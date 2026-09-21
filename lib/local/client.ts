import { EmbeddedWalletClient, type EmbeddedRuntime, type WalletClientInterface, type WalletRecord } from '@beignet/wallet-core';

export type LocalConnectionOptions = {
  electrumUrl: string;
  peerUrl: string;
  token: string;
  electrum: { host: string; port: number; tls: boolean };
};
type Reply = { id: number; result?: unknown; error?: { message: string; code?: string; status?: number } };
export type VaultStatus = { exists: boolean; passwordRequired: boolean };
export type WalletDefaults = { network: 'mainnet' | 'testnet' | 'regtest'; primaryUri: string };
export type NetworkProfile = WalletDefaults & { electrum: { host: string; port: number; tls: boolean } };
export type NetworkSettings = {
  activeNetwork: NetworkProfile['network']; profiles: Record<NetworkProfile['network'], NetworkProfile>;
  recovery?: { sourceNetwork: NetworkProfile['network']; separateNetworks: NetworkProfile['network'][] } | null;
};
const sessions = new WeakMap<WalletClientInterface, BrowserWalletSession>();
export const browserSession = (client: WalletClientInterface) => sessions.get(client);

export class BrowserWalletSession {
  private worker: Worker;
  private counter = 0;
  private closed = false;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  readonly client: EmbeddedWalletClient;
  constructor() {
    this.worker = new Worker(new URL('./wallet.worker.mjs', import.meta.url), { type: 'module', name: 'Beignet wallet' });
    this.worker.onmessage = (event: MessageEvent<Reply>) => {
      const { id, result, error } = event.data;
      const waiter = this.pending.get(id);
      if (!waiter) return;
      this.pending.delete(id);
      if (error) waiter.reject(Object.assign(new Error(error.message), { code: error.code, status: error.status }));
      else waiter.resolve(result);
    };
    this.worker.onerror = () => this.destroy(new Error('The local wallet stopped. Unlock it again to reconnect.'));
    const runtime: EmbeddedRuntime = {
      request: (request) => this.call('request', request),
      close: () => this.close(),
    };
    this.client = new EmbeddedWalletClient({ runtime });
    sessions.set(this.client, this);
  }
  call(operation: string, payload?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Wallet is locked.'));
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, operation, payload });
    });
  }
  async probe(): Promise<boolean> { return (await this.call('probe')) as boolean; }
  async inspect(): Promise<VaultStatus> { return (await this.call('inspect')) as VaultStatus; }
  async open(password: string): Promise<{ defaults: WalletDefaults }> {
    return (await this.call('unlock', { password, automatic: true })) as { defaults: WalletDefaults };
  }
  async networkSettings(): Promise<NetworkSettings> { return (await this.call('network-settings')) as NetworkSettings; }
  async saveNetwork(profile: NetworkProfile): Promise<NetworkSettings> { return (await this.call('save-network', profile)) as NetworkSettings; }
  async switchNetwork(profile: NetworkProfile): Promise<{ wallet: WalletRecord; mnemonic?: string }> {
    const result = (await this.call('switch-network', profile)) as { wallet: WalletRecord; mnemonic?: string };
    this.client.selectWallet(result.wallet.id);
    return result;
  }
  async unlock(password: string, options?: LocalConnectionOptions) {
    return this.call('unlock', { password, options });
  }
  async close() {
    if (this.closed) return;
    const timeout = setTimeout(() => this.destroy(new Error('Wallet is locked.')), 10000);
    try { await this.call('close'); }
    finally { clearTimeout(timeout); this.destroy(new Error('Wallet is locked.')); }
  }
  destroy(error = new Error('Wallet is locked.')) {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}
