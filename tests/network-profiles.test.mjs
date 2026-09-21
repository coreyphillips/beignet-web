import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultProfiles, loadNetworkSettings, saveNetworkSettings, networkVolume, validateProfile } from '../lib/local/network-profiles.mjs';
import { sharedWalletMnemonic, networkRecoveryInfo } from '../lib/local/wallet-identity.mjs';
const encode = value => new TextEncoder().encode(JSON.stringify(value));
function volume() {
  const files = new Map();
  return { read: p => files.get(p)?.slice() || null, write: (p, value) => files.set(p, value.slice()), remove: p => files.delete(p),
    rename: (from, to) => { files.set(to, files.get(from)); files.delete(from); }, list: prefix => [...files.keys()].filter(p => p.startsWith(prefix)) };
}
const registry = network => encode({ record: { id: network + '-wallet', network, electrum: defaultProfiles()[network].electrum, lfbw: { primaryUri: network + '-primary' } }, mnemonic: network + '-seed' });

test('wallet identities, channel databases, and transport settings stay isolated across all networks', () => {
  const root = volume();
  for (const network of ['mainnet', 'testnet', 'regtest']) {
    const scoped = networkVolume(root, network);
    scoped.write('/wallet/registry.json', registry(network));
    scoped.write('/wallet/channel.db', encode(network + '-channel-revocation'));
    scoped.write('/browser-network.json', encode(network + '-transport'));
  }
  for (const network of ['regtest', 'mainnet', 'testnet']) {
    const reopened = networkVolume(root, network);
    assert.deepEqual(reopened.read('/wallet/registry.json'), registry(network));
    assert.deepEqual(reopened.read('/wallet/channel.db'), encode(network + '-channel-revocation'));
    assert.deepEqual(reopened.read('/browser-network.json'), encode(network + '-transport'));
    assert.ok(reopened.list('/').every(p => !p.startsWith('/networks/')));
  }
});

test('legacy non-mainnet wallets retain their original paths and never become mainnet wallets', () => {
  const root = volume(); root.write('/wallet/registry.json', registry('regtest'));
  root.write('/wallet/channel.db', encode('existing committed state'));
  assert.equal(loadNetworkSettings(root).activeNetwork, 'regtest');
  const mainnet = networkVolume(root, 'mainnet');
  assert.equal(mainnet.read('/wallet/registry.json'), null);
  mainnet.write('/wallet/registry.json', registry('mainnet'));
  assert.deepEqual(root.read('/wallet/registry.json'), registry('regtest'));
  assert.deepEqual(networkVolume(root, 'regtest').read('/wallet/channel.db'), encode('existing committed state'));
  assert.deepEqual(networkVolume(root, 'mainnet').read('/wallet/registry.json'), registry('mainnet'));
});

test('per-network defaults persist independently and invalid changes preserve existing profiles', () => {
  const root = volume(), settings = loadNetworkSettings(root);
  assert.deepEqual(settings.profiles.mainnet.electrum, { host: 'bitkit.to', port: 9999, tls: true });
  settings.profiles.regtest = validateProfile({ network: 'regtest', primaryUri: 'regtest-peer', electrum: { host: 'localhost', port: 60401, tls: false } });
  saveNetworkSettings(root, settings);
  assert.equal(loadNetworkSettings(root).profiles.regtest.electrum.port, 60401);
  assert.equal(loadNetworkSettings(root).profiles.mainnet.electrum.port, 9999);
  assert.throws(() => validateProfile({ ...settings.profiles.regtest, electrum: { host: 'user@host', port: 1, tls: true } }), /hostname/);
  assert.throws(() => validateProfile({ ...settings.profiles.testnet, primaryUri: '' }, true), /primary/);
  assert.throws(() => networkVolume(root, 'unknown'), /Unknown/);
  assert.throws(() => networkVolume(root, 'mainnet').write('/../networks/regtest/wallet', encode('wrong')), /Invalid/);
});

test('a legacy regtest-first wallet supplies the shared phrase while keeping all network paths separate', () => {
  const root = volume(); root.write('/wallet/registry.json', registry('regtest'));
  const original = root.read('/wallet/registry.json');
  for (const network of ['mainnet', 'testnet']) {
    const mnemonic = sharedWalletMnemonic(root);
    assert.equal(mnemonic, 'regtest-seed');
    const next = JSON.parse(new TextDecoder().decode(registry(network)));
    next.mnemonic = mnemonic;
    networkVolume(root, network).write('/wallet/registry.json', encode(next));
  }
  assert.deepEqual(networkRecoveryInfo(root), { sourceNetwork: 'regtest', separateNetworks: [] });
  assert.deepEqual(root.read('/wallet/registry.json'), original);
  assert.equal(JSON.parse(new TextDecoder().decode(networkVolume(root, 'testnet').read('/wallet/registry.json'))).record.network, 'testnet');
});

test('a replaced source registry cannot silently supply a new phrase', () => {
  const root = volume(); root.write('/wallet/registry.json', registry('mainnet'));
  assert.equal(sharedWalletMnemonic(root), 'mainnet-seed');
  const replacement = JSON.parse(new TextDecoder().decode(registry('mainnet')));
  replacement.record.id = 'replacement'; replacement.mnemonic = 'replacement-seed';
  root.write('/wallet/registry.json', encode(replacement));
  assert.throws(() => sharedWalletMnemonic(root), /original wallet is unavailable/);
});
