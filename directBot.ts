import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { NativeWebhookResponse } from "./types";

export interface BotConnection { credentialId: string; botId: string; botName: string; warning?: string; }
export interface BotDisconnectResult { disconnected: boolean; pendingCleanup?: number; warning?: string; }
interface Credential extends BotConnection { token: string; }
interface Vault {
    get(userId: string): Promise<Credential | null>;
    set(userId: string, value: Credential): Promise<void>;
    remove(userId: string): Promise<void>;
    recover?(userId: string): Promise<void>;
}
interface Reply { status: number; body: any; }
export interface TestCleanupJob {
    userId: string; botId: string; channelId: string; messageId: string;
    deleteAt: number; nextAttemptAt: number; attempts: number;
}
export interface TestCleanupStore {
    load(): Promise<TestCleanupJob[]>;
    save(jobs: TestCleanupJob[]): Promise<void>;
}
interface DirectBotOptions { cleanupStore?: TestCleanupStore; now?: () => number; autoSchedule?: boolean; }
const CLEANUP_LIMIT = 1000;
const CLEANUP_WARNING = "Some test messages could not be deleted. Automatic deletion requires reconnecting the same bot; removing its credential may leave these messages in Discord.";
const validUser = (id: string) => typeof id === "string" && /^\d{17,20}$/.test(id) && BigInt(id) <= 18_446_744_073_709_551_615n;
const failure = (status: number, error: string, retryAfter?: number): NativeWebhookResponse => ({ status, data: JSON.stringify({ error, retryAfter }) });

export async function discordRequest(token: string, path: string, body?: unknown, signal?: AbortSignal, method = body === undefined ? "GET" : "POST"): Promise<Reply> {
    let status = -1;
    try {
        const response = await fetch(`https://discord.com/api/v10${path}`, {
            method,
            headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json", "User-Agent": "DiscordBot (https://github.com/glowxx/NitroSniperPlugin, 1.0)" },
            body: body === undefined ? undefined : JSON.stringify(body),
            redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000)
        });
        status = response.status;
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (reader) try {
            while (true) {
                const value = await reader.read();
                if (value.done) break;
                size += value.value.byteLength;
                if (size > 65_536) { await reader.cancel(); return { status, body: {} }; }
                chunks.push(value.value);
            }
        } finally { reader.releaseLock(); }
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        return { status, body: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {} };
    } catch { return { status, body: {} }; }
}

