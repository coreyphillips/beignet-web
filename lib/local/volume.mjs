const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const encode = (data) => {
  let text = '';
  for (let i = 0; i < data.length; i += 8192) text += String.fromCharCode(...data.subarray(i, i + 8192));
  return btoa(text);
};
const decode = (data) => Uint8Array.from(atob(data), (c) => c.charCodeAt(0));

/** A synchronous volume transaction writes one complete encrypted snapshot.
 * Persistent state never escapes the encrypted vault, including engine JSON. */
export function createVolume(vault) {
  const raw = vault.read();
  const files = raw ? JSON.parse(decoder.decode(raw)) : Object.create(null);
  if (!files || typeof files !== 'object' || Array.isArray(files) || Object.values(files).some((v) => typeof v !== 'string'))
    throw new Error('Wallet volume is damaged.');
  let poisoned = false;
  const check = () => { if (poisoned) throw new Error('Wallet storage failed. Lock and reopen before continuing.'); };
  const save = () => {
    try { vault.write(encoder.encode(JSON.stringify(files))); }
    catch (error) { poisoned = true; throw error; }
  };
  const validate = (path) => {
    if (typeof path !== 'string' || !path || path.includes('\0') || path === '__proto__' || path === 'constructor') throw new Error('Invalid wallet file path.');
  };
  return {
    read(path) { check(); validate(path); return Object.hasOwn(files, path) ? decode(files[path]) : null; },
    write(path, data) { check(); validate(path); files[path] = encode(data); save(); },
    remove(path) { check(); validate(path); delete files[path]; save(); },
    rename(from, to) {
      check(); validate(from); validate(to);
      if (!Object.hasOwn(files, from)) throw new Error('Wallet source file does not exist.');
      if (from === to) return;
      files[to] = files[from]; delete files[from]; save();
    },
    list(prefix = '') { check(); return Object.keys(files).filter((path) => path.startsWith(prefix)); },
    clearMemory() { for (const path of Object.keys(files)) delete files[path]; poisoned = true; },
  };
}
