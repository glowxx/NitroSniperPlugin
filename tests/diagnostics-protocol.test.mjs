import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTS } from './helpers.mjs';
const { cleanDiagnosticRecord, diagnosticError } = await loadTS('diagnosticProtocol.ts');
const session = '12345678-1234-4123-8123-123456789abc';

test('diagnostics whitelist drops private contents and arbitrary error text, preserving numeric evidence', () => {
    const secret = 'bot-token webhook-url service-key rqdata gift-code';
    const error = { name: secret, message: secret.repeat(100), stack: secret, status: 429, code: 20028, retryAfter: 12.5,
        body: { captcha_key: secret, retry_after: 100 }, token: secret };
    const record = cleanDiagnosticRecord({ ts: new Date().toISOString(), session, event: 'on_error', level: 'warn', claim: 1,
        ...diagnosticError(error), message: secret, giftCode: secret, userId: '123456789012345678', visibility: 'hidden', focused: false });
    assert.equal(record.status, 429); assert.equal(record.apiCode, 20028); assert.equal(record.retryAfter, 12.5);
    assert.equal(record.errorName, 'Error'); assert.equal(record.focused, false);
    assert.equal(JSON.stringify(record).includes(secret), false);
    assert.equal('message' in record, false); assert.equal('userId' in record, false);
});

test('diagnostics rejects invalid envelopes and cannot persist arbitrary event/session/reason strings', () => {
    const base = { ts: new Date().toISOString(), session, event: 'claim_dispatched', level: 'info', claim: 1 };
    assert.ok(cleanDiagnosticRecord(base));
    for (const patch of [{ session: '123456789012345678' }, { event: 'private-secret' }, { ts: 'private-secret' }, { level: 'private-secret' }]) {
        assert.equal(cleanDiagnosticRecord({ ...base, ...patch }), null);
    }
    const clean = cleanDiagnosticRecord({ ...base, reason: 'private-secret', errorName: 'private-secret', pending: Infinity });
    assert.equal('reason' in clean, false); assert.equal('errorName' in clean, false); assert.equal('pending' in clean, false);
});

test('hostile error getters cannot throw through logging or expose unknown transport codes', () => {
    assert.doesNotThrow(() => diagnosticError({ get status() { throw new Error('secret'); } }));
    assert.equal(JSON.stringify(diagnosticError({ name: 'TypeError', code: 'private-secret', message: 'private-secret' })).includes('private-secret'), false);
    assert.equal(diagnosticError({ body: { retry_after: 6.25 } }).retryAfter, 6.25);
});
