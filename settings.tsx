/*
Made with ❤️ by neoarz
I am not responsible for any damage caused by this plugin; use at your own risk
Vencord does not endorse/support this plugin (Works with Equicord as well)
dm @neoarz if u need help or have any questions
https://github.com/neoarz/NitroSniper
*/

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";
import { Button, showToast, useEffect, UserStore, useState, useStateFromStores } from "@webpack/common";

import { accountNotificationSettings, updateAccountNotificationSettings } from "./accountSettings";
import { DirectBotPanel } from "./directBotPanel";
import { checkBotConnection, getNotificationStatus, sendTestDM, subscribeNotifications } from "./notifications";
import { sendTestWebhook } from "./webhook";

function TestWebhookButton() {
    const userId = useStateFromStores([UserStore], () => UserStore.getCurrentUser()?.id ?? "");
    settings.use(["notificationAccounts"]);
    const { webhookUrl } = accountNotificationSettings(settings.store, userId);
    const [busy, setBusy] = useState(false);
    return <Button disabled={busy || !webhookUrl.trim()} onClick={async () => {
        setBusy(true);
        try { await sendTestWebhook(webhookUrl); if (UserStore.getCurrentUser()?.id === userId) showToast("Test webhook delivered.", "success"); }
        catch (error) { if (UserStore.getCurrentUser()?.id === userId) showToast(error instanceof Error ? error.message : "Webhook test failed.", "failure"); }
        finally { setBusy(false); }
    }}>{busy ? "Sending…" : "Send Test Webhook"}</Button>;
}

function ServiceNotificationPanel() {
    const userId = useStateFromStores([UserStore], () => UserStore.getCurrentUser()?.id ?? "");
    settings.use(["notificationAccounts"]);
    const values = accountNotificationSettings(settings.store, userId);
    const [status, setStatus] = useState(getNotificationStatus);
    const [busy, setBusy] = useState(false);
    useEffect(() => subscribeNotifications(() => setStatus(getNotificationStatus())), []);
    const run = async (action: () => Promise<void>) => {
        setBusy(true);
        try { await action(); }
        catch (error) { if (UserStore.getCurrentUser()?.id === userId) showToast(error instanceof Error ? error.message : "Notification action failed.", "failure"); }
        finally { setBusy(false); }
    };
    const disabled = busy || !values.botNotificationsEnabled || !values.botServiceUrl.trim() || !values.botNotificationKey.trim();
    return <div style={{ display: "grid", gap: 12, color: "var(--text-default, var(--text-normal))" }}>
        <div>Run <strong>/notifications link</strong> with your bot, paste its service URL and key below, enable DM notifications, then send a test.</div>
        <label style={{ display: "grid", gap: 6 }}>Service URL
            <input aria-label="Service URL" value={values.botServiceUrl} onChange={event => updateAccountNotificationSettings(settings.store, userId, { botServiceUrl: event.currentTarget.value })} />
        </label>
        <label style={{ display: "grid", gap: 6 }}>Notification key
            <input type="password" autoComplete="off" spellCheck={false}
                aria-label="Notification key" placeholder="Paste the key from /notifications link"
                value={values.botNotificationKey} onChange={event => updateAccountNotificationSettings(settings.store, userId, { botNotificationKey: event.currentTarget.value })}
                style={{ padding: 10, borderRadius: 4, border: "1px solid var(--input-border, transparent)", color: "var(--text-default, var(--text-normal))", background: "var(--input-background, var(--background-tertiary))" }} />
        </label>
        <div role="status" aria-live="polite">{values.botNotificationsEnabled ? status.message : "DM notifications disabled"} • {status.pending} pending locally</div>
        {status.unsaved > 0 && <div role="alert">{status.unsaved} confirmed claim notification(s) could not be saved for this connection. These notifications will not be sent. Check the bot connection and local storage.</div>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button disabled={disabled} onClick={() => void run(sendTestDM)}>Send Test DM</Button>
            <Button disabled={disabled} onClick={() => void run(checkBotConnection)}>Check Connection</Button>
        </div>
        <div style={{ fontSize: 13 }}>Test messages are automatically deleted after 30 seconds. Only successful claims trigger a permanent DM. To revoke access, run <strong>/notifications disconnect</strong>. This key is stored in your client settings; keep settings exports private.</div>
    </div>;
}

function BotNotificationPanel() {
    const userId = useStateFromStores([UserStore], () => UserStore.getCurrentUser()?.id ?? "");
    settings.use(["notificationAccounts"]);
    const values = accountNotificationSettings(settings.store, userId);
    if (!userId) return <div>Sign in to Discord to configure this account's notifications.</div>;
    return <div style={{ display: "grid", gap: 12 }}>
        <div>Notification destinations belong to the current Discord account.</div>
        <label style={{ display: "grid", gap: 6 }}>Discord webhook URL
            <input aria-label="Discord webhook URL" value={values.webhookUrl} onChange={event => updateAccountNotificationSettings(settings.store, userId, { webhookUrl: event.currentTarget.value })} />
        </label>
        <TestWebhookButton key={`webhook:${userId}`} />
        <label><input type="checkbox" checked={values.botNotificationsEnabled} onChange={event => updateAccountNotificationSettings(settings.store, userId, { botNotificationsEnabled: event.currentTarget.checked })} /> Enable bot DM notifications</label>
        <label>DM setup <select value={values.botNotificationMode} onChange={event => updateAccountNotificationSettings(settings.store, userId, { botNotificationMode: event.currentTarget.value === "service" ? "service" : "direct" })}>
            <option value="direct">Bot token (recommended)</option><option value="service">External notification service</option>
        </select></label>
        {values.botNotificationMode === "service" ? <ServiceNotificationPanel key={userId} /> : <DirectBotPanel key={userId} />}
    </div>;
}

export const settings = definePluginSettings({
    ignoreOwnGiftLinks: {
        type: OptionType.BOOLEAN,
        description: "Do not redeem Nitro gift links from messages sent by you.",
        default: true
    },
    webhookUrl: {
        type: OptionType.STRING,
        description: "Discord webhook URL for successful and failed redeem attempts. Leave empty to disable.",
        default: "", hidden: true
    },
    testWebhook: {
        type: OptionType.COMPONENT,
        description: "Test webhook delivery.",
        component: TestWebhookButton, hidden: true
    },
    botNotificationsEnabled: {
        type: OptionType.BOOLEAN,
        description: "Bot DM notifications — send a private notification after each successful claim.",
        default: false, hidden: true
    },
    botNotificationMode: {
        type: OptionType.SELECT,
        description: "DM setup — bot token is the simplest option.",
        options: [{ label: "Bot token (recommended)", value: "direct", default: true }, { label: "External notification service (advanced)", value: "service" }], hidden: true
    },
    botDirectAccounts: {
        type: OptionType.STRING, description: "Saved bot connection details (no tokens).", default: "", hidden: true
    },
    notificationAccounts: {
        type: OptionType.STRING, description: "Account-owned notification configuration.", default: "", hidden: true
    },
    botServiceUrl: {
        type: OptionType.STRING,
        description: "Notification service URL provided by /notifications link (HTTPS, no extra path).",
        default: "", hidden: true
    },
    botNotificationKey: {
        type: OptionType.STRING,
        description: "Account notification key.",
        default: "",
        hidden: true
    },
    botNotifications: {
        type: OptionType.COMPONENT,
        description: "Connect and test your notification bot.",
        component: BotNotificationPanel
    }
});
