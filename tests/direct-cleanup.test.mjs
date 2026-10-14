import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTS } from './helpers.mjs';
const { createDirectBot, diskCleanupStore, discordRequest } = await loadTS('directBot.ts');
const user = '123456789012345678', otherUser = '234567890123456789';
const originalBot = '345678901234567890', differentBot = '456789012345678901';
const channel = '567890123456789012';
const token = 'private-test-bot-token-no-network', rotated = 'private-rotated-bot-token-no-network';

async function fixture(t, overrides = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'nitrosniper-test-cleanup-'));
    const path = join(dir, 'cleanup.json');
    const credentials = new Map(), deleted = [];
    let clock = Date.now(), count = 0;
    const vault = { get: async id => credentials.get(id) ?? null, set: async (id, value) => credentials.set(id, value), remove: async id => credentials.delete(id) };
    const request = async (secret, route, body, signal, method) => {
        if (method === 'DELETE') {
            deleted.push({ secret, route });
            return overrides.delete ? overrides.delete(secret, route, signal) : { status: 204, body: {} };
        }
        if (route === '/users/@me') return { status: 200, body: { bot: true, id: secret === 'different-bot-token-for-tests-only' ? differentBot : originalBot, username: 'Test Bot' } };
        if (route === '/users/@me/channels') {
            const response = { status: 200, body: { id: channel } };
            return overrides.channel ? overrides.channel(response, signal) : response;
        }
        const receipt = { status: 200, body: { id: String(678901234567890123n + BigInt(count++)), channel_id: channel, timestamp: new Date(clock).toISOString() } };
        return overrides.message ? overrides.message(receipt, signal, body) : receipt;
    };
    const make = () => createDirectBot(vault, request, { now: () => clock, autoSchedule: false, cleanupStore: diskCleanupStore(async () => path) });
    let bot = make();
    const connection = await bot.connect(user, token);
    t.after(async () => { bot.stopCleanup(); await rm(dir, { recursive: true, force: true }); });
    return {
        get bot() { return bot; }, connection, credentials, deleted, path,
        advance: ms => { clock += ms; },
        restart: async () => { bot.stopCleanup(); bot = make(); await bot.startCleanup(); },
        jobs: async () => JSON.parse(await readFile(path, 'utf8')).jobs,
        send: (kind = 'test', owner = user, credentialId = connection.credentialId) => bot.send(owner, credentialId, JSON.stringify({
            eventId: `test-event-${String(count).padStart(16, '0')}`, kind, discordUserId: owner, occurredAt: new Date(clock).toISOString(),
            // These renderer source IDs must never become a DELETE target.
            channelId: otherUser, messageId: differentBot
        }))
    };
}

