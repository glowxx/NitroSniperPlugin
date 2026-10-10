import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTS } from './helpers.mjs';

const { ClaimQueue, extractGiftCodes } = await loadTS('claimQueue.ts');
const code = 'abcdefghijklmnop';
const user = '123456789012345678';
const secondUser = '234567890123456789';
const otherCode = 'qrstuvwxyzABCDEF';
const request = { code, claimantId: user };
const wrappers = ['||', '**', '*', '__', '~~', '`'];

for (const wrapper of wrappers) {
    test(`extracts complete genuine gift URLs inside ${JSON.stringify(wrapper)} formatting`, () => {
        for (const url of [`https://discord.gift/${code}`, `https://discord.com/gifts/${code}`, `https://discordapp.com/gifts/${code}`]) {
            assert.deepEqual(extractGiftCodes(`${wrapper}${url}${wrapper}`), [code]);
            assert.deepEqual(extractGiftCodes(`Gift: ${wrapper}${url}${wrapper}!`), [code]);
        }
    });
}

test('formatting support never turns hostile hosts or invalid gift paths into valid links', () => {
    const invalid = [
        `https://evil-discord.gift/${code}`,
        `https://evil.example/discord.gift/${code}`,
        `https://discord.gift.evil.example/${code}`,
        `https://discord.gift@evil.example/${code}`,
        `https://evil.example/**discord.gift/${code}**`,
        `https://evil.example/||discord.gift/${code}||`,
        `https://evil.example/_discord.gift/${code}_`,
        `https://discord.gift/${code.slice(0, 15)}`,
        `https://discord.gift/${code}123456789`,
        ...['_extra', '-extra', '/extra', '@evil.example', '=x'].map(suffix => `https://discord.gift/${code}${suffix}`)
    ];
    for (const text of invalid) {
        assert.deepEqual(extractGiftCodes(text), [], text);
        for (const wrapper of wrappers) assert.deepEqual(extractGiftCodes(`${wrapper}${text}${wrapper}`), [], `${wrapper}${text}${wrapper}`);
    }
});

for (const error of [{ status: 429 }, { status: 500 }, { status: 503 }, { status: 599 }, { code: 'ECONNRESET' }, { code: 'ETIMEDOUT' }, { code: 'EAI_AGAIN' }]) {
    test(`a new link can retry a confirmed transient failure ${JSON.stringify(error)} after cooldown`, t => {
        let now = 1_000;
        t.mock.method(Date, 'now', () => now);
        const calls = [], completed = [];
        const queue = new ClaimQueue((r, ok, fail) => { calls.push({ r, ok, fail }); }, (r, success) => completed.push(success), () => {});
        try {
            queue.start();
            assert.equal(queue.enqueue(request), true);
            now = 3_000;
            calls[0].fail(error);
            assert.deepEqual(completed, [false]);
            assert.equal(queue.enqueue(request), false);
            now = 7_999;
            assert.equal(queue.enqueue(request), false, 'cooldown starts when failure is confirmed');
            now = 8_000;
            assert.equal(queue.enqueue(request), true);
            assert.equal(calls.length, 2);
            calls[1].ok();
            now += 5_000;
            assert.equal(queue.enqueue(request), false, 'a successful retry stays deduplicated');
            assert.deepEqual(completed, [false, true]);
        } finally { queue.stop(); }
    });
}

test('transient failures allow at most three total attempts per account and gift in the dedup window', t => {
    let now = 1_000;
    t.mock.method(Date, 'now', () => now);
    const calls = [];
    const queue = new ClaimQueue((r, ok, fail) => { calls.push({ r, ok, fail }); }, () => {}, () => {});
    try {
        queue.start();
        for (let attempt = 0; attempt < 3; attempt++) {
            assert.equal(queue.enqueue(request), true, `attempt ${attempt + 1}`);
            calls[attempt].fail({ status: 503 });
            now += 5_000;
        }
        assert.equal(queue.enqueue(request), false);
        now += 60_000;
        assert.equal(queue.enqueue(request), false, 'cooldown cannot reset exhausted attempt budget');
        assert.equal(calls.length, 3);
        assert.equal(queue.enqueue({ code, claimantId: secondUser }), true, 'another account has its own attempt budget');
        assert.equal(calls.length, 4);
        calls[3].fail({ status: 429 });
        now += 5_000;
        assert.equal(queue.enqueue({ code, claimantId: secondUser }), true);
    } finally { queue.stop(); }
});

test('failed claims never automatically retry when time advances without a newly received link', async t => {
    let now = 1_000;
    t.mock.method(Date, 'now', () => now);
    const calls = [];
    const queue = new ClaimQueue((r, ok, fail) => { calls.push({ r, ok, fail }); }, () => {}, () => {});
    try {
        queue.start(); queue.enqueue(request); calls[0].fail({ status: 429 });
        now += 60_000;
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(calls.length, 1);
        assert.equal(queue.pendingCount, 0);
    } finally { queue.stop(); }
});

