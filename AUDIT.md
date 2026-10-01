# Structural and edge-case audit — 2026-10-01

Scope: root plugin modules, native IPC transport, settings, gift metadata, webhook formatting, standalone bot, pairing commands, HTTP API, SQLite storage, shutdown, Docker/configuration and regression tests. This is an implementation audit with fault-injection tests, not proof of compatibility with every future Discord client release.

## Confirmed findings and corrections

| Impact | Scenario before correction | Correction and regression evidence |
| --- | --- | --- |
| High | Restarting or switching accounts cleared the local claim lock although the old Discord redemption/CAPTCHA remained in flight. Another redemption could overlap it. | Keep the dispatched-action lock until its actual callback/rejection; suppress old-session results. Restart-overlap regression passed. |
| Medium | Discarding pending claims kept their codes marked as attempted; another account also inherited the same deduplication entries. | Release never-dispatched entries on stop; use account plus code as the identity. Cancellation and account-isolation tests passed. |
| High | A failed DataStore write left an unsaved event eligible for sending. A failed read left notification writes enabled and could overwrite unread durable state. | Publish queue snapshots only after successful writes. Pause on read/schema failure and preserve original data. Both faults were reproduced before correction. |
| Medium | A successful claim waited for optional gift metadata before being persisted; stopping/restarting during lookup lost its notification. | Save the confirmed event first, then enrich it within a three-second grace period. Restart during metadata lookup was tested. |
| High | A bot batch held stale rows; disconnecting and relinking during its first DM could send later cancelled events. | Re-read consent and queued state before each dispatch and after recipient lookup. Previously cancelled rows cannot be revived. |
| High | A slow `/notifications link` could finish after `/notifications disconnect` and reactivate the account. | Cancel pairing through account revision checks before/after awaited operations, including delayed interaction acknowledgement. Disconnect does not wait for a slow link. |
| Medium | Rotating a key before delivering its private response could invalidate a working key without providing the replacement. | Prepare the key, deliver the response, then activate only if pairing is still current. Private-reply failure preserves the working key. |
| High | A specially chosen author name could inject its own Markdown link into the webhook's author field. The original escape regex did not escape closing brackets. | Correct Markdown escaping and constrain embed-field lengths. An injected author-link test failed before and passed after the fix. |
| Medium | Two bot processes using one database could independently send the same queued notification. | Acquire an atomic database ownership lease, renew every five seconds and stop on ownership loss. A second process is refused; crash recovery waits at most 60 seconds. |
| Medium | Shutdown could continue a batch, accept delayed mutations or close SQLite before active HTTP/command work finished. | Stop ingestion/dispatch, drain handlers and HTTP requests, then close the database. Pending events remain durable. Shutdown during pairing/batch tests passed. |
| Medium | IPC rejections bypassed persisted backoff; null/malformed service replies could crash result handling. Old replies could update a stopped session's UI. | Normalize replies, persist retries and check the active generation/connection after awaits. Rate-limit retries wait at least one minute. |
| Medium | Restored records were weakly validated and could retain unintended extra fields. | Validate identities, times and counters; whitelist payload fields. Invalid top-level state is preserved and reported rather than reset. |
| Medium | A blocked recipient caused repeated attempts for every already queued DM. Events expiring during a slow batch could still be sent. | Fail the existing blocked-account backlog after the first permanent refusal; recheck event expiry immediately before dispatch. |
| Low | Metadata requests could accumulate if the underlying Discord REST promise never returned; unexpected names broke formatting. | Limit concurrent underlying lookups to four and validate/truncate names. Optional metadata failure does not invalidate a claim. |
| Low | Parsing a webhook discarded `thread_id`, routing a notification to the main channel instead of its configured thread. | Preserve validated `thread_id`/`wait`; reject ambiguous/unsupported query parameters. |
| Low | Fresh first messages after an account change could be rejected because the new start time was set at receipt. Gift paths with suffixes could be truncated into a different code. | Allow a bounded fresh-message handover and require valid gift-code delimiters. |
| Low | Own gift links were claimed by default on fresh installations, and a full claim queue had no warning. | New installations ignore own links by default; existing explicit settings are retained. Show a throttled queue-full warning. |

## Verification

- **54 regression/integration tests passed** on Node.js 24.19.0 and minimum supported Node.js 22.13.0.
- Full TypeScript checks and standalone desktop builds passed for the pinned Vencord/Equicord revisions in TESTING.md.
- Plugin lint passed with the upstream copyright-header rule excluded to retain the original MIT attribution.
- `npm audit --omit=dev`: **0 known vulnerabilities** reported in production dependencies at audit time. This does not establish that dependencies are vulnerability-free.
- GitHub Actions remains unavailable because GitHub reports an account billing lock. These results were obtained locally.

## Remaining boundaries

1. Live Discord gift redemption, actual CAPTCHA/modal behaviour, real bot delivery and the rendered settings panel still need an authenticated desktop client and operator bot credentials. Tests simulate the Discord sender; builds do not establish runtime compatibility of Discord's internal `redeemGiftCode` action.
2. A redemption or DM already dispatched to Discord cannot be recalled. Stop/disconnect prevent further queued work and stale result attribution; they cannot reverse external requests already sent.
3. If Discord never returns a redemption callback/rejection, the queue deliberately remains locked, including across plugin toggles. Fully restart the Discord client to clear that unresolved client action. Advancing blindly would risk overlapping claims.
4. Delivery is at least once. A crash after Discord accepted a DM but before SQLite recorded it can cause a retry. Stable nonces reduce duplicates only within Discord's limited nonce window.
5. Notifications expire after 24 hours, both queues are bounded, and transient bot delivery eventually exhausts its retries. Closed DMs require the user to enable delivery and send a new test; the old backlog is not automatically resent.
6. Bot DM events have durable retry handling. Channel webhooks remain best-effort: a timeout, rejected payload or Discord rate limit can lose that optional channel notification. It never causes another redemption attempt.
7. Gift extraction currently scans message text, not images, attachments, edited messages or embed-only gift links. Client deduplication is in memory and resets on a full process restart.
8. A recipient key authorizes client-reported success notifications to that same account. It does not independently prove the redemption. Keep keys/settings exports private; use TLS and proxy request limits for a public service.
9. The service is one bot process per database. The ownership lease blocks accidental duplicates; after an ungraceful crash the replacement may need to wait up to one minute. Back up SQLite state and monitor the health endpoint.
