import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/appStore';

/** Modal confirmation used for every destructive action. */
export function ConfirmDialog() {
  const request = useAppStore((s) => s.confirmRequest);
  const resolveConfirm = useAppStore((s) => s.resolveConfirm);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!request) return;
    cancelRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        resolveConfirm(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [request, resolveConfirm]);

  if (!request) return null;

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && resolveConfirm(false)}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message">
        <h2 id="confirm-title">{request.title}</h2>
        <p id="confirm-message">{request.message}</p>
        <div className="dialog-actions">
          <button type="button" className="button" ref={cancelRef} onClick={() => resolveConfirm(false)}>
            Cancel
          </button>
          <button
            type="button"
            className={request.danger ? 'button is-danger' : 'button is-primary'}
            onClick={() => resolveConfirm(true)}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
