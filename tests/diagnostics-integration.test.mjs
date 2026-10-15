import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTS } from './helpers.mjs';

test('plugin lifecycle through narrow native IPC persists sanitized claim evidence across account changes', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'ns-diagnostics-integration-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    globalThis.nsDiagnostics = { dir, user: '123456789012345678', calls: [], writes: [] };
    const state = globalThis.nsDiagnostics;
    const native = await loadTS('native.ts', {
        electron: 'export const app={getPath:()=>globalThis.nsDiagnostics.dir};',
        './directBot': 'export const directBot={};'
    });
    globalThis.VencordNative = { pluginHelpers: { NitroSniper: { writeClaimDiagnostic: payload => {
        const write = native.writeClaimDiagnostic(undefined, payload); state.writes.push(write); return write;
    } } } };
    t.after(() => { delete globalThis.VencordNative; delete globalThis.nsDiagnostics; });
    const { default: plugin } = await loadTS('index.tsx', {
        '@utils/Logger': 'export class Logger { log(){} error(){} }', '@utils/types': 'export default x=>x;',
        '@webpack': 'export const findByPropsLazy=()=>({redeemGiftCode:o=>new Promise((resolve,reject)=>globalThis.nsDiagnostics.calls.push({...o,resolve,reject}))});',
        '@webpack/common': 'export const UserStore={getCurrentUser:()=>({id:globalThis.nsDiagnostics.user})};export const ChannelStore={getChannel:()=>undefined};export const showToast=()=>{};',
        './settings': 'export const settings={store:{webhookUrl:"",botNotificationsEnabled:false,ignoreOwnGiftLinks:true,botNotificationKey:"secret-service-key",botDirectAccounts:"secret-bot-token"}};',
        './notifications': 'export const captureNotificationConfig=()=>null;export const digest=async()=>"";export async function enqueueNotification(){}export async function startNotifications(){}export function stopNotifications(){}',
        './giftCode': 'export async function resolveGiftType(){return null}', './webhook': 'export async function sendClaimWebhook(){}'
    });
    const code = 'aBcDeFgHiJkLmNoP';
    const send = value => plugin.flux.MESSAGE_CREATE({ message: { content: `[Nitro](https://discord.gift/${value}) private message`,
        timestamp: new Date(Date.now() + 1).toISOString(), channel_id: '234567890123456789', id: '345678901234567890', author: { id: '456789012345678901' } } });
    plugin.start(); t.after(() => plugin.stop()); send(code);
    state.calls[0].onRedeemed(); state.calls[0].resolve(); await Promise.resolve(); await Promise.resolve();
    plugin.flux.LOGOUT(); state.user = '567890123456789012'; plugin.flux.CONNECTION_OPEN(); send('qrstuvwxyzABCDEF');
    const secrets = ['secret-bot-token', 'secret-service-key', 'https://discord.com/api/webhooks/private', 'captcha-secret', 'rqtoken-private'];
    state.calls[1].reject(Object.assign(new Error(secrets.join(' ')), { status: 429, code: 20028, retryAfter: 12.5, rqdata: 'rqdata-private' }));
    await Promise.resolve(); await Promise.resolve(); plugin.stop();
    await Promise.all(state.writes);
    const text = await readFile(join(dir, 'NitroSniper', 'logs', 'claim-diagnostics.jsonl'), 'utf8');
    const rows = text.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(rows.slice(0, 8).map(row => row.event), ['plugin_started', 'session_started', 'gift_detected', 'claim_enqueued', 'claim_dispatched', 'on_redeemed', 'claim_completed_success', 'redeem_promise_resolved']);
    const sessions = rows.filter(row => row.event === 'session_started'); assert.equal(sessions.length, 2); assert.notEqual(sessions[0].session, sessions[1].session);
    assert.ok(rows.some(row => row.event === 'logout')); assert.ok(rows.some(row => row.event === 'connection_open'));
    assert.ok(rows.some(row => row.event === 'account_changed')); assert.equal(rows.at(-1).event, 'plugin_stopped');
    assert.ok(rows.some(row => row.event === 'redeem_promise_rejected' && row.status === 429 && row.apiCode === 20028 && row.retryAfter === 12.5));
    assert.ok(rows.some(row => row.event === 'claim_completed_failure'));
    for (const value of [...secrets, code, 'qrstuvwxyzABCDEF', 'discord.gift', 'private message', 'rqdata-private', '123456789012345678', '567890123456789012']) assert.equal(text.includes(value), false, value);
});