/** No token or raw Discord/network error is ever returned to the renderer. */
export function createDirectBot(vault: Vault, request = discordRequest, options: DirectBotOptions = {}) {
    let mutations: Promise<unknown> = Promise.resolve();
    const active = new Map<string, Set<AbortController>>();
    const cooldowns = new Map<string, number>();
    const authorizationCooldowns = new Map<string, number>();
    const now = options.now ?? (() => Date.now());
    const cleanupStore = options.cleanupStore ?? diskCleanupStore();
    let jobs: TestCleanupJob[] | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let persistenceRetryAt = 0;
    let persistenceFailures = 0;
    let cleanupController: { userId: string; controller: AbortController; } | undefined;
    const serial = <T,>(action: () => Promise<T>): Promise<T> => {
        const result = mutations.then(action); mutations = result.catch(() => {}); return result;
    };
    const abort = (userId: string) => {
        active.get(userId)?.forEach(controller => controller.abort());
        if (cleanupController?.userId === userId) cleanupController.controller.abort();
    };
    const publicInfo = (value: Credential): BotConnection => ({ credentialId: value.credentialId, botId: value.botId, botName: value.botName });
    async function loadJobs() { jobs ??= await cleanupStore.load(); return jobs; }
    async function saveJobs(next: TestCleanupJob[]) { await cleanupStore.save(next); jobs = next; }
    const key = (job: TestCleanupJob) => `${job.userId}:${job.botId}:${job.channelId}:${job.messageId}`;
    function schedule() {
        if (timer) clearTimeout(timer);
        timer = undefined;
        if (stopped || options.autoSchedule === false || (jobs && !jobs.length)) return;
        const due = jobs ? Math.max(persistenceRetryAt, Math.min(...jobs.map(job => Math.max(job.deleteAt, job.nextAttemptAt)))) : persistenceRetryAt;
        timer = setTimeout(() => { timer = undefined; void runCleanup().catch(() => {}); }, Math.max(100, Math.min(3_600_000, due - now())));
        timer.unref?.();
    }
    async function deleteJob(job: TestCleanupJob, value: Credential, signal?: AbortSignal) {
        // Recheck after asynchronous credential lookup: the wall clock may have moved backwards.
        if (job.deleteAt > now()) return;
        if ((authorizationCooldowns.get(value.botId) ?? 0) > now()) return { status: 401, body: {} };
        const wait = (cooldowns.get(value.botId) ?? 0) - now();
        if (wait > 0) return { status: 429, body: { retry_after: wait / 1000 } };
        try { return await request(value.token, `/channels/${job.channelId}/messages/${job.messageId}`, undefined, signal, "DELETE"); }
        catch { return { status: -1, body: {} }; }
    }
    async function updateJob(job: TestCleanupJob, reply: Reply) {
        if ((reply.status >= 200 && reply.status < 300) || reply.status === 404) {
            await saveJobs((await loadJobs()).filter(item => key(item) !== key(job)));
            return;
        }
        const attempts = Math.min(20, job.attempts + 1);
        const delay = reply.status === 429 ? retrySeconds(reply) * 1000
            : reply.status === -1 || reply.status >= 500 ? Math.min(3_600_000, 5000 * 2 ** Math.min(attempts - 1, 10)) : 3_600_000;
        if (reply.status === 429) cooldowns.set(job.botId, Math.max(cooldowns.get(job.botId) ?? 0, now() + delay));
        if ([401, 403].includes(reply.status)) authorizationCooldowns.set(job.botId, now() + delay);
        const next = { ...job, attempts, nextAttemptAt: now() + delay };
        await saveJobs((await loadJobs()).map(item => key(item) === key(job) ? next : item));
    }
    async function processCleanup() {
        // The same mutation queue protects credentials, cleanup jobs and DELETEs from rotation races.
        let processed = 0;
        for (const job of [...await loadJobs()]) {
            if (Math.max(job.deleteAt, job.nextAttemptAt) > now()) continue;
            if (processed++ >= 20) break;
            let value: Credential | null = null;
            try { value = await vault.get(job.userId); } catch { /* Keep the job for secure storage recovery. */ }
            if (!value || value.botId !== job.botId) {
                await updateJob(job, { status: 401, body: {} });
                continue;
            }
            const controller = new AbortController();
            cleanupController = { userId: job.userId, controller };
            try {
                const reply = await deleteJob(job, value, controller.signal);
                if (reply) await updateJob(job, reply);
            }
            finally { cleanupController = undefined; }
            if (controller.signal.aborted) break;
        }
    }
    function runCleanup() {
        return serial(async () => {
            try {
                if (now() < persistenceRetryAt) return;
                await processCleanup();
                persistenceFailures = 0; persistenceRetryAt = 0;
            } catch {
                // A failed durable update must not repeatedly dispatch a still-due DELETE.
                persistenceRetryAt = now() + Math.min(300_000, 5000 * 2 ** Math.min(persistenceFailures++, 6));
            }
            finally { schedule(); }
        });
    }
    function retrySeconds(reply: Reply) {
        return typeof reply.body?.retry_after === "number" && Number.isFinite(reply.body.retry_after)
            ? Math.max(1, Math.min(86_400, reply.body.retry_after)) : 60;
    }
    function replyError(reply: Reply, botId: string) {
        if (reply.status === 429) {
            const seconds = retrySeconds(reply);
            cooldowns.set(botId, now() + seconds * 1000);
            return failure(429, "Discord rate limit; the DM will retry.", seconds);
        }
        if (reply.status === 401) return failure(401, "Bot token is invalid or revoked. Connect the bot again.");
        if (reply.status === 403) return failure(403, "Discord blocked this DM. Allow DMs and make sure you share a server with the bot.");
        return failure(reply.status >= 400 ? reply.status : -1, "Could not send the DM. Check the bot connection.");
    }
    return {
        runCleanup,
        startCleanup() { stopped = false; return runCleanup(); },
        stopCleanup() { stopped = true; cleanupController?.controller.abort(); if (timer) clearTimeout(timer); timer = undefined; },
        status(userId: string) {
            if (!validUser(userId)) throw new Error("Sign in to Discord first.");
            return serial(async () => {
                const value = await vault.get(userId);
                if (!value) return null;
                let warning: string | undefined;
                try {
                    if ((await loadJobs()).some(job => job.userId === userId && job.attempts > 0)) warning = CLEANUP_WARNING;
                    schedule();
                }
                catch { warning = "Saved test-message cleanup is corrupted or unavailable. Pending cleanup has been preserved; check local storage."; }
                return { ...publicInfo(value), ...(warning ? { warning } : {}) };
            });
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
                const old = await vault.get(userId);
                abort(userId);
                let warning: string | undefined;
                if (old && old.botId !== value.botId && (await loadJobs()).some(job => job.userId === userId)) warning = CLEANUP_WARNING;
                await vault.set(userId, value);
                authorizationCooldowns.delete(value.botId);
                // A replacement token for the same bot can resume its original jobs immediately.
                if (jobs) await saveJobs(jobs.map(job => job.userId === userId && job.botId === value.botId ? { ...job, nextAttemptAt: job.deleteAt } : job));
                schedule();
                return { ...publicInfo(value), ...(warning ? { warning } : {}) };
            });
        },
        disconnect(userId: string, force = false): Promise<BotDisconnectResult> {
            if (!validUser(userId)) throw new Error("Sign in to Discord first.");
            if (typeof force !== "boolean") throw new Error("Invalid disconnect request.");
            // A blocked normal disconnect keeps deliveries active; only explicit force revokes immediately.
            if (force) abort(userId);
            return serial(async () => {
                let warning: string | undefined;
                let pendingCleanup: number | undefined;
                try { pendingCleanup = (await loadJobs()).filter(job => job.userId === userId).length; }
                catch { warning = "Could not read pending test-message cleanup. Disconnect was not completed. Force disconnect may leave temporary test messages in Discord."; }
                if (!force && (pendingCleanup || warning)) {
                    schedule();
                    return { disconnected: false, pendingCleanup, warning: warning ?? `There are ${pendingCleanup} temporary test message(s) waiting for automatic deletion after their 30-second lifetime. Cleanup requires the original bot credential. Disconnect after cleanup completes, or force disconnect knowing these messages may remain in Discord.` };
                }
                if (pendingCleanup || warning) warning = CLEANUP_WARNING;
                // Opaque removal needs no decryption. Neither normal nor forced removal issues DELETE.
                await vault.remove(userId); abort(userId);
                schedule();
                return { disconnected: true, ...(warning ? { warning } : {}) };
            });
        },
        recover(userId: string) {
            if (!validUser(userId)) throw new Error("Sign in to Discord first.");
            abort(userId);
            return serial(async () => {
                if (!vault.recover) throw new Error("Credential recovery is unavailable.");
                await vault.recover(userId);
            });
        },
        async send(userId: string, credentialId: string, payload: string): Promise<NativeWebhookResponse> {
            if (!validUser(userId) || typeof payload !== "string" || payload.length > 8192) return failure(400, "Invalid DM notification.");
            let event: any;
            try { event = JSON.parse(payload); } catch { return failure(400, "Invalid DM notification."); }
            const timestamp = Date.parse(event?.occurredAt);
            if (event?.discordUserId !== userId || !["claimed", "test"].includes(event?.kind)
                || typeof event.eventId !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(event.eventId)
                || !Number.isFinite(timestamp) || timestamp > now() + 300_000 || now() - timestamp >= 86_400_000
                || (event.giftType !== undefined && (typeof event.giftType !== "string" || event.giftType.length > 200))
                || ![event.guildId, event.channelId, event.messageId].every(id => id === undefined || validUser(id))) return failure(400, "Invalid or expired DM notification.");
            const controller = new AbortController();
            const controllers = active.get(userId) ?? new Set<AbortController>();
            controllers.add(controller); active.set(userId, controllers);
            try {
                const value = await serial(() => vault.get(userId));
                if (!value || value.credentialId !== credentialId) return failure(401, "Connect your bot in the notification settings.");
                const current = async () => !controller.signal.aborted && now() - timestamp < 86_400_000
                    && (await serial(() => vault.get(userId)))?.credentialId === credentialId && !controller.signal.aborted;
                const wait = (cooldowns.get(value.botId) ?? 0) - now();
                if (wait > 0) return failure(429, "Discord rate limit; the DM will retry.", wait / 1000);
                if (!await current()) return failure(409, "DM cancelled because the connection changed.");
                const channel = await request(value.token, "/users/@me/channels", { recipient_id: userId }, controller.signal);
                if (!await current()) return failure(409, "DM cancelled because the connection changed.");
                if (channel.status !== 200 || !validUser(channel.body?.id)) return replyError(channel, value.botId);
                const escape = (text: string) => text.replace(/[\\`*_{}[\]()#+.!|>~-]/g, "\\$&");
                const fields: { name: string; value: string; inline?: boolean; }[] = [];
                if (event.giftType) fields.push({ name: "Gift", value: escape(event.giftType), inline: true });
                if (event.channelId && event.messageId) fields.push({ name: "Source", value: `[Open message](https://discord.com/channels/${event.guildId ?? "@me"}/${event.channelId}/${event.messageId})` });
                return await serial(async () => {
                    const latest = await vault.get(userId);
                    if (controller.signal.aborted || latest?.credentialId !== credentialId || now() - timestamp >= 86_400_000) return failure(409, "DM cancelled because the connection changed or the event expired.");
                    const cooldown = (cooldowns.get(value.botId) ?? 0) - now();
                    if (cooldown > 0) return failure(429, "Discord rate limit; the DM will retry.", cooldown / 1000);
                    if (event.kind === "test" && (await loadJobs()).length >= CLEANUP_LIMIT) return failure(503, "Temporary test-message cleanup is full. Wait for pending cleanup before sending another test.");
                    const response = await request(value.token, `/channels/${channel.body.id}/messages`, {
                    embeds: [{ title: event.kind === "test" ? "Notifications connected" : "Nitro successfully claimed",
                        description: event.kind === "test" ? "Your bot DM notifications are working." : "Your Discord client reported a successful redemption.",
                        color: event.kind === "test" ? 0x5865f2 : 0x43b581, timestamp: new Date(timestamp).toISOString(), fields }],
                    allowed_mentions: { parse: [] }, enforce_nonce: true,
                    nonce: createHash("sha256").update(`${event.kind === "test" ? "test:" : ""}${userId}:${event.eventId}`).digest("hex").slice(0, 24)
                // A dispatched test must yield its receipt before a queued credential mutation runs.
                // Fetch's own ten-second deadline still bounds this native operation.
                }, event.kind === "test" ? undefined : controller.signal);
                if (response.status !== 200 || !validUser(response.body?.id)) return replyError(response, value.botId);
                if (event.kind === "test") {
                    // IDs originate only in this successful native create-message response. Renderer source IDs are never deletion targets.
                    if (!validUser(response.body?.channel_id) || response.body.channel_id !== channel.body.id) return failure(502, "The test was delivered, but Discord did not return a valid cleanup identity.");
                    // Local receipt time prevents an ahead-of-server client clock from deleting a fresh test early.
                    const deleteAt = now() + 30_000;
                    const job: TestCleanupJob = { userId, botId: value.botId, channelId: response.body.channel_id,
                        messageId: response.body.id, deleteAt, nextAttemptAt: deleteAt, attempts: 0 };
                    const existing = await loadJobs();
                    if (!existing.some(item => key(item) === key(job))) {
                        try { await saveJobs([...existing, job]); }
                        catch { return failure(503, "The test DM was delivered, but its automatic cleanup could not be saved. Delete this test manually and check local storage before testing again."); }
                    }
                    schedule();
                }
                return { status: 200, data: JSON.stringify({ accepted: true, state: "delivered" }) };
                });
            } catch { return failure(-1, "Could not access the saved bot connection. Connect the bot again."); }
            finally { controllers.delete(controller); if (!controllers.size) active.delete(userId); }
        }
    };
}

/** Electron uses the operating system's credential protection, never plaintext fallback. */
export async function readBounded(path: string, limit = 1_000_000): Promise<string> {
    const file = await open(path, "r");
    try {
        const buffer = Buffer.alloc(limit + 1);
        let length = 0;
        while (length <= limit) {
            const result = await file.read(buffer, length, buffer.length - length, length);
            if (!result.bytesRead) break;
            length += result.bytesRead;
        }
        if (length > limit) throw new Error("Stored data is too large.");
        return buffer.subarray(0, length).toString("utf8");
    } finally { await file.close(); }
}
export async function atomicJson(path: string, value: unknown) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => {}); }
}
async function quarantine(path: string) {
    const backups = (await readdir(dirname(path))).filter(name => name.startsWith("bot-credentials.json.quarantine-"));
    if (backups.length >= 5) throw new Error("Secure credential recovery backups are full. Preserve or remove an old backup before recovering again.");
    await copyFile(path, `${path}.quarantine-${randomUUID()}`);
}
/** Native-only, nonsecret cleanup records; no renderer endpoint can append or delete IDs. */
export function diskCleanupStore(pathForStore?: () => Promise<string>): TestCleanupStore {
    const location = pathForStore ?? (async () => {
        const { app } = await import("electron");
        return join(app.getPath("userData"), "NitroSniper", "test-message-cleanup.json");
    });
    const valid = (job: any): job is TestCleanupJob => job && typeof job === "object"
        && [job.userId, job.botId, job.channelId, job.messageId].every(validUser)
        // Absolute deadlines remain valid if the wall clock moves backwards before restart.
        && Number.isSafeInteger(job.deleteAt) && job.deleteAt > 0 && job.deleteAt <= 8_640_000_000_000_000
        && Number.isSafeInteger(job.nextAttemptAt) && job.nextAttemptAt > 0 && job.nextAttemptAt <= 8_640_000_000_000_000
        && Number.isInteger(job.attempts) && job.attempts >= 0 && job.attempts <= 20;
    const normalize = (jobs: TestCleanupJob[]) => jobs.map(({ userId, botId, channelId, messageId, deleteAt, nextAttemptAt, attempts }) =>
        ({ userId, botId, channelId, messageId, deleteAt, nextAttemptAt, attempts }));
    return {
        async load() {
            const path = await location();
            let value: any;
            try { value = JSON.parse(await readBounded(path)); }
            catch (error: any) {
                if (error?.code === "ENOENT") return [];
                throw new Error("Saved test-message cleanup is corrupted or unavailable. Pending cleanup has been preserved.");
            }
            if (value?.version !== 1 || !Array.isArray(value.jobs) || value.jobs.length > CLEANUP_LIMIT) {
                throw new Error("Saved test-message cleanup is corrupted. Pending cleanup has been preserved.");
            }
            const unique = new Map<string, TestCleanupJob>();
            for (const job of value.jobs) if (valid(job)) {
                const key = `${job.userId}:${job.botId}:${job.channelId}:${job.messageId}`;
                if (!unique.has(key)) unique.set(key, job);
            }
            const jobs = normalize([...unique.values()]);
            // An invalid entry cannot disable valid entries, and extra fields (including secrets) are never retained.
            if (JSON.stringify(jobs) !== JSON.stringify(value.jobs)) await atomicJson(path, { version: 1, jobs });
            return jobs;
        },
        async save(jobs) {
            if (jobs.length > CLEANUP_LIMIT || !jobs.every(valid)) throw new Error("Invalid test-message cleanup state.");
            await atomicJson(await location(), { version: 1, jobs: normalize(jobs) });
        }
    };
}
export function encryptedVault(): Vault {
    let saved: Record<string, { encrypted: string; }> | undefined;
    const validRecord = (value: unknown): value is { encrypted: string; } => !!value && typeof value === "object" && !Array.isArray(value)
        && "encrypted" in value
        && typeof value.encrypted === "string" && value.encrypted.length > 0 && value.encrypted.length <= 8192
        && /^[A-Za-z0-9+/]+={0,2}$/.test(value.encrypted);
    const validOuter = (value: any) => value && typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).length <= 100;
    const corruption = () => new Error("Secure credential storage is corrupted. Use Recover saved connection to preserve a backup and reconnect.");
    async function location() {
        const { app } = await import("electron");
        return join(app.getPath("userData"), "NitroSniper", "bot-credentials.json");
    }
    async function secureStorage() {
        const { safeStorage } = await import("electron");
        if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === "basic_text") {
            throw new Error("Secure token storage is unavailable. Enable your system keyring and restart Discord.");
        }
        return safeStorage;
    }
    async function storage() {
        const path = await location();
        if (!saved) {
            try {
                const data = JSON.parse(await readBounded(path));
                if (!validOuter(data) || !Object.entries(data).every(([id, value]) => validUser(id) && validRecord(value))) throw corruption();
                saved = data;
            } catch (error: any) {
                if (error?.code !== "ENOENT") throw corruption();
                saved = {};
            }
        }
        return path;
    }
    async function commit(path: string, next: Record<string, { encrypted: string; }>) {
        if (Object.keys(next).length > 100) throw new Error("Too many saved bot connections. Disconnect an unused account first.");
        try { await atomicJson(path, next); saved = next; }
        catch { throw new Error("Could not save the bot connection. Try again."); }
    }
    return {
        async get(userId) {
            await storage();
            const safeStorage = await secureStorage();
            const record = saved![userId];
            if (!record) return null;
            try {
                const value = JSON.parse(safeStorage.decryptString(Buffer.from(record.encrypted, "base64")));
                if (typeof value?.token !== "string" || typeof value.credentialId !== "string" || !validUser(value.botId) || typeof value.botName !== "string") throw new Error();
                return value;
            } catch { throw corruption(); }
        },
        async set(userId, value) {
            const path = await storage(), safeStorage = await secureStorage();
            await commit(path, { ...saved, [userId]: { encrypted: safeStorage.encryptString(JSON.stringify(value)).toString("base64") } });
        },
        async remove(userId) {
            const path = await storage(); const next = { ...saved }; delete next[userId]; await commit(path, next);
        },
        async recover(userId) {
            if (!validUser(userId)) throw new Error("Sign in to Discord first.");
            const path = await location();
            const next: Record<string, { encrypted: string; }> = {};
            try {
                const data = JSON.parse(await readBounded(path));
                if (validOuter(data)) for (const [id, value] of Object.entries(data)) {
                    if (validUser(id) && validRecord(value)) next[id] = { encrypted: value.encrypted };
                }
            } catch { /* Deliberate recovery preserves the original file before creating a clean vault. */ }
            try { await quarantine(path); }
            catch (error: any) { if (error?.code !== "ENOENT") throw new Error("Could not preserve secure credential storage. Recovery did not change your saved credentials."); }
            delete next[userId];
            await commit(path, next);
        }
    };
}
export const directBot = createDirectBot(encryptedVault());
// The native module is loaded at client startup, independently of the renderer settings panel.
void directBot.startCleanup();
