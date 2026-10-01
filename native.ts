/*
Made with ❤️ by neoarz
I am not responsible for any damage caused by this plugin; use at your own risk
Vencord does not endorse/support this plugin (Works with Equicord as well)
dm @neoarz if u need help or have any questions
https://github.com/neoarz/NitroSniper
*/

import type { IpcMainInvokeEvent } from "electron";

import { parseDiscordWebhook, parseServiceUrl } from "./notificationProtocol";
import type { NativeWebhookResponse } from "./types";

async function request(url: URL, method: string, payload?: string, key?: string): Promise<NativeWebhookResponse> {
    try {
        const response = await fetch(url, {
            method,
            headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
            body: payload,
            redirect: "error",
            signal: AbortSignal.timeout(10_000)
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
