import { MoreHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

export interface RowMenuItem {
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

interface RowMenuProps {
  label: string;
  items: RowMenuItem[];
}

/** Small "more actions" popover used by notebook, section and page rows. */
export function RowMenu({ label, items }: RowMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className={open ? 'row-menu is-open' : 'row-menu'} ref={rootRef} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="icon-button row-menu-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={15} />
      </button>
      {open ? (
        <div className="menu" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={item.danger ? 'menu-item is-danger' : 'menu-item'}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