test('permanent and unknown failures stay deduplicated even after the retry cooldown', t => {
    let now = 1_000;
    t.mock.method(Date, 'now', () => now);
    const errors = [{ status: 400, code: 10038 }, { code: 10038 }, { status: 403 }, { status: '503' }, { status: 600 }, new Error('network timeout'), {}, undefined];
    for (const error of errors) {
        const calls = [];
        const queue = new ClaimQueue((r, ok, fail) => { calls.push({ r, ok, fail }); }, () => {}, () => {});
        try {
            queue.start(); queue.enqueue(request); calls[0].fail(error); now += 60_000;
            assert.equal(queue.enqueue(request), false, `must not retry ${String(error)}`);
            assert.equal(calls.length, 1);
        } finally { queue.stop(); }
    }
});

test('unresolved claims keep the dispatch lock and deduplication across stop/start and elapsed time', t => {
    let now = 1_000;
    t.mock.method(Date, 'now', () => now);
    const calls = [], completed = [];
    const queue = new ClaimQueue((r, ok, fail) => { calls.push({ r, ok, fail }); }, (r, success) => completed.push(success), () => {});
    try {
        queue.start(); queue.enqueue(request); queue.stop(); queue.start();
        now += 86_400_001;
        assert.equal(queue.enqueue(request), false);
        assert.equal(queue.enqueue({ code: otherCode, claimantId: secondUser }), true);
        assert.equal(calls.length, 1);
        calls[0].ok();
        assert.equal(calls.length, 2);
        assert.deepEqual(completed, [], 'old-generation claim does not notify after restart');
        calls[1].ok();
        assert.deepEqual(completed, [true]);
    } finally { queue.stop(); }
});

test('late duplicate callbacks cannot unlock an ongoing retry or overwrite its success', t => {
    let now = 1_000;
    t.mock.method(Date, 'now', () => now);
    const calls = [], completed = [];
    const queue = new ClaimQueue((r, ok, fail) => { calls.push({ r, ok, fail }); }, (r, success) => completed.push(success), () => {});
    try {
        queue.start(); queue.enqueue(request); calls[0].fail({ code: 'ECONNRESET' });
        now += 5_000;
        assert.equal(queue.enqueue(request), true);
        calls[0].ok(); calls[0].fail({ status: 503 });
        assert.equal(queue.enqueue(request), false);
        assert.equal(calls.length, 2);
        assert.deepEqual(completed, [false]);
        calls[1].ok(); calls[1].fail({ status: 503 });
        now += 5_000;
        assert.equal(queue.enqueue(request), false);
        assert.deepEqual(completed, [false, true]);
    } finally { queue.stop(); }
});

test('known transport promise rejections and synchronous throws can be retried safely', async t => {
    let now = 1_000;
    t.mock.method(Date, 'now', () => now);
    for (const mode of ['throw', 'reject']) {
        let attempts = 0;
        const completed = [];
        const queue = new ClaimQueue((r, ok) => {
            attempts++;
            if (attempts > 1) { ok(); return; }
            const error = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
            if (mode === 'throw') throw error;
            return Promise.reject(error);
        }, (r, success) => completed.push(success), () => {});
        try {
            queue.start(); queue.enqueue(request);
            await new Promise(resolve => setImmediate(resolve));
            assert.deepEqual(completed, [false]);
            now += 5_000;
            assert.equal(queue.enqueue(request), true, mode);
            assert.equal(attempts, 2);
            assert.deepEqual(completed, [false, true]);
        } finally { queue.stop(); }
    }
});

test('Discord retry_after is respected before another received link can retry', t => {
    let now = 1_000;
    t.mock.method(Date, 'now', () => now);
    let fail;
    const queue = new ClaimQueue((r, ok, onError) => { fail = onError; }, () => {}, () => {});
    try {
        queue.start(); queue.enqueue(request);
        fail({ status: 429, body: { retry_after: 30 } });
        now += 29_999;
        assert.equal(queue.enqueue(request), false);
        now++;
        assert.equal(queue.enqueue(request), true);
    } finally { queue.stop(); }
});

test('stopping a pending retry retains earlier attempts without spending a never-dispatched attempt', t => {
    let now = 1_000;
    t.mock.method(Date, 'now', () => now);
    const calls = [];
    const queue = new ClaimQueue((r, ok, fail) => calls.push({ r, ok, fail }), () => {}, () => {});
    try {
        queue.start(); queue.enqueue(request); calls[0].fail({ status: 503 });
        now += 5000;
        queue.enqueue({ code: otherCode, claimantId: user });
        assert.equal(queue.enqueue(request), true);
        queue.stop(); queue.start();
        assert.equal(queue.enqueue(request), true);
        calls[1].ok();
        calls[2].fail({ status: 503 }); now += 5000;
        assert.equal(queue.enqueue(request), true);
        calls[3].fail({ status: 503 }); now += 5000;
        assert.equal(queue.enqueue(request), false);
    } finally { queue.stop(); }
});

test('nested wrappers preserve whole links and mismatched wrappers do not truncate suffixes', () => {
    assert.deepEqual(extractGiftCodes(`||**https://discord.gift/${code}**||`), [code]);
    assert.deepEqual(extractGiftCodes(`***https://discord.gift/${code}***`), [code]);
    for (const text of [`**https://discord.gift/${code}_**`, `||https://discord.gift/${code}extra_extra||`]) {
        assert.deepEqual(extractGiftCodes(text), []);
    }
});
