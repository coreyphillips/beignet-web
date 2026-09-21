import type { CSSProperties } from 'react';
import { Check, Clock3, ArrowDownLeft } from 'lucide-react';
import { formatSats, type ReceiveRequest, type ReceiveStatus } from '@beignet/wallet-core';

function Confetti() {
  return <div className="receipt-confetti" aria-hidden="true">
    {Array.from({ length: 24 }, (_, i) => {
      const angle = (i / 24) * Math.PI * 2;
      return <i key={i} style={{
        '--confetti-x': `${Math.cos(angle) * (90 + (i % 4) * 22)}px`,
        '--confetti-y': `${Math.sin(angle) * (80 + (i % 3) * 25) - 22}px`,
        '--confetti-turn': `${180 + i * 43}deg`,
        '--confetti-delay': `${(i % 4) * 35}ms`,
      } as CSSProperties} />;
    })}
  </div>;
}

export function ReceiveReceipt({ request, status }: { request: ReceiveRequest; status: ReceiveStatus }) {
  const complete = status.phase === 'completed';
  const partial = status.phase === 'partial';
  return <div className={`receive-receipt ${complete ? 'completed' : 'awaiting'}`}>
    <div className="receipt-mark" aria-hidden="true">
      {complete && <Confetti />}
      <div className="receipt-icon">{complete ? <Check size={34} /> : partial ? <ArrowDownLeft size={32} /> : <Clock3 size={32} />}</div>
    </div>
    <output className="receipt-message" aria-live="polite" aria-atomic="true">
      <span className="receipt-title">{complete ? 'Payment received' : partial ? 'Partial payment received' : 'Payment detected'}</span>
      <span className="receipt-amount">{formatSats(status.receivedSats)} <small>sats</small></span>
      <span className="muted">
        {partial && request.amountSats != null
          ? `Of ${formatSats(request.amountSats)} sats requested. ${formatSats(Math.max(0, request.amountSats - status.receivedSats))} sats remaining.`
          : complete ? 'Your payment is complete.' : 'Awaiting confirmation. Not yet available to spend.'}
      </span>
      {(partial || complete) && status.pendingSats > 0 && <span className="muted">{formatSats(status.pendingSats)} sats awaiting confirmation.</span>}
    </output>
    {request.description && <p className="muted center spaced">{request.description}</p>}
  </div>;
}
