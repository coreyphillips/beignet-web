import { createRelaySocketFactory } from '@beignet/portable-engine';
import { openWebSocketSocket } from './ws-socket.mjs';
import { createEsploraChain } from './electrum-esplora.mjs';
// One socket factory for the engine. A relay carries both the Electrum and
// the Lightning bytes through its fixed routes. A direct connection routes the
// engine's Electrum address to the chosen chain source and every other
// address, which is the primary, to the node's WebSocket listener.
export function createTransport(config, { WebSocket: W = globalThis.WebSocket, fetch: fetcher = globalThis.fetch } = {}) {
  if (config.mode !== 'direct') {
    return { socketFactory: createRelaySocketFactory({ electrumUrl: config.electrumUrl, peerUrl: config.peerUrl, token: config.token, electrum: config.electrum, WebSocket: W }), close() {} };
  }
  const { direct, electrum } = config;
  const chain = direct.chain.kind === 'esplora' ? createEsploraChain({ url: direct.chain.url, ws: direct.chain.ws, WebSocket: W, fetch: fetcher }) : null;
  return {
    socketFactory: (target) => {
      if (target.host === electrum.host && target.port === electrum.port) {
        return chain ? chain.openSocket(target) : openWebSocketSocket(direct.chain.url, { WebSocket: W, text: true, tls: target.tls, label: 'Electrum server' });
      }
      return openWebSocketSocket(direct.peerUrl, { WebSocket: W, tls: target.tls, label: 'Primary node' });
    },
    close() { chain?.close(); },
  };
}
