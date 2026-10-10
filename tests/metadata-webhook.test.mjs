import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTS } from './helpers.mjs';
globalThis.nsMetadata = { requests: [] };
const { resolveGiftType } = await loadTS('giftCode.ts');
const webhook = await loadTS('webhook.ts');
test('hanging metadata lookups are bounded without blocking subsequent claim handling', async () => {
    const releases = [];
    globalThis.VencordNative = { pluginHelpers: { NitroSniper: { resolveGiftMetadata: () => new Promise(resolve => releases.push(resolve)) } } };
    const lookups = Array.from({ length: 4 }, (_, i) => resolveGiftType('code' + i));
    assert.equal(await resolveGiftType('overflow'), null); assert.equal(releases.length, 4);
    for (const release of releases) release('Nitro');
    assert.deepEqual(await Promise.all(lookups), Array(4).fill('Nitro'));
    globalThis.VencordNative.pluginHelpers.NitroSniper.resolveGiftMetadata = async () => 'Nitro';
    assert.equal(await resolveGiftType('new'), 'Nitro');
});
test('metadata errors or unexpected name types never escape as a notification failure', async () => {
    globalThis.VencordNative.pluginHelpers.NitroSniper.resolveGiftMetadata = async () => ({ corrupt: true });
    assert.equal(await resolveGiftType('code'), null);
    globalThis.VencordNative.pluginHelpers.NitroSniper.resolveGiftMetadata = async () => { throw new Error('offline'); };
    assert.equal(await resolveGiftType('code'), null);
});
test('webhooks escape names and gift type markdown, suppress mentions and omit gift codes', async () => {
    const payloads = [];
    globalThis.VencordNative = { pluginHelpers: { NitroSniper: { sendWebhook: async (url, body) => { payloads.push(JSON.parse(body)); return { status: 200, data: '{}' }; } } } };
    await webhook.sendClaimWebhook('https://discord.com/api/webhooks/123456789012345678/abc', 'claimed', {
        code: 'private-gift-code', authorId: '123456789012345678', authorName: 'name](https://evil.example)',
        channelId: '234567890123456789', messageId: '345678901234567890'
    }, 'Nitro **fake**');
    const payload = payloads[0]; assert.deepEqual(payload.allowed_mentions.parse, []);
    assert.equal(JSON.stringify(payload).includes('private-gift-code'), false);
    assert.match(payload.embeds[0].fields[1].value, /name\\\]/);
    assert.match(payload.embeds[0].fields[0].value, /\\\*\\\*/);
});
