import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NotificationService, buildMessage } from '../bot/service.mjs';
import { createDMSender, createTestDMDeleter } from '../bot/sendDM.mjs';
import { Client, User, Routes } from 'discord.js';

const userId = '123456789012345678';
const botId = '234567890123456789';
const channelId = '345678901234567890';
const messageId = '456789012345678901';
const started = Date.parse('2026-10-14T12:00:00Z');

function fixture(t, { persisted = false, remove = async () => {}, send } = {}) {
    let now = started, identity = botId, sequence = 0;
    const sent = [], deleted = [];
    const dir = persisted ? mkdtempSync(join(tmpdir(), 'nitrosniper-cleanup-')) : undefined;
    const database = dir ? join(dir, 'state.sqlite') : ':memory:';
    const options = { database, now: () => now, botId: () => identity,
        sendDM: send ?? (async () => {
            const receipt = { channelId, messageId: String(BigInt(messageId) + BigInt(sequence++)), botId: identity, createdAt: now };
            sent.push(receipt); return receipt;
        }), deleteTestDM: async (job, canDelete, signal) => {
            assert.equal(canDelete(), true);
            assert.equal(job.bot_id, identity);
            deleted.push(job.message_id); return remove(job, signal);
        } };
    let service = new NotificationService(options);
    const key = service.link(userId);
    t.after(() => { service.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });
    return { get service() { return service; }, sent, deleted, database,
        advance(ms) { now += ms; }, bot(id) { identity = id; },
        restart() { service.close(); service = new NotificationService(options); },
        enqueue(kind = 'test', id = String(sequence).padStart(16, 'a')) {
            return service.enqueue({ eventId: id, kind, discordUserId: userId, occurredAt: new Date(now).toISOString(),
                // Attacker supplied source IDs must not become deletion targets.
                channelId: '567890123456789012', messageId: '678901234567890123' }, key);
        }, pending() { return service.db.prepare('SELECT * FROM test_cleanups ORDER BY message_id').all(); }
    };
}

test('delivered test receipt is durable and deleted exactly at thirty seconds; claims stay permanent', async () => {
    let now = started;
    const deleted = [];
    const service = new NotificationService({ database: ':memory:', now: () => now,
        sendDM: async () => ({ botId, channelId, messageId, createdAt: now }),
        deleteTestDM: async job => deleted.push(job.message_id), botId: () => botId });
    try {
        const key = service.link(userId);
        for (const kind of ['test', 'claimed']) service.enqueue({ eventId: kind.padEnd(16, 'a'), kind,
            discordUserId: userId, occurredAt: new Date(now).toISOString() }, key);
        await service.deliverDue();
        assert.equal(service.db.prepare('SELECT count(*) AS n FROM test_cleanups').get().n, 1);
        now += 29_999; await service.deliverDue(); assert.deepEqual(deleted, []);
        now++; await service.deliverDue(); await service.deliverDue();
        assert.deepEqual(deleted, [messageId]);
        assert.equal(service.db.prepare('SELECT count(*) AS n FROM test_cleanups').get().n, 0);
    } finally { service.close(); }
});

for (const restartAt of [10_000, 60_000]) test(`SQLite cleanup survives process replacement at ${restartAt / 1000} seconds`, async t => {
    const f = fixture(t, { persisted: true });
    f.enqueue(); await f.service.deliverDue();
    const originalDeadline = f.pending()[0].delete_at;
    f.advance(restartAt); f.restart();
    assert.equal(f.pending()[0].delete_at, originalDeadline);
    await f.service.deliverDue();
    if (restartAt < 30_000) {
        assert.deepEqual(f.deleted, []);
        f.advance(30_000 - restartAt); await f.service.deliverDue();
    }
    await f.service.deliverDue();
    assert.deepEqual(f.deleted, [messageId]); assert.equal(f.pending().length, 0);
    assert.equal(f.sent.length, 1, 'Restart must not resend an already delivered test');
});