test('test delivery persists only native response identity; no deletion before the exact original deadline', async t => {
    const f = await fixture(t);
    assert.equal((await f.send()).status, 200);
    const [job] = await f.jobs();
    assert.equal(job.channelId, channel); assert.equal(job.messageId, '678901234567890123');
    assert.equal((await readFile(f.path, 'utf8')).includes(token), false);
    f.advance(29_999); await f.bot.runCleanup(); assert.equal(f.deleted.length, 0);
    f.advance(1); await f.bot.runCleanup(); await f.bot.runCleanup();
    assert.deepEqual(f.deleted.map(value => value.route), [`/channels/${channel}/messages/678901234567890123`]);
    assert.deepEqual(await f.jobs(), []);
});
test('restart at ten seconds preserves the deadline, and a later restart deletes overdue tests', async t => {
    const f = await fixture(t); await f.send();
    const original = (await f.jobs())[0].deleteAt;
    f.advance(10_000); await f.restart();
    assert.equal((await f.jobs())[0].deleteAt, original); assert.equal(f.deleted.length, 0);
    f.advance(10_000); await f.restart(); assert.equal(f.deleted.length, 0);
    f.advance(9_999); await f.bot.runCleanup(); assert.equal(f.deleted.length, 0);
    f.advance(1); await f.bot.runCleanup(); assert.equal(f.deleted.length, 1);
    await f.send(); f.advance(60_000); await f.restart(); assert.equal(f.deleted.length, 2);
});
test('two test messages keep independent durable identities and are each deleted once', async t => {
    const f = await fixture(t); await f.send(); f.advance(5000); await f.send();
    assert.equal((await f.jobs()).length, 2);
    f.advance(25_000); await f.bot.runCleanup(); assert.equal(f.deleted.length, 1);
    f.advance(5000); await f.restart(); await f.bot.runCleanup();
    assert.equal(f.deleted.length, 2); assert.notEqual(f.deleted[0].route, f.deleted[1].route);
});
test('claim messages never enter cleanup across elapsed time or client restart', async t => {
    const f = await fixture(t); assert.equal((await f.send('claimed')).status, 200);
    f.advance(60_000); await f.restart(); await f.bot.runCleanup();
    assert.equal(f.deleted.length, 0);
    await assert.rejects(readFile(f.path), { code: 'ENOENT' });
});
test('404 removes the durable record as already deleted', async t => {
    const f = await fixture(t, { delete: async () => ({ status: 404, body: { code: 10008 } }) });
    await f.send(); f.advance(30_000); await f.bot.runCleanup(); await f.restart();
    assert.equal(f.deleted.length, 1); assert.deepEqual(await f.jobs(), []);
});
test('429 retains the job and respects retry_after across restart', async t => {
    let attempts = 0;
    const f = await fixture(t, { delete: async () => ++attempts === 1 ? { status: 429, body: { retry_after: 12 } } : { status: 204, body: {} } });
    await f.send(); f.advance(30_000); await f.bot.runCleanup(); assert.equal((await f.jobs()).length, 1);
    f.advance(11_999); await f.restart(); assert.equal(attempts, 1);
    f.advance(1); await f.bot.runCleanup(); assert.equal(attempts, 2); assert.deepEqual(await f.jobs(), []);
});
for (const reply of [{ status: 500, body: {} }, { status: -1, body: {} }]) {
    test(`transient ${reply.status} cleanup failure is durably retried with bounded backoff`, async t => {
        let attempts = 0;
        const f = await fixture(t, { delete: async () => ++attempts === 1 ? reply : { status: 204, body: {} } });
        await f.send(); f.advance(30_000); await f.bot.runCleanup();
        assert.equal((await f.jobs())[0].attempts, 1);
        f.advance(4999); await f.restart(); assert.equal(attempts, 1);
        f.advance(1); await f.bot.runCleanup(); assert.equal(attempts, 2); assert.deepEqual(await f.jobs(), []);
    });
}
test('one malformed persisted job cannot prevent valid cleanup and extra fields are stripped', async t => {
    const f = await fixture(t); await f.send();
    const jobs = await f.jobs();
    await writeFile(f.path, JSON.stringify({ version: 1, jobs: [{ ...jobs[0], unexpected: 'not retained' }, { ...jobs[0], messageId: 'arbitrary' }] }));
    f.advance(30_000); await f.restart(); assert.equal(f.deleted.length, 1);
    assert.equal((await readFile(f.path, 'utf8')).includes('not retained'), false);
});
test('same-bot token rotation cleans up using the new encrypted-vault credential association', async t => {
    const f = await fixture(t); await f.send();
    await f.bot.connect(user, rotated);
    f.advance(30_000); await f.restart(); assert.equal(f.deleted.length, 1); assert.equal(f.deleted[0].secret, rotated);
});
test('different bot replacement never deletes early or uses the replacement credential for old tests', async t => {
    const f = await fixture(t, { delete: async () => ({ status: 500, body: {} }) });
    await f.send(); const result = await f.bot.connect(user, 'different-bot-token-for-tests-only');
    assert.match(result.warning, /same bot/); assert.equal(f.deleted.length, 0);
    f.advance(3_600_000); await f.restart(); assert.equal(f.deleted.length, 0); assert.equal((await f.jobs()).length, 1);
    await f.bot.connect(user, rotated); await f.bot.runCleanup(); assert.equal(f.deleted.length, 1); assert.equal(f.deleted[0].secret, rotated);
});
test('normal disconnect at ten seconds retains the credential and exact thirty-second deadline', async t => {
    const f = await fixture(t); await f.send();
    const deadline = (await f.jobs())[0].deleteAt;
    f.advance(10_000); const result = await f.bot.disconnect(user);
    assert.equal(result.disconnected, false); assert.equal(result.pendingCleanup, 1);
    assert.match(result.warning, /1 temporary test message/); assert.equal(f.credentials.has(user), true);
    assert.equal(f.deleted.length, 0); assert.equal((await f.jobs())[0].deleteAt, deadline);
    f.advance(19_999); await f.bot.runCleanup(); assert.equal(f.deleted.length, 0);
    f.advance(1); await f.bot.runCleanup(); assert.equal(f.deleted.length, 1);
    assert.equal((await f.bot.disconnect(user)).disconnected, true); assert.equal(f.credentials.has(user), false);
});
test('explicit force disconnect removes the credential without issuing any early DELETE', async t => {
    const f = await fixture(t); await f.send(); f.advance(10_000);
    const result = await f.bot.disconnect(user, true);
    assert.equal(result.disconnected, true); assert.match(result.warning, /may leave these messages/);
    assert.equal(f.credentials.has(user), false); assert.equal(f.deleted.length, 0);
    assert.equal((await readFile(f.path, 'utf8')).includes(token), false);
    f.advance(3_600_000); await f.restart(); assert.equal(f.deleted.length, 0);
});

