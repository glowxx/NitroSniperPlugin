import { type DiagnosticContext, diagnosticError, type DiagnosticEvent, type DiagnosticFields, type DiagnosticObserver } from "./diagnosticProtocol";
import type { ClaimRequest } from "./types";

function closingBracket(text: string, start: number, open: string, close: string): number {
    let depth = 0;
    for (let index = start; index < text.length; index++) {
        if (text[index] === "\\") { index++; continue; }
        if (text[index] === open) depth++;
        else if (text[index] === close && --depth === 0) return index;
    }
    return -1;
}
function maskedLink(text: string, start = 0) {
    if (text[start] !== "[") return;
    const labelEnd = closingBracket(text, start, "[", "]");
    if (labelEnd < 0 || text[labelEnd + 1] !== "(") return;
    const destinationEnd = closingBracket(text, labelEnd + 1, "(", ")");
    return { destination: text.slice(labelEnd + 2, destinationEnd < 0 ? text.length : destinationEnd),
        end: destinationEnd < 0 ? text.length : destinationEnd + 1, closed: destinationEnd >= 0 };
}
function* giftCandidates(content: string) {
    const whitespace = (char: string) => char !== "\uFEFF" && /\s/.test(char);
    for (let index = 0; index < content.length;) {
        if (whitespace(content[index])) { index++; continue; }
        const start = index;
        while (index < content.length && !whitespace(content[index])) {
            // Keep labels/destinations together, even inside hostile outer URLs; never emit their substrings.
            const link = content[index] === "[" ? maskedLink(content, index) : undefined;
            index = link ? link.end : index + 1;
        }
        yield content.slice(start, index);
    }
}

