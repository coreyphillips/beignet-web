import { useEffect, useState } from 'react';
import type { ReceiveRequest, ReceiveStatus, WalletClientInterface } from '@beignet/wallet-core';

// Watch the displayed request independently of the slower full-wallet refresh.
// Requests never overlap, and results from an old request cannot update a new one.
export function useReceiveStatus(client: WalletClientInterface, request: ReceiveRequest | null, onSettled: () => void) {
  const [result, setResult] = useState<{ id: string; status?: ReceiveStatus; error?: string; ambiguous?: boolean } | null>(null);
  useEffect(() => {
    if (!request) return;
    let stopped = false, inFlight = false, settled = false, detected = false;
    const run = async () => {
      if (stopped || inFlight || settled || document.hidden) return;
      inFlight = true;
      try {
        const status = await client.getReceiveStatus(request);
        if (stopped) return;
        setResult({ id: request.id, status });
        if (status.phase === 'completed') {
          settled = true;
          onSettled();
        } else if (!detected && status.phase !== 'waiting') {
          detected = true;
          onSettled();
        }
      } catch (error) {
        if (stopped) return;
        if (error && typeof error === 'object' && 'code' in error && error.code === 'AMBIGUOUS_RECEIVE_ADDRESS') {
          setResult({ id: request.id, ambiguous: true, error: 'This Bitcoin address was shared by multiple requests. Check Bitcoin received in Activity; this invoice updates automatically if paid with Lightning.' });
        } else {
          setResult(previous => ({
            id: request.id,
            ...(previous?.id === request.id ? { status: previous.status } : {}),
            error: 'Payment status is temporarily unavailable. We’ll keep checking.',
          }));
        }
      } finally { inFlight = false; }
    };
    void run();
    const timer = setInterval(run, 2000);
    document.addEventListener('visibilitychange', run);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', run);
    };
  }, [client, request, onSettled]);
  return result?.id === request?.id ? result : null;
}
