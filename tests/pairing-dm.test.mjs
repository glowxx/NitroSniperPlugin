import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, ClientUser, User, Routes } from 'discord.js';
import { NotificationService } from '../bot/service.mjs';
import { createInteractionHandler } from '../bot/interactionHandler.mjs';

const userId = '123456789012345678';
const channelId = '234567890123456789';
const botId = '345678901234567890';

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function fixture(t, { delayCreateDM = false } = {}) {
    const createDMEntered = deferred(), createDMRelease = deferred();
    const messages = [];
    const userData = { id: userId, username: 'recipient', discriminator: '0', avatar: null };
    const botData = { id: botId, username: 'notifications', discriminator: '0', avatar: null, bot: true };
    // Keep recipient lookup, DM creation, MessagePayload serialization and the REST
    // queue real. Only the final HTTP transport is replaced; no network is used.
    const client = new Client({ intents: [], rest: { retries: 0, makeRequest: async (url, options) => {
        options.signal.throwIfAborted();
        const route = new URL(url).pathname.replace(/^\/api\/v\d+/, '');
        let data;
        if (route === Routes.userChannels()) {
            assert.equal(options.method, 'POST');
            assert.equal(JSON.parse(options.body).recipient_id, userId);
            createDMEntered.resolve();
            if (delayCreateDM) await createDMRelease.promise;
            options.signal.throwIfAborted();
            data = { id: channelId, type: 1, recipients: [userData], last_message_id: null };
        } else if (route === Routes.channelMessages(channelId)) {
            assert.equal(options.method, 'POST');
            const body = JSON.parse(options.body);
            messages.push(body);
            data = { id: '456789012345678901', channel_id: channelId, author: botData,
                content: body.content, timestamp: new Date().toISOString(), type: 0,
                mentions: [], mention_roles: [], attachments: [], embeds: [] };
        } else {
            throw new Error(`Unexpected Discord request: ${options.method} ${route}`);
        }
        return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    } } });
    client.rest.setToken('test-token-with-no-network-access');
    client.user = new ClientUser(client, botData);
    const user = new User(client, userData);
    client.users.cache.set(userId, user);
    const service = new NotificationService({ database: ':memory:', sendDM: async () => {} });
    let stopping = false;
    const handler = createInteractionHandler({ service, publicUrl: 'https://notify.example.com', isStopping: () => stopping });
    const pending = [];
    t.after(async () => {
        createDMRelease.resolve();
        await Promise.allSettled(pending);
        service.close();
        await client.destroy();
    });
    function interaction(action) {
        return { client, user, commandName: 'notifications', isChatInputCommand: () => true,
            options: { getSubcommand: () => action }, edits: [],
            async deferReply() { this.deferred = true; },
            async editReply(message) { this.edits.push(message); }, async reply() {} };
    }
    return {
        service, handler, messages, createDMEntered, createDMRelease, interaction,
        handle(command) { const task = handler.handle(command); pending.push(task); return task; },
        stop() {
            stopping = true;
            handler.stop();
            service.stop();
        }
    };
}

test('disconnect while the real SDK creates a pairing DM prevents the message request', { timeout: 2_000 }, async t => {
    const f = fixture(t, { delayCreateDM: true });
    const previousKey = f.service.link(userId);
    const link = f.interaction('link');
    const pending = f.handle(link);
    await f.createDMEntered.promise;
    await f.handle(f.interaction('disconnect'));
    assert.equal(f.messages.length, 0, 'No pairing message has reached transport yet');
    f.createDMRelease.resolve();
    await pending;
    assert.equal(f.messages.length, 0, 'A disconnected account must not receive a pending pairing DM');
    assert.equal(f.service.status(userId).linked, false);
    assert.throws(() => f.service.authenticate(previousKey, userId), { status: 401 });
    assert.match(link.edits.at(-1), /cancelled/i);
});

test('shutdown while the real SDK creates a pairing DM prevents the message request and key activation', { timeout: 2_000 }, async t => {
    const f = fixture(t, { delayCreateDM: true });
    const link = f.interaction('link');
    const pending = f.handle(link);
    await f.createDMEntered.promise;
    f.stop();
    assert.equal(f.messages.length, 0, 'No pairing message has reached transport yet');
    f.createDMRelease.resolve();
    await pending;
    await f.handler.drain();
    assert.equal(f.messages.length, 0, 'Shutdown must cancel a pairing DM before message dispatch');
    assert.equal(f.service.status(userId).linked, false);
});

test('authorized pairing sends the SDK-serialized DM and activates the privately returned key', { timeout: 2_000 }, async t => {
    const f = fixture(t);
    const link = f.interaction('link');
    await f.handle(link);
    assert.equal(link.deferred, true);
    assert.equal(f.messages.length, 1);
    assert.match(f.messages[0].content, /DM delivery is working/);
    assert.deepEqual(f.messages[0].allowed_mentions, { parse: [] });
    const key = link.edits.at(-1).match(/Notification key: `([^`]+)`/)?.[1];
    assert.ok(key, 'Authorized pairing must privately return a connection key');
    assert.equal(f.service.authenticate(key, userId).user_id, userId);
});

for (const action of ['disconnect', 'stop']) {
    test(`${action} finishes pairing without waiting for the SDK to create its channel`, { timeout: 2_000 }, async t => {
        const f = fixture(t, { delayCreateDM: true });
        const link = f.interaction('link');
        const pending = f.handle(link);
        await f.createDMEntered.promise;
        if (action === 'disconnect') await f.handle(f.interaction('disconnect'));
        else f.stop();
        let timer;
        try {
            const finished = await Promise.race([pending.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 100); })]);
            assert.equal(finished, true, 'Revocation must not await an unrelated SDK preparation request');
            assert.equal(f.messages.length, 0);
            assert.equal(f.service.status(userId).linked, false);
        } finally { clearTimeout(timer); }
    });
}
