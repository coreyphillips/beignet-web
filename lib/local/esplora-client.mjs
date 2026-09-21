// A small client for an Esplora style REST API (mempool.space, Blockstream,
// or a self-hosted instance): bounded concurrency, coalesced duplicate
// requests and short caches, so the engine's Electrum traffic does not
// become a flood of identical HTTP calls.
export class EsploraError extends Error {
  constructor(status, body, path) { super(`Block explorer API returned ${status} for ${path}`); this.status = status; this.body = body; }
}
export function createEsploraClient({ url, fetch: fetcher = globalThis.fetch, concurrency = 4, now = () => Date.now() }) {
  const base = url.replace(/\/+$/, '');
  const cache = new Map(), inflight = new Map(), queue = [];
  let active = 0, closed = false;
  const pump = () => {
    while (active < concurrency && queue.length) { active++; const run = queue.shift(); run().finally(() => { active--; pump(); }); }
  };
  const schedule = (task) => new Promise((resolve, reject) => { queue.push(() => task().then(resolve, reject)); pump(); });
  async function request(method, path, { body, text = false, ttl = 0 } = {}) {
    if (closed) throw new Error('Block explorer client is closed');
    const key = `${method} ${path}`;
    if (ttl) { const hit = cache.get(key); if (hit && hit.expires > now()) return hit.value; }
    if (inflight.has(key)) return inflight.get(key);
    const promise = schedule(async () => {
      const response = await fetcher(base + path, { method, ...(body !== undefined ? { body, headers: { 'Content-Type': 'text/plain' } } : {}), signal: AbortSignal.timeout(15000) });
      const raw = await response.text();
      if (!response.ok) throw new EsploraError(response.status, raw.slice(0, 200), path);
      const value = text ? raw.trim() : JSON.parse(raw);
      if (ttl) cache.set(key, { value, expires: now() + ttl });
      return value;
    }).finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }
  return {
    get: (path, options) => request('GET', path, options),
    post: (path, body, options) => request('POST', path, { ...options, body }),
    forget(prefix) { for (const key of cache.keys()) if (key.includes(prefix)) cache.delete(key); },
    close() { closed = true; cache.clear(); },
  };
}
