import { Client, GatewayIntentBits } from 'discord.js';
import { config } from './config.mjs';
import { createInteractionHandler } from './interactionHandler.mjs';
import { NotificationService, createApi } from './service.mjs';
import { createDMSender } from './sendDM.mjs';

const options = config();
const client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { timeout: 10_000, retries: 2 } });
let stopping = false;
const service = new NotificationService({ database: options.database, onLeaseLost: () => { console.error("Database ownership lost; stopping the bot."); void shutdown(1); }, sendDM: createDMSender(client) });
const server = createApi(service, { ready: () => !stopping && !service.stopping && client.isReady() });
const commands = createInteractionHandler({ service, publicUrl: options.publicUrl, isStopping: () => stopping || service.stopping, log: console.error });
const onInteraction = interaction => void commands.handle(interaction).catch(() => console.error('Notification command failed.'));
client.on('interactionCreate', onInteraction);
let worker;
client.once('clientReady', () => {
    if (stopping) return;
    server.listen(options.port, options.host, () => console.log(`Notifications API listening on ${options.host}:${options.port}`));
    worker = setInterval(() => void service.deliverDue().catch(() => console.error('Delivery worker failed; check database availability.')), 1000);
    console.log('NitroSniper notification bot ready.');
});
server.on('error', error => { console.error(`API failed: ${error.code ?? 'unknown'}`); void shutdown(1); });
client.on('error', () => console.error('Discord connection error; reconnecting.'));
async function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    service.stop();
    commands.stop();
    clearInterval(worker);
    client.removeListener('interactionCreate', onInteraction);
    const deadline = setTimeout(() => process.exit(1), 30_000);
    deadline.unref();
    // Existing HTTP bodies/commands must finish before their database is closed.
    await Promise.all([
        new Promise(resolve => server.close(() => resolve())),
        commands.drain()
    ]);
    while (service.busy) await new Promise(resolve => setTimeout(resolve, 50));
    service.close();
    await client.destroy();
    clearTimeout(deadline);
    // Aborted SDK rate-limit waits may retain timers after all owned work has drained.
    process.exit(code);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
await client.login(options.token).catch(async () => { console.error('Bot login failed. Check DISCORD_BOT_TOKEN.'); await shutdown(1); });
