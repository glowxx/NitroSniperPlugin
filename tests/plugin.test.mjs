import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTS } from './helpers.mjs';
const user = '123456789012345678';
const code = 'abcdefghijklmnop';
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
globalThis.nsPlugin = {};
const context = globalThis.nsPlugin;
const { default: plugin } = await loadTS('index.tsx', {
    '@utils/Logger': 'export class Logger { log(){} error(){} }',
    '@utils/types': 'export default x => x;',
    '@webpack': 'export function findByPropsLazy(){return {redeemGiftCode: o => {globalThis.nsPlugin.calls.push(o); return Promise.resolve();}}}',
    '@webpack/common': 'export const ChannelStore={getChannel:()=>undefined}; export const UserStore={getCurrentUser:()=>({id:globalThis.nsPlugin.user})}; export const showToast=()=>{}; export const Toasts={Type:{FAILURE:1}};',
    './settings': 'export const settings = {store:{webhookUrl:"", botNotificationsEnabled:true,botServiceUrl:"",botNotificationKey:"",ignoreOwnGiftLinks:true}};',
    './giftCode': 'export async function resolveGiftType(){return "Nitro"}',
    './notifications': 'export const digest=async()=>"a".repeat(64); export async function enqueueNotification(e){globalThis.nsPlugin.events.push(e)} export async function startNotifications(){} export function stopNotifications(){}',
    './webhook': 'export async function sendClaimWebhook(){}'
});
function message(content, extra = {}) { return { content, timestamp: new Date(Date.now() + 1).toISOString(), author: { id: '234567890123456789', username: 'sender' }, channel_id: '345678901234567890', id: '456789012345678901', ...extra }; }
function reset() { context.calls = []; context.events = []; context.user = user; plugin.start(); }

test('integration sends a success event only after onRedeemed, never on promise resolution or failed attempts', async () => {
    reset(); plugin.flux.MESSAGE_CREATE({ message: message(`discord.gift/${code}`) }); await settle();
    assert.equal(context.calls.length, 1); assert.equal(context.events.length, 0);
    context.calls[0].onRedeemed(); context.calls[0].onRedeemed(); await settle();
    assert.equal(context.events.length, 1); assert.equal(context.events[0].kind, 'claimed');
    assert.equal(context.events[0].discordUserId, user); assert.equal(context.events[0].code, undefined);
    plugin.flux.MESSAGE_CREATE({ message: message('discord.gift/qrstuvwxyzABCDEF') });
    context.calls[1].onError(new Error('invalid')); await settle(); assert.equal(context.events.length, 1); plugin.stop();
});
test('ignores own/history messages and stopping suppresses late callbacks', async () => {
    reset();
    plugin.flux.MESSAGE_CREATE({ message: message('discord.gift/1234567890ABCDEF', { author: { id: user } }) });
    plugin.flux.MESSAGE_CREATE({ message: message('discord.gift/1234567890ABCDEF', { timestamp: '2020-01-01T00:00:00Z' }) });
    assert.equal(context.calls.length, 0);
    plugin.flux.MESSAGE_CREATE({ message: message('discord.gift/1234567890ABCDEF') }); plugin.stop();
    context.calls[0].onRedeemed(); await settle(); assert.equal(context.events.length, 0);
});
test('changing accounts while a claim is pending cannot notify the newly logged-in account', async () => {
    reset(); plugin.flux.MESSAGE_CREATE({ message: message('discord.gift/ABCDEF1234567890') });
    context.user = '567890123456789012'; context.calls[0].onRedeemed(); await settle();
    assert.equal(context.events.length, 0); plugin.stop();
});
