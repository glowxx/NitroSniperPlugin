import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const snowflake = /^\d{17,20}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const DAY = 86_400_000;
const TEST_LIFETIME = 30_000;
const CLEANUP_LIMIT = 10_000;
export class ServiceError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

export function validateEvent(body, now = Date.now()) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ServiceError(400, 'Invalid event.');
    if (typeof body.eventId !== 'string' || typeof body.discordUserId !== 'string' || typeof body.occurredAt !== 'string'
        || !/^[A-Za-z0-9_-]{16,80}$/.test(body.eventId) || !snowflake.test(body.discordUserId)
        || !['claimed', 'test'].includes(body.kind)) throw new ServiceError(400, 'Invalid event identity.');
    const time = Date.parse(body.occurredAt);
    if (!Number.isFinite(time) || now - time > DAY || time - now > 300_000) throw new ServiceError(400, 'Event timestamp is outside the 24-hour delivery window.');
    if (body.giftType !== undefined && (typeof body.giftType !== 'string' || body.giftType.length > 200)) throw new ServiceError(400, 'Invalid gift type.');
    for (const field of ['guildId', 'channelId', 'messageId']) {
        if (body[field] !== undefined && (typeof body[field] !== 'string' || !snowflake.test(body[field]))) throw new ServiceError(400, `Invalid ${field}.`);
    }
    // Whitelist fields; never store tokens, gift codes, arbitrary embeds or recipient overrides.
    const clean = Object.fromEntries(['eventId', 'kind', 'discordUserId', 'occurredAt', 'giftType', 'guildId', 'channelId', 'messageId']
        .filter(key => body[key] !== undefined).map(key => [key, body[key]]));
    clean.occurredAt = new Date(time).toISOString();
    return clean;
}

