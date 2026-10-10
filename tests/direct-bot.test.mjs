import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTS } from './helpers.mjs';
const { createDirectBot } = await loadTS('directBot.ts');
const user = '123456789012345678', other = '234567890123456789';
const token = 'private-bot-token-for-tests-only';
const event = () => ({ eventId: 'event-1234567890123456', kind: 'claimed', discordUserId: user, occurredAt: new Date().toISOString(), giftType: 'Nitro @everyone', channelId: other, messageId: '345678901234567890' });
function fixture(request) {
    const saved = new Map(), calls = [];
    let failSave = false;
    const vault = { get: async id => saved.get(id) ?? null, set: async (id, value) => { if (failSave) throw new Error('disk failed'); saved.set(id, value); }, remove: async id => saved.delete(id) };
    const send = async (...args) => {
        calls.push(args);
        if (request) return request(...args);
        if (args[1] === '/users/@me') return { status: 200, body: { id: '456789012345678901', bot: true, username: 'MyBot' } };
        return { status: 200, body: { id: '567890123456789012' } };
    };
    return { bot: createDirectBot(vault, send), saved, calls, failSave: () => { failSave = true; } };
}
test('setup validates the bot and only returns public metadata; no token readback', async () => {
    const f = fixture(); const info = await f.bot.connect(user, ` Bot ${token} `);
    assert.equal(f.calls[0][0], token); assert.equal(info.botName, 'MyBot');
    assert.equal(f.saved.get(user).token, token);
    assert.deepEqual(await f.bot.status(user), info);
    assert.equal(JSON.stringify(info).includes(token), false);
    assert.equal(await f.bot.status(other), null);
});
test('user tokens and invalid tokens cannot replace a working bot', async () => {
    const f = fixture(); const old = await f.bot.connect(user, token);
    f.failSave(); await assert.rejects(f.bot.connect(user, token));
    assert.deepEqual(await f.bot.status(user), old);
    for (const reply of [{ status: 401, body: {} }, { status: 200, body: { id: user, bot: false } }]) {
        const bad = fixture(async () => reply);
        await assert.rejects(bad.bot.connect(user, token), /bot token/);
        assert.equal(await bad.bot.status(user), null);
    }
});
test('direct sender scopes account/credential, serializes safe DM payload and stable nonce', async () => {
    const f = fixture(); const info = await f.bot.connect(user, token); f.calls.length = 0;
    assert.equal((await f.bot.send(other, info.credentialId, JSON.stringify(event()))).status, 400);
    assert.equal((await f.bot.send(user, 'old-credential', JSON.stringify(event()))).status, 401);
    assert.equal(f.calls.length, 0);
    const value = await f.bot.send(user, info.credentialId, JSON.stringify(event()));
    assert.equal(JSON.parse(value.data).state, 'delivered');
    assert.deepEqual(f.calls[0][2], { recipient_id: user });
    assert.deepEqual(f.calls[1][2].allowed_mentions, { parse: [] });
    assert.equal(f.calls[1][2].enforce_nonce, true);
    assert.ok(f.calls[1][2].nonce.length <= 25);
    assert.equal(JSON.stringify(f.calls[1][2]).includes(token), false);
    const nonce = f.calls[1][2].nonce;
    await f.bot.send(user, info.credentialId, JSON.stringify(event()));
    assert.equal(f.calls[3][2].nonce, nonce);
});
test('disconnect during channel creation aborts the request and prevents message dispatch', async () => {
    let release, signal;
    const f = fixture(async (value, path, body, controllerSignal) => {
        if (path === '/users/@me') return { status: 200, body: { bot: true, id: other, username: 'Bot' } };
        signal = controllerSignal;
        return new Promise(resolve => { release = () => resolve({ status: 200, body: { id: other } }); });
    });
    const info = await f.bot.connect(user, token);
    const pending = f.bot.send(user, info.credentialId, JSON.stringify(event()));
    while (!release) await new Promise(setImmediate);
    await f.bot.disconnect(user); assert.equal(signal.aborted, true); release();
    assert.equal((await pending).status, 409);
    assert.equal(f.calls.length, 2); assert.equal(await f.bot.status(user), null);
});
test('rate limits defer all DM requests for the bot and never expose Discord raw errors', async () => {
    const f = fixture(async (value, path) => path === '/users/@me'
        ? { status: 200, body: { bot: true, id: other, username: 'Bot' } }
        : { status: 429, body: { retry_after: 30, message: token } });
    const info = await f.bot.connect(user, token);
    const first = await f.bot.send(user, info.credentialId, JSON.stringify(event()));
    const calls = f.calls.length;
    const second = await f.bot.send(user, info.credentialId, JSON.stringify({ ...event(), eventId: 'other-event-1234567890' }));
    assert.equal(first.status, 429); assert.equal(second.status, 429); assert.equal(f.calls.length, calls);
    assert.ok(JSON.parse(second.data).retryAfter > 25); assert.equal(first.data.includes(token), false);
});
test('connection replacement invalidates old credentials and cannot move old events', async () => {
    const f = fixture(); const first = await f.bot.connect(user, token); const second = await f.bot.connect(user, token);
    assert.notEqual(first.credentialId, second.credentialId);
    assert.equal((await f.bot.send(user, first.credentialId, JSON.stringify(event()))).status, 401);
    assert.equal((await f.bot.send(user, second.credentialId, JSON.stringify(event()))).status, 200);
});
test('expired events, invalid source IDs and arbitrary payloads never reach Discord', async () => {
    const f = fixture(); const info = await f.bot.connect(user, token); f.calls.length = 0;
    for (const payload of ['bad-json', JSON.stringify({ ...event(), occurredAt: new Date(Date.now()-86_400_001).toISOString() }), JSON.stringify({ ...event(), channelId: 'wrong' }), JSON.stringify({ ...event(), kind: 'failed' })]) {
        assert.equal((await f.bot.send(user, info.credentialId, payload)).status, 400);
    }
    assert.equal(f.calls.length, 0);
});
test('operating-system vault stores encrypted data, survives reload and rejects plaintext fallback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nitrosniper-secret-'));
    globalThis.nsVault = { dir, encryptionAvailable: true, backend: 'dpapi' };
    const mod = await loadTS('directBot.ts', { electron: `export const app={getPath:()=>globalThis.nsVault.dir}; export const safeStorage={isEncryptionAvailable:()=>globalThis.nsVault.encryptionAvailable,getSelectedStorageBackend:()=>globalThis.nsVault.backend,encryptString:text=>Buffer.from([...text].reverse().join('')),decryptString:bytes=>[...bytes.toString()].reverse().join('')};` });
    try {
        const f = fixture(); await f.bot.connect(user, token); const value = f.saved.get(user);
        const first = mod.encryptedVault(); await first.set(user, value);
        const contents = await readFile(join(dir, 'NitroSniper', 'bot-credentials.json'), 'utf8');
        assert.equal(contents.includes(token), false);
        assert.deepEqual(await mod.encryptedVault().get(user), value);
        await first.remove(user); assert.equal(await mod.encryptedVault().get(user), null);
        globalThis.nsVault.backend = 'basic_text'; await assert.rejects(first.set(user, value), /Secure token storage/);
        globalThis.nsVault.backend = 'dpapi'; globalThis.nsVault.encryptionAvailable = false;
        await assert.rejects(first.get(user), /Secure token storage/);
    } finally { await rm(dir, { recursive: true, force: true }); delete globalThis.nsVault; }
});

test('native bot HTTP transport bounds replies and never returns credential-bearing network errors', async t => {
    const saved = new Map();
    const bot = createDirectBot({get:async id=>saved.get(id)??null,set:async(id,value)=>saved.set(id,value),remove:async id=>saved.delete(id)});
    t.mock.method(globalThis,'fetch',async(url,options)=>{
        assert.equal(new URL(url).origin,'https://discord.com');
        assert.equal(options.redirect,'error');assert.ok(options.headers['User-Agent'].startsWith('DiscordBot'));
        return new Response(JSON.stringify({bot:true,id:other,username:'Bot'}));
    });
    const info = await bot.connect(user,token);
    globalThis.fetch=async()=>new Response('a'.repeat(65537));
    assert.equal((await bot.send(user,info.credentialId,JSON.stringify(event()))).status,-1);
    globalThis.fetch=async()=>{throw new Error(`network error with token ${token}`);};
    const result=await bot.send(user,info.credentialId,JSON.stringify(event()));
    assert.equal(result.status,-1);assert.equal(result.data.includes(token),false);
});
