# Post-audit command and review ledger

Date: 2026-10-14. Existing clean workspace at `6b1caa3348ca3a43ecc954204fedfe8a439525c4`, branch `main`. Work is on `fix/post-audit-hardening`. All implementation changes are being saved in one focused local commit after the user explicitly accepted the stock GPL-header/MIT-plugin lint limitation. No push, merge or PR was authorized or performed.

## Setup and inspection

| Command | Result |
| --- | --- |
| `Get-Location`, `rg --files -g AGENTS.md`, `git status --short` | PASSED: correct workspace, no local AGENTS.md, clean starting tree |
| `git status`, `git branch --show-current`, `git rev-parse HEAD`, `git log -n 10 --oneline` | PASSED: expected baseline |
| `git switch -c fix/post-audit-hardening` | FAILED initially: sandbox denied `.git/refs`; PASSED with approved execution |
| `npm ci` | FAILED initially: EPERM creating scoped dependency directory; PASSED with approved execution, 27 packages, zero reported vulnerabilities |
| `node --version`, `Get-Command node` | PASSED: Node 24.19.0 at `C:/Program Files/nodejs/node.exe` |
| `Get-Content` / `rg` for the specification, skills, affected production code and tests | PASSED, except an initial host read using sandbox `$env:TEMP` (different redirected directory); corrected with the explicit fetched path |
| `git clone --depth 1 https://github.com/Vendicated/Vencord.git <temporary Vencord>` | PASSED with approved execution |
| `git clone --depth 1 https://github.com/Equicord/Equicord.git <temporary Equicord>` | PASSED with approved execution |
| `git -C <host> fetch --depth 1 origin <pinned SHA>` (both hosts) | PASSED |
| `git -C <host> worktree add --detach <pinned directory> <pinned SHA>` (both hosts) | PASSED |
| `corepack pnpm install --frozen-lockfile` (all four hosts) | PASSED: declared pnpm 11.9.0 / 12.6.0 / 12.8.1, not a forced shared version |
| Copy baseline sources into external host directories | NOT RUN: automatic approval review unavailable due account usage limit; no unsafe-action determination |
| Workspace source copies using `Get-ChildItem` / `Copy-Item` | PASSED; originals and dependency manifests unchanged |
| `New-Item -ItemType Junction` for workspace host dependencies | FAILED: sandbox access denied; replaced with copying dependency files into writable workspace |
| `node .host-verification/copy-dependencies.mjs <fetched host> <workspace host>` | PASSED for all four hosts; no external writes or junction creation |

## Regression and repository checks

Repeated commands below were rerun only after relevant implementation/test changes. Expected red runs are recorded separately from the final outcome.

| Command | Result |
| --- | --- |
| `node --test tests/parser-hardening.test.mjs tests/claim-backpressure.test.mjs` | FAILED before fixes: 11/13; confirmed parser and cooldown bugs |
| `node --test tests/parser-hardening.test.mjs` | FAILED when U+FEFF adversarial case was added, then fixed |
| `node --test tests/parser-hardening.test.mjs tests/claim-backpressure.test.mjs tests/claims.test.mjs tests/claim-recovery.test.mjs` | PASSED: 71/71 |
| `node --test tests/account-settings.test.mjs` | FAILED before module existed; PASSED: 2/2 after migration/isolation implementation |
| `node --test tests/confirmed-persistence.test.mjs` | FAILED: 3/3 before fix; PASSED: 3/3 after fix |
| `node --test tests/plugin.test.mjs tests/confirmed-persistence.test.mjs tests/notifications.test.mjs tests/outbox-failures.test.mjs tests/notification-recovery.test.mjs` | PASSED: 44/44 |
| `node --test tests/plugin.test.mjs tests/notification-recovery.test.mjs tests/notifications.test.mjs tests/direct-panel.test.mjs` | FAILED initially: panel expected global enabled setting; fixed to verify per-account state |
| `node --test tests/account-notification-integration.test.mjs` | PASSED: 4/4, including controlled digest pause and repeated A/B switches |
| `node --test tests/outbox-failures.test.mjs tests/notification-recovery.test.mjs tests/notifications.test.mjs tests/plugin.test.mjs tests/account-notification-integration.test.mjs` | PASSED: 45/45 with explicit completion/deferred synchronization |
| `node --test tests/direct-cleanup.test.mjs tests/service-cleanup.test.mjs` | FAILED review regressions: 2/35 (write-retry storm and SDK success during stop); both fixed |
| `node --test tests/direct-cleanup.test.mjs tests/service-cleanup.test.mjs tests/dm-adapter.test.mjs tests/pairing-dm.test.mjs tests/direct-bot.test.mjs` | PASSED: 58/58 after fixes |
| `node --test tests/direct-bot.test.mjs tests/direct-cleanup.test.mjs tests/vault-recovery.test.mjs tests/direct-dm-integration.test.mjs` | FAILED during fixture update because unit tests used real Electron cleanup storage; PASSED: 31/31 after explicit native-store fixture |
| `node --test tests/direct-cleanup.test.mjs` | FAILED first on startup-read retry clock fixture, then PASSED: 17/17; FAILED after adding claim/test nonce collision, then fixed |
| `node --test tests/direct-cleanup.test.mjs tests/service-cleanup.test.mjs tests/dm-adapter.test.mjs` | PASSED: 46/46 after separate test nonce namespace |
| `node --test tests/direct-cleanup.test.mjs tests/service-cleanup.test.mjs` (clock-offset review) | FAILED first on two premature-deletion regressions, then fixed and covered by the full unrestricted run |
| `node --test tests/vault-recovery.test.mjs` | PASSED: 6/6, including partial other-account recovery |
| `node --test tests/direct-bot.test.mjs` | FAILED when final-dispatch expiry regression was added; fixed. A restricted temp-file test in that red run also reported EPERM; full final run uses workspace TEMP |
| `node --test tests/direct-panel.test.mjs` | FAILED first on recovery button for cleanup corruption; PASSED: 4/4 after restricting it to credential corruption. Further failing-first regressions for keyring-unavailable UI removal and late owner-scoped actions were fixed; final panel suite PASSED: 6/6 |
| `npm test` | Initial restricted runs FAILED on temporary filesystem/localhost restrictions. Restricted final run: FAILED, 233/235 passed due EACCES loopback HTTP access; final approved unrestricted run: PASSED, 237/237, none skipped |
| `npm run check` | PASSED throughout and after final functional changes: renderer/native bundling and bot syntax |
| `git diff --check` | PASSED after implementation and final review |
| `rg -n 'Toasts.Type'` excluding generated directories | PASSED: no production occurrence; only historical TESTING.md text |
| `git diff`, `git diff --stat`, `git diff --numstat`, `git ls-files --others --exclude-standard`, `git status --short` | PASSED: reviewed production changes, regressions and documentation; intended uncommitted work only |