test('a blocked normal disconnect cannot cancel an unrelated in-flight CLAIM DM', async t => {
    let hold = false, entered, release;
    const inChannel = new Promise(resolve => { entered = resolve; });
    const response = new Promise(resolve => { release = resolve; });
    const f = await fixture(t, { channel: async receipt => { if (hold) { entered(); await response; } return receipt; } });
    await f.send(); hold = true; const claimed = f.send('claimed'); await inChannel;
    f.advance(10_000); const result = await f.bot.disconnect(user); assert.equal(result.disconnected, false);
    release(); assert.equal((await claimed).status, 200);
    assert.equal(f.deleted.length, 0); assert.equal((await f.jobs()).length, 1);
});
test('account B cannot supply a bot credential for account A cleanup', async t => {
    const f = await fixture(t); await f.send();
    const saved = f.credentials.get(user); f.credentials.delete(user); f.credentials.set(otherUser, saved);
    f.advance(30_000); await f.restart(); assert.equal(f.deleted.length, 0); assert.equal((await f.jobs()).length, 1);
});
test('HTTP transport preserves status for JSON, malformed, oversized, and unavailable bodies', async t => {
    for (const [status, data] of [[403, '<html>secret</html>'], [404, 'text'], [429, '<html/>'], [500, '<html/>'], [429, '{"retry_after":8}'], [403, 'x'.repeat(65_537)]]) {
        t.mock.method(globalThis, 'fetch', async () => new Response(data, { status }));
        const reply = await discordRequest(token, '/users/@me');
        assert.equal(reply.status, status); assert.equal(JSON.stringify(reply.body).includes('secret'), false);
        if (data.includes('retry_after')) assert.equal(reply.body.retry_after, 8);
        t.mock.restoreAll();
    }
    t.mock.method(globalThis, 'fetch', async () => { throw new Error(token); });
    assert.deepEqual(await discordRequest(token, '/users/@me'), { status: -1, body: {} });
});

test('cleanup persistence failure backs off instead of repeatedly deleting on a due timer', async t => {
    let clock = Date.now(), jobs = [], fail = false, deletes = 0;
    const credentials = new Map();
    const vault = { get: async id => credentials.get(id) ?? null, set: async (id, v) => credentials.set(id, v), remove: async id => credentials.delete(id) };
    const store = { load: async () => structuredClone(jobs), save: async next => { if (fail) throw new Error('disk unavailable'); jobs = structuredClone(next); } };
    const request = async (secret, route, body, signal, method) => method === 'DELETE' ? (++deletes, { status: 204, body: {} })
        : route === '/users/@me' ? { status: 200, body: { id: originalBot, bot: true } }
            : route === '/users/@me/channels' ? { status: 200, body: { id: channel } }
                : { status: 200, body: { id: '678901234567890123', channel_id: channel, timestamp: new Date(clock).toISOString() } };
    const bot = createDirectBot(vault, request, { cleanupStore: store, now: () => clock, autoSchedule: false });
    const connection = await bot.connect(user, token);
    await bot.send(user, connection.credentialId, JSON.stringify({ eventId: 'cleanup-failure-test', kind: 'test', discordUserId: user, occurredAt: new Date(clock).toISOString() }));
    clock += 30_000; fail = true; await bot.runCleanup(); assert.equal(deletes, 1);
    clock += 4_999; await bot.runCleanup(); assert.equal(deletes, 1);
    clock++; fail = false; await bot.runCleanup(); assert.equal(deletes, 2); assert.deepEqual(jobs, []);
});

test('disconnect cannot discard a dispatched test receipt before durable cleanup registration', async t => {
    let entered, release;
    const inPost = new Promise(resolve => { entered = resolve; });
    const response = new Promise(resolve => { release = resolve; });
    const f = await fixture(t, { message: async (receipt, signal) => {
        assert.equal(signal, undefined, 'Native test receipt uses its bounded transport deadline');
        entered(); await response; return receipt;
    }, delete: async () => ({ status: 500, body: {} }) });
    const sending = f.send(); await inPost;
    const disconnecting = f.bot.disconnect(user); release();
    assert.equal((await sending).status, 200);
    assert.equal((await disconnecting).disconnected, false);
    assert.equal((await f.jobs()).length, 1); assert.equal(f.credentials.has(user), true);
    assert.equal(f.deleted.length, 0);
});

