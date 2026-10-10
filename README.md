# NitroSniper for Vencord / Equicord

Automatically redeem gift links in the running Discord client, with optional Discord webhooks and private success notifications from your own Discord bot.

Client redemption uses Discord's own gift action. A notification is created **only when Discord invokes the success callback**. An open CAPTCHA or gift dialog is not a successful claim. The bot sends notifications; it does not redeem gifts.

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

## Delivery and claim behaviour

- Gift codes are deduplicated per account for 24 hours in the current client process (up to 5,000 remembered codes); pending redemption queue is capped at 100. A newly received link can retry a confirmed HTTP 429/5xx or recognized transport failure after at least five seconds, respecting a numeric Discord `retry_after` when provided, with at most three dispatched attempts per account/code in that window. No retries run automatically. Successes, permanent/unknown failures and unresolved actions remain deduplicated. Discarded, never-dispatched codes are released on stop; cancelling a pending retry preserves earlier attempts.
- Multiple links in a message are handled separately, including links directly wrapped in spoilers, bold, italic, underline, strikethrough or backticks. Formatting is matched in place without stripping characters from URLs. Own messages are ignored by default on fresh installations (existing explicit settings are retained).
- Received Discord gateway `MESSAGE_CREATE` events are processed using their verified envelope, so claim detection does not depend on the computer clock matching Discord. Local/optimistic messages and push-notification replay are ignored; message edits and history loads are not scanned. Gateway events replayed after reconnect count as newly received events and remain deduplicated. Invalid timestamps are rejected. Unrecognized client/event formats retain a conservative local timestamp cutoff.
- Synchronous errors and rejected action promises release the queue. Repeated callbacks are ignored. Disabling the plugin cancels queued work and suppresses stale callbacks.
- After two minutes without a callback, a warning asks you to check Discord's dialog. The next claim waits for the callback; the plugin does not bypass CAPTCHA or assume the result. Plugin toggles retain the lock on an unresolved dispatched action. Fully restart the Discord client if it never returns; a plugin toggle does not cancel a redemption already dispatched to Discord.
- A confirmed event is saved before optional metadata enrichment. The local DM outbox uses committed DataStore snapshots before transport, isolated by account, endpoint and key fingerprint, and capped at 100 events. Events expire after 24 hours. Old key/account outboxes stay isolated until expiration; they never get reassigned to a different account.
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