export function extractGiftCodes(content: string): string[] {
    const codes = new Set<string>();
    // Keep complete candidates, including any nested URL in their path/query or Markdown label.
    // U+FEFF is JavaScript whitespace but an invisible URL modification, not a candidate boundary.
    for (const token of giftCandidates(content)) {
        let candidate = token.replace(/[.,!?]+$/, "");
        // Strip only paired OUTER formatting; never search inside an unrelated URL or malformed wrapper.
        const closing: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">", '"': '"', "'": "'", "*": "*", "_": "_", "~": "~", "|": "|", "`": "`" };
        while (candidate.length > 1 && closing[candidate[0]] === candidate.at(-1)) candidate = candidate.slice(1, -1);
        if (candidate.startsWith("[")) {
            const link = maskedLink(candidate);
            if (!link?.closed || link.end !== candidate.length) continue;
            // The visible label is never a URL. Only an absolute HTTP(S) destination can identify a gift host.
            candidate = link.destination.replace(/^[ \t]+|[ \t]+$/g, "");
            if (!/^https?:\/\//i.test(candidate)) continue;
        }
        // Validate the raw spelling before URL normalization (userinfo, Unicode, backslashes, dot segments).
        if (/[^\x21-\x7e]/.test(candidate)) continue;
        const match = /^(https?:\/\/)?(discord\.gift|discord(?:app)?\.com)(\/[^?#]*)(?:\?[^#]*)?(?:#.*)?$/i.exec(candidate);
        if (!match) continue;
        const path = match[2].toLowerCase() === "discord.gift" ? /^\/([A-Za-z0-9]{16,24})$/ : /^\/gifts?\/([A-Za-z0-9]{16,24})$/;
        const code = path.exec(match[3])?.[1];
        if (!code) continue;
        try {
            const url = new URL(match[1] ? candidate : `https://${candidate}`);
            if (url.hostname.toLowerCase() === match[2].toLowerCase() && url.pathname === match[3] && !url.username && !url.password) codes.add(code);
        } catch { /* Invalid complete URL. */ }
    }
    return [...codes];
}

interface SeenClaim { time: number; attempts: number; retryAt?: number; }

function retryDelay(error: unknown): number | undefined {
    if (!error || typeof error !== "object") return;
    const { status, code, retryAfter, body } = error as { status?: unknown; code?: unknown; retryAfter?: unknown; body?: { retry_after?: unknown; }; };
    // Unknown outcomes and Discord's permanent API errors remain deduplicated.
    if (typeof status === "number" && status >= 400 && status < 500 && status !== 429) return;
    const transport = typeof code === "string" && ["ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "ECONNREFUSED", "EAI_AGAIN"].includes(code);
    if (!(status === 429 || (typeof status === "number" && status >= 500 && status <= 599) || transport)) return;
    // Discord's BillingError.retryAfter and HTTP response body.retry_after are both seconds.
    const seconds = typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : body?.retry_after;
    return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
        ? Math.max(5000, Math.min(86_400_000, seconds * 1000)) : 5000;
}

interface DispatchedClaim {
    request: ClaimRequest;
    generation: number;
    dispatchedAt: number;
    timer?: ReturnType<typeof setTimeout>;
    checkpoints?: ReturnType<typeof setTimeout>[];
    reported?: Set<number>;
}

/** Serial claims. Stopping cannot cancel a gift action already dispatched to Discord. */
export class ClaimQueue {
    private pending: ClaimRequest[] = [];
    private seen = new Map<string, SeenClaim>();
    private active = false;
    private generation = 0;
    private dispatched?: DispatchedClaim;
    private cooldowns = new Map<string, number>();
    private wakeup?: ReturnType<typeof setTimeout>;
    private diagnosticIds = new WeakMap<ClaimRequest, DiagnosticContext>();
    private diagnosticCounter = 0;
    private cooldownWait?: { request: ClaimRequest; deadline: number; };
    private lastOverflowLog = -Infinity;

    constructor(
        private redeem: (request: ClaimRequest, success: () => void, failure: (error: unknown) => void) => PromiseLike<unknown> | void,
        private completed: (request: ClaimRequest, success: boolean, error?: unknown) => void,
        private stalled: () => void,
        private timeoutMs = 120_000,
        private diagnostics?: DiagnosticObserver
    ) { }

    private identity(request: ClaimRequest) { return `${request.claimantId ?? ""}:${request.code}`; }
    private log(event: DiagnosticEvent, request?: ClaimRequest, fields: DiagnosticFields = {}) {
        try {
            if (!this.diagnostics) return;
            if (request && !this.diagnosticIds.has(request)) this.diagnosticIds.set(request, { ...this.diagnostics.context(), claim: ++this.diagnosticCounter });
            this.diagnostics.record(event, { pending: this.pending.length, active: !!this.dispatched, ...fields }, request ? this.diagnosticIds.get(request) : undefined);
        } catch { /* Diagnostics must never change redemption behavior. */ }
    }
    private reject(request: ClaimRequest, reason: string): false {
        this.log("claim_rejected_from_queue", request, { reason }); return false;
    }
    get diagnosticState(): { context?: DiagnosticContext; fields: DiagnosticFields; } {
        const claim = this.dispatched;
        return { context: claim ? this.diagnosticIds.get(claim.request) : undefined,
            fields: { active: !!claim, pending: this.pending.length,
                ...(claim ? { elapsedMs: Math.max(0, Date.now() - claim.dispatchedAt), cooldownMs: Math.max(0, (this.cooldowns.get(claim.request.claimantId ?? "") ?? 0) - Date.now()) } : {}) } };
    }
    get pendingCount() { return this.pending.length; }
    start() {
        this.stop();
        this.active = true;
        if (this.dispatched) this.armWarning(this.dispatched);
        this.next();
    }
    stop() {
        this.active = false;
        this.generation++;
        // Discarded work was never dispatched and must not stay marked as attempted.
        for (const request of this.pending) {
            const key = this.identity(request);
            if (this.seen.get(key)?.attempts === 0) this.seen.delete(key);
        }
        this.pending = [];
        clearTimeout(this.dispatched?.timer);
        this.dispatched?.checkpoints?.forEach(clearTimeout);
        clearTimeout(this.wakeup);
        this.wakeup = undefined;
        this.cooldownWait = undefined;
        // Keep the lock until the old action really returns, even across account/plugin restarts.
    }
    enqueue(request: ClaimRequest): boolean {
        this.log("gift_detected", request);
        if (!this.active) return this.reject(request, "inactive");
        if (this.pending.length >= 100) {
            if (Date.now() - this.lastOverflowLog >= 10_000) { this.lastOverflowLog = Date.now(); this.log("queue_overflow", request); }
            return this.reject(request, "queue_full");
        }
        const now = Date.now();
        for (const [account, deadline] of this.cooldowns) if (deadline <= now) this.cooldowns.delete(account);
        if (this.cooldowns.size >= 5000 && !this.cooldowns.has(request.claimantId ?? "")) return this.reject(request, "cooldown_capacity");
        const protectedKeys = new Set(this.pending.map(item => this.identity(item)));
        if (this.dispatched) protectedKeys.add(this.identity(this.dispatched.request));
        for (const [key, entry] of this.seen) if (now - entry.time > 86_400_000 && !protectedKeys.has(key)) this.seen.delete(key);
        const key = this.identity(request);
        const previous = this.seen.get(key);
        if (previous && (protectedKeys.has(key) || previous.retryAt === undefined || now < previous.retryAt || previous.attempts >= 3)) {
            return this.reject(request, protectedKeys.has(key) ? "duplicate" : previous.retryAt === undefined ? "already_seen" : now < previous.retryAt ? "retry_wait" : "attempt_limit");
        }
        if (!previous && this.seen.size >= 5000) {
            const oldest = Array.from(this.seen.keys()).find(item => !protectedKeys.has(item));
            if (oldest) this.seen.delete(oldest);
        }
        if (!previous) this.seen.set(key, { time: now, attempts: 0 });
        this.pending.push(request);
        this.log("claim_enqueued", request);
        this.next();
        return true;
    }
    private armWarning(claim: DispatchedClaim) {
        clearTimeout(claim.timer);
        claim.checkpoints?.forEach(clearTimeout);
        if (this.diagnostics) {
            claim.reported ??= new Set();
            claim.checkpoints = [15_000, 30_000, 60_000, 120_000].filter(ms => !claim.reported?.has(ms)).map(checkpointMs => setTimeout(() => {
                if (!this.active || this.dispatched !== claim) return;
                claim.reported?.add(checkpointMs);
                this.log("claim_pending_checkpoint", claim.request, { checkpointMs, elapsedMs: Math.max(0, Date.now() - claim.dispatchedAt),
                    cooldownMs: Math.max(0, (this.cooldowns.get(claim.request.claimantId ?? "") ?? 0) - Date.now()) });
            }, Math.max(1, checkpointMs - (Date.now() - claim.dispatchedAt))));
        }
        claim.timer = setTimeout(() => {
            if (this.active && this.dispatched === claim) this.stalled();
        }, Math.max(1, this.timeoutMs - (Date.now() - claim.dispatchedAt)));
    }
    private next() {
        if (!this.active || this.dispatched) return;
        clearTimeout(this.wakeup);
        this.wakeup = undefined;
        const [request] = this.pending;
        if (!request) return;
        const delay = (this.cooldowns.get(request.claimantId ?? "") ?? 0) - Date.now();
        if (delay > 0) {
            const deadline = Date.now() + delay;
            if (this.cooldownWait?.request !== request || this.cooldownWait.deadline !== deadline) {
                this.cooldownWait = { request, deadline };
                this.log("queue_waiting_for_429_cooldown", request, { cooldownMs: delay });
            }
            const { generation } = this;
            const timer = setTimeout(() => {
                if (this.wakeup !== timer || !this.active || generation !== this.generation || this.pending[0] !== request) return;
                this.wakeup = undefined;
                this.next();
            }, delay);
            this.wakeup = timer;
            return;
        }
        if (this.cooldownWait) { this.log("cooldown_finished", this.cooldownWait.request); this.cooldownWait = undefined; }
        this.pending.shift();
        const entry = this.seen.get(this.identity(request))!;
        entry.attempts++;
        entry.retryAt = undefined;
        entry.time = Date.now();
        const claim: DispatchedClaim = { request, generation: this.generation, dispatchedAt: Date.now() };
        this.dispatched = claim;
        this.log("claim_dispatched", request);
        const finish = (success: boolean, error?: unknown) => {
            if (this.dispatched !== claim) return;
            clearTimeout(claim.timer);
            claim.checkpoints?.forEach(clearTimeout);
            this.dispatched = undefined;
            const delay = success ? undefined : retryDelay(error);
            // BillingError retains status/retryAfter, but no trustworthy bucket/scope headers.
            // A late result still applies to the account that dispatched it, even after stop/switch.
            if (delay !== undefined && (error as { status?: unknown; })?.status === 429) {
                const account = request.claimantId ?? "";
                this.cooldowns.set(account, Math.max(this.cooldowns.get(account) ?? 0, Date.now() + delay));
            }
            this.log(success ? "claim_completed_success" : "claim_completed_failure", request,
                { elapsedMs: Math.max(0, Date.now() - claim.dispatchedAt), late: !this.active || claim.generation !== this.generation, ...(success ? {} : diagnosticError(error)) });
            try {
                if (this.active && claim.generation === this.generation) {
                    if (delay !== undefined && entry.attempts < 3) entry.retryAt = Date.now() + delay;
                    this.completed(request, success, error);
                }
            } finally { this.next(); }
        };
        this.armWarning(claim);
        const signals = new Set<DiagnosticEvent>();
        const signal = (event: DiagnosticEvent, error?: unknown) => {
            if (signals.has(event)) return;
            signals.add(event);
            this.log(event, request, { late: this.dispatched !== claim, elapsedMs: Math.max(0, Date.now() - claim.dispatchedAt), ...diagnosticError(error) });
        };
        try {
            const result = this.redeem(request, () => { signal("on_redeemed"); finish(true); }, error => { signal("on_error", error); finish(false, error); });
            // Callback-only adapters must keep the lock; Discord's Promise resolves after redemption succeeds.
            if (result && typeof result.then === "function") {
                void Promise.resolve(result).then(() => { signal("redeem_promise_resolved"); finish(true); }, error => { signal("redeem_promise_rejected", error); finish(false, error); });
            }
        } catch (error) { signal("redeem_threw", error); finish(false, error); }
    }
}
