'use client';
import { useEffect, useRef, useState } from 'react';
import { type WalletClientInterface, type WalletRecord } from '@beignet/wallet-core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { browserSession, type NetworkProfile, type NetworkSettings as Preferences } from '@/lib/local/client';
import { defaultProfiles, validateProfile } from '@/lib/local/network-profiles.mjs';
import { Spinner } from '@/components/ui/spinner';
import { SettingsFeedback } from './settings-feedback';
import type { ApplySettings, SettingsFeedback as Feedback } from '@/lib/settings-types';

type Network = NetworkProfile['network'];
const labels = { mainnet: 'Bitcoin mainnet', testnet: 'Bitcoin testnet', regtest: 'Local regtest' };
const errorText = (e: unknown) => e instanceof Error ? e.message : 'Unable to update network settings.';
const serverUrl = (profile: NetworkProfile) => `${profile.electrum.tls ? 'ssl' : 'tcp'}://${profile.electrum.host.includes(':') ? `[${profile.electrum.host}]` : profile.electrum.host}:${profile.electrum.port}`;
function parseServer(value: string) {
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Use a server address such as ssl://bitkit.to:9999.'); }
  if (!['ssl:', 'tls:', 'tcp:'].includes(url.protocol) || !url.hostname || !url.port || url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/'))
    throw new Error('Use ssl://host:port or tcp://host:port without a username or password.');
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port), tls: url.protocol !== 'tcp:' };
}
function hostPreferences(network: Network): Preferences {
  const profiles = defaultProfiles() as Preferences['profiles'];
  const raw = localStorage.getItem('beignet-network-profiles');
  if (raw) {
    const stored = JSON.parse(raw);
    for (const n of ['mainnet', 'testnet', 'regtest'] as Network[]) if (stored[n]) profiles[n] = validateProfile(stored[n]) as NetworkProfile;
  }
  return { activeNetwork: network, profiles };
}

