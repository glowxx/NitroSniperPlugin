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
import { ChannelStore, showToast, Toasts, UserStore } from "@webpack/common";

import { ClaimQueue, extractGiftCodes } from "./claimQueue";
import { resolveGiftType } from "./giftCode";
import { createNotification } from "./notificationProtocol";
import { captureNotificationConfig, digest, enqueueNotification, startNotifications, stopNotifications } from "./notifications";
import { settings } from "./settings";
import type { ClaimRequest } from "./types";
import { sendClaimWebhook } from "./webhook";

const logger = new Logger("NitroSniper");
const GiftActions = findByPropsLazy("redeemGiftCode");
let startTime = 0;
let session = 0;
let started = false;
let accountId = "";
let lastOverflowWarning = 0;

async function giftTypeWithDeadline(code: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([resolveGiftType(code), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 3000); })]);
    } finally { clearTimeout(timer); }
}

async function notify(request: ClaimRequest, success: boolean, userId: string, generation: number) {
    const { webhookUrl, botNotificationsEnabled: botEnabled } = settings.store;
    if (!webhookUrl.trim() && !(success && botEnabled)) return;
    const isCurrent = () => started && generation === session && UserStore.getCurrentUser()?.id === userId;
    if (!isCurrent()) return;
    const expectedConfig = captureNotificationConfig();
    const giftType = giftTypeWithDeadline(request.code);
    if (webhookUrl.trim()) void giftType.then(type => {
        if (!isCurrent() || settings.store.webhookUrl !== webhookUrl) return;
        return sendClaimWebhook(webhookUrl, success ? "claimed" : "failed", request, type);
    }).catch(() => logger.error("Webhook notification failed. Check the webhook URL and desktop native support."));
    if (success && botEnabled) {
        const event = createNotification(request, userId, null);
        event.eventId = await digest(`${userId}:${request.code}`);
        if (!isCurrent()) return;
        await enqueueNotification(event, expectedConfig, giftType);
    }
}

const queue = new ClaimQueue(
    (request, onRedeemed, onError) => {
        if (request.claimantId !== UserStore.getCurrentUser()?.id) return onError(new Error("Discord account changed."));
        return GiftActions.redeemGiftCode({ code: request.code, onRedeemed, onError });
    },
    (request, success) => {
        logger.log(success ? "Gift successfully redeemed" : "Gift redemption failed");
        const userId = request.claimantId;
        if (userId) void notify(request, success, userId, session)
            .catch(() => logger.error("Could not save DM notification. Check the notification settings and outbox."));
    },
    () => showToast("NitroSniper is still waiting for Discord. Check for an open gift or CAPTCHA dialog. If Discord never responds, fully restart the client.", Toasts.Type.FAILURE)
);

function startSession() {
    started = true;
    session++;
    accountId = UserStore.getCurrentUser()?.id ?? "";
    startTime = Date.now();
    queue.start();
    void startNotifications(() => ({ enabled: settings.store.botNotificationsEnabled,
        url: settings.store.botServiceUrl, key: settings.store.botNotificationKey,
        userId: UserStore.getCurrentUser()?.id ?? "" }))
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
        MESSAGE_CREATE({ message }: { message: Message; }) {
            if (!started || !message.content || !UserStore.getCurrentUser()) return;
            if (accountId !== UserStore.getCurrentUser()?.id) {
                startSession();
                // Account-change handling occurs at receipt time, after this fresh event was created.
                const receivedTime = new Date(message.timestamp).getTime();
                if (Number.isFinite(receivedTime) && Date.now() - receivedTime < 5000) startTime = Math.min(startTime, receivedTime);
            }
            if (settings.store.ignoreOwnGiftLinks && message.author?.id === UserStore.getCurrentUser()?.id) return;
            const timestamp = new Date(message.timestamp).getTime();
            if (!Number.isFinite(timestamp) || timestamp < startTime) return;
            for (const code of extractGiftCodes(message.content)) {
                const authorId = message.author?.id;
                const avatar = message.author?.avatar;
                if (queue.pendingCount >= 100 && Date.now() - lastOverflowWarning > 10_000) {
                    lastOverflowWarning = Date.now();
                    showToast("NitroSniper claim queue is full. Check the open Discord gift dialog.", Toasts.Type.FAILURE);
                }
                queue.enqueue({ code, claimantId: accountId, authorId, authorName: message.author?.globalName ?? message.author?.username,
                    authorUsername: message.author?.username,
                    authorAvatarUrl: authorId && avatar ? `https://cdn.discordapp.com/avatars/${authorId}/${avatar}.png?size=128` : undefined,
                    channelId: message.channel_id, guildId: ChannelStore.getChannel(message.channel_id)?.guild_id, messageId: message.id });
            }
        },
        LOGOUT() { accountId = ""; session++; queue.stop(); stopNotifications(); }
    }
});
