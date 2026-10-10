/*
Made with ❤️ by neoarz
I am not responsible for any damage caused by this plugin; use at your own risk
Vencord does not endorse/support this plugin (Works with Equicord as well)
dm @neoarz if u need help or have any questions
https://github.com/neoarz/NitroSniper
*/

import type { PluginNative } from "@utils/types";

let activeLookups = 0;
const MAX_LOOKUPS = 4;

export async function resolveGiftType(code: string): Promise<string | null> {
    if (activeLookups >= MAX_LOOKUPS) return null;
    activeLookups++;
    try {
        const helper = (globalThis as any).VencordNative?.pluginHelpers?.NitroSniper as PluginNative<typeof import("./native")> | undefined;
        if (!helper?.resolveGiftMetadata) return null;
        const name = await helper.resolveGiftMetadata(code);
        return typeof name === "string" ? name.slice(0, 200) || null : null;
    } catch {
        return null;
    } finally { activeLookups--; }
}