test('repeated test DMs keep their own identities and original independent deadlines', async t => {
    const f = fixture(t, { persisted: true });
    f.enqueue(); await f.service.deliverDue(); f.advance(10_000);
    f.enqueue(); await f.service.deliverDue();
    assert.deepEqual(f.pending().map(job => job.delete_at), [started + 30_000, started + 40_000]);
    f.restart(); f.advance(20_000); await f.service.deliverDue();
    assert.deepEqual(f.deleted, [f.sent[0].messageId]);
    f.advance(10_000); await f.service.deliverDue(); await f.service.deliverDue();
    assert.deepEqual(f.deleted, f.sent.map(receipt => receipt.messageId));
});

test('claim receipt never enters cleanup through deadlines, transient failures, or restarts', async t => {
    const f = fixture(t, { persisted: true });
    f.enqueue('claimed'); await f.service.deliverDue();
    assert.equal(f.pending().length, 0);
    f.advance(60_000); f.restart(); await f.service.deliverDue();
    f.advance(8 * 86_400_000); f.restart(); await f.service.deliverDue();
    assert.deepEqual(f.deleted, []); assert.equal(f.pending().length, 0);
});

for (const failure of [{ status: 404 }, { code: 10008 }]) test(`already deleted test completes cleanup: ${JSON.stringify(failure)}`, async t => {
    const f = fixture(t, { remove: async () => { throw Object.assign(new Error('raw secret response'), failure); } });
    f.enqueue(); await f.service.deliverDue(); f.advance(30_000);
    await f.service.deliverDue(); await f.service.deliverDue();
    assert.equal(f.pending().length, 0); assert.deepEqual(f.deleted, [messageId]);
});

test('429 retry_after and bot-wide backpressure survive restart without hitting another test early', async t => {
    let fail = true;
    const f = fixture(t, { persisted: true, remove: async () => {
        if (fail) throw Object.assign(new Error('raw Discord body'), { status: 429, rawError: { retry_after: 12.5 } });
    } });
    f.enqueue(); await f.service.deliverDue(); f.enqueue(); await f.service.deliverDue();
    f.advance(30_000); await f.service.deliverDue();
    assert.equal(f.deleted.length, 1);
    assert.equal(f.pending()[0].next_at, started + 42_500);
    f.restart(); f.advance(12_499); await f.service.deliverDue(); assert.equal(f.deleted.length, 1);
    fail = false; f.advance(1); await f.service.deliverDue();
    assert.equal(f.pending().length, 0); assert.equal(f.deleted.length, 3);
});

for (const failure of [{ status: 500 }, {}]) test(`transient DELETE failure remains durable with bounded backoff: ${JSON.stringify(failure)}`, async t => {
    let fail = true;
    const f = fixture(t, { persisted: true, remove: async () => {
        if (fail) throw Object.assign(new Error('raw secret HTML'), failure);
    } });
    f.enqueue(); await f.service.deliverDue(); f.advance(30_000); await f.service.deliverDue();
    assert.equal(f.pending().length, 1); assert.equal(f.pending()[0].next_at, started + 35_000);
    assert.doesNotMatch(JSON.stringify(f.pending()), /raw secret/);
    f.restart(); f.advance(4_999); await f.service.deliverDue(); assert.equal(f.deleted.length, 1);
    f.advance(1); fail = false; await f.service.deliverDue(); assert.equal(f.pending().length, 0);
});

test('authorization failure pauses the whole bot for an hour and preserves recovery state', async t => {
    let revoked = true;
    const f = fixture(t, { persisted: true, remove: async () => {
        if (revoked) throw Object.assign(new Error('token secret'), { status: 401 });
    } });
    f.enqueue(); await f.service.deliverDue(); f.enqueue(); await f.service.deliverDue();
    f.advance(30_000); await f.service.deliverDue();
    assert.equal(f.deleted.length, 1); assert.equal(f.pending().length, 2);
    assert.match(f.service.status(userId).cleanup.error, /original bot credential/);
    f.restart(); f.advance(3_599_999); await f.service.deliverDue(); assert.equal(f.deleted.length, 1);
    revoked = false; f.advance(1); await f.service.deliverDue(); assert.equal(f.pending().length, 0);
});

