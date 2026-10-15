import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTS } from './helpers.mjs';

const user = '123456789012345678', other = '234567890123456789';
const secret = { credentialId: 'connection', botId: other, botName: 'Test Bot', token: 'test-token-with-no-network-access' };
async function fixture(t) {
    const dir = await mkdtemp(join(tmpdir(), 'nitrosniper-vault-recovery-'));
    const state = { dir, available: true, backend: 'dpapi', decryptions: 0 };
    globalThis.nsRecovery = state;
    const mod = await loadTS('directBot.ts', { electron: `export const app={getPath:()=>globalThis.nsRecovery.dir}; export const safeStorage={isEncryptionAvailable:()=>globalThis.nsRecovery.available,getSelectedStorageBackend:()=>globalThis.nsRecovery.backend,encryptString:text=>Buffer.from([...text].reverse().join('')),decryptString:bytes=>{globalThis.nsRecovery.decryptions++;return [...bytes.toString()].reverse().join('')}};` });
    const path = join(dir, 'NitroSniper', 'bot-credentials.json');
    await mkdir(join(dir, 'NitroSniper'));
    t.after(async () => { await rm(dir, { recursive: true, force: true }); delete globalThis.nsRecovery; });
    return { mod, state, path };
}
for (const contents of ['{truncated', '[]', JSON.stringify({ [user]: 'invalid structure' }), 'x'.repeat(1_000_001)]) {
    test(`corrupted vault is preserved until deliberate recovery (${contents.length} bytes)`, async t => {
        const f = await fixture(t); await writeFile(f.path, contents);
        const vault = f.mod.encryptedVault();
        await assert.rejects(vault.get(user), /corrupt/i);
        await assert.rejects(vault.set(user, secret), /corrupt/i);
        assert.equal(await readFile(f.path, 'utf8'), contents);
        await vault.recover(user);
        const files = await readdir(join(f.state.dir, 'NitroSniper'));
        const backup = files.find(file => file.startsWith('bot-credentials.json.quarantine-'));
        assert.ok(backup); assert.equal(await readFile(join(f.state.dir, 'NitroSniper', backup), 'utf8'), contents);
        await vault.set(user, secret);
        assert.deepEqual(await f.mod.encryptedVault().get(user), secret);
        assert.equal((await readFile(f.path, 'utf8')).includes(secret.token), false);
    });
}
test('removing opaque ciphertext works without a keyring and leaves other accounts intact', async t => {
    const f = await fixture(t), vault = f.mod.encryptedVault();
    await vault.set(user, secret); await vault.set(other, secret);
    f.state.available = false;
    await assert.rejects(vault.get(user), /Secure token storage/);
    await assert.rejects(vault.set(user, secret), /Secure token storage/);
    await vault.remove(user);
    assert.equal(f.state.decryptions, 0);
    const stored = JSON.parse(await readFile(f.path, 'utf8'));
    assert.equal(stored[user], undefined); assert.ok(stored[other]);
    f.state.available = true;
    assert.deepEqual(await f.mod.encryptedVault().get(other), secret);
});

test('deliberate partial recovery preserves other valid encrypted account records and quarantines the original', async t => {
    const f = await fixture(t), vault = f.mod.encryptedVault();
    await vault.set(user, secret); await vault.set(other, secret);
    const data = JSON.parse(await readFile(f.path, 'utf8'));
    data['345678901234567890'] = { encrypted: 'invalid ciphertext!' };
    const original = JSON.stringify(data); await writeFile(f.path, original);
    const restarted = f.mod.encryptedVault(); await assert.rejects(restarted.get(user), /corrupt/i);
    await restarted.recover(user);
    assert.deepEqual(await restarted.get(other), secret); assert.equal(await restarted.get(user), null);
    const backups = (await readdir(join(f.state.dir, 'NitroSniper'))).filter(file => file.includes('.quarantine-'));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(f.state.dir, 'NitroSniper', backups[0]), 'utf8'), original);
    assert.equal(f.state.decryptions, 1, 'Recovery validates opaque records without decrypting other accounts');
});