export function buildMessage(event) {
    const escape = value => value.replace(/[\\`*_{}[\]()#+.!|>~\-]/g, '\\$&');
    const fields = [];
    if (event.giftType) fields.push({ name: 'Gift', value: escape(event.giftType), inline: true });
    if (event.channelId && event.messageId) fields.push({ name: 'Source', value: `[Open message](https://discord.com/channels/${event.guildId ?? '@me'}/${event.channelId}/${event.messageId})` });
    return {
        embeds: [{ title: event.kind === 'test' ? 'Notifications connected' : 'Nitro successfully claimed',
            description: event.kind === 'test' ? 'Your NitroSniper DM notifications are working.' : 'Your Discord client reported a successful redemption.',
            color: event.kind === 'test' ? 0x5865f2 : 0x43b581, fields,
            timestamp: event.occurredAt, footer: { text: 'NitroSniper • DM notifications' } }],
        allowedMentions: { parse: [] },
        nonce: hash(`${event.kind === 'test' ? 'test:' : ''}${event.discordUserId}:${event.eventId}`).slice(0, 24),
        enforceNonce: true
    };
}

export class NotificationService {
    constructor({ database = 'bot/data/notifications.sqlite', sendDM, deleteTestDM, botId = () => undefined, now = Date.now, onLeaseLost = () => {} }) {
        if (database !== ':memory:') mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(database);
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS links(user_id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, linked_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS events(user_id TEXT NOT NULL, event_id TEXT NOT NULL, payload TEXT NOT NULL,
                state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT,
                PRIMARY KEY(user_id,event_id));
            CREATE INDEX IF NOT EXISTS delivery_due ON events(state,next_at);
            CREATE INDEX IF NOT EXISTS ingestion_recent ON events(user_id,created_at);
            CREATE INDEX IF NOT EXISTS status_latest ON events(user_id,updated_at DESC);
            CREATE TABLE IF NOT EXISTS worker_lease(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,expires_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS test_cleanups(user_id TEXT NOT NULL,event_id TEXT NOT NULL,bot_id TEXT NOT NULL,
                channel_id TEXT NOT NULL,message_id TEXT NOT NULL,delete_at INTEGER NOT NULL,next_at INTEGER NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,error TEXT,PRIMARY KEY(user_id,event_id),UNIQUE(bot_id,channel_id,message_id));
            CREATE INDEX IF NOT EXISTS cleanup_due ON test_cleanups(next_at);
            CREATE TABLE IF NOT EXISTS cleanup_backoff(bot_id TEXT PRIMARY KEY,next_at INTEGER NOT NULL);
            CREATE TRIGGER IF NOT EXISTS cleanup_capacity BEFORE INSERT ON test_cleanups
                WHEN (SELECT count(*) FROM test_cleanups)>=10000 OR
                     (SELECT count(*) FROM test_cleanups WHERE user_id=NEW.user_id)>=100
                BEGIN SELECT RAISE(ABORT,'Test cleanup queue is full'); END;`);
        this.owner = randomBytes(24).toString('hex');
        const acquired = this.db.prepare(`INSERT INTO worker_lease VALUES(1,?,?)
            ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
            WHERE worker_lease.expires_at<=?`).run(this.owner, Date.now() + 60_000, Date.now());
        if (!acquired.changes) {
            this.db.close();
            throw new Error('Another notification bot owns this database. Stop it, or wait up to 60 seconds after a crash.');
        }
        this.onLeaseLost = onLeaseLost;
        this.leaseTimer = setInterval(() => {
            try {
                const renewed = this.db.prepare('UPDATE worker_lease SET expires_at=? WHERE id=1 AND owner=?').run(Date.now() + 60_000, this.owner);
                if (!renewed.changes) this.loseLease();
            } catch { this.loseLease(); }
        }, 5000);
        this.leaseTimer.unref();
        this.sendDM = sendDM;
        this.deleteTestDM = deleteTestDM;
        this.botId = botId;
        this.now = now;
        this.busy = false;
        this.closed = false;
        this.lastPrune = 0;
        // Validate persisted metadata even when a broken timestamp would never become due.
        for (const job of this.db.prepare('SELECT rowid,* FROM test_cleanups').iterate()) {
            if (!this.#validCleanup(job)) this.db.prepare('DELETE FROM test_cleanups WHERE rowid=?').run(job.rowid);
        }
    }
    loseLease() {
        if (this.stopping || this.closed) return;
        this.stop();
        this.onLeaseLost();
    }
    ownsLease() {
        return !this.closed && this.db.prepare('SELECT owner FROM worker_lease WHERE id=1').get()?.owner === this.owner;
    }
    ensureOwner() {
        if (this.closed || this.stopping) throw new ServiceError(503, 'Notification bot is stopping.');
        if (!this.ownsLease()) { this.loseLease(); throw new ServiceError(503, 'Notification database ownership changed.'); }
    }
    prepareLink(userId) {
        this.ensureOwner();
        if (typeof userId !== 'string' || !snowflake.test(userId)) throw new ServiceError(400, 'Invalid account.');
        return randomBytes(32).toString('base64url');
    }
    activateLink(userId, token) {
        this.ensureOwner();
        if (typeof userId !== 'string' || !snowflake.test(userId) || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ServiceError(400, 'Invalid link.');
        this.db.prepare('INSERT INTO links VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash,linked_at=excluded.linked_at')
            .run(userId, hash(token), this.now());
    }
    link(userId) {
        const token = this.prepareLink(userId);
        this.activateLink(userId, token);
        return token;
    }
    disconnect(userId) {
        this.ensureOwner();
        try {
            // Revoke the key and cancel its backlog together; a partial write must not survive relinking.
            this.db.exec('BEGIN IMMEDIATE');
            try {
                this.db.prepare('DELETE FROM links WHERE user_id=?').run(userId);
                this.db.prepare("UPDATE events SET state='cancelled',error='Disconnected',updated_at=? WHERE user_id=? AND state='queued'").run(this.now(), userId);
                this.db.exec('COMMIT');
            } catch (error) {
                this.db.exec('ROLLBACK');
                throw error;
            }
        } catch {
            throw new ServiceError(503, 'Could not disconnect notifications. Your key may still be active; retry /notifications disconnect.');
        } finally {
            // Honour the user's cancellation request even when persistence fails.
            if (this.delivery?.userId === userId) this.delivery.controller.abort();
        }
    }
    authenticate(token, userId) {
        this.ensureOwner();
        if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ServiceError(401, 'Run /notifications link and paste the new key in the plugin.');
        const link = this.db.prepare('SELECT user_id FROM links WHERE token_hash=?').get(hash(token));
        if (!link) throw new ServiceError(401, 'Notification key expired or revoked. Run /notifications link again.');
        if (link.user_id !== userId) throw new ServiceError(403, 'This key belongs to a different Discord account.');
        return link;
    }
    status(userId) {
        const linked = !!this.db.prepare('SELECT 1 FROM links WHERE user_id=?').get(userId);
        const pending = this.db.prepare("SELECT count(*) AS count FROM events WHERE user_id=? AND state='queued'").get(userId).count;
        const latest = this.db.prepare('SELECT state,updated_at AS updatedAt,error FROM events WHERE user_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 1').get(userId) ?? null;
        const cleanup = this.db.prepare('SELECT count(*) AS pending,MAX(error) AS error FROM test_cleanups WHERE user_id=?').get(userId);
        return { linked, pending, latest, cleanup };
    }
    enqueue(body, token) {
        const event = validateEvent(body, this.now());
        this.authenticate(token, event.discordUserId);
        return this.enqueueForUser(event);
    }
    // Internal use only, after a verified Discord interaction. Not exposed by HTTP.
    enqueueForUser(body) {
        this.ensureOwner();
        const event = validateEvent(body, this.now());
        if (!this.status(event.discordUserId).linked) throw new ServiceError(403, 'Run /notifications link first.');
        const existing = this.db.prepare('SELECT state FROM events WHERE user_id=? AND event_id=?').get(event.discordUserId, event.eventId);
        if (existing) return { accepted: true, duplicate: true, state: existing.state };
        if (event.kind === 'test') {
            // Reserve capacity for every queued test before sending anything to Discord.
            const capacity = this.db.prepare(`SELECT (SELECT count(*) FROM test_cleanups) +
                (SELECT count(*) FROM events WHERE state='queued' AND json_valid(payload) AND json_extract(payload,'$.kind')='test') AS total,
                (SELECT count(*) FROM test_cleanups WHERE user_id=?) +
                (SELECT count(*) FROM events WHERE user_id=? AND state='queued' AND json_valid(payload) AND json_extract(payload,'$.kind')='test') AS account`).get(event.discordUserId, event.discordUserId);
            // A revoked in-flight test can still return a successful SDK receipt.
            const revokedDelivery = this.delivery?.test && this.db.prepare('SELECT state FROM events WHERE user_id=? AND event_id=?')
                .get(this.delivery.userId, this.delivery.eventId)?.state !== 'queued';
            if (capacity.total + Number(!!revokedDelivery) >= CLEANUP_LIMIT
                || capacity.account + Number(!!revokedDelivery && this.delivery.userId === event.discordUserId) >= 100)
                throw new ServiceError(429, 'Test cleanup queue is full. Retry after pending test messages are removed.');
        }
        const userQueued = this.status(event.discordUserId).pending;
        const totalQueued = this.db.prepare("SELECT count(*) AS count FROM events WHERE state='queued'").get().count;
        if (userQueued >= 100 || totalQueued >= 10_000) throw new ServiceError(429, 'Notification queue is full. Retry later.');
        const recent = this.db.prepare('SELECT count(*) AS count FROM events WHERE user_id=? AND created_at>?').get(event.discordUserId, this.now() - 60_000).count;
        if (recent >= 10) throw new ServiceError(429, 'Too many notifications. Retry in a minute.');
        this.db.prepare('INSERT INTO events(user_id,event_id,payload,next_at,created_at,updated_at) VALUES(?,?,?,?,?,?)')
            .run(event.discordUserId, event.eventId, JSON.stringify(event), this.now(), this.now(), this.now());
        return { accepted: true, duplicate: false, state: 'queued' };
    }
    async deliverDue() {
        if (this.busy || this.closed || this.stopping) return;
        if (!this.ownsLease()) { this.loseLease(); return; }
        this.busy = true;
        try {
            if (this.deleteTestDM) await this.#cleanupDue();
            const now = this.now();
            if (now - this.lastPrune >= 60_000) {
                this.db.prepare("UPDATE events SET state='failed',error='Delivery window expired',updated_at=? WHERE state='queued' AND json_extract(payload,'$.occurredAt')<?").run(now, new Date(now - DAY).toISOString());
                this.db.prepare("DELETE FROM events WHERE state!='queued' AND updated_at<?").run(now - 7 * DAY);
                this.lastPrune = now;
            }
            const events = this.db.prepare("SELECT * FROM events WHERE state='queued' AND next_at<=? ORDER BY next_at LIMIT 20").all(now);
            for (const row of events) {
                if (this.closed || this.stopping || !this.ownsLease()) break;
                const payload = JSON.parse(row.payload);
                if (this.now() - Date.parse(payload.occurredAt) >= DAY) {
                    this.db.prepare("UPDATE events SET state='failed',error='Delivery window expired',updated_at=? WHERE user_id=? AND event_id=? AND state='queued'")
                        .run(this.now(), row.user_id, row.event_id);
                    continue;
                }
                const canSend = () => !this.closed && !this.stopping && this.ownsLease() && this.status(row.user_id).linked
                    && this.now() - Date.parse(payload.occurredAt) < DAY
                    && this.db.prepare('SELECT state FROM events WHERE user_id=? AND event_id=?').get(row.user_id, row.event_id)?.state === 'queued';
                if (!canSend()) continue;
                let state = 'delivered', error = null, nextAt = now, testCreated = false;
                const controller = new AbortController();
                this.delivery = { userId: row.user_id, eventId: row.event_id, test: payload.kind === 'test', controller };
                const deadline = setTimeout(() => controller.abort(), Math.max(1, DAY - (this.now() - Date.parse(payload.occurredAt))));
                deadline.unref();
                try {
                    const receipt = await this.sendDM(row.user_id, buildMessage(payload), canSend, controller.signal, payload.kind);
                    if (receipt === false) continue;
                    if (!this.ownsLease()) { this.loseLease(); break; }
                    if (payload.kind === 'test') {
                        testCreated = true;
                        this.#recordTestDelivery(row, receipt);
                    }
                }
                catch (err) {
                    const permanent = [50007, 50278, 50013, 10013, 50035].includes(Number(err?.code));
                    state = permanent ? 'failed' : 'queued';
                    error = [50007, 50278].includes(Number(err?.code)) ? 'Discord cannot deliver this DM. Allow DMs, unblock the bot, then send a new test.'
                        : permanent ? 'Discord rejected this notification. Check the account and bot permissions.'
                        : 'Discord delivery temporarily unavailable.';
                    if (testCreated) error = 'The test DM was sent, but automatic deletion could not be saved. Delete this test manually if cleanup cannot recover.';
                    if ([50007, 50278, 10013].includes(Number(err?.code))) {
                        this.db.prepare("UPDATE events SET state='failed',error=?,updated_at=? WHERE user_id=? AND state='queued'")
                            .run(error, this.now(), row.user_id);
                    }
                    nextAt = this.now() + Math.min(300_000, 5000 * 2 ** Math.min(row.attempts, 6));
                }
                finally {
                    clearTimeout(deadline);
                    this.delivery = undefined;
                }
                // A disconnect during an in-flight request must not resurrect cancelled jobs.
                this.db.prepare("UPDATE events SET state=?,error=?,attempts=attempts+1,next_at=?,updated_at=? WHERE user_id=? AND event_id=? AND state='queued'")
                    .run(state, error, nextAt, this.now(), row.user_id, row.event_id);
            }
        } finally { this.busy = false; }
    }
    #recordTestDelivery(row, receipt) {
        const now = this.now();
        if (!receipt || ![receipt.channelId, receipt.messageId, receipt.botId].every(id => typeof id === 'string' && snowflake.test(id))
            || receipt.botId !== this.botId()) {
            throw new Error('Discord test delivery identity unavailable.');
        }
        // Persist the SDK receipt and completion atomically; a replay uses the same nonce.
        this.db.exec('BEGIN IMMEDIATE');
        try {
            // Local successful delivery completion is authoritative, never an embed/server timestamp.
            const deleteAt = now + TEST_LIFETIME;
            this.db.prepare(`INSERT INTO test_cleanups(user_id,event_id,bot_id,channel_id,message_id,delete_at,next_at)
                VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`).run(row.user_id, row.event_id, receipt.botId, receipt.channelId, receipt.messageId, deleteAt, deleteAt);
            this.db.prepare("UPDATE events SET state='delivered',error=NULL,updated_at=? WHERE user_id=? AND event_id=? AND state='queued'")
                .run(now, row.user_id, row.event_id);
            this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    #validCleanup(job) {
        return [job.user_id, job.bot_id, job.channel_id, job.message_id].every(id => typeof id === 'string' && snowflake.test(id)
                && BigInt(id) <= 18_446_744_073_709_551_615n)
            && typeof job.event_id === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(job.event_id)
            && Number.isSafeInteger(job.delete_at) && job.delete_at >= 0 && job.delete_at <= 8_640_000_000_000_000
            && Number.isSafeInteger(job.next_at) && job.next_at >= 0 && job.next_at <= 8_640_000_000_000_000
            && Number.isSafeInteger(job.attempts) && job.attempts >= 0 && job.attempts <= 1_000_000;
    }
    async #cleanupDue() {
        const jobs = this.db.prepare('SELECT rowid,* FROM test_cleanups WHERE next_at<=? ORDER BY next_at LIMIT 20').all(this.now());
        for (const job of jobs) {
            if (this.closed || this.stopping || !this.ownsLease()) break;
            if (!this.#validCleanup(job)) {
                this.db.prepare('DELETE FROM test_cleanups WHERE rowid=?').run(job.rowid);
                continue;
            }
            if (job.delete_at > this.now()) {
                this.db.prepare('UPDATE test_cleanups SET next_at=delete_at WHERE rowid=?').run(job.rowid);
                continue;
            }
            if (job.bot_id !== this.botId()) {
                this.db.prepare('UPDATE test_cleanups SET next_at=?,error=? WHERE rowid=?')
                    .run(this.now() + 3_600_000, 'Original bot credential is unavailable. Restore the same bot to remove this test message.', job.rowid);
                continue;
            }
            const backoff = this.db.prepare('SELECT next_at FROM cleanup_backoff WHERE bot_id=?').get(job.bot_id)?.next_at;
            if (Number.isSafeInteger(backoff) && backoff > this.now()) {
                this.db.prepare('UPDATE test_cleanups SET next_at=? WHERE rowid=?').run(Math.max(job.delete_at, backoff), job.rowid);
                continue;
            }
            const controller = new AbortController();
            this.cleanup = controller;
            const timer = setTimeout(() => controller.abort(), 15_000);
            timer.unref();
            let complete = false, nextAt, error, botBackoff = false;
            try {
                const canDelete = () => !this.closed && !this.stopping && this.ownsLease() && job.bot_id === this.botId() && job.delete_at <= this.now();
                if (await this.deleteTestDM(job, canDelete, controller.signal) === false) continue;
                complete = true;
            } catch (err) {
                const status = Number(err?.status), code = Number(err?.code);
                complete = status === 404 || code === 10008;
                const permanent = [400, 401, 403].includes(status) || [50001, 50013].includes(code);
                const retryAfter = Number(err?.rawError?.retry_after ?? err?.retry_after);
                const delay = status === 429 && Number.isFinite(retryAfter) && retryAfter > 0
                    ? Math.max(1000, Math.ceil(Math.min(retryAfter, 86_400) * 1000))
                    : permanent ? 3_600_000 : Math.min(300_000, 5000 * 2 ** Math.min(job.attempts, 6));
                nextAt = this.now() + delay;
                error = permanent ? 'Discord denied test cleanup. Restore the original bot credential and permissions.' : 'Test cleanup temporarily unavailable.';
                botBackoff = status === 429 || permanent;
            } finally { clearTimeout(timer); this.cleanup = undefined; }
            if (!this.ownsLease()) { this.loseLease(); break; }
            if (botBackoff) {
                // One bot-wide gate survives restart and prevents a queue of failures from hammering Discord.
                this.db.prepare('INSERT INTO cleanup_backoff VALUES(?,?) ON CONFLICT(bot_id) DO UPDATE SET next_at=excluded.next_at').run(job.bot_id, nextAt);
            }
            if (complete) this.db.prepare('DELETE FROM test_cleanups WHERE rowid=?').run(job.rowid);
            else this.db.prepare('UPDATE test_cleanups SET next_at=?,attempts=MIN(attempts+1,1000000),error=? WHERE rowid=?').run(nextAt, error, job.rowid);
        }
        if (!this.closed && this.ownsLease()) this.db.prepare('DELETE FROM cleanup_backoff WHERE bot_id NOT IN (SELECT bot_id FROM test_cleanups)').run();
    }
    stop() { this.stopping = true; this.delivery?.controller.abort(); this.cleanup?.abort(); }
    close() {
        if (this.busy) throw new Error('Wait for the delivery worker before closing the database.');
        if (this.closed) return;
        clearInterval(this.leaseTimer);
        try { this.db.prepare('DELETE FROM worker_lease WHERE id=1 AND owner=?').run(this.owner); }
        finally { this.closed = true; this.db.close(); }
    }
}

export function createApi(service, { ready = () => true } = {}) {
    const server = createServer(async (req, res) => {
        const reply = (status, body) => {
            res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(status === 429 ? { 'retry-after': '60' } : {}) });
            res.end(JSON.stringify(body));
        };
        try {
            const url = new URL(req.url, 'http://localhost');
            if (req.method === 'GET' && url.pathname === '/health') return reply(ready() ? 200 : 503, { ready: ready() });
            if (!ready()) throw new ServiceError(503, 'Notification bot is offline. Retry shortly.');
            const token = req.headers.authorization?.replace(/^Bearer /, '');
            if (req.method === 'GET' && url.pathname === '/v1/status') {
                const userId = url.searchParams.get('discordUserId');
                service.authenticate(token, userId);
                return reply(200, service.status(userId));
            }
            if (req.method !== 'POST' || url.pathname !== '/v1/events') return reply(404, { error: 'Unknown route.' });
            if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new ServiceError(415, 'Use application/json.');
            // Validate credentials before reading attacker-controlled bodies.
            if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)
                || !service.db.prepare('SELECT 1 FROM links WHERE token_hash=?').get(hash(token))) throw new ServiceError(401, 'Invalid notification key.');
            let size = 0;
            const chunks = [];
            for await (const chunk of req) {
                size += chunk.length;
                if (size > 8192) throw new ServiceError(413, 'Event is too large.');
                chunks.push(chunk);
            }
            let body;
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ServiceError(400, 'Invalid JSON.'); }
            reply(202, service.enqueue(body, token));
        } catch (err) {
            if (!res.headersSent && !res.destroyed) reply(err.status ?? 500, { error: err.status ? err.message : 'Notification service error. Retry later.' });
        }
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.timeout = 15_000;
    return server;
}