test('corrupt persisted entries are rejected without stopping valid cleanup or exposing response content', async t => {
    const f = fixture(t, { persisted: true });
    f.enqueue(); await f.service.deliverDue(); f.enqueue(); await f.service.deliverDue();
    f.service.db.prepare('UPDATE test_cleanups SET message_id=?,next_at=? WHERE message_id=?')
        .run('not-a-snowflake', Number.MAX_SAFE_INTEGER, f.sent[0].messageId);
    f.restart(); assert.equal(f.pending().length, 1);
    f.advance(30_000); await f.service.deliverDue();
    assert.deepEqual(f.deleted, [f.sent[1].messageId]);
});

test('same-bot token rotation remains eligible; an unrelated replacement bot never deletes old DMs', async t => {
    const f = fixture(t, { persisted: true });
    f.enqueue(); await f.service.deliverDue();
    f.bot('789012345678901234'); f.advance(30_000); f.restart(); await f.service.deliverDue();
    assert.deepEqual(f.deleted, []); assert.equal(f.pending().length, 1);
    assert.match(f.service.status(userId).cleanup.error, /Original bot/);
    f.bot(botId); f.advance(3_600_000); f.restart(); await f.service.deliverDue();
    assert.deepEqual(f.deleted, [messageId]);
});

test('disconnect revokes service consent but bot-owned cleanup continues without any plaintext token retention', async t => {
    const f = fixture(t, { persisted: true });
    f.enqueue(); await f.service.deliverDue(); f.service.disconnect(userId);
    assert.equal(f.service.status(userId).linked, false);
    assert.deepEqual(Object.keys(f.pending()[0]).sort(), ['attempts', 'bot_id', 'channel_id', 'delete_at', 'error', 'event_id', 'message_id', 'next_at', 'user_id']);
    f.restart(); f.advance(30_000); await f.service.deliverDue();
    assert.deepEqual(f.deleted, [messageId]);
});

test('SQLite upgrade is additive and idempotent on an existing delivery database', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'nitrosniper-migration-')); const database = join(dir, 'state.sqlite');
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const old = new DatabaseSync(database);
    old.exec(`CREATE TABLE links(user_id TEXT PRIMARY KEY,token_hash TEXT UNIQUE NOT NULL,linked_at INTEGER NOT NULL);
        CREATE TABLE events(user_id TEXT NOT NULL,event_id TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,error TEXT,PRIMARY KEY(user_id,event_id));`);
    old.prepare('INSERT INTO links VALUES(?,?,?)').run(userId, 'existing-hash', started);
    old.close();
    for (let i = 0; i < 2; i++) {
        const service = new NotificationService({ database, sendDM: async () => {} });
        assert.equal(service.db.prepare('SELECT token_hash FROM links WHERE user_id=?').get(userId).token_hash, 'existing-hash');
        assert.equal(service.db.prepare('SELECT count(*) AS n FROM test_cleanups').get().n, 0);
        service.close();
    }
});

test('shutdown during DELETE drains one owned operation and restart retries safely', async t => {
    let entered, released;
    const inDelete = new Promise(resolve => { entered = resolve; });
    const release = new Promise(resolve => { released = resolve; });
    const f = fixture(t, { persisted: true, remove: async (job, signal) => {
        entered(); await release;
        if (signal.aborted) throw new Error('aborted');
    } });
    f.enqueue(); await f.service.deliverDue(); f.advance(30_000);
    const worker = f.service.deliverDue(); await inDelete;
    await f.service.deliverDue(); assert.equal(f.deleted.length, 1);
    assert.throws(() => f.service.close(), /Wait for the delivery worker/);
    f.service.stop(); released(); await worker;
    assert.equal(f.pending().length, 1);
    f.restart(); f.advance(5_000); await f.service.deliverDue(); assert.equal(f.pending().length, 0);
});

test('a worker that loses its lease during DELETE cannot mutate the replacement worker state', async t => {
    let entered, release;
    const inDelete = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const f = fixture(t, { remove: async () => { entered(); await gate; throw Object.assign(new Error('failed'), { status: 429 }); } });
    f.enqueue(); await f.service.deliverDue(); f.advance(30_000);
    const worker = f.service.deliverDue(); await inDelete;
    const before = f.pending();
    f.service.db.prepare('UPDATE worker_lease SET owner=?').run('replacement'); release(); await worker;
    assert.deepEqual(f.pending(), before);
    assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM cleanup_backoff').get().n, 0);
    assert.equal(f.service.stopping, true);
});

