import type { WalletRecord, WalletSnapshot } from '@beignet/wallet-core';

export type SettingsScope = 'primary' | 'network';
export type SettingsFeedback = { scope: SettingsScope; phase: 'pending' | 'success' | 'warning' | 'error'; message: string };
export type SettingsOutcome = {
  applied: boolean; phase: 'success' | 'warning'; wallet?: WalletRecord | null;
  snapshot?: WalletSnapshot | null; mnemonic?: string; detail?: string;
};
export type ApplySettings = (options: {
  scope: SettingsScope; pending: string; success: string; refresh?: boolean;
  change: () => Promise<{ wallet?: WalletRecord; mnemonic?: string } | void>;
}) => Promise<SettingsOutcome>;
