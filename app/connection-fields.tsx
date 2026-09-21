'use client';
import { Input } from '@/components/ui/input';
import type { Connection, NetworkProfile } from '@/lib/local/client';

// Set at build time for deployments without a companion service on the app's
// origin, such as static hosting. The user then names the network connection.
export const MANUAL_TRANSPORT = process.env.NEXT_PUBLIC_MANUAL_TRANSPORT === '1';
type Network = NetworkProfile['network'];
export type ConnectionDraft = { mode: 'relay' | 'direct'; relayUrl: string; token: string; peerUrl: string; chainKind: 'esplora' | 'electrum-ws'; chainUrl: string };
const explorers: Record<Network, string> = { mainnet: 'https://mempool.space/api', testnet: 'https://mempool.space/testnet/api', regtest: '' };
export const emptyDraft = (network: Network): ConnectionDraft =>
  ({ mode: 'direct', relayUrl: '', token: '', peerUrl: '', chainKind: network === 'regtest' ? 'electrum-ws' : 'esplora', chainUrl: explorers[network] });
export function draftOf(connection: Connection | undefined, network: Network): ConnectionDraft {
  const draft = emptyDraft(network);
  if (!connection) return draft;
  if (connection.mode === 'relay') return { ...draft, mode: 'relay', relayUrl: connection.url, token: connection.token };
  return { ...draft, mode: 'direct', peerUrl: connection.peerUrl, chainKind: connection.chain.kind, chainUrl: connection.chain.url };
}
export const connectionOf = (draft: ConnectionDraft): Connection => draft.mode === 'relay'
  ? { mode: 'relay', url: draft.relayUrl.trim(), token: draft.token.trim() }
  : { mode: 'direct', peerUrl: draft.peerUrl.trim(), chain: { kind: draft.chainKind, url: draft.chainUrl.trim() } };

export function ConnectionFields({ value, onChange, disabled }: { value: ConnectionDraft; onChange: (next: ConnectionDraft) => void; disabled?: boolean }) {
  const set = (patch: Partial<ConnectionDraft>) => onChange({ ...value, ...patch });
  return <>
    <label className="field"><span>Connection</span><select value={value.mode} disabled={disabled} onChange={e => set({ mode: e.target.value as ConnectionDraft['mode'] })}>
      <option value="direct">Direct to your node</option>
      <option value="relay">Through a relay</option>
    </select></label>
    {value.mode === 'relay' ? <>
      <label className="field" htmlFor="connection-relay-url"><span>Relay URL</span><Input id="connection-relay-url" value={value.relayUrl} onChange={e => set({ relayUrl: e.target.value })} disabled={disabled} placeholder="wss://relay.example:8790" spellCheck={false} /></label>
      <label className="field" htmlFor="connection-relay-token"><span>Relay token</span><Input id="connection-relay-token" type="password" value={value.token} onChange={e => set({ token: e.target.value })} disabled={disabled} autoComplete="off" /></label>
      <p className="muted">The relay forwards bytes to its configured Electrum server and primary node. Enter that server below.</p>
    </> : <>
      <label className="field" htmlFor="connection-peer-url"><span>Primary node WebSocket</span><Input id="connection-peer-url" value={value.peerUrl} onChange={e => set({ peerUrl: e.target.value })} disabled={disabled} placeholder="wss://node.example:9736" spellCheck={false} /></label>
      <label className="field"><span>Chain source</span><select value={value.chainKind} disabled={disabled} onChange={e => set({ chainKind: e.target.value as ConnectionDraft['chainKind'] })}>
        <option value="esplora">Block explorer API</option>
        <option value="electrum-ws">Electrum server over WebSocket</option>
      </select></label>
      <label className="field" htmlFor="connection-chain-url"><span>{value.chainKind === 'esplora' ? 'API URL' : 'Electrum WebSocket URL'}</span><Input id="connection-chain-url" value={value.chainUrl} onChange={e => set({ chainUrl: e.target.value })} disabled={disabled} placeholder={value.chainKind === 'esplora' ? 'https://mempool.space/api' : 'wss://electrum.example:50004'} spellCheck={false} /></label>
      <p className="muted">A browser cannot open TCP or Tor connections. Your primary node must accept WebSocket peers over WSS, or over ws:// when it runs on this computer. For an address on this computer or your local network, allow the browser’s local network access prompt when it appears.</p>
    </>}
  </>;
}
