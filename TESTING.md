# Verification

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
4. With an authorized gift on your own test account, verify that only Discord's successful redemption callback triggers a DM. Verify the CAPTCHA/modal behaviour without bypassing it.
5. Restart the bot during queued delivery, switch client accounts, and test the deployed HTTPS proxy.

The internal Discord action is discovered by name at runtime; future Discord updates can change it even when TypeScript and bundling pass. A successful mock integration does not prove live Discord compatibility or real delivery. DM delivery also depends on the recipient's privacy settings and bot access. See README for limits and recovery actions.

## GitHub Actions availability

The workflow was created and triggered, but GitHub rejected all jobs before assigning a runner. Its check annotation states: "The job was not started because your account is locked due to a billing issue." No CI test steps ran. This is separate from the passing local test/build results above. The repository owner must resolve the GitHub billing lock before the workflow can run.
