// Manual network connections for a static deployment. Without a companion
// service on the app's origin, the user names how the wallet reaches the
// network: either a byte relay they operate, or the primary node's own
// WebSocket listener plus a chain source the browser can query directly.
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const parse = (value, hint) => {
  let url;
  try { url = new URL(String(value ?? '').trim()); } catch { throw new Error(`Enter ${hint}.`); }
  if (url.username || url.password || url.hash || url.search) throw new Error('Use a connection URL without credentials, query parameters, or a fragment.');
  return url;
};
export function websocketUrl(value, hint = 'a connection URL such as wss://host:port') {
  const url = parse(value, hint);
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && LOOPBACK.includes(url.hostname))) throw new Error('Use WSS for remote network connections.');
  return url.href;
}
export function httpUrl(value, hint = 'an API URL such as https://mempool.space/api') {
  const url = parse(value, hint);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.includes(url.hostname))) throw new Error('Use HTTPS for remote API connections.');
  return url.href.replace(/\/+$/, '');
}
// An Electrum server address as typed in settings: ssl://host:port or tcp://host:port.
export function parseElectrumServer(value) {
  let url;
  try { url = new URL(String(value ?? '').trim()); } catch { throw new Error('Use a server address such as ssl://bitkit.to:9999.'); }
  if (!['ssl:', 'tls:', 'tcp:'].includes(url.protocol) || !url.hostname || !url.port || url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/'))
    throw new Error('Use ssl://host:port or tcp://host:port without a username or password.');
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port), tls: url.protocol !== 'tcp:' };
}
// mempool.space publishes new blocks on a WebSocket beside its REST API; derive
// that endpoint so the settings need one URL. A plain Esplora falls back to polling.
export function mempoolPushUrl(apiUrl) {
  const url = new URL(apiUrl);
  if (!url.pathname.endsWith('/api')) return undefined;
  return `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}${url.pathname}/v1/ws`;
}
export function validateConnection(input) {
  if (!input || typeof input !== 'object') throw new Error('Choose how this wallet reaches the network.');
  if (input.mode === 'relay') {
    const url = websocketUrl(input.url, 'the relay URL, such as wss://relay.example:8790').replace(/\/+$/, '');
    const token = typeof input.token === 'string' ? input.token.trim() : '';
    if (!TOKEN.test(token)) throw new Error('Enter the relay access token.');
    return { mode: 'relay', url, token };
  }
  if (input.mode === 'direct') {
    const peerUrl = websocketUrl(input.peerUrl, 'the primary node WebSocket URL, such as wss://node.example:9736');
    const chain = input.chain;
    if (chain?.kind === 'electrum-ws') return { mode: 'direct', peerUrl, chain: { kind: 'electrum-ws', url: websocketUrl(chain.url, 'the Electrum WebSocket URL, such as wss://electrum.example:50004') } };
    if (chain?.kind === 'esplora') {
      const url = httpUrl(chain.url);
      const ws = chain.ws ? websocketUrl(chain.ws) : mempoolPushUrl(url);
      return { mode: 'direct', peerUrl, chain: { kind: 'esplora', url, ...(ws ? { ws } : {}) } };
    }
    throw new Error('Choose an Electrum WebSocket server or a block explorer API.');
  }
  throw new Error('Choose a relay or a direct connection.');
}
// The engine addresses its chain source as host, port and TLS. A relay keeps
// the server the relay forwards to; a direct chain source is named by its URL,
// and the engine's socket for that address is routed to it.
export function chainTarget(connection, fallback) {
  if (!connection || connection.mode === 'relay') return fallback;
  const url = new URL(connection.chain.url);
  const tls = url.protocol === 'wss:' || url.protocol === 'https:';
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) || (tls ? 443 : 80), tls };
}
// The connection the worker persists and starts the engine with.
export function manualConnection(profile) {
  const connection = validateConnection(profile.connection);
  const base = { mode: connection.mode, network: profile.network, primaryUri: profile.primaryUri, electrum: chainTarget(connection, profile.electrum) };
  if (connection.mode === 'relay') return { ...base, electrumUrl: `${connection.url}/electrum`, peerUrl: `${connection.url}/peer`, token: connection.token };
  return { ...base, direct: { peerUrl: connection.peerUrl, chain: connection.chain } };
}
