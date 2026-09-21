import { createSocketShell, bytesOf } from './socket-shell.mjs';
const FRAME = 16384;
// A byte stream over one WebSocket. Binary mode carries the Lightning peer
// connection: each write is one binary frame and frames are a byte stream,
// which is what the engine's own WebSocket transport and CLN's ws listener
// speak. Text mode carries Electrum JSON-RPC to a server that frames one
// message per text frame: outbound lines are sent without their newline,
// inbound messages are delivered with one.
export function openWebSocketSocket(url, { WebSocket: W = globalThis.WebSocket, text = false, tls = false, label = 'Network connection' } = {}) {
  const socket = createSocketShell();
  if (!W) { queueMicrotask(() => socket.destroy(new Error('WebSocket is required'))); return socket; }
  let ws;
  try { ws = new W(url); } catch (error) { queueMicrotask(() => socket.destroy(error)); return socket; }
  ws.binaryType = 'arraybuffer';
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  let outbound = '';
  const deliver = (bytes) => { if (!socket.destroyed) socket.emit('data', bytes); };
  ws.onopen = () => { socket.emit('connect'); if (tls) socket.emit('secureConnect'); };
  ws.onmessage = (event) => {
    const data = event.data;
    if (typeof data === 'string') {
      if (!text) { socket.destroy(new Error(`${label} sent unexpected text data.`)); return; }
      deliver(encoder.encode(data.endsWith('\n') ? data : data + '\n'));
    } else if (data instanceof ArrayBuffer) deliver(new Uint8Array(data));
    else if (ArrayBuffer.isView(data)) deliver(bytesOf(data));
    else if (data?.arrayBuffer) data.arrayBuffer().then((buffer) => deliver(new Uint8Array(buffer))).catch((error) => socket.destroy(error));
    else socket.destroy(new Error(`${label} sent data in an unknown format.`));
  };
  ws.onerror = () => socket.fail(new Error(`Unable to connect to the ${label.toLowerCase()}. Check the address and that it accepts WebSocket connections from this site.`));
  ws.onclose = (event) => {
    const local = socket.destroyed;
    socket.destroyed = true;
    if (!local && event?.code !== 1000 && event?.code !== 1001) socket.fail(new Error(`The ${label.toLowerCase()} closed the connection.`));
    socket.finish();
  };
  socket.write = (data, callback) => {
    if (socket.destroyed || ws.readyState !== 1) throw new Error(`${label} is not connected`);
    const bytes = bytesOf(data);
    // An empty write is a no-op on a TCP socket; never send it as an empty frame.
    if (!bytes.length) { callback?.(); return true; }
    // Frames are a byte stream to the far side, so a large message is sent as
    // several frames: CLN's WebSocket listener drops a connection on a frame
    // carrying a maximum-size Lightning message in one piece. Each slice is a
    // copy, because the engine may reuse its buffer after write returns.
    if (!text) for (let offset = 0; offset < bytes.length; offset += FRAME) ws.send(bytes.slice(offset, offset + FRAME));
    else {
      outbound += decoder.decode(bytes, { stream: true });
      let index;
      while ((index = outbound.indexOf('\n')) >= 0) {
        const line = outbound.slice(0, index).trim();
        outbound = outbound.slice(index + 1);
        if (line) ws.send(line);
      }
    }
    callback?.();
    return true;
  };
  socket.end = () => { socket.destroyed = true; ws.close(); queueMicrotask(() => socket.finish()); };
  socket.destroy = (error) => { socket.destroyed = true; if (error) socket.fail(error); ws.close(); queueMicrotask(() => socket.finish()); };
  return socket;
}
