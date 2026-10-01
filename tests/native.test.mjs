import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTS } from './helpers.mjs';
const native = await loadTS('native.ts');
const key = 'K'.repeat(43);
test('native transport scopes routes, attaches only notification key and forbids redirects', async t => {
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => { requests.push([url.toString(), options]); return new Response('{"accepted":true}', { status: 202 }); });
    const result = await native.sendBotNotification(null, 'http://localhost:8787', key, 'event', '{}');
    assert.equal(result.status, 202);
    assert.equal(requests[0][0], 'http://localhost:8787/v1/events');
    assert.equal(requests[0][1].headers.Authorization, `Bearer ${key}`);
    assert.equal(requests[0][1].redirect, 'error'); assert.ok(requests[0][1].signal instanceof AbortSignal);
    await native.sendBotNotification(null, 'http://localhost:8787', key, 'status', '123456789012345678');
    assert.match(requests[1][0], /\/v1\/status\?discordUserId=/); assert.equal(requests[1][1].method, 'GET');
    await assert.rejects(() => native.sendBotNotification(null, 'http://localhost:8787', key, 'delete', '{}'));
    await assert.rejects(() => native.sendBotNotification(null, 'http://localhost:8787', key, 'event', 'a'.repeat(8193)));
    await assert.rejects(() => native.sendWebhook(null, 'https://evil.com', '{}')); assert.equal(requests.length, 2);
});
test('native transport bounds replies and redacts raw network errors containing credentials', async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response('a'.repeat(65_537)));
    assert.equal((await native.sendBotNotification(null, 'http://localhost:8787', key, 'event', '{}')).status, -1);
    globalThis.fetch = async () => { throw new Error(`request with secret ${key}`); };
    const result = await native.sendBotNotification(null, 'http://localhost:8787', key, 'event', '{}');
    assert.equal(result.status, -1); assert.equal(result.data.includes(key), false);
});
