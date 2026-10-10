import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTS } from './helpers.mjs';

const code = 'abcdefghijklmnop';

test('native metadata lookups abort stalled HTTP requests and recover all four slots', async t => {
    const native = await loadTS('native.ts');
    const controllers = [];
    const deadlines = [];
    const requests = [];
    t.mock.method(AbortSignal, 'timeout', milliseconds => {
        const controller = new AbortController();
        controllers.push(controller);
        deadlines.push(milliseconds);
        return controller.signal;
    });
    t.mock.method(globalThis, 'fetch', (url, options) => {
        requests.push([url.toString(), options]);
        return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    });
    assert.equal(typeof native.resolveGiftMetadata, 'function');
    const lookups = Array.from({ length: 4 }, () => native.resolveGiftMetadata(null, code));
    assert.equal(await native.resolveGiftMetadata(null, code), null);
    assert.equal(requests.length, 4);
    assert.deepEqual(deadlines, Array(4).fill(3000));
    assert.equal(requests[0][0], `https://discord.com/api/v10/entitlements/gift-codes/${code}?with_application=false&with_subscription_plan=true`);
    assert.equal(requests[0][1].headers.Authorization, undefined);
    assert.equal(requests[0][1].redirect, 'error');
    for (const controller of controllers) controller.abort();
    assert.deepEqual(await Promise.all(lookups), Array(4).fill(null));
    globalThis.fetch = async () => new Response('{"subscription_plan":{"name":"Nitro"}}');
    assert.equal(await native.resolveGiftMetadata(null, code), 'Nitro');
});

test('native metadata permits only real code shapes and returns a bounded name from valid JSON', async t => {
    const native = await loadTS('native.ts');
    let requests = 0;
    let response = () => new Response('{"subscription_plan":{"name":"Nitro"}}');
    t.mock.method(globalThis, 'fetch', async () => { requests++; return response(); });
    assert.equal(typeof native.resolveGiftMetadata, 'function');
    for (const input of ['short', `${code}/../users/@me`, `${code}?token=secret`, { toString: () => code }, 'a'.repeat(25)]) {
        assert.equal(await native.resolveGiftMetadata(null, input), null);
    }
    assert.equal(requests, 0);
    assert.equal(await native.resolveGiftMetadata(null, code), 'Nitro');
    response = () => new Response('{"subscription_plan":{"name":{}}}');
    assert.equal(await native.resolveGiftMetadata(null, code), null);
    response = () => new Response('null');
    assert.equal(await native.resolveGiftMetadata(null, code), null);
    response = () => new Response('{');
    assert.equal(await native.resolveGiftMetadata(null, code), null);
    response = () => new Response('{"subscription_plan":{"name":"' + 'n'.repeat(300) + '"}}');
    assert.equal((await native.resolveGiftMetadata(null, code)).length, 200);
    response = () => new Response('x'.repeat(65_537));
    assert.equal(await native.resolveGiftMetadata(null, code), null);
    response = () => new Response('{"subscription_plan":{"name":"Nitro"}}', { status: 429 });
    assert.equal(await native.resolveGiftMetadata(null, code), null);
});

test('renderer metadata recovers after native errors and degrades safely without updated desktop support', async () => {
    const { resolveGiftType } = await loadTS('giftCode.ts', {
        '@webpack/common': 'export const Constants={Endpoints:{GIFT_CODE_RESOLVE:c=>c}}; export const RestAPI={get:async()=>({body:{subscription_plan:{name:"old lookup"}}})};'
    });
    globalThis.VencordNative = { pluginHelpers: { NitroSniper: { resolveGiftMetadata: async () => { throw new Error('IPC unavailable'); } } } };
    assert.equal(await resolveGiftType(code), null);
    globalThis.VencordNative.pluginHelpers.NitroSniper.resolveGiftMetadata = async () => 'Nitro';
    assert.equal(await resolveGiftType(code), 'Nitro');
    delete globalThis.VencordNative;
    assert.equal(await resolveGiftType(code), null);
});
