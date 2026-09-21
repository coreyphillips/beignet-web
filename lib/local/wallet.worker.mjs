import { openBrowserStore } from './durable-store.mjs';
import { unlockVault, inspectVault } from './vault.mjs';
import { automaticConnection, sameConnection } from './automatic-connection.mjs';
import { loadNetworkSettings, saveNetworkSettings, networkVolume, validateProfile } from './network-profiles.mjs';
import { sharedWalletMnemonic, networkRecoveryInfo } from './wallet-identity.mjs';
import { createVolume } from './volume.mjs';
import { createPortableRuntime, createRelaySocketFactory } from '@beignet/portable-engine';
import { createSqlJsDatabaseFactory } from '@beignet/portable-engine/sqljs';

let runtime, store, vault, volume, scoped, settings, config;
let opening = false, renewTimer, connectionGeneration = 0;
const CONFIG_PATH = '/browser-network.json';
const encoder = new TextEncoder(), decoder = new TextDecoder();
// The worker script is served under <base>/_next/static/workers/, so the app's
// static root is whatever precedes /_next/ in its own URL. This keeps the SQLite
// WASM lookup correct when the app is hosted under a path prefix.
const assetRoot = () => self.location.href.split('/_next/')[0] + '/';
function websocketUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.hash || url.search) throw new Error('Use a connection URL without credentials, query parameters, or a fragment.');
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    throw new Error('Use WSS for remote network connections.');
  return url.href;
}
async function stopEngine() {
  connectionGeneration++;
  clearTimeout(renewTimer);
  await runtime?.close();
  runtime = undefined;
}
async function cleanup() {
  // A failed stop remains retryable. Keep the storage lease until the engine
  // stops successfully or its owning worker is terminated as a crash.
  await stopEngine();
  volume?.clearMemory(); volume = undefined; scoped = undefined; settings = undefined; config = undefined;
  if (vault) vault.close(); else store?.close();
  vault = undefined; store = undefined;
}
function renewConnection(current) {
  const generation = connectionGeneration;
  const renew = async () => {
    if (generation !== connectionGeneration) return;
    try {
      const next = await automaticConnection(self.location.origin, fetch, {
        network: current.network, primaryUri: current.primaryUri, electrum: current.electrum,
      });
      if (generation !== connectionGeneration) return;
      if (!sameConnection(current, next)) throw new Error('Connection settings changed. Reopen the wallet to apply them.');
      current.token = next.token; current.expiresAt = next.expiresAt;
    } catch { /* Existing sessions remain live; retry temporary service failures. */ }
    if (generation === connectionGeneration)
      renewTimer = setTimeout(renew, Math.max(15000, Math.min(240000, current.expiresAt - Date.now() - 60000)));
  };
  renewTimer = setTimeout(renew, Math.max(15000, current.expiresAt - Date.now() - 60000));
}
async function startRuntime(network, { options, automatic = true, prepared, updateDefaults = true } = {}) {
  scoped = networkVolume(volume, network);
  const engineVolume = scoped;
  const saved = scoped.read(CONFIG_PATH);
  const registry = scoped.read('/wallet/registry.json');
  const existing = registry && JSON.parse(decoder.decode(registry)).record;
  const connectionProfile = existing
    ? { ...settings.profiles[network], primaryUri: existing.lfbw.primaryUri }
    : settings.profiles[network];
  let next = prepared || options || (saved && JSON.parse(decoder.decode(saved)));
  if (!prepared && automatic && (!next || next.managed)) {
    try {
      next = await automaticConnection(self.location.origin, fetch, connectionProfile);
    } catch (error) { if (!next || !scoped.read('/wallet/registry.json')) throw error; }
  }
  if (!next) throw new Error('The app’s connection service is unavailable. Please try again in a moment.');
  next.electrumUrl = websocketUrl(next.electrumUrl); next.peerUrl = websocketUrl(next.peerUrl);
  if (typeof next.token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(next.token)) throw new Error('The app’s connection service could not authorize a connection.');
  if (!next.electrum || typeof next.electrum.host !== 'string' || !next.electrum.host.trim() || !Number.isInteger(next.electrum.port) || next.electrum.port < 1 || next.electrum.port > 65535)
    throw new Error('The saved Bitcoin connection is invalid.');
  const databaseFactory = await createSqlJsDatabaseFactory({ load: path => engineVolume.read(path), save: (path, bytes) => engineVolume.write(path, bytes),
    locateFile: file => new URL(`engine/${file}`, assetRoot()).href });
  scoped.write(CONFIG_PATH, encoder.encode(JSON.stringify(next)));
  runtime = await createPortableRuntime({ databaseFactory, volume: engineVolume, electrum: next.electrum, socketFactory: createRelaySocketFactory(next) });
  config = next;
  if (next.managed) {
    if (updateDefaults && !existing) {
      settings.profiles[network] = validateProfile({ network, primaryUri: next.primaryUri, electrum: next.electrum });
      saveNetworkSettings(volume, settings);
    }
    renewConnection(next);
  }
}
self.onmessage = async ({ data: { id, operation, payload } }) => {
  try {
    let result;
    if (operation === 'probe' || operation === 'inspect') {
      if (opening || runtime) throw new Error('Wallet is already opening.');
      const probe = await openBrowserStore();
      try { result = operation === 'probe' ? probe.read() !== null : inspectVault(probe.read()); } finally { probe.close(); }
    } else if (operation === 'unlock') {
      if (opening || runtime) throw new Error('Wallet is already open.');
      opening = true;
      try {
        store = await openBrowserStore(); vault = await unlockVault(store, payload.password); payload.password = '';
        volume = createVolume(vault); settings = loadNetworkSettings(volume);
        await startRuntime(settings.activeNetwork, { options: payload.options, automatic: !!payload.automatic });
        result = { opened: true, defaults: settings.profiles[settings.activeNetwork] };
      } catch (error) { await cleanup(); throw error; }
      finally { opening = false; payload.password = ''; }
    } else if (operation === 'network-settings') {
      if (!runtime || opening) throw new Error('Open your wallet first.');
      result = { ...settings, recovery: networkRecoveryInfo(volume) };
    } else if (operation === 'save-network') {
      if (!runtime || opening) throw new Error('Open your wallet first.');
      const profile = validateProfile(payload);
      settings.profiles[profile.network] = profile;
      saveNetworkSettings(volume, settings);
      result = { ...settings, recovery: networkRecoveryInfo(volume) };
    } else if (operation === 'switch-network') {
      if (!runtime || opening) throw new Error('Open your wallet first.');
      const profile = validateProfile(payload, true);
      opening = true;
      const previousNetwork = settings.activeNetwork;
      const previousProfile = settings.profiles[profile.network];
      const previousConfig = config;
      let stopped = false;
      let previousWallet;
      try {
        // Resolve the original identity before stopping anything. Missing or
        // damaged source data must never cause a replacement phrase to appear.
        const mnemonic = networkVolume(volume, profile.network).read('/wallet/registry.json')
          ? undefined : sharedWalletMnemonic(volume);
        // Validate and provision the requested route before stopping the current
        // engine. Tokens bind immutable targets; active sockets never retarget.
        const prepared = await automaticConnection(self.location.origin, fetch, profile);
        previousWallet = (await runtime.request({ method: 'GET', path: '/api/wallets' }))[0];
        await stopEngine();
        stopped = true;
        settings.profiles[profile.network] = profile;
        settings.activeNetwork = profile.network;
        saveNetworkSettings(volume, settings);
        await startRuntime(profile.network, { prepared });
        const list = await runtime.request({ method: 'GET', path: '/api/wallets' });
        if (list.length) {
          const wallet = list[0];
          if (wallet.lfbw?.primaryUri !== profile.primaryUri) {
            await runtime.request({ method: 'PATCH', path: `/api/wallets/${wallet.id}`, body: { lfbw: { enabled: true, primaryUri: profile.primaryUri } } });
          } else await runtime.request({ method: 'POST', path: `/api/wallets/${wallet.id}/start` });
          // Return the persisted result, not the record captured before PATCH.
          result = { wallet: (await runtime.request({ method: 'GET', path: '/api/wallets' }))[0] };
        } else {
          const created = await runtime.request({ method: 'POST', path: '/api/wallets', body: {
            name: profile.network === 'mainnet' ? 'Everyday wallet' : `${profile.network === 'testnet' ? 'Testnet' : 'Regtest'} wallet`,
            network: profile.network, mnemonic, lfbw: { enabled: true, primaryUri: profile.primaryUri },
          } });
          result = { wallet: created.record };
        }
      } catch (error) {
        // Failed provisioning leaves the active engine untouched. After an
        // actual switch, restore and restart the prior wallet before returning.
        if (stopped) {
          await stopEngine();
          settings.activeNetwork = previousNetwork;
          settings.profiles[profile.network] = previousProfile;
          saveNetworkSettings(volume, settings);
          await startRuntime(previousNetwork, { prepared: previousConfig, updateDefaults: false });
          if (previousWallet) {
            await runtime.request({ method: 'PATCH', path: `/api/wallets/${previousWallet.id}`, body: { lfbw: previousWallet.lfbw } });
          }
        }
        throw error;
      } finally { opening = false; }
    } else if (operation === 'request') {
      if (!runtime || opening) throw new Error('Open your wallet first.');
      result = await runtime.request(payload);
      if (payload.method === 'POST' && payload.path === '/api/wallets' && result?.record) {
        const record = result.record;
        settings.activeNetwork = record.network;
        settings.profiles[record.network] = validateProfile({ network: record.network, primaryUri: record.lfbw.primaryUri, electrum: record.electrum });
        saveNetworkSettings(volume, settings);
      }
    } else if (operation === 'close') { await cleanup(); result = { closed: true }; }
    else throw new Error('Unsupported local wallet operation.');
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: { message: error instanceof Error ? error.message : 'Local wallet operation failed.', code: error?.code, status: error?.status } });
  }
};
