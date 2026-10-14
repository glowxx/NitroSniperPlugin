# Verification

## Masked gift link correction — 2026-10-15

Starting at `5b3b5ac7079752e111315be712cd495f5bfdb773`, all three `[Nitro](https://discord.gift/CODE)`, `discord.com/gifts` and `discordapp.com/gifts` masked-link regressions failed with an empty result. The whitespace tokenizer also incorrectly exposed gift URLs inside a spaced visible label or malformed spaced destination. The correction keeps complete Markdown candidates together, handles balanced/escaped brackets and parentheses, ignores labels and passes only a complete absolute HTTP(S) destination through the unchanged strict host/path validation. Whole hostile outer URLs are never searched for gift substrings. Syntax references: [Discord masked links](https://support.discord.com/hc/en-us/articles/210298617-Markdown-Text-101-Chat-Formatting-Bold-Italic-Underline) and [CommonMark inline links](https://spec.commonmark.org/0.31.2/#inline-links).

- `node --test tests/parser-hardening.test.mjs`: FAILED before correction (5/12), then PASSED **12/12**, including all prior adversarial cases plus three masked-host reproductions, case/query/fragment/paired wrappers, spaced/Unicode/nested/escaped labels, independent links, deduplication, hostile destinations/suffixes and malformed structure.
- `node --test tests/claims.test.mjs tests/claim-recovery.test.mjs tests/claim-backpressure.test.mjs`: PASSED **67/67**.
- `npm test`: PASSED **262/262**, none skipped, on Node 24.19.0 with approved localhost access and workspace TEMP/TMP.
- `npm run check` and `git diff --check`: PASSED.

No live Discord claims/CAPTCHA tests or unrelated production changes were made. The existing red Actions run had no executed steps and is not evidence of a source/test failure; no production workaround or workflow rerun was made in response. The new head's workflow state is reported separately after push.

## Cleanup deadline correction — 2026-10-14

The correction above `25efe176fccd43499718688673d929907f673346` preserves the authoritative local delivery deadline. Normal disconnect with pending tests retains the encrypted connection and reports a pending count; the separately warned force action removes it without issuing DELETE. Different-bot replacement no longer drains tests. A blocked normal disconnect also preserves unrelated in-flight CLAIM delivery.

Final `npm test`: **254/254 passed, none skipped**, on Node 24.19.0 with approved loopback access. Focused cleanup/panel/lifecycle checks passed **64/64**. Fake-clock cases cover 10.000, 29.999 and 30.000 seconds, restart/recovery at 10/20 seconds, overdue restart, rotation, force revocation, account switch, actual plugin stop, clock rewinds/forward jumps and durable-before-success ordering. Service failure after successful POST now reports the cleanup limitation explicitly. No real thirty-second sleeps, Discord credentials, live redemption or CAPTCHA tests were used.

Current Vencord `16ec4ea838899706019e7f472e45f055070abeb1` and Equicord `e0e85c8d4f6dc73aac9368cf3f4b2200eac4d4b4` full type checks passed with TS 6.0.3 and zero diagnostics; both standalone builds passed after the final functional change. Current-host lint for the three changed host-facing files reports only the previously accepted GPL-header/MIT-plugin conflict, three errors per host. No rule or check was suppressed; MIT and attribution remain intact. See [CLEANUP_DEADLINE_VERIFICATION.md](CLEANUP_DEADLINE_VERIFICATION.md) for commands, initial failures, review findings and wall-clock limits. Results below describe earlier phases.

## Post-audit implementation — 2026-10-14

Baseline: clean `main` at `6b1caa3348ca3a43ecc954204fedfe8a439525c4`; implementation branch `fix/post-audit-hardening`. Node.js 24.19.0. All Discord responses and OS encryption in tests are simulated; no authenticated redemption, real bot credential or CAPTCHA was used.

The final full suite executed **237 tests: 237 passed, none skipped** with approved execution outside the sandbox. The preceding restricted run executed 235 tests with 233 passing and two loopback failures: the HTTP contract test reports `connect EACCES 127.0.0.1`; the native HTTP integration consequently cannot enqueue its event. They were not removed, skipped or changed to hide the restriction. Temporary filesystem tests use workspace `node_modules/.test-tmp` for `TEMP`/`TMP`. `npm ci` passed with approved installation, `npm run check` and `git diff --check` passed. The unrestricted test gate is satisfied; the user explicitly accepted the stock GPL-header/MIT-plugin lint limitation while retaining MIT and original attribution.

Failing-first regressions independently exposed nested URL extraction, case/query parser gaps, distinct-gift 429 dispatch, stop/logout/account-switch persistence loss, corrupt vault/removal failures, HTML HTTP status loss, cleanup-write retry storms, SDK receipt loss during shutdown, nonce reuse selecting a claim message and expiry during native serialization. Controlled promises, observable completion hooks and fake clocks replaced notification timing guesses. New tests cover independent A/B destinations, legacy migration, direct/service restart deadlines, multiple tests, permanent claims, 404/429/transient failures, malformed entries, same/different-bot replacement, revocation, lease/shutdown races, capacity, partial vault recovery, safe recovery-button scope and client/server clock offsets without early test deletion, keyring-unavailable UI removal and owner-scoped late setup/disconnect.

Host sources and their declared dependencies were fetched into disposable directories. Windows sandbox restrictions prevented native junction resolution and writes outside the workspace, so source and dependency files were copied to ignored `.host-verification` directories. Full TypeScript programs used each upstream `tsconfig.json`, its installed TypeScript 6.0.3 and exact original dependency paths through a read-only compiler-host adapter; no diagnostics, files or compiler checks were filtered. Builds used the upstream standalone script with Node (equivalent to its package-manager command), with a module-resolution hook for the original locked build-tool dependency graph. No upstream source or dependency manifest was changed.

| Host | Revision | Full type check | Standalone build | Relevant lint |
| --- | --- | --- | --- | --- |
| Pinned Vencord | `7f0c10cc29fd789f2f4828ae3dc947623e837920` | Passed | Passed | Not run |
| Pinned Equicord | `ab9b98472acb281cc7ec4d2c7a612219993bb3cb` | Passed | Passed | Not run |
| Current Vencord | `16ec4ea838899706019e7f472e45f055070abeb1` | Passed | Passed | Failed: upstream GPL header rule versus MIT plugin |
| Current Equicord | `e0e85c8d4f6dc73aac9368cf3f4b2200eac4d4b4` | Passed | Passed | Failed: upstream GPL header rule versus MIT plugin |

Import ordering, unnecessary regex escaping and touched-code destructuring were fixed. Existing MIT licensing and original attribution were retained; the GPL header rule was not suppressed. Full Equicord plugin lint also identifies an existing extra blank line in untouched `webhook.ts`. No production `Toasts.Type` remains. CI now checks pinned and rolling hosts, uses each host's declared pnpm, and allows rolling failures without silently blocking releases.

Node 22 and a live authenticated desktop/keyring test were not run because those environments/credentials were unavailable. Native `testTsc` CLI attempts in flattened copied dependencies initially failed on transitive dependency versions; the final full checks above use the exact locked dependency graph. Initial standalone attempts failed on dependency resolution before the workspace preparation was corrected. See `POST_AUDIT_VERIFICATION.md` for the command/result ledger and remaining gates.

## Gift redemption compatibility — 2026-10-14

Source inspection used Discord Stable build **637268**, version hash `a935e483c18dcf082c62ce19bc9e3560fce10581`, obtained from the public [app page](https://discord.com/app). These are client implementation observations, not a documented stable API contract.

- [Main client bundle](https://discord.com/assets/web.94f77ed563542b5d.js), module **75255**: `redeemGiftCode` is async; accepts `code`, `options.channelId`, optional `options.paymentSource`, `onRedeemed`, `onError`; awaits the internal HTTP POST with `channel_id`; dispatches success and invokes `onRedeemed` before returning the result. On failure it constructs a BillingError, dispatches failure, invokes `onError`, and throws the same error. There is no successful failure return in this implementation.
- [Native gift modal chunk](https://discord.com/assets/723a4d63ad1ef195.js), module **361845**: the accept handler awaits redemption with `options.channelId` from `channelContext`. The open handler changes local presentation state. Channel context is optional, including gifts opened outside a channel; this does not prove that every native redemption carries a non-null channel ID.
- Main bundle modules **913122 → 136857 → 178253 → 636537**: the action's BillingError inherits the API error fields `status`, `code`, `retryAfter`, `fields`, `message`, and `error`. The API error wrapper supplies fallback `code: -1` and copies `body.retry_after` to `retryAfter` when parsing a normal message body. It does not preserve the original `body` or a raw transport error's string `code`.
- Main bundle module **636537**: HTTPResponseError can retain `body`, `status`, and `retryAfter`; the HTTP layer parses the retry header/body in seconds and multiplies by 1000 when scheduling its cooldown. BillingError copies the body value without conversion. Discord's [rate-limit documentation](https://docs.discord.com/developers/topics/rate-limits) independently specifies seconds, including fractional values, for `retry_after`. Other unrelated client objects also use the name `retryAfter` for milliseconds/timestamps; this queue handles the verified gift action error contract.
- Executing the downloaded gift action and actual BillingError/APIError constructors in an isolated Node VM with stubbed HTTP/Flux/localization verified channel forwarding, Promise/callback success, and identical callback/rejected errors for HTTP 429 and 503 with `code: -1`, `retryAfter: 30`. No account, real gift, redemption HTTP request, or CAPTCHA was used.

The old numeric-code early return rejected both verified transient error shapes. The fix preserves explicit HTTP 4xx failures other than 429 and unknown outcomes as non-retryable. Known transport codes are retryable only when actually exposed; the plugin does not infer or unwrap missing transport information from BillingError.

Regression coverage includes normalized/raw retry delays and bounds, numeric fallback codes on transient HTTP statuses, real numeric rate-limit codes, permanent/CAPTCHA/unknown errors, Promise-only success, duplicate success/failure completion, stale callbacks/Promise settlement, callback-only adapters, account restart, and unresolved claim serialization. The integration mock now uses a controlled Promise matching Discord's actual settlement timing; the old immediately resolved mock incorrectly modeled a still-pending redemption as success.

Verification on Node.js **24.19.0**:

- Baseline: 136/136 tests passed outside the Windows sandbox. The restricted run failed five existing tests because localhost connections or temporary filesystem operations were denied; `npm run check` passed there.
- Regression-first focused run failed before the implementation; the corrected focused suite passed **73/73**, also independently repeated by the scoped reviewer. Final `npm test`: **160/160 passed**, no skipped tests. `npm run check` passed after the code change.
- Strict standalone TypeScript checking of `claimQueue.ts` and `types.ts` passed with the installed TypeScript compiler. No new dependency or suppression was added.
- In a disposable clean copy of installed Equicord commit `e0e85c8d4f6dc73aac9368cf3f4b2200eac4d4b4`, with this plugin and existing host dependencies, the standalone desktop/Equibop build passed. Host ESLint passed for the two changed TypeScript files using the previously documented `simple-header/header: off` exception to retain MIT attribution.
- Full Equicord `tsc --noEmit` failed with **seven TS2339 errors**: `Toasts.Type` is absent from this newer host's `Toasts` type (`directBotPanel.tsx`, `index.tsx`, `settings.tsx`). Repeating against the starting plugin sources produced identical diagnostics. This pre-existing host incompatibility is outside this focused redemption fix; it was not suppressed or changed. The user's existing Equicord checkout was not modified.
- A separate Vencord checkout and the historical pinned host installations were unavailable; their full type/build checks were not rerun. No authenticated client was exercised. Final diff inspection and a separate focused review found no additional required changes.

Passing channel context matches the observed native call more closely. There is no evidence here that it reduces CAPTCHA frequency. Live authenticated redemption and actual CAPTCHA presentation remain untested; the native action and protection handling remain in control.

## Direct bot-token setup — 2026-10-10

- All 136 tests pass on Node.js 24.19.0 and 22.13.0, including four atomic-disconnect regressions and thirteen direct-mode tests.
- Direct-mode integration exercises token verification, native Discord requests, the actual plugin callback, a persisted local outbox and removal after confirmed delivery. Discord HTTP responses and OS encryption are simulated; no real token is used.
- Panel interaction tests verify immediate input clearing, metadata-only settings, disconnect cleanup, failure feedback and account changes during setup.
- Vault tests verify ciphertext-only files, reload, deletion and refusing unavailable encryption/plaintext fallback. They do not establish real Windows/macOS/Linux keyring behaviour in an authenticated desktop client.
- Vencord and Equicord type checking and standalone desktop bundling pass against the pinned host revisions below, using their declared pnpm 11.9.0 and 12.6.0 respectively.
- Real bot DMs and live visual/keyring checks remain outstanding: connect a bot, invite it to a shared server, allow DMs, send a test, restart Discord, and verify that the connection remains available without token readback.

## Final re-audit corrections — 2026-10-04

| Check | Result |
| --- | --- |
| Full regression/integration suite, Node 24.19.0 | 119 passed |
| Full suite, minimum supported Node 22.13.0 | 119 passed |
| Plugin bundles and bot syntax, Node 24 and 22.13.0 | Passed |
| Pinned Vencord and Equicord type checks and standalone desktop builds | Passed |
| Vencord plugin ESLint, preserving original MIT attribution | Passed |
| Isolated mutations of gateway recognition, reconciliation, REST signal, abortable waits and pairing cancellation | Regressions detected |
| Final independent read-only client and bot review | No further required corrections found |

The new tests reproduce delayed recipient lookup/DM-channel creation, disconnect/relink, expiry and shutdown; use real discord.js serialization and REST buckets; check cancellation during a real local rate-limit sleep; validate pairing cancellation and private key activation; and run the bot entrypoint in separate processes to check SIGTERM and login-failure exit codes. Client regressions cover clock offsets, account changes, local/push envelopes, missing fields and deduplicated gateway replay. Outbox regressions cover terminal non-JSON rejections and metadata finishing during transport.

Every confirmed bug was reproduced before its correction. Mutations were made only in disposable copies, with the original project untouched. The public Discord client envelope was checked against `web.24a0dd4254453b09.js`; no real gift or account token was used. See [AUDIT.md](AUDIT.md) for the final findings, corrections and limits.

## Previous follow-up fixes — 2026-10-04

| Check | Result |
| --- | --- |
| Full regression/integration suite, Node 24.19.0 (`npm test`) | 87 passed |
| Full suite, minimum supported Node 22.13.0 (`node --test tests/*.test.mjs`) | 87 passed |
| Plugin bundles and bot syntax (`npm run check`), Node 24 and 22.13.0 | Passed |
| Vencord `testTsc`, `buildStandalone` | Passed |
| Equicord `testTsc`, desktop/Equibop `buildStandalone` | Passed |
| Vencord plugin ESLint, excluding its copyright-header rule to preserve MIT attribution | Passed |
| Mutation of transient-retry condition in a disposable source copy | 13 claim-recovery tests failed, as expected |

The host revisions are the same pinned revisions listed below. Host dependencies were installed with scripts disabled; Vencord used its declared pnpm 11.9.0 and Equicord its declared pnpm 12.6.0. No dependency manifest or lockfile was changed in the plugin repository.

New regressions cover formatted/spoofed gift links, transient/permanent/unknown errors, cooldown and Discord retry-after, the three-dispatch cap, cancelled retry budgets, stale callbacks, no automatic claiming, visible unsaved events, invalid replacement settings, optional metadata write failure, outages longer than thirty minutes, expiry during recipient lookup, metadata aborts/slot recovery and native response validation.

The metadata abort contract follows Node's documented `AbortSignal.timeout`: https://nodejs.org/docs/latest-v22.x/api/globals.html#static-method-abortsignaltimeoutdelay. An unauthenticated request to the restricted gift endpoint with a deliberately invalid code returned Discord's `404 / Unknown Gift Code`; no real gift was queried or redeemed. Automated metadata tests simulate Discord responses and aborts.

Live-client checks listed below remain outstanding. These results do not establish live Discord gift compatibility, visual settings correctness or real DM delivery.

## Previous verification — 2026-10-01

| Check | Result |
| --- | --- |
| Automated regression/integration tests, Node 24.19.0 | 54 passed |
| Same tests, minimum supported Node 22.13.0 | 54 passed |
| Local plugin bundles and bot syntax | Passed |
| Vencord TypeScript check and full desktop standalone build | Passed |
| Equicord TypeScript check and full desktop/Equibop standalone build | Passed |
| Vencord plugin lint, excluding upstream's own copyright-header rule | Passed |
| GitHub Actions run | Not started: GitHub account billing lock |

Host sources checked:

- Vencord: `7f0c10cc29fd789f2f4828ae3dc947623e837920`
- Equicord: `ab9b98472acb281cc7ec4d2c7a612219993bb3cb`

The plugin retains the original MIT license and attribution rather than inserting Vencord's copyright header. Both host builds include the renderer and new native notification transport. GitHub Actions repeats tests on Node 22/24 and builds against these pinned host revisions.

The follow-up structural audit and fault-injection results are in [AUDIT.md](AUDIT.md).

## Problems corrected

- Duplicate gift messages and repeated success/error callbacks could produce repeated work or notifications.
- Throwing or rejecting the internal gift action could leave the redemption queue stuck.
- No stop lifecycle allowed queued work or callbacks to survive disabling/restarting the plugin.
- Account changes could misattribute late claim notifications.
- Long-running CAPTCHA/modals were not surfaced to the user. The queue now waits and warns rather than starting overlapping redemptions.
- The original `Message.guild_id` access did not type-check against current Vencord types. Guild source links now use `ChannelStore`.
- Arbitrary webhook URLs, unbounded response bodies and requests without timeouts are now rejected/bounded.
- Gift metadata cannot delay notification creation indefinitely; lookup is limited to three seconds.

## Automated coverage

The integration test drives the actual plugin success callback, native helper and HTTP server, checks persistence in SQLite, and delivers through an injected Discord DM sender. Additional tests exercise stopped clients, account changes, callback duplication, own/history messages, malformed/spoofed gift links, queue bounds, key rotation/revocation, account mismatch, service restarts, transient retries, blocked DMs, rate limits, request/response-size limits, notification outbox restore/isolation, and delivery status.

## Live checks still needed

No Discord bot credentials or authenticated desktop Discord instance were available in this workspace. The following are therefore **not claimed as tested**:

1. Register `/notifications` with the real bot and verify link/test/status/disconnect in Discord.
2. Build/restart the actual Vencord/Equicord client and visually inspect the panel (password masking, enabled/disabled state, keyboard navigation and buttons).
3. Run Send Test DM with DMs allowed, then with the bot blocked; inspect both plugin and slash-command status.
4. With an authorized gift on your own test account, verify that a successful Discord callback or redemption Promise settlement triggers exactly one claim notification. Verify the CAPTCHA/modal behaviour without bypassing it.
5. Restart the bot during queued delivery, switch client accounts, and test the deployed HTTPS proxy.

The internal Discord action is discovered by name at runtime; future Discord updates can change it even when TypeScript and bundling pass. A successful mock integration does not prove live Discord compatibility or real delivery. DM delivery also depends on the recipient's privacy settings and bot access. See README for limits and recovery actions.

## GitHub Actions availability

The workflow was created and triggered, but GitHub rejected all jobs before assigning a runner. Its check annotation states: "The job was not started because your account is locked due to a billing issue." No CI test steps ran. This is separate from the passing local test/build results above. The repository owner must resolve the GitHub billing lock before the workflow can run.
