import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, User, MessagePayload, Routes } from 'discord.js';
import { NotificationService, buildMessage } from '../bot/service.mjs';
import { createDMSender } from '../bot/sendDM.mjs';

const userId = '123456789012345678';
const channelId = '234567890123456789';
const DAY = 86_400_000;

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

async function completedWithin(promise, milliseconds) {
    let timer;
    try {
        return await Promise.race([
            promise.then(() => true),
            new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })
        ]);
    } finally { clearTimeout(timer); }
}

function fixture(t, { delayFetch = false, delayCreateDM = false, age = 0, useRealRest = false, rest = {} } = {}) {
    let now = Date.parse('2026-10-04T12:00:00.000Z');
    const event = { eventId: 'a'.repeat(64), kind: 'claimed', discordUserId: userId,
        occurredAt: new Date(now - age).toISOString(), giftType: 'Nitro',
        guildId: '345678901234567890', channelId, messageId: '456789012345678901' };
    const fetchEntered = deferred(), fetchRelease = deferred();
    const createDMEntered = deferred(), createDMRelease = deferred();
    const messages = [];
    const client = new Client({ intents: [], rest });
    const user = new User(client, { id: userId, username: 'recipient', discriminator: '0', avatar: null });

    // The boundary records the final Discord request, including SDK serialization.
    // No Discord network calls are permitted by this fixture.
    if (!useRealRest) client.rest.post = async (route, options) => {
        assert.equal(route, Routes.channelMessages(channelId));
        messages.push({ route, body: structuredClone(options.body), signal: options.signal });
        return { id: '567890123456789012', channel_id: channelId };
    };
    const channel = {
        id: channelId, client,
        async send(options) {
            const payload = options instanceof MessagePayload ? options : MessagePayload.create(this, options);
            const { body, files } = await payload.resolveBody().resolveFiles();
            return client.rest.post(Routes.channelMessages(this.id), { body, files });
        }
    };
    client.users.fetch = async id => {
        assert.equal(id, userId);
        fetchEntered.resolve();
        if (delayFetch) await fetchRelease.promise;
        return user;
    };
    // User.send remains the real discord.js implementation, which awaits createDM.
    user.createDM = async () => {
        createDMEntered.resolve();
        if (delayCreateDM) await createDMRelease.promise;
        return channel;
    };
    const service = new NotificationService({ database: ':memory:', now: () => now, sendDM: createDMSender(client) });
    const key = service.link(userId);
    service.enqueue(event, key);
    let delivery;
    t.after(async () => {
        fetchRelease.resolve();
        createDMRelease.resolve();
        try { await delivery; }
        finally { service.close(); await client.destroy(); }
    });
    return {
        service, client, event, messages, fetchEntered, fetchRelease, createDMEntered, createDMRelease,
        advance: milliseconds => { now += milliseconds; },
        deliver: () => (delivery = service.deliverDue())
    };
}

test('the bot adapter respects a disconnect while recipient fetch is pending', async t => {
    const f = fixture(t, { delayFetch: true });
    const delivery = f.deliver();
    await f.fetchEntered.promise;
    f.service.disconnect(userId);
    f.fetchRelease.resolve();
    await delivery;
    assert.equal(f.messages.length, 0, 'A revoked recipient must not receive a Discord message');
    assert.equal(f.service.status(userId).latest.state, 'cancelled');
});

test('disconnect and relink while discord.js creates a DM never sends the cancelled event', async t => {
    const f = fixture(t, { delayCreateDM: true });
    const delivery = f.deliver();
    await f.createDMEntered.promise;
    f.service.disconnect(userId);
    f.service.link(userId);
    f.createDMRelease.resolve();
    await delivery;
    assert.equal(f.messages.length, 0, 'Relinking must not restore consent for a cancelled event');
    assert.equal(f.service.status(userId).latest.state, 'cancelled');
});

test('an event expiring while discord.js creates a DM never reaches Discord message creation', async t => {
    const f = fixture(t, { delayCreateDM: true, age: DAY - 1_000 });
    const delivery = f.deliver();
    await f.createDMEntered.promise;
    f.advance(1_000);
    f.createDMRelease.resolve();
    await delivery;
    assert.equal(f.messages.length, 0, 'The delivery window must hold at the message dispatch boundary');
    assert.notEqual(f.service.status(userId).latest.state, 'delivered');
});

test('stopping while discord.js creates a DM prevents sending and preserves the queued event', async t => {
    const f = fixture(t, { delayCreateDM: true });
    const delivery = f.deliver();
    await f.createDMEntered.promise;
    f.service.stop();
    f.createDMRelease.resolve();
    await delivery;
    assert.equal(f.messages.length, 0, 'Stopping must prevent a message that has not been dispatched');
    assert.equal(f.service.status(userId).latest.state, 'queued');
});

test('an authorized DM preserves nonce enforcement, disabled mentions, and embeds on the wire', async t => {
    const f = fixture(t);
    await f.deliver();
    assert.equal(f.messages.length, 1);
    const expected = buildMessage(f.event);
    assert.equal(f.messages[0].body.nonce, expected.nonce);
    assert.equal(f.messages[0].body.enforce_nonce, true);
    assert.deepEqual(f.messages[0].body.allowed_mentions, { parse: [] });
    assert.deepEqual(f.messages[0].body.embeds, expected.embeds);
    assert.equal(f.service.status(userId).latest.state, 'delivered');
});

