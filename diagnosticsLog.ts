import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import { cleanDiagnosticRecord, TERMINAL_DIAGNOSTICS } from "./diagnosticProtocol";

interface DiagnosticsLogOptions {
    directory?: () => Promise<string>;
    maxBytes?: number;
}
const FILE_NAME = "claim-diagnostics.jsonl";
const MAX_BYTES = 512 * 1024;
const MAX_PENDING = 512;
const TERMINAL_RESERVE = 128;

/** Fixed native-owned destination; the renderer can supply a record, never a filename. */
export function createDiagnosticsLog(options: DiagnosticsLogOptions = {}) {
    const directory = options.directory ?? (async () => {
        const { app } = await import("electron");
        return join(app.getPath("userData"), "NitroSniper", "logs");
    });
    const requestedLimit = options.maxBytes;
    const maxBytes = typeof requestedLimit === "number" && Number.isSafeInteger(requestedLimit) && requestedLimit > 0
        ? Math.min(MAX_BYTES, requestedLimit) : MAX_BYTES;
    let tail: Promise<void> = Promise.resolve();
    let pending = 0;
    let ordinaryWindow = Date.now();
    let ordinaryCount = 0;

    async function size(path: string) {
        try {
            const value = await lstat(path);
            if (!value.isFile() || value.isSymbolicLink()) throw new Error("Invalid diagnostic file.");
            return value.size;
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return 0;
            throw error;
        }
    }
    async function remove(path: string) {
        try { await unlink(path); }
        catch (error: unknown) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error; }
    }
    async function move(source: string, destination: string) {
        try { await rename(source, destination); }
        catch (error: unknown) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error; }
    }
    async function write(line: string, bytes: number): Promise<boolean> {
        try {
            const dir = await directory();
            await mkdir(dir, { recursive: true, mode: 0o700 });
            const directoryInfo = await lstat(dir);
            if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) return false;
            const current = join(dir, FILE_NAME);
            const previous = `${current}.1`, oldest = `${current}.2`;
            // A stale oversized file is disposable diagnostic data; never move it into oversized history.
            for (const path of [oldest, previous, current]) if (await size(path) > maxBytes) await remove(path);
            if (await size(current) + bytes > maxBytes) {
                await remove(oldest);
                await move(previous, oldest);
                await move(current, previous);
            }
            const file = await open(current, "a", 0o600);
            try { await file.writeFile(line, "utf8"); }
            finally { await file.close(); }
            return true;
        } catch {
            // Diagnostics are best effort. Never expose I/O errors or recursively invoke the logger.
            return false;
        }
    }

    return {
        append(payload: string): Promise<boolean> {
            if (typeof payload !== "string" || payload.length > 4096 || Buffer.byteLength(payload, "utf8") > 4096) return Promise.resolve(false);
            let line: string, terminal: boolean;
            try {
                const record = cleanDiagnosticRecord(JSON.parse(payload));
                if (!record) return Promise.resolve(false);
                line = `${JSON.stringify(record)}\n`;
                terminal = TERMINAL_DIAGNOSTICS.has(record.event);
            } catch { return Promise.resolve(false); }
            const bytes = Buffer.byteLength(line, "utf8");
            if (bytes > maxBytes || pending >= MAX_PENDING || (!terminal && pending >= MAX_PENDING - TERMINAL_RESERVE)) return Promise.resolve(false);
            if (!terminal) {
                const now = Date.now();
                if (now - ordinaryWindow >= 60_000) { ordinaryWindow = now; ordinaryCount = 0; }
                if (ordinaryCount >= 120) return Promise.resolve(false);
                ordinaryCount++;
            }
            // Terminal records bypass the ordinary limiter. Hard saturation still returns false:
            // a best-effort logger must not grow memory or block the claim path without a bound.
            pending++;
            const result = tail.then(() => write(line, bytes));
            tail = result.then(() => { pending--; }, () => { pending--; });
            return result;
        },
        idle(): Promise<void> { return tail; }
    };
}

export const diagnosticsLog = createDiagnosticsLog();
