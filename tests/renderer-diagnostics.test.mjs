import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTS } from './helpers.mjs';
const { createClaimDiagnostics } = await loadTS('claimDiagnostics.ts');

function fixture(t, sink) {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1_000_000 });
    const document = new EventTarget(), window = new EventTarget(), rows = [];
    document.visibilityState = 'visible'; let focused = true, online = true;
    document.hasFocus = () => focused;
    const logger = createClaimDiagnostics({ environment: { document, window, online: () => online },
        sink: sink ?? (payload => { rows.push(JSON.parse(payload)); return Promise.resolve(true); }) });
    const snapshot = () => ({ context: { ...logger.context(), claim: 12 }, fields: { active: true, pending: 2, elapsedMs: 42 } });
    logger.start(snapshot); logger.beginSession('startup'); t.after(() => logger.stop());
    return { logger, rows, document, window, focus: value => { focused = value; window.dispatchEvent(new Event(value ? 'focus' : 'blur')); },
        online: value => { online = value; window.dispatchEvent(new Event(value ? 'online' : 'offline')); } };
}

test('fresh anonymous sessions and actual visibility/focus/network transitions only', t => {
    const f = fixture(t); const original = f.logger.context().session;
    assert.deepEqual(f.rows.map(row => row.event), ['plugin_started', 'session_started']);
    f.document.visibilityState = 'hidden'; for (let i = 0; i < 10; i++) f.document.dispatchEvent(new Event('visibilitychange'));
    f.focus(false); f.focus(false); f.online(false); f.online(false);
    assert.deepEqual(f.rows.slice(2).map(row => row.event), ['visibility_changed', 'focus_changed', 'network_changed']);
    assert.ok(f.rows.slice(2).every(row => row.claim === 12 && row.active && row.pending === 2));
    f.logger.beginSession('account_changed'); assert.notEqual(f.logger.context().session, original);
    f.logger.stop(); const count = f.rows.length;
    f.focus(true); f.online(true); f.document.dispatchEvent(new Event('visibilitychange')); t.mock.timers.tick(90_000);
    assert.equal(f.rows.length, count); assert.equal(f.rows.at(-1).event, 'plugin_stopped');
});

test('normal timer ticks produce no logs; abnormal gaps emit once and at most once per minute', t => {
    const f = fixture(t); for (let i = 0; i < 12; i++) t.mock.timers.tick(5000); assert.equal(f.rows.length, 2);
    t.mock.timers.setTime(Date.now() + 90_000); t.mock.timers.tick(5000);
    const gap = f.rows.find(row => row.event === 'runtime_gap');
    assert.ok(gap.gapMs >= 90_000); assert.equal(gap.expectedMs, 5000); assert.equal(gap.claim, 12);
    t.mock.timers.setTime(Date.now() + 25_000); t.mock.timers.tick(5000);
    assert.equal(f.rows.filter(row => row.event === 'runtime_gap').length, 1);
    t.mock.timers.setTime(Date.now() + 65_000); t.mock.timers.tick(5000);
    assert.equal(f.rows.filter(row => row.event === 'runtime_gap').length, 2);
});

test('duplicate ordinary events coalesce but distinct terminal signals are retained', t => {
    const f = fixture(t);
    for (let i = 0; i < 100; i++) f.logger.record('connection_open');
    for (let claim = 1; claim <= 200; claim++) f.logger.record('on_error', { status: 500 }, { ...f.logger.context(), claim });
    assert.equal(f.rows.filter(row => row.event === 'connection_open').length, 1);
    assert.equal(f.rows.filter(row => row.event === 'on_error').length, 200);
});

for (const asyncFailure of [false, true]) test(`native ${asyncFailure ? 'rejection' : 'throw'} never escapes diagnostics`, async t => {
    const f = fixture(t, () => { if (asyncFailure) return Promise.reject(new Error('disk')); throw new Error('disk'); });
    assert.doesNotThrow(() => f.logger.record('claim_completed_success'));
    await Promise.resolve(); await Promise.resolve();
});
