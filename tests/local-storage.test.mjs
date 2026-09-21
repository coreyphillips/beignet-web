import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableBlobStore } from '../lib/local/durable-store.mjs';
import { unlockVault, inspectVault } from '../lib/local/vault.mjs';
import { createCipheriv, pbkdf2Sync } from 'node:crypto';

class File {
  data = new Uint8Array(); durable = new Uint8Array(); failFlush = false;
  getSize() { return this.data.length; }
  read(buffer, { at = 0 } = {}) { const part = this.data.subarray(at, at + buffer.length); buffer.set(part); return part.length; }
  write(buffer, { at = 0 } = {}) { const next = new Uint8Array(Math.max(this.data.length, at + buffer.length)); next.set(this.data); next.set(buffer, at); this.data = next; return buffer.length; }
  truncate(size) { const next = new Uint8Array(size); next.set(this.data.subarray(0, size)); this.data = next; }
  flush() { if (this.failFlush) throw new Error('disk failure'); this.durable = this.data.slice(); }
  close() {}
  crash() { this.data = this.durable.slice(); }
}
const files = () => [new File(), new File(), new File()];
const open = ([journal, ...slots]) => new DurableBlobStore(journal, slots);
const data = (value) => new TextEncoder().encode(value);

test('a durable commit survives restart; an unacknowledged slot never replaces it', () => {
  const f = files(), store = open(f);
  store.write(data('first state'));
  f[0].failFlush = true;
  assert.throws(() => store.write(data('unacknowledged second')), /disk failure/);
  assert.throws(() => store.write(data('third')), /closed/);
  f.forEach((file) => file.crash());
  f[0].failFlush = false;
  assert.deepEqual(open(f).read(), data('first state'));
});

test('partial commit log tails are discarded, complete corrupt records fail closed', () => {
  const f = files();
  open(f).write(data('good'));
  f[0].write(data('partial'), { at: 80 }); f[0].flush();
  assert.deepEqual(open(f).read(), data('good'));
  assert.equal(f[0].getSize(), 80);
  f[0].data[31] ^= 1;
  assert.throws(() => open(f), /damaged/);
});

test('corruption in newest committed slot never falls back to old channel state', () => {
  const f = files(), store = open(f);
  store.write(data('revocation old'));
  store.write(data('revocation new'));
  f[1].data[0] ^= 1;
  assert.throws(() => open(f), /damaged/);
});

test('local vault persists only authenticated ciphertext; correct passphrase reopens it', async () => {
  const f = files();
  const vault = await unlockVault(open(f), 'a sufficiently long test passphrase');
  vault.write(data('seed and live channel secrets'));
  assert.ok(!new TextDecoder().decode(f[2].data).includes('seed and live'));
  vault.close();
  await assert.rejects(unlockVault(open(f), 'wrong passphrase'), /Unable to unlock/);
  const reopened = await unlockVault(open(f), 'a sufficiently long test passphrase');
  assert.deepEqual(reopened.read(), data('seed and live channel secrets'));
  reopened.close();
  assert.throws(() => reopened.read(), /locked/);
});

test('vault ciphertext tampering is refused', async () => {
  const f = files();
  const vault = await unlockVault(open(f), 'a sufficiently long test passphrase');
  vault.write(data('secret'));
  vault.close();
  const store = open(f), envelope = JSON.parse(new TextDecoder().decode(store.read()));
  envelope.state = envelope.state.slice(0, -4) + 'AAAA';
  store.write(data(JSON.stringify(envelope)));
  await assert.rejects(unlockVault(open(f), 'a sufficiently long test passphrase'), /Unable to unlock/);
});

test('one-character and whitespace passwords work without trimming or a minimum', async () => {
  for (const password of ['x', ' ']) {
    const f = files(), vault = await unlockVault(open(f), password);
    vault.write(data('protected wallet')); vault.close();
    const before = open(f).read();
    assert.deepEqual(inspectVault(before), { exists: true, passwordRequired: true });
    await assert.rejects(unlockVault(open(f), ''), /Unable to unlock/);
    assert.deepEqual(open(f).read(), before);
    const restored = await unlockVault(open(f), password);
    assert.deepEqual(restored.read(), data('protected wallet')); restored.close();
  }
});

test('passwordless wallets reopen without a prompt and preserve their protection choice', async () => {
  const f = files(), vault = await unlockVault(open(f), '');
  vault.write(data('local wallet state')); vault.close();
  const first = JSON.parse(new TextDecoder().decode(open(f).read()));
  assert.equal(first.version, 2);
  assert.equal(Buffer.from(first.key, 'base64').length, 32);
  assert.deepEqual(inspectVault(open(f).read()), { exists: true, passwordRequired: false });
  await assert.rejects(unlockVault(open(f), 'not an upgrade'), /does not use a password/);
  const reopened = await unlockVault(open(f), '');
  assert.deepEqual(reopened.read(), data('local wallet state'));
  reopened.write(data('new channel state')); reopened.close();
  const second = JSON.parse(new TextDecoder().decode(open(f).read()));
  assert.notEqual(second.nonce, first.nonce);
  assert.equal(second.key, first.key);
  const again = await unlockVault(open(f), '');
  assert.deepEqual(again.read(), data('new channel state')); again.close();
});

