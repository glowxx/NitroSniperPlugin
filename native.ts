/*
Made with ❤️ by neoarz
I am not responsible for any damage caused by this plugin; use at your own risk
Vencord does not endorse/support this plugin (Works with Equicord as well)
dm @neoarz if u need help or have any questions
https://github.com/neoarz/NitroSniper
*/

import type { IpcMainInvokeEvent } from "electron";

import { parseDiscordWebhook, parseServiceUrl } from "./notificationProtocol";
import type { GiftCodeResolution, NativeWebhookResponse } from "./types";

async function request(url: URL, method: string, payload?: string, key?: string, timeoutMs = 10_000): Promise<NativeWebhookResponse> {
    try {
        const response = await fetch(url, {
            method,
            headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
            body: payload,
            redirect: "error",
            signal: AbortSignal.timeout(timeoutMs)
        });
        // Bound the reply as well as the request; a misconfigured service cannot grow memory forever.
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let data = "";
        if (reader) {
            try {
                let bytes = 0;
                while (true) {
                    const result = await reader.read();
                    if (result.done) break;
                    bytes += result.value.byteLength;
                    if (bytes > 65_536) { await reader.cancel(); throw new Error("Response too large"); }
                    data += decoder.decode(result.value, { stream: true });
                }
                data += decoder.decode();
            } finally { reader.releaseLock(); }
        }
        return { status: response.status, data };
    } catch {
        // Fetch errors can contain credential-bearing URLs; never return raw errors to renderer logs.
        return { status: -1, data: "Notification request failed or timed out." };
    }
}

let metadataLookups = 0;

/** Resolve optional public gift metadata without a Discord account token. */
export async function resolveGiftMetadata(_: IpcMainInvokeEvent, code: string): Promise<string | null> {
    if (typeof code !== "string" || !/^[A-Za-z0-9]{16,24}$/.test(code) || metadataLookups >= 4) return null;
    metadataLookups++;
    try {
        const url = new URL(`https://discord.com/api/v10/entitlements/gift-codes/${code}`);
        url.searchParams.set("with_application", "false");
        url.searchParams.set("with_subscription_plan", "true");
        // Node fetch aborts the underlying request, including reading the response body.
        // https://nodejs.org/docs/latest-v22.x/api/globals.html#static-method-abortsignaltimeoutdelay
        const { status, data } = await request(url, "GET", undefined, undefined, 3000);
        if (status !== 200) return null;
        const body: GiftCodeResolution | null = JSON.parse(data);
        const name = body?.subscription_plan?.name ?? body?.store_listing?.sku?.name;
        return typeof name === "string" ? name.slice(0, 200) || null : null;
    } catch { return null; }
    finally { metadataLookups--; }
}

export async function sendWebhook(_: IpcMainInvokeEvent, webhookUrl: string, payload: string): Promise<NativeWebhookResponse> {
    const url = parseDiscordWebhook(webhookUrl);
    if (!url) throw new Error("Webhook URL is empty.");
    if (typeof payload !== "string" || payload.length > 8192) throw new Error("Invalid webhook payload.");
    url.searchParams.set("wait", "true");
    return request(url, "POST", payload);
}

export async function sendBotNotification(_: IpcMainInvokeEvent, serviceUrl: string, key: string, action: "event" | "status", payload: string): Promise<NativeWebhookResponse> {
    const url = parseServiceUrl(serviceUrl);
    if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error("Invalid notification key.");
    if (action === "status") {
        if (!/^\d{17,20}$/.test(payload)) throw new Error("Invalid Discord account.");
        url.pathname = "/v1/status";
        url.searchParams.set("discordUserId", payload);
        return request(url, "GET", undefined, key);
    }
    if (action !== "event" || typeof payload !== "string" || payload.length > 8192) throw new Error("Invalid notification request.");
    url.pathname = "/v1/events";
    return request(url, "POST", payload, key);
}

export async function connectDirectBot(_: IpcMainInvokeEvent, userId: string, token: string) {
    return (await import("./directBot")).directBot.connect(userId, token);
}
export async function getDirectBotStatus(_: IpcMainInvokeEvent, userId: string) {
    return (await import("./directBot")).directBot.status(userId);
}
export async function disconnectDirectBot(_: IpcMainInvokeEvent, userId: string) {
    return (await import("./directBot")).directBot.disconnect(userId);
}
export async function sendDirectBotNotification(_: IpcMainInvokeEvent, userId: string, credentialId: string, payload: string) {
    return (await import("./directBot")).directBot.send(userId, credentialId, payload);
}
