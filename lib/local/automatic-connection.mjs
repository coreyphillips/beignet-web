const unavailable = 'The app’s connection service is unavailable. Please try again in a moment.';

export async function automaticConnection(origin = self.location.origin, fetcher = fetch, profile) {
  let response;
  try {
    response = await fetcher(new URL('/api/browser-config', origin), {
      method: profile ? 'POST' : 'GET',
      cache: 'no-store', credentials: 'same-origin', headers: { 'X-Beignet-Transport': '1', ...(profile ? { 'Content-Type': 'application/json' } : {}) },
      ...(profile ? { body: JSON.stringify(profile) } : {}),
      signal: AbortSignal.timeout(15000),
    });
  } catch { throw new Error(unavailable); }
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error(unavailable);
  const config = await response.json();
  if (config.enabled !== true || !['mainnet', 'testnet', 'regtest'].includes(config.network) || (profile && config.network !== profile.network) ||
    typeof config.primaryUri !== 'string' || !config.primaryUri ||
    typeof config.token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(config.token) ||
    !Number.isFinite(config.expiresAt) || config.expiresAt <= Date.now() ||
    !config.electrum || typeof config.electrum.host !== 'string' || !config.electrum.host ||
    !Number.isInteger(config.electrum.port) || config.electrum.port < 1 || config.electrum.port > 65535 ||
    typeof config.electrum.tls !== 'boolean') throw new Error(unavailable);
  const expected = new URL(origin);
  for (const [key, path] of [['peerUrl', '/transport/peer'], ['electrumUrl', '/transport/electrum']]) {
    const url = new URL(config[key]);
    if (url.host !== expected.host || url.protocol !== (expected.protocol === 'https:' ? 'wss:' : 'ws:') ||
      url.pathname !== path || url.search || url.hash || url.username || url.password) throw new Error(unavailable);
  }
  return { ...config, managed: true };
}

export function sameConnection(a, b) {
  return a.network === b.network && a.primaryUri === b.primaryUri && a.peerUrl === b.peerUrl && a.electrumUrl === b.electrumUrl &&
    a.electrum?.host === b.electrum?.host && a.electrum?.port === b.electrum?.port && a.electrum?.tls === b.electrum?.tls;
}
