import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTS } from './helpers.mjs';

const { createDirectBot } = await loadTS('directBot.ts');
const owner = '123456789012345678', other = '234567890123456789', botId = '345678901234567890';
const channelId = '456789012345678901', messageId = '567890123456789012';

for (const transition of ['plugin disable', 'account switch']) {
    test(`${transition} after test delivery cannot issue native DELETE before its original deadline`, async t => {
        const start = Date.now(); t.mock.timers.enable({ apis: ['Date'], now: start });
        const credentials = new Map(); let jobs = [], deletes = 0;
        const bot = createDirectBot({ get: async id => credentials.get(id) ?? null,
            set: async (id, value) => credentials.set(id, value), remove: async id => credentials.delete(id) },
            async (token, route, body, signal, method) => method === 'DELETE' ? (++deletes, { status: 204, body: {} })
                : route === '/users/@me' ? { status: 200, body: { id: botId, bot: true } }
                    : route === '/users/@me/channels' ? { status: 200, body: { id: channelId } }
                        : { status: 200, body: { id: messageId, channel_id: channelId } },
            { autoSchedule: false, cleanupStore: { load: async () => structuredClone(jobs), save: async next => { jobs = structuredClone(next); } } });
        const connection = await bot.connect(owner, 'test-token-with-no-network-access');
        globalThis.nsLifetime = { owner, store: new Map(), settings: { webhookUrl: '', botNotificationsEnabled: true,
            botNotificationMode: 'direct', botDirectAccounts: JSON.stringify({ [owner]: connection }), botServiceUrl: '', botNotificationKey: '' } };
        globalThis.VencordNative = { pluginHelpers: { NitroSniper: { sendBotNotification() {},
            getDirectBotStatus: id => bot.status(id), sendDirectBotNotification: (...args) => bot.send(...args) } } };
        const { default: plugin, waitForNotificationIdle } = await loadTS('index.tsx', {
            '@utils/Logger': 'export class Logger{log(){} error(){}}', '@utils/types': 'export default x=>x;',
            '@webpack': 'export const findByPropsLazy=()=>({redeemGiftCode(){throw new Error("No live redemption");}});',
            '@webpack/common': 'export const UserStore={getCurrentUser:()=>({id:globalThis.nsLifetime.owner})}; export const ChannelStore={getChannel:()=>undefined}; export const showToast=()=>{};',
            '@api/DataStore': 'export const get=async k=>structuredClone(globalThis.nsLifetime.store.get(k)); export const set=async(k,v)=>globalThis.nsLifetime.store.set(k,structuredClone(v));',
            './settings': 'export const settings={store:globalThis.nsLifetime.settings};', './giftCode': 'export const resolveGiftType=async()=>null;'
        });
        try {
            plugin.start(); await waitForNotificationIdle();
            assert.equal((await bot.send(owner, connection.credentialId, JSON.stringify({ eventId: 'lifetime-integration-test',
                kind: 'test', discordUserId: owner, occurredAt: new Date().toISOString() }))).status, 200);
            const deadline = jobs[0].deleteAt;
            t.mock.timers.tick(10_000);
            if (transition === 'plugin disable') plugin.stop();
            else { globalThis.nsLifetime.owner = other; plugin.flux.CONNECTION_OPEN(); await waitForNotificationIdle(); }
            await bot.runCleanup(); assert.equal(deletes, 0); assert.equal(jobs[0].deleteAt, deadline);
            t.mock.timers.tick(19_999); await bot.runCleanup(); assert.equal(deletes, 0);
            t.mock.timers.tick(1); await bot.runCleanup(); assert.equal(deletes, 1); assert.deepEqual(jobs, []);
        } finally { plugin.stop(); bot.stopCleanup(); delete globalThis.nsLifetime; delete globalThis.VencordNative; }
    });
}
