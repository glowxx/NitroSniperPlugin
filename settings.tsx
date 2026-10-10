/*
Made with ❤️ by neoarz
I am not responsible for any damage caused by this plugin; use at your own risk
Vencord does not endorse/support this plugin (Works with Equicord as well)
dm @neoarz if u need help or have any questions
https://github.com/neoarz/NitroSniper
*/

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";
import { Button, showToast, Toasts, useEffect, useState } from "@webpack/common";

import { DirectBotPanel } from "./directBotPanel";

import { checkBotConnection, getNotificationStatus, sendTestDM, subscribeNotifications } from "./notifications";
import { sendTestWebhook } from "./webhook";

function TestWebhookButton() {
    const { webhookUrl } = settings.use(["webhookUrl"]);
    const [busy, setBusy] = useState(false);
    return <Button disabled={busy || !webhookUrl.trim()} onClick={async () => {
        setBusy(true);
        try { await sendTestWebhook(webhookUrl); showToast("Test webhook delivered.", Toasts.Type.SUCCESS); }
        catch (error) { showToast(error instanceof Error ? error.message : "Webhook test failed.", Toasts.Type.FAILURE); }
        finally { setBusy(false); }
    }}>{busy ? "Sending…" : "Send Test Webhook"}</Button>;
}

function ServiceNotificationPanel() {
    const values = settings.use(["botNotificationsEnabled", "botServiceUrl", "botNotificationKey"]);
    const [status, setStatus] = useState(getNotificationStatus);
    const [busy, setBusy] = useState(false);
    useEffect(() => subscribeNotifications(() => setStatus(getNotificationStatus())), []);
    const run = async (action: () => Promise<void>) => {
        setBusy(true);
        try { await action(); }
        catch (error) { showToast(error instanceof Error ? error.message : "Notification action failed.", Toasts.Type.FAILURE); }
        finally { setBusy(false); }
    };
    const disabled = busy || !values.botNotificationsEnabled || !values.botServiceUrl.trim() || !values.botNotificationKey.trim();
    return <div style={{ display: "grid", gap: 12, color: "var(--text-default, var(--text-normal))" }}>
        <div>Run <strong>/notifications link</strong> with your bot, paste its service URL and key below, enable DM notifications, then send a test.</div>
        <label style={{ display: "grid", gap: 6 }}>Service URL
            <input aria-label="Service URL" value={values.botServiceUrl} onChange={event => { settings.store.botServiceUrl = event.currentTarget.value; }} />
        </label>
        <label style={{ display: "grid", gap: 6 }}>Notification key
            <input type="password" autoComplete="off" spellCheck={false}
                aria-label="Notification key" placeholder="Paste the key from /notifications link"
                value={values.botNotificationKey} onChange={event => { settings.store.botNotificationKey = event.currentTarget.value; }}
                style={{ padding: 10, borderRadius: 4, border: "1px solid var(--input-border, transparent)", color: "var(--text-default, var(--text-normal))", background: "var(--input-background, var(--background-tertiary))" }} />
        </label>
        <div role="status" aria-live="polite">{values.botNotificationsEnabled ? status.message : "DM notifications disabled"} • {status.pending} pending locally</div>
        {status.unsaved > 0 && <div role="alert">{status.unsaved} confirmed claim notification(s) could not be saved for this connection. These notifications will not be sent. Check the bot connection and local storage.</div>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button disabled={disabled} onClick={() => void run(sendTestDM)}>Send Test DM</Button>
            <Button disabled={disabled} onClick={() => void run(checkBotConnection)}>Check Connection</Button>
        </div>
        <div style={{ fontSize: 13 }}>Only successful claims trigger a DM. Failed attempts stay in your webhook. To revoke access, run <strong>/notifications disconnect</strong>. This key is stored in your client settings; keep settings exports private.</div>
    </div>;
}

function BotNotificationPanel() {
    const values = settings.use(["botNotificationMode"]);
    return values.botNotificationMode === "service" ? <ServiceNotificationPanel /> : <DirectBotPanel />;
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
        default: ""
    },
    testWebhook: {
        type: OptionType.COMPONENT,
        description: "Test webhook delivery.",
        component: TestWebhookButton
    },
    botNotificationsEnabled: {
        type: OptionType.BOOLEAN,
        description: "Bot DM notifications — send a private notification after each successful claim.",
        default: false
    },
    botNotificationMode: {
        type: OptionType.SELECT,
        description: "DM setup — bot token is the simplest option.",
        options: [{ label: "Bot token (recommended)", value: "direct", default: true }, { label: "External notification service (advanced)", value: "service" }]
    },
    botDirectAccounts: {
        type: OptionType.STRING, description: "Saved bot connection details (no tokens).", default: "", hidden: true
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
