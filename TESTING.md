# Verification — 2026-10-01

| Check | Result |
| --- | --- |
| Automated regression/integration tests, Node 24.19.0 | 25 passed |
| Same tests, minimum supported Node 22.13.0 | 25 passed |
| Local plugin bundles and bot syntax | Passed |
| Vencord TypeScript check and full desktop standalone build | Passed |
| Equicord TypeScript check and full desktop/Equibop standalone build | Passed |
| Vencord plugin lint, excluding upstream's own copyright-header rule | Passed |

Host sources checked:

- Vencord: `7f0c10cc29fd789f2f4828ae3dc947623e837920`
- Equicord: `ab9b98472acb281cc7ec4d2c7a612219993bb3cb`

The plugin retains the original MIT license and attribution rather than inserting Vencord's copyright header. Both host builds include the renderer and new native notification transport. GitHub Actions repeats tests on Node 22/24 and builds against these pinned host revisions.

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