test('same-bot rotation at ten seconds preserves deleteAt and cannot delete before 30.000', async t => {
    const f = await fixture(t); await f.send(); const deadline = (await f.jobs())[0].deleteAt;
    f.advance(10_000); await f.bot.connect(user, rotated);
    assert.equal((await f.jobs())[0].deleteAt, deadline); assert.equal(f.deleted.length, 0);
    f.advance(19_999); await f.bot.runCleanup(); assert.equal(f.deleted.length, 0);
    f.advance(1); await f.bot.runCleanup(); assert.equal(f.deleted.length, 1);
    assert.equal(f.deleted[0].secret, rotated);
});

test('account switch and renderer/plugin suspension leave the native deadline authoritative', async t => {
    const f = await fixture(t); await f.send();
    f.advance(10_000); await f.bot.connect(otherUser, rotated); await f.bot.status(otherUser);
    // Renderer disable/reload has no native cleanup stop/disconnect hook.
    f.bot.stopCleanup(); f.advance(10_000); await f.bot.startCleanup();
    assert.equal(f.deleted.length, 0);
    f.advance(9_999); await f.bot.runCleanup(); assert.equal(f.deleted.length, 0);
    f.advance(1); await f.bot.runCleanup(); assert.equal(f.deleted.length, 1);
    assert.equal(f.deleted[0].secret, token);
});

test('backward wall-clock change preserves a valid persisted deadline through restart', async t => {
    const start = Date.now(); t.mock.timers.enable({ apis: ['Date'], now: start });
    const f = await fixture(t); await f.send(); const deadline = (await f.jobs())[0].deleteAt;
    f.advance(-600_000); t.mock.timers.setTime(start - 600_000); await f.restart();
    assert.equal((await f.jobs())[0].deleteAt, deadline); assert.equal(f.deleted.length, 0);
    f.advance(629_999); t.mock.timers.setTime(start + 29_999); await f.bot.runCleanup(); assert.equal(f.deleted.length, 0);
    f.advance(1); t.mock.timers.setTime(start + 30_000); await f.bot.runCleanup(); assert.equal(f.deleted.length, 1);
});

test('a delayed POST uses local successful delivery time and acknowledges only after durable cleanup', async t => {
    let clock = Date.now(), entered, release, post, confirm;
    const inPost = new Promise(resolve => { post = resolve; });
    const receipt = new Promise(resolve => { confirm = resolve; });
    const inSave = new Promise(resolve => { entered = resolve; });
    const saved = new Promise(resolve => { release = resolve; });
    const credentials = new Map(); let jobs = [], settled = false;
    const bot = createDirectBot({ get: async id => credentials.get(id) ?? null, set: async (id, v) => credentials.set(id, v), remove: async id => credentials.delete(id) },
        async (secret, route) => route === '/users/@me' ? { status: 200, body: { id: originalBot, bot: true } }
            : route === '/users/@me/channels' ? { status: 200, body: { id: channel } } : (post(), await receipt),
        { now: () => clock, autoSchedule: false, cleanupStore: { load: async () => jobs, save: async next => { entered(); await saved; jobs = next; } } });
    const connection = await bot.connect(user, token);
    const sending = bot.send(user, connection.credentialId, JSON.stringify({ eventId: 'delayed-test-delivery', kind: 'test', discordUserId: user, occurredAt: new Date(clock).toISOString() })).then(value => { settled = true; return value; });
    await inPost; clock += 120_000; confirm({ status: 200, body: { id: '678901234567890123', channel_id: channel, timestamp: '2000-01-01T00:00:00Z' } });
    await inSave; assert.equal(settled, false); release(); assert.equal((await sending).status, 200);
    assert.equal(jobs[0].deleteAt, clock + 30_000);
});

test('a sent test whose initial cleanup write fails returns an explicit manual-deletion error', async () => {
    const credentials = new Map(); let posts = 0;
    const bot = createDirectBot({ get: async id => credentials.get(id) ?? null, set: async (id, v) => credentials.set(id, v), remove: async id => credentials.delete(id) },
        async (secret, route) => route === '/users/@me' ? { status: 200, body: { id: originalBot, bot: true } }
            : route === '/users/@me/channels' ? { status: 200, body: { id: channel } } : (++posts, { status: 200, body: { id: '678901234567890123', channel_id: channel } }),
        { autoSchedule: false, cleanupStore: { load: async () => [], save: async () => { throw new Error('private storage details'); } } });
    const connection = await bot.connect(user, token);
    const result = await bot.send(user, connection.credentialId, JSON.stringify({ eventId: 'failed-cleanup-save', kind: 'test', discordUserId: user, occurredAt: new Date().toISOString() }));
    assert.equal(posts, 1); assert.equal(result.status, 503); assert.match(result.data, /delivered.*cleanup could not be saved/);
    assert.equal(result.data.includes(token), false); assert.equal(result.data.includes('private storage details'), false);
});

