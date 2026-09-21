// Run against an explicitly supplied regtest primary using a disposable OPFS
// directory. Creates a quoted receive request; no funding transaction or payment.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { EmbeddedWalletClient } from '@beignet/wallet-core';

const origin = process.env.BEIGNET_TEST_ORIGIN || 'http://127.0.0.1:8787';
const primaryUri = process.env.BEIGNET_TEST_PRIMARY;
assert.ok(process.env.BEIGNET_TEST_ELECTRUM, 'Supply BEIGNET_TEST_ELECTRUM for regtest explicitly');
const server = new URL(process.env.BEIGNET_TEST_ELECTRUM);
assert.ok(primaryUri && /^0[23][0-9a-f]{64}@/.test(primaryUri), 'Supply the regtest primary explicitly');
assert.equal(server.protocol, 'tcp:', 'This disposable check uses the supplied regtest TCP server');
const electrum = { host: server.hostname, port: Number(server.port), tls: false };
const directory = path.resolve('dist/client');
const workerFile = fs.readdirSync(path.join(directory, '_next/static/workers')).find(f => f.startsWith('wallet.worker-'));
const source = fs.readFileSync(path.join(directory, '_next/static/workers', workerFile), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'beignet-jit-regtest-'));
const waiting = new Map();
let nextId = 0, thread, ready;
function startWorker() {
  let readyResolve, readyReject;
  ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  thread = new Worker(new URL('./worker-harness.mjs', import.meta.url), { workerData: { source, origin, workerFile, temp } });
  thread.on('message', ({ ready: started, id, result, error }) => {
    if (started) { readyResolve(); return; }
    const waiter = waiting.get(id); if (!waiter) return;
    waiting.delete(id);
    if (error) waiter.reject(Object.assign(new Error(error.message), error)); else waiter.resolve(result);
  });
  thread.on('error', error => { readyReject(error); for (const waiter of waiting.values()) waiter.reject(error); waiting.clear(); });
}
async function call(operation, payload) {
  await ready;
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { waiting.delete(id); reject(Error(`${operation} timed out`)); }, 150000);
    waiting.set(id, { resolve(value) { clearTimeout(timeout); resolve(value); }, reject(error) { clearTimeout(timeout); reject(error); } });
    thread.postMessage({ id, operation, payload });
  });
}
try {
  const response = await fetch(origin + '/api/browser-config', { method: 'POST', headers: { 'X-Beignet-Transport': '1', Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ network: 'regtest', primaryUri, electrum }) });
  assert.equal(response.status, 200, 'The local companion must allow this regtest profile');
  const options = await response.json();
  assert.equal(options.network, 'regtest');
  startWorker();
  await call('unlock', { password: 'disposable quote verification', options });
  const client = new EmbeddedWalletClient({ runtime: { request: request => call('request', request), close: () => call('close') } });
  const created = await client.createWallet({ name: 'Disposable regtest quote check', network: 'regtest', primaryUri, electrum });
  console.log('Disposable regtest wallet setup:', created.lfbw.setup);
  assert.equal(created.lfbw.setup, 'ready', created.lfbw.setupError || 'Primary did not connect');
  const rpc = suffix => call('request', { method: 'GET', path: `/wallets/${created.id}/api${suffix}` });
  const peers = await rpc('/peers');
  console.log('Primary connection:', JSON.stringify(peers.map(peer => ({ pubkey: peer.pubkey || peer.nodeId, state: peer.state }))));
  const started = Date.now();
  const quote = await client.quoteReceive({ amountSats: 10000, description: 'Regtest quote verification' });
  console.log('Receive quote succeeded:', JSON.stringify({ elapsedMs: Date.now() - started, feeSats: quote.feeSats, warnings: quote.warnings }));
  const invoice = await client.receive(quote);
  assert.match(invoice.bolt11, /^lnbcrt/);
  const second = await client.receive(await client.quoteReceive({ amountSats: 12000, description: 'Second request verification' }));
  assert.notEqual(second.address, invoice.address, 'Unpaid requests must have distinct watched Bitcoin addresses');
  assert.notEqual(second.paymentHash, invoice.paymentHash);
  let gapReached = false;
  for (let count = 0; count < 32; count++) {
    try { await call('request', { method: 'POST', path: `/wallets/${created.id}/api/address/new`, body: {} }); }
    catch (error) {
      assert.equal(error.code, 'RECEIVE_ADDRESS_LIMIT'); gapReached = true; break;
    }
  }
  assert.equal(gapReached, true, 'The inherited unused-address limit remains enforced');
  const lightningOnly = await client.receive(await client.quoteReceive({ amountSats: 15000, description: 'Address-limit fallback verification' }));
  assert.equal(lightningOnly.bitcoinTracking, 'lightning-only');
  assert.equal(lightningOnly.uri, lightningOnly.bolt11);
  assert.equal(lightningOnly.address, undefined);
  assert.equal((await client.getReceiveStatus(lightningOnly)).phase, 'waiting');
  const saved = (await rpc('/receive/requests')).requests;
  assert.equal(saved.length, 3);
  assert.equal(saved.filter(request => request.bitcoinTracking === 'unique').length, 2);
  assert.equal(saved.filter(request => request.bitcoinTracking === 'lightning-only').length, 1);
  assert.deepEqual(saved.map(request => request.uri).sort(), [invoice.uri, second.uri, lightningOnly.uri].sort());
  const status = await client.getReceiveStatus(invoice);
  assert.equal(status.phase, 'waiting');
  const snapshot = await client.snapshot();
  assert.equal(snapshot.activity.filter(item => item.receiveRequest && item.kind === 'request').length, 3);
  assert.equal((await rpc('/channels')).length, 0, 'This check must not open any channel');
  const walletId = created.id;
  await client.close(); await thread.terminate();
  startWorker();
  await call('unlock', { password: 'disposable quote verification', options });
  const reopened = new EmbeddedWalletClient({ runtime: { request: request => call('request', request), close: () => call('close') } });
  const records = await reopened.listWallets();
  assert.ok(records.some(record => record.id === walletId));
  reopened.selectWallet(walletId); await reopened.startWallet();
  assert.deepEqual((await rpc('/receive/requests')).requests, saved, 'Worker restart preserves the exact original URIs and address bindings');
  const restored = await reopened.snapshot();
  assert.equal(restored.activity.filter(item => item.receiveRequest && item.kind === 'request').length, 3);
  assert.ok(restored.activity.filter(item => item.receiveRequest).every(item => item.receiveStatus?.phase === 'waiting'));
  assert.equal((await rpc('/channels')).length, 0);
  console.log('Two distinct unified requests plus a usable Lightning-only fallback at the unchanged Bitcoin address gap, waiting Activity entries and exact persisted URIs verified across full production-worker restart. No payment or funding was attempted.');
  await reopened.close();
} finally {
  await thread?.terminate();
  for (const waiter of waiting.values()) waiter.reject(Error('Test worker closed'));
  waiting.clear();
  fs.rmSync(temp, { recursive: true, force: true });
}
