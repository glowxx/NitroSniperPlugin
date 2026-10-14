/*
Made with ❤️ by neoarz
I am not responsible for any damage caused by this plugin; use at your own risk
Vencord does not endorse/support this plugin (Works with Equicord as well)
dm @neoarz if u need help or have any questions
https://github.com/neoarz/NitroSniper
*/

import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import type { Message } from "@vencord/discord-types";
import { findByPropsLazy } from "@webpack";
import { ChannelStore, showToast, UserStore } from "@webpack/common";

import { accountNotificationSettings } from "./accountSettings";
import { ClaimQueue, extractGiftCodes } from "./claimQueue";
import { resolveGiftType } from "./giftCode";
import { createNotification } from "./notificationProtocol";
import { captureNotificationConfig, digest, enqueueNotification, startNotifications, stopNotifications } from "./notifications";
import { settings } from "./settings";
import type { ClaimRequest } from "./types";
import { sendClaimWebhook } from "./webhook";

export { waitForNotificationIdle } from "./notifications";

const logger = new Logger("NitroSniper");
const GiftActions = findByPropsLazy("redeemGiftCode");
let startTime = 0;
let session = 0;
let started = false;
let accountId = "";
let lastOverflowWarning = 0;
const recordings = new Set<Promise<void>>();

/** Observe already-started confirmed-event preparation without making shutdown wait. */
export async function waitForConfirmedNotifications() {
    // Promise-only redemption confirms in the microtask queue.
    await Promise.resolve();
    while (recordings.size) await Promise.allSettled([...recordings]);
}

interface MessageCreateEvent {
    message: Message & { guild_id?: string; };
    channelId?: string;
    guildId?: string;
    optimistic?: boolean;
    isPushNotification?: boolean;
    sendMessageOptions?: unknown;
}

async function giftTypeWithDeadline(code: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([resolveGiftType(code), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 3000); })]);
    } finally { clearTimeout(timer); }
}

async function notify(request: ClaimRequest, success: boolean, userId: string, generation: number) {
    const { webhookUrl, botNotificationsEnabled: botEnabled } = accountNotificationSettings(settings.store, userId);
    if (!webhookUrl.trim() && !(success && botEnabled)) return;
    const isCurrent = () => started && generation === session && UserStore.getCurrentUser()?.id === userId;
    if (!isCurrent()) return;
    const expectedConfig = captureNotificationConfig();
    const giftType = giftTypeWithDeadline(request.code);
    if (webhookUrl.trim()) void giftType.then(type => {
        if (!isCurrent() || accountNotificationSettings(settings.store, userId).webhookUrl !== webhookUrl) return;
        return sendClaimWebhook(webhookUrl, success ? "claimed" : "failed", request, type);
    }).catch(() => logger.error("Webhook notification failed. Check the webhook URL and desktop native support."));
    if (success && botEnabled) {
        const event = createNotification(request, userId, null);
        event.eventId = await digest(`${userId}:${request.code}`);
        await enqueueNotification(event, expectedConfig, giftType);
    }
}

const queue = new ClaimQueue(
    (request, onRedeemed, onError) => {
        if (request.claimantId !== UserStore.getCurrentUser()?.id) return onError(new Error("Discord account changed."));
        return GiftActions.redeemGiftCode({ code: request.code, options: { channelId: request.channelId }, onRedeemed, onError });
    },
    (request, success) => {
        logger.log(success ? "Gift successfully redeemed" : "Gift redemption failed");
        const userId = request.claimantId;
        const generation = session;
        if (userId) {
            const recording = notify(request, success, userId, generation).catch(() => {
                logger.error("Could not save DM notification. Check the notification settings and outbox.");
                if (started && generation === session && UserStore.getCurrentUser()?.id === userId) {
                    showToast("NitroSniper could not save a DM notification. Check the notification panel and connection settings.", "failure");
                }
            });
            recordings.add(recording);
            void recording.finally(() => recordings.delete(recording));
        }
    },
    () => showToast("NitroSniper is still waiting for Discord. Check for an open gift or CAPTCHA dialog. If Discord never responds, fully restart the client.", "failure")
);

function directCredentialId(userId: string): string {
    try { return JSON.parse(settings.store.botDirectAccounts || "{}")[userId]?.credentialId ?? ""; }
    catch { return ""; }
}

function startSession() {
    started = true;
    session++;
    accountId = UserStore.getCurrentUser()?.id ?? "";
    accountNotificationSettings(settings.store, accountId);
    startTime = Date.now();
    queue.start();
    void startNotifications(() => {
        const userId = UserStore.getCurrentUser()?.id ?? "";
        const value = accountNotificationSettings(settings.store, userId);
        return { enabled: value.botNotificationsEnabled, mode: value.botNotificationMode,
            url: value.botNotificationMode === "direct" ? "https://discord.com" : value.botServiceUrl,
            key: value.botNotificationMode === "direct" ? directCredentialId(userId) : value.botNotificationKey, userId };
    })
        .catch(() => logger.error("Could not load the DM notification outbox."));
}

export default definePlugin({
    name: "NitroSniper",
    description: "Redeems Nitro gift links with optional webhook and bot DM notifications",
    authors: [{ name: "neoarz", id: 218675193592283137n }],
    tags: ["Chat", "Utility"],
    searchTerms: ["nitro", "gift", "redeem", "snipe", "notifications"],
    settings,
    start: startSession,
    stop() {
        started = false;
        session++;
        queue.stop();
        stopNotifications();
    },
    flux: {
        MESSAGE_CREATE(event: MessageCreateEvent) {
            const { message, channelId, guildId, optimistic, isPushNotification } = event;
            if (!started || !message.content || !UserStore.getCurrentUser()) return;
            // History loads do not emit this envelope. Local SDK messages and push replay are separate sources.
            if (optimistic || isPushNotification || Object.hasOwn(event, "sendMessageOptions")) return;
            if (channelId !== undefined && channelId !== message.channel_id) return;
            if (accountId !== UserStore.getCurrentUser()?.id) {
                startSession();
            }
            if (settings.store.ignoreOwnGiftLinks && message.author?.id === UserStore.getCurrentUser()?.id) return;
            const timestamp = new Date(message.timestamp).getTime();
            // Verified Discord gateway shape: do not compare its server clock with the system clock.
            // Keep the conservative timestamp filter for unknown client/event formats.
            const gateway = optimistic === false && isPushNotification === false
                && Object.hasOwn(event, "guildId") && guildId === message.guild_id && channelId === message.channel_id;
            if (!Number.isFinite(timestamp) || (!gateway && timestamp < startTime)) return;
            for (const code of extractGiftCodes(message.content)) {
                const authorId = message.author?.id;
                const avatar = message.author?.avatar;
                if (queue.pendingCount >= 100 && Date.now() - lastOverflowWarning > 10_000) {
                    lastOverflowWarning = Date.now();
                    showToast("NitroSniper claim queue is full. Check the open Discord gift dialog.", "failure");
                }
                queue.enqueue({ code, claimantId: accountId, authorId, authorName: message.author?.globalName ?? message.author?.username,
                    authorUsername: message.author?.username,
                    authorAvatarUrl: authorId && avatar ? `https://cdn.discordapp.com/avatars/${authorId}/${avatar}.png?size=128` : undefined,
                    channelId: message.channel_id, guildId: ChannelStore.getChannel(message.channel_id)?.guild_id, messageId: message.id });
            }
        },
        CONNECTION_OPEN() { if (started && accountId !== UserStore.getCurrentUser()?.id) startSession(); },
        LOGOUT() { accountId = ""; session++; queue.stop(); stopNotifications(); }
    }
});