The last full-suite failure in `tests/end-to-end.test.mjs` is an empty service queue caused by the blocked native loopback request. The explicit network error in `tests/service.test.mjs` is `connect EACCES 127.0.0.1`. Neither is reported as passed.

## Host commands

Host identifiers: `host-vencord` = current Vencord `16ec4ea838899706019e7f472e45f055070abeb1`; `host-equicord` = current Equicord `e0e85c8d4f6dc73aac9368cf3f4b2200eac4d4b4`; `pinned-vencord` = `7f0c10cc29fd789f2f4828ae3dc947623e837920`; `pinned-equicord` = `ab9b98472acb281cc7ec4d2c7a612219993bb3cb`.

| Command | Result |
| --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit` in workspace host copies | FAILED initial preparation: absent dependency junctions, then mixed transitive versions in flattened package files. These are not the final type results |
| `node .host-verification/typecheck.mjs .host-verification/<host> C:/Users/Kamil/AppData/Local/Temp/NitroSniper-<host>-20261014` (each of four identifiers) | PASSED: full upstream tsconfig, original locked dependencies, TS 6.0.3, zero diagnostics. Earlier runs exposed genuine account-setting and recovery-map type errors, which were corrected without casts/suppressions. Initial compiler-host dependency realpath handling was also corrected |
| `node --require ./scripts/suppressExperimentalWarnings.js scripts/build/build.mjs --standalone` | FAILED initial dependency preparation; PASSED for both Vencord revisions after physical workspace copies. Equicord build-tool transitive dependency resolution needed the exact original graph below |
| `node --import ../resolve-dependencies.mjs --require ./scripts/suppressExperimentalWarnings.js scripts/build/build.mjs --standalone` (all four hosts, with original dependency location and host metadata environment variables) | PASSED for all four hosts. Earlier hook/preparation attempts failed on package resolution or mismatched `brace-expansion`, before correction |
| Host ESLint CLI `src/userplugins/nitroSniper` with the original host config, both current hosts | FAILED: GPL-header rule for MIT plugin, plus an existing empty line in untouched webhook.ts on Equicord. Touched import, regex and destructuring issues were corrected |
| Host ESLint CLI for `accountSettings.ts claimQueue.ts directBot.ts directBotPanel.tsx index.tsx native.ts notifications.ts settings.tsx`, both current hosts | FAILED: exactly eight `simple-header/header` errors in each; no other rule errors. No rule was disabled and original attribution/license retained |
| Pinned-host ESLint | NOT RUN: current-host relevant lint already exposed the shared license-header gate; type/build checks ran separately for each pinned host |
| Node 22 checks | NOT RUN: Node 22 runtime unavailable in configured PATH |
| Real authenticated Discord/keyring/DM/redemption tests | NOT RUN: no credentials/live client test environment; no CAPTCHA triggered or solved |
| `git add` / `git commit -m "fix: harden claims, notifications, and test DM cleanup"` | Authorized final local save after 237/237 tests, four full type/build checks and final diff review; verify final SHA/status with git log/status |
| `git push` / merge / PR creation | NOT RUN: expressly prohibited |

## Focused security/diff review

Deletion jobs originate only from successfully delivered structured `kind === "test"` events and trusted create-message receipts. Channel/message snowflakes are validated; renderer source IDs never become deletion targets. Kind-separated test nonces prevent a reused claimed event ID from selecting a permanent claim message. No generic IPC/HTTP deletion route was added.

Direct records contain only account/bot/message identities, deadlines and attempts. Vault tokens stay OS-encrypted; public metadata excludes tokens. Same-bot credential rotation is eligible; different bot/account credentials cannot execute old jobs. Deliberate revocation drains within a bounded deadline and warns if future deletion needs reconnect. Claims never enter cleanup. Files/records, worker batches, backoff and timers are bounded; failed writes/reads pause rather than repeatedly dispatching due operations. Service cleanup is protected by the existing SQLite worker lease and additive idempotent schema.

Confirmed claim persistence starts with captured A configuration and survives plugin stop/logout/switch during preparation. UI/delivery still require the matching active session. The DataStore commit is the durability boundary; closing the whole process before that asynchronous commit or losing writable storage remains a reported boundary. Webhooks retain their documented best-effort delivery semantics.

No parallel gift claims, new automatic gift retries, CAPTCHA changes, plaintext fallback, real-token logging or unrelated feature redesign were introduced. Unrestricted loopback checks are now passed. The user explicitly accepted the documented stock GPL-header/MIT-plugin lint limitation and authorized the focused local commit; no checker was disabled.
