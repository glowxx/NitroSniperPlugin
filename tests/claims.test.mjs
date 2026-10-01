import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTS } from './helpers.mjs';
const { ClaimQueue, extractGiftCodes } = await loadTS('claimQueue.ts');
const { parseServiceUrl, parseDiscordWebhook } = await loadTS('notificationProtocol.ts');
const code = 'abcdefghijklmnop';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('extracts multiple real gift links, deduplicates, rejects spoofed and truncated URLs', () => {
    assert.deepEqual(extractGiftCodes(`https://discord.gift/${code} (https://discord.com/gifts/qrstuvwxyzABCDEF) discord.gift/${code}`), [code, 'qrstuvwxyzABCDEF']);
    for (const text of [`https://evil-discord.gift/${code}`, `https://evil.example/discord.gift/${code}`, `https://discord.gift/${code}1234567890`, `discord.gift/${code.slice(0, 15)}`]) assert.deepEqual(extractGiftCodes(text), []);
});
test('requires HTTPS, prevents credential URLs, arbitrary webhook hosts and path injection', () => {
    assert.equal(parseServiceUrl(' http://localhost:8787 ').origin, 'http://localhost:8787');
    assert.equal(parseServiceUrl('https://notify.example.com').origin, 'https://notify.example.com');
    for (const url of ['http://notify.example.com', 'https://user:key@example.com', 'https://example.com/path', 'https://example.com/?key=x']) assert.throws(() => parseServiceUrl(url));
    assert.equal(parseDiscordWebhook(''), null);
    assert.equal(parseDiscordWebhook('https://discord.com/api/webhooks/123456789012345678/abc_123').hostname, 'discord.com');
    for (const url of ['https://evil.com/api/webhooks/123456789012345678/abc', 'http://discord.com/api/webhooks/123456789012345678/abc', 'https://discord.com/api/users/@me']) assert.throws(() => parseDiscordWebhook(url));
});
test('serial claims; duplicate links and callbacks never create duplicate successes', () => {
    const callbacks = [], completed = [];
    const queue = new ClaimQueue((request, ok, fail) => { callbacks.push({ request, ok, fail }); }, (request, success) => completed.push([request.code, success]), () => {});
    queue.start();
    assert.equal(queue.enqueue({ code }), true);
    assert.equal(queue.enqueue({ code }), false);
    queue.enqueue({ code: 'qrstuvwxyzABCDEF' });
    assert.equal(callbacks.length, 1);
    callbacks[0].ok(); callbacks[0].ok(); callbacks[0].fail(new Error('late'));
    assert.equal(callbacks.length, 2);
    callbacks[1].fail(new Error('invalid gift'));
    assert.deepEqual(completed, [[code, true], ['qrstuvwxyzABCDEF', false]]);
    queue.stop();
});
test('sync throws and rejected redemption promises release queue without false success', async () => {
    const results = [];
    const queue = new ClaimQueue(request => { if (request.code === code) throw new Error('sync'); return Promise.reject(new Error('async')); }, (_, ok) => results.push(ok), () => {});
    queue.start(); queue.enqueue({ code }); queue.enqueue({ code: 'qrstuvwxyzABCDEF' });
    await tick(); assert.deepEqual(results, [false, false]); queue.stop();
});
test('stop/restart ignores stale callbacks and preserves deduplication', () => {
    const callbacks = [], completed = [];
    const queue = new ClaimQueue((_, ok) => callbacks.push(ok), (_, success) => completed.push(success), () => {});
    queue.start(); queue.enqueue({ code }); queue.enqueue({ code: 'qrstuvwxyzABCDEF' });
    queue.stop(); callbacks[0](); assert.deepEqual(completed, []);
    queue.start(); assert.equal(queue.enqueue({ code }), false);
    queue.enqueue({ code: '1234567890ABCDEF' }); callbacks[0](); assert.deepEqual(completed, []);
    callbacks[1](); assert.deepEqual(completed, [true]); queue.stop();
});
test('long CAPTCHA stalls queue safely and late confirmation can resume it', async () => {
    const callbacks = [], results = []; let stalled = 0;
    const queue = new ClaimQueue((_, ok) => callbacks.push(ok), (_, ok) => results.push(ok), () => stalled++, 10);
    queue.start(); queue.enqueue({ code }); queue.enqueue({ code: 'qrstuvwxyzABCDEF' });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(stalled, 1); assert.equal(callbacks.length, 1); assert.deepEqual(results, []);
    callbacks[0](); assert.equal(callbacks.length, 2); callbacks[1](); queue.stop();
});
test('queue is bounded under bursts', () => {
    const queue = new ClaimQueue(() => {}, () => {}, () => {});
    queue.start(); for (let i = 0; i < 101; i++) assert.equal(queue.enqueue({ code: String(i) }), true);
    assert.equal(queue.enqueue({ code: 'overflow' }), false); queue.stop();
});
