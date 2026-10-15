import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTS } from './helpers.mjs';

const { ClaimQueue } = await loadTS('claimQueue.ts');
const accountA = '123456789012345678';
const accountB = '234567890123456789';
const request = (code, claimantId = accountA) => ({ code, claimantId });

function setup(t) {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    const calls = [], completed = [];
    const queue = new ClaimQueue((r, ok, fail) => { calls.push({ r, ok, fail }); }, (r, success) => completed.push({ r, success }), () => {});
    queue.start();
    t.after(() => queue.stop());
    return { queue, calls, completed, tick: ms => t.mock.timers.tick(ms) };
}

for (const [fields, delay] of [[{ retryAfter: 12 }, 12000], [{ retryAfter: 6.25 }, 6250], [{ body: { retry_after: 12, global: false } }, 12000], [{ retryAfter: NaN }, 5000]]) {
    test(`confirmed 429 waits distinct pending gifts until deadline ${JSON.stringify(fields)}`, t => {
        const { queue, calls, completed, tick } = setup(t);
        queue.enqueue(request('first')); queue.enqueue(request('second')); queue.enqueue(request('third'));
        calls[0].fail({ status: 429, code: -1, ...fields });
        assert.equal(calls.length, 1);
        assert.equal(queue.pendingCount, 2);
        assert.equal(completed.length, 1);
        tick(delay - 1); assert.equal(calls.length, 1);
        tick(1); assert.equal(calls.length, 2);
        assert.equal(calls[1].r.code, 'second');
        tick(60000); assert.equal(calls.length, 2, 'one unresolved claim still holds the lock');
        calls[1].ok(); assert.equal(calls.length, 3);
        calls[2].ok(); tick(60000);
        assert.equal(calls.length, 3, 'failed first gift is never automatically re-enqueued');
    });
}

test('cooldown follows account across stop/start and account switches; stale timers cannot dispatch', t => {
    const { queue, calls, tick } = setup(t);
    queue.enqueue(request('first')); queue.enqueue(request('discarded'));
    calls[0].fail({ status: 429, retryAfter: 12 });
    queue.stop(); queue.start();
    queue.enqueue(request('account-b', accountB));
    assert.equal(calls.length, 2, 'B does not inherit A cooldown');
    calls[1].ok();
    queue.stop(); queue.start(); queue.enqueue(request('account-a'));
    tick(11999); assert.equal(calls.length, 2);
    tick(1); assert.equal(calls.length, 3, 'returning A retains original deadline');
    assert.equal(calls[2].r.code, 'account-a');
    tick(12000); assert.equal(calls.length, 3, 'stale wakeups do not duplicate dispatch');
});

test('successive 429s extend an account cooldown without duplicate timers or gift retries', t => {
    const { queue, calls, tick } = setup(t);
    queue.enqueue(request('first')); queue.enqueue(request('second')); queue.enqueue(request('third'));
    calls[0].fail({ status: 429, retryAfter: 12 });
    tick(12000); assert.equal(calls.length, 2);
    calls[1].fail({ status: 429, retryAfter: 30 });
    queue.enqueue(request('fourth'));
    tick(29999); assert.equal(calls.length, 2);
    tick(1); assert.equal(calls.length, 3);
    calls[2].ok(); assert.equal(calls.length, 4);
    calls[3].ok(); tick(60000); assert.equal(calls.length, 4);
});

test('a late previous-session 429 still protects its original account and never blocks another account', t => {
    const { queue, calls, completed, tick } = setup(t);
    queue.enqueue(request('first')); queue.stop(); queue.start();
    queue.enqueue(request('second', accountB));
    assert.equal(calls.length, 1, 'old unresolved dispatch keeps lock');
    calls[0].fail({ status: 429, retryAfter: 12 });
    assert.equal(calls.length, 2);
    assert.deepEqual(completed, [], 'old result produces no stale completion UI');
    calls[1].ok(); queue.stop(); queue.start(); queue.enqueue(request('third'));
    tick(11999); assert.equal(calls.length, 2);
    tick(1); assert.equal(calls.length, 3);
});

test('stopping cancels cooldown wakeup and never spends an attempt for discarded pending gifts', t => {
    const { queue, calls, tick } = setup(t);
    queue.enqueue(request('first')); queue.enqueue(request('second'));
    calls[0].fail({ status: 429, retryAfter: 12 }); queue.stop(); tick(12000);
    assert.equal(calls.length, 1);
    queue.start(); assert.equal(queue.enqueue(request('second')), true);
    assert.equal(calls.length, 2);
});

test('a canceled wakeup delivered after restart cannot release or dispatch the new session', t => {
    const { queue, calls, tick } = setup(t);
    const scheduled = [];
    const schedule = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
        scheduled.push({ callback, delay });
        return schedule(callback, delay);
    });
    queue.enqueue(request('first')); queue.enqueue(request('second'));
    calls[0].fail({ status: 429, retryAfter: 12 });
    const oldWakeup = scheduled.find(item => item.delay === 12000).callback;
    queue.stop(); queue.start(); queue.enqueue(request('account-b', accountB));
    oldWakeup(); assert.equal(calls.length, 2, 'stale timer cannot unlock ongoing B');
    calls[1].ok(); queue.stop(); queue.start(); queue.enqueue(request('account-a'));
    oldWakeup(); assert.equal(calls.length, 2, 'stale timer cannot dispatch A before its deadline');
    tick(12000); assert.equal(calls.length, 3);
    oldWakeup(); assert.equal(calls.length, 3, 'stale timer cannot duplicate A dispatch');
});

test('a newly received distinct gift respects cooldown even when no gift was pending at failure', t => {
    const { queue, calls, tick } = setup(t);
    queue.enqueue(request('first')); calls[0].fail({ status: 429, retryAfter: 12 });
    tick(3000); queue.enqueue(request('second'));
    assert.equal(calls.length, 1);
    tick(8999); assert.equal(calls.length, 1);
    tick(1); assert.equal(calls.length, 2);
    calls[1].ok();
    assert.equal(queue.enqueue(request('first')), true, 'existing newly received link retry semantics survive');
    assert.equal(calls.length, 3);
});

test('ordinary terminal failure does not delay other distinct gifts or make the failed gift retryable', t => {
    const { queue, calls, tick } = setup(t);
    queue.enqueue(request('first')); queue.enqueue(request('second'));
    calls[0].fail({ status: 400, body: { captcha_key: ['challenge required'] } });
    assert.equal(calls.length, 2);
    calls[1].ok(); tick(60000);
    assert.equal(queue.enqueue(request('first')), false);
    assert.equal(calls.length, 2);
});

test('5xx failure keeps re-receipt cooldown but does not establish unverified account-wide backpressure', t => {
    const { queue, calls, tick } = setup(t);
    queue.enqueue(request('first')); queue.enqueue(request('second'));
    calls[0].fail({ status: 503, code: -1 });
    assert.equal(calls.length, 2);
    assert.equal(queue.enqueue(request('first')), false);
    calls[1].ok(); tick(5000);
    assert.equal(queue.enqueue(request('first')), true);
    assert.equal(calls.length, 3);
});
