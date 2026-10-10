import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client, User } from 'discord.js';
import { NotificationService } from '../bot/service.mjs';
import { createInteractionHandler } from '../bot/interactionHandler.mjs';
const user = '123456789012345678';
const clients = new Set();
afterEach(async () => { for (const client of clients) await client.destroy(); clients.clear(); });
function interaction(action, send = async () => {}) {
    const client = new Client({ intents: [] }); clients.add(client);
    const recipient = new User(client, { id: user, username: 'recipient', discriminator: '0', avatar: null });
    client.users.fetch = async () => recipient;
    recipient.createDM = async () => ({ id: '234567890123456789', client });
    client.rest.post = async () => send();
    return { client, user: recipient, commandName: 'notifications', isChatInputCommand: () => true,
        options: { getSubcommand: () => action }, edits: [],
        async deferReply() { this.deferred = true; }, async editReply(message) { this.edits.push(message); }, async reply() {} };
}
const tick = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };
test('disconnect cancels an in-progress link instead of being undone by its late DM', async () => {
    const service = new NotificationService({ database: ':memory:', sendDM: async () => {} }); let release;
    service.link(user); const handler = createInteractionHandler({ service, publicUrl: 'https://notify.example.com' });
    const link = interaction('link', () => new Promise(resolve => { release = resolve; }));
    const pending = handler.handle(link); await tick();
    const disconnect = interaction('disconnect'); await handler.handle(disconnect);
    assert.equal(service.status(user).linked, false);
    release(); await pending; assert.equal(service.status(user).linked, false); assert.match(link.edits.at(-1), /cancelled/); service.close();
});
test('failed private key reply retains the existing valid key', async () => {
    const service = new NotificationService({ database: ':memory:', sendDM: async () => {} }); const oldKey = service.link(user);
    const handler = createInteractionHandler({ service, publicUrl: 'https://notify.example.com' });
    const link = interaction('link'); link.editReply = async () => { throw new Error('interaction expired'); };
    await handler.handle(link); assert.equal(service.authenticate(oldKey, user).user_id, user); service.close();
});
test('a second slow link is refused; key is activated only after private reply succeeds', async () => {
    const service = new NotificationService({ database: ':memory:', sendDM: async () => {} }); let release; let now = Date.now();
    const handler = createInteractionHandler({ service, publicUrl: 'https://notify.example.com', now: () => now });
    const first = interaction('link', () => new Promise(resolve => { release = resolve; }));
    const pending = handler.handle(first); await tick(); now += 20_000;
    const second = interaction('link'); await handler.handle(second); assert.match(second.edits[0], /already in progress/);
    assert.equal(service.status(user).linked, false); release(); await pending;
    const key = first.edits[0].match(/Notification key: `([^`]+)`/)[1]; assert.equal(service.authenticate(key, user).user_id, user); service.close();
});
test('shutdown cancels slow pairing and rejects further command mutations', async () => {
    const service = new NotificationService({ database: ':memory:', sendDM: async () => {} }); let release; let stopping = false;
    const handler = createInteractionHandler({ service, publicUrl: 'https://notify.example.com', isStopping: () => stopping });
    const link = interaction('link', () => new Promise(resolve => { release = resolve; }));
    const pending = handler.handle(link); await tick(); stopping = true; service.stop(); release(); await pending; await handler.drain();
    assert.equal(service.status(user).linked, false);
    const testDM = interaction('test'); await handler.handle(testDM); assert.match(testDM.edits.at(-1), /stopping/); service.close();
});

test('disconnect during a slow interaction acknowledgement cancels linking before a DM is sent', async () => {
    const service = new NotificationService({ database: ':memory:', sendDM: async () => {} }); let acknowledge; let sent = 0;
    const handler = createInteractionHandler({ service, publicUrl: 'https://notify.example.com' });
    const link = interaction('link', async () => { sent++; });
    link.deferReply = () => new Promise(resolve => { acknowledge = () => { link.deferred = true; resolve(); }; });
    const pending = handler.handle(link); await tick(); await handler.handle(interaction('disconnect')); acknowledge(); await pending;
    assert.equal(sent, 0); assert.equal(service.status(user).linked, false); service.close();
});

test('disconnect write failure reports a retryable error without confirming a revoked connection', async () => {
    const service = new NotificationService({ database: ':memory:', sendDM: async () => {} });
    try {
        const key = service.link(user);
        service.enqueueForUser({ eventId: 'disconnect-command-test', kind: 'test', discordUserId: user, occurredAt: new Date().toISOString() });
        service.db.exec("CREATE TRIGGER fail_disconnect BEFORE UPDATE ON events WHEN NEW.state='cancelled' BEGIN SELECT RAISE(ABORT,'simulated write failure'); END");
        const handler = createInteractionHandler({ service, publicUrl: 'https://notify.example.com' });
        const failed = interaction('disconnect');
        await handler.handle(failed);
        assert.match(failed.edits.at(-1), /retry.*disconnect/i);
        assert.doesNotMatch(failed.edits.at(-1), /^Disconnected\./);
        assert.equal(service.authenticate(key, user).user_id, user);
        assert.equal(service.status(user).pending, 1);
        service.db.exec('DROP TRIGGER fail_disconnect');
        const retried = interaction('disconnect');
        await handler.handle(retried);
        assert.match(retried.edits.at(-1), /^Disconnected\./);
        assert.equal(service.status(user).linked, false);
        assert.equal(service.status(user).pending, 0);
    } finally { service.close(); }
});
