import test from 'node:test';
import assert from 'node:assert/strict';
import { NotificationService } from '../bot/service.mjs';
import { loadTS } from './helpers.mjs';

const userId = '123456789012345678';
const event = id => ({ eventId: id, kind: 'claimed', discordUserId: userId, occurredAt: new Date().toISOString() });

test('a full outbox preserves saved events and exposes a sticky count of unsaved confirmed claims', async t => {
    let poll;
    t.mock.method(globalThis, 'setInterval', fn => { poll = fn; return 123456; });
    globalThis.nsRecoveryStore = [];
    const config = { enabled: true, url: 'http://localhost:8787', key: 'K'.repeat(43), userId };
    const { digest, ...notifications } = await loadTS('notifications.ts', {
        '@api/DataStore': 'export async function get(){return structuredClone(globalThis.nsRecoveryStore)} export async function set(k,v){globalThis.nsRecoveryStore=structuredClone(v)}'
    });
    const scope = await digest(`${config.url}:${config.key}:${userId}`);
    globalThis.nsRecoveryStore = Array.from({ length: 100 }, (_, i) => ({ scope, event: event(String(i).padStart(16, 'a')), attempts: 0, nextAt: Date.now() + 60_000 }));
    globalThis.VencordNative = { pluginHelpers: { NitroSniper: { sendBotNotification: async () => ({ status: 200, data: '{"pending":0}' }) } } };
    try {
        await notifications.startNotifications(() => config);
        await assert.rejects(notifications.enqueueNotification(event('overflow'.padStart(16, 'a'))), /outbox is full/);
        assert.equal(globalThis.nsRecoveryStore.length, 100);
        assert.equal(notifications.getNotificationStatus().unsaved, 1);
        await notifications.checkBotConnection();
        assert.equal(notifications.getNotificationStatus().unsaved, 1);
        poll();
        await new Promise(resolve => setImmediate(resolve));
        config.key = '';
        for (let i = 0; i < 100 && notifications.getNotificationStatus().unsaved !== 0; i++) {
            poll();
            await new Promise(resolve => setTimeout(resolve, 2));
        }
        assert.equal(notifications.getNotificationStatus().unsaved, 0, 'invalid replacement settings must not display old failures');
        config.key = 'R'.repeat(43);
        await notifications.checkBotConnection();
        assert.equal(notifications.getNotificationStatus().unsaved, 0, 'do not attribute old failures to a new connection');
    } finally { notifications.stopNotifications(); }
});

test('optional metadata write failure does not report a durable claim notification as unsaved', async t => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    let poll;
    t.mock.method(globalThis, 'setInterval', fn => { poll = fn; return 123456; });
    const config = { enabled: true, url: 'http://localhost:8787', key: 'K'.repeat(43), userId };
    globalThis.nsEnrichmentStore = { value: [], writes: 0 };
    const notifications = await loadTS('notifications.ts', {
        '@api/DataStore': 'export async function get(){return []} export async function set(k,v){if(++globalThis.nsEnrichmentStore.writes===2)throw new Error("metadata write failed");globalThis.nsEnrichmentStore.value=structuredClone(v)}'
    });
    const sent = [];
    globalThis.VencordNative = { pluginHelpers: { NitroSniper: { sendBotNotification: async (...args) => { sent.push(JSON.parse(args[3])); return { status: 202, data: '{"accepted":true}' }; } } } };
    try {
        await notifications.startNotifications(() => config);
        await assert.doesNotReject(notifications.enqueueNotification(event('a'.repeat(64)), notifications.captureNotificationConfig(), Promise.resolve('Nitro')));
        assert.equal(globalThis.nsEnrichmentStore.value.length, 1);
        assert.equal(notifications.getNotificationStatus().unsaved, 0);
        now += 3001;
        poll();
        for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
        assert.equal(sent.length, 1);
        assert.equal(sent[0].giftType, undefined);
        assert.equal(globalThis.nsEnrichmentStore.value.length, 0);
    } finally { notifications.stopNotifications(); }
});

test('failed event persistence is visible and never sends the unsaved claim', async () => {
    let sent = 0;
    const config = { enabled: true, url: 'http://localhost:8787', key: 'K'.repeat(43), userId };
    const notifications = await loadTS('notifications.ts', {
        '@api/DataStore': 'export async function get(){return []} export async function set(){throw new Error("disk write failed")}'
    });
    globalThis.VencordNative = { pluginHelpers: { NitroSniper: { sendBotNotification: async () => { sent++; return { status: 202, data: '{"accepted":true}' }; } } } };
    try {
        await notifications.startNotifications(() => config);
        await assert.rejects(notifications.enqueueNotification(event('a'.repeat(64))), /write/);
        assert.equal(notifications.getNotificationStatus().unsaved, 1);
        assert.equal(sent, 0);
    } finally { notifications.stopNotifications(); }
});

test('a Discord REST outage longer than thirty minutes remains retryable until the delivery window expires', async () => {
    let now = Date.now();
    const began = now;
    let sent = 0;
    let offline = true;
    const service = new NotificationService({ database: ':memory:', now: () => now, sendDM: async () => {
        sent++;
        if (offline) throw new Error('temporary Discord REST outage');
    } });
    try {
        const key = service.link(userId);
        service.enqueue({ ...event('a'.repeat(64)), occurredAt: new Date(now).toISOString() }, key);
        for (let i = 0; i < 20; i++) {
            now = service.db.prepare('SELECT next_at FROM events').get().next_at;
            await service.deliverDue();
        }
        assert.ok(now - began > 30 * 60_000);
        assert.equal(service.status(userId).latest.state, 'queued');
        offline = false;
        now = service.db.prepare('SELECT next_at FROM events').get().next_at;
        await service.deliverDue();
        assert.equal(service.status(userId).latest.state, 'delivered');
        const beforeExpiry = sent;
        service.enqueue({ ...event('b'.repeat(64)), occurredAt: new Date(began).toISOString() }, key);
        now = began + 86_400_000;
        await service.deliverDue();
        assert.equal(sent, beforeExpiry);
        assert.equal(service.status(userId).latest.state, 'failed');
    } finally { service.close(); }
});

test('an event expiring during recipient lookup cannot dispatch a DM', async () => {
    let now = Date.now();
    let sent = 0;
    const service = new NotificationService({ database: ':memory:', now: () => now, sendDM: async (id, payload, canSend) => {
        now += 2000;
        if (!canSend()) return false;
        sent++;
    } });
    try {
        service.enqueue({ ...event('a'.repeat(64)), occurredAt: new Date(now - 86_399_000).toISOString() }, service.link(userId));
        await service.deliverDue();
        assert.equal(sent, 0);
        await service.deliverDue();
        assert.equal(service.status(userId).latest.state, 'failed');
        assert.match(service.status(userId).latest.error, /expired/);
    } finally { service.close(); }
});
