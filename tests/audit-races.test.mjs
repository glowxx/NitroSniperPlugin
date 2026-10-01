import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTS } from './helpers.mjs';
import { NotificationService } from '../bot/service.mjs';
const { ClaimQueue } = await loadTS('claimQueue.ts');
const code = 'abcdefghijklmnop';
const user = '123456789012345678';
const event = id => ({ eventId: id.repeat(16), kind: 'claimed', discordUserId: user, occurredAt: new Date().toISOString() });

test('restarting cannot overlap a still dispatched redemption', () => {
    const calls = [], completed = [];
    const queue = new ClaimQueue((r, ok) => calls.push({ r, ok }), (r) => completed.push(r.code), () => {});
    try {
        queue.start(); queue.enqueue({ code }); queue.stop(); queue.start();
        queue.enqueue({ code: 'qrstuvwxyzABCDEF' });
        assert.equal(calls.length, 1);
        calls[0].ok(); assert.equal(calls.length, 2); assert.deepEqual(completed, []);
        calls[1].ok(); assert.deepEqual(completed, ['qrstuvwxyzABCDEF']);
    } finally { queue.stop(); }
});
test('cancelled pending codes can be queued again and deduplication is account-scoped', () => {
    const calls = [];
    const queue = new ClaimQueue((r, ok) => calls.push({ r, ok }), () => {}, () => {});
    try {
        queue.start(); queue.enqueue({ code, claimantId: user });
        queue.enqueue({ code: 'qrstuvwxyzABCDEF', claimantId: user }); queue.stop(); queue.start();
        assert.equal(queue.enqueue({ code: 'qrstuvwxyzABCDEF', claimantId: user }), true);
        assert.equal(queue.enqueue({ code, claimantId: '234567890123456789' }), true);
        calls[0].ok(); calls[1].ok(); calls[2].ok();
    } finally { queue.stop(); }
});
test('disconnect/relink during a batch never sends previously cancelled rows', async () => {
    let release; const sent = [];
    const service = new NotificationService({ database: ':memory:', sendDM: (id, payload) => {
        sent.push(payload); return sent.length === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
    } });
    const key = service.link(user); service.enqueue(event('a'), key); service.enqueue(event('b'), key);
    try {
        const delivery = service.deliverDue(); service.disconnect(user); service.link(user); release(); await delivery;
        assert.equal(sent.length, 1);
        assert.equal(service.db.prepare("SELECT count(*) AS count FROM events WHERE state='cancelled'").get().count, 2);
    } finally { service.close(); }
});

test('closed DMs fail the existing account backlog without repeatedly hitting Discord', async () => {
    let sent = 0;
    const service = new NotificationService({ database: ':memory:', sendDM: async () => { sent++; throw Object.assign(new Error('closed'), { code: 50007 }); } });
    const key = service.link(user); service.enqueue(event('a'), key); service.enqueue(event('b'), key);
    await service.deliverDue(); assert.equal(sent, 1); assert.equal(service.status(user).pending, 0);
    assert.equal(service.db.prepare("SELECT count(*) AS count FROM events WHERE state='failed'").get().count, 2); service.close();
});
test('shutdown pauses the rest of a delivery batch and leaves its durable events for restart', async () => {
    let release; let sent = 0;
    const service = new NotificationService({ database: ':memory:', sendDM: async () => { sent++; await new Promise(resolve => { release = resolve; }); } });
    const key = service.link(user); service.enqueue(event('a'), key); service.enqueue(event('b'), key);
    const work = service.deliverDue(); service.stop(); release(); await work;
    assert.equal(sent, 1); assert.equal(service.status(user).pending, 1);
    assert.throws(() => service.enqueue(event('c'), key), { status: 503 }); service.close(); service.close();
});
test('a consent guard cancels a DM if the account disconnects during recipient lookup', async () => {
    let release; let sent = 0;
    const service = new NotificationService({ database: ':memory:', sendDM: async (id, payload, canSend) => {
        await new Promise(resolve => { release = resolve; });
        if (!canSend()) return false;
        sent++;
    } });
    service.enqueue(event('a'), service.link(user)); const work = service.deliverDue(); service.disconnect(user); release(); await work;
    assert.equal(sent, 0); assert.equal(service.status(user).latest.state, 'cancelled'); service.close();
});

test('events expiring while an earlier DM is sent are checked again before dispatch', async () => {
    let now = Date.now(); let sent = 0;
    const service = new NotificationService({ database: ':memory:', now: () => now, sendDM: async () => { sent++; now += 2000; } });
    const key = service.link(user); const occurredAt = new Date(now - 86_399_000).toISOString();
    service.enqueue({ ...event('a'), occurredAt }, key); service.enqueue({ ...event('b'), occurredAt }, key);
    await service.deliverDue(); assert.equal(sent, 1);
    assert.equal(service.db.prepare("SELECT state FROM events WHERE event_id=?").get('b'.repeat(16)).state, 'failed'); service.close();
});
