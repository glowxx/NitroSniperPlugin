import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { NativeWebhookResponse } from "./types";

export interface BotConnection { credentialId: string; botId: string; botName: string; }
interface Credential extends BotConnection { token: string; }
interface Vault {
    get(userId: string): Promise<Credential | null>;
    set(userId: string, value: Credential): Promise<void>;
    remove(userId: string): Promise<void>;
}
interface Reply { status: number; body: any; }
const validUser = (id: string) => typeof id === "string" && /^\d{17,20}$/.test(id);
const failure = (status: number, error: string, retryAfter?: number): NativeWebhookResponse => ({ status, data: JSON.stringify({ error, retryAfter }) });

async function discordRequest(token: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Reply> {
    try {
        const response = await fetch(`https://discord.com/api/v10${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json", "User-Agent": "DiscordBot (https://github.com/glowxx/NitroSniperPlugin, 1.0)" },
            body: body === undefined ? undefined : JSON.stringify(body),
            redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000)
        });
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (reader) try {
            while (true) {
                const value = await reader.read();
                if (value.done) break;
                size += value.value.byteLength;
                if (size > 65_536) { await reader.cancel(); return { status: -1, body: {} }; }
                chunks.push(value.value);
            }
        } finally { reader.releaseLock(); }
        return { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
    } catch { return { status: -1, body: {} }; }
}

/** No token or raw Discord/network error is ever returned to the renderer. */
export function createDirectBot(vault: Vault, request = discordRequest) {
    let mutations: Promise<unknown> = Promise.resolve();
    const active = new Map<string, Set<AbortController>>();
    const cooldowns = new Map<string, number>();
    const serial = <T,>(action: () => Promise<T>): Promise<T> => {
        const result = mutations.then(action); mutations = result.catch(() => {}); return result;
    };
    const abort = (userId: string) => active.get(userId)?.forEach(controller => controller.abort());
    const publicInfo = (value: Credential): BotConnection => ({ credentialId: value.credentialId, botId: value.botId, botName: value.botName });
    function replyError(reply: Reply, botId: string) {
        if (reply.status === 429) {
            const seconds = typeof reply.body?.retry_after === "number" && Number.isFinite(reply.body.retry_after)
                ? Math.max(1, Math.min(86_400, reply.body.retry_after)) : 60;
            cooldowns.set(botId, Date.now() + seconds * 1000);
            return failure(429, "Discord rate limit; the DM will retry.", seconds);
        }
        if (reply.status === 401) return failure(401, "Bot token is invalid or revoked. Connect the bot again.");
        if (reply.status === 403) return failure(403, "Discord blocked this DM. Allow DMs and make sure you share a server with the bot.");
        return failure(reply.status >= 400 ? reply.status : -1, "Could not send the DM. Check the bot connection.");
    }
    return {
        status(userId: string) {
            if (!validUser(userId)) throw new Error("Sign in to Discord first.");
            return serial(async () => { const value = await vault.get(userId); return value ? publicInfo(value) : null; });
        },
        connect(userId: string, input: string) {
            if (!validUser(userId)) throw new Error("Sign in to Discord first.");
            const token = typeof input === "string" ? input.trim().replace(/^Bot\s+/i, "") : "";
            if (token.length < 20 || token.length > 256 || /\s/.test(token)) throw new Error("Paste a valid bot token.");
            return serial(async () => {
                const result = await request(token, "/users/@me");
                if (result.status !== 200 || result.body?.bot !== true || !validUser(result.body?.id)) {
                    throw new Error("Could not verify the bot token. Use a bot token from the Discord Developer Portal and check your connection.");
                }
                const value: Credential = { token, credentialId: randomUUID(), botId: result.body.id,
                    botName: typeof result.body.username === "string" ? result.body.username.slice(0, 100) : "Discord bot" };
                await vault.set(userId, value);
                abort(userId);
                return publicInfo(value);
            });
        },
        disconnect(userId: string) {
            if (!validUser(userId)) throw new Error("Sign in to Discord first.");
            // Stop an existing request immediately, without waiting for a pending token verification.
            abort(userId);
            return serial(async () => { await vault.remove(userId); abort(userId); });
        },
        async send(userId: string, credentialId: string, payload: string): Promise<NativeWebhookResponse> {
            if (!validUser(userId) || typeof payload !== "string" || payload.length > 8192) return failure(400, "Invalid DM notification.");
            let event: any;
            try { event = JSON.parse(payload); } catch { return failure(400, "Invalid DM notification."); }
            const timestamp = Date.parse(event?.occurredAt);
            if (event?.discordUserId !== userId || !["claimed", "test"].includes(event?.kind)
                || typeof event.eventId !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(event.eventId)
                || !Number.isFinite(timestamp) || timestamp > Date.now() + 300_000 || Date.now() - timestamp >= 86_400_000
                || (event.giftType !== undefined && (typeof event.giftType !== "string" || event.giftType.length > 200))
                || ![event.guildId, event.channelId, event.messageId].every(id => id === undefined || validUser(id))) return failure(400, "Invalid or expired DM notification.");
            const controller = new AbortController();
            const controllers = active.get(userId) ?? new Set<AbortController>();
            controllers.add(controller); active.set(userId, controllers);
            try {
                const value = await serial(() => vault.get(userId));
                if (!value || value.credentialId !== credentialId) return failure(401, "Connect your bot in the notification settings.");
                const current = async () => !controller.signal.aborted && Date.now() - timestamp < 86_400_000
                    && (await serial(() => vault.get(userId)))?.credentialId === credentialId && !controller.signal.aborted;
                const wait = (cooldowns.get(value.botId) ?? 0) - Date.now();
                if (wait > 0) return failure(429, "Discord rate limit; the DM will retry.", wait / 1000);
                if (!await current()) return failure(409, "DM cancelled because the connection changed.");
                const channel = await request(value.token, "/users/@me/channels", { recipient_id: userId }, controller.signal);
                if (!await current()) return failure(409, "DM cancelled because the connection changed.");
                if (channel.status !== 200 || !validUser(channel.body?.id)) return replyError(channel, value.botId);
                const escape = (text: string) => text.replace(/[\\`*_{}[\]()#+.!|>~\-]/g, "\\$&");
                const fields: { name: string; value: string; inline?: boolean; }[] = [];
                if (event.giftType) fields.push({ name: "Gift", value: escape(event.giftType), inline: true });
                if (event.channelId && event.messageId) fields.push({ name: "Source", value: `[Open message](https://discord.com/channels/${event.guildId ?? "@me"}/${event.channelId}/${event.messageId})` });
                const response = await request(value.token, `/channels/${channel.body.id}/messages`, {
                    embeds: [{ title: event.kind === "test" ? "Notifications connected" : "Nitro successfully claimed",
                        description: event.kind === "test" ? "Your bot DM notifications are working." : "Your Discord client reported a successful redemption.",
                        color: event.kind === "test" ? 0x5865f2 : 0x43b581, timestamp: new Date(timestamp).toISOString(), fields }],
                    allowed_mentions: { parse: [] }, enforce_nonce: true,
                    nonce: createHash("sha256").update(`${userId}:${event.eventId}`).digest("hex").slice(0, 24)
                }, controller.signal);
                if (response.status !== 200 || !validUser(response.body?.id)) return replyError(response, value.botId);
                return { status: 200, data: JSON.stringify({ accepted: true, state: "delivered" }) };
            } catch { return failure(-1, "Could not access the saved bot connection. Connect the bot again."); }
            finally { controllers.delete(controller); if (!controllers.size) active.delete(userId); }
        }
    };
}

