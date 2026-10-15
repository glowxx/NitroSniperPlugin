# Test DM cleanup deadline correction

Client date: 2026-10-14. Same workspace, clean starting tree on `fix/post-audit-hardening` at `25efe176fccd43499718688673d929907f673346`. The prior commit is preserved. This correction is authorized as a second local commit, without push, merge or PR.

## Behavior and durability

The previous `pendingWarning` drained tests during disconnect and different-bot replacement without checking `deleteAt`. It has been removed. Normal disconnect returns `disconnected: false`, the pending count and an actionable warning while keeping the encrypted connection, settings and metadata intact. No automatic deferred revocation is created. Retry after cleanup or explicitly choose `Force disconnect — test DMs may remain`. Force removes opaque ciphertext without decryption, issues no DELETE, and retains nonsecret jobs. Cleanup remains possible only if the matching original bot is available again. An unreadable cleanup store similarly blocks normal removal and offers the explicit force choice.

Same-bot rotation preserves `deleteAt`; different-bot replacement cannot use its new token for old jobs. Plugin stop, settings/account changes and renderer reload never shorten deadlines. A blocked normal disconnect leaves in-flight CLAIM delivery active; cancellation occurs only upon actual removal or explicit force.

Both modes use local successful delivery completion, `deliveredAt + 30_000`, without click/event/embed/server time. Direct mode awaits atomic cleanup persistence before success; deferred-save and failed-save tests prove it. SQLite commits receipt and `delivered` together. Initial service HTTP acceptance means queued, not delivered. A failed cleanup commit after successful POST stays non-delivered and explicitly reports that the test was sent but cleanup could not be saved.

Absolute deadlines survive restart. Validators check representable timestamp ranges rather than comparing valid jobs with the current clock, preventing data loss on backwards corrections. Native cleanup rechecks time after asynchronous credential lookup; service rechecks in its deletion guard. Native rescheduling is bounded to 100 ms–one hour, with existing retry backoff. Forward corrections can make a persisted job overdue. Across restarts wall time cannot independently measure elapsed real time; keep the OS clock synchronized. Intentional DELETE always requires current local time to reach the original deadline. Normal-clock tests prove zero DELETE at 10.000/29.999 and eligibility at 30.000 seconds. Scheduling, downtime and rate limits may delay removal.

## Focused adversarial review

Reviewed `git show 6b1caa3348ca3a43ecc954204fedfe8a439525c4..HEAD` in file groups, production paths, related tests and the correction diff. Scope was regressions introduced by the 35-file implementation. Corrected findings:

1. Disconnect's early drain, reported by the user.
2. Different-bot replacement shared the early-drain path.
3. Direct/SQLite validators discarded valid jobs after backwards clock changes.
4. Service lifetime depended on the Discord timestamp and could extend the intended local lifetime.
5. Service persistence failure after successful POST returned only a generic delivery error, hiding the cleanup limitation.

Review of the first correction also found cancellation of an unrelated in-flight CLAIM when normal disconnect was blocked. A failing-first regression proved 409 instead of 200; moving abort to actual removal fixed it. No further regression was found in migration/account retention, confirmed DataStore ordering, serial claim completion, timers, vault recovery, nonce separation, cleanup ownership or SQLite migration. No style-only refactor, dependency/schema change, parallel claims, gift retries or CAPTCHA change was added.

Only successful TEST native/SDK receipts create cleanup. Renderer source IDs are never delete targets. Persisted jobs validate snowflakes (including uint64 bounds), owner/bot identity, timestamps and attempts. No cleanup token, plaintext fallback, renderer path or generic delete-target IPC/HTTP endpoint exists. CLAIM events remain outside cleanup. Retention after force/unrelated-bot replacement is explicit and bounded by existing queue limits. Reconnect the original bot; 404 completes jobs already deleted manually.

## Verification commands

Tests use `$env:TEMP = Join-Path (Get-Location) 'node_modules\.test-tmp'; $env:TMP = $env:TEMP`.

