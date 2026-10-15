import { MessagePayload, Routes } from 'discord.js';

// Some SDK rate-limit waits ignore AbortSignal. Release our worker promptly,
// while observing the underlying promise and retaining its aborted request signal.
function abortable(promise, signal) {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(promise).then(
            value => { cleanup(); resolve(value); },
            error => { cleanup(); reject(error); }
        );
        if (signal.aborted) { cleanup(); onAbort(); }
    });
}

// Once a test POST has been dispatched, preserve a confirmed receipt during shutdown.
// SDK bucket waits may ignore cancellation; a shared ten-second grace bounds this wait.
function testReceipt(promise, signal) {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
        let timer;
        const onAbort = () => { timer ??= setTimeout(() => reject(signal.reason), 10_000); };
        const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
        Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
}

/** Consent is checked after every SDK preparation step, before message dispatch. */
export function createDMSender(client) {
    return async (userId, options, canSend, signal, kind) => {
        try {
            if (signal?.aborted || !canSend()) return false;
            const user = await abortable(client.users.fetch(userId), signal);
            if (signal?.aborted || !canSend()) return false;
            const channel = await abortable(user.createDM(), signal);
            if (signal?.aborted || !canSend()) return false;
            const payload = MessagePayload.create(channel, options).resolveBody();
            const { body, files } = await abortable(payload.resolveFiles(), signal);
            if (signal?.aborted || !canSend()) return false;
            // The SDK honors this signal while waiting for a REST bucket as well.
            const pending = client.rest.post(Routes.channelMessages(channel.id), { body, files, signal });
            const response = await (kind === 'test' ? testReceipt(pending, signal) : abortable(pending, signal));
            // Return only native API identity, never IDs supplied in the notification event.
            if (!response || response.channel_id !== channel.id) return undefined;
            return { channelId: response.channel_id, messageId: response.id,
                botId: response.author?.id ?? client.user?.id,
                createdAt: Date.now() };
        } catch (error) {
            if (signal?.aborted || !canSend()) return false;
            throw error;
        }
    };
}

/** Internal worker adapter. No HTTP/renderer route accepts deletion targets. */
export function createTestDMDeleter(client) {
    return async (job, canDelete, signal) => {
        if (![job.bot_id, job.channel_id, job.message_id].every(id => typeof id === 'string' && /^\d{17,20}$/.test(id))
            || job.bot_id !== client.user?.id) throw Object.assign(new Error('Original bot is unavailable.'), { status: 403 });
        if (signal?.aborted || !canDelete()) return false;
        await abortable(client.rest.delete(Routes.channelMessage(job.channel_id, job.message_id), { signal }), signal);
    };
}