test('legacy v1 data opens unchanged and never falls back to passwordless mode', async () => {
  const password = 'legacy password', key = Buffer.alloc(32, 7), salt = Buffer.alloc(32, 8);
  const wrapNonce = Buffer.alloc(12, 9), nonce = Buffer.alloc(12, 10), aad = Buffer.from('beignet-browser-vault-v1');
  const encrypt = (secret, iv, input) => {
    const cipher = createCipheriv('aes-256-gcm', secret, iv); cipher.setAAD(aad);
    return Buffer.concat([cipher.update(input), cipher.final(), cipher.getAuthTag()]).toString('base64');
  };
  const envelope = { version: 1, iterations: 600000, salt: salt.toString('base64'), wrapNonce: wrapNonce.toString('base64'),
    wrappedKey: encrypt(pbkdf2Sync(password, salt, 600000, 32, 'sha256'), wrapNonce, key), nonce: nonce.toString('base64'), state: encrypt(key, nonce, data('old live channel state')) };
  const f = files(); open(f).write(data(JSON.stringify(envelope)));
  const original = open(f).read();
  assert.equal(inspectVault(original).passwordRequired, true);
  await assert.rejects(unlockVault(open(f), ''), /Unable to unlock/);
  assert.deepEqual(open(f).read(), original);
  const vault = await unlockVault(open(f), password);
  assert.deepEqual(vault.read(), data('old live channel state'));
  vault.close(); assert.deepEqual(open(f).read(), original);
});

test('invalid existing vault headers stay errors, never an empty wallet', async () => {
  assert.deepEqual(inspectVault(null), { exists: false, passwordRequired: false });
  for (const change of [e => { e.key = 'AA=='; }, e => { e.nonce = 'AA=='; }, e => { e.version = 3; }, e => { e.state = '!'; }]) {
    const f = files(), vault = await unlockVault(open(f), '');
    vault.write(data('keep this wallet')); vault.close();
    const envelope = JSON.parse(new TextDecoder().decode(open(f).read())); change(envelope);
    const raw = data(JSON.stringify(envelope)); open(f).write(raw);
    assert.throws(() => inspectVault(raw), /damaged|Unsupported/);
    await assert.rejects(unlockVault(open(f), ''), /damaged|Unsupported/);
    assert.deepEqual(open(f).read(), raw);
  }
});

import { createVolume } from '../lib/local/volume.mjs';
test('volume renames persist atomically and storage failure poisons future access', () => {
  let stored = null, failed = false;
  const vault = { read: () => stored, write: (v) => { if (failed) throw new Error('full'); stored = v; } };
  const volume = createVolume(vault);
  volume.write('/wallet.tmp', data('private state'));
  volume.rename('/wallet.tmp', '/wallet.json');
  const reopened = createVolume(vault);
  assert.equal(reopened.read('/wallet.tmp'), null);
  assert.deepEqual(reopened.read('/wallet.json'), data('private state'));
  failed = true;
  assert.throws(() => volume.write('/wallet.json', data('new')), /full/);
  assert.throws(() => volume.read('/wallet.json'), /storage failed/);
});


for (const password of ['', 'large protected wallet']) {
  test(`multi-megabyte ${password ? 'protected' : 'passwordless'} wallet is inspected and reopened without changing saved bytes`, async () => {
    const f = files(), state = new Uint8Array(8 * 1024 * 1024).fill(109);
    state.set(data('large synthetic wallet state')); state[state.length - 1] = 42;
    const vault = await unlockVault(open(f), password);
    vault.write(state); vault.close();
    const original = open(f).read();
    assert.deepEqual(inspectVault(original), { exists: true, passwordRequired: !!password });
    const reopened = await unlockVault(open(f), password);
    assert.deepEqual(reopened.read(), state); reopened.close();
    assert.deepEqual(open(f).read(), original, 'Opening never rewrites or replaces the stored wallet');
  });
}

test('base64 validation handles large invalid input without overflow and retains padding checks', () => {
  const envelope = state => data(JSON.stringify({ version: 2, protection: 'none',
    key: Buffer.alloc(32).toString('base64'), nonce: Buffer.alloc(12).toString('base64'), state }));
  for (const size of [16, 17, 18]) assert.equal(inspectVault(envelope(Buffer.alloc(size).toString('base64'))).exists, true);
  const valid = Buffer.alloc(8 * 1024 * 1024).toString('base64');
  for (const state of [valid.slice(0, -1) + '!', valid.slice(0, -4) + 'AA=A', valid.slice(0, -4) + 'A===', valid + '=', valid.slice(0, -4) + ' AA=']) {
    assert.throws(() => inspectVault(envelope(state)), error => error.message === 'Wallet vault is damaged.' && !(error instanceof RangeError));
  }
});
