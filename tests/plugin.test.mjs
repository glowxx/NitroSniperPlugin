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
    '@webpack/common': 'export const ChannelStore={getChannel:()=>undefined}; export const UserStore={getCurrentUser:()=>({id:globalThis.nsPlugin.user})}; export const showToast=message=>globalThis.nsPlugin.toasts.push(message); export const Toasts={Type:{FAILURE:1}};',
    './settings': 'export const settings = {store:{webhookUrl:"", botNotificationsEnabled:true,botServiceUrl:"",botNotificationKey:"",ignoreOwnGiftLinks:true}};',
    './giftCode': 'export async function resolveGiftType(){return "Nitro"}',
    './notifications': 'export const captureNotificationConfig=()=>null; export const digest=async()=>"a".repeat(64); export async function enqueueNotification(e){if(globalThis.nsPlugin.savePromise)await globalThis.nsPlugin.savePromise;if(globalThis.nsPlugin.failSave)throw new Error("outbox full");globalThis.nsPlugin.events.push(e)} export async function startNotifications(){} export function stopNotifications(){}',
    './webhook': 'export async function sendClaimWebhook(){}'
});
function message(content, extra = {}) { return { content, timestamp: new Date(Date.now() + 1).toISOString(), author: { id: '234567890123456789', username: 'sender' }, channel_id: '345678901234567890', id: '456789012345678901', ...extra }; }
function reset() { context.calls = []; context.events = []; context.toasts = []; context.failSave = false; context.savePromise = undefined; context.user = user; plugin.start(); }

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

test('a confirmed claim whose notification cannot be saved produces a visible alert', async () => {
    reset(); context.failSave = true;
    try {
        plugin.flux.MESSAGE_CREATE({ message: message('**discord.gift/alertclaimABCDEF**') });
        assert.equal(context.calls.length, 1);
        context.calls[0].onRedeemed(); await settle();
        assert.equal(context.events.length, 0);
        assert.equal(context.toasts.length, 1);
        assert.match(context.toasts[0], /could not save a DM notification/);
    } finally { plugin.stop(); }
});

test('a notification failure from a stopped session cannot show a stale alert', async () => {
    reset(); let rejectSave;
    context.savePromise = new Promise((resolve, reject) => { rejectSave = reject; });
    try {
        plugin.flux.MESSAGE_CREATE({ message: message('discord.gift/stalealertABCDEF') });
        context.calls[0].onRedeemed(); await settle();
        plugin.stop(); rejectSave(new Error('disk write failed')); await settle();
        assert.equal(context.toasts.length, 0);
    } finally { plugin.stop(); }
});

function gatewayMessage(content, extra = {}) {
    const msg = message(content, extra);
    return { message: msg, channelId: msg.channel_id, guildId: msg.guild_id, optimistic: false, isPushNotification: false };
}

for (const offset of [-60_000, 60_000]) {
    test(`a real gateway create event is recognized with local clock offset ${offset}`, t => {
        const serverTime = Date.now();
        t.mock.method(Date, 'now', () => serverTime + offset);
        reset();
        try {
            plugin.flux.MESSAGE_CREATE(gatewayMessage(`discord.gift/${offset < 0 ? 'clockbehindABCDE' : 'clockaheadABCDEF'}`, { timestamp: new Date(serverTime + 100).toISOString() }));
            assert.equal(context.calls.length, 1);
            context.calls[0].onError({ status: 400 });
        } finally { plugin.stop(); }
    });
}

test('the first gateway message after an account change is processed without comparing different clocks', t => {
    const serverTime = Date.now();
    t.mock.method(Date, 'now', () => serverTime + 60_000);
    reset();
    try {
        context.user = '678901234567890123';
        plugin.flux.MESSAGE_CREATE(gatewayMessage('discord.gift/accountclockABCD', { timestamp: new Date(serverTime + 100).toISOString() }));
        assert.equal(context.calls.length, 1);
        context.calls[0].onError({ status: 400 });
    } finally { plugin.stop(); }
});

for (const [index, flags] of [{ optimistic: true }, { isPushNotification: true }, { sendMessageOptions: {} }].entries()) {
    test(`local/push events cannot claim gifts: ${JSON.stringify(flags)}`, () => {
        reset();
        try {
            plugin.flux.MESSAGE_CREATE({ ...gatewayMessage(`discord.gift/localmessageABC${index}`), ...flags });
            if (context.calls.length) context.calls[0].onError({ status: 400 });
            assert.equal(context.calls.length, 0);
        } finally { plugin.stop(); }
    });
}

test('a gateway replay is a newly received create event, still deduplicated, while unrecognized history is ignored', () => {
    reset();
    try {
        const replay = gatewayMessage('discord.gift/replaymessageABC', { timestamp: '2020-01-01T00:00:00Z' });
        plugin.flux.MESSAGE_CREATE({ message: replay.message });
        assert.equal(context.calls.length, 0);
        plugin.flux.MESSAGE_CREATE(replay);
        assert.equal(context.calls.length, 1);
        context.calls[0].onError({ status: 400 });
        plugin.flux.MESSAGE_CREATE(replay);
        assert.equal(context.calls.length, 1);
    } finally { plugin.stop(); }
});

for (const [index, field] of ['guildId', 'channelId', 'optimistic', 'isPushNotification'].entries()) {
    test(`an unrecognized envelope missing ${field} keeps the conservative history filter`, () => {
        reset();
        try {
            const event = gatewayMessage(`discord.gift/unknownformatAB${index}`, { timestamp: '2020-01-01T00:00:00Z' });
            delete event[field];
            plugin.flux.MESSAGE_CREATE(event);
            if (context.calls.length) context.calls[0].onError({ status: 400 });
            assert.equal(context.calls.length, 0);
        } finally { plugin.stop(); }
    });
}

test('recognized gateway envelopes still reject malformed dates and mismatched channels', () => {
    reset();
    try {
        plugin.flux.MESSAGE_CREATE(gatewayMessage('discord.gift/invaliddateABCDE', { timestamp: 'invalid' }));
        plugin.flux.MESSAGE_CREATE({ ...gatewayMessage('discord.gift/wrongchannelABCD'), channelId: '777777777777777777' });
        if (context.calls.length) context.calls[0].onError({ status: 400 });
        assert.equal(context.calls.length, 0);
    } finally { plugin.stop(); }
});
