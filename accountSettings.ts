export interface AccountNotificationSettings {
    webhookUrl: string;
    botNotificationsEnabled: boolean;
    botNotificationMode: "direct" | "service";
    botServiceUrl: string;
    botNotificationKey: string;
}
interface SettingsStore extends Partial<Omit<AccountNotificationSettings, "botNotificationMode">> {
    botNotificationMode?: string;
    notificationAccounts?: string;
    botDirectAccounts?: string;
}
interface Accounts { version: 1; accounts: Record<string, AccountNotificationSettings>; }
const snowflake = /^\d{17,20}$/;
const defaults = (): AccountNotificationSettings => ({ webhookUrl: "", botNotificationsEnabled: false, botNotificationMode: "direct", botServiceUrl: "", botNotificationKey: "" });
function clean(value: SettingsStore): AccountNotificationSettings {
    return { webhookUrl: typeof value.webhookUrl === "string" ? value.webhookUrl.slice(0, 2048) : "",
        botNotificationsEnabled: value.botNotificationsEnabled === true,
        botNotificationMode: value.botNotificationMode === "service" ? "service" : "direct",
        botServiceUrl: typeof value.botServiceUrl === "string" ? value.botServiceUrl.slice(0, 2048) : "",
        botNotificationKey: typeof value.botNotificationKey === "string" ? value.botNotificationKey.slice(0, 256) : "" };
}
function read(store: SettingsStore, userId: string): Accounts {
    if (!store.notificationAccounts) {
        const legacy = clean(store);
        if (legacy.botNotificationMode === "direct" && !store.botDirectAccounts && legacy.botServiceUrl.trim() && legacy.botNotificationKey.trim()) legacy.botNotificationMode = "service";
        const data: Accounts = { version: 1, accounts: { [userId]: legacy } };
        // Publish the migration marker and its sole owner before clearing legacy values.
        store.notificationAccounts = JSON.stringify(data);
        store.webhookUrl = ""; store.botServiceUrl = ""; store.botNotificationKey = "";
        store.botNotificationsEnabled = false; store.botNotificationMode = "direct";
        return data;
    }
    try {
        if (store.notificationAccounts.length > 1_000_000) throw new Error();
        const value = JSON.parse(store.notificationAccounts);
        if (value?.version !== 1 || !value.accounts || typeof value.accounts !== "object" || Array.isArray(value.accounts) || Object.keys(value.accounts).length > 100) throw new Error();
        const accounts: Accounts["accounts"] = {};
        for (const [id, config] of Object.entries(value.accounts)) {
            if (!snowflake.test(id) || !config || typeof config !== "object" || Array.isArray(config)) throw new Error();
            accounts[id] = clean(config);
        }
        return { version: 1, accounts };
    } catch { throw new Error("Saved account notification settings are invalid. Restore a valid settings backup."); }
}
export function accountNotificationSettings(store: SettingsStore, userId: string): AccountNotificationSettings {
    if (!snowflake.test(userId)) return defaults();
    return { ...(read(store, userId).accounts[userId] ?? defaults()) };
}
export function updateAccountNotificationSettings(store: SettingsStore, userId: string, patch: Partial<AccountNotificationSettings>) {
    if (!snowflake.test(userId)) throw new Error("Sign in to Discord first.");
    const data = read(store, userId);
    if (!data.accounts[userId] && Object.keys(data.accounts).length >= 100) throw new Error("Too many saved notification accounts.");
    data.accounts[userId] = clean({ ...(data.accounts[userId] ?? defaults()), ...patch });
    store.notificationAccounts = JSON.stringify(data);
}