| Command | Result |
| --- | --- |
| `git status --short`; `git branch --show-current`; `git rev-parse HEAD` | PASSED: expected clean starting state |
| `node --test tests/direct-cleanup.test.mjs tests/direct-panel.test.mjs tests/service-cleanup.test.mjs` | FAILED before fix: 47/58, eleven regressions; PASSED after fix: 58/58 |
| `node --test tests/direct-cleanup.test.mjs tests/direct-panel.test.mjs tests/direct-lifetime-integration.test.mjs tests/service-cleanup.test.mjs` | PASSED: 63/63, then 64/64 after final CLAIM correction |
| `node --test --test-name-pattern='blocked normal disconnect cannot cancel' tests/direct-cleanup.test.mjs` | FAILED before fix: 409 instead of 200; fixed and passed in final focused/full runs |
| `node --test tests/parser-hardening.test.mjs tests/claims.test.mjs tests/claim-recovery.test.mjs tests/claim-backpressure.test.mjs tests/account-settings.test.mjs tests/account-notification-integration.test.mjs tests/confirmed-persistence.test.mjs tests/notification-recovery.test.mjs tests/notifications.test.mjs tests/outbox-failures.test.mjs tests/vault-recovery.test.mjs tests/direct-bot.test.mjs tests/direct-cleanup.test.mjs tests/direct-panel.test.mjs tests/direct-lifetime-integration.test.mjs tests/service-cleanup.test.mjs` | PASSED: 183/183 before final CLAIM regression; included in final 254/254 suite |
| `npm test` | PASSED with approved loopback access: 253/253, then final 254/254, none skipped |
| `npm run check` | PASSED after first and final functional changes |
| `git diff --check` | PASSED; normal LF-to-CRLF checkout notices only |
| `git show 6b1caa3348ca3a43ecc954204fedfe8a439525c4..HEAD -- <file groups>`; `git diff` | PASSED: focused manual review |

Source copies use `Get-ChildItem -File -Path '*.ts','*.tsx'` and `Copy-Item -Destination .host-verification/<host>/src/userplugins/nitroSniper`, for the two current hosts after functional changes. Original host sources, dependency graphs/configs and full tsconfig were not changed; no diagnostic filtering or rule suppression was used.

| Command from repository root | Result |
| --- | --- |
| `node .host-verification/typecheck.mjs .host-verification/host-vencord C:/Users/Kamil/AppData/Local/Temp/NitroSniper-host-vencord-20261014` | PASSED after first/final changes: TS 6.0.3, zero diagnostics |
| `node .host-verification/typecheck.mjs .host-verification/host-equicord C:/Users/Kamil/AppData/Local/Temp/NitroSniper-host-equicord-20261014` | PASSED after first/final changes: TS 6.0.3, zero diagnostics |

Standalone build commands, from `.host-verification/host-vencord` and `.host-verification/host-equicord` respectively:

```powershell
$env:NS_HOST_DEPENDENCIES = 'C:/Users/Kamil/AppData/Local/Temp/NitroSniper-host-vencord-20261014'
$env:VENCORD_HASH = 'verification'
$env:VENCORD_REMOTE = 'Vendicated/Vencord'
node --import ../resolve-dependencies.mjs --require ./scripts/suppressExperimentalWarnings.js scripts/build/build.mjs --standalone

$env:NS_HOST_DEPENDENCIES = 'C:/Users/Kamil/AppData/Local/Temp/NitroSniper-host-equicord-20261014'
$env:VENCORD_HASH = 'verification'
$env:VENCORD_REMOTE = 'Equicord/Equicord'
node --import ../resolve-dependencies.mjs --require ./scripts/suppressExperimentalWarnings.js scripts/build/build.mjs --standalone
```

RESULT: PASSED for both hosts after first/final functional changes.

Initial lint commands used the original ESLint CLI/config against workspace files. RESULT: FAILED preparation: original `parserOptions.project` did not include workspace files. Corrected using the identical copied config with the dependency-resolution hook:

```powershell
# In .host-verification/host-vencord
$env:NS_HOST_DEPENDENCIES = 'C:/Users/Kamil/AppData/Local/Temp/NitroSniper-host-vencord-20261014'
node --import ../resolve-dependencies.mjs C:/Users/Kamil/AppData/Local/Temp/NitroSniper-host-vencord-20261014/node_modules/eslint/bin/eslint.js --config ./eslint.config.mjs src/userplugins/nitroSniper/directBot.ts src/userplugins/nitroSniper/directBotPanel.tsx src/userplugins/nitroSniper/native.ts

# In .host-verification/host-equicord
$env:NS_HOST_DEPENDENCIES = 'C:/Users/Kamil/AppData/Local/Temp/NitroSniper-host-equicord-20261014'
node --import ../resolve-dependencies.mjs C:/Users/Kamil/AppData/Local/Temp/NitroSniper-host-equicord-20261014/node_modules/eslint/bin/eslint.js --config ./eslint.config.mjs src/userplugins/nitroSniper/directBot.ts src/userplugins/nitroSniper/directBotPanel.tsx src/userplugins/nitroSniper/native.ts
```

RESULT: FAILED only `simple-header/header`, three errors per host, the previously user-accepted GPL-header/MIT-plugin conflict. MIT/original attribution is preserved, no suppression or other code-rule failure.

An initial documentation patch had a mismatched heading and FAILED without changing files; corrected against `# Verification`. Node 22 and live authenticated Discord/keyring/DM/redemption/CAPTCHA checks: NOT RUN, environment/credentials unavailable. Pinned-host reruns: NOT RUN in this focused correction; current-host type/build checks passed. No real thirty-second sleeps or live redemption were used. The authorized second local commit and final status/HEAD/parent checks complete the local save; SHA is reported in chat. Push/merge/PR: NOT RUN, prohibited.
