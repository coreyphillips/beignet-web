// Execute the exact production worker bundle in a browser-like JS realm (no
// Node globals/builtins) with disk-backed OPFS handles and real WS networking.
// This is a runtime integration test, not browser UI or compatibility testing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { Worker } from 'node:worker_threads';
import { randomBytes } from 'node:crypto';
import { attachRelay } from '../../beignet-relay/relay.js';
const directory = path.resolve('dist/client');
const workerFile = fs.readdirSync(path.join(directory, '_next/static/workers')).find((f) => f.startsWith('wallet.worker-'));
assert.ok(workerFile, 'Build the web app first');
const source = fs.readFileSync(path.join(directory, '_next/static/workers', workerFile), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'beignet-web-worker-'));
const threads = new Set();
let relay, web, call;
const token = randomBytes(32).toString('base64url');
const password = process.env.BEIGNET_TEST_PASSWORDLESS === '1' ? '' : 'disposable regtest passphrase';
const primaryUri = '028c6651b7759f24585df5864b4f1eaa2fc32acd17eecfef316199bf9a7606ba67@127.0.0.1:19846';
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

try {
  const electrum = { host: '127.0.0.1', port: 60001, tls: false };
  let origin;
  web = http.createServer(async (request, response) => {
    if (request.url === '/api/browser-config') {
      assert.equal(request.headers['x-beignet-transport'], '1');
      let text = ''; for await (const chunk of request) text += chunk;
      const profile = text ? JSON.parse(text) : { network: 'regtest', primaryUri, electrum };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ...profile, enabled: true, token, expiresAt: Date.now() + 300000,
        peerUrl: origin.replace('http:', 'ws:') + '/transport/peer', electrumUrl: origin.replace('http:', 'ws:') + '/transport/electrum' }));
      return;
    }
    if (request.url !== '/engine/sql-wasm.wasm') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/wasm' });
    response.end(fs.readFileSync(path.join(directory, 'engine/sql-wasm.wasm')));
  });
  await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${web.address().port}`;
  relay = attachRelay(web, { host: '127.0.0.1', origins: [origin], token, electrum,
    peer: { host: '127.0.0.1', port: 19846, tls: false } }, {
    authorizeUpgrade: (request, supplied) => request.headers.origin === origin && supplied === token,
  });
  call = worker(origin);
  assert.equal(await call('probe'), false);
  console.log('Worker loaded; encrypted vault opening.');
  const options = { electrum, token, electrumUrl: origin.replace('http:', 'ws:') + '/transport/electrum', peerUrl: origin.replace('http:', 'ws:') + '/transport/peer' };
  await call('unlock', { password, options });
  console.log('Vault open; creating disposable regtest wallet.');
  const result = await call('request', { method: 'POST', path: '/api/wallets', body: {
    name: 'Browser worker regtest', network: 'regtest',
    lfbw: { enabled: true, primaryUri },
  } });
  assert.equal(result.record.network, 'regtest');
  assert.equal(result.record.lfbw.setup, 'ready');
  assert.ok(result.mnemonic);
  const id = result.record.id;
  const rpc = (suffix, method = 'GET', body) => call('request', { method, path: `/wallets/${id}/api${suffix}`, body });
  await rpc('/wallet/refresh', 'POST', {});
  const address = await rpc('/address/new', 'POST', {});
  assert.match(address.address, /^bcrt1/);
  const invoice = await rpc('/invoice/create', 'POST', { amountSats: 1000, description: 'Worker invoice', expirySecs: 300 });
  assert.match(invoice.bolt11, /^lnbcrt/);
  assert.deepEqual(await rpc('/ffor/epochs'), [], 'A normal invoice must not claim offline coverage');
  const config = await call('request', { path: '/api/config' });
  assert.equal(config.engineVersion, '0.22.0-portable');
  const nodeId = (await rpc('/info')).nodeId;
  const regtestProfile = { network: 'regtest', primaryUri, electrum };
  const provisioned = await call('switch-network', regtestProfile);
  assert.equal(provisioned.wallet.id, id);
  assert.equal((await rpc('/info')).nodeId, nodeId);
  const separate = await call('switch-network', { ...regtestProfile, network: 'testnet' });
  assert.equal(separate.wallet.network, 'testnet');
  assert.notEqual(separate.wallet.id, id);
  assert.equal(separate.wallet.lfbw.setup, 'failed', 'The regtest transport must not start a testnet engine');
  assert.equal(separate.mnemonic, undefined, 'Switching networks must not generate another recovery phrase');
  const testnetPhrase = await call('request', { method: 'GET', path: `/wallets/${separate.wallet.id}/api/mnemonic` });
  assert.ok(testnetPhrase.mnemonic === result.mnemonic, 'Both networks must use the original recovery phrase');
  const returned = await call('switch-network', regtestProfile);
  assert.equal(returned.wallet.id, id);
  assert.equal((await rpc('/info')).nodeId, nodeId);
  assert.ok((await rpc('/invoices')).some(item => item.paymentHash === invoice.paymentHash));
  for (const file of fs.readdirSync(path.join(temp, 'beignet-wallet-v1'))) {
    const contents = fs.readFileSync(path.join(temp, 'beignet-wallet-v1', file));
    assert.ok(!contents.includes(Buffer.from(result.mnemonic)), 'Seed must not be on disk in plaintext');
    assert.ok(!contents.includes(Buffer.from(token)), 'Relay token must not be on disk in plaintext');
  }
  await call('close');
  call = worker(origin);
  assert.equal(await call('probe'), true);
  assert.equal((await call('inspect')).passwordRequired, !!password);
  await assert.rejects(call('unlock', { password: 'wrong password' }), password ? /Unable to unlock/ : /does not use a password/);
  await call('unlock', { password, automatic: true });
  await call('request', { method: 'POST', path: `/api/wallets/${id}/start` });
  assert.equal((await rpc('/info')).nodeId, nodeId);
  assert.ok((await rpc('/invoices')).some((item) => item.paymentHash === invoice.paymentHash));
  await call('close');
  console.log(`Production browser worker (${password ? 'password-protected' : 'passwordless'}): regtest peer, address/invoice, automatic transport, isolated network switch, restored history and cold restart passed.`);
} finally {
  for (const thread of threads) await thread.terminate();
  await relay?.close();
  if (web) await new Promise((resolve) => web.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}
