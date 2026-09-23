'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  ArrowRight,
  ArrowLeft,
  Wallet,
  Clock3,
  Settings2,
  Zap,
  Eye,
  EyeOff,
  ShieldCheck,
  RefreshCw,
  Copy,
  Share2,
  Check,
  LockKeyhole,
  Link2,
  Plus,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import {
  WalletClient,
  DemoWalletClient,
  EmbeddedWalletClient,
  type WalletClientInterface,
  DEFAULT_HOST_URL,
  DEFAULT_PRIMARY_URI,
  parseSats,
  formatSats,
  type WalletSnapshot,
  type WalletRecord,
  type CreatedWallet,
  type HostConfig,
  type Activity,
  type SendReview,
  type SendResult,
  type ReceiveQuote,
  type ReceiveRequest,
} from '@beignet/wallet-core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { LocalConnection } from './local-connection';
import { NetworkSettings } from './network-settings';
import { browserSession } from '@/lib/local/client';
import { Spinner } from '@/components/ui/spinner';
import { SettingsFeedback } from './settings-feedback';
import { ReceiveReceipt } from './receive-receipt';
import { useReceiveStatus } from '@/lib/use-receive-status';
import { createSettingsUpdater } from '@/lib/settings-update.mjs';
import type { ApplySettings, SettingsFeedback as SettingsFeedbackState, SettingsOutcome } from '@/lib/settings-types';
// Set at build time when the app is hosted under a path prefix.
const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');

type Client = WalletClientInterface;
type Screen =
  | 'wallet'
  | 'send'
  | 'receive'
  | 'activity'
  | 'detail'
  | 'settings';
const money = (n: number) => formatSats(n);
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'Something went wrong. Please try again.';
const when = (time: number) =>
  time > 0
    ? new Date(time).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : 'Awaiting update';
