# NitroSniper for Vencord / Equicord

Automatically redeem gift links in the running Discord client, with optional Discord webhooks and private success notifications from your own Discord bot.

Client redemption uses Discord's own gift action. A notification is created **only when Discord invokes the success callback**. An open CAPTCHA or gift dialog is not a successful claim. The bot sends notifications; it does not redeem gifts.

## Bot DM notifications

### For users

1. Join a server containing the notification bot and allow its DMs.
2. Run **`/notifications link`**. The bot checks DM delivery and privately returns the service URL and an account-specific key.
3. In **Settings → Vencord/Equicord → Plugins → NitroSniper**, paste the service URL and notification key, then enable **Bot DM notifications**.
4. Click **Send Test DM**, then **Check Connection** to confirm delivery.

A successful claim produces a DM with the gift type when available, time, and source-message link. The source link requires your normal permission to view that message. Failed attempts are sent only to the optional webhook. Neither notification channel exposes the gift code.

The key can send notifications only to the Discord account that created it. **Never paste the bot token or a Discord user token into the plugin.** The key is masked in settings but stored in the client's settings; keep settings exports private. Run `/notifications link` again to replace a key or `/notifications disconnect` to revoke it and cancel queued messages. Disabling notifications locally stops new events and local retries; already accepted server events may still be delivered. Disconnect to cancel those too.

| Command | Purpose |
| --- | --- |
| `/notifications link` | Verify DMs and create/rotate your key |
| `/notifications status` | See account link, queued messages and last delivery result |
| `/notifications test` | Queue a test DM from the bot |
| `/notifications disconnect` | Revoke the key and cancel queued messages |

### For the bot operator

Requires **Node.js 22.13+**; Node.js 24 is recommended. SQLite is built into Node (older releases may print an experimental warning). Run the bot on your server, separately from the client plugin. One bot process must own its database; do not run multiple replicas against the same file.

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

Existing webhook settings remain valid. Webhooks are now restricted to official Discord webhook URLs and requests have a 10-second timeout. A notification error never causes another redemption attempt.

## Delivery and claim behaviour

- Gift codes are deduplicated for 24 hours in the current client process (up to 5,000 remembered codes); pending redemption queue is capped at 100.
- Multiple links in a message are handled separately. Own messages can be ignored; old/invalid timestamps are rejected.
- Synchronous errors and rejected action promises release the queue. Repeated callbacks are ignored. Disabling the plugin cancels queued work and suppresses stale callbacks.
- After two minutes without a callback, a warning asks you to check Discord's dialog. The next claim waits for the callback; the plugin does not bypass CAPTCHA or assume the result. Restarting can clear a stuck queue, but does not cancel a redemption already dispatched to Discord.
- The local DM outbox is saved in the client's DataStore before transport, isolated by account, endpoint and key fingerprint, and capped at 100 events. Events expire after 24 hours. Old key/account outboxes stay isolated until expiration; they never get reassigned to a different account.
- The bot stores hashed keys and a durable SQLite queue, deduplicates by account/event ID, and retries transient failures with bounded exponential backoff. Event history is retained for seven days. A closed/blocked DM is terminal and appears in the status; enable DMs and send a **new test** after fixing it.
- Per-account ingestion is limited to 10 new events per minute, with 100 queued per account and 10,000 total. Duplicate retries are accepted without consuming the ingestion limit.
- HTTP **202 means saved/queued**, not delivered. Check Connection or `/notifications status` reports the actual bot delivery state.
- Delivery is at least once. Stable Discord message nonces reduce duplicates if a process crashes after sending but before marking an event delivered; Discord's nonce window is limited, so an unusually delayed retry can still duplicate a DM.
- Success is the client's reported result. A recipient's key holder can submit events for their own account; the service cannot independently prove a gift redemption. It cannot send to another account through that key.

## Tests

```sh
npm test
npm run check
```

Tests cover the full confirmed-claim → native IPC → HTTP → SQLite → DM-sender path with a simulated Discord sender, plus duplicate callbacks, restarts, account isolation, stopped plugins, queued retries, blocked DMs, revoked keys, malformed requests, URL restrictions, rate limits and response-size bounds. GitHub Actions runs them on Node.js 22 and 24.

Host verification commands after copying the root plugin files into an upstream source checkout:

```sh
pnpm testTsc
pnpm buildStandalone
```

See [TESTING.md](TESTING.md) for the actual verification results and the remaining live-client checks.

## Credits and license

Original plugin by **neoarz**. [Vencord](https://github.com/Vendicated/Vencord) and [Equicord](https://github.com/Equicord/Equicord) are not affiliated with or responsible for this custom plugin. MIT License; see [LICENSE](LICENSE).

This custom client plugin can violate Discord's Terms of Service. The original project's use-at-your-own-risk notice applies.
