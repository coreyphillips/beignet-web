'use client';
import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent, type ComponentType } from 'react';
import { ArrowLeft, Wallet } from 'lucide-react';
import { type WalletClientInterface, type WalletRecord } from '@beignet/wallet-core';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { BrowserWalletSession, type NetworkProfile, type VaultStatus, type WalletDefaults } from '@/lib/local/client';
import { defaultProfiles, validateProfile } from '@/lib/local/network-profiles.mjs';
import { chainTarget, parseElectrumServer } from '@/lib/local/connection.mjs';
import { ConnectionFields, MANUAL_TRANSPORT, connectionOf, emptyDraft, type ConnectionDraft } from './connection-fields';

type Network = NetworkProfile['network'];
const networkLabels: Record<Network, string> = { mainnet: 'Bitcoin mainnet', testnet: 'Bitcoin testnet', regtest: 'Local regtest' };
const serverUrl = (profile: NetworkProfile) => `${profile.electrum.tls ? 'ssl' : 'tcp'}://${profile.electrum.host}:${profile.electrum.port}`;

const message = (error: unknown) => error instanceof Error ? error.message : 'Unable to open your wallet. Please try again.';
const Field = ({ label, children }: { label: string; children: ReactNode }) => <label className="field"><span>{label}</span>{children}</label>;

