import type { PluginNative } from "@utils/types";
import { Button, showToast, useEffect, useRef, UserStore, useState, useStateFromStores } from "@webpack/common";

import { accountNotificationSettings, updateAccountNotificationSettings } from "./accountSettings";
import type { BotConnection } from "./directBot";
import { getNotificationStatus, sendTestDM, subscribeNotifications } from "./notifications";
import { settings } from "./settings";

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
    const [forceDisconnectOwner, setForceDisconnectOwner] = useState("");
    settings.use(["notificationAccounts", "botDirectAccounts"]);
    const values = accountNotificationSettings(settings.store, userId);
    let savedConnection = false;
    try { savedConnection = !!JSON.parse(settings.store.botDirectAccounts || "{}")[userId]?.credentialId; }
    catch { /* Native storage remains authoritative; unreadable public metadata contains no token. */ }
    const canDisconnect = !!bot || savedConnection || /secure token storage is unavailable/i.test(error);
    useEffect(() => subscribeNotifications(() => setStatus(getNotificationStatus())), []);
    useEffect(() => {
        let current = true;
        const expectedRevision = ++revision.current;
        setToken(""); setBot(null); setError(""); setForceDisconnectOwner("");
        if (userId) void Promise.resolve().then(() => helper().getDirectBotStatus(userId)).then(value => {
            if (current && expectedRevision === revision.current) { setBot(value); remember(userId, value); if (value?.warning) setError(value.warning); }
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
        setForceDisconnectOwner("");
        const input = token; setToken("");
        const value = await helper().connectDirectBot(userId, input);
        remember(userId, value);
        updateAccountNotificationSettings(settings.store, userId, { botNotificationsEnabled: true });
        if (UserStore.getCurrentUser()?.id === userId) {
            setBot(value);
            if (value.warning) setError(value.warning);
            showToast(`Connected to ${value.botName}. Send a test DM to verify delivery.`, "success");
        }
    };
    const disconnect = async (force = false) => {
        if (force && (forceDisconnectOwner !== userId || UserStore.getCurrentUser()?.id !== userId)) return;
        const result = await helper().disconnectDirectBot(userId, force);
        if (result?.disconnected === false) {
            if (UserStore.getCurrentUser()?.id === userId) {
                setError(result.warning ?? "Pending test messages must finish cleanup before disconnect.");
                setForceDisconnectOwner(userId);
            }
            return;
        }
        remember(userId, null);
        updateAccountNotificationSettings(settings.store, userId, { botNotificationsEnabled: false });
        if (UserStore.getCurrentUser()?.id === userId) {
            setBot(null); setToken(""); setForceDisconnectOwner("");
            if (result?.warning) setError(result.warning);
        }
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
            <Button disabled={busy || !userId || !token.trim()} onClick={() => run(connect)}>{busy ? "Working…" : bot ? "Replace bot" : "Connect bot"}</Button>
            <Button disabled={busy || !bot || !values.botNotificationsEnabled} onClick={() => run(sendTestDM)}>Send Test DM</Button>
            <Button disabled={busy || !userId || !canDisconnect} onClick={() => run(() => disconnect())}>Disconnect</Button>
            {forceDisconnectOwner === userId && userId && <Button disabled={busy} onClick={() => run(() => disconnect(true))}>Force disconnect — test DMs may remain</Button>}
            {/secure credential storage is corrupted/i.test(error) && <Button disabled={busy || !userId} onClick={() => void run(async () => {
                await helper().recoverDirectBotVault(userId); remember(userId, null);
                if (UserStore.getCurrentUser()?.id === userId) { setBot(null); setError("Secure storage recovered. Reconnect your bot."); }
            })}>Recover secure storage</Button>}
        </div>
        {error && <div role="alert">{error}</div>}
        <div role="status" aria-live="polite">{values.botNotificationsEnabled ? status.message : "DM notifications disabled"} • {status.pending} pending locally</div>
        {status.unsaved > 0 && <div role="alert">{status.unsaved} claim notification(s) could not be saved.</div>}
        <div style={{ fontSize: 13 }}>The token is encrypted locally and is never displayed again or included in settings exports. Test DMs are deleted after their full 30-second lifetime, including after restart with the same valid bot connected. Disconnect keeps the connection while test cleanup is pending. Explicit force disconnect removes the token and may leave these tests in Discord.</div>
    </div>;
}
