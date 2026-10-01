import type { ClaimRequest } from "./types";

export function extractGiftCodes(content: string): string[] {
    const pattern = /(?:^|[\s<(])(?:https?:\/\/)?(?:discord\.gift\/|discord(?:app)?\.com\/gifts?\/)([A-Za-z0-9]{16,24})(?=$|[^A-Za-z0-9])/g;
    return [...new Set(Array.from(content.matchAll(pattern), match => match[1]))];
}

/** Serial claims; only Discord's callback can confirm a successful redemption. */
export class ClaimQueue {
    private pending: ClaimRequest[] = [];
    private seen = new Map<string, number>();
    private active = false;
    private running = false;
    private generation = 0;
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(
        private redeem: (request: ClaimRequest, success: () => void, failure: (error: unknown) => void) => unknown,
        private completed: (request: ClaimRequest, success: boolean, error?: unknown) => void,
        private stalled: () => void,
        private timeoutMs = 120_000
    ) { }

    start() { this.stop(); this.active = true; }
    stop() {
        this.active = false;
        this.generation++;
        this.pending = [];
        this.running = false;
        clearTimeout(this.timer);
    }
    enqueue(request: ClaimRequest): boolean {
        if (!this.active || this.pending.length >= 100) return false;
        const now = Date.now();
        for (const [code, time] of this.seen) if (now - time > 86_400_000) this.seen.delete(code);
        if (this.seen.has(request.code)) return false;
        if (this.seen.size >= 5000) this.seen.delete(this.seen.keys().next().value!);
        this.seen.set(request.code, now);
        this.pending.push(request);
        this.next();
        return true;
    }
    private next() {
        if (!this.active || this.running) return;
        const request = this.pending.shift();
        if (!request) return;
        this.running = true;
        const { generation } = this;
        let settled = false;
        const finish = (success: boolean, error?: unknown) => {
            if (settled || !this.active || generation !== this.generation) return;
            settled = true;
            clearTimeout(this.timer);
            this.running = false;
            try { this.completed(request, success, error); } finally { this.next(); }
        };
        // Do not start another redemption while a CAPTCHA/modal may still be open.
        this.timer = setTimeout(() => this.stalled(), this.timeoutMs);
        try {
            const result = this.redeem(request, () => finish(true), error => finish(false, error));
            void Promise.resolve(result).catch(error => finish(false, error));
        } catch (error) { finish(false, error); }
    }
}
