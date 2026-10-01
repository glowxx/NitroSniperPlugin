import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotificationService, createApi, validateEvent, buildMessage } from '../bot/service.mjs';
const user = '123456789012345678';
const other = '234567890123456789';
const event = (id = 'a'.repeat(64)) => ({ eventId: id, kind: 'claimed', discordUserId: user, occurredAt: new Date().toISOString(), giftType: 'Nitro @everyone' });
function setup(sendDM = async () => {}, database = ':memory:') { return new NotificationService({ sendDM, database }); }

test('keys scoped to account; rotation/revocation invalidates prior keys; stored hashed only', () => {
    const service = setup(); const key = service.link(user);
    assert.equal(key.length, 43); assert.equal(service.authenticate(key, user).user_id, user);
    assert.throws(() => service.authenticate(key, other), { status: 403 });
    assert.throws(() => service.authenticate('garbage', user), { status: 401 });
    assert.notEqual(service.db.prepare('SELECT token_hash FROM links').get().token_hash, key);
    service.link(user); assert.throws(() => service.authenticate(key, user), { status: 401 });
    const fresh = service.link(user); service.disconnect(user); assert.throws(() => service.authenticate(fresh, user), { status: 401 }); service.close();
});
test('deduplicates across accounts and restarts, and delivers a single DM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nitrosniper-')); const db = join(dir, 'state.sqlite'); const sent = [];
    let service = setup(async (...args) => sent.push(args), db); const key = service.link(user);
    assert.equal(service.enqueue(event(), key).duplicate, false); service.close();
    service = setup(async (...args) => sent.push(args), db);
    assert.equal(service.enqueue(event(), key).duplicate, true); await service.deliverDue(); await service.deliverDue();
    assert.equal(sent.length, 1); assert.equal(service.status(user).latest.state, 'delivered');
    assert.equal(service.enqueue(event(), key).state, 'delivered');
    const secondKey = service.link(other); service.enqueue({ ...event(), discordUserId: other }, secondKey); await service.deliverDue();
    assert.equal(sent.length, 2); service.close(); rmSync(dir, { recursive: true });
});
test('temporary network failure retries; closed DM fails permanently without a retry loop', async () => {
    let calls = 0; const service = setup(async () => { calls++; if (calls === 1) throw new Error('network'); });
    const key = service.link(user); service.enqueue(event(), key); await service.deliverDue();
    assert.equal(service.status(user).latest.state, 'queued');
    service.db.prepare('UPDATE events SET next_at=0').run(); await service.deliverDue();
    assert.equal(service.status(user).latest.state, 'delivered'); service.close();
    const blocked = setup(async () => { throw Object.assign(new Error('blocked'), { code: 50007 }); });
    blocked.enqueue(event(), blocked.link(user)); await blocked.deliverDue();
    assert.equal(blocked.status(user).latest.state, 'failed'); assert.match(blocked.status(user).latest.error, /Allow DMs/); blocked.close();
});
test('concurrent workers do not duplicate; disconnect cancels in-flight state', async () => {
    let finish; let calls = 0;
    const service = setup(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
    service.enqueue(event(), service.link(user)); const work = service.deliverDue(); await service.deliverDue();
    assert.equal(calls, 1); service.disconnect(user); finish(); await work;
    assert.equal(service.status(user).latest.state, 'cancelled'); service.close();
});
test('validates event times, sizes, kind, source IDs and never forwards arbitrary fields', () => {
    assert.throws(() => validateEvent({ ...event(), kind: 'failed' }), { status: 400 });
    assert.throws(() => validateEvent({ ...event(), occurredAt: 'invalid' }), { status: 400 });
    assert.throws(() => validateEvent({ ...event(), occurredAt: new Date(Date.now() - 90_000_000).toISOString() }), { status: 400 });
    assert.throws(() => validateEvent({ ...event(), channelId: 'bad' }), { status: 400 });
    assert.throws(() => validateEvent({ ...event(), giftType: 'a'.repeat(201) }), { status: 400 });
    const clean = validateEvent({ ...event(), recipient: other, code: 'secret-gift', embeds: [{}] });
    assert.equal(clean.recipient, undefined); assert.equal(clean.code, undefined); assert.equal(clean.embeds, undefined);
    const message = buildMessage(clean); assert.deepEqual(message.allowedMentions.parse, []); assert.equal(message.enforceNonce, true);
    assert.equal(message.nonce, buildMessage(clean).nonce); assert.ok(message.nonce.length <= 25);
});
test('enforces per-account rate limits; duplicates bypass rate limits', () => {
    const service = setup(); const key = service.link(user);
    for (let i = 0; i < 10; i++) service.enqueue(event(String(i).padStart(16, 'a')), key);
    assert.throws(() => service.enqueue(event('b'.repeat(16)), key), { status: 429 });
    assert.equal(service.enqueue(event('a'.repeat(15) + '0'), key).duplicate, true); service.close();
});
test('HTTP contract: health, auth, account mismatch, bad JSON, payload limit, status and durable acceptance', async () => {
    const service = setup(); const key = service.link(user); let ready = false;
    const server = createApi(service, { ready: () => ready });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const post = (body, token = key) => fetch(url + '/v1/events', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body });
    try {
        assert.equal((await fetch(url + '/health')).status, 503); ready = true;
        assert.equal((await fetch(url + '/health')).status, 200);
        assert.equal((await post(JSON.stringify(event()), 'bad')).status, 401);
        assert.equal((await post(JSON.stringify({ ...event(), discordUserId: other }))).status, 403);
        assert.equal((await post('{')).status, 400);
        assert.equal((await post('a'.repeat(9000))).status, 413);
        const accepted = await post(JSON.stringify(event())); assert.equal(accepted.status, 202); assert.equal((await accepted.json()).accepted, true);
        await service.deliverDue();
        const status = await fetch(url + `/v1/status?discordUserId=${user}`, { headers: { authorization: `Bearer ${key}` } });
        assert.equal((await status.json()).latest.state, 'delivered');
        assert.equal((await fetch(url + '/v1/status?discordUserId=' + user)).status, 401);
        assert.equal((await fetch(url + '/unknown')).status, 404);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); service.close(); }
});


