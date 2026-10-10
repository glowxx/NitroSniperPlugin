import type { ClaimRequest } from "./types";

export function extractGiftCodes(content: string): string[] {
    // Match wrappers in place: stripping Markdown first could turn an attacker's URL path into a gift URL.
    const pattern = /(?:^|[\s<(])([*_~|`]*)(?:https?:\/\/)?(?:discord\.gift\/|discord(?:app)?\.com\/gifts?\/)([A-Za-z0-9]{16,24})([*_~|`]*)(?=$|[\s<>()[\]{}.,!?"'`#])/g;
    return [...new Set(Array.from(content.matchAll(pattern))
        .filter(match => match[1] === Array.from(match[3]).reverse().join(""))
        .map(match => match[2]))];
}

interface SeenClaim { time: number; attempts: number; retryAt?: number; }

function retryDelay(error: unknown): number | undefined {
    if (!error || typeof error !== "object") return;
    const { status, code, body } = error as { status?: unknown; code?: unknown; body?: { retry_after?: unknown; }; };
    // Unknown outcomes and Discord's permanent API errors remain deduplicated.
    if (typeof code === "number" || (typeof status === "number" && status >= 400 && status < 500 && status !== 429)) return;
    const transport = typeof code === "string" && ["ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "ECONNREFUSED", "EAI_AGAIN"].includes(code);
    if (!(status === 429 || (typeof status === "number" && status >= 500 && status <= 599) || transport)) return;
    const seconds = body?.retry_after;
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

    constructor(
        private redeem: (request: ClaimRequest, success: () => void, failure: (error: unknown) => void) => unknown,
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
        // Keep the lock until the old action really returns, even across account/plugin restarts.
    }
    enqueue(request: ClaimRequest): boolean {
        if (!this.active || this.pending.length >= 100) return false;
        const now = Date.now();
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
        const request = this.pending.shift();
        if (!request) return;
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
            try {
                if (this.active && claim.generation === this.generation) {
                    const delay = success ? undefined : retryDelay(error);
                    if (delay !== undefined && entry.attempts < 3) entry.retryAt = Date.now() + delay;
                    this.completed(request, success, error);
                }
            } finally { this.next(); }
        };
        this.armWarning(claim);
        try {
            const result = this.redeem(request, () => finish(true), error => finish(false, error));
            void Promise.resolve(result).catch(error => finish(false, error));
        } catch (error) { finish(false, error); }
    }
}