export function NetworkSettings({ client, currentNetwork, currentWalletId, applySettings, feedback, revision, disabled }: {
  client: WalletClientInterface; currentNetwork: Network; currentWalletId: string;
  applySettings: ApplySettings; feedback: Feedback | null; revision: number; disabled: boolean;
}) {
  const session = browserSession(client);
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [network, setNetwork] = useState<Network>(currentNetwork);
  const [server, setServer] = useState('');
  const [primary, setPrimary] = useState('');
  const [wallets, setWallets] = useState<WalletRecord[]>([]);
  const [walletId, setWalletId] = useState(currentWalletId);
  const [action, setAction] = useState<'save' | 'connect' | null>(null);
  const busy = disabled || action !== null;
  const [error, setError] = useState('');
  const draft = useRef({ network: currentNetwork, server: '', primary: '' });
  const baseline = useRef<Preferences | null>(null);
  const identity = useRef(currentWalletId);
  useEffect(() => {
    let active = true;
    const load = async () => {
      const next = session ? await session.networkSettings() : hostPreferences(currentNetwork);
      if (!active) return;
      const changedWallet = identity.current !== currentWalletId;
      const selected = changedWallet ? currentNetwork : draft.current.network;
      const previous = baseline.current?.profiles[selected];
      // Refresh persisted fields after another settings card changes them, but
      // preserve any unsaved draft. Ordinary balance polling never resets forms.
      if (changedWallet || !previous || draft.current.server === serverUrl(previous)) {
        draft.current.server = serverUrl(next.profiles[selected]); setServer(draft.current.server);
      }
      if (changedWallet || !previous || draft.current.primary === previous.primaryUri) {
        draft.current.primary = next.profiles[selected].primaryUri; setPrimary(draft.current.primary);
      }
      draft.current.network = selected; setNetwork(selected);
      if (changedWallet) setWalletId(currentWalletId);
      identity.current = currentWalletId; baseline.current = next; setPreferences(next);
      if (!session) { const list = await client.listWallets(); if (active) setWallets(list.filter(w => w.lfbw?.enabled)); }
    };
    void load().catch(e => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [client, currentNetwork, currentWalletId, session, revision]);
  const choose = (next: Network) => {
    setNetwork(next); setServer(serverUrl(preferences!.profiles[next])); setPrimary(preferences!.profiles[next].primaryUri);
    draft.current = { network: next, server: serverUrl(preferences!.profiles[next]), primary: preferences!.profiles[next].primaryUri };
    const matching = wallets.filter(w => w.network === next);
    setWalletId(matching.length === 1 ? matching[0].id : ''); setError('');
  };
  const profile = () => validateProfile({ network, primaryUri: primary, electrum: parseServer(server) }) as NetworkProfile;
  async function save() {
    if (busy || !preferences) return;
    setAction('save'); setError('');
    try {
      const selected = profile();
      const next = { ...preferences, profiles: { ...preferences.profiles, [network]: selected } };
      await applySettings({ scope: 'network', pending: 'Saving your server settings…', refresh: false,
        success: `${labels[network]} default saved. ${session ? 'Reconnect or switch to apply it.' : 'New host wallets will use this server.'}`,
        change: async () => {
          if (session) await session.saveNetwork(selected);
          else localStorage.setItem('beignet-network-profiles', JSON.stringify(next.profiles));
        },
      });
    } catch (e) { setError(errorText(e)); }
    finally { setAction(null); }
  }
  async function change() {
    if (busy || !preferences) return;
    setAction('connect'); setError('');
    try {
      const selected = profile();
      if (session) validateProfile(selected, true);
      else if (!walletId && wallets.some(w => w.network === network)) throw new Error('Choose the wallet to open, or choose Create a wallet.');
      await applySettings({ scope: 'network', pending: network === currentNetwork ? 'Applying settings and reconnecting…' : `Opening ${labels[network]}…`,
        success: network === currentNetwork ? 'Network settings applied.' : `Switched to ${labels[network]}.`, change: async () => {
        if (session) return session.switchNetwork(selected);
        const next = { ...preferences.profiles, [network]: selected };
        localStorage.setItem('beignet-network-profiles', JSON.stringify(next));
        const existing = wallets.find(w => w.id === walletId && w.network === network);
        if (existing) {
          client.selectWallet(existing.id);
          await client.startWallet();
          return { wallet: existing };
        }
        validateProfile(selected, true);
        const created = await client.createWallet({ name: network === 'mainnet' ? 'Everyday wallet' : `${labels[network]} wallet`, network, primaryUri: selected.primaryUri, electrum: selected.electrum });
        client.selectWallet(created.id);
        return { wallet: created, mnemonic: created.mnemonic };
      } });
    } catch (e) { setError(errorText(e)); }
    finally { setAction(null); }
  }
  return <section className="surface flow-stack">
    <h2>Network &amp; servers</h2>
    <p className="muted">{session
      ? 'New networks use your original recovery phrase. Each network keeps its own balance, history, and channel state.'
      : 'Each host wallet keeps its own recovery phrase, balance, and history.'}</p>
    {!!preferences?.recovery?.separateNetworks.length && <p className="notice">
      Your existing {preferences.recovery.separateNetworks.map(n => labels[n]).join(' and ')} wallet{preferences.recovery.separateNetworks.length > 1 ? 's have' : ' has'} a separate recovery phrase from an earlier app version. Keep those backups. Existing wallets and funds stay in place.
    </p>}
    {error && <div className="notice error" role="alert">{error}</div>}
    <SettingsFeedback feedback={!error && feedback?.scope === 'network' ? feedback : null} />
    <fieldset className="settings-controls flow-stack" disabled={busy} aria-busy={action !== null}>
    <label className="field"><span>Network</span><select value={network} disabled={!preferences || busy} onChange={e => choose(e.target.value as Network)}>
      {(Object.keys(labels) as Network[]).map(n => <option key={n} value={n}>{labels[n]}</option>)}
    </select></label>
    <label className="field" htmlFor="network-electrum"><span>Default Electrum server</span><Input id="network-electrum" value={server} onChange={e => { draft.current.server = e.target.value; setServer(e.target.value); setError(''); }} disabled={!preferences || busy} placeholder="ssl://bitkit.to:9999" spellCheck={false} /></label>
    {network === 'regtest' && <p className="muted">Use an Electrum server following your primary’s regtest chain. For a node on another computer, enter its reachable server address.</p>}
    {!session && <label className="field"><span>Wallet to open</span><select value={walletId} onChange={e => setWalletId(e.target.value)} disabled={busy}>
      <option value="">Choose a wallet</option>
      {wallets.filter(w => w.network === network).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
      <option value="new">Create a wallet</option>
    </select></label>}
    <details open={network !== 'mainnet' && !primary}>
      <summary className="text-button">Primary node for this network</summary>
      <div className="spaced flow-stack"><p className="muted">Testnet and regtest need their own Lightning node. Your mainnet node cannot serve those networks.</p>
        <Textarea aria-label="Primary node for selected network" value={primary} onChange={e => { draft.current.primary = e.target.value; setPrimary(e.target.value); setError(''); }} disabled={busy} placeholder="pubkey@host:port" spellCheck={false} />
      </div>
    </details>
    <div className="flow-stack">
      <Button className="secondary" onClick={save} disabled={busy || !preferences}>{action === 'save' ? <><Spinner aria-hidden="true" />Saving…</> : 'Save default'}</Button>
      <Button className="primary" onClick={change} disabled={busy || !preferences}>{action === 'connect' ? <><Spinner aria-hidden="true" />Updating…</> : network === currentNetwork ? 'Reconnect wallet' : `Switch to ${labels[network]}`}</Button>
    </div>
    {!session && <p className="muted">Saved servers apply to new host wallets. Existing host wallets keep their own server settings.</p>}
    </fieldset>
  </section>;
}
