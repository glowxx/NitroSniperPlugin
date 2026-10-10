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

/** Consent is checked after every SDK preparation step, before message dispatch. */
export function createDMSender(client) {
    return async (userId, options, canSend, signal) => {
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
            await abortable(client.rest.post(Routes.channelMessages(channel.id), { body, files, signal }), signal);
        } catch (error) {
            if (signal?.aborted || !canSend()) return false;
            throw error;
        }
    };
}
