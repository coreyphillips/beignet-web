import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConnection, chainTarget, manualConnection, parseElectrumServer, mempoolPushUrl } from '../lib/local/connection.mjs';

const token = 'b'.repeat(43);
test('a relay connection needs WSS off loopback, a base64url token, and no trailing slash', () => {
  assert.deepEqual(validateConnection({ mode: 'relay', url: 'wss://relay.example:8790/', token }), { mode: 'relay', url: 'wss://relay.example:8790', token });
  assert.equal(validateConnection({ mode: 'relay', url: 'ws://127.0.0.1:8790', token }).url, 'ws://127.0.0.1:8790');
  assert.throws(() => validateConnection({ mode: 'relay', url: 'ws://relay.example:8790', token }), /WSS/);
  assert.throws(() => validateConnection({ mode: 'relay', url: 'wss://relay.example:8790', token: 'short' }), /token/);
  assert.throws(() => validateConnection({ mode: 'relay', url: 'wss://u:p@relay.example', token }), /credentials/);
  assert.throws(() => validateConnection({ mode: 'relay', url: 'wss://relay.example/?x=1', token }), /query/);
});
test('a direct connection names the peer WebSocket and one chain source', () => {
  const electrum = validateConnection({ mode: 'direct', peerUrl: 'wss://node.example:9736', chain: { kind: 'electrum-ws', url: 'wss://electrum.example:50004' } });
  assert.deepEqual(electrum, { mode: 'direct', peerUrl: 'wss://node.example:9736/', chain: { kind: 'electrum-ws', url: 'wss://electrum.example:50004/' } });
  const esplora = validateConnection({ mode: 'direct', peerUrl: 'ws://127.0.0.1:19847', chain: { kind: 'esplora', url: 'https://mempool.space/api/' } });
  assert.deepEqual(esplora.chain, { kind: 'esplora', url: 'https://mempool.space/api', ws: 'wss://mempool.space/api/v1/ws' });
  assert.equal(validateConnection({ mode: 'direct', peerUrl: 'ws://127.0.0.1:1', chain: { kind: 'esplora', url: 'https://explorer.example/esplora' } }).chain.ws, undefined);
  assert.throws(() => validateConnection({ mode: 'direct', peerUrl: 'ws://node.example:9736', chain: { kind: 'esplora', url: 'https://mempool.space/api' } }), /WSS/);
  assert.throws(() => validateConnection({ mode: 'direct', peerUrl: 'wss://node.example', chain: { kind: 'esplora', url: 'http://mempool.space/api' } }), /HTTPS/);
  assert.throws(() => validateConnection({ mode: 'direct', peerUrl: 'wss://node.example', chain: { kind: 'other', url: 'x' } }), /Choose/);
  assert.throws(() => validateConnection({ mode: 'magic' }), /relay or a direct/);
  assert.equal(mempoolPushUrl('https://mempool.space/testnet/api'), 'wss://mempool.space/testnet/api/v1/ws');
});
test('the engine addresses a direct chain source by its URL host and a relay by the server it forwards to', () => {
  const fallback = { host: 'bitkit.to', port: 9999, tls: true };
  assert.equal(chainTarget({ mode: 'relay', url: 'wss://r', token }, fallback), fallback);
  assert.deepEqual(chainTarget({ mode: 'direct', peerUrl: 'wss://n', chain: { kind: 'esplora', url: 'https://mempool.space/api' } }), { host: 'mempool.space', port: 443, tls: true });
  assert.deepEqual(chainTarget({ mode: 'direct', peerUrl: 'wss://n', chain: { kind: 'electrum-ws', url: 'ws://127.0.0.1:60004/' } }), { host: '127.0.0.1', port: 60004, tls: false });
});
test('the persisted connection carries relay routes or direct endpoints, never both', () => {
  const profile = { network: 'regtest', primaryUri: 'pk@127.0.0.1:19846', electrum: { host: '127.0.0.1', port: 60001, tls: false } };
  const relay = manualConnection({ ...profile, connection: { mode: 'relay', url: 'ws://127.0.0.1:8790', token } });
  assert.deepEqual(relay, { mode: 'relay', network: 'regtest', primaryUri: profile.primaryUri, electrum: profile.electrum, electrumUrl: 'ws://127.0.0.1:8790/electrum', peerUrl: 'ws://127.0.0.1:8790/peer', token });
  const direct = manualConnection({ ...profile, connection: { mode: 'direct', peerUrl: 'ws://127.0.0.1:19847', chain: { kind: 'electrum-ws', url: 'ws://127.0.0.1:60004' } } });
  assert.deepEqual(direct, { mode: 'direct', network: 'regtest', primaryUri: profile.primaryUri, electrum: { host: '127.0.0.1', port: 60004, tls: false }, direct: { peerUrl: 'ws://127.0.0.1:19847/', chain: { kind: 'electrum-ws', url: 'ws://127.0.0.1:60004/' } } });
  assert.equal(direct.token, undefined);
});
test('Electrum server addresses keep their existing ssl and tcp forms', () => {
  assert.deepEqual(parseElectrumServer(' ssl://bitkit.to:9999 '), { host: 'bitkit.to', port: 9999, tls: true });
  assert.deepEqual(parseElectrumServer('tcp://[::1]:60001'), { host: '::1', port: 60001, tls: false });
  assert.throws(() => parseElectrumServer('wss://bitkit.to:9999'), /ssl:\/\/host:port/);
});
