import type { PluginNative } from "@utils/types";
import { Button, Toasts, UserStore, showToast, useEffect, useState, useStateFromStores, useRef } from "@webpack/common";

import { getNotificationStatus, sendTestDM, subscribeNotifications } from "./notifications";
import { settings } from "./settings";
import type { BotConnection } from "./directBot";

function helper() {
    const value = (globalThis as any).VencordNative?.pluginHelpers?.NitroSniper as PluginNative<typeof import("./native")> | undefined;
    if (!value?.connectDirectBot) throw new Error("Rebuild and fully restart your desktop Discord client to configure the bot.");
    return value;
}
function remember(userId: string, value: BotConnection | null) {
    let accounts: Record<string, BotConnection> = {};
    try {
        const stored = JSON.parse(settings.store.botDirectAccounts || "{}");
        if (stored && typeof stored === "object" && !Array.isArray(stored)) accounts = stored;
    } catch { /* Recover public connection metadata. */ }
    if (value) accounts[userId] = value; else delete accounts[userId];
    settings.store.botDirectAccounts = JSON.stringify(accounts);
}

export function DirectBotPanel() {
    const userId = useStateFromStores([UserStore], () => UserStore.getCurrentUser()?.id ?? "");
    const revision = useRef(0);
    const [token, setToken] = useState("");
    const [bot, setBot] = useState<BotConnection | null>(null);
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState(getNotificationStatus);
    const [error, setError] = useState("");
    const values = settings.use(["botNotificationsEnabled", "botDirectAccounts"]);
    useEffect(() => subscribeNotifications(() => setStatus(getNotificationStatus())), []);
    useEffect(() => {
        let current = true;
        const expectedRevision = ++revision.current;
        setToken(""); setBot(null); setError("");
        if (userId) void Promise.resolve().then(() => helper().getDirectBotStatus(userId)).then(value => {
            if (current && expectedRevision === revision.current) { setBot(value); remember(userId, value); }
        }).catch(reason => { if (current && expectedRevision === revision.current) setError(reason instanceof Error ? reason.message : "Could not load the bot connection."); });
        return () => { current = false; };
    }, [userId]);
    const run = async (action: () => Promise<void>) => {
        revision.current++;
        setBusy(true); setError("");
        try { await action(); }
        catch (reason) { if (UserStore.getCurrentUser()?.id === userId) setError(reason instanceof Error ? reason.message : "Bot connection failed."); }
        finally { setBusy(false); }
    };
    const connect = async () => {
        const input = token; setToken("");
        const value = await helper().connectDirectBot(userId, input);
        remember(userId, value);
        if (UserStore.getCurrentUser()?.id === userId) {
            setBot(value); settings.store.botNotificationsEnabled = true;
            showToast(`Connected to ${value.botName}. Send a test DM to verify delivery.`, Toasts.Type.SUCCESS);
        }
    };
    const disconnect = async () => {
        await helper().disconnectDirectBot(userId);
        remember(userId, null);
        if (UserStore.getCurrentUser()?.id === userId) { setBot(null); setToken(""); settings.store.botNotificationsEnabled = false; }
    };
    return <div style={{ display: "grid", gap: 12 }}>
        <div>Paste your bot token and click Connect. The bot sends DMs directly from this desktop client. No server or slash-command setup is needed.</div>
        <div>Use a token from the <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">Discord Developer Portal</a>. Invite the bot to a server you belong to and allow its DMs.</div>
        {bot && <a href={`https://discord.com/oauth2/authorize?client_id=${bot.botId}&scope=bot&permissions=0`} target="_blank" rel="noreferrer">Invite {bot.botName} to a server</a>}
        <div role="status">{bot ? `Connected: ${bot.botName}` : "No bot connected for this Discord account"}</div>
        <label style={{ display: "grid", gap: 6 }}>Bot token{bot ? " (paste a new token to replace the bot)" : ""}
            <input type="password" autoComplete="off" spellCheck={false} disabled={busy || !userId}
                aria-label="Bot token" placeholder={bot ? "Token saved — hidden" : "Paste bot token"}
                value={token} onChange={event => setToken(event.currentTarget.value)}
                style={{ padding: 10, borderRadius: 4, border: "1px solid var(--input-border, transparent)", color: "var(--text-default, var(--text-normal))", background: "var(--input-background, var(--background-tertiary))" }} />
        </label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button disabled={busy || !userId || !token.trim()} onClick={() => void run(connect)}>{busy ? "Working…" : bot ? "Replace bot" : "Connect bot"}</Button>
            <Button disabled={busy || !bot || !values.botNotificationsEnabled} onClick={() => void run(sendTestDM)}>Send Test DM</Button>
            <Button disabled={busy || !bot} onClick={() => void run(disconnect)}>Disconnect</Button>
        </div>
        {error && <div role="alert">{error}</div>}
        <div role="status" aria-live="polite">{values.botNotificationsEnabled ? status.message : "DM notifications disabled"} • {status.pending} pending locally</div>
        {status.unsaved > 0 && <div role="alert">{status.unsaved} claim notification(s) could not be saved.</div>}
        <div style={{ fontSize: 13 }}>The token is encrypted locally and is never displayed again or included in settings exports. Keep Discord open for queued DMs to send. Disconnect removes the saved token.</div>
    </div>;
}
