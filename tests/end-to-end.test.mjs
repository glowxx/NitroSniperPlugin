import test from 'node:test';
import assert from 'node:assert/strict';
import { NotificationService, createApi } from '../bot/service.mjs';
import { loadTS } from './helpers.mjs';

test('confirmed claim → native IPC → HTTP → durable bot queue → recipient DM', async () => {
    const userId = '123456789012345678'; const dms = [];
    const service = new NotificationService({ database: ':memory:', sendDM: async (...args) => dms.push(args) });
    const server = createApi(service); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const native = await loadTS('native.ts');
    const key = service.link(userId);
    globalThis.nsE2E = { calls: [], store: new Map(), settings: { ignoreOwnGiftLinks: false, webhookUrl: '', botNotificationsEnabled: true,
        botServiceUrl: `http://127.0.0.1:${server.address().port}`, botNotificationKey: key }, userId };
    globalThis.VencordNative = { pluginHelpers: { NitroSniper: { sendBotNotification: (...args) => native.sendBotNotification(null, ...args) } } };
    const { default: plugin } = await loadTS('index.tsx', {
        '@utils/Logger': 'export class Logger{log(){} error(){}}', '@utils/types': 'export default x=>x;',
        '@webpack': 'export function findByPropsLazy(){return {redeemGiftCode:o=>{globalThis.nsE2E.calls.push(o)}}}',
        '@webpack/common': 'export const ChannelStore={getChannel:()=>undefined}; export const UserStore={getCurrentUser:()=>({id:globalThis.nsE2E.userId})}; export const showToast=()=>{}; export const Toasts={Type:{FAILURE:1}};',
        '@api/DataStore': 'export async function get(k){return structuredClone(globalThis.nsE2E.store.get(k))} export async function set(k,v){globalThis.nsE2E.store.set(k,structuredClone(v))}',
        './settings': 'export const settings={store:globalThis.nsE2E.settings};',
        './giftCode': 'export async function resolveGiftType(){return "Nitro Monthly";}'
    });
    try {
        plugin.start();
        const message = { content: 'https://discord.gift/abcdefghijklmnop', timestamp: new Date(Date.now() + 1).toISOString(),
            author: { id: '234567890123456789' }, channel_id: '345678901234567890', id: '456789012345678901' };
        plugin.flux.MESSAGE_CREATE({ message }); assert.equal(globalThis.nsE2E.calls.length, 1);
        assert.equal(service.status(userId).pending, 0);
        globalThis.nsE2E.calls[0].onRedeemed();
        for (let i = 0; i < 100 && !service.status(userId).pending; i++) await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(service.status(userId).pending, 1);
        await service.deliverDue(); assert.equal(dms.length, 1); assert.equal(dms[0][0], userId);
        assert.equal(dms[0][1].embeds[0].title, 'Nitro successfully claimed');
        assert.equal(JSON.stringify(dms).includes('abcdefghijklmnop'), false);
        plugin.flux.MESSAGE_CREATE({ message }); globalThis.nsE2E.calls[0].onRedeemed();
        await service.deliverDue(); assert.equal(dms.length, 1);
    } finally { plugin.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); service.close(); }
});
