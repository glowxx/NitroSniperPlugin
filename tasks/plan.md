# Post-audit hardening

Baseline: clean main at 6b1caa3348ca3a43ecc954204fedfe8a439525c4. User-provided implementation contract is the specification. One final local commit; no push, merge or PR.

Independent slices can run in parallel after their contracts are established:
- Claim queue/parser: complete URL candidates; one serial claim; claimant-scoped 429 cooldown; no automatic gift retry or CAPTCHA changes.
- Native direct bot: encrypted vault recovery/removal, sanitized HTTP status, native-owned durable test cleanup. Extend public connection results only with non-secret warnings. Native recovery endpoint accepts account ID only, no deletion IDs.
- Service: additive idempotent SQLite cleanup table, returned message identity, persistent deadline and worker retries. Claims never enter cleanup.
- Renderer integration: account-owned destinations, one-time legacy migration, persistence independent of session, current supported toast API.

Verification: reproduce each affected behavior first; focused regressions per slice; npm ci/test/check; four host type/build/lint checks; manual diff/security review. All external Discord operations use mocks; no live redemption.

Final checkpoint: complete required checks and document limitations, then one commit on fix/post-audit-hardening.
