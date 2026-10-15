# NitroSniper for Vencord / Equicord

Automatically redeem gift links in the running Discord client, with optional Discord webhooks and private success notifications from your own Discord bot.

Client redemption uses Discord's own gift action with the originating channel context. A notification is created **only when Discord invokes the success callback or its redemption Promise resolves successfully**. An open CAPTCHA or gift dialog is not a successful claim. The bot sends notifications; it does not redeem gifts.

## Bot DM notifications

### Simple setup: paste the bot token in the plugin

1. Create a bot in the Discord Developer Portal and invite it to a server you belong to. Allow DMs from that server.
2. Open NitroSniper settings, leave **DM setup → Bot token (recommended)** selected, paste the **bot token**, and click **Connect bot**.
3. The input clears immediately. The panel shows the connected bot's name; the saved token cannot be displayed again. Click **Send Test DM** to verify delivery.

No external service, `.env` editing, running bot process or slash-command registration is needed in this mode. Discord API requests run in the desktop native process using the saved bot token. The token is encrypted with Electron `safeStorage` in the current OS user's profile and is absent from normal plugin settings and settings exports. Plaintext storage fallback is refused; Linux requires a working system keyring. **Disconnect** removes the token for the current Discord account and aborts pending sends. Other Discord accounts have separate connections. Already sent messages cannot be recalled.

Keep the desktop client running for DMs to send. Confirmed events still use the persistent local outbox, expire after 24 hours and retry transient errors/rate limits. A blocked DM or revoked token is reported as a terminal error for that event; fix the connection and send a new test. This mode can only deliver after the running client reports a successful claim. Server-side delivery while the client is closed remains available through the optional external-service mode below.

If replacing an already connected bot fails, the previous connection is retained. Replacing or removing a bot isolates the old connection's outbox; those events are not redirected to the new bot. Nonces reduce duplicate DMs after ambiguous responses or restarts, but cannot provide an unlimited exactly-once guarantee.

### External notification service (advanced)

Existing configured service installations retain that mode on the first update. To configure a service manually, select **DM setup → External notification service (advanced)**. Its URL and key fields appear inside the panel.


1. Join a server containing the notification bot and allow its DMs.
2. Run **`/notifications link`**. The bot checks DM delivery and privately returns the service URL and an account-specific key.
3. In **Settings → Vencord/Equicord → Plugins → NitroSniper**, paste the service URL and notification key, then enable **Bot DM notifications**.
4. Click **Send Test DM**, then **Check Connection** to confirm delivery.

A successful claim produces a DM with the gift type when available, time, and source-message link. The source link requires your normal permission to view that message. Failed attempts are sent only to the optional webhook. Neither notification channel exposes the gift code.

The key can send notifications only to the Discord account that created it. **In external-service mode, paste only the notification key; its bot token stays on the server. Never use a Discord user token.** The key is masked in settings but stored in the client's settings; keep settings exports private. Run `/notifications link` again to replace a key or `/notifications disconnect` to revoke it and cancel queued messages. Disabling notifications locally stops new events and local retries; already accepted server events may still be delivered. Disconnect to cancel those too.

| Command | Purpose |
| --- | --- |
| `/notifications link` | Verify DMs and create/rotate your key |
| `/notifications status` | See account link, queued messages and last delivery result |
| `/notifications test` | Queue a test DM from the bot |
| `/notifications disconnect` | Revoke the key and cancel queued messages |

### For the bot operator

Requires **Node.js 22.13+**; Node.js 24 is recommended. SQLite is built into Node (older releases may print an experimental warning). Run the bot on your server, separately from the client plugin. One bot process must own its database. An ownership lease rejects a second process and stops a worker that loses ownership; after a crash, wait up to 60 seconds for that lease to expire. Do not run multiple replicas against the same file.

1. Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications). Copy its bot token and application ID.
2. Invite it with the **`bot`** and **`applications.commands`** scopes. No administrator permission, Message Content intent or Server Members intent is needed.
3. From this repository's root:

```sh
npm ci
cp bot/.env.example bot/.env
# Fill in DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID and PUBLIC_URL.
npm run bot:register
npm run bot
```

On Windows, copy `bot/.env.example` to `bot/.env` in File Explorer or use `Copy-Item bot/.env.example bot/.env` in PowerShell. All npm commands run from the repository root.

`PUBLIC_URL` is the service origin, for example `https://notify.example.com`, without a path. Place a TLS reverse proxy in front of `127.0.0.1:8787`. HTTP is allowed only for localhost testing. With Caddy, the basic configuration is:

