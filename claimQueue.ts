import type { ClaimRequest } from "./types";

export function extractGiftCodes(content: string): string[] {
    const codes = new Set<string>();
    // Keep a complete whitespace-delimited candidate, including any nested URL in its path/query.
    // U+FEFF is JavaScript whitespace but an invisible URL modification, not a candidate boundary.
    for (const token of content.match(/(?:\S|\uFEFF)+/g) ?? []) {
        let candidate = token.replace(/[.,!?]+$/, "");
        // Strip only paired OUTER formatting; never search inside an unrelated URL or malformed wrapper.
        const closing: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">", '"': '"', "'": "'", "*": "*", "_": "_", "~": "~", "|": "|", "`": "`" };
        while (candidate.length > 1 && closing[candidate[0]] === candidate.at(-1)) candidate = candidate.slice(1, -1);
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

    constructor(
        private redeem: (request: ClaimRequest, success: () => void, failure: (error: unknown) => void) => PromiseLike<unknown> | void,
        private completed: (request: ClaimRequest, success: boolean, error?: unknown) => void,
        private stalled: () => void,
        private timeoutMs = 120_000
    ) { }

    private identity(request: ClaimRequest) { return `${request.claimantId ?? ""}:${request.code}`; }
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
        clearTimeout(this.wakeup);
        this.wakeup = undefined;
        // Keep the lock until the old action really returns, even across account/plugin restarts.
    }
    enqueue(request: ClaimRequest): boolean {
        if (!this.active || this.pending.length >= 100) return false;
        const now = Date.now();
        for (const [account, deadline] of this.cooldowns) if (deadline <= now) this.cooldowns.delete(account);
        if (this.cooldowns.size >= 5000 && !this.cooldowns.has(request.claimantId ?? "")) return false;
        const protectedKeys = new Set(this.pending.map(item => this.identity(item)));
        if (this.dispatched) protectedKeys.add(this.identity(this.dispatched.request));
        for (const [key, entry] of this.seen) if (now - entry.time > 86_400_000 && !protectedKeys.has(key)) this.seen.delete(key);
        const key = this.identity(request);
        const previous = this.seen.get(key);
        if (previous && (protectedKeys.has(key) || previous.retryAt === undefined || now < previous.retryAt || previous.attempts >= 3)) return false;
        if (!previous && this.seen.size >= 5000) {
            const oldest = Array.from(this.seen.keys()).find(item => !protectedKeys.has(item));
            if (oldest) this.seen.delete(oldest);
        }
        if (!previous) this.seen.set(key, { time: now, attempts: 0 });
        this.pending.push(request);
        this.next();
        return true;
    }
    private armWarning(claim: DispatchedClaim) {
        clearTimeout(claim.timer);
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
            const { generation } = this;
            const timer = setTimeout(() => {
                if (this.wakeup !== timer || !this.active || generation !== this.generation || this.pending[0] !== request) return;
                this.wakeup = undefined;
                this.next();
            }, delay);
            this.wakeup = timer;
            return;
        }
        this.pending.shift();
        const entry = this.seen.get(this.identity(request))!;
        entry.attempts++;
        entry.retryAt = undefined;
        entry.time = Date.now();
        const claim: DispatchedClaim = { request, generation: this.generation, dispatchedAt: Date.now() };
        this.dispatched = claim;
        const finish = (success: boolean, error?: unknown) => {
            if (this.dispatched !== claim) return;
            clearTimeout(claim.timer);
            this.dispatched = undefined;
            const delay = success ? undefined : retryDelay(error);
            // BillingError retains status/retryAfter, but no trustworthy bucket/scope headers.
            // A late result still applies to the account that dispatched it, even after stop/switch.
            if (delay !== undefined && (error as { status?: unknown; })?.status === 429) {
                const account = request.claimantId ?? "";
                this.cooldowns.set(account, Math.max(this.cooldowns.get(account) ?? 0, Date.now() + delay));
            }
            try {
                if (this.active && claim.generation === this.generation) {
                    if (delay !== undefined && entry.attempts < 3) entry.retryAt = Date.now() + delay;
                    this.completed(request, success, error);
                }
            } finally { this.next(); }
        };
        this.armWarning(claim);
        try {
            const result = this.redeem(request, () => finish(true), error => finish(false, error));
            // Callback-only adapters must keep the lock; Discord's Promise resolves after redemption succeeds.
            if (result && typeof result.then === "function") {
                void Promise.resolve(result).then(() => finish(true), error => finish(false, error));
            }
        } catch (error) { finish(false, error); }
    }
}
