import { ChevronDown, Pipette } from 'lucide-react';
import type { CSSProperties } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import type { InkKind } from '../store/palette';
import { colorName, inlineColors, normalizeHexColor, paletteOf, sameColor } from '../store/palette';

interface SwatchProps {
  kind: InkKind;
  color: string;
  selected: boolean;
  onSelect: (color: string) => void;
}

/** One colour button. Black (and white) ink is shown the way it will be painted in the current theme. */
function Swatch({ kind, color, selected, onSelect }: SwatchProps) {
  const name = colorName(kind, color);
  const normalized = normalizeHexColor(color) ?? color;
  return (
    <button
      type="button"
      className={selected ? 'swatch is-active' : 'swatch'}
      data-ink={normalized === '#000000' ? 'adaptive' : normalized === '#ffffff' ? 'adaptive-light' : undefined}
      data-color={normalized}
      style={{ '--swatch': color } as CSSProperties}
      aria-label={name}
      aria-pressed={selected}
      title={name}
      onClick={() => onSelect(color)}
    />
  );
}

interface ColorPaletteProps {
  kind: InkKind;
  color: string;
  onColor: (color: string) => void;
}

/**
 * Inline favourite colours plus a "more colours" popover with the full palette,
 * recently used custom colours and a picker for any other colour. The selected
 * colour is always visible inline, even when it is a custom one.
 */
export function ColorPalette({ kind, color, onColor }: ColorPaletteProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  const recents = useAppStore((s) => s.recentColors[kind]);
  const rememberColor = useAppStore((s) => s.rememberColor);

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

  const choose = (next: string) => {
    onColor(next);
    rememberColor(kind, next);
  };

  // React reports every colour the system picker passes through as a change. Only the colour the
  // user settles on (the native `change` event, fired when the picker closes) is remembered.
  useEffect(() => {
    const picker = pickerRef.current;
    if (!open || !picker) return;
    const onCommit = () => {
      onColor(picker.value);
      rememberColor(kind, picker.value);
    };
    picker.addEventListener('change', onCommit);
    return () => picker.removeEventListener('change', onCommit);
  }, [open, kind, onColor, rememberColor]);

  return (
    <div className="color-palette" ref={rootRef}>
      {inlineColors(kind, color).map((c) => (
        <Swatch key={c} kind={kind} color={c} selected={sameColor(c, color)} onSelect={choose} />
      ))}
      <button
        type="button"
        className={open ? 'more-colors is-open' : 'more-colors'}
        aria-label="More colors"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="More colors"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDown size={14} />
      </button>
      {open ? (
        <div className="color-popover" role="dialog" aria-label={kind === 'pen' ? 'Pen colors' : 'Highlighter colors'}>
          <div className="color-grid" data-grid="presets">
            {paletteOf(kind).map((entry) => (
              <Swatch
                key={entry.color}
                kind={kind}
                color={entry.color}
                selected={sameColor(entry.color, color)}
                onSelect={(c) => {
                  choose(c);
                  setOpen(false);
                }}
              />
            ))}
          </div>
          <div className="color-popover-section">
            <span className="color-popover-label">Recent custom colors</span>
            {recents.length > 0 ? (
              <div className="color-grid" data-grid="recent">
                {recents.map((c) => (
                  <Swatch
                    key={c}
                    kind={kind}
                    color={c}
                    selected={sameColor(c, color)}
                    onSelect={(next) => {
                      choose(next);
                      setOpen(false);
                    }}
                  />
                ))}
              </div>
            ) : (
              <span className="color-popover-empty">None yet</span>
            )}
          </div>
          <label className="custom-color">
            <Pipette size={15} />
            <span>Custom color…</span>
            <input
              ref={pickerRef}
              type="color"
              aria-label="Custom color"
              data-custom-color
              value={normalizeHexColor(color) ?? '#000000'}
              // Live preview while the picker is open.
              onChange={(e) => onColor(e.currentTarget.value)}
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}
