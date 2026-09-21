// The Node-socket-shaped object the engine's injected transport must return:
// connect, data, error and close events, write, end and destroy, and the
// tuning calls a TCP socket has. Close is reported as soon as the socket is
// destroyed locally, never waiting on a far side that may not answer.
const encoder = new TextEncoder();
export const bytesOf = (data) => typeof data === 'string' ? encoder.encode(data)
  : data instanceof Uint8Array ? data : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
export function createSocketShell() {
  const listeners = new Map();
  let errorEmitted = false, closeEmitted = false;
  const shell = {
    destroyed: false,
    on(event, fn) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); return shell; },
    once(event, fn) { const wrap = (...args) => { shell.off(event, wrap); fn(...args); }; return shell.on(event, wrap); },
    off(event, fn) { const list = listeners.get(event); if (list) listeners.set(event, list.filter((f) => f !== fn)); return shell; },
    emit(event, ...args) { for (const fn of Array.from(listeners.get(event) ?? [])) fn(...args); return shell; },
    // An error with nobody listening must not unwind into the WebSocket
    // callback that reported it and take the whole worker down.
    fail(error) { if (errorEmitted) return; errorEmitted = true; try { shell.emit('error', error); } catch (thrown) { console.error('Unhandled transport error', thrown); } },
    finish() { if (closeEmitted) return; closeEmitted = true; shell.destroyed = true; shell.emit('close'); },
    write() { throw new Error('Socket is not connected'); },
    end() { shell.destroyed = true; queueMicrotask(() => shell.finish()); },
    destroy(error) { shell.destroyed = true; if (error) shell.fail(error); queueMicrotask(() => shell.finish()); },
  };
  shell.addListener = (event, fn) => shell.on(event, fn);
  shell.removeListener = (event, fn) => shell.off(event, fn);
  for (const method of ['setTimeout', 'setEncoding', 'setKeepAlive', 'setNoDelay', 'pause', 'resume', 'ref', 'unref']) shell[method] = () => shell;
  return shell;
}
