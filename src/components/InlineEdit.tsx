import { useEffect, useRef, useState } from 'react';

interface InlineEditProps {
  value: string;
  ariaLabel: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

/** Text input used for in-place renaming: Enter or blur commits, Escape cancels. */
export function InlineEdit({ value, ariaLabel, onCommit, onCancel }: InlineEditProps) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const finish = (commit: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (commit && draft.trim() && draft !== value) onCommit(draft);
    else onCancel();
  };

  return (
    <input
      ref={inputRef}
      className="inline-edit"
      aria-label={ariaLabel}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(true)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
      }}
    />
  );
}