export function LocalConnection({ onConnect, back, BackupView }: {
  onConnect: (client: WalletClientInterface) => void;
  back: () => void;
  BackupView: ComponentType<{ phrase: string; onDone: () => void; initial?: boolean }>;
}) {
  const session = useRef<BrowserWalletSession | null>(null);
  const handedOff = useRef(false);
  const pending = useRef(false);
  const [opened, setOpened] = useState(false);
  const defaults = useRef<WalletDefaults | null>(null);
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [addPassword, setAddPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [wallets, setWallets] = useState<WalletRecord[]>([]);
  const [phrase, setPhrase] = useState('');
  const [persisted, setPersisted] = useState<boolean | null>(null);
  // Static deployments: the first run names the network and how to reach it.
  const [network, setNetwork] = useState<Network>('mainnet');
  const [primary, setPrimary] = useState(() => defaultProfiles().mainnet.primaryUri);
  const [server, setServer] = useState(() => serverUrl(defaultProfiles().mainnet as NetworkProfile));
  const [connection, setConnection] = useState<ConnectionDraft>(() => emptyDraft('mainnet'));
  const chooseNetwork = (next: Network) => {
    const profile = defaultProfiles()[next] as NetworkProfile;
    setNetwork(next); setPrimary(profile.primaryUri); setServer(serverUrl(profile)); setConnection(emptyDraft(next)); setError('');
  };
  const manualProfile = (): NetworkProfile | undefined => {
    if (!MANUAL_TRANSPORT || status?.exists) return undefined;
    const chosen = connectionOf(connection);
    return validateProfile({ network, primaryUri: primary, electrum: chosen.mode === 'relay' ? parseElectrumServer(server) : chainTarget(chosen), connection: chosen }, true) as NetworkProfile;
  };
  useEffect(() => {
    const next = new BrowserWalletSession();
    session.current = next;
    let active = true;
    void next.inspect().then((found) => { if (active) setStatus(found); }).catch((e) => { if (active) setError(message(e)); });
    return () => { active = false; if (!handedOff.current) next.destroy(); };
  }, []);
  const enter = () => {
    handedOff.current = true;
    setPhrase('');
    onConnect(session.current!.client);
  };
  const begin = () => {
    if (pending.current) return false;
    pending.current = true; setBusy(true); setError('');
    return true;
  };
  const finish = () => { pending.current = false; setBusy(false); };
  async function openWallet(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!status || !session.current || pending.current) return;
    if (!status.exists && addPassword && password !== confirmation) { setError('The passwords do not match.'); return; }
    if (!begin()) return;
    try {
      if (!opened) {
        setPersisted(await navigator.storage.persist().catch(() => false));
        const result = await session.current.open(status.passwordRequired || addPassword ? password : '', manualProfile());
        defaults.current = result.defaults;
        setOpened(true);
      }
      const list = await session.current.client.listWallets();
      setWallets(list);
      if (!list.length) {
        const settings = defaults.current;
        if (!settings?.network || !settings.primaryUri) throw new Error('The app could not finish automatic setup. Please reopen it and try again.');
        const wallet = await session.current.client.createWallet({ name: 'Everyday wallet', network: settings.network, primaryUri: settings.primaryUri });
        session.current.client.selectWallet(wallet.id);
        setWallets([wallet]);
        if (wallet.mnemonic) setPhrase(wallet.mnemonic); else enter();
      } else if (list.length === 1) {
        session.current.client.selectWallet(list[0].id);
        await session.current.client.startWallet();
        enter();
      }
    } catch (e) { setError(message(e)); }
    finally { setPassword(''); setConfirmation(''); finish(); }
  }
  if (phrase) return <BackupView phrase={phrase} onDone={enter} initial />;
  const needsPassword = status?.passwordRequired || (!status?.exists && addPassword);
  return <section className="surface connection-card flow-stack">
    <div className="connection-header">
      <span className="mini-icon"><Wallet size={22} /></span>
      <h2>{status ? status.exists ? 'Welcome back.' : 'Create your wallet.' : error ? 'Could not open wallet.' : 'Checking this browser…'}</h2>
      <p className="muted spaced">Your wallet and keys stay in this browser.</p>
    </div>
    {error && <div className="notice error" role="alert">{error}</div>}
    {error && !status && <button className="text-button" disabled={busy} onClick={async () => {
      if (!session.current || !begin()) return;
      try { setStatus(await session.current.inspect()); }
      catch (e) { setError(message(e)); }
      finally { finish(); }
    }}>Try again</button>}
    {persisted === false && <div className="notice warning">This browser may clear wallet data when storage runs low. Keep your recovery information safe.</div>}
    {wallets.length ? <div className="flow-stack">
      {wallets.map((wallet) => <Button className="primary" key={wallet.id} disabled={busy} onClick={async () => {
        if (!begin()) return;
        try { session.current!.client.selectWallet(wallet.id); await session.current!.client.startWallet(); enter(); }
        catch (e) { setError(message(e)); }
        finally { finish(); }
      }}>{busy ? 'Opening wallet…' : wallets.length === 1 ? 'Open wallet' : wallet.name}</Button>)}
    </div> : status ? <form className="flow-stack" onSubmit={openWallet}>
      {MANUAL_TRANSPORT && !status.exists && !opened && <>
        <label className="field"><span>Network</span><select value={network} disabled={busy} onChange={e => chooseNetwork(e.target.value as Network)}>
          {(Object.keys(networkLabels) as Network[]).map(n => <option key={n} value={n}>{networkLabels[n]}</option>)}
        </select></label>
        <label className="field" htmlFor="setup-primary"><span>Primary node</span><Textarea id="setup-primary" value={primary} onChange={e => { setPrimary(e.target.value); setError(''); }} disabled={busy} placeholder="pubkey@host:port" spellCheck={false} /></label>
        <ConnectionFields value={connection} disabled={busy} onChange={next => { setConnection(next); setError(''); }} />
        {connection.mode === 'relay' && <label className="field" htmlFor="setup-electrum"><span>Electrum server</span><Input id="setup-electrum" value={server} onChange={e => { setServer(e.target.value); setError(''); }} disabled={busy} placeholder="ssl://bitkit.to:9999" spellCheck={false} /></label>}
      </>}
      {status && !status.exists && <label className="check-label">
        <input type="checkbox" checked={addPassword} disabled={busy || opened} onChange={(e) => { setAddPassword(e.target.checked); setPassword(''); setConfirmation(''); }} />
        Add a password <span className="muted">(optional)</span>
      </label>}
      {needsPassword && !opened ? <>
        <Field label="Password"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required disabled={busy} autoComplete={status?.exists ? 'current-password' : 'new-password'} /></Field>
        {!status?.exists && <Field label="Repeat password"><Input type="password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} required disabled={busy} autoComplete="new-password" /></Field>}
      </> : status && !opened && <p className="muted">No password. Anyone using this browser can open your wallet.</p>}
      <Button className="primary" type="submit" disabled={busy || !status}>{busy ? status?.exists ? 'Opening wallet…' : 'Creating your wallet…' : status?.exists ? status.passwordRequired ? 'Unlock wallet' : 'Open wallet' : 'Continue'}</Button>
      {!status?.exists && <p className="muted">Next, save your recovery phrase.{MANUAL_TRANSPORT ? ' You can change the connection later in Settings.' : ' Connections are configured automatically.'}</p>}
    </form> : error ? <p className="muted">We couldn’t check the saved wallet. Try again to reopen it.</p> : <output className="inline-flex items-center gap-2 muted"><Spinner aria-hidden="true" />Checking for a saved wallet…</output>}
    <button className="text-button" onClick={() => { if (!pending.current) back(); }} disabled={busy}><ArrowLeft size={16} /> Back</button>
  </section>;
}
