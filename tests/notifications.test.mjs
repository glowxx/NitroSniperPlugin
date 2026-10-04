import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTS } from './helpers.mjs';
const userId = '123456789012345678';
const event = { eventId: 'a'.repeat(64), kind: 'claimed', discordUserId: userId, occurredAt: new Date().toISOString() };
const wait = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 2)); };
const stored = new Map();
globalThis.nsStore = stored;
const notifications = await loadTS('notifications.ts', { '@api/DataStore': `export async function get(k){return structuredClone(globalThis.nsStore.get(k));} export async function set(k,v){globalThis.nsStore.set(k,structuredClone(v));}` });
let config;
let sent;
function setup(reply = { status: 202, data: JSON.stringify({ accepted: true, state: 'queued' }) }) {
    config = { enabled: true, userId, url: 'http://localhost:8787', key: 'K'.repeat(43) };
    sent = [];
    globalThis.VencordNative = { pluginHelpers: { NitroSniper: { sendBotNotification: async (...args) => { sent.push(args); return reply; } } } };
}

test('notification outbox persists before transmission, drains accepted events, and restores after restart', async () => {
    setup({ status: -1, data: '' }); stored.clear();
    await notifications.startNotifications(() => config); await wait();
    await notifications.enqueueNotification(event); await wait();
    assert.equal(sent.length, 1);
    assert.equal(stored.values().next().value.length, 1);
    assert.equal(stored.values().next().value[0].event.discordUserId, userId);
    assert.equal(JSON.stringify(stored.values().next().value).includes(config.key), false);
    notifications.stopNotifications();
    const saved = stored.values().next().value; saved[0].nextAt = 0;
    setup(); await notifications.startNotifications(() => config); await wait();
    assert.equal(sent.length, 1); assert.equal(stored.values().next().value.length, 0);
    notifications.stopNotifications();
});
test('failed claims cannot be enqueued by the claim integration; outbox isolates accounts and rotated keys', async () => {
    setup({ status: 401, data: JSON.stringify({ error: 'Key revoked' }) }); stored.clear();
    await notifications.startNotifications(() => config); await wait();
    await notifications.enqueueNotification(event); await wait(); notifications.stopNotifications();
    const saved = stored.values().next().value; saved[0].nextAt = 0;
    config.key = 'b'.repeat(43); sent = [];
    await notifications.startNotifications(() => config); await wait();
    assert.equal(sent.length, 0);
    await notifications.enqueueNotification({ ...event, discordUserId: '234567890123456789' });
    assert.equal(stored.values().next().value.length, 1); notifications.stopNotifications();
});
test('test DM and status distinguish acceptance from delivery and expose blocked DMs', async () => {
    setup(); stored.clear();
    await notifications.startNotifications(() => config); await wait();
    await notifications.sendTestDM();
    assert.equal(JSON.parse(sent.at(-1)[3]).kind, 'test'); assert.match(notifications.getNotificationStatus().message, /queued/);
    globalThis.VencordNative.pluginHelpers.NitroSniper.sendBotNotification = async () => ({ status: 200, data: JSON.stringify({ pending: 0, latest: { state: 'failed', error: 'Allow DMs' } }) });
    await notifications.checkBotConnection(); assert.equal(notifications.getNotificationStatus().message, 'Allow DMs');
    config.enabled = false; await assert.rejects(notifications.sendTestDM, /disabled/);
    notifications.stopNotifications();
});