test('disconnect aborts a DM waiting in the real Discord REST bucket before it reaches transport', { timeout: 2_000 }, async t => {
    const networkEntered = deferred(), networkRelease = deferred(), notificationQueued = deferred();
    const requests = [];
    let precedingRequest;
    // Register first: fixture cleanup awaits delivery, which needs this gate open.
    t.after(async () => {
        networkRelease.resolve();
        await precedingRequest;
    });
    const f = fixture(t, { useRealRest: true, rest: { retries: 0, timeout: 5_000,
        makeRequest: async (url, options) => {
            options.signal.throwIfAborted();
            requests.push(JSON.parse(options.body));
            if (requests.length === 1) {
                networkEntered.resolve();
                let onAbort;
                try {
                    await Promise.race([networkRelease.promise, new Promise((resolve, reject) => {
                        onAbort = () => reject(options.signal.reason);
                        options.signal.addEventListener('abort', onAbort, { once: true });
                    })]);
                } finally { options.signal.removeEventListener('abort', onAbort); }
            }
            options.signal.throwIfAborted();
            return new Response(JSON.stringify({ id: '567890123456789012', channel_id: channelId }),
                { status: 200, headers: { 'content-type': 'application/json' } });
        }
    } });
    f.client.rest.setToken('test-token-with-no-network-access');
    precedingRequest = f.client.rest.post(Routes.channelMessages(channelId), { body: { content: 'Earlier message' } });
    await networkEntered.promise;

    // Observe entry after the actual SequentialHandler has called queue.wait.
    // Preserve its real queue and abort implementation.
    assert.equal(f.client.rest.handlers.size, 1);
    const handler = f.client.rest.handlers.values().next().value;
    const queueRequest = handler.queueRequest.bind(handler);
    handler.queueRequest = (...args) => {
        const pending = queueRequest(...args);
        if (args[3].body?.nonce === buildMessage(f.event).nonce) notificationQueued.resolve();
        return pending;
    };
    const delivery = f.deliver();
    await notificationQueued.promise;
    assert.equal(requests.length, 1, 'The notification must be waiting behind the first request');
    f.service.disconnect(userId);
    networkRelease.resolve();
    await Promise.all([precedingRequest, delivery]);
    assert.equal(requests.length, 1, 'A cancelled queued DM must never reach the HTTP transport');
    assert.equal(f.service.status(userId).latest.state, 'cancelled');
});

test('disconnect releases the worker while recipient fetch remains blocked', async t => {
    const f = fixture(t, { delayFetch: true });
    const delivery = f.deliver();
    await f.fetchEntered.promise;
    f.service.disconnect(userId);
    // Leave recipient lookup blocked: cancellation must finish independently.
    assert.equal(await completedWithin(delivery, 100), true, 'Cancellation must not wait for recipient lookup');
    assert.equal(f.service.busy, false);
    assert.equal(f.messages.length, 0);
    assert.equal(f.service.status(userId).latest.state, 'cancelled');
});

test('disconnect releases the worker during a real local REST rate limit before its reset', { timeout: 2_000 }, async t => {
    const rateLimited = deferred();
    const requests = [];
    let notificationRequest;
    // Observe the SDK request finishing after its aborted limiter delay, including
    // when the adapter returns early; no outstanding REST work escapes cleanup.
    t.after(async () => { await notificationRequest?.catch(() => {}); });
    const f = fixture(t, { useRealRest: true, rest: { retries: 0, timeout: 2_000, offset: 0,
        makeRequest: async (url, options) => {
            options.signal.throwIfAborted();
            requests.push(JSON.parse(options.body));
            return new Response(JSON.stringify({ id: '567890123456789012', channel_id: channelId }),
                { status: 200, headers: {
                    'content-type': 'application/json', 'X-RateLimit-Limit': '1',
                    'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-After': '0.5'
                } });
        }
    } });
    f.client.rest.setToken('test-token-with-no-network-access');
    await f.client.rest.post(Routes.channelMessages(channelId), { body: { content: 'Exhaust bucket' } });
    f.client.rest.once('rateLimited', details => rateLimited.resolve(details));
    const post = f.client.rest.post.bind(f.client.rest);
    f.client.rest.post = (route, options) => (notificationRequest = post(route, options));
    const delivery = f.deliver();
    const limit = await rateLimited.promise;
    assert.equal(limit.global, false, 'The notification must be blocked by its local bucket');
    assert.ok(limit.timeToReset > 100, 'The reset must remain beyond the cancellation deadline');
    f.service.disconnect(userId);
    assert.equal(await completedWithin(delivery, 100), true, 'Cancellation must finish before the SDK limiter wakes');
    assert.equal(f.service.busy, false);
    assert.equal(requests.length, 1, 'The notification must never reach HTTP transport');
    assert.equal(f.service.status(userId).latest.state, 'cancelled');
});