test('forward wall-clock jump makes an overdue job eligible once, without a deletion loop', async t => {
    const f = await fixture(t); await f.send(); f.advance(600_000);
    await f.bot.runCleanup(); await f.bot.runCleanup(); await f.restart();
    assert.equal(f.deleted.length, 1); assert.deepEqual(await f.jobs(), []);
});

test('cleanup rechecks deleteAt if the clock moves backwards during asynchronous credential lookup', async () => {
    let clock = Date.now(), rewind = false, jobs = [], deletes = 0;
    const credentials = new Map();
    const bot = createDirectBot({ get: async id => { if (rewind) { clock -= 10_000; rewind = false; } return credentials.get(id) ?? null; },
        set: async (id, value) => credentials.set(id, value), remove: async id => credentials.delete(id) },
        async (token, route, body, signal, method) => method === 'DELETE' ? (++deletes, { status: 204, body: {} })
            : route === '/users/@me' ? { status: 200, body: { id: originalBot, bot: true } }
                : route === '/users/@me/channels' ? { status: 200, body: { id: channel } }
                    : { status: 200, body: { id: '678901234567890123', channel_id: channel } },
        { now: () => clock, autoSchedule: false, cleanupStore: { load: async () => jobs, save: async next => { jobs = next; } } });
    const connection = await bot.connect(user, token);
    await bot.send(user, connection.credentialId, JSON.stringify({ eventId: 'rewind-during-lookup', kind: 'test', discordUserId: user, occurredAt: new Date(clock).toISOString() }));
    clock += 30_000; rewind = true; await bot.runCleanup(); assert.equal(deletes, 0);
    clock += 10_000; await bot.runCleanup(); assert.equal(deletes, 1);
});

test('failed startup reads schedule bounded recovery without requiring another test click', async t => {
    let reads = 0, wake, wait;
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t.mock.method(globalThis, 'setTimeout', (fn, delay) => { wake = fn; wait = delay; return { unref() {} }; });
    t.mock.method(globalThis, 'clearTimeout', () => {});
    const bot = createDirectBot({ get: async () => null }, async () => {}, {
        cleanupStore: { load: async () => { if (++reads === 1) throw new Error('temporary read error'); return []; }, save: async () => {} }
    });
    await bot.startCleanup(); assert.equal(wait, 5000); assert.equal(typeof wake, 'function');
    t.mock.timers.tick(5000);
    await bot.runCleanup(); assert.equal(reads, 2); bot.stopCleanup();
});

test('reusing a claimed event ID as a test cannot turn Discord nonce deduplication into claim deletion', async t => {
    const messages = new Map();
    const f = await fixture(t, { message: (receipt, signal, body) => {
        if (!messages.has(body.nonce)) messages.set(body.nonce, receipt);
        return messages.get(body.nonce);
    } });
    const event = { eventId: 'reused-event-id-for-test', discordUserId: user, occurredAt: new Date().toISOString() };
    await f.bot.send(user, f.connection.credentialId, JSON.stringify({ ...event, kind: 'claimed' }));
    const claimId = [...messages.values()][0].body.id;
    await f.bot.send(user, f.connection.credentialId, JSON.stringify({ ...event, kind: 'test' }));
    assert.equal(messages.size, 2, 'The test must have a different Discord nonce namespace');
    f.advance(30_000); await f.bot.runCleanup();
    assert.equal(f.deleted.length, 1); assert.equal(f.deleted[0].route.endsWith(`/${claimId}`), false);
});

test('a server/client clock offset cannot delete a newly delivered test before thirty elapsed seconds', async t => {
    const f = await fixture(t, { message: receipt => ({ ...receipt, body: { ...receipt.body, timestamp: new Date(Date.now() - 600_000).toISOString() } }) });
    await f.send(); await f.bot.runCleanup(); assert.equal(f.deleted.length, 0);
    f.advance(29_999); await f.bot.runCleanup(); assert.equal(f.deleted.length, 0);
    f.advance(1); await f.bot.runCleanup(); assert.equal(f.deleted.length, 1);
});
