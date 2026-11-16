import { useEffect } from 'react';
import { useAppStore } from '../store/appStore';

const INFO_DURATION_MS = 2600;
const ERROR_DURATION_MS = 8000;

/** Transient status message (saved, exported, import errors). */
export function Toast() {
  const toast = useAppStore((s) => s.toast);
  const dismissToast = useAppStore((s) => s.dismissToast);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(dismissToast, toast.kind === 'error' ? ERROR_DURATION_MS : INFO_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [toast, dismissToast]);

  if (!toast) return null;
  return (
    <div
      className={toast.kind === 'error' ? 'toast is-error' : 'toast'}
      role={toast.kind === 'error' ? 'alert' : 'status'}
      onClick={dismissToast}
    >
      {toast.message}
    </div>
  );
}
