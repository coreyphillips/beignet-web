// Production-worker startup regression. Uses only disposable encrypted fixture
// files: no network connection, actual wallet, mnemonic, or payment operation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { DurableBlobStore } from '../lib/local/durable-store.mjs';
import { unlockVault } from '../lib/local/vault.mjs';

const directory = path.resolve('dist/client/_next/static/workers');
const workerFile = fs.readdirSync(directory).find(name => name.startsWith('wallet.worker-'));
assert.ok(workerFile, 'Build the web app before running this production-worker check');
const source = fs.readFileSync(path.join(directory, workerFile), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'beignet-large-vault-'));
function handle(file) {
  const fd = fs.openSync(file, 'w+', 0o600);
  return { getSize: () => fs.fstatSync(fd).size,
    read: (bytes, { at = 0 } = {}) => fs.readSync(fd, bytes, 0, bytes.length, at),
    write: (bytes, { at = 0 } = {}) => fs.writeSync(fd, bytes, 0, bytes.length, at),
    truncate: size => fs.ftruncateSync(fd, size), flush: () => fs.fsyncSync(fd), close: () => fs.closeSync(fd) };
}
const hashes = files => files.map(file => createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
try {
  for (const password of ['', 'disposable large wallet']) {
    const root = path.join(temp, password ? 'protected' : 'unprotected');
    const vaultDirectory = path.join(root, 'beignet-wallet-v1'); fs.mkdirSync(vaultDirectory, { recursive: true });
    const files = ['commits', 'state-0', 'state-1'].map(name => path.join(vaultDirectory, name));
    const handles = files.map(handle), store = new DurableBlobStore(handles[0], handles.slice(1));
    const vault = await unlockVault(store, password);
    vault.write(new Uint8Array(8 * 1024 * 1024).fill(37)); vault.close();
    const original = hashes(files);
    for (let restart = 0; restart < 2; restart++) {
      const worker = new Worker(new URL('./worker-harness.mjs', import.meta.url), {
        workerData: { source, origin: 'http://127.0.0.1:8787', workerFile, temp: root },
      });
      try {
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('Wallet inspection timed out')), 20000);
          worker.once('error', error => { clearTimeout(timer); reject(error); });
          worker.on('message', message => {
            if (message.ready) worker.postMessage({ id: 1, operation: 'inspect' });
            else if (message.id === 1) {
              clearTimeout(timer);
              if (message.error) reject(Object.assign(Error(message.error.message), message.error));
              else resolve(message.result);
            }
          });
        });
        assert.deepEqual(result, { exists: true, passwordRequired: !!password });
      } finally { await worker.terminate(); }
      assert.deepEqual(hashes(files), original, 'Inspection must not modify saved data');
    }
    console.log(`Production worker inspected the large ${password ? 'protected' : 'passwordless'} wallet across two fresh workers; saved files unchanged.`);
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