/** Electron uses the operating system's credential protection, never plaintext fallback. */
export function encryptedVault(): Vault {
    let saved: Record<string, { encrypted: string; }> | undefined;
    async function storage() {
        const { app, safeStorage } = await import("electron");
        if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === "basic_text") {
            throw new Error("Secure token storage is unavailable. Enable your system keyring and restart Discord.");
        }
        const path = join(app.getPath("userData"), "NitroSniper", "bot-credentials.json");
        if (!saved) {
            try {
                const bytes = await readFile(path, "utf8");
                if (bytes.length > 1_000_000) throw new Error();
                const data = JSON.parse(bytes);
                if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
                saved = data;
            } catch (error: any) {
                if (error?.code !== "ENOENT") throw new Error("Could not read saved bot credentials.");
                saved = {};
            }
        }
        return { path, safeStorage };
    }
    async function commit(path: string, next: typeof saved) {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${randomUUID()}.tmp`;
        try { await writeFile(temporary, JSON.stringify(next), { mode: 0o600 }); await rename(temporary, path); saved = next; }
        catch { await unlink(temporary).catch(() => {}); throw new Error("Could not save the bot connection. Try again."); }
    }
    return {
        async get(userId) {
            const { safeStorage } = await storage();
            const record = saved![userId];
            if (!record) return null;
            try {
                const value = JSON.parse(safeStorage.decryptString(Buffer.from(record.encrypted, "base64")));
                if (typeof value?.token !== "string" || typeof value.credentialId !== "string" || !validUser(value.botId) || typeof value.botName !== "string") throw new Error();
                return value;
            } catch { throw new Error("Could not decrypt the bot connection. Connect the bot again."); }
        },
        async set(userId, value) {
            const { path, safeStorage } = await storage();
            await commit(path, { ...saved, [userId]: { encrypted: safeStorage.encryptString(JSON.stringify(value)).toString("base64") } });
        },
        async remove(userId) {
            const { path } = await storage(); const next = { ...saved }; delete next[userId]; await commit(path, next);
        }
    };
}
export const directBot = createDirectBot(encryptedVault());
