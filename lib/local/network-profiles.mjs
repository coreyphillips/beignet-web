import { DEFAULT_PRIMARY_URI } from '@beignet/wallet-core';
import { validateConnection } from './connection.mjs';
export const NETWORKS = ['mainnet', 'testnet', 'regtest'];
const PATH = '/browser-settings.json';
const encoder = new TextEncoder(), decoder = new TextDecoder();
export const defaultProfiles = () => ({
  mainnet: { network: 'mainnet', primaryUri: DEFAULT_PRIMARY_URI, electrum: { host: 'bitkit.to', port: 9999, tls: true } },
  testnet: { network: 'testnet', primaryUri: '', electrum: { host: 'electrum.blockstream.info', port: 60002, tls: true } },
  regtest: { network: 'regtest', primaryUri: '', electrum: { host: '127.0.0.1', port: 60001, tls: false } },
});
export function validateProfile(profile, requirePrimary = false) {
  const e = profile?.electrum;
  if (!NETWORKS.includes(profile?.network) || !e || typeof e.host !== 'string' || !e.host.trim() || /[\s/@?#]/.test(e.host) ||
    !Number.isInteger(e.port) || e.port < 1 || e.port > 65535 || typeof e.tls !== 'boolean') throw new Error('Enter a server hostname, port, and connection type.');
  if (typeof profile.primaryUri !== 'string' || (requirePrimary && !profile.primaryUri.trim())) throw new Error('Add a primary node for this network before switching.');
  // A manual connection (static deployments without a companion service) travels with the profile.
  const connection = profile.connection ? validateConnection(profile.connection) : undefined;
  return { network: profile.network, primaryUri: profile.primaryUri.trim(), electrum: { host: e.host.trim(), port: e.port, tls: e.tls }, ...(connection ? { connection } : {}) };
}
function legacyNetwork(volume) {
  const raw = volume.read('/wallet/registry.json');
  if (!raw) return null;
  const network = JSON.parse(decoder.decode(raw))?.record?.network;
  if (!NETWORKS.includes(network)) throw new Error('The existing wallet network is invalid.');
  return network;
}
export function loadNetworkSettings(volume) {
  const raw = volume.read(PATH);
  const defaults = defaultProfiles();
  if (!raw) {
    const activeNetwork = legacyNetwork(volume) || 'mainnet';
    const registry = volume.read('/wallet/registry.json');
    if (registry) {
      const { record } = JSON.parse(decoder.decode(registry));
      defaults[activeNetwork] = validateProfile({ network: activeNetwork, primaryUri: record.lfbw?.primaryUri || '', electrum: record.electrum || defaults[activeNetwork].electrum });
    }
    return { activeNetwork, profiles: defaults };
  }
  const settings = JSON.parse(decoder.decode(raw));
  if (!NETWORKS.includes(settings.activeNetwork)) throw new Error('Saved network settings are invalid.');
  for (const network of NETWORKS) {
    if (settings.profiles?.[network]?.network !== network) throw new Error('Saved network profiles are invalid.');
    defaults[network] = validateProfile(settings.profiles[network]);
  }
  return { activeNetwork: settings.activeNetwork, profiles: defaults };
}
export function saveNetworkSettings(volume, settings) { volume.write(PATH, encoder.encode(JSON.stringify(settings))); }

// Older releases stored one wallet at the volume root, including regtest
// wallets. Preserve that exact location for its actual network; never retag it.
export function networkVolume(volume, network) {
  if (!NETWORKS.includes(network)) throw new Error('Unknown Bitcoin network.');
  const legacy = legacyNetwork(volume);
  const prefix = network === (legacy || 'mainnet') ? '' : `/networks/${network}`;
  const file = (path) => {
    if (typeof path !== 'string' || !path.startsWith('/') || path.split('/').includes('..')) throw new Error('Invalid network wallet path.');
    return prefix + path;
  };
  return {
    read: path => volume.read(file(path)), write: (path, bytes) => volume.write(file(path), bytes),
    remove: path => volume.remove(file(path)), rename: (from, to) => volume.rename(file(from), file(to)),
    list: (path = '/') => volume.list(file(path)).filter(p => prefix || !p.startsWith('/networks/')).map(p => p.slice(prefix.length)),
  };
}