test('test cleanup capacity rejects another test before sending while real claims remain deliverable', async t => {
    const f = fixture(t);
    const insert = f.service.db.prepare('INSERT INTO test_cleanups(user_id,event_id,bot_id,channel_id,message_id,delete_at,next_at) VALUES(?,?,?,?,?,?,?)');
    for (let i = 0; i < 100; i++) insert.run(userId, String(i).padStart(16, 'z'), botId, channelId,
        String(BigInt(messageId) + BigInt(i)), started + 30_000, started + 30_000);
    assert.throws(() => f.enqueue(), { status: 429 });
    f.enqueue('claimed'); await f.service.deliverDue(); assert.equal(f.sent.length, 1); assert.equal(f.pending().length, 100);
});

test('service SDK adapter records only returned message identity and calls official DELETE with matching bot', async t => {
    const client = new Client({ intents: [] }); t.after(() => client.destroy());
    client.user = { id: botId };
    const user = new User(client, { id: userId, username: 'recipient', discriminator: '0', avatar: null });
    client.users.fetch = async () => user;
    user.createDM = async () => ({ id: channelId, client });
    client.rest.post = async route => {
        assert.equal(route, Routes.channelMessages(channelId));
        return { id: messageId, channel_id: channelId, author: { id: botId }, timestamp: new Date(started).toISOString() };
    };
    const receipt = await createDMSender(client)(userId, { content: 'test' }, () => true);
    assert.deepEqual(receipt, { channelId, messageId, botId, createdAt: started });
    const deleted = [];
    client.rest.delete = async (route, options) => { deleted.push(route); assert.equal(options.signal.aborted, false); };
    const remove = createTestDMDeleter(client);
    const job = { bot_id: botId, channel_id: channelId, message_id: messageId };
    await remove(job, () => true, new AbortController().signal);
    assert.deepEqual(deleted, [Routes.channelMessage(channelId, messageId)]);
    await assert.rejects(remove({ ...job, bot_id: '789012345678901234' }, () => true), { status: 403 });
    assert.equal(deleted.length, 1);
});

test('SDK success received during shutdown remains durable for test cleanup', async t => {
    const client = new Client({ intents: [] }); t.after(() => client.destroy());
    client.user = { id: botId };
    const user = new User(client, { id: userId, username: 'recipient', discriminator: '0', avatar: null });
    client.users.fetch = async () => user; user.createDM = async () => ({ id: channelId, client });
    let entered, release;
    const inPost = new Promise(resolve => { entered = resolve; });
    const response = new Promise(resolve => { release = resolve; });
    client.rest.post = () => { entered(); return response; };
    const service = new NotificationService({ database: ':memory:', now: () => started, botId: () => botId, sendDM: createDMSender(client) });
    try {
        service.enqueue({ eventId: 'shutdown-test-event', kind: 'test', discordUserId: userId, occurredAt: new Date(started).toISOString() }, service.link(userId));
        const delivery = service.deliverDue(); await inPost; service.stop();
        release({ id: messageId, channel_id: channelId, author: { id: botId }, timestamp: new Date(started).toISOString() });
        await delivery;
        assert.equal(service.db.prepare('SELECT count(*) AS n FROM test_cleanups').get().n, 1);
        assert.equal(service.status(userId).latest.state, 'delivered');
    } finally { service.close(); }
});

test('test and claimed message nonces remain separate even for the same structured event ID', () => {
    const event = { eventId: 'same-event-identifier', discordUserId: userId, occurredAt: new Date(started).toISOString() };
    assert.notEqual(buildMessage({ ...event, kind: 'test' }).nonce, buildMessage({ ...event, kind: 'claimed' }).nonce);
});

test('a server timestamp behind the service clock never makes a new test expire immediately', async t => {
    const f = fixture(t, { send: async () => ({ botId, channelId, messageId, createdAt: started - 600_000 }) });
    f.enqueue(); await f.service.deliverDue(); await f.service.deliverDue();
    assert.deepEqual(f.deleted, []); f.advance(29_999); await f.service.deliverDue(); assert.deepEqual(f.deleted, []);
    f.advance(1); await f.service.deliverDue(); assert.deepEqual(f.deleted, [messageId]);
});