test('expiry uses event time rather than ingestion time, with normalized timestamps', async () => {
    let now = Date.now(); let sent = 0;
    const service = new NotificationService({ database: ':memory:', now: () => now, sendDM: async () => { sent++; } });
    const key = service.link(user);
    service.enqueue({ ...event(), occurredAt: new Date(now - 86_390_000).toISOString() }, key);
    now += 20_000; await service.deliverDue();
    assert.equal(sent, 0); assert.equal(service.status(user).latest.state, 'failed');
    assert.equal(validateEvent({ ...event(), occurredAt: new Date().toUTCString() }).occurredAt.endsWith('Z'), true);
    for (const body of [{ ...event(), eventId: ['a'.repeat(64)] }, { ...event(), discordUserId: [user] }, { ...event(), channelId: [user] }]) assert.throws(() => validateEvent(body), { status: 400 });
    service.close();
});

test('exhausted delivery attempts fail visibly instead of retrying forever', async () => {
    const service = setup(async () => { throw new Error('offline'); });
    service.enqueue(event(), service.link(user));
    service.db.prepare('UPDATE events SET attempts=11').run(); await service.deliverDue();
    assert.equal(service.status(user).latest.state, 'failed'); assert.match(service.status(user).latest.error, /repeated attempts/); service.close();
});

test('a second bot process cannot share the same database and duplicate delivery', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nitrosniper-lease-')); const database = join(dir, 'state.sqlite');
    const first = setup(async () => {}, database); const key = first.link(user); first.enqueue(event(), key);
    assert.throws(() => setup(async () => {}, database), /Another notification bot/);
    first.close(); let sent = 0; const replacement = setup(async () => { sent++; }, database);
    await replacement.deliverDue(); assert.equal(sent, 1); replacement.close(); rmSync(dir, { recursive: true });
});
test('a worker losing its database lease stops sending and cannot delete the replacement lease', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nitrosniper-lease-')); const database = join(dir, 'state.sqlite'); let sent = 0;
    const first = setup(async () => { sent++; }, database); first.enqueue(event(), first.link(user));
    first.db.prepare('UPDATE worker_lease SET expires_at=0').run();
    const replacement = setup(async () => { sent++; }, database);
    await first.deliverDue(); assert.equal(sent, 0); assert.equal(first.stopping, true);
    first.close(); assert.equal(replacement.ownsLease(), true);
    await replacement.deliverDue(); assert.equal(sent, 1); replacement.close(); rmSync(dir, { recursive: true });
});
