import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTS } from './helpers.mjs';
const A = '123456789012345678', B = '234567890123456789';
const { accountNotificationSettings, updateAccountNotificationSettings } = await loadTS('accountSettings.ts');
let sequence = 0;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture() {
    const ns = globalThis.nsAccountIntegration = { user: A, calls: [], sent: [], hooks: [], toasts: [], writes: [], store: new Map(), settings: {
        ignoreOwnGiftLinks: false, webhookUrl: 'https://discord.com/api/webhooks/123456789012345678/webhookA',
        botNotificationsEnabled: true, botServiceUrl: 'http://localhost:8787', botNotificationKey: 'A'.repeat(43)
    } };
    globalThis.VencordNative = { pluginHelpers: { NitroSniper: { sendBotNotification: async (...args) => {
        ns.sent.push(args); return { status: 202, data: '{"accepted":true}' };
    } } } };
    const module = await loadTS('index.tsx', {
        '@utils/Logger': 'export class Logger {log(){} error(){}}', '@utils/types': 'export default x=>x;',
        '@webpack': `/* fixture ${sequence++} */ export const findByPropsLazy=()=>({redeemGiftCode:o=>new Promise(resolve=>globalThis.nsAccountIntegration.calls.push({...o,resolve}))});`,
        '@webpack/common': 'export const UserStore={getCurrentUser:()=>globalThis.nsAccountIntegration.user?{id:globalThis.nsAccountIntegration.user}:null}; export const ChannelStore={getChannel:()=>undefined}; export const showToast=(text,type)=>{if(type!=="failure")throw new Error("unsupported toast");globalThis.nsAccountIntegration.toasts.push(text)};',
        './settings': 'export const settings={get store(){return globalThis.nsAccountIntegration.settings}};',
        '@api/DataStore': 'export async function get(k){return structuredClone(globalThis.nsAccountIntegration.store.get(k))} export async function set(k,v){globalThis.nsAccountIntegration.store.set(k,structuredClone(v));globalThis.nsAccountIntegration.writes.push(structuredClone(v))}',
        './giftCode': 'export async function resolveGiftType(){return "Nitro"}',
        './webhook': 'export async function sendClaimWebhook(...args){globalThis.nsAccountIntegration.hooks.push(args)}'
    });
    const plugin = module.default;
    plugin.start(); await module.waitForNotificationIdle();
    const claim = (code = `gift${String(sequence++).padStart(12, '0')}`) => {
        plugin.flux.MESSAGE_CREATE({ message: { content: `discord.gift/${code}`, timestamp: new Date(Date.now() + 1).toISOString(),
            author: { id: B }, channel_id: '345678901234567890', id: '456789012345678901' } });
        const call = ns.calls.at(-1); call.onRedeemed(); call.onRedeemed(); call.resolve();
        return code;
    };
    const settled = async () => { await module.waitForConfirmedNotifications(); await module.waitForNotificationIdle(); };
    const switchTo = async user => { ns.user = user; plugin.flux.CONNECTION_OPEN(); await module.waitForNotificationIdle(); };
    return { ns, plugin, module, claim, settled, switchTo };
}

test('A/B claims use only their own webhook and service key across repeated switches', async () => {
    const f = await fixture();
    try {
        f.claim(); await f.settled();
        assert.equal(f.ns.sent.length, 1); assert.equal(f.ns.sent[0][1], 'A'.repeat(43));
        await f.switchTo(B); f.claim(); await f.settled();
        assert.equal(f.ns.sent.length, 1); assert.equal(f.ns.hooks.length, 1);
        assert.equal(accountNotificationSettings(f.ns.settings, B).botNotificationKey, '');
        updateAccountNotificationSettings(f.ns.settings, B, { webhookUrl: 'webhook-B', botNotificationsEnabled: true,
            botNotificationMode: 'service', botServiceUrl: 'http://localhost:8788', botNotificationKey: 'B'.repeat(43) });
        for (const user of [B, A, B, A]) {
            await f.switchTo(user); f.claim(); await f.settled();
            assert.equal(f.ns.sent.at(-1)[1], user === A ? 'A'.repeat(43) : 'B'.repeat(43));
            assert.equal(JSON.parse(f.ns.sent.at(-1)[3]).discordUserId, user);
            assert.equal(f.ns.hooks.at(-1)[0], user === A ? 'https://discord.com/api/webhooks/123456789012345678/webhookA' : 'webhook-B');
        }
        assert.equal(f.ns.sent.length, 5);
    } finally { f.plugin.stop(); }
});

for (const action of ['stop', 'logout', 'switch']) test(`success before immediate ${action} persists A once despite a delayed event digest`, async t => {
    const f = await fixture();
    const entered = deferred(), release = deferred();
    const original = crypto.subtle.digest.bind(crypto.subtle);
    t.mock.method(crypto.subtle, 'digest', async (algorithm, data) => {
        const text = new TextDecoder().decode(data);
        if (text.startsWith(`${A}:gift`)) { entered.resolve(); await release.promise; }
        return original(algorithm, data);
    });
    try {
        f.claim(); await entered.promise;
        if (action === 'stop') f.plugin.stop();
        if (action === 'logout') { f.ns.user = ''; f.plugin.flux.LOGOUT(); }
        if (action === 'switch') await f.switchTo(B);
        release.resolve(); await f.settled();
        const durable = f.ns.store.get('NitroSniper.notificationOutbox.v1');
        assert.equal(durable.length, 1); assert.equal(durable[0].event.discordUserId, A);
        assert.equal(durable[0].scope, Array.from(new Uint8Array(await original('SHA-256', new TextEncoder().encode(`http://localhost:8787:${'A'.repeat(43)}:${A}`))), byte => byte.toString(16).padStart(2, '0')).join(''));
        assert.deepEqual(f.ns.toasts, []); assert.deepEqual(f.ns.sent, []);
        f.plugin.stop(); f.ns.user = A; f.plugin.start(); await f.module.waitForNotificationIdle();
        // Optional metadata deadline is preserved; force due by restoring the durable record at restart.
        f.plugin.stop(); durable[0].nextAt = 0; f.ns.store.set('NitroSniper.notificationOutbox.v1', durable);
        f.plugin.start(); await f.module.waitForNotificationIdle();
        assert.equal(f.ns.sent.length, 1); assert.equal(JSON.parse(f.ns.sent[0][3]).discordUserId, A);
    } finally { release.resolve(); f.plugin.stop(); }
});
