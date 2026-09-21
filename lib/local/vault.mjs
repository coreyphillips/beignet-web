import { gcm } from '@noble/ciphers/aes.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const AAD = encoder.encode('beignet-browser-vault-v1');
const LOCAL_AAD = encoder.encode('beignet-browser-vault-v2-unprotected');
const ITERATIONS = 600000;
const MAX_ENVELOPE = 256 * 1024 * 1024;
const bytes = (length) => crypto.getRandomValues(new Uint8Array(length));
const encode = (data) => {
  let text = '';
  for (let i = 0; i < data.length; i += 8192) text += String.fromCharCode(...data.subarray(i, i + 8192));
  return btoa(text);
};
const decode = (data) => Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
function encodedBytes(value, length) {
  if (typeof value !== 'string' || value.length % 4 !== 0) throw new Error('Wallet vault is damaged.');
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  // A repeated-group regex exhausts the JS regexp stack on multi-megabyte
  // ciphertext. Scan the alphabet once and allow padding only at the end.
  if (/[^A-Za-z0-9+/]/.test(value.slice(0, value.length - padding)))
    throw new Error('Wallet vault is damaged.');
  const result = decode(value);
  if (length !== undefined && result.length !== length) throw new Error('Wallet vault is damaged.');
  return result;
}
function envelopeFrom(raw) {
  if (raw.length > MAX_ENVELOPE) throw new Error('Wallet vault is too large.');
  let envelope;
  try { envelope = JSON.parse(decoder.decode(raw)); }
  catch { throw new Error('Wallet vault is damaged.'); }
  if (!envelope || typeof envelope !== 'object') throw new Error('Wallet vault is damaged.');
  if (envelope.version === 1 && envelope.iterations === ITERATIONS) {
    encodedBytes(envelope.salt, 32);
    encodedBytes(envelope.wrapNonce, 12);
    encodedBytes(envelope.wrappedKey, 48);
  } else if (envelope.version === 2 && envelope.protection === 'none') {
    encodedBytes(envelope.key, 32);
  } else throw new Error('Unsupported wallet vault format.');
  encodedBytes(envelope.nonce, 12);
  if (encodedBytes(envelope.state).length < 16) throw new Error('Wallet vault is damaged.');
  return envelope;
}

// Inspect only the protection choice. Invalid existing data never becomes a
// blank wallet or silently loses its password requirement.
export function inspectVault(raw) {
  if (!raw) return { exists: false, passwordRequired: false };
  const envelope = envelopeFrom(raw);
  return { exists: true, passwordRequired: envelope.version === 1 };
}
async function passwordKey(password, salt) {
  const input = encoder.encode(password);
  try {
    const material = await crypto.subtle.importKey('raw', input, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, material,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } finally { input.fill(0); }
}

/** Password-protected v1 vaults remain unchanged. Optional-password v2 stores
 * its random key locally: it provides no password protection or confidentiality
 * from someone who can access this browser's profile. Both retain the same
 * authenticated state format and synchronous durable write boundaries. */
export async function unlockVault(store, password) {
  if (typeof password !== 'string') throw new Error('Invalid wallet password.');
  const raw = store.read();
  let header, key, value, aad = AAD;
  if (raw) {
    const envelope = envelopeFrom(raw);
    if (envelope.version === 2 && password.length) throw new Error('This wallet does not use a password. Open it without one.');
    try {
      if (envelope.version === 1) {
        header = { version: 1, iterations: ITERATIONS, salt: envelope.salt, wrapNonce: envelope.wrapNonce, wrappedKey: envelope.wrappedKey };
        const wrapKey = await passwordKey(password, decode(header.salt));
        key = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(header.wrapNonce), additionalData: AAD }, wrapKey, decode(header.wrappedKey)));
      } else {
        header = { version: 2, protection: 'none', key: envelope.key };
        key = decode(header.key);
        aad = LOCAL_AAD;
      }
      value = gcm(key, decode(envelope.nonce), aad).decrypt(decode(envelope.state));
    } catch {
      key?.fill(0);
      throw new Error('Unable to unlock. Check your password; damaged wallet data also cannot be opened.');
    }
  } else {
    key = bytes(32);
    if (password.length) {
      const salt = bytes(32), nonce = bytes(12);
      const wrapKey = await passwordKey(password, salt);
      const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: AAD }, wrapKey, key));
      header = { version: 1, iterations: ITERATIONS, salt: encode(salt), wrapNonce: encode(nonce), wrappedKey: encode(wrapped) };
    } else {
      header = { version: 2, protection: 'none', key: encode(key) };
      aad = LOCAL_AAD;
    }
    value = null;
  }
  let closed = false;
  const vault = {
    read() { if (closed) throw new Error('Wallet is locked.'); return value?.slice() ?? null; },
    write(data) {
      if (closed) throw new Error('Wallet is locked.');
      const nonce = bytes(12);
      const state = gcm(key, nonce, aad).encrypt(data);
      store.write(encoder.encode(JSON.stringify({ ...header, nonce: encode(nonce), state: encode(state) })));
      value?.fill(0);
      value = data.slice();
    },
    close() {
      if (closed) return;
      closed = true;
      key.fill(0);
      value?.fill(0);
      value = null;
      store.close();
    },
  };
  return vault;
}
