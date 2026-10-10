import * as DataStore from "@api/DataStore";
import type { PluginNative } from "@utils/types";

import { type NotificationEvent, parseServiceUrl } from "./notificationProtocol";

export interface NotificationConfig { enabled: boolean; url: string; key: string; userId: string; }
interface Connection extends NotificationConfig { scope: string; }
interface Pending { event: NotificationEvent; scope: string; attempts: number; nextAt: number; }
export interface NotificationStatus { message: string; pending: number; unsaved: number; }
const STORE_KEY = "NitroSniper.notificationOutbox.v1";
const DAY = 86_400_000;
let state: NotificationStatus = { message: "Not connected", pending: 0, unsaved: 0 };
let saveFailures: { connection: Connection; count: number; } | undefined;
const subscribers = new Set<() => void>();
let config: () => NotificationConfig;
let queue: Pending[] = [];
let scope = "";
let active = false;
let loaded = false;
let loadError: Error | undefined;
let epoch = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let busy = false;
let operations: Promise<unknown> = Promise.resolve();
const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
    const next = operations.then(fn);
    operations = next.catch(() => {});
    return next;
};
function update(message: string) {
    const pending = queue.filter(item => item.scope === scope).length;
    const unsaved = saveFailures?.connection.scope === scope && sameSession(epoch, saveFailures.connection) ? saveFailures.count : 0;
    if (state.message === message && state.pending === pending && state.unsaved === unsaved) return;
    state = { message, pending, unsaved };
    subscribers.forEach(fn => fn());
}
export const getNotificationStatus = () => state;
export function subscribeNotifications(fn: () => void) { subscribers.add(fn); return () => { subscribers.delete(fn); }; }
export async function digest(value: string) {
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
}
function native() {
    const helper = (globalThis as any).VencordNative?.pluginHelpers?.NitroSniper as PluginNative<typeof import("./native")> | undefined;
    if (!helper?.sendBotNotification) throw new Error("DM notifications require a desktop build with the updated native.ts. Rebuild and restart your client.");
    return helper;
}
export function captureNotificationConfig(): NotificationConfig | null {
    return config ? { ...config() } : null;
}
function sameSession(generation: number, value?: NotificationConfig) {
    if (!active || generation !== epoch) return false;
    if (!value) return true;
    const current = config();
    try {
        return current.enabled && current.userId === value.userId && current.key.trim() === value.key.trim()
            && parseServiceUrl(current.url).origin === parseServiceUrl(value.url).origin;
    } catch { return false; }
}
async function connection(value = config()): Promise<Connection> {
    if (!value.enabled) throw new Error("Bot DM notifications are disabled.");
    const url = parseServiceUrl(value.url).origin;
    if (!/^[A-Za-z0-9_-]{43}$/.test(value.key.trim())) throw new Error("Paste the notification key from /notifications link.");
    if (!/^\d{17,20}$/.test(value.userId)) throw new Error("Sign in to Discord first.");
    return { ...value, url, key: value.key.trim(), scope: await digest(`${url}:${value.key.trim()}:${value.userId}`) };
}
function responseBody(data: string): { accepted?: boolean; state?: string; pending?: number; error?: string; latest?: { state?: string; error?: string; }; } {
    try {
        const value = JSON.parse(data);
        return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch { return {}; }
}
function responseError(value: unknown, fallback: string) { return typeof value === "string" ? value.slice(0, 500) : fallback; }
function cleanEvent(event: NotificationEvent, now = Date.now()): NotificationEvent {
    const time = Date.parse(event?.occurredAt);
    if (event?.kind !== "claimed" || typeof event.eventId !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(event.eventId)
        || typeof event.discordUserId !== "string" || !/^\d{17,20}$/.test(event.discordUserId)
        || !Number.isFinite(time) || time > now + 300_000 || now - time >= DAY
        || (event.giftType !== undefined && (typeof event.giftType !== "string" || event.giftType.length > 200))
        || ![event.guildId, event.channelId, event.messageId].every(id => id === undefined || (typeof id === "string" && /^\d{17,20}$/.test(id)))) {
        throw new Error("Invalid or expired confirmed-claim notification.");
    }
    return { eventId: event.eventId, kind: "claimed", discordUserId: event.discordUserId,
        occurredAt: new Date(time).toISOString(), giftType: event.giftType,
        guildId: event.guildId, channelId: event.channelId, messageId: event.messageId };
}
function restoreStored(item: Pending, now: number): Pending | null {
    try {
        if (typeof item?.scope !== "string" || !/^[a-f0-9]{64}$/.test(item.scope)
            || !Number.isInteger(item.attempts) || item.attempts < 0 || !Number.isFinite(item.nextAt)) return null;
        return { event: cleanEvent(item.event, now), scope: item.scope, attempts: item.attempts, nextAt: Math.min(item.nextAt, now + 300_000) };
    } catch { return null; }
}
/** Commit snapshots before publishing them in memory; failed writes cannot create sendable events. */
async function commit(next: Pending[]) {
    await DataStore.set(STORE_KEY, next);
    queue = next;
}
export async function startNotifications(getConfig: () => NotificationConfig) {
    stopNotifications();
    config = getConfig;
    active = true;
    loaded = false;
    loadError = undefined;
    saveFailures = undefined;
    scope = "";
    const generation = epoch;
    try {
        await serial(async () => {
            const stored = await DataStore.get<Pending[]>(STORE_KEY);
            if (!sameSession(generation)) return;
            if (stored !== undefined && (!Array.isArray(stored) || stored.length > 100)) throw new Error("Saved DM outbox is invalid. Notifications are paused; recover the client DataStore before restarting.");
            queue = (stored ?? []).map(item => restoreStored(item, Date.now())).filter((item): item is Pending => item !== null);
            loaded = true;
            update("Ready to connect");
        });
    } catch (error) {
        if (sameSession(generation)) {
            loadError = new Error(error instanceof Error ? `Could not load DM outbox: ${error.message}` : "Could not load DM outbox.");
            update(loadError.message);
        }
        throw loadError ?? error;
    }
    if (!sameSession(generation) || !loaded) return;
    timer = setInterval(() => void flush(), 5000);
    void flush();
}
export function stopNotifications() {
    active = false; epoch++; clearInterval(timer);
    scope = "";
    update("Notifications stopped");
}
export async function enqueueNotification(event: NotificationEvent, expectedConfig?: NotificationConfig | null, giftType?: Promise<string | null>) {
    if (loadError) throw loadError;
    if (!active || !config().enabled) return;
    const generation = epoch;
    let saved: Pending | undefined;
    let savedConnection: Connection | undefined;
    await serial(async () => {
        if (loadError) throw loadError;
        if (!loaded) throw new Error("DM outbox has not loaded. Notifications are paused.");
        const value = await connection(expectedConfig ?? config());
        if (!sameSession(generation, value) || event.discordUserId !== value.userId) return;
        scope = value.scope;
        try {
            const clean = cleanEvent(event);
            const remaining = queue.filter(item => Date.now() - Date.parse(item.event.occurredAt) < DAY);
            if (remaining.some(item => item.scope === scope && item.event.eventId === event.eventId)) return;
            if (remaining.length >= 100) throw new Error("DM outbox is full. Check the bot connection.");
            const item = { event: clean, scope, attempts: 0, nextAt: Date.now() + (giftType ? 3000 : 0) };
            await commit([...remaining, item]);
            saved = item;
            savedConnection = value;
        } catch (error) {
            if (sameSession(generation, value)) {
                saveFailures = { connection: value, count: (saveFailures?.connection.scope === value.scope ? saveFailures.count : 0) + 1 };
                update(error instanceof Error ? error.message : "Could not save the confirmed-claim notification.");
            }
            throw error;
        }
        if (sameSession(generation, value)) update("Notification saved for delivery");
    });
    // Metadata is optional. The event is already durable, even if the client stops during lookup.
    if (giftType && saved && savedConnection) {
        const type = await giftType.catch(() => null);
        await serial(async () => {
            if (!sameSession(generation, savedConnection) || !queue.includes(saved!)) return;
            const enriched = { ...saved!, event: { ...saved!.event, giftType: typeof type === "string" ? type.slice(0, 200) || undefined : undefined }, nextAt: Date.now() };
            await commit(queue.map(item => item === saved ? enriched : item));
        }).catch(() => {
            // The original event is already durable; optional enrichment must not turn it into a failed save.
            if (sameSession(generation, savedConnection)) update("Notification saved; optional gift details could not be updated.");
        });
    }
    if (sameSession(generation)) void flush();
}
async function flush() {
    if (!active || !loaded || loadError || busy) return;
    busy = true;
    const generation = epoch;
    try {
        if (!config().enabled) { update("Bot DM notifications disabled"); return; }
        const value = await connection();
        if (!sameSession(generation, value)) return;
        scope = value.scope;
        await serial(async () => {
            if (!sameSession(generation, value)) return;
            const remaining = queue.filter(item => Date.now() - Date.parse(item.event.occurredAt) < DAY);
            if (remaining.length !== queue.length) await commit(remaining);
        });
        if (!sameSession(generation, value)) return;
        const pending = queue.find(item => item.scope === value.scope && item.nextAt <= Date.now());
        if (!pending) { update(state.message); return; }
        let status = -1, data = "";
        try {
            ({ status, data } = await native().sendBotNotification(value.url, value.key, "event", JSON.stringify(pending.event)));
        } catch { /* A rejected IPC request follows the same persisted backoff as a network failure. */ }
        if (!sameSession(generation, value)) return;
        const body = responseBody(data);
        const accepted = status >= 200 && status < 300 && body.accepted === true;
        const terminal = status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);
        await serial(async () => {
            if (!sameSession(generation, value)) return;
            // Optional enrichment can replace the object while the HTTP request is in flight.
            const current = queue.find(item => item.scope === pending.scope && item.event.eventId === pending.event.eventId);
            if (!current) return;
            if (accepted || terminal) await commit(queue.filter(item => item !== current));
            else {
                const attempts = current.attempts + 1;
                const nextAt = Date.now() + ([401, 403].includes(status) ? 300_000 : status === 429 ? 60_000 : Math.min(300_000, 5000 * 2 ** Math.min(attempts, 6)));
                await commit(queue.map(item => item === current ? { ...current, attempts, nextAt } : item));
            }
        });
        if (!sameSession(generation, value)) return;
        update(accepted ? (body.state === "delivered" ? "Last DM delivered" : body.state === "failed" ? "Last DM failed. Check connection status." : "Accepted by bot — check status for DM delivery")
            : terminal ? `Notification rejected (HTTP ${status}) — it will not retry. ${responseError(body.error, "Check the service URL and bot configuration.")}`
                : responseError(body.error, "Bot unavailable — notification will retry automatically"));
    } catch (error) {
        if (sameSession(generation)) update(error instanceof Error ? error.message : "Notification connection failed");
    } finally { busy = false; }
}
async function actionConnection() {
    if (!active) throw new Error("Notification session stopped. Enable the plugin first.");
    if (loadError) throw loadError;
    if (!loaded) throw new Error("DM outbox has not loaded yet.");
    const generation = epoch;
    const value = await connection();
    if (!sameSession(generation, value)) throw new Error("Notification settings changed or the session stopped.");
    return { generation, value };
}
export async function checkBotConnection() {
    const { generation, value } = await actionConnection();
    const { status, data } = await native().sendBotNotification(value.url, value.key, "status", value.userId);
    const body = responseBody(data);
    if (!sameSession(generation, value)) throw new Error("Notification settings changed or the session stopped.");
    if (status !== 200) throw new Error(responseError(body.error, "Could not reach notification bot."));
    scope = value.scope;
    update(responseError(body.latest?.error, `Connected • ${Number.isInteger(body.pending) ? body.pending : "unknown"} queued on bot • last DM: ${typeof body.latest?.state === "string" ? body.latest.state.slice(0, 30) : "none"}`));
}
export async function sendTestDM() {
    const { generation, value } = await actionConnection();
    const event: NotificationEvent = { eventId: crypto.randomUUID(), kind: "test", discordUserId: value.userId, occurredAt: new Date().toISOString() };
    const { status, data } = await native().sendBotNotification(value.url, value.key, "event", JSON.stringify(event));
    const body = responseBody(data);
    if (!sameSession(generation, value)) throw new Error("Notification settings changed or the session stopped.");
    if (status !== 202 || body.accepted !== true) throw new Error(responseError(body.error, "Could not send test DM."));
    scope = value.scope;
    update("Test queued — click Check Connection to confirm delivery");
}
