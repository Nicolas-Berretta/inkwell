import { Check, CircleAlert, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { writeQueue } from '../db/persistence';
import { useAppStore } from '../store/appStore';

/** A write normally takes a few milliseconds; "Saving…" is only shown when one takes noticeably longer. */
const SAVING_LABEL_DELAY_MS = 500;

/**
 * Quiet indicator of whether everything is stored. It only re-renders when the
 * save status changes (when an action ends), never while the pointer moves.
 */
export function SaveStatus() {
  const status = useAppStore((s) => s.saveStatus);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (status !== 'saving') {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), SAVING_LABEL_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [status]);

  if (status === 'error') {
    return (
      <button
        type="button"
        className="save-status is-error"
        data-status="error"
        title="Recent changes could not be saved to this browser. Click to try again."
        onClick={() => void writeQueue.retry()}
      >
        <CircleAlert size={14} />
        <span role="alert">Not saved. Retry</span>
      </button>
    );
  }
  const saving = status === 'saving' && slow;
  return (
    <span
      className="save-status"
      data-status={status}
      role="status"
      title={saving ? 'Saving your changes to this browser' : 'All changes are saved in this browser'}
    >
      {saving ? <LoaderCircle size={14} className="save-status-spinner" /> : <Check size={14} />}
      <span>{saving ? 'Saving…' : 'Saved'}</span>
    </span>
  );
}
