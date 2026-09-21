// Saving configuration and reconnecting are different outcomes. Once a change
// commits, a failed refresh must never be described as an unsaved setting.
export function createSettingsUpdater() {
  let pending = false;
  return {
    get pending() { return pending; },
    async run({ client, change, previousWallet, refresh = true }) {
      if (pending) throw new Error('Wait for the current settings update to finish.');
      pending = true;
      try {
        const applied = await change() || {};
        if (!refresh) return { phase: 'success', applied: true };
        let snapshot = null, wallet = null;
        try { snapshot = await client.snapshot(); wallet = snapshot.wallet; }
        catch {
          try { wallet = (await client.listWallets()).find(w => w.id === client.connection.walletId) || null; }
          catch { /* The committed change remains applied even when offline. */ }
        }
        if (!wallet) {
          const record = applied.wallet || previousWallet;
          if (record?.id === client.connection.walletId) {
            // Worker results may contain raw setup errors. Only sanitized list
            // or snapshot diagnostics may be displayed; keep fallback identity.
            wallet = { id: record.id, name: record.name, network: record.network, status: record.status,
              lfbw: { enabled: !!record.lfbw?.enabled, primaryUri: record.lfbw?.primaryUri, setup: record.lfbw?.setup } };
          }
        }
        const connected = !!snapshot?.primary.connected && wallet?.lfbw?.setup !== 'failed';
        return { applied: true, wallet, snapshot, mnemonic: applied.mnemonic,
          phase: connected ? 'success' : 'warning',
          detail: connected ? 'Connected to your primary.' : wallet?.lfbw?.setupError || (snapshot
            ? 'The primary is still connecting. You can retry the connection here.'
            : 'The connection could not be verified yet. You can retry here; your settings were saved.') };
      } finally { pending = false; }
    },
  };
}
