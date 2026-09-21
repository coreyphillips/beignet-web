import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createEsploraChain } from '../lib/local/electrum-esplora.mjs';
import { reverseHex, statusHash, mempoolRows, historyRows, unspentRows, feeForTarget, verboseTransaction, MISSING_TRANSACTION } from '../lib/local/electrum-methods.mjs';

const SH = 'ab'.repeat(32), ESPLORA = reverseHex(SH);
const TX1 = '1'.repeat(64), TX2 = '2'.repeat(64), TX3 = '3'.repeat(64), HASH = 'f'.repeat(64), HEADER = '0'.repeat(160);
const encode = (value) => new TextEncoder().encode(value);
const tx = (txid, height, vin = [{ txid: '9'.repeat(64), vout: 0, scriptsig: '', scriptsig_asm: '', sequence: 4294967295, witness: ['aa'] }]) => ({
  txid, version: 2, locktime: 0, size: 200, weight: 500, fee: 150, vin,
  vout: [{ scriptpubkey: '0014' + 'e8'.repeat(20), scriptpubkey_asm: 'OP_0 OP_PUSHBYTES_20 ' + 'e8'.repeat(20), scriptpubkey_type: 'v0_p2wpkh', scriptpubkey_address: 'bcrt1q', value: 123456 }],
  status: height ? { confirmed: true, block_height: height, block_hash: HASH, block_time: 1700000000 } : { confirmed: false },
});
function world() {
  const routes = new Map(), calls = [], timers = [];
  const set = (path, value) => routes.set(path, value);
  set('/blocks/tip/hash', HASH); set('/blocks/tip/height', 800); set(`/block/${HASH}/header`, HEADER); set(`/block/${HASH}`, { height: 800, id: HASH });
  set('/block-height/0', 'g'.repeat(64)); set('/block/' + 'g'.repeat(64) + '/header', 'a'.repeat(160));
  set(`/scripthash/${ESPLORA}`, { chain_stats: { funded_txo_sum: 5000, spent_txo_sum: 1000, tx_count: 1 }, mempool_stats: { funded_txo_sum: 300, spent_txo_sum: 0, tx_count: 0 } });
  set(`/scripthash/${ESPLORA}/txs/chain`, [tx(TX1, 790)]); set(`/scripthash/${ESPLORA}/txs/mempool`, []);
  set(`/scripthash/${ESPLORA}/utxo`, [{ txid: TX1, vout: 0, value: 4000, status: { confirmed: true, block_height: 790 } }]);
  set(`/tx/${TX1}`, tx(TX1, 790)); set(`/tx/${TX1}/hex`, '02000000deadbeef'); set(`/tx/${TX1}/merkle-proof`, { block_height: 790, merkle: [TX2], pos: 1 });
  set('/fee-estimates', { 1: 20, 2: 18, 6: 10, 144: 2 });
  const fetcher = async (url, options = {}) => {
    const path = new URL(url).pathname.replace(/^\/api/, '');
    calls.push(`${options.method ?? 'GET'} ${path}`);
    if (options.method === 'POST' && path === '/tx') return new Response(options.body === 'bad' ? 'sendrawtransaction RPC error: dust' : TX3, { status: options.body === 'bad' ? 400 : 200 });
    if (!routes.has(path)) return new Response('not found', { status: 404 });
    const value = routes.get(path);
    return new Response(typeof value === 'string' ? value : JSON.stringify(value), { status: 200 });
  };
  const chain = createEsploraChain({ url: 'https://explorer.test/api', fetch: fetcher, WebSocket: undefined,
    setTimeout: (fn) => { timers.push(fn); return 1; }, setInterval: (fn) => { timers.push(fn); return 1; }, clearInterval() {} });
  return { chain, routes, calls, timers, set };
}
// Drive one socket like the engine does: write a line, read back the JSON line(s).
function client(chain, target = { host: 'explorer.test', port: 443, tls: true }) {
  const socket = chain.openSocket(target);
  const lines = [], waiters = [];
  socket.on('data', (bytes) => { for (const line of new TextDecoder().decode(bytes).split('\n').filter(Boolean)) { const message = JSON.parse(line); const waiter = waiters.shift(); if (waiter) waiter(message); else lines.push(message); } });
  const next = () => new Promise((resolve) => (lines.length ? resolve(lines.shift()) : waiters.push(resolve)));
  const ask = (request) => { socket.write(encode(JSON.stringify(request) + '\n')); return next(); };
  return { socket, ask, next, pending: () => lines.length };
}
const connected = (socket) => new Promise((resolve) => socket.on('connect', resolve));

