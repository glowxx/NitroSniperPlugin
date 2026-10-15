export const DIAGNOSTIC_EVENTS = [
    "plugin_started", "plugin_stopped", "session_started", "logout", "account_changed", "connection_open",
    "gift_detected", "claim_enqueued", "claim_rejected_from_queue", "claim_dispatched", "queue_overflow",
    "queue_waiting_for_429_cooldown", "cooldown_finished", "on_redeemed", "on_error", "redeem_promise_resolved",
    "redeem_promise_rejected", "redeem_threw", "claim_completed_success", "claim_completed_failure",
    "claim_pending_checkpoint", "visibility_changed", "focus_changed", "runtime_gap", "network_changed"
] as const;
export type DiagnosticEvent = typeof DIAGNOSTIC_EVENTS[number];
export interface DiagnosticContext { session: string; claim?: number; }
export interface DiagnosticFields {
    pending?: number; elapsedMs?: number; checkpointMs?: number; cooldownMs?: number; expectedMs?: number; gapMs?: number;
    status?: number; apiCode?: number; retryAfter?: number; active?: boolean; late?: boolean; focused?: boolean; online?: boolean;
    visibility?: string; reason?: string; errorName?: string; transportCode?: string;
}
export interface DiagnosticRecord extends DiagnosticContext, DiagnosticFields {
    ts: string; level: "info" | "warn" | "error"; event: DiagnosticEvent;
}
export interface DiagnosticObserver {
    context(): DiagnosticContext;
    record(event: DiagnosticEvent, fields?: DiagnosticFields, context?: DiagnosticContext): void;
}
export const TERMINAL_DIAGNOSTICS = new Set<string>([
    "on_redeemed", "on_error", "redeem_promise_resolved", "redeem_promise_rejected", "redeem_threw",
    "claim_completed_success", "claim_completed_failure"
]);
const names = new Set(["Error", "TypeError", "RangeError", "AbortError", "TimeoutError", "BillingError", "APIError", "HTTPResponseError"]);
const transports = new Set(["ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "ECONNREFUSED", "EAI_AGAIN"]);
const reasons = new Set(["inactive", "queue_full", "cooldown_capacity", "duplicate", "retry_wait", "attempt_limit", "already_seen", "startup", "account_changed", "login"]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const number = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

/** No arbitrary message/name/body/stack survives, even if it embeds an unknown secret. */
export function diagnosticError(error: unknown): DiagnosticFields {
    const safe: DiagnosticFields = {};
    try {
        if (!object(error)) return safe;
        safe.errorName = typeof error.name === "string" && names.has(error.name) ? error.name : "Error";
        if (number(error.status, -1, 599) && Number.isInteger(error.status)) safe.status = error.status;
        if (number(error.code, 0, 10_000_000) && Number.isInteger(error.code)) safe.apiCode = error.code;
        else if (typeof error.code === "string" && transports.has(error.code)) safe.transportCode = error.code;
        const retry = number(error.retryAfter, 0, 86_400) ? error.retryAfter : object(error.body) ? error.body.retry_after : undefined;
        if (number(retry, 0, 86_400)) safe.retryAfter = retry;
    } catch { /* Hostile getters and unusual error objects must not affect the claim. */ }
    return safe;
}

/** Native and renderer share this strict field allowlist; raw error text is deliberately omitted. */
export function cleanDiagnosticRecord(value: unknown): DiagnosticRecord | null {
    if (!object(value)) return null;
    const event = DIAGNOSTIC_EVENTS.find(event => event === value.event);
    const { level } = value;
    if (typeof value.ts !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.ts)
        || !Number.isFinite(Date.parse(value.ts)) || typeof value.session !== "string"
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.session)
        || !event || (level !== "info" && level !== "warn" && level !== "error")) return null;
    const safe: DiagnosticRecord = { ts: value.ts, level, event, session: value.session };
    for (const field of ["claim", "pending", "elapsedMs", "checkpointMs", "cooldownMs", "expectedMs", "gapMs", "status", "apiCode", "retryAfter"] as const) {
        const max = field === "pending" ? 100 : field === "status" ? 599 : field === "retryAfter" ? 86_400
            : field === "apiCode" ? 10_000_000 : field === "claim" ? 1_000_000_000 : 1_000_000_000_000;
        const entry = value[field];
        if (number(entry, field === "status" ? -1 : 0, max)) safe[field] = entry;
    }
    for (const field of ["active", "late", "focused", "online"] as const) {
        const entry = value[field];
        if (typeof entry === "boolean") safe[field] = entry;
    }
    if (typeof value.visibility === "string" && ["visible", "hidden", "prerender", "unknown"].includes(value.visibility)) safe.visibility = value.visibility;
    for (const [field, allowed] of [["reason", reasons], ["errorName", names], ["transportCode", transports]] as const) {
        const entry = value[field];
        if (typeof entry === "string" && allowed.has(entry)) safe[field] = entry;
    }
    return safe;
}
