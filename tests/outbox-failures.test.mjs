import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTS } from './helpers.mjs';
const userId = '123456789012345678';
const event = { eventId: 'c'.repeat(64), kind: 'claimed', discordUserId: userId, occurredAt: new Date().toISOString() };
const tick = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 2)); };
globalThis.nsAuditData = { value: undefined, failRead: false, failWrite: false };
const data = globalThis.nsAuditData;
const notifications = await loadTS('notifications.ts', { '@api/DataStore': `
export async function get(){if(globalThis.nsAuditData.failRead)throw new Error('disk read failed');return structuredClone(globalThis.nsAuditData.value)}
export async function set(k,v){if(globalThis.nsAuditData.failWrite)throw new Error('disk write failed');globalThis.nsAuditData.value=structuredClone(v)}` });
let config;
let sends;
function setup() {
    data.value = undefined; data.failRead = false; data.failWrite = false;
    config = { enabled: true, url: 'http://localhost:8787', key: 'K'.repeat(43), userId };
    sends = [];
    globalThis.VencordNative = { pluginHelpers: { NitroSniper: { sendBotNotification: async (...args) => {
        sends.push(args); return { status: 202, data: '{"accepted":true,"state":"queued"}' };
    } } } };
}

test('failed outbox writes cannot leave unsaved events eligible for sending', async t => {
    setup(); const intervals = []; t.mock.method(globalThis, 'setInterval', fn => { intervals.push(fn); return 987654; });
    try {
        await notifications.startNotifications(() => config); await tick(); data.failWrite = true;
        await assert.rejects(notifications.enqueueNotification(event), /write|save|outbox/);
        intervals[0](); await tick(); assert.equal(sends.length, 0);
    } finally { notifications.stopNotifications(); }
});
test('failed outbox reads pause notification writes instead of overwriting unread durable events', async () => {
    setup(); data.value = [{ protected: 'existing durable data' }]; data.failRead = true;
    try {
        await assert.rejects(notifications.startNotifications(() => config), /read|load|outbox/);
        await assert.rejects(notifications.enqueueNotification(event), /read|load|outbox/);
        assert.deepEqual(data.value, [{ protected: 'existing durable data' }]); assert.equal(sends.length, 0);
    } finally { notifications.stopNotifications(); }
});
test('native helper rejection increments backoff rather than retrying every polling tick', async () => {
    setup();
    globalThis.VencordNative.pluginHelpers.NitroSniper.sendBotNotification = async () => { throw new Error('IPC failure'); };
    try {
        await notifications.startNotifications(() => config); await tick();
        await notifications.enqueueNotification(event); await tick();
        assert.equal(data.value[0].attempts, 1); assert.ok(data.value[0].nextAt > Date.now());
    } finally { notifications.stopNotifications(); }
});
test('late status responses cannot update a stopped notification session', async () => {
    setup(); let resolveStatus;
    try {
        await notifications.startNotifications(() => config); await tick();
        globalThis.VencordNative.pluginHelpers.NitroSniper.sendBotNotification = () => new Promise(resolve => { resolveStatus = resolve; });
        const check = notifications.checkBotConnection(); await tick(); notifications.stopNotifications();
        resolveStatus({ status: 200, data: '{"pending":0,"latest":{"state":"delivered"}}' });
        await assert.rejects(check, /stopped|changed|disabled/);
        assert.doesNotMatch(notifications.getNotificationStatus().message, /last DM: delivered/);
    } finally { notifications.stopNotifications(); }
});
test('invalid top-level persisted data is preserved and reported, never silently reset', async () => {
    setup(); data.value = { unexpectedVersion: true };
    try {
        await assert.rejects(notifications.startNotifications(() => config), /outbox|invalid/);
        assert.deepEqual(data.value, { unexpectedVersion: true }); assert.equal(sends.length, 0);
    } finally { notifications.stopNotifications(); }
});

test('confirmed claims persist before optional metadata and survive stopping during its lookup', async () => {
    setup(); let resolveType;
    try {
        await notifications.startNotifications(() => config); await tick();
        const type = new Promise(resolve => { resolveType = resolve; });
        const enqueue = notifications.enqueueNotification(event, notifications.captureNotificationConfig(), type);
        await tick(); assert.equal(data.value.length, 1); assert.equal(sends.length, 0);
        notifications.stopNotifications(); resolveType('Nitro'); await enqueue;
        assert.equal(data.value.length, 1); data.value[0].nextAt = 0;
        await notifications.startNotifications(() => config); await tick(); assert.equal(sends.length, 1);
    } finally { notifications.stopNotifications(); }
});
test('endpoint or key changes during metadata cannot move an old claim to the new connection', async () => {
    setup(); let resolveType;
    try {
        await notifications.startNotifications(() => config); await tick();
        const captured = notifications.captureNotificationConfig();
        const type = new Promise(resolve => { resolveType = resolve; });
        const enqueue = notifications.enqueueNotification(event, captured, type); await tick();
        config.key = 'R'.repeat(43); resolveType('Nitro'); await enqueue; await tick();
        assert.equal(sends.length, 0); assert.equal(data.value.length, 1);
    } finally { notifications.stopNotifications(); }
});
test('malformed JSON replies do not crash delivery or escape bounded retry backoff', async () => {
    setup();
    globalThis.VencordNative.pluginHelpers.NitroSniper.sendBotNotification = async () => ({ status: 200, data: 'null' });
    try {
        await notifications.startNotifications(() => config); await tick(); await notifications.enqueueNotification(event); await tick();
        assert.equal(data.value[0].attempts, 1); assert.ok(data.value[0].nextAt > Date.now());
    } finally { notifications.stopNotifications(); }
});

test('restored outbox records whitelist event fields and reject corrupted identities', async () => {
    setup(); const scope = await notifications.digest(`${config.url}:${config.key}:${userId}`);
    data.value = [
        { scope, event: { ...event, code: 'private-gift-code', botToken: 'private-bot-token' }, attempts: 0, nextAt: 0 },
        { scope, event: { ...event, eventId: { invalid: true } }, attempts: 0, nextAt: 0 }
    ];
    try {
        await notifications.startNotifications(() => config); await tick();
        assert.equal(sends.length, 1); const payload = JSON.parse(sends[0][3]);
        assert.equal(payload.code, undefined); assert.equal(payload.botToken, undefined);
    } finally { notifications.stopNotifications(); }
});

test('API rate limits defer client retries for at least the advertised minute', async () => {
    setup(); globalThis.VencordNative.pluginHelpers.NitroSniper.sendBotNotification = async () => ({ status: 429, data: '{"error":"Retry in a minute"}' });
    try {
        await notifications.startNotifications(() => config); await tick();
        const before = Date.now(); await notifications.enqueueNotification(event); await tick();
        assert.ok(data.value[0].nextAt >= before + 60_000);
    } finally { notifications.stopNotifications(); }
});
