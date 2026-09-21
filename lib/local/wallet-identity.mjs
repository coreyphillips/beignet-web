import { NETWORKS, networkVolume } from './network-profiles.mjs';

const PATH = '/browser-wallet-identity.json';
const REGISTRY = '/wallet/registry.json';
const encoder = new TextEncoder(), decoder = new TextDecoder();
function readJson(raw) {
  try { return JSON.parse(decoder.decode(raw)); }
  catch { throw new Error('Saved wallet identity is damaged. Your existing wallet data has been preserved.'); }
}

function readWallet(volume, network) {
  const raw = networkVolume(volume, network).read(REGISTRY);
  if (!raw) return null;
  const wallet = readJson(raw);
  if (wallet?.record?.network !== network || typeof wallet.record.id !== 'string' || !wallet.record.id ||
    typeof wallet.mnemonic !== 'string' || !wallet.mnemonic.trim())
    throw new Error('Saved wallet identity is damaged. Your existing wallet data has been preserved.');
  return wallet;
}

// The reference lives inside the encrypted vault. Keep the original registry as
// the seed source, without copying its phrase into settings or another store.
function sourceWallet(volume) {
  const saved = volume.read(PATH);
  if (saved) {
    const source = readJson(saved);
    if (source?.version !== 1 || !NETWORKS.includes(source.network) || typeof source.walletId !== 'string')
      throw new Error('The saved recovery phrase reference is invalid.');
    const wallet = readWallet(volume, source.network);
    if (!wallet || wallet.record.id !== source.walletId)
      throw new Error('The original wallet is unavailable. Restore its data before adding another network.');
    return wallet;
  }
  // Releases with separate phrases stored the first wallet at the root. Adopt
  // that original identity, irrespective of which network is currently open.
  const root = volume.read(REGISTRY);
  const originalNetwork = root && readJson(root)?.record?.network;
  if (root && !NETWORKS.includes(originalNetwork)) throw new Error('The original wallet network is invalid.');
  const order = originalNetwork ? [originalNetwork, ...NETWORKS.filter(n => n !== originalNetwork)] : NETWORKS;
  for (const network of order) {
    const wallet = readWallet(volume, network);
    if (!wallet) continue;
    volume.write(PATH, encoder.encode(JSON.stringify({ version: 1, network, walletId: wallet.record.id })));
    return wallet;
  }
  return null;
}

export function sharedWalletMnemonic(volume) {
  const source = sourceWallet(volume);
  if (!source) throw new Error('Create your wallet before adding another network.');
  return source.mnemonic;
}

// Only non-secret migration information crosses the worker boundary. Previously
// created wallets keep their own phrase and committed channel state unchanged.
export function networkRecoveryInfo(volume) {
  const source = sourceWallet(volume);
  if (!source) return null;
  const separateNetworks = NETWORKS.filter(network => {
    const wallet = readWallet(volume, network);
    return wallet && wallet.mnemonic.trim() !== source.mnemonic.trim();
  });
  return { sourceNetwork: source.record.network, separateNetworks };
}
