import { randomUUID } from 'node:crypto';
import { MessageFlags } from 'discord.js';
import { ServiceError } from './service.mjs';

/** Revoke promptly; a slow link request must never undo a subsequent disconnect. */
export function createInteractionHandler({ service, publicUrl, isStopping = () => false, now = Date.now, log = () => {} }) {
    const accounts = new Map();
    const tasks = new Set();
    async function handle(interaction) {
        if (!interaction.isChatInputCommand() || interaction.commandName !== 'notifications') return;
        const userId = interaction.user.id;
        const action = interaction.options.getSubcommand();
        for (const [id, entry] of accounts) if (!entry.linking && now() - entry.touched > 300_000) accounts.delete(id);
        const account = accounts.get(userId) ?? { revision: 0, linking: false, nextAt: 0, touched: now() };
        accounts.set(userId, account);
        account.touched = now();
        const requestedRevision = account.revision;
        if (action === 'disconnect') account.revision++;
        try {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            if (isStopping()) throw new ServiceError(503, 'Notification bot is stopping. Please retry after it restarts.');
            if (action === 'link') {
                if (account.revision !== requestedRevision) throw new ServiceError(409, 'Link request cancelled by a newer account action.');
                if (account.linking) return void await interaction.editReply('A link request is already in progress. Use /notifications disconnect to cancel it.');
                if (now() < account.nextAt) return void await interaction.editReply('Please wait 10 seconds before linking or testing again.');
                account.nextAt = now() + 10_000;
                account.linking = true;
                const revision = ++account.revision;
                const stillCurrent = () => !isStopping() && account.revision === revision;
                try {
                    await interaction.user.send({ content: 'NitroSniper DM delivery is working. Return to the command response for your connection key.', allowedMentions: { parse: [] } });
                    if (!stillCurrent()) throw new ServiceError(409, 'Link request cancelled. Run /notifications link again when ready.');
                    const token = service.prepareLink(userId);
                    // Do not revoke a working key if Discord cannot deliver the private replacement.
                    await interaction.editReply(`**Connect your plugin**\n1. Open NitroSniper settings → Bot DM notifications.\n2. Service URL: \`${publicUrl}\`\n3. Notification key: \`${token}\`\n4. Enable notifications and click **Send Test DM**.\n\nThis key is only for your account. Keep it private. Running this command again replaces the previous key.`);
                    if (!stillCurrent()) throw new ServiceError(409, 'Link request cancelled. The displayed key was not activated.');
                    service.activateLink(userId, token);
                } finally { account.linking = false; }
            } else if (action === 'disconnect') {
                service.disconnect(userId);
                await interaction.editReply('Disconnected. Your key is revoked and queued notifications are cancelled. A DM already sent to Discord cannot be recalled.');
            } else if (action === 'status') {
                const status = service.status(userId);
                await interaction.editReply(`Connection: **${status.linked ? 'Linked' : 'Not linked'}**\nQueued: **${status.pending}**\nLatest delivery: **${status.latest?.state ?? 'None'}**${status.latest?.error ? `\n${status.latest.error}` : ''}`);
            } else if (action === 'test') {
                if (now() < account.nextAt) return void await interaction.editReply('Please wait 10 seconds before linking or testing again.');
                account.nextAt = now() + 10_000;
                service.enqueueForUser({ eventId: randomUUID(), kind: 'test', discordUserId: userId, occurredAt: new Date(now()).toISOString() });
                await interaction.editReply('Test DM queued. Use /notifications status to check delivery.');
            }
        } catch (error) {
            const message = [50007, 50278].includes(Number(error?.code))
                ? 'Discord blocked this DM. Enable DMs from server members, unblock the bot, and try again. You may need a shared server with the bot.'
                : error instanceof ServiceError ? error.message : 'Could not complete the command. Please retry shortly.';
            try {
                if (interaction.deferred || interaction.replied) await interaction.editReply(message);
                else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
            } catch { /* Discord may have expired the interaction. No key is activated on reply failure. */ }
            log('Notification command failed.');
        }
    }
    return {
        handle(interaction) {
            const task = handle(interaction);
            tasks.add(task);
            void task.finally(() => tasks.delete(task)).catch(() => {});
            return task;
        },
        async drain() { await Promise.allSettled([...tasks]); }
    };
}
