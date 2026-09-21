import { sha256 } from '@noble/hashes/sha2.js';

const RECORD_SIZE = 80;
const MAGIC = new TextEncoder().encode('BGNLOG01');
const MAX_STATE = 256 * 1024 * 1024;
const MAX_JOURNAL = 64 * 1024 * 1024;
const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function readExactly(file, size, at = 0) {
  const data = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const count = file.read(data.subarray(offset), { at: at + offset });
    if (!Number.isInteger(count) || count <= 0) throw new Error('Wallet storage read was incomplete.');
    offset += count;
  }
  return data;
}
function writeExactly(file, data, at = 0) {
  let offset = 0;
  while (offset < data.length) {
    const count = file.write(data.subarray(offset), { at: at + offset });
    if (!Number.isInteger(count) || count <= 0) throw new Error('Wallet storage write was incomplete.');
    offset += count;
  }
}
function flush(file) {
  const result = file.flush();
  if (result && typeof result.then === 'function') throw new Error('This browser cannot flush wallet state synchronously. Use a current browser or connect a host.');
}

/** Two data slots, with an append-only commit log. The current slot is never
 * overwritten until a new slot AND its commit record are durably flushed.
 * An incomplete final record was never acknowledged, so it is discarded. A
 * complete but invalid record or committed data is corruption: NEVER roll back.
 * Open handles must be exclusive for the lifetime of the engine. */
export class DurableBlobStore {
  constructor(journal, slots) {
    this.journal = journal;
    this.slots = slots;
    this.failed = false;
    this.closed = false;
    this.sequence = 0;
    this.value = null;
    const size = journal.getSize();
    if (size > MAX_JOURNAL) throw new Error('Wallet commit log exceeds its supported size.');
    this.position = size - (size % RECORD_SIZE);
    if (this.position) {
      const record = readExactly(journal, RECORD_SIZE, this.position - RECORD_SIZE);
      const view = new DataView(record.buffer);
      if (!equal(record.subarray(0, 8), MAGIC) || !equal(record.subarray(48), sha256(record.subarray(0, 48))))
        throw new Error('Wallet commit log is damaged. Refusing to load an older channel state.');
      this.sequence = view.getUint32(8);
      const length = view.getUint32(12);
      if (!this.sequence || this.sequence !== this.position / RECORD_SIZE || length > MAX_STATE)
        throw new Error('Wallet commit log is invalid.');
      const slot = slots[this.sequence % 2];
      if (slot.getSize() !== length) throw new Error('Committed wallet state is incomplete.');
      this.value = readExactly(slot, length);
      if (!equal(record.subarray(16, 48), sha256(this.value)))
        throw new Error('Wallet state is damaged. Refusing to load an older channel state.');
    } else if (slots.some((slot) => slot.getSize() > 0)) {
      // A interrupted first write has no acknowledged state. Do not silently
      // replace it with a new seed; the user should investigate the storage.
      throw new Error('Wallet initialization was interrupted. Existing data was preserved.');
    }
    if (size !== this.position) {
      journal.truncate(this.position);
      flush(journal);
    }
  }
  read() { this.assertOpen(); return this.value?.slice() ?? null; }
  assertOpen() {
    if (this.closed || this.failed) throw new Error('Wallet storage is closed. Unlock it again before continuing.');
  }
  write(data) {
    this.assertOpen();
    if (!(data instanceof Uint8Array) || data.length > MAX_STATE) throw new Error('Wallet state exceeds its supported size.');
    if (this.position + RECORD_SIZE > MAX_JOURNAL) throw new Error('Wallet commit log is full. Close the wallet and export its data.');
    try {
      const next = this.sequence + 1;
      const slot = this.slots[next % 2];
      writeExactly(slot, data);
      slot.truncate(data.length);
      flush(slot);
      const record = new Uint8Array(RECORD_SIZE);
      record.set(MAGIC);
      const view = new DataView(record.buffer);
      view.setUint32(8, next);
      view.setUint32(12, data.length);
      record.set(sha256(data), 16);
      record.set(sha256(record.subarray(0, 48)), 48);
      writeExactly(this.journal, record, this.position);
      flush(this.journal);
      this.sequence = next;
      this.position += RECORD_SIZE;
      this.value = data.slice();
    } catch (error) {
      // No more messages may be released against state whose durability is
      // unknown. A failed flush permanently poisons this open store.
      this.failed = true;
      throw error;
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.value?.fill(0);
    this.value = null;
    for (const file of [...this.slots, this.journal]) file.close();
  }
}

export async function openBrowserStore() {
  if (!globalThis.isSecureContext || !navigator.storage?.getDirectory)
    throw new Error('Local wallets require HTTPS (or localhost) and private browser file storage. You can still connect a host.');
  const handles = [];
  try {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('beignet-wallet-v1', { create: true });
    for (const name of ['commits', 'state-0', 'state-1']) {
      const file = await directory.getFileHandle(name, { create: true });
      if (typeof file.createSyncAccessHandle !== 'function') throw new Error('This browser does not support durable local wallets. Connect a host instead.');
      handles.push(await file.createSyncAccessHandle());
    }
    return new DurableBlobStore(handles[0], handles.slice(1));
  } catch (error) {
    for (const handle of handles) handle.close();
    if (error?.name === 'NoModificationAllowedError') throw new Error('This wallet is already open in another tab. Lock it there first.');
    throw error;
  }
}
