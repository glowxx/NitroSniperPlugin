import type { ClaimRequest } from "./types";

export function extractGiftCodes(content: string): string[] {
    const pattern = /(?:^|[\s<(])(?:https?:\/\/)?(?:discord\.gift\/|discord(?:app)?\.com\/gifts?\/)([A-Za-z0-9]{16,24})(?=$|[\s<>()[\]{}.,!?"'`#])/g;
    return [...new Set(Array.from(content.matchAll(pattern), match => match[1]))];
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
    private seen = new Map<string, number>();
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
        for (const request of this.pending) this.seen.delete(this.identity(request));
        this.pending = [];
        clearTimeout(this.dispatched?.timer);
        // Keep the lock until the old action really returns, even across account/plugin restarts.
    }
    enqueue(request: ClaimRequest): boolean {
        if (!this.active || this.pending.length >= 100) return false;
        const now = Date.now();
        const protectedKeys = new Set(this.pending.map(item => this.identity(item)));
        if (this.dispatched) protectedKeys.add(this.identity(this.dispatched.request));
        for (const [key, time] of this.seen) if (now - time > 86_400_000 && !protectedKeys.has(key)) this.seen.delete(key);
        const key = this.identity(request);
        if (this.seen.has(key)) return false;
        if (this.seen.size >= 5000) {
            const oldest = Array.from(this.seen.keys()).find(item => !protectedKeys.has(item));
            if (oldest) this.seen.delete(oldest);
        }
        this.seen.set(key, now);
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
        const claim: DispatchedClaim = { request, generation: this.generation, dispatchedAt: Date.now() };
        this.dispatched = claim;
        const finish = (success: boolean, error?: unknown) => {
            if (this.dispatched !== claim) return;
            clearTimeout(claim.timer);
            this.dispatched = undefined;
            try {
                if (this.active && claim.generation === this.generation) this.completed(request, success, error);
            } finally { this.next(); }
        };
        this.armWarning(claim);
        try {
            const result = this.redeem(request, () => finish(true), error => finish(false, error));
            void Promise.resolve(result).catch(error => finish(false, error));
        } catch (error) { finish(false, error); }
    }
}