test('the connect handshake, keepalive and a batch are answered from the API as one line each', async () => {
  const { chain } = world();
  const { socket, ask } = client(chain);
  await connected(socket);
  assert.deepEqual((await ask({ jsonrpc: '2.0', id: 1, method: 'server.version', params: ['beignet', '1.4'] })).result, ['beignet-esplora/0.1', '1.4']);
  assert.deepEqual(await ask({ jsonrpc: '2.0', id: 2, method: 'server.ping', params: [] }), { jsonrpc: '2.0', id: 2, result: null });
  const batch = await ask([{ jsonrpc: '2.0', id: 3, method: 'blockchain.scripthash.get_balance', params: [SH] }, { jsonrpc: '2.0', id: 4, method: 'blockchain.block.header', params: [0] }, { jsonrpc: '2.0', id: 5, method: 'nope', params: [] }]);
  assert.deepEqual(batch.map((r) => r.id), [3, 4, 5]);
  assert.deepEqual(batch[0].result, { confirmed: 4000, unconfirmed: 300 });
  assert.equal(batch[1].result, 'a'.repeat(160));
  assert.match(batch[2].error.message, /Unknown method/);
  chain.close();
});
test('script status follows the Electrum rules and is pushed once per change without an id', async () => {
  const { chain, set, timers } = world();
  const { socket, ask, next, pending } = client(chain);
  await connected(socket);
  const history = (await ask({ id: 1, method: 'blockchain.scripthash.get_history', params: [SH] })).result;
  assert.deepEqual(history, [{ tx_hash: TX1, height: 790 }]);
  const expected = bytesToHex(sha256(encode(`${TX1}:790:`)));
  assert.equal((await ask({ id: 2, method: 'blockchain.scripthash.subscribe', params: [SH] })).result, expected);
  assert.equal(statusHash(history), expected);
  assert.equal(statusHash([]), null);
  // Nothing changed on the API: the poll stays quiet.
  for (const timer of timers) await timer();
  assert.equal(pending(), 0);
  // A mempool payment arrives, then the poll notices the count change.
  set(`/scripthash/${ESPLORA}`, { chain_stats: { funded_txo_sum: 5000, spent_txo_sum: 1000, tx_count: 1 }, mempool_stats: { funded_txo_sum: 300, spent_txo_sum: 0, tx_count: 1 } });
  set(`/scripthash/${ESPLORA}/txs/mempool`, [tx(TX2, 0)]);
  for (const timer of timers) await timer();
  const notification = await next();
  assert.deepEqual(Object.keys(notification), ['jsonrpc', 'method', 'params']);
  assert.equal(notification.method, 'blockchain.scripthash.subscribe');
  assert.equal(notification.params[0], SH);
  assert.equal(notification.params[1], bytesToHex(sha256(encode(`${TX1}:790:${TX2}:0:`))));
  for (const timer of timers) await timer();
  assert.equal(pending(), 0, 'An unchanged status is not repeated');
  chain.close();
});
test('headers are served from the tip and pushed when the tip hash changes', async () => {
  const { chain, set, timers } = world();
  const { socket, ask, next } = client(chain);
  await connected(socket);
  assert.deepEqual((await ask({ id: 1, method: 'blockchain.headers.subscribe', params: [] })).result, { height: 800, hex: HEADER });
  const NEXT = 'e'.repeat(64);
  set('/blocks/tip/hash', NEXT); set(`/block/${NEXT}`, { height: 801, id: NEXT }); set(`/block/${NEXT}/header`, '1'.repeat(160));
  for (const timer of timers) await timer();
  const notification = await next();
  assert.deepEqual(notification, { jsonrpc: '2.0', method: 'blockchain.headers.subscribe', params: [{ height: 801, hex: '1'.repeat(160) }] });
  chain.close();
});
test('transactions, proofs, fees and broadcasts translate to the shapes the engine reads', async () => {
  const { chain, calls, set } = world();
  const { socket, ask } = client(chain);
  await connected(socket);
  const verbose = (await ask({ id: 1, method: 'blockchain.transaction.get', params: [TX1, true] })).result;
  assert.equal(verbose.hex, '02000000deadbeef');
  assert.equal(verbose.confirmations, 11);
  assert.equal(verbose.blockhash, HASH);
  assert.equal(verbose.vsize, 125);
  assert.deepEqual(verbose.vout[0], { value: 0.00123456, n: 0, scriptPubKey: { asm: 'OP_0 ' + 'e8'.repeat(20), hex: '0014' + 'e8'.repeat(20), type: 'v0_p2wpkh', address: 'bcrt1q', addresses: ['bcrt1q'] } });
  assert.equal(verbose.vin[0].txid, '9'.repeat(64));
  assert.deepEqual(verbose.vin[0].txinwitness, ['aa']);
  assert.equal((await ask({ id: 2, method: 'blockchain.transaction.get', params: [TX1, false] })).result, '02000000deadbeef');
  const missing = await ask({ id: 3, method: 'blockchain.transaction.get', params: [TX2, true] });
  assert.equal(missing.error.message, MISSING_TRANSACTION);
  assert.deepEqual((await ask({ id: 4, method: 'blockchain.transaction.get_merkle', params: [TX1, 790] })).result, { block_height: 790, merkle: [TX2], pos: 1 });
  assert.equal((await ask({ id: 5, method: 'blockchain.estimatefee', params: [6] })).result, 0.0001);
  assert.equal((await ask({ id: 6, method: 'blockchain.estimatefee', params: [3] })).result, 0.00018);
  assert.deepEqual((await ask({ id: 7, method: 'blockchain.scripthash.listunspent', params: [SH] })).result, [{ tx_hash: TX1, tx_pos: 0, height: 790, value: 4000 }]);
  assert.equal((await ask({ id: 8, method: 'blockchain.transaction.broadcast', params: ['0200aa'] })).result, TX3);
  assert.match((await ask({ id: 9, method: 'blockchain.transaction.broadcast', params: ['bad'] })).error.message, /dust/);
  set('/fee-estimates', undefined); calls.length = 0;
  assert.equal((await ask({ id: 10, method: 'blockchain.estimatefee', params: [2] })).result, 0.00018, 'Fee estimates are cached');
  chain.close();
});
test('a one-shot query socket writes on connect and may be destroyed after the first line', async () => {
  const { chain } = world();
  const socket = chain.openSocket({ host: 'explorer.test', port: 443, tls: true });
  const seen = [];
  socket.on('connect', () => socket.write(encode(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'blockchain.block.header', params: [0] }) + '\n')));
  socket.on('data', (bytes) => { seen.push(new TextDecoder().decode(bytes)); socket.destroy(); });
  socket.on('close', () => seen.push('close'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(seen.length, 2);
  assert.match(seen[0], /"result":"a{160}"\}\n$/);
  assert.equal(seen[1], 'close');
  assert.throws(() => socket.write('x'), /closed/);
  chain.close();
});
test('pure translations: hash order, history heights, unspent order and fee units', () => {
  assert.equal(reverseHex('0011ff'), 'ff1100');
  const parent = tx(TX1, 0), child = tx(TX2, 0, [{ txid: TX1, vout: 0, scriptsig: '', scriptsig_asm: '', sequence: 0, witness: [] }]);
  assert.deepEqual(mempoolRows([parent, child]), [{ tx_hash: TX1, height: 0, fee: 150 }, { tx_hash: TX2, height: -1, fee: 150 }]);
  assert.deepEqual(historyRows([tx(TX3, 795), tx(TX1, 790)], [parent]), [{ tx_hash: TX1, height: 790 }, { tx_hash: TX3, height: 795 }, { tx_hash: TX1, height: 0 }]);
  assert.deepEqual(unspentRows([{ txid: TX2, vout: 1, value: 1, status: { confirmed: false } }, { txid: TX1, vout: 0, value: 2, status: { confirmed: true, block_height: 5 } }]).map((r) => r.height), [5, 0]);
  assert.equal(feeForTarget({ 1: 50, 144: 1 }, 144), 0.00001);
  assert.equal(feeForTarget({}, 2), -1);
  assert.equal(verboseTransaction(tx(TX1, 0), 'aa', 800).confirmations, 0);
});
