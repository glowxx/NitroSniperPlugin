import type { ClaimRequest } from "./types";

export interface NotificationEvent {
    eventId: string;
    kind: "claimed" | "test";
    discordUserId: string;
    occurredAt: string;
    giftType?: string;
    guildId?: string;
    channelId?: string;
    messageId?: string;
}

export function parseServiceUrl(value: string): URL {
    let url: URL;
    try { url = new URL(value.trim()); } catch { throw new Error("Enter a valid notification service URL."); }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
        throw new Error("Use HTTPS for the notification service (HTTP is allowed only on localhost).");
    }
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
        throw new Error("Use the service origin only, for example https://notify.example.com.");
    }
    return url;
}

export function parseDiscordWebhook(value: string): URL | null {
    if (!value.trim()) return null;
    let url: URL;
    try { url = new URL(value.trim()); } catch { throw new Error("Webhook URL is invalid."); }
    if (url.protocol !== "https:" || url.port || url.username || url.password
        || !["discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"].includes(url.hostname)
        || !/^\/api(?:\/v\d+)?\/webhooks\/\d{17,20}\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
        throw new Error("Enter an official Discord webhook URL.");
    }
    const threadIds = url.searchParams.getAll("thread_id");
    const waits = url.searchParams.getAll("wait");
    if (threadIds.length > 1 || (threadIds.length === 1 && !/^\d{17,20}$/.test(threadIds[0]))
        || waits.length > 1 || (waits.length === 1 && !["true", "false"].includes(waits[0]))
        || Array.from(url.searchParams.keys()).some(key => !["thread_id", "wait"].includes(key))) {
        throw new Error("Webhook query parameters are invalid. Only thread_id and wait are supported.");
    }
    url.hash = "";
    return url;
}

export function createNotification(request: ClaimRequest, discordUserId: string, giftType: string | null): NotificationEvent {
    return {
        // A code hash identifies duplicate callbacks without sharing the gift code with the bot.
        eventId: "", // Filled by the caller using SHA-256 of the gift code.
        kind: "claimed",
        discordUserId,
        occurredAt: new Date().toISOString(),
        giftType: giftType?.slice(0, 200) || undefined,
        guildId: request.guildId,
        channelId: request.channelId,
        messageId: request.messageId
    };
}
