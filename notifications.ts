import * as DataStore from "@api/DataStore";
import type { PluginNative } from "@utils/types";

import { type NotificationEvent, parseServiceUrl } from "./notificationProtocol";

interface Config { enabled: boolean; url: string; key: string; userId: string; }
interface Pending { event: NotificationEvent; scope: string; attempts: number; nextAt: number; }
export interface NotificationStatus { message: string; pending: number; }
const STORE_KEY = "NitroSniper.notificationOutbox.v1";
let state: NotificationStatus = { message: "Not connected", pending: 0 };
const subscribers = new Set<() => void>();
let config: () => Config;
let queue: Pending[] = [];
let scope = "";
let active = false;
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
    if (state.message === message && state.pending === pending) return;
    state = { message, pending };
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
async function connection() {
    const value = config();
    if (!value.enabled) throw new Error("Bot DM notifications are disabled.");
    const url = parseServiceUrl(value.url).origin;
    if (!/^[A-Za-z0-9_-]{43}$/.test(value.key.trim())) throw new Error("Paste the notification key from /notifications link.");
    if (!/^\d{17,20}$/.test(value.userId)) throw new Error("Sign in to Discord first.");
    return { ...value, url, key: value.key.trim(), scope: await digest(`${url}:${value.key.trim()}:${value.userId}`) };
}
function responseBody(data: string) {
    try { return JSON.parse(data); } catch { return {}; }
}
async function save() { await DataStore.set(STORE_KEY, queue); }
export async function startNotifications(getConfig: () => Config) {
    stopNotifications();
    config = getConfig;
    active = true;
    const generation = epoch;
    await serial(async () => {
        const stored = await DataStore.get<Pending[]>(STORE_KEY);
        if (!active || generation !== epoch) return;
        queue = Array.isArray(stored) ? stored.filter(item => item?.event?.kind === "claimed"
            && typeof item.scope === "string" && Number.isFinite(item.nextAt) && Number.isFinite(item.attempts)
            && Date.now() - Date.parse(item.event.occurredAt) < 86_400_000).slice(-100) : [];
        update("Ready to connect");
    });
    if (!active || generation !== epoch) return;
    timer = setInterval(() => void flush(), 5000);
    void flush();
}
export function stopNotifications() { active = false; epoch++; clearInterval(timer); }
export async function enqueueNotification(event: NotificationEvent) {
    if (!active || !config().enabled) return;
    const generation = epoch;
    await serial(async () => {
        const value = await connection();
        if (!active || generation !== epoch || event.discordUserId !== value.userId) return;
        scope = value.scope;
        if (queue.some(item => item.scope === scope && item.event.eventId === event.eventId)) return;
        if (queue.length >= 100) throw new Error("DM outbox is full. Check the bot connection.");
        queue.push({ event, scope, attempts: 0, nextAt: Date.now() });
        await save();
        update("Notification saved for delivery");
    });
    void flush();
}
async function flush() {
    if (!active || busy) return;
    busy = true;
    const generation = epoch;
    try {
        if (!config().enabled) { update("Bot DM notifications disabled"); return; }
        const value = await connection();
        if (!active || generation !== epoch) return;
        scope = value.scope;
        await serial(async () => {
            const remaining = queue.filter(item => Date.now() - Date.parse(item.event.occurredAt) < 86_400_000);
            if (remaining.length !== queue.length) { queue = remaining; await save(); }
        });
        const pending = queue.find(item => item.scope === scope && item.nextAt <= Date.now());
        if (!pending) { update(state.message); return; }
        const { status, data } = await native().sendBotNotification(value.url, value.key, "event", JSON.stringify(pending.event));
        if (!active || generation !== epoch || (await connection()).scope !== value.scope) return;
        const body = responseBody(data);
        const accepted = status >= 200 && status < 300 && body.accepted === true;
        const terminal = status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);
        await serial(async () => {
            if (accepted || terminal) queue = queue.filter(item => item !== pending);
            else {
                pending.attempts++;
                pending.nextAt = Date.now() + ([401, 403].includes(status) ? 300_000 : Math.min(300_000, 5000 * 2 ** Math.min(pending.attempts, 6)));
            }
            await save();
        });
        update(accepted ? (body.state === "delivered" ? "Last DM delivered" : body.state === "failed" ? "Last DM failed. Check connection status." : "Accepted by bot — check status for DM delivery")
            : typeof body.error === "string" ? body.error : "Bot unavailable — notification will retry automatically");
    } catch (error) { update(error instanceof Error ? error.message : "Notification connection failed"); }
    finally { busy = false; }
}
export async function checkBotConnection() {
    const value = await connection();
    const { status, data } = await native().sendBotNotification(value.url, value.key, "status", value.userId);
    const body = responseBody(data);
    if (status !== 200) throw new Error(body.error ?? "Could not reach notification bot.");
    if ((await connection()).scope !== value.scope) throw new Error("Settings changed. Check the connection again.");
    scope = value.scope;
    update(body.latest?.error ?? `Connected • ${body.pending ?? 0} queued on bot • last DM: ${body.latest?.state ?? "none"}`);
}
export async function sendTestDM() {
    const value = await connection();
    const event: NotificationEvent = { eventId: crypto.randomUUID(), kind: "test", discordUserId: value.userId, occurredAt: new Date().toISOString() };
    const { status, data } = await native().sendBotNotification(value.url, value.key, "event", JSON.stringify(event));
    const body = responseBody(data);
    if (status !== 202 || !body.accepted) throw new Error(body.error ?? "Could not send test DM.");
    if ((await connection()).scope !== value.scope) throw new Error("Settings changed. Send a new test.");
    scope = value.scope;
    update("Test queued — click Check Connection to confirm delivery");
}
