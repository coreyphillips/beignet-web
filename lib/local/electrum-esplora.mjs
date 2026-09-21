import { createSocketShell, bytesOf } from './socket-shell.mjs';
import { createEsploraClient, EsploraError } from './esplora-client.mjs';
import { reverseHex, statusHash, balanceFromEsplora, historyRows, mempoolRows, unspentRows, verboseTransaction, feeForTarget, MISSING_TRANSACTION } from './electrum-methods.mjs';
// An Electrum server the engine talks to in the browser, answered from an
// Esplora style REST API. The engine writes newline-delimited JSON-RPC to a
// socket from the transport; this socket parses those lines, answers each
// request from the API, and pushes header and script status notifications
// the way an Electrum server does. Blocks arrive from mempool.space's push
// socket when available, otherwise by polling. Script activity is polled,
// since the API has no subscription keyed by script hash.
const TIP_TTL = 10000, HEADER_TTL = 3600000, FEE_TTL = 60000, TX_TTL = 10000, POLL_BLOCKS = 30000, POLL_SCRIPTS = 60000, PAGE = 25, MAX_PAGES = 40;
const encoder = new TextEncoder(), decoder = new TextDecoder();
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
export function createEsploraChain({ url, ws, WebSocket: W = globalThis.WebSocket, fetch: fetcher = globalThis.fetch, setTimeout: later = globalThis.setTimeout, setInterval: every = globalThis.setInterval, clearInterval: stop = globalThis.clearInterval }) {
  const api = createEsploraClient({ url, fetch: fetcher });
  const sockets = new Set();
  const watched = new Map(); // esplora hash -> { electrum, status, counts, sockets }
  let tip = null, feed = null, blockTimer = null, scriptTimer = null, backoff = 5000, closed = false;

  async function header(height) { const hash = await api.get(`/block-height/${height}`, { text: true, ttl: HEADER_TTL }); return api.get(`/block/${hash}/header`, { text: true, ttl: HEADER_TTL }); }
  async function currentTip() {
    if (tip && tip.expires > Date.now()) return tip;
    const hash = await api.get('/blocks/tip/hash', { text: true });
    if (tip?.hash === hash) { tip.expires = Date.now() + TIP_TTL; return tip; }
    const [height, hex] = await Promise.all([api.get('/blocks/tip/height'), api.get(`/block/${hash}/header`, { text: true, ttl: HEADER_TTL })]);
    return (tip = { hash, height: Number(height), hex, expires: Date.now() + TIP_TTL });
  }
  async function transaction(txid) {
    try {
      const [tx, hex] = await Promise.all([api.get(`/tx/${txid}`, { ttl: TX_TTL }), api.get(`/tx/${txid}/hex`, { text: true, ttl: HEADER_TTL })]);
      return { tx, hex };
    } catch (error) { if (error instanceof EsploraError && error.status === 404) return null; throw error; }
  }
  async function chainPages(hash) {
    const rows = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = await api.get(`/scripthash/${hash}/txs/chain${rows.length ? `/${rows.at(-1).txid}` : ''}`);
      rows.push(...batch);
      if (batch.length < PAGE) break;
    }
    return rows;
  }
  async function history(hash) {
    const [chain, mempool] = await Promise.all([chainPages(hash), api.get(`/scripthash/${hash}/txs/mempool`)]);
    return { chain, mempool, rows: historyRows(chain, mempool) };
  }
  async function counts(hash) { const stats = await api.get(`/scripthash/${hash}`); return `${stats.chain_stats?.tx_count ?? 0}:${stats.mempool_stats?.tx_count ?? 0}`; }

  // Header feed: push socket when the API offers one, polling otherwise and as a backstop.
  async function onBlock(hash) {
    if (closed || !hash || tip?.hash === hash) return;
    try {
      const [height, hex] = await Promise.all([api.get(`/block/${hash}`).then((block) => block.height), api.get(`/block/${hash}/header`, { text: true, ttl: HEADER_TTL })]);
      if (closed) return;
      tip = { hash, height, hex, expires: Date.now() + TIP_TTL };
      api.forget('/scripthash/');
      for (const socket of sockets) if (socket.headers) socket.notify('blockchain.headers.subscribe', [{ height, hex }]);
      void recheckAll();
    } catch { /* the next poll or push retries */ }
  }
  async function pollTip() { try { await onBlock(await api.get('/blocks/tip/hash', { text: true })); } catch { /* retried on the next interval */ } }
  function connectFeed() {
    if (closed || !ws || !W || feed) return;
    let socket;
    try { socket = new W(ws); } catch { return; }
    feed = socket;
    socket.onopen = () => { backoff = 5000; socket.send(JSON.stringify({ action: 'want', data: ['blocks'] })); };
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      let message; try { message = JSON.parse(event.data); } catch { return; }
      const block = message.block ?? (Array.isArray(message.blocks) ? message.blocks.at(-1) : undefined);
      if (block?.id) void onBlock(block.id);
    };
    socket.onerror = () => {};
    socket.onclose = () => { feed = null; if (!closed) later(connectFeed, (backoff = Math.min(backoff * 2, 120000))); };
  }
  function startFeeds() {
    if (blockTimer) return;
    connectFeed();
    blockTimer = every(pollTip, ws ? POLL_BLOCKS * 4 : POLL_BLOCKS);
    scriptTimer = every(() => void recheckAll(), POLL_SCRIPTS);
  }

  // Script status: recomputed when a block arrives, on an interval, and after a broadcast.
  async function recheck(hash, force = false) {
    const entry = watched.get(hash);
    if (!entry || closed) return;
    try {
      const seen = await counts(hash);
      if (!force && seen === entry.counts) return;
      const { rows } = await history(hash);
      const status = statusHash(rows);
      entry.counts = seen;
      if (status === entry.status) return;
      entry.status = status;
      for (const socket of entry.sockets) socket.notify('blockchain.scripthash.subscribe', [entry.electrum, status]);
    } catch { /* retried on the next trigger */ }
  }
  async function recheckAll(force = false) { for (const hash of Array.from(watched.keys())) await recheck(hash, force); }

  const methods = {
    'server.version': async () => ['beignet-esplora/0.1', '1.4'],
    'server.ping': async () => null,
    'server.banner': async () => `Electrum over ${url}`,
    'blockchain.relayfee': async () => 0.00001,
    'blockchain.headers.subscribe': async (_params, socket) => { socket.headers = true; startFeeds(); const { height, hex } = await currentTip(); return { height, hex }; },
    'blockchain.block.header': async ([height]) => header(Number(height)),
    'blockchain.estimatefee': async ([blocks]) => {
      try { return feeForTarget(await api.get('/fee-estimates', { ttl: FEE_TTL }), Number(blocks)); } catch { /* try the mempool.space shape */ }
      try {
        const fees = await api.get('/v1/fees/recommended', { ttl: FEE_TTL });
        return feeForTarget({ 1: fees.fastestFee, 3: fees.halfHourFee, 6: fees.hourFee, 24: fees.economyFee, 144: fees.minimumFee }, Number(blocks));
      } catch { return -1; }
    },
    'blockchain.scripthash.get_balance': async ([sh]) => balanceFromEsplora(await api.get(`/scripthash/${reverseHex(sh)}`)),
    'blockchain.scripthash.get_history': async ([sh]) => (await history(reverseHex(sh))).rows,
    'blockchain.scripthash.get_mempool': async ([sh]) => mempoolRows(await api.get(`/scripthash/${reverseHex(sh)}/txs/mempool`)),
    'blockchain.scripthash.listunspent': async ([sh]) => unspentRows(await api.get(`/scripthash/${reverseHex(sh)}/utxo`)),
    'blockchain.scripthash.subscribe': async ([sh], socket) => {
      const hash = reverseHex(sh);
      startFeeds();
      let entry = watched.get(hash);
      if (!entry) {
        const [seen, { rows }] = await Promise.all([counts(hash), history(hash)]);
        entry = watched.get(hash) ?? { electrum: sh, status: statusHash(rows), counts: seen, sockets: new Set() };
        watched.set(hash, entry);
      }
      entry.sockets.add(socket); socket.scripts.add(hash);
      return entry.status;
    },
    'blockchain.transaction.get': async ([txid, verbose]) => {
      const found = await transaction(txid);
      if (!found) throw Object.assign(new Error(MISSING_TRANSACTION), { code: 2 });
      if (!verbose) return found.hex;
      return verboseTransaction(found.tx, found.hex, (await currentTip()).height);
    },
    'blockchain.transaction.get_merkle': async ([txid]) => api.get(`/tx/${txid}/merkle-proof`, { ttl: HEADER_TTL }),
    'blockchain.transaction.broadcast': async ([hex]) => {
      let txid;
      try { txid = await api.post('/tx', hex, { text: true }); }
      catch (error) { throw Object.assign(new Error(`Broadcast rejected: ${error instanceof EsploraError ? error.body : error?.message}`), { code: -26 }); }
      if (!/^[0-9a-f]{64}$/.test(txid)) throw Object.assign(new Error(`Broadcast rejected: ${txid.slice(0, 120)}`), { code: -26 });
      api.forget('/scripthash/'); api.forget(`/tx/${txid}`);
      later(() => void recheckAll(true), 2000);
      return txid;
    },
  };
  async function answer(request, socket) {
    const id = request?.id;
    if (!request || typeof request.method !== 'string' || !Array.isArray(request.params ?? [])) return rpcError(id ?? null, -32600, 'Invalid request');
    const method = methods[request.method];
    if (!method) return rpcError(id, -32601, `Unknown method ${request.method}`);
    try { return { jsonrpc: '2.0', id, result: await method(request.params ?? [], socket) }; }
    catch (error) { return rpcError(id, error?.code ?? (error instanceof EsploraError ? -32000 : 1), error?.message ?? 'Request failed'); }
  }

  return {
    openSocket(target) {
      const socket = createSocketShell();
      socket.headers = false; socket.scripts = new Set();
      let inbound = '';
      const send = (message) => { if (!socket.destroyed) socket.emit('data', encoder.encode(JSON.stringify(message) + '\n')); };
      socket.notify = (method, params) => send({ jsonrpc: '2.0', method, params });
      socket.write = (data, callback) => {
        if (socket.destroyed) throw new Error('Electrum socket is closed');
        inbound += decoder.decode(bytesOf(data), { stream: true });
        let index;
        while ((index = inbound.indexOf('\n')) >= 0) {
          const line = inbound.slice(0, index).trim();
          inbound = inbound.slice(index + 1);
          if (!line) continue;
          let parsed; try { parsed = JSON.parse(line); } catch { send(rpcError(null, -32700, 'Parse error')); continue; }
          if (Array.isArray(parsed)) void Promise.all(parsed.map((request) => answer(request, socket))).then(send);
          else void answer(parsed, socket).then(send);
        }
        callback?.();
        return true;
      };
      const detach = () => { for (const hash of socket.scripts) watched.get(hash)?.sockets.delete(socket); socket.scripts.clear(); sockets.delete(socket); };
      socket.end = () => { socket.destroyed = true; detach(); queueMicrotask(() => socket.finish()); };
      socket.destroy = (error) => { socket.destroyed = true; detach(); if (error) socket.fail(error); queueMicrotask(() => socket.finish()); };
      sockets.add(socket);
      queueMicrotask(() => { if (!socket.destroyed) { socket.emit('connect'); if (target?.tls) socket.emit('secureConnect'); } });
      return socket;
    },
    close() {
      closed = true;
      if (blockTimer) stop(blockTimer); if (scriptTimer) stop(scriptTimer); blockTimer = scriptTimer = null;
      try { feed?.close(); } catch { /* already closed */ }
      feed = null;
      for (const socket of Array.from(sockets)) socket.destroy();
      watched.clear(); api.close();
    },
  };
}
