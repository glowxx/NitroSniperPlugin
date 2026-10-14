import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTS } from './helpers.mjs';
const A = '123456789012345678', B = '234567890123456789';
const cfg = { enabled: true, userId: A, url: 'http://localhost:8787', key: 'A'.repeat(43), mode: 'service' };
for (const action of ['stop', 'logout', 'switch']) {
    test(`captured confirmed claim persists exactly once despite ${action} during asynchronous preparation`, async () => {
        globalThis.nsConfirmed = [];
        const n = await loadTS('notifications.ts', { '@api/DataStore': 'export async function get(){return structuredClone(globalThis.nsConfirmed)} export async function set(k,v){globalThis.nsConfirmed=structuredClone(v)}' });
        let current = { ...cfg };
        await n.startNotifications(() => current);
        const captured = n.captureNotificationConfig();
        n.stopNotifications();
        if (action === 'switch') { current = { ...cfg, userId: B, key: 'B'.repeat(43) }; await n.startNotifications(() => current); }
        if (action === 'logout') current = { ...cfg, userId: '', enabled: false };
        const event = { eventId: 'c'.repeat(64), kind: 'claimed', discordUserId: A, occurredAt: new Date().toISOString() };
        try {
            await n.enqueueNotification(event, captured);
            await n.enqueueNotification(event, captured);
            assert.equal(globalThis.nsConfirmed.length, 1);
            assert.equal(globalThis.nsConfirmed[0].event.discordUserId, A);
            assert.equal(globalThis.nsConfirmed[0].scope, await n.digest(`${cfg.url}:${cfg.key}:${A}`));
        } finally { n.stopNotifications(); }
    });
}