```caddyfile
notify.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Point the hostname to your server and configure TLS. Apply request/connection limits at the proxy for public deployment. Do not log Authorization headers. `GET /health` returns 200 when the bot is ready, otherwise 503.

`DISCORD_GUILD_ID` is optional. Set it to your development server ID for immediate guild command registration; omit it for global commands. Registration upserts only `/notifications` and preserves unrelated commands. Remove a development guild command in the Developer Portal before switching to global registration if you see duplicate commands.

For Docker:

```sh
# Configure bot/.env first.
docker compose -f bot/compose.yaml up -d --build
docker compose -f bot/compose.yaml exec notifications node bot/register.mjs
```

The compose setup binds the API to the host's loopback address and uses a persistent named volume. Keep your TLS proxy in front of it. Back up `bot/data/notifications.sqlite` using SQLite's backup facilities (or stop the bot and copy the database plus any WAL/SHM files). Do not delete the volume during an upgrade.

## Plugin installation / update

Build a desktop Vencord or Equicord from source following its custom-plugin instructions. Put this repository in `src/userplugins/nitroSniper`, or copy the root `.ts` and `.tsx` files into that folder. The `bot`, `tests`, `scripts` and npm dependencies belong to the standalone service and development tools, not the plugin bundle.

**Rebuild and fully restart the client after updating.** The new native helper must be included. No bot library is imported into the renderer or native plugin. Web-only installations cannot use these notification transports; settings show a clear error.

Existing webhook settings remain valid. Webhooks are now restricted to official Discord webhook URLs and requests have a 10-second timeout. Valid thread_id routing is preserved. Channel webhooks are best-effort and do not share the durable DM retry queue. A notification error never causes another redemption attempt.

Webhook URL, DM enabled state, setup mode, service URL and service key belong to the current Discord account. The first migration assigns the old global settings only to the account logged in at that time, then clears the legacy destination fields. New accounts start unconfigured; switching back restores that account's own configuration. Direct bot credentials and public connection metadata remain account-owned.

## Temporary test DMs

**Send Test DM** messages keep their full 30-second lifetime after confirmed delivery. Both modes set `deliveredAt` from the local clock when a successful Discord message response completes and persist `deleteAt = deliveredAt + 30_000`. Click time, event time, embeds and Discord timestamps do not determine cleanup. Restarts preserve that original deadline. Real claim DMs are permanent and never enter cleanup. Tests use a separate nonce namespace, so a reused event ID cannot select an earlier claim message through Discord nonce deduplication.

Direct mode records the successful Discord response's channel/message IDs, account owner, bot ID and original deadline in `NitroSniper/test-message-cleanup.json` under Electron's user-data directory. The native module resumes this worker at startup, without opening settings or sending another test. The atomic, bounded store contains no token; cleanup resolves the current encrypted credential for the original account and bot. A malformed entry cannot stop valid entries. Invalid outer storage is preserved and reported. Failed startup reads and failed cleanup writes back off before retrying.

Service mode stores the successful SDK receipt in additive SQLite `test_cleanups` and `cleanup_backoff` tables. Its existing single-owner worker resumes overdue jobs after restart. Both modes treat successful DELETE and 404 as completion, respect `retry_after` on 429 and keep transient failures for bounded retry. Authorization failures pause cleanup and retain recovery state. No renderer or HTTP endpoint accepts arbitrary deletion IDs.

A same-bot token rotation resumes old tests without changing `deleteAt`. Replacing it with a different bot never deletes tests early or uses the unrelated replacement to delete old messages; a warning explains that cleanup requires reconnecting the original bot. **Disconnect** removes the encrypted credential normally when no test cleanup is pending. With pending tests it keeps the connection, reports the pending count and asks the user to retry after cleanup. An explicitly warned **Force disconnect — test DMs may remain** action removes the credential without issuing DELETE, leaving durable jobs available if the original bot is later reconnected. An unreadable cleanup store also blocks normal disconnect and offers the explicit force choice. No old plaintext token is retained, and no disconnect is silently deferred indefinitely.

Plugin disable, settings/account changes and renderer reload never shorten test lifetime. The restart guarantee requires the same valid bot credential and functioning durable storage. A failed initial cleanup write after successful Discord delivery is reported as a failed test action with an explicit manual-deletion warning. Service status similarly warns that a test was sent but automatic deletion could not be saved; it never publishes `delivered` before the cleanup transaction commits. Its initial HTTP acknowledgement means queued, not delivered. Revoking a service notification key does not remove the service bot credential, so its test cleanup continues at the original deadline.

Cleanup persists absolute wall-clock deadlines. Backwards clock changes preserve jobs and delay cleanup until the deadline; native timers recheck it and reschedule between 100 ms and one hour. Forward changes can make a job overdue according to the new wall clock. Across process restarts an absolute timestamp cannot measure elapsed time independently of system-clock corrections; keep the OS clock synchronized. DELETE is never intentionally issued while the current local time is before the persisted deadline. Scheduling, downtime and rate limits can delay deletion beyond the eligible time.

Corrupted credential storage requires an explicit **Recover secure storage** action. Recovery preserves the original encrypted file in a quarantine backup, keeps individually valid other-account records where possible and disconnects the selected account. Writes and decryptions require OS encryption; deleting opaque encrypted records does not require a functioning keyring. There is no plaintext fallback.

## Delivery and claim behaviour

- Gift codes are deduplicated per account for 24 hours in the current client process (up to 5,000 remembered codes); pending redemption queue is capped at 100. A newly received link can retry a confirmed HTTP 429/5xx or recognized transport failure after at least five seconds, respecting a numeric Discord `retryAfter` or `body.retry_after` in seconds (capped at 24 hours), with at most three dispatched attempts per account/code in that window. HTTP 429/5xx remain retryable with numeric API/fallback codes. No retries run automatically. Successes, permanent/unknown failures and unresolved actions remain deduplicated. Discarded, never-dispatched codes are released on stop; cancelling a pending retry preserves earlier attempts.
- Complete gift URL candidates are validated before extracting codes, including paired/nested spoilers, bold, italic, underline, strikethrough, backticks and prose wrappers. Genuine hosts are compared case-insensitively, codes retain their case, and queries/fragments are accepted. Unrelated URLs containing nested gift-shaped paths, queries or fragments are rejected, along with userinfo, Unicode/zero-width hosts, normalization tricks, extra path components and mismatched wrappers. Own messages are ignored by default on fresh installations (existing explicit settings are retained).
- A verified HTTP 429 delays distinct pending claims for that claimant account. Stop/start preserves the in-memory deadline; another account has its own cooldown. The public gift action wrapper does not retain trustworthy bucket/scope information, so this is conservative account-scoped backpressure. It does not automatically requeue the failed gift or change CAPTCHA handling.
- Received Discord gateway `MESSAGE_CREATE` events are processed using their verified envelope, so claim detection does not depend on the computer clock matching Discord. Local/optimistic messages and push-notification replay are ignored; message edits and history loads are not scanned. Gateway events replayed after reconnect count as newly received events and remain deduplicated. Invalid timestamps are rejected. Unrecognized client/event formats retain a conservative local timestamp cutoff.
- Synchronous errors and settled action promises release the queue. Repeated callbacks and Promise settlements for an already completed claim are ignored. Disabling the plugin cancels queued work and suppresses stale results.
- After two minutes without completion, a warning asks you to check Discord's dialog. The next claim waits for a callback or Promise settlement; the plugin does not bypass CAPTCHA or assume the result. Plugin toggles retain the lock on an unresolved dispatched action. Fully restart the Discord client if it never returns; a plugin toggle does not cancel a redemption already dispatched to Discord.
- A successful claim starts recording with its captured claimant and configuration; stopping, logging out or changing accounts cannot cancel already-started preparation/persistence. The event becomes durable when the DataStore write completes, before optional metadata enrichment. Delivery and stale UI remain session-guarded. The local DM outbox uses committed snapshots before transport, isolated by account, endpoint and key fingerprint, and capped at 100 events. Events expire after 24 hours. Old key/account outboxes stay isolated until expiration; they never get reassigned to a different account. Closing the entire process before an asynchronous storage write completes cannot guarantee that write; plugin/session shutdown does not cancel it.
- Outbox read/schema failures pause notifications without overwriting unread data; write failures do not publish unsaved events.
- A full outbox or failed initial event write shows a toast and an alert with an unsaved-notification count for the current connection in the current plugin session. This count survives delivery-status refreshes but resets when the plugin restarts; it is a warning, not another retry queue. Already saved events are preserved. A failed optional metadata update does not mark the saved notification as lost.
- Optional gift metadata uses a public Discord endpoint through the desktop native helper, with no account token, at most four concurrent requests, a three-second abort deadline and bounded response bodies. Timed-out requests release the lookup slots. Missing/failed metadata does not prevent a claim notification.
- The bot stores hashed keys and a durable SQLite queue, deduplicates by account/event ID, and retries transient failures with bounded exponential backoff (at most five minutes between retries) until the event's 24-hour delivery window expires. Consent and expiry are checked after recipient lookup, DM-channel creation and payload preparation. Disconnect, stop and expiry abort pending message requests, including SDK REST queues. A message already accepted by Discord cannot be recalled. Event history is retained for seven days. A closed/blocked DM is terminal and appears in the status; enable DMs and send a **new test** after fixing it. The existing blocked-account backlog is failed to prevent repeated rejected requests.
- Terminal HTTP rejections explicitly report that the local event was rejected and will not retry. Optional metadata changes cannot make the client lose an acceptance or reset its retry backoff while a request is in flight.
- Pairing-test DMs use the same guarded sender. Disconnect and shutdown cancel pending pairing work before final message dispatch. An SDK rate-limit wait does not prevent cancellation from releasing the worker; shutdown exits after owned work and resources have drained.
- Per-account ingestion is limited to 10 new events per minute, with 100 queued per account and 10,000 total. Duplicate retries are accepted without consuming the ingestion limit.
- HTTP **202 means saved/queued**, not delivered. Check Connection or `/notifications status` reports the actual bot delivery state.
- Delivery is at least once. Stable Discord message nonces reduce duplicates if a process crashes after sending but before marking an event delivered; Discord's nonce window is limited, so an unusually delayed retry can still duplicate a DM.
- Success is the client's reported result. A recipient's key holder can submit events for their own account; the service cannot independently prove a gift redemption. It cannot send to another account through that key.

## Claim diagnostics

Desktop builds keep local JSON Lines at `<Discord/Electron userData>/NitroSniper/logs/claim-diagnostics.jsonl`. Rebuild and fully restart the client to include the native writer. The current file and `.1` / `.2` retain at most 512 KiB each (1.5 MiB total file contents). Rotation removes the oldest file. Logs survive client restarts; claim state does not. There is no telemetry or connectivity probe.

Each entry has `ts`, `level`, `event`, a fresh anonymous `session` UUID and, for a gift, a local numeric `claim` identifier. The logger records queue transitions, callback/Promise outcomes and four pending checkpoints at 15/30/60/120 seconds. Where available, entries include visibility, focus, online state, queue size, elapsed time and cooldown. Account changes start a new anonymous session; late claim results retain their original correlation. No Discord account IDs are written.

Visibility, focus and online/offline events log only actual transitions. A five-second internal timer normally writes nothing; an interval longer than 20 seconds records `runtime_gap`, at most once per minute. A gap can also reflect sleep, event-loop blockage or a wall-clock correction: it suggests suspension/throttling rather than proving its cause. No gap event does not prove uninterrupted execution. The diagnostics do not fix the intermittent spinner, bypass CAPTCHA or release an unresolved claim; the existing two-minute warning and serialized claim lock remain.

Ordinary events coalesce identical entries for ten seconds and are capped at 120 per minute in both layers. Terminal callback/Promise/completion signals bypass this limit. Native writes are serialized, bounded to 512 pending records with 128 places reserved from ordinary admissions, and accept only small schema-validated records. Logging is best effort: disk errors or hard saturation can lose evidence, and shutdown never waits for the writer. Logging failures do not fail or retry a claim.

Gift codes/URLs, bot/account tokens, webhook URLs, service keys, message/DM contents, authorization/cookies and CAPTCHA/rqtoken/rqdata values are intentionally omitted. Arbitrary error messages, names, stacks and bodies are discarded; only recognized error names/transport codes and bounded numeric HTTP status, Discord error code and retry delay survive validation in both layers.

When reporting a stuck claim, provide the relevant `claim-diagnostics.jsonl`, `.1` and `.2` if needed, plus the approximate time, client build and whether the computer slept or the app was in the background. Review the files before sharing. Send only diagnostics files, never credential, settings, vault or notification database files. A dispatched claim followed by a long gap suggests renderer interruption; pending checkpoints without callback/Promise settlement suggest an unresolved Discord operation; rejection/error events show observable failure; a resolved Promise without a callback shows the Promise fallback completed it.

## Tests

```sh
npm test
npm run check
```

Tests cover the full confirmed-claim → native IPC → HTTP → SQLite → DM-sender path with a simulated Discord sender, plus fault-injected reads/writes, restart overlap, cancelled pairing, ownership leases, Markdown-link injection, duplicate callbacks, restarts, account isolation, stopped plugins, queued retries, blocked DMs, revoked keys, malformed requests, URL restrictions, rate limits and response-size bounds. GitHub Actions runs them on Node.js 22 and 24.

Host verification commands after copying the root plugin files into an upstream source checkout:

```sh
pnpm testTsc
pnpm buildStandalone
```

See [AUDIT.md](AUDIT.md) for structural findings and remaining boundaries, and [TESTING.md](TESTING.md) for the actual verification results and the remaining live-client checks.

## Credits and license

Original plugin by **neoarz**. [Vencord](https://github.com/Vendicated/Vencord) and [Equicord](https://github.com/Equicord/Equicord) are not affiliated with or responsible for this custom plugin. MIT License; see [LICENSE](LICENSE).

This custom client plugin can violate Discord's Terms of Service. The original project's use-at-your-own-risk notice applies.
