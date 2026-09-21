import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsUpdater } from '../lib/settings-update.mjs';

const record = { id: 'fixture', name: 'Fixture', network: 'mainnet', status: 'running', lfbw: { enabled: true, primaryUri: 'new-primary', setup: 'ready' } };
test('a committed setting with failed connection is applied with a warning, not rolled back', async () => {
  const saved = { ...record, lfbw: { ...record.lfbw, setup: 'failed', setupError: 'The primary node refused the connection.' } };
  const client = { connection: { walletId: record.id }, snapshot: async () => { throw Error('offline'); }, listWallets: async () => [saved] };
  const result = await createSettingsUpdater().run({ client, change: async () => ({ wallet: saved }), previousWallet: record });
  assert.equal(result.applied, true); assert.equal(result.phase, 'warning');
  assert.equal(result.wallet.lfbw.primaryUri, 'new-primary');
  assert.match(result.detail, /refused/); assert.equal(result.snapshot, null);
});
test('fallback metadata never publishes a raw worker setup error', async () => {
  const client = { connection: { walletId: record.id }, snapshot: async () => { throw Error('offline'); }, listWallets: async () => { throw Error('offline'); } };
  const result = await createSettingsUpdater().run({ client, previousWallet: record, change: async () => ({ wallet: { ...record, lfbw: { ...record.lfbw, setupError: 'private upstream payload' } } }) });
  assert.ok(!JSON.stringify(result).includes('private upstream payload'));
  assert.equal(result.applied, true); assert.equal(result.phase, 'warning');
});
test('one settings operation owns both the save and subsequent connection check', async () => {
  let finish, changes = 0;
  const deferred = new Promise(resolve => { finish = resolve; });
  const client = { snapshot: () => deferred, connection: { walletId: record.id } };
  const updater = createSettingsUpdater();
  const first = updater.run({ client, previousWallet: record, change: async () => { changes++; } });
  await Promise.resolve();
  await assert.rejects(updater.run({ client, change: async () => { changes++; } }), /current settings update/);
  assert.equal(changes, 1); assert.equal(updater.pending, true);
  finish({ wallet: record, primary: { connected: true } });
  assert.equal((await first).phase, 'success'); assert.equal(updater.pending, false);
});
test('saving a default does not restart or inspect the engine', async () => {
  const result = await createSettingsUpdater().run({ client: {}, refresh: false, change: async () => {} });
  assert.equal(result.phase, 'success'); assert.equal(result.snapshot, undefined);
});
test('a rejected change releases the operation without running a misleading success refresh', async () => {
  const updater = createSettingsUpdater();
  await assert.rejects(updater.run({ client: { snapshot: () => assert.fail('must not refresh as success') }, change: async () => { throw Error('provisioning failed'); } }), /provisioning failed/);
  assert.equal(updater.pending, false);
});
