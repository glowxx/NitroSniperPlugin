import { Client, GatewayIntentBits, MessageFlags } from 'discord.js';
import { randomUUID } from 'node:crypto';
import { config } from './config.mjs';
import { NotificationService, createApi } from './service.mjs';

const options = config();
const client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { timeout: 10_000, retries: 2 } });
const service = new NotificationService({ database: options.database, sendDM: async (userId, payload) => {
    const user = await client.users.fetch(userId);
    await user.send(payload);
} });
const server = createApi(service, { ready: () => client.isReady() });
let worker;
let stopping = false;
client.once('clientReady', () => {
    server.listen(options.port, options.host, () => console.log(`Notifications API listening on ${options.host}:${options.port}`));
    worker = setInterval(() => void service.deliverDue().catch(() => console.error('Delivery worker failed; check database availability.')), 1000);
    console.log('NitroSniper notification bot ready.');
});
server.on('error', error => { console.error(`API failed: ${error.code ?? 'unknown'}`); void shutdown(1); });
client.on('error', () => console.error('Discord connection error; reconnecting.'));
const commandCooldown = new Map();
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'notifications') return;
    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const userId = interaction.user.id;
        const action = interaction.options.getSubcommand();
        if (['link', 'test'].includes(action)) {
            const now = Date.now();
            for (const [id, time] of commandCooldown) if (now - time >= 10_000) commandCooldown.delete(id);
            if (commandCooldown.has(userId)) return void await interaction.editReply('Please wait 10 seconds before linking or testing again.');
            commandCooldown.set(userId, now);
        }
        if (action === 'link') {
            // Verify DMs before revoking an existing working key.
            await interaction.user.send({ content: 'NitroSniper DM notifications are ready. Return to the command response to copy your connection key.', allowedMentions: { parse: [] } });
            const token = service.link(userId);
            await interaction.editReply(`**Connect your plugin**\n1. Open NitroSniper settings → Bot DM notifications.\n2. Service URL: \`${options.publicUrl}\`\n3. Notification key: \`${token}\`\n4. Enable notifications and click **Send Test DM**.\n\nThis key is only for your account. Keep it private. Running this command again replaces the previous key.`);
        } else if (action === 'disconnect') {
            service.disconnect(userId);
            await interaction.editReply('Disconnected. Your key is revoked and pending notifications are cancelled.');
        } else if (action === 'status') {
            const status = service.status(userId);
            await interaction.editReply(`Connection: **${status.linked ? 'Linked' : 'Not linked'}**\nQueued: **${status.pending}**\nLatest delivery: **${status.latest?.state ?? 'None'}**${status.latest?.error ? `\n${status.latest.error}` : ''}`);
        } else if (action === 'test') {
            if (!service.status(userId).linked) return void await interaction.editReply('Run /notifications link first.');
            service.enqueueForUser({ eventId: randomUUID(), kind: 'test', discordUserId: userId, occurredAt: new Date().toISOString() });
            await interaction.editReply('Test DM queued. Use /notifications status to check delivery.');
        }
    } catch (error) {
        const message = [50007, 50278].includes(Number(error.code))
            ? 'Discord blocked this DM. Enable DMs from server members, unblock the bot, and try again. You may need a shared server with the bot.'
            : 'Could not complete the command. Please retry shortly.';
        try { if (interaction.deferred || interaction.replied) await interaction.editReply(message); else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }); } catch { /* Expired interaction. */ }
        console.error(`Notification command failed (${error.code ?? 'internal'}).`);
    }
});
async function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    clearInterval(worker);
    server.close();
    // Stop taking requests before draining an active delivery. Keep Discord alive during the drain.
    const deadline = setTimeout(() => process.exit(1), 30_000);
    deadline.unref();
    while (service.busy) await new Promise(resolve => setTimeout(resolve, 50));
    service.close();
    client.destroy();
    process.exitCode = code;
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
await client.login(options.token).catch(async () => { console.error('Bot login failed. Check DISCORD_BOT_TOKEN.'); await shutdown(1); });
