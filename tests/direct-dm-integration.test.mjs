import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTS } from './helpers.mjs';
const userId = '123456789012345678';

test('token setup → confirmed claim → durable client outbox → native Discord bot DM, without a service', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'nitrosniper-direct-integration-'));
    const token = 'test-bot-token-never-used-on-network';
    const calls = [];
    globalThis.nsDirect = { dir, calls: [], store: new Map(), userId };
    const native = await loadTS('native.ts', { electron: `export const app={getPath:()=>globalThis.nsDirect.dir}; export const safeStorage={isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=>"dpapi",encryptString:text=>Buffer.from([...text].reverse().join('')),decryptString:bytes=>[...bytes.toString()].reverse().join('')};` });
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        calls.push([url.toString(), options]);
        assert.equal(options.headers.Authorization, `Bot ${token}`);
        assert.equal(options.redirect, 'error');
        assert.ok(options.signal instanceof AbortSignal);
        const body = url.endsWith('/users/@me') ? { id: '234567890123456789', bot: true, username: 'TestBot' } : { id: '345678901234567890' };
        return new Response(JSON.stringify(body), { status: 200 });
    });
    const connection = await native.connectDirectBot(null, userId, token);
    globalThis.nsDirect.settings = { ignoreOwnGiftLinks: false, webhookUrl: '', botNotificationsEnabled: true,
        botNotificationMode: 'direct', botDirectAccounts: JSON.stringify({ [userId]: connection }), botServiceUrl: '', botNotificationKey: '' };
    globalThis.VencordNative = { pluginHelpers: { NitroSniper: Object.fromEntries(Object.entries(native).filter(([,fn]) => typeof fn === 'function').map(([key,fn]) => [key, (...args) => fn(null,...args)])) } };
    const { default: plugin } = await loadTS('index.tsx', {
        '@utils/Logger': 'export class Logger{log(){} error(){}}', '@utils/types': 'export default x=>x;',
        '@webpack': 'export function findByPropsLazy(){return {redeemGiftCode:o=>{globalThis.nsDirect.calls.push(o)}}}',
        '@webpack/common': 'export const ChannelStore={getChannel:()=>undefined}; export const UserStore={getCurrentUser:()=>({id:globalThis.nsDirect.userId})}; export const showToast=()=>{}; export const Toasts={Type:{FAILURE:1}};',
        '@api/DataStore': 'export async function get(k){return structuredClone(globalThis.nsDirect.store.get(k))} export async function set(k,v){globalThis.nsDirect.store.set(k,structuredClone(v))}',
        './settings': 'export const settings={store:globalThis.nsDirect.settings};', './giftCode': 'export async function resolveGiftType(){return "Nitro Monthly";}'
    });
    try {
        plugin.start();
        plugin.flux.MESSAGE_CREATE({ message: { content: 'https://discord.gift/abcdefghijklmnop', timestamp: new Date(Date.now()+1).toISOString(), author: { id: '234567890123456789' }, channel_id: '345678901234567890', id: '456789012345678901' } });
        assert.equal(calls.length, 1, 'Setup verifies the bot, but does not claim success or send a message');
        globalThis.nsDirect.calls[0].onRedeemed();
        for (let i=0;i<100 && calls.length<3;i++) await new Promise(resolve => setTimeout(resolve,5));
        assert.equal(calls.length, 3);
        assert.deepEqual(JSON.parse(calls[1][1].body), { recipient_id: userId });
        const message = JSON.parse(calls[2][1].body);
        assert.equal(message.embeds[0].title, 'Nitro successfully claimed');
        assert.equal(message.embeds[0].fields[0].value, 'Nitro Monthly');
        assert.equal(JSON.stringify(message).includes('abcdefghijklmnop'), false);
        assert.equal(JSON.stringify(globalThis.nsDirect.settings).includes(token), false);
        assert.equal((await readFile(join(dir,'NitroSniper','bot-credentials.json'),'utf8')).includes(token), false);
        for (let i=0;i<100 && globalThis.nsDirect.store.get('NitroSniper.notificationOutbox.v1')?.length;i++) await new Promise(resolve => setTimeout(resolve,5));
        assert.deepEqual(globalThis.nsDirect.store.get('NitroSniper.notificationOutbox.v1'), []);
        await native.disconnectDirectBot(null,userId);
        assert.equal(await native.getDirectBotStatus(null,userId), null);
    } finally { plugin.stop(); await rm(dir,{recursive:true,force:true}); delete globalThis.nsDirect; delete globalThis.VencordNative; }
});
