// Read-only smoke of the Electrum shim against a live Esplora API. Network
// access only; nothing is broadcast. BEIGNET_ESPLORA_URL overrides the API.
import assert from 'node:assert/strict';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { createEsploraChain } from '../lib/local/electrum-esplora.mjs';
import { mempoolPushUrl } from '../lib/local/connection.mjs';
const url = process.env.BEIGNET_ESPLORA_URL || 'https://mempool.space/api';
const chain = createEsploraChain({ url, ws: mempoolPushUrl(url), WebSocket: globalThis.WebSocket, fetch: globalThis.fetch });
const socket = chain.openSocket({ host: new URL(url).hostname, port: 443, tls: true });
const lines = [], waiters = [];
socket.on('data', (bytes) => { for (const line of new TextDecoder().decode(bytes).split('\n').filter(Boolean)) { const message = JSON.parse(line); const waiter = waiters.shift(); if (waiter) waiter(message); else lines.push(message); } });
const next = () => new Promise((resolve) => (lines.length ? resolve(lines.shift()) : waiters.push(resolve)));
const ask = (method, params = []) => { socket.write(new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n')); return next(); };
await new Promise((resolve) => socket.on('connect', resolve));
try {
  const genesis = (await ask('blockchain.block.header', [0])).result;
  assert.equal(genesis.length, 160);
  console.log('genesis header', genesis.slice(0, 16));
  const tip = (await ask('blockchain.headers.subscribe')).result;
  assert.ok(tip.height > 800000 || url !== 'https://mempool.space/api');
  console.log('tip', tip.height, tip.hex.slice(0, 16));
  // Electrum names the script by the reversed hash; a well known P2WPKH output script.
  const script = hexToBytes('0014e8df018c7e326cc253faac7e46cdc51e68542c42');
  const scripthash = bytesToHex(sha256(script).reverse());
  const balance = (await ask('blockchain.scripthash.get_balance', [scripthash])).result;
  const history = (await ask('blockchain.scripthash.get_history', [scripthash])).result;
  const status = (await ask('blockchain.scripthash.subscribe', [scripthash])).result;
  console.log('balance', balance, 'history rows', history.length, 'status', status?.slice(0, 16));
  assert.ok(history.length > 0, 'The reversed hash must resolve to the known script history');
  assert.ok(history.every((row, i) => i === 0 || row.height === 0 || row.height >= history[i - 1].height));
  const verbose = (await ask('blockchain.transaction.get', [history[0].tx_hash, true])).result;
  assert.equal(verbose.txid, history[0].tx_hash);
  assert.ok(verbose.confirmations > 0 && verbose.hex.length > 0 && verbose.vout.length > 0);
  console.log('verbose tx', verbose.txid.slice(0, 16), 'confirmations', verbose.confirmations, 'vsize', verbose.vsize);
  const merkle = (await ask('blockchain.transaction.get_merkle', [history[0].tx_hash, history[0].height])).result;
  assert.equal(merkle.block_height, history[0].height);
  const fee = (await ask('blockchain.estimatefee', [6])).result;
  assert.ok(fee > 0);
  console.log('fee for 6 blocks (BTC/kB)', fee);
  const batch = await ask('server.ping');
  assert.equal(batch.result, null);
  console.log('Esplora shim online smoke passed against', url);
} finally { socket.destroy(); chain.close(); }
