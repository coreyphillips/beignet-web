import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
// Pure translations between the Electrum protocol the engine speaks and the
// JSON an Esplora style API returns.

// Electrum names a script by the byte-reversed SHA-256 of its scriptPubKey;
// Esplora takes the same hash in forward byte order.
export const reverseHex = (hex) => bytesToHex(hexToBytes(hex).reverse());
// Electrum status: SHA-256 over "txid:height:" for every history row, in order.
export const statusHash = (history) => history.length ? bytesToHex(sha256(new TextEncoder().encode(history.map((row) => `${row.tx_hash}:${row.height}:`).join('')))) : null;
export const balanceFromEsplora = (stats) => ({
  confirmed: (stats.chain_stats?.funded_txo_sum ?? 0) - (stats.chain_stats?.spent_txo_sum ?? 0),
  unconfirmed: (stats.mempool_stats?.funded_txo_sum ?? 0) - (stats.mempool_stats?.spent_txo_sum ?? 0),
});
// Confirmed rows oldest first, then mempool rows. Electrum reports -1 for a
// mempool transaction whose input is itself unconfirmed; the mempool rows for
// this script are the only parents known without further lookups.
export function mempoolRows(mempool) {
  const ids = new Set(mempool.map((tx) => tx.txid));
  return mempool.map((tx) => ({ tx_hash: tx.txid, height: tx.vin.some((input) => ids.has(input.txid)) ? -1 : 0, fee: tx.fee ?? 0 }));
}
export function historyRows(chainNewestFirst, mempool) {
  const confirmed = [...chainNewestFirst].reverse().map((tx) => ({ tx_hash: tx.txid, height: tx.status.block_height }));
  return confirmed.concat(mempoolRows(mempool).map(({ tx_hash, height }) => ({ tx_hash, height })));
}
export const unspentRows = (utxos) => utxos
  .map((utxo) => ({ tx_hash: utxo.txid, tx_pos: utxo.vout, height: utxo.status?.confirmed ? utxo.status.block_height : 0, value: utxo.value }))
  .sort((a, b) => (a.height || Infinity) - (b.height || Infinity));
// Esplora writes push opcodes into the assembly; Bitcoin Core does not.
const asm = (value) => (value || '').replace(/OP_PUSHBYTES_\d+ /g, '').replace(/OP_PUSHNUM_(\d+)/g, '$1');
const btc = (sats) => Number((sats / 1e8).toFixed(8));
export function verboseTransaction(tx, hex, tipHeight) {
  const confirmed = !!tx.status?.confirmed;
  return {
    txid: tx.txid, hash: tx.txid, version: tx.version, size: tx.size, vsize: Math.ceil(tx.weight / 4), weight: tx.weight, locktime: tx.locktime, hex,
    vin: tx.vin.map((input) => input.is_coinbase
      ? { coinbase: input.scriptsig, sequence: input.sequence }
      : { txid: input.txid, vout: input.vout, scriptSig: { asm: asm(input.scriptsig_asm), hex: input.scriptsig || '' }, ...(input.witness?.length ? { txinwitness: input.witness } : {}), sequence: input.sequence }),
    vout: tx.vout.map((output, n) => ({ value: btc(output.value), n, scriptPubKey: {
      asm: asm(output.scriptpubkey_asm), hex: output.scriptpubkey, type: output.scriptpubkey_type,
      ...(output.scriptpubkey_address ? { address: output.scriptpubkey_address, addresses: [output.scriptpubkey_address] } : {}),
    } })),
    ...(confirmed ? { blockhash: tx.status.block_hash, blockheight: tx.status.block_height, confirmations: Math.max(1, tipHeight - tx.status.block_height + 1), time: tx.status.block_time, blocktime: tx.status.block_time } : { confirmations: 0 }),
  };
}
// Electrum quotes BTC per kilobyte; Esplora quotes sat per vbyte by target.
export function feeForTarget(estimates, blocks) {
  const keys = Object.keys(estimates || {}).map(Number).filter((k) => Number.isFinite(k) && estimates[k] > 0).sort((a, b) => a - b);
  if (!keys.length) return -1;
  const key = keys.filter((k) => k <= blocks).pop() ?? keys[0];
  return Number(((estimates[key] * 1000) / 1e8).toFixed(8)) || -1;
}
export const MISSING_TRANSACTION = 'No such mempool or blockchain transaction. Use gettransaction for wallet transactions.';
