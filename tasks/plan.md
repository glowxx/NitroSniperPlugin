# Post-audit hardening

Baseline: clean main at 6b1caa3348ca3a43ecc954204fedfe8a439525c4. User-provided implementation contract is the specification. One final local commit; no push, merge or PR.

Independent slices can run in parallel after their contracts are established:
- Claim queue/parser: complete URL candidates; one serial claim; claimant-scoped 429 cooldown; no automatic gift retry or CAPTCHA changes.
- Native direct bot: encrypted vault recovery/removal, sanitized HTTP status, native-owned durable test cleanup. Extend public connection results only with non-secret warnings. Native recovery endpoint accepts account ID only, no deletion IDs.
- Service: additive idempotent SQLite cleanup table, returned message identity, persistent deadline and worker retries. Claims never enter cleanup.
- Renderer integration: account-owned destinations, one-time legacy migration, persistence independent of session, current supported toast API.

Verification: reproduce each affected behavior first; focused regressions per slice; npm ci/test/check; four host type/build/lint checks; manual diff/security review. All external Discord operations use mocks; no live redemption.

Final checkpoint: complete required checks and document limitations, then one commit on fix/post-audit-hardening.

## Bounded claim diagnostics — 2026-10-15

The new user specification authorizes one diagnostics commit, updating PR #3, a normal merge commit after verification, and removing the fully merged feature branch. It supersedes the earlier no-push/no-merge limit for this work.

1. Define a fixed diagnostics allowlist: fresh UUID session, local numeric claim ID, event/level, numeric error metadata and environment snapshots. Never persist arbitrary error messages or private content. Verify with hostile-payload tests.
2. Implement serialized native JSONL writes to a fixed userData/NitroSniper/logs directory, 512 KiB per file, current plus two rotations, bounded admission with terminal-event priority. Verify actual files, concurrent writes, rotation and write failures using small test limits.
3. Observe queue transitions/callbacks/Promise settlement without changing completion semantics. Add at most four pending checkpoints (15/30/60/120s), retaining the 120s warning and unresolved lock. Verify fake-clock ordering, duplicate callbacks and failing observers.
4. Add lifecycle and renderer visibility/focus transitions, 5s gap checks logging only gaps over 20s with a one-minute rate limit. No probes, telemetry, idle surveillance or optional settings UI. Verify listener/timer cleanup and runtime gaps deterministically.
5. Run focused/full checks, current host type/build checks, privacy/final diff review and documentation. Create one commit, push and inspect the new CI run. Merge only verified intended history; zero-step infrastructure failures are recorded separately. Confirm ancestry before branch cleanup and final main synchronization.

Questions answered: was the renderer inactive/throttled; which redeem signals arrived; did the operation remain pending or fail with a numeric HTTP/API/rate-limit outcome? All diagnostics remain best-effort and never await a filesystem write on the claim path.
