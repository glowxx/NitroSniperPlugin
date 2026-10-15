import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { loadTS } from './helpers.mjs';

const { createDiagnosticsLog } = await loadTS('diagnosticsLog.ts');
const basename = 'claim-diagnostics.jsonl';
const record = (claim = 1, event = 'claim_completed_success') => ({
    ts: '2026-10-15T10:20:30.000Z', session: '12345678-abcd-4567-890a-123456789abc',
    level: 'info', event, claim
});
async function fixture(t, maxBytes) {
    const directory = await mkdtemp(join(process.cwd(), '.diagnostics-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const make = () => createDiagnosticsLog({ directory: async () => directory, maxBytes });
    return { directory, make, log: make(), file: suffix => join(directory, basename + (suffix ?? '')) };
}
const lines = async path => (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));

test('concurrent terminal events serialize as complete JSONL in admission order without an ordinary rate limit', async t => {
    const f = await fixture(t);
    const results = await Promise.all(Array.from({ length: 250 }, (_, index) => f.log.append(JSON.stringify(record(index)))));
    await f.log.idle();
    assert.ok(results.every(Boolean));
    const saved = await lines(f.file());
    assert.deepEqual(saved.map(row => row.claim), Array.from({ length: 250 }, (_, index) => index));
});

test('rotation uses actual JSONL bytes, retains only three bounded files and removes oldest events', async t => {
    const bytes = Buffer.byteLength(JSON.stringify(record()) + '\n');
    const f = await fixture(t, bytes * 2);
    for (let claim = 1; claim <= 7; claim++) assert.equal(await f.log.append(JSON.stringify(record(claim))), true);
    assert.deepEqual((await readdir(f.directory)).sort(), [basename, `${basename}.1`, `${basename}.2`]);
    assert.deepEqual((await lines(f.file())).map(row => row.claim), [7]);
    assert.deepEqual((await lines(f.file('.1'))).map(row => row.claim), [5, 6]);
    assert.deepEqual((await lines(f.file('.2'))).map(row => row.claim), [3, 4]);
    for (const suffix of ['', '.1', '.2']) assert.ok((await stat(f.file(suffix))).size <= bytes * 2);
});

test('reopening the writer appends to existing logs and retains their rotation history', async t => {
    const bytes = Buffer.byteLength(JSON.stringify(record()) + '\n');
    const f = await fixture(t, bytes * 2);
    for (let claim = 1; claim <= 3; claim++) await f.log.append(JSON.stringify(record(claim)));
    const reopened = f.make();
    assert.equal(await reopened.append(JSON.stringify(record(4))), true);
    assert.deepEqual((await lines(f.file())).map(row => row.claim), [3, 4]);
    assert.deepEqual((await lines(f.file('.1'))).map(row => row.claim), [1, 2]);
});

test('native validation rejects malformed, oversized and invalid records while discarding private extras', async t => {
    const f = await fixture(t);
    for (const payload of ['{', 'null', '[]', JSON.stringify({ ...record(), event: 'arbitrary' }), JSON.stringify({ ...record(), session: 'account-id' }), JSON.stringify({ ...record(), private: '🔑'.repeat(1100) })]) {
        assert.equal(await f.log.append(payload), false);
    }
    const payload = { ...record(), status: 429, retryAfter: 12, token: 'private-token', giftCode: 'private-gift-code', userId: '123456789012345678', message: 'private-message', stack: 'private-stack', body: { authorization: 'private-auth' }, reason: 'private-reason' };
    assert.equal(await f.log.append(JSON.stringify(payload)), true);
    const saved = await lines(f.file());
    assert.deepEqual(saved, [{ ...record(), status: 429, retryAfter: 12 }]);
    assert.equal((await readFile(f.file(), 'utf8')).includes('private-'), false);
});

test('ordinary flood is bounded and cannot consume terminal admissions', async t => {
    const f = await fixture(t);
    const ordinary = Array.from({ length: 1000 }, (_, index) => f.log.append(JSON.stringify(record(index, 'claim_pending_checkpoint'))));
    const terminals = Array.from({ length: 128 }, (_, index) => f.log.append(JSON.stringify(record(index + 1000))));
    const ordinaryResults = await Promise.all(ordinary), terminalResults = await Promise.all(terminals);
    assert.equal(ordinaryResults.filter(Boolean).length, 120);
    assert.ok(terminalResults.every(Boolean));
    const saved = await lines(f.file());
    assert.equal(saved.filter(row => row.event === 'claim_completed_success').length, 128);
});

test('hard saturation rejects further work best effort while reserving 128 terminal places', async t => {
    const f = await fixture(t);
    const initial = Array.from({ length: 384 }, (_, index) => f.log.append(JSON.stringify(record(index))));
    const ordinary = f.log.append(JSON.stringify(record(9000, 'claim_pending_checkpoint')));
    const reserved = Array.from({ length: 128 }, (_, index) => f.log.append(JSON.stringify(record(index + 384))));
    const overflow = f.log.append(JSON.stringify(record(9001)));
    assert.equal(await ordinary, false); assert.equal(await overflow, false);
    assert.ok((await Promise.all(initial)).every(Boolean)); assert.ok((await Promise.all(reserved)).every(Boolean));
    assert.equal((await lines(f.file())).length, 512);
});

test('I/O failures return false without throwing, exposing raw errors or poisoning the serialized writer', async t => {
    const f = await fixture(t), blocked = join(f.directory, 'not-a-directory');
    await writeFile(blocked, 'file');
    let target = blocked;
    const log = createDiagnosticsLog({ directory: async () => target });
    assert.equal(await log.append(JSON.stringify(record())), false);
    await log.idle();
    target = f.directory;
    assert.equal(await log.append(JSON.stringify(record(2))), true);
    assert.equal((await lines(f.file()))[0].claim, 2);
});

test('a record larger than the configured file size is rejected without growing files', async t => {
    const f = await fixture(t, 64);
    assert.equal(await f.log.append(JSON.stringify(record())), false);
    assert.deepEqual(await readdir(f.directory), []);
});

test('oversized stale files are discarded and options cannot raise the native 512 KiB ceiling', async t => {
    const f = await fixture(t, 1024 * 1024);
    await writeFile(f.file(), 'x'.repeat(512 * 1024));
    await writeFile(f.file('.1'), 'x'.repeat(512 * 1024 + 1));
    await writeFile(f.file('.2'), 'x'.repeat(512 * 1024 + 1));
    assert.equal(await f.log.append(JSON.stringify(record())), true);
    assert.deepEqual((await readdir(f.directory)).sort(), [basename, `${basename}.1`]);
    assert.equal((await stat(f.file('.1'))).size, 512 * 1024);
    assert.equal((await lines(f.file()))[0].event, 'claim_completed_success');
});

test('the singleton uses the native Electron userData location without renderer path input', async t => {
    const f = await fixture(t);
    globalThis.nsDiagnosticsDirectory = f.directory;
    t.after(() => { delete globalThis.nsDiagnosticsDirectory; });
    const { diagnosticsLog } = await loadTS('diagnosticsLog.ts', {
        electron: 'export const app={getPath:name=>{if(name!=="userData")throw new Error("bad path");return globalThis.nsDiagnosticsDirectory;}};'
    });
    assert.equal(await diagnosticsLog.append(JSON.stringify(record())), true);
    const saved = await lines(join(f.directory, 'NitroSniper', 'logs', basename));
    assert.deepEqual(saved, [record()]);
});
