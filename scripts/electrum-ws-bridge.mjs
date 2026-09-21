// A loopback WebSocket door to a TCP Electrum server, for running the static
// app against a local regtest stack: the browser cannot open TCP sockets, and
// electrs speaks only TCP. One text frame carries one JSON-RPC message.
//
//   node scripts/electrum-ws-bridge.mjs [tcp-host:port] [listen-host:port]
//   defaults: 127.0.0.1:60001 -> ws://127.0.0.1:60004
import net from 'node:net';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
function server() {
  for (const name of ['ws', '../../beignet-relay/node_modules/ws']) { try { return require(name).WebSocketServer; } catch { /* try the next location */ } }
  throw new Error('Install the ws package (npm install --no-save ws) to run the bridge.');
}
const debug = process.env.BRIDGE_DEBUG === '1' ? (direction, line) => console.error(`bridge ${direction} ${line.length}b ${line.slice(0, 160)}`) : () => {};
const split = (value, fallback) => { const [host, port] = (value || fallback).split(':'); return { host, port: Number(port) }; };
export function startBridge({ target = '127.0.0.1:60001', listen = '127.0.0.1:60004' } = {}) {
  const upstream = split(target), bind = split(listen);
  const WebSocketServer = server();
  const web = http.createServer((_request, response) => response.writeHead(404).end());
  const sockets = new WebSocketServer({ server: web });
  sockets.on('connection', (ws) => {
    const tcp = net.connect(upstream.port, upstream.host);
    let inbound = '';
    tcp.setNoDelay(true);
    tcp.on('data', (chunk) => {
      inbound += chunk.toString('utf8');
      let index;
      while ((index = inbound.indexOf('\n')) >= 0) { const line = inbound.slice(0, index).trim(); inbound = inbound.slice(index + 1); if (line && ws.readyState === 1) { debug('<-', line); ws.send(line); } }
    });
    ws.on('message', (data) => { if (!tcp.destroyed) { debug('->', data.toString('utf8')); tcp.write(data.toString('utf8').trim() + '\n'); } });
    ws.on('close', () => tcp.destroy());
    ws.on('error', () => tcp.destroy());
    tcp.on('close', () => { if (ws.readyState === 1) ws.close(1000, 'upstream closed'); });
    tcp.on('error', () => { if (ws.readyState === 1) ws.close(1011, 'upstream failed'); });
  });
  return new Promise((resolve, reject) => {
    web.once('error', reject);
    web.listen(bind.port, bind.host, () => resolve({ port: web.address().port, url: `ws://${bind.host}:${web.address().port}`, close: () => new Promise((done) => { sockets.close(); web.close(done); }) }));
  });
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const bridge = await startBridge({ target: process.argv[2], listen: process.argv[3] });
  console.log(`Electrum WebSocket bridge: ${bridge.url} -> tcp ${process.argv[2] || '127.0.0.1:60001'}`);
}
