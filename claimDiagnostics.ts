import type { PluginNative } from "@utils/types";

import { cleanDiagnosticRecord, type DiagnosticContext, type DiagnosticEvent, type DiagnosticFields, TERMINAL_DIAGNOSTICS } from "./diagnosticProtocol";

interface Snapshot { context?: DiagnosticContext; fields: DiagnosticFields; }
interface Environment {
    document?: Pick<Document, "visibilityState" | "hasFocus" | "addEventListener" | "removeEventListener">;
    window?: Pick<Window, "addEventListener" | "removeEventListener">;
    online?: () => boolean;
}
interface Options { environment?: Environment; sink?: (payload: string) => Promise<unknown>; }
const INTERVAL = 5000;

function newSessionId(): string {
    try { return crypto.randomUUID(); }
    catch {
        // Correlation only, never a credential or identity derived from Discord data.
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, char => {
            const value = Math.floor(Math.random() * 16);
            return (char === "x" ? value : (value & 3) | 8).toString(16);
        });
    }
}
function nativeSink(payload: string): Promise<unknown> {
    const host = globalThis as typeof globalThis & { VencordNative?: { pluginHelpers?: { NitroSniper?: PluginNative<typeof import("./native")>; }; }; };
    return host.VencordNative?.pluginHelpers?.NitroSniper?.writeClaimDiagnostic?.(payload) ?? Promise.resolve(false);
}

/** Renderer-only observation. No request data, credentials, paths or claim controls enter this API. */
export function createClaimDiagnostics(options: Options = {}) {
    const environment = options.environment ?? {
        document: typeof document === "undefined" ? undefined : document,
        window: typeof window === "undefined" ? undefined : window,
        online: () => typeof navigator === "undefined" ? undefined : navigator.onLine
    };
    const sink = options.sink ?? nativeSink;
    let session = newSessionId();
    let snapshot: (() => Snapshot) | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let running = false;
    let visibility: string | undefined, focused: boolean | undefined, online: boolean | undefined;
    let previousTick = 0, lastGap = -Infinity, windowStart = 0, ordinaryCount = 0;
    const repeated = new Map<string, number>();
    const listeners: (() => void)[] = [];

    function state(): DiagnosticFields {
        const fields: DiagnosticFields = {};
        try { fields.visibility = environment.document?.visibilityState ?? "unknown"; } catch { /* Optional host API. */ }
        try { fields.focused = environment.document?.hasFocus(); } catch { /* Optional host API. */ }
        try { fields.online = environment.online?.(); } catch { /* Optional host API. */ }
        return fields;
    }
    function record(event: DiagnosticEvent, fields: DiagnosticFields = {}, context?: DiagnosticContext) {
        try {
            const safe = cleanDiagnosticRecord({ ts: new Date().toISOString(), level: /error|rejected|threw|failure/.test(event) ? "error"
                : ["runtime_gap", "claim_pending_checkpoint", "queue_overflow"].includes(event) ? "warn" : "info",
            event, session, ...context, ...state(), ...fields });
            if (!safe) return;
            if (!TERMINAL_DIAGNOSTICS.has(event)) {
                const now = Date.now();
                if (now < windowStart || now - windowStart >= 60_000) { windowStart = now; ordinaryCount = 0; }
                const signature = JSON.stringify({ ...safe, ts: undefined });
                const last = repeated.get(signature);
                if (ordinaryCount >= 120 || (last !== undefined && now >= last && now - last < 10_000)) return;
                if (repeated.size >= 256) repeated.clear();
                repeated.set(signature, now); ordinaryCount++;
            }
            void Promise.resolve(sink(JSON.stringify(safe))).catch(() => {});
        } catch { /* Logging cannot interrupt claims or lifecycle, including missing/old native helpers. */ }
    }
    function transition(event: DiagnosticEvent) {
        try { const current = snapshot?.(); record(event, current?.fields, current?.context); }
        catch { /* Even a failed state snapshot must stay outside the claim path. */ }
    }
    function listen(target: Environment["document"] | Environment["window"], event: string, handler: () => void) {
        if (!target) return;
        try {
            target.addEventListener(event, handler);
            listeners.push(() => target.removeEventListener(event, handler));
        } catch { /* Unsupported environments still allow lifecycle/result logging. */ }
    }
    function detach() {
        clearInterval(timer); timer = undefined;
        for (const remove of listeners.splice(0)) { try { remove(); } catch { /* Best effort teardown. */ } }
    }
    return {
        context(): DiagnosticContext { return { session }; },
        record,
        beginSession(reason: "startup" | "account_changed" | "login") {
            if (reason !== "startup") session = newSessionId();
            record("session_started", { reason });
        },
        start(readState: () => Snapshot) {
            detach(); session = newSessionId(); snapshot = readState; running = true;
            repeated.clear(); ordinaryCount = 0; windowStart = previousTick = Date.now(); lastGap = -Infinity;
            ({ visibility, focused, online } = state());
            record("plugin_started");
            listen(environment.document, "visibilitychange", () => {
                const next = state().visibility;
                if (next !== visibility) { visibility = next; transition("visibility_changed"); }
            });
            const focus = () => {
                const next = state().focused;
                if (next !== focused) { focused = next; transition("focus_changed"); }
            };
            const network = () => {
                const next = state().online;
                if (next !== online) { online = next; transition("network_changed"); }
            };
            listen(environment.window, "focus", focus); listen(environment.window, "blur", focus);
            listen(environment.window, "online", network); listen(environment.window, "offline", network);
            timer = setInterval(() => {
                const now = Date.now(), gapMs = now - previousTick;
                previousTick = now;
                if (now < lastGap) lastGap = -Infinity;
                if (gapMs > 20_000 && now - lastGap >= 60_000) {
                    lastGap = now;
                    try { const current = snapshot?.(); record("runtime_gap", { ...current?.fields, expectedMs: INTERVAL, gapMs }, current?.context); }
                    catch { /* No effect on redeem or the runtime. */ }
                }
            }, INTERVAL);
        },
        stop() {
            if (running) transition("plugin_stopped");
            running = false; detach(); snapshot = undefined;
        }
    };
}

export const claimDiagnostics = createClaimDiagnostics();
