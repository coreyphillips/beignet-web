import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransport } from '../lib/local/transport.mjs';

// A WebSocket double: records what was dialed and sent, and lets a test act as the far side.
class FakeWebSocket {
  static opened = [];
  constructor(url, protocols) { this.url = url; this.protocols = protocols; this.sent = []; this.readyState = 0; this.closed = false; FakeWebSocket.opened.push(this); }
  send(data) { this.sent.push(data); }
  close() { this.closed = true; this.readyState = 3; queueMicrotask(() => this.onclose?.({ code: 1000 })); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(data) { this.onmessage?.({ data }); }
  drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const direct = { mode: 'direct', network: 'regtest', primaryUri: 'pk@127.0.0.1:19846', electrum: { host: '127.0.0.1', port: 60004, tls: false },
  direct: { peerUrl: 'ws://127.0.0.1:19847/', chain: { kind: 'electrum-ws', url: 'ws://127.0.0.1:60004/' } } };
const events = (socket) => { const seen = []; for (const name of ['connect', 'secureConnect', 'data', 'error', 'close']) socket.on(name, (value) => seen.push([name, value])); return seen; };

test('the Electrum address is routed to the chain source as text frames and every other address to the primary as binary frames', async () => {
  FakeWebSocket.opened = [];
  const { socketFactory } = createTransport(direct, { WebSocket: FakeWebSocket });
  const chain = socketFactory({ host: '127.0.0.1', port: 60004, tls: false });
  const peer = socketFactory({ host: '127.0.0.1', port: 19846, tls: false });
  assert.equal(FakeWebSocket.opened[0].url, 'ws://127.0.0.1:60004/');
  assert.equal(FakeWebSocket.opened[1].url, 'ws://127.0.0.1:19847/');
  assert.equal(FakeWebSocket.opened[0].protocols, undefined, 'No relay subprotocols are offered to a plain server');
  const chainSeen = events(chain), peerSeen = events(peer);
  FakeWebSocket.opened[0].open(); FakeWebSocket.opened[1].open();
  assert.deepEqual(chainSeen, [['connect', undefined]]);
  chain.write(new TextEncoder().encode('{"id":1,"method":"server.ping","params":[]}\n{"id":2,'));
  chain.write('"method":"server.version","params":[]}\n');
  assert.deepEqual(FakeWebSocket.opened[0].sent, ['{"id":1,"method":"server.ping","params":[]}', '{"id":2,"method":"server.version","params":[]}']);
  FakeWebSocket.opened[0].receive('{"id":1,"result":null}');
  assert.equal(new TextDecoder().decode(chainSeen.at(-1)[1]), '{"id":1,"result":null}\n');
  peer.write(new Uint8Array([1, 2, 3]));
  assert.deepEqual([...FakeWebSocket.opened[1].sent[0]], [1, 2, 3]);
  peer.write(new Uint8Array(0));
  assert.equal(FakeWebSocket.opened[1].sent.length, 1, 'An empty write sends no frame');
  const large = new Uint8Array(65569).map((_, i) => i & 255);
  peer.write(large);
  const frames = FakeWebSocket.opened[1].sent.slice(1);
  assert.deepEqual(frames.map((frame) => frame.byteLength), [16384, 16384, 16384, 16384, 33], 'A maximum-size Lightning message goes out in several frames');
  assert.deepEqual(Buffer.concat(frames.map((frame) => Buffer.from(frame))), Buffer.from(large));
  large.fill(0);
  assert.equal(frames[0][1], 1, 'Frames are copies, not views of the engine buffer');
  FakeWebSocket.opened[1].receive(new Uint8Array([9, 8]).buffer);
  assert.deepEqual([...peerSeen.at(-1)[1]], [9, 8]);
  FakeWebSocket.opened[1].receive('text is a protocol violation');
  await tick();
  assert.match(peerSeen.find(([name]) => name === 'error')[1].message, /unexpected text/);
  assert.equal(peerSeen.at(-1)[0], 'close');
});
test('a far side that drops the socket reports an error then close, and a local destroy reports only close', async () => {
  FakeWebSocket.opened = [];
  const { socketFactory } = createTransport(direct, { WebSocket: FakeWebSocket });
  const dropped = socketFactory({ host: '127.0.0.1', port: 19846, tls: false });
  const seen = events(dropped);
  FakeWebSocket.opened[0].open(); FakeWebSocket.opened[0].drop();
  assert.deepEqual(seen.map(([name]) => name), ['connect', 'error', 'close']);
  const local = socketFactory({ host: '127.0.0.1', port: 19846, tls: false });
  const localSeen = events(local);
  FakeWebSocket.opened[1].open(); local.destroy();
  await tick();
  assert.deepEqual(localSeen.map(([name]) => name), ['connect', 'close']);
  assert.ok(FakeWebSocket.opened[1].closed);
  assert.throws(() => local.write('x'), /not connected/);
});
test('a relay connection keeps the authenticated byte relay protocol', () => {
  FakeWebSocket.opened = [];
  const token = 'c'.repeat(43);
  const { socketFactory } = createTransport({ mode: 'relay', electrum: { host: 'bitkit.to', port: 9999, tls: true }, electrumUrl: 'wss://relay.example/electrum', peerUrl: 'wss://relay.example/peer', token }, { WebSocket: FakeWebSocket });
  socketFactory({ host: 'bitkit.to', port: 9999, tls: true });
  socketFactory({ host: 'node.example', port: 9735, tls: false });
  assert.deepEqual(FakeWebSocket.opened.map((ws) => ws.url), ['wss://relay.example/electrum', 'wss://relay.example/peer']);
  assert.deepEqual(FakeWebSocket.opened[0].protocols, ['beignet.v1', `auth.${token}`]);
});
