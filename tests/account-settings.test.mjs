import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTS } from './helpers.mjs';
const A = '123456789012345678', B = '234567890123456789';
const { accountNotificationSettings, updateAccountNotificationSettings } = await loadTS('accountSettings.ts');

test('ownerless legacy destinations migrate once to current account; new accounts are unconfigured', () => {
    const store = { webhookUrl: 'webhook-A', botNotificationsEnabled: true, botNotificationMode: 'direct', botServiceUrl: 'https://service-A.example', botNotificationKey: 'key-A', botDirectAccounts: '' };
    assert.equal(accountNotificationSettings(store, '').webhookUrl, '');
    assert.equal(store.notificationAccounts, undefined);
    const a = accountNotificationSettings(store, A);
    assert.equal(a.webhookUrl, 'webhook-A'); assert.equal(a.botNotificationKey, 'key-A');
    assert.equal(a.botNotificationMode, 'service');
    assert.equal(store.webhookUrl, ''); assert.equal(store.botNotificationKey, '');
    assert.equal(accountNotificationSettings(store, B).webhookUrl, '');
    assert.equal(accountNotificationSettings(store, B).botNotificationsEnabled, false);
    updateAccountNotificationSettings(store, B, { webhookUrl: 'webhook-B', botNotificationKey: 'key-B', botServiceUrl: 'https://service-B.example', botNotificationsEnabled: true });
    for (let i = 0; i < 4; i++) {
        assert.equal(accountNotificationSettings(store, A).webhookUrl, 'webhook-A');
        assert.equal(accountNotificationSettings(store, A).botNotificationKey, 'key-A');
        assert.equal(accountNotificationSettings(store, B).webhookUrl, 'webhook-B');
        assert.equal(accountNotificationSettings(store, B).botNotificationKey, 'key-B');
    }
    store.webhookUrl = 'legacy-after-migration';
    assert.equal(accountNotificationSettings(store, B).webhookUrl, 'webhook-B');
});

test('malformed account configuration fails closed without exposing values or overwriting storage', () => {
    const store = { notificationAccounts: '{private-key', webhookUrl: 'old' };
    assert.throws(() => accountNotificationSettings(store, A), /account notification settings/);
    assert.equal(store.notificationAccounts, '{private-key');
});
