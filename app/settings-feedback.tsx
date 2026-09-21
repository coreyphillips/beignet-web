import { Check, CircleAlert } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import type { SettingsFeedback as Feedback } from '@/lib/settings-types';

export function SettingsFeedback({ feedback }: { feedback?: Feedback | null }) {
  if (!feedback) return null;
  const { phase, message } = feedback;
  return <div className={`notice settings-feedback ${phase}`} role={phase === 'error' ? 'alert' : 'status'} aria-live={phase === 'error' ? 'assertive' : 'polite'}>
    {phase === 'pending' ? <Spinner aria-hidden="true" /> : phase === 'success' ? <Check size={18} aria-hidden="true" /> : <CircleAlert size={18} aria-hidden="true" />}
    <span>{message}</span>
  </div>;
}
