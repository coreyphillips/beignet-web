import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('../../beignet-relay/node_modules/ws');
const { source, origin, workerFile, temp } = workerData;
const locks = new Set(), timers = new Set();
let sockets = 0;
const schedule = (fn, ms, ...args) => { const t = setTimeout(fn, ms, ...args); timers.add(t); return t; };
function directoryHandle(root) {
  return {
    async getDirectoryHandle(name) { const p = path.join(root, name); fs.mkdirSync(p, { recursive: true }); return directoryHandle(p); },
    async getFileHandle(name) {
      const p = path.join(root, name);
      return { async createSyncAccessHandle() {
        if (locks.has(p)) throw Object.assign(new Error('locked'), { name: 'NoModificationAllowedError' });
        locks.add(p);
        const fd = fs.openSync(p, fs.existsSync(p) ? 'r+' : 'w+', 0o600);
        let closed = false;
        return {
          getSize: () => fs.fstatSync(fd).size,
          read: (bytes, { at = 0 } = {}) => fs.readSync(fd, bytes, 0, bytes.length, at),
          write: (bytes, { at = 0 } = {}) => fs.writeSync(fd, bytes, 0, bytes.length, at),
          truncate: (size) => fs.ftruncateSync(fd, size),
          flush: () => fs.fsyncSync(fd),
          close() { if (!closed) { closed = true; fs.closeSync(fd); locks.delete(p); } },
        };
      } };
    },
  };
}
  const sandbox = {
    isSecureContext: true, importScripts() {}, crypto: webcrypto, TextEncoder, TextDecoder, URL, URLSearchParams,
    Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array,
    ArrayBuffer, DataView, WebAssembly, fetch: (url, options) => fetch(url, { ...options, headers: { ...options?.headers, 'Sec-Fetch-Site': 'same-origin' } }), Response, Request, Headers, AbortController, AbortSignal, performance,
    atob, btoa, console: process.env.BEIGNET_HARNESS_LOG === '1' ? console : { log() {}, warn() {}, error() {}, debug() {} },
    setTimeout: schedule, clearTimeout,
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); timers.add(t); return t; }, clearInterval, queueMicrotask,
    location: { origin, href: `${origin}/_next/static/workers/${workerFile}` },
    navigator: { storage: { getDirectory: async () => directoryHandle(temp) } },
    WebSocket: class { constructor(url, protocols) {
      const socket = new WebSocket(url, protocols, { origin });
      if (process.env.BEIGNET_HARNESS_LOG === '1') {
        const tag = `ws#${++sockets} ${url}`;
        console.error(`harness: ${tag} dialing`);
        socket.on('open', () => console.error(`harness: ${tag} open`));
        socket.on('close', (code, reason) => console.error(`harness: ${tag} close ${code} ${reason}`));
        socket.on('error', (error) => console.error(`harness: ${tag} error ${error.message}`));
        const send = socket.send.bind(socket);
        socket.send = (data, ...rest) => { console.error(`harness: ${tag} send ${typeof data === 'string' ? `text ${data.length}` : `binary ${data.byteLength}`}`); return send(data, ...rest); };
        socket.on('message', (data) => console.error(`harness: ${tag} recv ${data.length ?? data.byteLength}`));
      }
      return socket;
    } },
    postMessage: ({ id, result, error }) => {
      if (process.env.BEIGNET_HARNESS_LOG === '1') console.error(`harness: <- #${id}${error ? ` error ${error.message}` : ''}`);
      parentPort.postMessage({ id, result, error });
    },
  };
sandbox.self = sandbox;
const context = vm.createContext(sandbox);
vm.runInContext(source, context, { filename: workerFile, timeout: 20000 });
const logging = process.env.BEIGNET_HARNESS_LOG === '1';
if (logging) { const started = Date.now(); let last = Date.now(); setInterval(() => { const now = Date.now(); if (now - last > 2000) console.error(`harness: event loop stalled ${now - last}ms`); last = now; }, 1000).unref(); console.error(`harness: started at ${started}`); }
parentPort.on('message', (data) => { if (logging) console.error(`harness: -> ${data.operation} ${data.payload?.path ?? ''} #${data.id}`); void context.onmessage({ data }); });
parentPort.postMessage({ ready: true });