const titles: Record<Screen, string> = {
  wallet: 'Wallet',
  send: 'Send',
  receive: 'Receive',
  activity: 'Activity',
  detail: 'Payment details',
  settings: 'Settings',
};
function Action({
  children,
  secondary = false,
  ...props
}: Omit<React.ComponentProps<typeof Button>, 'className'> & {
  secondary?: boolean;
  className?: string;
}) {
  return (
    <Button
      {...props}
      className={`${secondary ? 'secondary' : 'primary'} ${props.className || ''}`}
    >
      {children}
    </Button>
  );
}
function Notice({
  children,
  error = false,
  warning = false,
}: {
  children: ReactNode;
  error?: boolean;
  warning?: boolean;
}) {
  return (
    <div
      className={`notice ${error ? 'error' : warning ? 'warning' : ''}`}
      role={error ? 'alert' : 'status'}
    >
      {children}
    </div>
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Details({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl>
      {rows.map(([label, value]) => (
        <div className="detail-row" key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
function Amount({
  amount,
  setAmount,
  optional = false,
  disabled = false,
  required = false,
}: {
  amount: string;
  setAmount: (v: string) => void;
  optional?: boolean;
  disabled?: boolean;
  required?: boolean;
}) {
  return (
    <Field label={`Amount in sats${optional ? ' · optional' : required ? ' · required' : ''}`}>
      <Input
        className="amount-input"
        inputMode="numeric"
        autoComplete="off"
        value={amount}
        disabled={disabled}
        required={required}
        placeholder={optional ? 'Any amount' : required ? 'Enter amount' : '0'}
        onChange={(e) => setAmount(e.target.value)}
      />
    </Field>
  );
}
function Busy({ text = 'Working…' }: { text?: string }) {
  return <output className="inline-flex items-center gap-2"><Spinner aria-hidden="true" />{text}</output>;
}

export default function Home() {
  const [client, setClient] = useState<Client | null>(null);
  const [snapshot, setSnapshot] = useState<WalletSnapshot | null>(null);
  const [savedWallet, setSavedWallet] = useState<WalletRecord | null>(null);
  const [screen, setScreen] = useState<Screen>('wallet');
  const [detail, setDetail] = useState<Activity | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [locking, setLocking] = useState(false);
  const [settingsFeedback, setSettingsFeedback] = useState<SettingsFeedbackState | null>(null);
  const [settingsRevision, setSettingsRevision] = useState(0);
  const settingsUpdater = useRef(createSettingsUpdater());
  const switching = settingsFeedback?.phase === 'pending';
  const [networkBackup, setNetworkBackup] = useState('');
  const [hidden, setHidden] = useState(false);
  const [tick, setTick] = useState(0);
  const [now, setNow] = useState(Date.now);
  const epoch = useRef(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const open = (next: Screen) => {
    if (settingsUpdater.current.pending) return;
    setScreen(next);
    history.pushState({ beignetView: next }, '', `#${next}`);
    window.scrollTo({ top: 0 });
  };
  useEffect(() => {
    const navigate = () => {
      if (settingsUpdater.current.pending) return;
      const view = location.hash.slice(1) as Screen;
      setScreen(
        ['wallet', 'send', 'receive', 'activity', 'settings'].includes(view)
          ? view
          : 'activity',
      );
    };
    window.addEventListener('popstate', navigate);
    return () => window.removeEventListener('popstate', navigate);
  }, []);
  async function reconnect() {
    if (!client) return;
    setLoading(true);
    try { await client.startWallet(); refresh(); }
    catch (e) { setError(errorText(e)); }
    finally { setLoading(false); }
  }
  async function resync() {
    if (!client) return;
    setLoading(true);
    try {
      await client.refreshWallet();
      refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) void navigator.serviceWorker.register(`${BASE_PATH}/sw.js`).catch(() => {});
  }, []);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('demo') === '1')
      // oxlint-disable-next-line react/react-compiler -- Read browser-only query state after static hydration.
      setClient(new DemoWalletClient());
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!client) return;
    const version = ++epoch.current;
    let stopped = false;
    let inFlight = false;
    const run = async () => {
      if (inFlight || document.hidden || settingsUpdater.current.pending || version !== epoch.current) return;
      inFlight = true;
      setLoading(true);
      try {
        const next = await client.snapshot();
        if (!stopped && version === epoch.current) {
          setSnapshot(next);
          setSavedWallet(next.wallet);
          setError('');
        }
      } catch (e) {
        if (!stopped && version === epoch.current) setError(errorText(e));
        // Identity and connection settings remain available even when a wrong
        // server or unavailable peer prevents the engine returning balances.
        try {
          const records = await client.listWallets();
          const wallet = records.find(w => w.id === client.connection.walletId);
          if (!stopped && version === epoch.current && wallet) setSavedWallet(wallet);
        } catch { /* Preserve the original connection error. */ }
      } finally {
        inFlight = false;
        if (!stopped && version === epoch.current) setLoading(false);
      }
    };
    void run();
    const timer = setInterval(run, 10000);
    document.addEventListener('visibilitychange', run);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', run);
    };
  }, [client, tick]);
  const connect = (next: Client) => {
    epoch.current++;
    setSnapshot(null);
    setSavedWallet(null);
    setError('');
    setClient(next);
    setScreen('wallet');
    setDetail(null);
    setSettingsFeedback(null);
    refresh();
  };
  const applySettings: ApplySettings = async ({ scope, pending, success, change, refresh: updateWallet = true }) => {
    if (!client || settingsUpdater.current.pending) throw new Error('Wait for the current settings update to finish.');
    const previousWallet = savedWallet || snapshot?.wallet;
    const previousId = client.connection.walletId;
    const version = ++epoch.current;
    setSettingsFeedback({ scope, phase: 'pending', message: pending });
    setError('');
    try {
      const result = await settingsUpdater.current.run({ client, change, previousWallet, refresh: updateWallet }) as SettingsOutcome;
      if (version !== epoch.current) return result;
      if (updateWallet) {
        setSavedWallet(result.wallet || (previousWallet?.id === client.connection.walletId ? previousWallet : null) || null);
        setSnapshot(result.snapshot || null);
        if (result.wallet?.id !== previousId) setDetail(null);
        setNetworkBackup(result.mnemonic || '');
      }
      setSettingsRevision(value => value + 1);
      setSettingsFeedback({ scope, phase: result.phase, message: `${success}${result.detail ? ` ${result.detail}` : ''}` });
      return result;
    } catch (e) {
      if (version === epoch.current) {
        if (previousId && client.connection.walletId !== previousId) client.selectWallet(previousId);
        setSettingsFeedback({ scope, phase: 'error', message: `The update could not finish. ${errorText(e)}` });
      }
      throw e;
    } finally {
      if (version === epoch.current) { setLoading(false); refresh(); }
    }
  };
  const lock = async () => {
    if (settingsUpdater.current.pending) return;
    const local = client instanceof EmbeddedWalletClient ? client : null;
    setLocking(!!local);
    epoch.current++;
    setClient(null);
    setSnapshot(null);
    setError('');
    setScreen('wallet');
    setDetail(null);
    setNetworkBackup('');
    setSavedWallet(null);
    setSettingsFeedback(null);
    history.replaceState(null, '', location.pathname);
    // Hide secrets immediately, but release the old worker's exclusive storage
    // handles before offering another local wallet session.
    if (local) {
      try { await local.close(); }
      catch { /* close also terminates the worker after a shutdown failure */ }
      finally { setLocking(false); }
    }
  };
  // Feature detection keeps ordinary browsers independent of the optional WebMCP API.
  useEffect(() => {
    const context = (
      document as Document & {
        modelContext?: {
          registerTool: (
            tool: unknown,
            options: { signal: AbortSignal },
          ) => unknown;
        };
      }
    ).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    Promise.resolve(
      context.registerTool(
        {
          name: 'open_wallet_view',
          title: 'Open wallet view',
          description:
            'Navigate to Wallet, Send, Receive, Activity, or Settings. Does not create requests or send money.',
          inputSchema: {
            type: 'object',
            properties: {
              view: {
                type: 'string',
                enum: ['wallet', 'send', 'receive', 'activity', 'settings'],
              },
            },
            required: ['view'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false },
          execute: (input: unknown) => {
            const view = (input as { view?: Screen })?.view;
            if (
              !view ||
              !['wallet', 'send', 'receive', 'activity', 'settings'].includes(
                view,
              )
            )
              throw new Error('Choose a supported view');
            if (!client && view !== 'settings')
              throw new Error('Connect a wallet first');
            setScreen(view);
            return { view };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => {});
    return () => lifecycle.abort();
  }, [client]);
  const openActivity = (activity: Activity) => {
    setDetail(activity);
    open('detail');
  };
  const demo = snapshot?.demo || client instanceof DemoWalletClient;
  const unusable =
    switching || !!error || !snapshot || now - (snapshot?.updatedAt || 0) > 45000;
  return (
    <div className="wallet-app">
      <aside className="sidebar">
        <a
          className="brand"
          href="#wallet"
          onClick={(e) => {
            e.preventDefault();
            open('wallet');
          }}
          aria-label="Beignet home"
        >
          <span className="brand-icon">
            <Zap size={22} fill="currentColor" />
          </span>
          beignet<span className="brand-dot">.</span>
        </a>
        <nav aria-label="Main navigation">
          {(
            [
              { id: 'wallet', label: 'Wallet', icon: Wallet },
              { id: 'activity', label: 'Activity', icon: Clock3 },
              { id: 'settings', label: 'Settings', icon: Settings2 },
            ] as const
          ).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${screen === id || (id === 'wallet' && ['send', 'receive'].includes(screen)) || (id === 'activity' && screen === 'detail') ? 'selected' : ''}`}
              onClick={() => open(id)}
              disabled={switching}
              aria-current={screen === id ? 'page' : undefined}
            >
              <Icon size={20} />
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <ShieldCheck size={19} />
          <span>
            Your wallet.
            <br />
            <strong>{client instanceof EmbeddedWalletClient ? 'On this device.' : 'Your keys, your choice.'}</strong>
          </span>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div>
            <span className="eyebrow">
              {(savedWallet || snapshot?.wallet)?.name?.toUpperCase() || 'YOUR EVERYDAY WALLET'}
            </span>
            <h1>{titles[screen]}</h1>
          </div>
          <div className="toggle">
            {client && (
              <button
                className="icon-button"
                onClick={resync}
                disabled={loading || switching}
                aria-label="Refresh wallet"
              >
                <RefreshCw size={18} />
              </button>
            )}
            <span className="status-chip">
              {switching ? 'Updating settings…' : demo
                ? 'Preview · sample money'
                : snapshot
                  ? `${snapshot.wallet.network} · ${error ? 'offline' : 'connected'}`
                  : 'Not connected'}
            </span>
          </div>
        </header>
        {client && error && (
          <div className="spaced">
            <Notice error>
              {error}
              {snapshot
                ? ' Showing the last update. Payments are paused until the connection returns.'
                : ''}{' '}
              <button className="text-button" onClick={refresh}>
                Retry
              </button>
            </Notice>
          </div>
        )}
        {networkBackup ? (
          <BackupPhrase phrase={networkBackup} initial onDone={() => setNetworkBackup('')} />
        ) : locking ? (
          <section className="surface center"><Busy text="Locking your wallet…" /></section>
        ) : !client ? (
          <Connection onConnect={connect} />
        ) : screen === 'settings' && (savedWallet || snapshot?.wallet) ? (
          <Settings key={(savedWallet || snapshot!.wallet).id} client={client} wallet={(savedWallet || snapshot!.wallet)} snapshot={snapshot}
            lock={lock} applySettings={applySettings} feedback={settingsFeedback} revision={settingsRevision} busy={switching} />
        ) : !snapshot ? (
          <div className="narrow flow-stack">
          <section className="surface center">
            {savedWallet && <><h2>{savedWallet.name}</h2><p className="muted">{savedWallet.network} · Balance unavailable while reconnecting.</p></>}
            {savedWallet?.lfbw?.setup === 'failed' && savedWallet.lfbw.setupError && <Notice error>{savedWallet.lfbw.setupError}</Notice>}
            <Busy
              text={
                loading
                  ? 'Connecting to your wallet…'
                  : 'Your wallet is not available yet.'
              }
            />
            <div className="spaced">
              <div className="flow-stack">
                <Action secondary onClick={reconnect} disabled={loading}>
                  Try again
                </Action>
                <button
                  className="text-button"
                  disabled={loading}
                  onClick={async () => {
                    try {
                      await client.retrySetup();
                      refresh();
                    } catch (e) {
                      setError(errorText(e));
                    }
                  }}
                >
                  Retry wallet setup
                </button>
                <button className="text-button" onClick={lock}>
                  Back to connection
                </button>
              </div>
            </div>
          </section>
          {savedWallet && <NetworkSettings client={client} currentNetwork={savedWallet.network} currentWalletId={savedWallet.id}
            applySettings={applySettings} feedback={settingsFeedback} revision={settingsRevision} disabled={switching} />}
          </div>
        ) : (
          <div key={snapshot.wallet.id}>
            {screen === 'wallet' && (
              <>
                <section className="balance-card">
                  <div className="balance-top">
                    <span>Total balance</span>
                    <button
                      className="icon-button"
                      aria-label={hidden ? 'Show balance' : 'Hide balance'}
                      onClick={() => setHidden(!hidden)}
                    >
                      {hidden ? <EyeOff size={20} /> : <Eye size={20} />}
                    </button>
                  </div>
                  <div className="balance-value">
                    {hidden ? '••••••' : money(snapshot.balance.totalSats)}{' '}
                    <span>sats</span>
                  </div>
                  <div className="balance-sub">
                    {hidden ? '••••' : money(snapshot.balance.availableSats)}{' '}
                    available{' '}
                    {snapshot.balance.pendingSats > 0 && (
                      <>
                        <span>·</span>
                        {hidden
                          ? '••••'
                          : money(snapshot.balance.pendingSats)}{' '}
                        awaiting
                      </>
                    )}
                  </div>
                  <div className="wallet-actions">
                    <Action onClick={() => open('send')} disabled={unusable}>
                      <ArrowUpRight size={22} />
                      Send
                    </Action>
                    <Action
                      secondary
                      onClick={() => open('receive')}
                      disabled={unusable}
                    >
                      <ArrowDownLeft size={22} />
                      Receive
                    </Action>
                  </div>
                </section>
                {snapshot.notes.length > 0 && (
                  <div className="balance-note note-list">
                    {snapshot.notes.map((note, i) => (
                      <Notice warning key={i}>
                        {note}
                      </Notice>
                    ))}
                  </div>
                )}
                <div className="content-grid">
                  <section>
                    <div className="section-heading">
                      <h2>Recent activity</h2>
                      <button
                        className="text-button"
                        onClick={() => open('activity')}
                      >
                        View all <ArrowRight size={16} />
                      </button>
                    </div>
                    <ActivityList
                      items={snapshot.activity.slice(0, 5)}
                      onOpen={openActivity}
                      hidden={hidden}
                    />
                  </section>
                  <aside className="context-card">
                    <span className="mini-icon">
                      <Zap size={21} />
                    </span>
                    <h2>
                      One wallet.
                      <br />
                      Ready for either way.
                    </h2>
                    <p>
                      Paste a payment request to send. Share one code to
                      receive.
                    </p>
                    <div className="context-rule" />
                    <span className="eyebrow">
                      {demo ? 'PREVIEW MODE' : 'WALLET CONNECTION'}
                    </span>
                    <p>
                      {demo
                        ? 'Sample money. Explore freely, then connect your own Beignet host.'
                        : snapshot.primary.connected
                          ? 'Your primary is connected. Your wallet handles the payment details.'
                          : 'Your primary is reconnecting. Your balance stays visible here.'}
                    </p>
                    {demo && (
                      <button className="text-button" onClick={lock}>
                        Connect a wallet <ArrowRight size={15} />
                      </button>
                    )}
                  </aside>
                </div>
              </>
            )}
            {screen === 'send' && (
              <Send
                client={client}
                refresh={refresh}
                now={now}
                disabled={unusable}
                demo={!!demo}
                onActivity={() => open('activity')}
              />
            )}
            {screen === 'receive' && (
              <Receive
                client={client}
                now={now}
                disabled={unusable}
                allowAmountless={snapshot.balance.receivableSats > 0}
                offlineReceivableSats={snapshot.balance.offlineReceivableSats}
                refresh={refresh}
                onActivity={() => open('activity')}
              />
            )}
            {screen === 'activity' && (
              <ActivityScreen
                snapshot={snapshot}
                onOpen={openActivity}
                hidden={hidden}
              />
            )}
            {screen === 'detail' && detail && (
              <ActivityDetail
                item={
                  snapshot.activity.find((a) => a.id === detail.id) || detail
                }
                back={() => open('activity')}
                client={client}
                now={now}
                refresh={refresh}
              />
            )}
          </div>
        )}
        <footer className="workspace-footer">
          {demo
            ? 'Preview only. No real funds.'
            : 'Bitcoin, with less to think about.'}
          <span>BEIGNET / LFBW</span>
        </footer>
      </main>
    </div>
  );
}

function Connection({ onConnect }: { onConnect: (c: Client) => void }) {
  const [mode, setMode] = useState<'local' | 'host' | null>(null);
  const [url, setUrl] = useState(DEFAULT_HOST_URL);
  const [token, setToken] = useState('');
  const [wallets, setWallets] = useState<WalletRecord[] | null>(null);
  const [client, setClient] = useState<WalletClient | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState('Everyday wallet');
  const [network, setNetwork] = useState<'mainnet' | 'regtest' | 'testnet'>(
    'mainnet',
  );
  const [primary, setPrimary] = useState(DEFAULT_PRIMARY_URI);
  const [create, setCreate] = useState(false);
  const [config, setConfig] = useState<HostConfig | null>(null);
  const [electrumHost, setElectrumHost] = useState('');
  const [electrumPort, setElectrumPort] = useState('50002');
  const [electrumTls, setElectrumTls] = useState(true);
  const [created, setCreated] = useState<CreatedWallet | null>(null);
  const operation = useRef(0);
  const pending = useRef(false);
  useEffect(() => () => { operation.current++; }, []);
  const begin = () => {
    if (pending.current) return null;
    pending.current = true;
    setBusy(true);
    setError('');
    return ++operation.current;
  };
  const finish = (id: number) => {
    if (id !== operation.current) return;
    pending.current = false;
    setBusy(false);
  };
  const changeMode = (next: typeof mode) => {
    if (pending.current) return;
    operation.current++;
    setMode(next);
  };
  useEffect(() => {
    try {
      // oxlint-disable-next-line react/react-compiler -- The saved host exists only in browser storage, after static hydration.
      setUrl(
        localStorage.getItem('beignet-host-url') ||
          (process.env.NODE_ENV === 'development'
            ? DEFAULT_HOST_URL
            : location.origin),
      );
    } catch {}
  }, []);
  async function connect(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const id = begin();
    if (id === null) return;
    try {
      const next = new WalletClient({ url: url.trim(), token: token.trim() });
      const [list, hostConfig] = await Promise.all([
        next.listWallets(),
        next.getConfig(),
      ]);
      if (id !== operation.current) return;
      setConfig(hostConfig);
      setClient(next);
      setWallets(list.filter((w) => w.lfbw?.enabled));
      try {
        localStorage.setItem('beignet-host-url', url.trim());
      } catch {}
    } catch (e) {
      if (id === operation.current) setError(errorText(e));
    } finally {
      finish(id);
    }
  }
  async function createWallet(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!client) return;
    const id = begin();
    if (id === null) return;
    try {
      const wallet = await client.createWallet({
        name: name.trim(),
        network,
        primaryUri: primary.trim(),
        ...(electrumHost.trim()
          ? {
              electrum: {
                host: electrumHost.trim(),
                port: Number(electrumPort),
                tls: electrumTls,
              },
            }
          : {}),
      });
      if (id !== operation.current) return;
      client.selectWallet(wallet.id);
      if (wallet.mnemonic) setCreated(wallet);
      else onConnect(client);
    } catch (e) {
      if (id === operation.current) setError(errorText(e));
    } finally {
      finish(id);
    }
  }
  if (mode === 'local') return <LocalConnection onConnect={onConnect} back={() => changeMode(null)} BackupView={BackupPhrase} />;
  if (!mode) return <section className="surface connection-card flow-stack">
    <div className="connection-header"><span className="mini-icon"><Wallet size={22} /></span><h2>Make yourself at home.</h2><p className="muted spaced">Choose where your wallet lives.</p></div>
    <button className="mode-choice" onClick={() => changeMode('local')}><LockKeyhole size={24} /><span><strong>On this browser</strong><small>Keep the wallet engine and keys on this device.</small></span><ArrowRight size={20} /></button>
    <button className="mode-choice" onClick={() => changeMode('host')}><Link2 size={24} /><span><strong>Connect a host</strong><small>Control a wallet running on your Beignet host.</small></span><ArrowRight size={20} /></button>
    <button className="text-button" onClick={() => onConnect(new DemoWalletClient())}>Explore a sample wallet</button>
  </section>;
  if (created?.mnemonic)
    return (
      <BackupPhrase
        phrase={created.mnemonic}
        onDone={() => {
          const next = client!;
          setCreated(null);
          onConnect(next);
        }}
        initial
      />
    );
  return (
    <section className="surface connection-card">
      <div className="connection-header">
        <span className="mini-icon">
          <Link2 size={22} />
        </span>
        <h2>{wallets ? 'Choose your wallet' : 'Make yourself at home.'}</h2>
        <p className="muted spaced">
          {wallets
            ? 'Open an existing Lightning-first wallet or create a new one.'
            : 'Connect to your Beignet host. Your keys stay there; your browser is the remote control.'}
        </p>
      </div>
      <button className="text-button" disabled={busy} onClick={() => changeMode(null)}><ArrowLeft size={16} /> Back</button>
      {error && <Notice error>{error}</Notice>}
      {!wallets ? (
        <form className="flow-stack" onSubmit={connect}>
          <Field label="Host address">
            <Input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
              autoComplete="url"
              placeholder="https://wallet.example.com"
            />
          </Field>
          <Field label="Connection token">
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <p className="muted">
            The token stays in this tab’s memory. Closing or locking the wallet
            removes it. Use HTTPS when connecting beyond this computer.
          </p>
          <Action type="submit" disabled={busy}>
            {busy ? 'Connecting…' : 'Connect wallet'}
            <ArrowRight size={18} />
          </Action>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => { if (!pending.current) onConnect(new DemoWalletClient()); }}
          >
            Explore a sample wallet
          </button>
        </form>
      ) : (
        <div className="flow-stack">
          {!create &&
            wallets.map((wallet) => (
              <button
                key={wallet.id}
                className="activity-row"
                disabled={busy}
                onClick={async () => {
                  const id = begin();
                  if (id === null) return;
                  const selected = client!;
                  try {
                    selected.selectWallet(wallet.id);
                    if (wallet.status !== 'running')
                      await selected.startWallet();
                    if (id === operation.current) onConnect(selected);
                  } catch (e) {
                    if (id === operation.current) setError(errorText(e));
                  } finally {
                    finish(id);
                  }
                }}
              >
                <span className="activity-icon">
                  <Wallet size={20} />
                </span>
                <span className="activity-copy">
                  <strong>{wallet.name}</strong>
                  <small>
                    {wallet.network} · {wallet.status}
                  </small>
                </span>
                <ArrowRight size={18} />
              </button>
            ))}
          {!create ? (
            <Action secondary disabled={busy} onClick={() => { if (!pending.current) setCreate(true); }}>
              <Plus size={18} />
              New wallet
            </Action>
          ) : (
            <form className="flow-stack" onSubmit={createWallet}>
              <Field label="Wallet name">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={60}
                />
              </Field>
              <Field label="Network">
                <select
                  value={network}
                  onChange={(e) => {
                    const n = e.target.value as typeof network;
                    setNetwork(n);
                    setPrimary(n === 'mainnet' ? DEFAULT_PRIMARY_URI : '');
                    setElectrumHost('');
                    setElectrumPort(n === 'regtest' ? '60001' : '50002');
                    setElectrumTls(n !== 'regtest');
                  }}
                >
                  <option value="mainnet">Bitcoin mainnet</option>
                  <option value="regtest">Local regtest</option>
                  <option value="testnet">Bitcoin testnet</option>
                </select>
              </Field>
              <Field label="Primary node">
                <Textarea
                  value={primary}
                  onChange={(e) => setPrimary(e.target.value)}
                  required
                  placeholder="pubkey@host:port"
                  spellCheck={false}
                />
              </Field>
              <details>
                <summary className="text-button">
                  Chain connection{' '}
                  {config?.hasDefaultElectrum
                    ? '· host default available'
                    : '· configure a server'}
                </summary>
                <div className="flow-stack spaced">
                  <Field label="Electrum host">
                    <Input
                      value={electrumHost}
                      onChange={(e) => setElectrumHost(e.target.value)}
                      placeholder={
                        config?.defaultElectrum?.host || 'electrum.example.com'
                      }
                      autoCapitalize="none"
                      spellCheck={false}
                    />
                  </Field>
                  <Field label="Electrum port">
                    <Input
                      inputMode="numeric"
                      value={electrumPort}
                      onChange={(e) => setElectrumPort(e.target.value)}
                    />
                  </Field>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={electrumTls}
                      onChange={(e) => setElectrumTls(e.target.checked)}
                    />
                    Use TLS
                  </label>
                  <p className="muted">
                    Use an Electrum server on the selected network. Leaving it
                    blank uses the host’s configured default.
                  </p>
                </div>
              </details>
              <p className="muted">
                Your primary provides instant Lightning capacity using funding
                that may not yet be confirmed. The default onion address needs Tor
                configured on your host. Channel funding may incur network or
                provider fees.
              </p>
              <Action type="submit" disabled={busy}>
                {busy ? 'Creating wallet…' : 'Create wallet'}
              </Action>
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => { if (!pending.current) setCreate(false); }}
              >
                Cancel
              </button>
            </form>
          )}
          <button
            className="text-button"
            disabled={busy}
            onClick={() => {
              if (pending.current) return;
              operation.current++;
              setClient(null);
              setWallets(null);
              setToken('');
              setCreate(false);
            }}
          >
            Use a different host
          </button>
        </div>
      )}
    </section>
  );
}

function activityStatusLabel(item: Activity) {
  if (item.receiveStatus?.phase === 'partial') return 'Partially paid';
  if (item.receiveStatus?.phase === 'pending') return 'Awaiting confirmation';
  if (item.status === 'pending') return item.kind === 'request' ? 'Unpaid' : 'Awaiting';
  return item.status === 'completed' ? 'Completed' : item.status === 'expired' ? 'Expired' : item.status === 'failed' ? 'Failed' : 'Status unknown';
}

function ActivityList({
  items,
  onOpen,
  hidden = false,
}: {
  items: Activity[];
  onOpen: (a: Activity) => void;
  hidden?: boolean;
}) {
  return items.length ? (
    <div>
      {items.map((item) => (
        <button
          className="activity-row"
          key={item.id}
          onClick={() => onOpen(item)}
        >
          <span
            className={`activity-icon ${item.kind === 'sent' || item.kind === 'transfer' ? 'sent' : ''}`}
          >
            {item.kind === 'received' ? (
              <ArrowDownLeft size={21} />
            ) : item.kind === 'sent' ? (
              <ArrowUpRight size={21} />
            ) : (
              <Clock3 size={20} />
            )}
          </span>
          <span className="activity-copy">
            <strong>{item.title}</strong>
            <small>
              {when(item.timestamp)}
              {item.status !== 'completed' ? ` · ${activityStatusLabel(item)}` : ''}
            </small>
          </span>
          <span
            className={`activity-amount ${item.kind === 'received' && item.status === 'completed' ? 'positive' : ''}`}
          >
            {hidden
              ? '••••'
              : `${item.kind === 'received' ? '+ ' : item.kind === 'sent' ? '− ' : ''}${money(item.amountSats)}`}
            <small>sats</small>
          </span>
        </button>
      ))}
    </div>
  ) : (
    <div className="empty">
      Nothing here yet.
      <br />
      Your payments and requests will appear here.
    </div>
  );
}
function ActivityScreen({
  snapshot,
  onOpen,
  hidden,
}: {
  snapshot: WalletSnapshot;
  onOpen: (a: Activity) => void;
  hidden: boolean;
}) {
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const items = snapshot.activity.filter(
    (a) =>
      (filter === 'all' ||
        (filter === 'requests' ? a.kind === 'request' || !!a.receiveRequest : a.kind === filter)) &&
      `${a.title} ${a.description} ${a.reference} ${a.amountSats}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <section className="surface">
      <div className="flow-stack">
        <Field label="Search activity">
          <Input
            placeholder="Description, amount, or reference"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </Field>
        <div className="chips" aria-label="Activity filters">
          {[
            ['all', 'All'],
            ['sent', 'Sent'],
            ['received', 'Received'],
            ['requests', 'Requests'],
          ].map(([value, label]) => (
            <button
              key={value}
              className={`chip ${filter === value ? 'active' : ''}`}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <ActivityList items={items} onOpen={onOpen} hidden={hidden} />
    </section>
  );
}
function ActivityDetail({ item, back, client, now, refresh }: { item: Activity; back: () => void; client: Client; now: number; refresh: () => void }) {
  return (
    <section className="surface narrow flow-stack">
      <button className="text-button" onClick={back}>
        <ArrowLeft size={17} />
        Activity
      </button>
      <div className="center">
        <div className="success-icon">
          {item.status === 'completed' ? (
            <Check size={27} />
          ) : (
            <Clock3 size={27} />
          )}
        </div>
        <h2>{item.title}</h2>
        <div className="balance-value">
          {money(item.amountSats)} <span>sats</span>
        </div>
        <span className="badge">{activityStatusLabel(item)}</span>
      </div>
      {item.receiveStatus?.phase === 'pending' && <Notice>Your payment has been detected. Awaiting Bitcoin confirmation.</Notice>}
      {item.receiveStatus?.phase === 'partial' && <Notice>{money(item.receiveStatus.receivedSats)} sats received so far. {money(Math.max(0, (item.receiveRequest?.amountSats ?? item.amountSats) - item.receiveStatus.receivedSats))} sats remaining.</Notice>}
      {item.kind === 'transfer' && item.status === 'pending' && <Notice>This transfer is still awaiting completion. Your balance updates when the funds become available.</Notice>}
      {item.receiveStatusUnavailable && <Notice warning>{item.receiveRequest?.bitcoinTracking === 'ambiguous' ? 'This Bitcoin address was shared by multiple requests. Check Bitcoin received in Activity; this invoice updates automatically if paid with Lightning.' : 'Payment status is temporarily unavailable. The last known result is shown.'}</Notice>}
      {item.receiveRequest && <RequestDetails key={item.id} item={item} client={client} now={now} refresh={refresh} />}
      <Details
        rows={[
          ['Date', when(item.timestamp)],
          [
            item.feeEstimated ? 'Estimated fee' : 'Fee',
            item.feeKnown === false
              ? 'Unavailable'
              : `${money(item.feeSats)} sats`,
          ],
          ['Description', item.description || '—'],
          [
            'Reference',
            <span key="reference" className="monospace break">
              {item.reference}
            </span>,
          ],
          ...(item.address
            ? [[item.kind === 'sent' ? 'Recipient' : 'Receive address', item.address] as [string, ReactNode]]
            : []),
        ]}
      />
      {item.status === 'uncertain' && (
        <Notice warning>
          The connection ended before a final result arrived. Check activity
          before trying again.
        </Notice>
      )}
      <CopyValue value={item.reference} label="Copy reference" />
    </section>
  );
}


function RequestDetails({ item, client, now, refresh }: { item: Activity; client: Client; now: number; refresh: () => void }) {
  const request = item.receiveRequest!;
  const [linking, setLinking] = useState(false);
  const [original, setOriginal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const latch = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const shareable = item.kind === 'request' && item.status === 'pending' && request.expiresAt > now && !item.receiveStatusUnavailable;
  async function link(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (latch.current || !original.trim()) return;
    if (!item.paymentHash) { setError('This entry is missing its invoice reference.'); return; }
    latch.current = true; setBusy(true); setError('');
    try {
      await client.importReceiveRequest(original.trim(), item.paymentHash);
      if (!mounted.current) return;
      setSaved(true); setOriginal(''); setLinking(false); refresh();
    } catch (error) { if (mounted.current) setError(errorText(error)); }
    finally { latch.current = false; if (mounted.current) setBusy(false); }
  }
  return <div className="flow-stack request-history">
    {shareable ? <>
      <div className="qr-wrap"><QRCodeSVG value={request.uri} size={220} level="M" title={request.legacy ? 'Lightning invoice QR code' : 'Payment request QR code'} /></div>
      <Field label={request.legacy ? 'Lightning invoice' : 'Payment request'}><Textarea value={request.uri} readOnly rows={3} spellCheck={false} onFocus={event => event.target.select()} /></Field>
      <CopyValue value={request.uri} label={request.legacy ? 'Copy invoice' : 'Copy request'} />
      <p className="muted center">Expires in {Math.max(1, Math.ceil((request.expiresAt - now) / 60000))} min</p>
    </> : <details>
      <summary className="text-button">View original {request.legacy ? 'Lightning invoice' : 'request'}</summary>
      <div className="flow-stack spaced">
        <p className="muted">Saved for reference. {item.status === 'completed' ? 'This request has already been paid.' : request.expiresAt <= now ? 'This code has expired.' : item.receiveStatus && item.receiveStatus.phase !== 'waiting' ? 'A payment has been detected for this request.' : 'Check its payment status before sharing.'}</p>
        <Field label="Original code"><Textarea value={request.uri} readOnly rows={3} spellCheck={false} onFocus={event => event.target.select()} /></Field>
      </div>
    </details>}
    {request.legacy && item.kind === 'request' && !saved && <>
      <p className="muted">This older entry saved only its Lightning invoice. To match a Bitcoin payment, link the original payment request.</p>
      {!linking ? <button className="text-button" onClick={() => setLinking(true)}>Link original request</button> : <form className="flow-stack" onSubmit={link}>
        <Field label="Original payment request"><Textarea value={original} disabled={busy} onChange={event => setOriginal(event.target.value)} placeholder="Paste the original bitcoin: payment request" maxLength={16000} rows={3} spellCheck={false} /></Field>
        <Action type="submit" disabled={busy || !original.trim()}>{busy ? <Busy text="Linking request…" /> : 'Link request'}</Action>
        <button className="text-button" type="button" disabled={busy} onClick={() => setLinking(false)}>Cancel</button>
      </form>}
    </>}
    {saved && request.legacy && <Notice>Request linked. Checking its payment status…</Notice>}
    {error && <Notice error>{error}</Notice>}
  </div>;
}

function Send({
  client,
  refresh,
  now,
  disabled,
  demo,
  onActivity,
}: {
  client: Client;
  refresh: () => void;
  now: number;
  disabled: boolean;
  demo: boolean;
  onActivity: () => void;
}) {
  const [request, setRequest] = useState('');
  const [amount, setAmount] = useState('');
  const [review, setReview] = useState<SendReview | null>(null);
  const [result, setResult] = useState<SendResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const latch = useRef(false);
  async function prepare(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (latch.current) return;
    latch.current = true;
    setBusy(true);
    setError('');
    try {
      setReview(
        await client.prepareSend({
          request,
          ...(amount.trim() ? { amountSats: parseSats(amount) } : {}),
        }),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      latch.current = false;
      setBusy(false);
    }
  }
  async function send() {
    if (!review || latch.current) return;
    latch.current = true;
    setBusy(true);
    setError('');
    try {
      setResult(await client.send(review));
      setReview(null);
      refresh();
    } catch (e) {
      setError(errorText(e));
      setReview(null);
    } finally {
      latch.current = false;
      setBusy(false);
    }
  }
  async function paste() {
    try {
      setRequest(await navigator.clipboard.readText());
      setAmount('');
    } catch {
      setError(
        'Paste your request into the box using your browser’s paste command.',
      );
    }
  }
  if (result)
    return (
      <section className="surface narrow flow-stack">
        <div className="center">
          <div className="success-icon">
            {result.status === 'completed' ? (
              <Check size={30} />
            ) : (
              <Clock3 size={30} />
            )}
          </div>
          <h2>
            {result.status === 'completed'
              ? 'Payment sent'
              : result.status === 'failed'
                ? 'Payment failed'
                : result.status === 'uncertain'
                  ? 'Checking the outcome'
                  : 'Payment in progress'}
          </h2>
          <div className="balance-value">
            {money(result.amountSats)} <span>sats</span>
          </div>
        </div>
        <Notice warning={result.status !== 'completed'}>
          {result.message}
        </Notice>
        {demo && (
          <p className="muted center">
            Simulated payment. No real money moved.
          </p>
        )}
        <Details
          rows={[
            [
              result.feeEstimated || result.status !== 'completed'
                ? 'Reviewed fee'
                : 'Fee paid',
              result.feeKnown === false
                ? 'Unavailable'
                : `${money(result.feeSats)} sats`,
            ],
            [
              'Reference',
              <span key="reference" className="break monospace">
                {result.paymentHash || result.txid || result.id}
              </span>,
            ],
          ]}
        />
        <Action onClick={onActivity}>
          View activity
          <ArrowRight size={18} />
        </Action>
      </section>
    );
  return (
    <section className="surface narrow flow-stack">
      {error && <Notice error>{error}</Notice>}
      {disabled && (
        <Notice warning>Waiting for a fresh wallet connection.</Notice>
      )}
      {!review ? (
        <form className="flow-stack" onSubmit={prepare}>
          <div>
            <h2>Where’s it going?</h2>
            <p className="muted spaced">
              Paste a Lightning invoice or Bitcoin payment request. We’ll take
              it from there.
            </p>
          </div>
          <Field label="Payment request">
            <Textarea
              value={request}
              onChange={(e) => {
                setRequest(e.target.value);
                setAmount('');
                setError('');
              }}
              required
              placeholder="Paste a payment request or address"
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
            />
          </Field>
          <button type="button" className="text-button" onClick={paste}>
            <Copy size={16} />
            Paste from clipboard
          </button>
          <Amount amount={amount} setAmount={setAmount} optional />
          <p className="muted">
            Leave the amount empty if it’s already in the request.
          </p>
          {demo && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setRequest('demo:coffee');
                setAmount('2450');
              }}
            >
              Try a sample payment
            </button>
          )}
          <Action type="submit" disabled={busy || disabled || !request.trim()}>
            {busy ? 'Checking payment…' : 'Review payment'}
            <ArrowRight size={18} />
          </Action>
        </form>
      ) : (
        <>
          <button
            className="text-button"
            disabled={busy}
            onClick={() => setReview(null)}
          >
            <ArrowLeft size={17} />
            Edit payment
          </button>
          <div className="center">
            <h2>Ready to send</h2>
            <div className="balance-value">
              {money(review.amountSats)} <span>sats</span>
            </div>
            <p className="muted spaced">
              {review.description || 'Bitcoin payment'}
            </p>
          </div>
          <Details
            rows={[
              [
                'To',
                <span key="destination" className="break monospace">
                  {review.destination}
                </span>,
              ],
              [review.feeLabel || 'Fee', `${money(review.feeSats)} sats`],
              ['Total', `${money(review.totalSats)} sats`],
            ]}
          />
          {review.warnings.map((w, i) => (
            <Notice warning key={i}>
              {w}
            </Notice>
          ))}
          {review.expiresAt <= now ? (
            <Notice warning>This quote expired. Go back to refresh it.</Notice>
          ) : (
            <p className="muted">
              Quote expires in{' '}
              {Math.max(1, Math.ceil((review.expiresAt - now) / 1000))} seconds.
            </p>
          )}
          <Action
            onClick={send}
            disabled={busy || disabled || review.expiresAt <= now}
          >
            {busy
              ? 'Sending…'
              : `${demo ? 'Simulate send' : 'Send'} ${money(review.amountSats)} sats`}
            <ArrowUpRight size={19} />
          </Action>
        </>
      )}
    </section>
  );
}

function Receive({
  client,
  now,
  disabled,
  allowAmountless,
  offlineReceivableSats,
  refresh,
  onActivity,
}: {
  client: Client;
  now: number;
  disabled: boolean;
  allowAmountless: boolean;
  /** The most an offline receive can take right now; undefined when the engine does not say. */
  offlineReceivableSats?: number;
  refresh: () => void;
  onActivity: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [quote, setQuote] = useState<ReceiveQuote | null>(null);
  const [request, setRequest] = useState<ReceiveRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const latch = useRef(false);
  const [capacityChanged, setCapacityChanged] = useState(false);
  // Receiving offline is an opt-in, never the default: the ordinary request
  // is paid over the home channel or provisioned by the primary just in time.
  // The box is offered only when the engine advertises offline receiving; the
  // primary still has to offer settlement, and the quote says so when not.
  const [offlineAvailable, setOfflineAvailable] = useState(false);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    let active = true;
    // Through a promise, so a client without getConfig (the demo client, an
    // older host) leaves the box off rather than breaking the form.
    Promise.resolve()
      .then(() => client.getConfig?.())
      .then((config) => { if (active) setOfflineAvailable(config?.offlineReceiveAvailable === true); })
      .catch(() => { if (active) setOfflineAvailable(false); });
    return () => { active = false; };
  }, [client]);
  // Nor is it offered when no channel can hold one: an offline receive needs
  // a channel with the primary that holds none of this wallet's balance. An
  // engine that does not say how much fits leaves that to the quote.
  const offlineOffered = offlineAvailable && (offlineReceivableSats === undefined || offlineReceivableSats > 0);
  // Back to the ordinary request when an offline one no longer fits, but only
  // on the form: creating an offline request reserves its channel, which takes
  // the figure to 0 while that request is still on screen.
  useEffect(() => {
    // oxlint-disable-next-line react/react-compiler -- A refresh that finds no room withdraws a choice the form can no longer honour.
    if (!request && !quote && !offlineOffered) setOffline(false);
  }, [request, quote, offlineOffered]);
  // An amount is needed when the primary has to provide the capacity (a
  // just-in-time receive is quoted on it), when it changed under a quote, and
  // for an offline receive, whose slot holds one fixed amount.
  const amountRequired = !allowAmountless || capacityChanged || offline;
  const typedSats = /^\d+$/.test(amount.trim()) ? Number(amount.trim()) : 0;
  const overOffline = offline && offlineReceivableSats !== undefined && typedSats > offlineReceivableSats;
  const amountError = useRef(false);
  useEffect(() => {
    if (allowAmountless) {
      // oxlint-disable-next-line react/react-compiler -- A false-to-true capacity update supersedes a prior quote's amount requirement.
      setCapacityChanged(false);
      if (amountError.current) { setError(''); amountError.current = false; }
    }
  }, [allowAmountless]);
  async function prepare(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (latch.current || disabled) return;
    if (amountRequired && !amount.trim()) {
      setError('Enter an amount for your payment request.');
      return;
    }
    if (overOffline) return;
    latch.current = true;
    setBusy(true);
    setError('');
    try {
      setQuote(
        await client.quoteReceive({
          ...(amount.trim() ? { amountSats: parseSats(amount) } : {}),
          description,
          ...(offline ? { mode: 'offline' as const } : {}),
        }),
      );
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'AMOUNT_REQUIRED') { setCapacityChanged(true); amountError.current = true; }
      setError(errorText(e));
    } finally {
      latch.current = false;
      setBusy(false);
    }
  }
  async function create() {
    if (!quote || latch.current || disabled) return;
    latch.current = true;
    setBusy(true);
    setError('');
    try {
      setRequest(await client.receive(quote));
      setQuote(null);
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'AMOUNT_REQUIRED') { setCapacityChanged(true); amountError.current = true; }
      setError(errorText(e));
      setQuote(null);
    } finally {
      latch.current = false;
      setBusy(false);
    }
  }
  const tracking = useReceiveStatus(client, request, refresh);
  const receipt = tracking?.status && tracking.status.phase !== 'waiting' ? tracking.status : null;
  async function share() {
    if (!request || receipt || tracking?.ambiguous) return;
    try {
      if (navigator.share)
        await navigator.share({
          title: 'Beignet payment request',
          text: request.uri,
        });
      else if (navigator.clipboard)
        await navigator.clipboard.writeText(request.uri);
      else throw new Error('Copy the request using the text field below.');
    } catch (e) {
      if (!(e instanceof Error && e.name === 'AbortError'))
        setError(errorText(e));
    }
  }
  return (
    <section className="surface narrow flow-stack">
      {error && <Notice error>{error}</Notice>}
      {request && tracking?.error && <Notice warning>{tracking.error}</Notice>}
      {request ? (
        <>
          {tracking?.ambiguous ? <>
            <h2>Check payment status</h2>
            <p className="muted">The original request is saved below. Check Activity for Bitcoin received before sharing another request.</p>
            <details><summary className="text-button">View original request</summary>
              <Field label="Original code"><Textarea value={request.uri} readOnly rows={3} spellCheck={false} onFocus={event => event.target.select()} /></Field>
            </details>
            <Action onClick={onActivity}>View activity<ArrowRight size={18} /></Action>
          </> : receipt ? <>
            <ReceiveReceipt request={request} status={receipt} />
            <Action onClick={onActivity}>View activity<ArrowRight size={18} /></Action>
          </> : <>
          <div className="center">
            <h2>
              {request.amountSats
                  ? `Receive ${money(request.amountSats)} sats`
                  : 'Ready to receive'}
            </h2>
            <p className="muted spaced">
              {request.description ||
                  (request.bitcoinTracking === 'lightning-only' ? 'This request accepts Lightning.' : 'One request. Let their wallet choose how to pay.')}
            </p>
          </div>
          {request.expiresAt <= now ? (
            <Notice warning>
              This request has expired. Create a new one before sharing.
            </Notice>
          ) : (
            <div className="qr-wrap">
              <QRCodeSVG
                value={request.uri}
                size={252}
                level="M"
                title="Payment request QR code"
              />
            </div>
          )}
          {request.demo && (
            <Notice warning>
              Preview code only. This cannot receive real money.
            </Notice>
          )}
          <div className="wallet-actions">
            <Action
              onClick={share}
              disabled={request.expiresAt <= now}
            >
              <Share2 size={18} />
              Share
            </Action>
            <CopyValue
              value={request.uri}
              disabled={request.expiresAt <= now}
            />
          </div>
          <Field label="Payment request">
            <Textarea
              value={request.uri}
              readOnly
              rows={3}
              spellCheck={false}
              onFocus={(e) => e.target.select()}
            />
          </Field>
          {request.expiresAt > now && (
            <p className="muted center">
              Expires in {Math.ceil((request.expiresAt - now) / 60000)} min ·
              {request.offlineReceive ? 'You can close your wallet. Payments will appear when you reopen it.' : client instanceof EmbeddedWalletClient ? 'Keep this wallet open.' : 'Keep your host online.'}
            </p>
          )}
          {request.warnings.map((w, i) => (
            <Notice warning key={i}>
              {w}
            </Notice>
          ))}
          </>}
          <button
            className="text-button"
            onClick={() => {
              setRequest(null);
              setCapacityChanged(false); amountError.current = false;
              setError('');
              setAmount(receipt?.phase === 'partial' && request.amountSats != null ? String(Math.max(0, request.amountSats - receipt.receivedSats)) : '');
              if (receipt?.phase !== 'partial') setDescription('');
            }}
          >
            {receipt?.phase === 'partial' ? 'Request the remaining amount' : 'New request'}
          </button>
        </>
      ) : quote ? (
        <>
          <button className="text-button" disabled={busy} onClick={() => setQuote(null)}>
            <ArrowLeft size={16} />
            Edit request
          </button>
          <h2>Your request</h2>
          <Details
            rows={[
              [
                'Amount',
                quote.amountSats
                  ? `${money(quote.amountSats)} sats`
                  : 'Any amount',
              ],
              ['Receiving fee', `${money(quote.feeSats)} sats`],
              [
                'You receive',
                quote.netSats != null
                  ? `${money(quote.netSats)} sats`
                  : 'Amount sent, less any quoted fees',
              ],
            ]}
          />
          {offline && (
            <Notice>
              Payable while this wallet is closed. Your primary node prepares it and settles the payment for you.
            </Notice>
          )}
          {quote.warnings.map((w, i) => (
            <Notice warning key={i}>
              {w}
            </Notice>
          ))}
          {quote.expiresAt <= now && (
            <Notice warning>
              The quote expired. Edit the request to get a fresh quote.
            </Notice>
          )}
          <Action
            onClick={create}
            disabled={busy || disabled || quote.expiresAt <= now}
          >
            {busy ? <Busy text="Creating request…" /> : <>Create request<ArrowDownLeft size={19} /></>}
          </Action>
        </>
      ) : (
        <form className="flow-stack" onSubmit={prepare} aria-busy={busy}>
          <div>
            <h2>Make a little room for more.</h2>
            <p className="muted spaced">
              Share one code, whether someone pays with Lightning or Bitcoin.
            </p>
          </div>
          <Amount amount={amount} setAmount={setAmount} optional={!amountRequired} required={amountRequired} disabled={busy} />
          <p className="muted">{overOffline ? `An offline receive can take up to ${money(offlineReceivableSats ?? 0)} sats right now.` : amountRequired ? 'Enter an amount for your payment request.' : 'Leave the amount blank to let the sender choose.'}</p>
          <Field label="What’s it for? · optional">
            <Input
              value={description}
              disabled={busy}
              maxLength={160}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Dinner, a thank-you, anything"
            />
          </Field>
          {offlineOffered && (
            <div>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={offline}
                  disabled={busy}
                  onChange={(e) => { setOffline(e.target.checked); setError(''); }}
                />
                Receive offline
              </label>
              <p className="muted">
                {offline
                  ? `Accept this payment even while this wallet is closed. Your primary node prepares it, so it has to offer offline settlement. ${offlineReceivableSats === undefined ? 'Enter at least 354 sats.' : `Enter 354 to ${money(offlineReceivableSats)} sats.`}`
                  : 'Off, the request is paid over your channel or provisioned by your primary node just in time.'}
              </p>
            </div>
          )}
          <output className="muted">
            {busy ? 'Checking your primary’s receiving capacity. This can take a few seconds.' : 'We’ll check any receiving fee before creating the request.'}
          </output>
          <Action type="submit" disabled={busy || disabled || (amountRequired && !amount.trim()) || overOffline}>
            {busy ? <Busy text="Checking availability…" /> : <>{error ? 'Try again' : 'Continue'}<ArrowRight size={18} /></>}
          </Action>
        </form>
      )}
    </section>
  );
}

function CopyValue({
  value,
  label = 'Copy',
  disabled = false,
}: {
  value: string;
  label?: string;
  disabled?: boolean;
}) {
  const [message, setMessage] = useState('');
  return (
    <div>
      <Action
        secondary
        disabled={disabled}
        onClick={async () => {
          try {
            if (!navigator.clipboard) throw new Error();
            await navigator.clipboard.writeText(value);
            setMessage('Copied');
          } catch {
            setMessage('Select the text and use your browser’s copy command.');
          }
        }}
      >
        <Copy size={17} />
        {message === 'Copied' ? 'Copied' : label}
      </Action>
      {message && message !== 'Copied' && (
        <output className="muted spaced">{message}</output>
      )}
    </div>
  );
}

function Settings({
  client,
  wallet,
  snapshot,
  lock,
  applySettings,
  feedback,
  revision,
  busy,
}: {
  client: Client;
  wallet: WalletRecord;
  snapshot: WalletSnapshot | null;
  lock: () => void;
  applySettings: ApplySettings;
  feedback: SettingsFeedbackState | null;
  revision: number;
  busy: boolean;
}) {
  const status = snapshot?.wallet.id === wallet.id ? snapshot.primary : {
    uri: wallet.lfbw?.primaryUri || '', connected: false,
    setup: wallet.lfbw?.setup || 'pending', setupError: wallet.lfbw?.setupError,
  };
  const demo = client instanceof DemoWalletClient;
  const [primary, setPrimary] = useState(
    status.uri || (wallet.network === 'mainnet' ? DEFAULT_PRIMARY_URI : ''),
  );
  const [revealing, setRevealing] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [showBackup, setShowBackup] = useState(false);
  // Which engine build is actually running. The wallet reports it, so host mode
  // and on-device mode can differ and the difference is visible rather than
  // assumed.
  const [engineVersion, setEngineVersion] = useState('');
  useEffect(() => {
    let active = true;
    // A version label is a courtesy. It must never be able to take Settings
    // down, which is the one screen someone reaches for when things are wrong.
    Promise.resolve()
      .then(() => client.getConfig?.())
      .then((config) => {
        if (active) setEngineVersion(config?.engineVersion || '');
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [client]);
  const disabled = busy || revealing;
  async function update(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (disabled) return;
    setError('');
    try {
      await applySettings({ scope: 'primary', pending: 'Saving primary and connecting…', success: 'Primary saved.', change: async () => {
        const session = browserSession(client);
        if (session) {
          const settings = await session.networkSettings();
          return session.switchNetwork({ ...settings.profiles[wallet.network], primaryUri: primary.trim() });
        }
        return { wallet: await client.updatePrimary(primary.trim()) };
      } });
      setEditing(false);
    } catch { /* The persistent feedback shows the error; retain the draft. */ }
  }
  async function retry() {
    if (disabled) return;
    setError('');
    try {
      await applySettings({ scope: 'primary', pending: 'Connecting to your primary…', success: 'Connection check finished.', change: async () => { await client.retrySetup(); } });
    } catch { /* The persistent feedback shows the connection failure. */ }
  }
  useEffect(() => {
    const hide = () => {
      if (document.hidden) {
        setPhrase('');
        setShowBackup(false);
      }
    };
    document.addEventListener('visibilitychange', hide);
    return () => document.removeEventListener('visibilitychange', hide);
  }, []);
  async function reveal() {
    if (disabled) return;
    setRevealing(true);
    setError('');
    try {
      setPhrase(await client.getRecoveryPhrase());
      setShowBackup(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setRevealing(false);
    }
  }
  if (phrase)
    return <BackupPhrase phrase={phrase} onDone={() => setPhrase('')} />;
  return (
    <div className="narrow flow-stack">
      {error && <Notice error>{error}</Notice>}
      <fieldset className="settings-controls flow-stack" disabled={disabled}>
      <section className="surface flow-stack">
        <h2>Wallet connection</h2>
        <Details
          rows={[
            ['Wallet', wallet.name],
            ['Network', wallet.network],
            [
              'Keys stored',
              demo ? 'Preview — no keys' : client instanceof EmbeddedWalletClient ? 'This browser' : 'Your Beignet host',
            ],
            [client instanceof EmbeddedWalletClient ? 'Wallet engine' : 'Host', demo ? 'Sample wallet' : client instanceof EmbeddedWalletClient ? 'On this device' : client.connection.url],
            ['Last updated', when(snapshot?.updatedAt || 0)],
            ...(engineVersion
              ? ([['Engine', engineVersion]] as [string, ReactNode][])
              : []),
          ]}
        />
        <p className="muted">
          {client instanceof EmbeddedWalletClient
            ? 'Keep this wallet open to receive payments and monitor channels. Locking stops the engine and removes unlocked keys from memory. Clearing site data removes this wallet.'
            : 'Your host stays online to receive payments and protect channels. This browser holds only a temporary connection token.'}
        </p>
        <Action secondary onClick={lock} disabled={disabled}>
          <LockKeyhole size={18} />
          {demo ? 'Leave preview' : 'Lock & disconnect'}
        </Action>
      </section>
      {!demo && <NetworkSettings client={client} currentNetwork={wallet.network} currentWalletId={wallet.id}
        applySettings={applySettings} feedback={feedback} revision={revision} disabled={disabled} />}
      <section className="surface flow-stack">
        <div className="row">
          <h2>Primary node</h2>
          <span className="badge">
            {busy && feedback?.scope === 'primary' ? 'Updating…' : status.connected
              ? 'Connected'
              : status.setup === 'failed' ? 'Connection needed' : 'Connecting'}
          </span>
        </div>
        <p className="muted">
          Provides capacity when you need it, so you don’t have to manage
          channels.
        </p>
        {client instanceof EmbeddedWalletClient && <p className="muted">The app connects to this node automatically.</p>}
        <SettingsFeedback feedback={feedback?.scope === 'primary' ? feedback : null} />
        {feedback?.scope !== 'primary' && status.setup === 'failed' && <Notice error>{status.setupError || 'Could not connect to your primary. Check its address and make sure the node is running.'}</Notice>}
        {editing ? (
          <form className="flow-stack" onSubmit={update}>
            <Field label="Node address">
              <Textarea
                value={primary}
                onChange={(e) => {
                  setPrimary(e.target.value);
                }}
                required
                disabled={disabled}
                spellCheck={false}
              />
            </Field>
            <p className="muted">Your primary provides instant Lightning capacity using funding that may not yet be confirmed. Changing it keeps existing channels open.</p>
            <Action type="submit" disabled={disabled}>
              {busy && feedback?.scope === 'primary' ? <Busy text="Saving…" /> : 'Save primary'}
            </Action>
            <button
              type="button"
              className="text-button"
              onClick={() => setEditing(false)}
              disabled={disabled}
            >
              Cancel
            </button>
          </form>
        ) : (
          <>
            <p className="monospace break">
              {status.uri || 'No primary configured'}
            </p>
            <div className="row">
              <button className="text-button" disabled={disabled} onClick={() => { setPrimary(status.uri); setEditing(true); }}>
                Change primary
              </button>
              <button className="text-button" onClick={retry} disabled={disabled}>
                {busy && feedback?.scope === 'primary' ? <Busy text="Connecting…" /> : 'Retry connection'}
              </button>
            </div>
          </>
        )}
      </section>
      <section className="surface flow-stack">
        <h2>Backup & recovery</h2>
        <p className="muted">
          Write down your recovery phrase and keep a secure backup of your
          wallet’s data. The phrase alone does not contain the latest
          channel state.
        </p>
        {showBackup ? (
          <>
            <Notice warning>
              Anyone with this phrase can access your wallet. Make sure nobody
              else can see your screen.
            </Notice>
            <Action disabled={disabled} onClick={reveal}>
              {revealing ? <Busy text="Loading…" /> : 'Reveal recovery phrase'}
            </Action>
            <button
              className="text-button"
              onClick={() => setShowBackup(false)}
            >
              Cancel
            </button>
          </>
        ) : (
          <Action
            secondary
            disabled={demo || disabled}
            onClick={() => setShowBackup(true)}
          >
            <ShieldCheck size={18} />
            Back up wallet
          </Action>
        )}
      </section>
      </fieldset>
    </div>
  );
}

function BackupPhrase({
  phrase,
  onDone,
  initial = false,
}: {
  phrase: string;
  onDone: () => void;
  initial?: boolean;
}) {
  const [saved, setSaved] = useState(false);
  const [concealed, setConcealed] = useState(false);
  useEffect(() => {
    const hide = () => {
      if (document.hidden) setConcealed(true);
    };
    document.addEventListener('visibilitychange', hide);
    return () => document.removeEventListener('visibilitychange', hide);
  }, []);
  return (
    <section className="surface narrow flow-stack">
      <h2>{initial ? 'Your wallet is created.' : 'Your recovery phrase'}</h2>
      <p className="muted">
        Write these words down in order and keep them somewhere private. Do not
        send them to anyone or save them in a screenshot.
      </p>
      {concealed ? (
        <Action secondary onClick={() => setConcealed(false)}>
          Show words again
        </Action>
      ) : (
        <ol className="recovery-words">
          {phrase
            .trim()
            .split(/\s+/)
            .map((word, index) => (
              <li key={index}>
                <span>{index + 1}</span>
                {word}
              </li>
            ))}
        </ol>
      )}
      <Notice warning>
        Keep your wallet’s data backed up too. This phrase cannot recover
        the latest Lightning channel state on its own.
      </Notice>
      {initial && (
        <label className="check-label">
          <input
            type="checkbox"
            checked={saved}
            onChange={(e) => setSaved(e.target.checked)}
          />
          I wrote down my recovery phrase.
        </label>
      )}
      <Action disabled={initial && !saved} onClick={onDone}>
        {initial ? 'Open wallet' : 'Hide phrase & return'}
      </Action>
    </section>
  );
}
