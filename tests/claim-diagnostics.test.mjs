import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTS } from './helpers.mjs';
const { ClaimQueue } = await loadTS('claimQueue.ts');
const session = '12345678-1234-4123-8123-123456789abc';
const request = () => ({ code: 'privateGiftCode12', claimantId: '123456789012345678' });
const events = rows => rows.map(row => row.event);
function fixture(t, redeem, broken = false) {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
    const rows = [], completed = []; let warnings = 0;
    const observer = { context: () => ({ session }), record: (event, fields, context) => {
        if (broken) throw new Error('logger unavailable'); rows.push({ event, ...fields, ...context });
    } };
    const queue = new ClaimQueue(redeem, (_, success) => completed.push(success), () => warnings++, 120_000, observer);
    queue.start(); t.after(() => queue.stop());
    return { queue, rows, completed, get warnings() { return warnings; } };
}

test('callback and Promise success have distinct ordered diagnostics with one completion', async t => {
    let succeed, resolve;
    const f = fixture(t, (_, ok) => { succeed = ok; return new Promise(done => { resolve = done; }); });
    f.queue.enqueue(request()); succeed(); resolve(); await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(events(f.rows), ['gift_detected', 'claim_enqueued', 'claim_dispatched', 'on_redeemed', 'claim_completed_success', 'redeem_promise_resolved']);
    assert.deepEqual(f.completed, [true]); assert.equal(f.rows[0].claim, 1);
    assert.ok(f.rows.every(row => row.session === session));
    assert.equal(JSON.stringify(f.rows).includes('privateGiftCode'), false);
});

for (const kind of ['promise success', 'callback failure', 'promise rejection', 'sync throw']) test(`claim diagnostics capture ${kind} without changing completion`, async t => {
    let fail, settle;
    const secret = 'private bot-token webhook-url service-key rqtoken';
    const error = Object.assign(new Error(secret), { status: 429, code: 20028, retryAfter: 12.5 });
    const f = fixture(t, (_, ok, bad) => {
        fail = bad;
        if (kind === 'sync throw') throw error;
        if (kind === 'callback failure') return;
        return new Promise((resolve, reject) => { settle = kind === 'promise success' ? resolve : () => reject(error); });
    });
    f.queue.enqueue(request()); if (kind === 'callback failure') fail(error); else settle?.();
    await Promise.resolve(); await Promise.resolve();
    assert.ok(events(f.rows).includes(kind === 'callback failure' ? 'on_error' : kind === 'sync throw' ? 'redeem_threw' : kind === 'promise rejection' ? 'redeem_promise_rejected' : 'redeem_promise_resolved'));
    assert.deepEqual(f.completed, [kind === 'promise success']);
    assert.equal(JSON.stringify(f.rows).includes(secret), false);
    if (kind !== 'promise success') assert.ok(f.rows.some(row => row.status === 429 && row.retryAfter === 12.5));
});

test('unresolved claim stays locked with only 15/30/60/120 second checkpoints and the existing warning', t => {
    let calls = 0; const f = fixture(t, () => { calls++; });
    f.queue.enqueue(request()); f.queue.enqueue({ ...request(), code: 'anotherPrivate12' });
    for (let second = 0; second < 130; second++) t.mock.timers.tick(1000);
    assert.equal(calls, 1); assert.deepEqual(f.completed, []); assert.equal(f.warnings, 1);
    assert.deepEqual(f.rows.filter(row => row.event === 'claim_pending_checkpoint').map(row => row.checkpointMs), [15_000, 30_000, 60_000, 120_000]);
    f.queue.stop(); f.queue.start(); t.mock.timers.tick(10_000);
    assert.equal(f.rows.filter(row => row.event === 'claim_pending_checkpoint').length, 4);
    assert.equal(calls, 1);
});

test('logging exceptions cannot prevent claim success or release unresolved work', t => {
    let ok; const f = fixture(t, (_, success) => { ok = success; }, true);
    assert.doesNotThrow(() => f.queue.enqueue(request())); ok(); assert.deepEqual(f.completed, [true]);
});

test('429 logs waiting once per transition, finish once, and safe queue rejections', t => {
    let fail; const f = fixture(t, (_, ok, bad) => { fail = bad; });
    f.queue.enqueue(request()); f.queue.enqueue({ ...request(), code: 'anotherPrivate12' });
    fail({ status: 429, retryAfter: 12 });
    f.queue.enqueue({ ...request(), code: 'thirdPrivateCode' }); f.queue.enqueue(request());
    assert.equal(f.rows.filter(row => row.event === 'queue_waiting_for_429_cooldown').length, 1);
    t.mock.timers.tick(12_000);
    assert.equal(f.rows.filter(row => row.event === 'cooldown_finished').length, 1);
    assert.ok(f.rows.some(row => row.event === 'claim_rejected_from_queue' && row.reason === 'retry_wait'));
});

test('duplicate callbacks are coalesced while late unique terminal signals retain original session', t => {
    let ok, fail; let current = session;
    const rows = [];
    const q = new ClaimQueue((_, success, failure) => { ok = success; fail = failure; }, () => {}, () => {}, 120_000,
        { context: () => ({ session: current }), record: (event, fields, context) => rows.push({ event, ...fields, ...context }) });
    q.start(); q.enqueue(request()); q.stop(); current = 'abcdefab-abcd-4abc-8abc-abcdefabcdef'; q.start();
    for (let i = 0; i < 100; i++) ok(); fail({ status: 500 }); q.stop();
    assert.equal(rows.filter(row => row.event === 'on_redeemed').length, 1);
    assert.equal(rows.find(row => row.event === 'on_error').session, session);
});
