import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticConnection, sameConnection } from '../lib/local/automatic-connection.mjs';
const origin = 'https://wallet.example.com';
const config = () => ({ enabled: true, network: 'mainnet', primaryUri: '02' + '11'.repeat(32) + '@primary.example.com:9735',
  electrum: { host: 'bitkit.to', port: 9999, tls: true }, peerUrl: 'wss://wallet.example.com/transport/peer',
  electrumUrl: 'wss://wallet.example.com/transport/electrum', token: 't'.repeat(43), expiresAt: Date.now() + 300000 });
const response = (value) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('automatic setup fetches only the same-origin transport config without wallet credentials', async () => {
  const result = await automaticConnection(origin, async (url, options) => {
    assert.equal(url.href, origin + '/api/browser-config');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers['X-Beignet-Transport'], '1');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.credentials, 'same-origin');
    return response(config());
  });
  assert.equal(result.managed, true);
  assert.deepEqual(result.electrum, { host: 'bitkit.to', port: 9999, tls: true });
});

test('invalid or expired automatic transports cannot redirect local keys or sockets', async () => {
  const variants = [
    { enabled: false }, { network: 'unknown' }, { token: 'short' }, { expiresAt: 1 },
    { peerUrl: 'wss://other.example.com/transport/peer' }, { peerUrl: 'ws://wallet.example.com/transport/peer' },
    { peerUrl: 'wss://wallet.example.com/transport/peer?token=secret' }, { electrum: { host: 'bitkit.to', port: 0, tls: true } },
  ];
  for (const patch of variants) await assert.rejects(automaticConnection(origin, async () => response({ ...config(), ...patch })), /unavailable/);
  await assert.rejects(automaticConnection(origin, async () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } })), /unavailable/);
  await assert.rejects(automaticConnection(origin, async () => { throw new Error('network'); }), /unavailable/);
});

test('renewal may replace credentials but cannot silently change the active network or primary', () => {
  const previous = config();
  assert.equal(sameConnection(previous, { ...previous, token: 'n'.repeat(43), expiresAt: Date.now() + 600000 }), true);
  for (const patch of [{ network: 'regtest' }, { primaryUri: 'different' }, { peerUrl: 'different' }, { electrum: { ...previous.electrum, host: 'another' } }])
    assert.equal(sameConnection(previous, { ...previous, ...patch }), false);
});

test('network preferences are provisioned in the request body, never in transport URLs', async () => {
  const profile = { network: 'regtest', primaryUri: 'regtest-primary', electrum: { host: 'localhost', port: 60001, tls: false } };
  const result = await automaticConnection(origin, async (url, options) => {
    assert.equal(url.search, ''); assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), profile);
    return response({ ...config(), ...profile });
  }, profile);
  assert.equal(result.network, 'regtest');
  await assert.rejects(automaticConnection(origin, async () => response(config()), profile), /unavailable/);
});
