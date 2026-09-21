// Execute the production worker bundle in a browser-like realm with a direct
// connection: no relay and no companion. The primary is the regtest CLN's own
// WebSocket peer listener, and Electrum is the local electrs behind the
// loopback WebSocket bridge. Requires `npm run build` and the documented
// regtest Docker stack (bitcoin, electrum, cln).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { randomBytes } from 'node:crypto';
import { startBridge } from '../scripts/electrum-ws-bridge.mjs';
// BEIGNET_TEST_TRANSPORT=relay runs the same steps through the byte relay
// instead, to tell an engine behaviour from a transport one.
const viaRelay = process.env.BEIGNET_TEST_TRANSPORT === 'relay';
const directory = path.resolve('dist/client');
const workerFile = fs.readdirSync(path.join(directory, '_next/static/workers')).find((f) => f.startsWith('wallet.worker-'));
assert.ok(workerFile, 'Build the web app first');
const source = fs.readFileSync(path.join(directory, '_next/static/workers', workerFile), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'beignet-web-direct-'));
const threads = new Set();
const password = 'disposable regtest passphrase';
const primaryUri = process.env.BEIGNET_TEST_PRIMARY || '028c6651b7759f24585df5864b4f1eaa2fc32acd17eecfef316199bf9a7606ba67@127.0.0.1:19846';
const peerUrl = process.env.BEIGNET_TEST_PEER_WS || 'ws://127.0.0.1:19847';
const btc = (...args) => execFileSync('docker', ['exec', process.env.BEIGNET_REGTEST_BITCOIN || 'bitcoin', 'bitcoin-cli', '-rpcport=43782', '-rpcuser=polaruser', '-rpcpassword=polarpass', '-rpcwallet=default', ...args], { encoding: 'utf8', timeout: 20000 }).trim();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(label, fn, timeout = 120000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try { const value = await fn(); if (value) { console.log('PASS ' + label); return value; } } catch (error) { last = error; }
    await delay(500);
  }
  throw new Error(`${label} timed out${last ? `: ${last.message}` : ''}`);
}
function worker(origin) {
  const thread = new Worker(new URL('./worker-harness.mjs', import.meta.url), { workerData: { source, origin, workerFile, temp } });
  threads.add(thread);
  const pending = new Map(); let next = 0;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  thread.on('message', ({ ready: started, id, result, error }) => {
    if (started) { readyResolve(); return; }
    const waiter = pending.get(id); if (!waiter) return;
    pending.delete(id);
    if (error) waiter.reject(Object.assign(new Error(error.message), error)); else waiter.resolve(result);
  });
  thread.on('error', (error) => { readyReject(error); for (const waiter of pending.values()) waiter.reject(error); pending.clear(); });
  return async (operation, payload) => {
    await ready;
    const result = await new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Worker ${operation} timed out`)); }, 120000);
      pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      thread.postMessage({ id, operation, payload });
    });
    if (operation === 'close') { await thread.terminate(); threads.delete(thread); }
    return result;
  };
}
let bridge, web, call, relay;
try {
  const tcpElectrum = process.env.BEIGNET_TEST_ELECTRUM_TCP || '127.0.0.1:60001';
  bridge = await startBridge({ target: tcpElectrum, listen: '127.0.0.1:0' });
  // Static files only: the origin serves the SQLite WASM and nothing else.
  web = http.createServer((request, response) => {
    if (request.url !== '/engine/sql-wasm.wasm') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/wasm' });
    response.end(fs.readFileSync(path.join(directory, 'engine/sql-wasm.wasm')));
  });
  await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${web.address().port}`;
  const token = randomBytes(32).toString('base64url');
  if (viaRelay) {
    const { attachRelay } = await import('../../beignet-relay/relay.js');
    relay = attachRelay(web, { host: '127.0.0.1', origins: [origin], token, electrum: { host: tcpElectrum.split(':')[0], port: Number(tcpElectrum.split(':')[1]), tls: false },
      peer: { host: primaryUri.split('@')[1].split(':')[0], port: Number(primaryUri.split(':').pop()), tls: false } }, {
      authorizeUpgrade: (request, supplied) => request.headers.origin === origin && supplied === token });
  }
  const electrum = viaRelay ? { host: '127.0.0.1', port: 60001, tls: false } : { host: '127.0.0.1', port: bridge.port, tls: false };
  const connection = viaRelay ? { mode: 'relay', url: origin.replace('http:', 'ws:') + '/transport', token } : { mode: 'direct', peerUrl, chain: { kind: 'electrum-ws', url: bridge.url } };
  const profile = { network: 'regtest', primaryUri, electrum, connection };
  console.log(`Transport: ${connection.mode}`);
  call = worker(origin);
  assert.equal(await call('probe'), false);
  await call('unlock', { password, automatic: true, profile });
  console.log('Vault open through a direct connection; creating a disposable regtest wallet.');
  const created = await call('request', { method: 'POST', path: '/api/wallets', body: { name: 'Direct browser wallet', network: 'regtest', lfbw: { enabled: true, primaryUri } } });
  assert.equal(created.record.network, 'regtest');
  const id = created.record.id;
  const rpc = (suffix, method = 'GET', body) => call('request', { method, path: `/wallets/${id}/api${suffix}`, body });
  const record = () => call('request', { method: 'GET', path: '/api/wallets' }).then((list) => list.find((w) => w.id === id));
  await wait('primary reached over its WebSocket listener', async () => (await record()).lfbw?.setup === 'ready' && (await rpc('/info')).primaryConnected !== false);
  const address = await rpc('/address/new', 'POST', {});
  assert.match(address.address, /^bcrt1/);
  const before = Number((await rpc('/info')).blockHeight ?? 0);
  const txid = btc('sendtoaddress', address.address, '0.001');
  assert.match(txid, /^[0-9a-f]{64}$/);
  btc('generatetoaddress', '1', btc('getnewaddress'));
  await wait('a new block reaches the engine through the Electrum bridge', async () => Number((await rpc('/info')).blockHeight ?? 0) > before);
  await rpc('/wallet/refresh', 'POST', {});
  // The lightning-first rules move a confirmed deposit into the home channel
  // with the primary, so the deposit shows up either as on-chain balance or
  // as a channel being opened over the same WebSocket peer link.
  await wait('the deposit is seen and channelized over the direct peer link', async () => {
    const [balance, channels] = await Promise.all([rpc('/balance'), rpc('/channels')]);
    console.log('balance', JSON.stringify(balance), 'channels', channels.length);
    return Number(balance.onchain ?? 0) >= 100000 || channels.length > 0;
  }, 90000);
  btc('generatetoaddress', '3', btc('getnewaddress'));
  await wait('the home channel locks in and carries a Lightning balance', async () => {
    const balance = await rpc('/balance');
    console.log('balance', JSON.stringify(balance));
    return Number(balance.lightning ?? 0) > 0;
  }, 120000);
  const invoice = await rpc('/invoice/create', 'POST', { amountSats: 1000, description: 'Direct invoice', expirySecs: 300 });
  assert.match(invoice.bolt11, /^lnbcrt/);
  const nodeId = (await rpc('/info')).nodeId;
  const settings = await call('network-settings');
  assert.equal(settings.profiles.regtest.connection.mode, connection.mode);
  await call('close');
  call = worker(origin);
  assert.equal(await call('probe'), true);
  await call('unlock', { password, automatic: true });
  await call('request', { method: 'POST', path: `/api/wallets/${id}/start` });
  await wait('cold restart reconnects the primary from the saved direct connection', async () => (await record()).lfbw?.setup === 'ready');
  assert.equal((await rpc('/info')).nodeId, nodeId);
  await call('close');
  console.log('Production browser worker over a direct connection: CLN WebSocket peer, Electrum WebSocket bridge, block and deposit notifications, and cold restart passed.');
} finally {
  for (const thread of threads) await thread.terminate();
  await relay?.close();
  await bridge?.close();
  if (web) await new Promise((resolve) => web.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}
