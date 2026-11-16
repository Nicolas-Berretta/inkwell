import { Eraser, Hand, Highlighter, ImagePlus, Lasso, PenLine, Redo2, Type, Undo2 } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { HIGHLIGHTER_COLORS, HIGHLIGHTER_SIZES, PEN_COLORS, PEN_SIZES, useAppStore } from '../store/appStore';
import { openImagePicker } from '../store/canvasActions';
import { getActiveEngine } from '../store/engineRegistry';
import type { ToolId } from '../types';

const TOOLS: ReadonlyArray<{ id: ToolId; label: string; shortcut: string; icon: ReactNode }> = [
  { id: 'pen', label: 'Pen', shortcut: 'P', icon: <PenLine size={18} /> },
  { id: 'highlighter', label: 'Highlighter', shortcut: 'H', icon: <Highlighter size={18} /> },
  { id: 'eraser', label: 'Eraser', shortcut: 'E', icon: <Eraser size={18} /> },
  { id: 'lasso', label: 'Lasso select', shortcut: 'L', icon: <Lasso size={18} /> },
  { id: 'text', label: 'Text', shortcut: 'T', icon: <Type size={18} /> },
  { id: 'pan', label: 'Pan', shortcut: 'V', icon: <Hand size={18} /> },
];

const COLOR_NAMES: Record<string, string> = {
  '#000000': 'Black',
  '#e03131': 'Red',
  '#1971c2': 'Blue',
  '#2f9e44': 'Green',
  '#f08c00': 'Orange',
  '#7048e8': 'Purple',
  '#ffe45c': 'Yellow',
  '#9cf08f': 'Green',
  '#ffa8cf': 'Pink',
  '#8fd6ff': 'Blue',
  '#ffc078': 'Orange',
};

interface ToolOptionsProps {
  colors: readonly string[];
  sizes: readonly number[];
  color: string;
  size: number;
  onColor: (color: string) => void;
  onSize: (size: number) => void;
  kind: 'pen' | 'highlighter';
}

function ToolOptions({ colors, sizes, color, size, onColor, onSize, kind }: ToolOptionsProps) {
  const largest = sizes[sizes.length - 1];
  return (
    <div className="tool-options" role="group" aria-label={kind === 'pen' ? 'Pen options' : 'Highlighter options'}>
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          className={c === color ? 'swatch is-active' : 'swatch'}
          data-ink={c === '#000000' ? 'adaptive' : undefined}
          style={{ '--swatch': c } as CSSProperties}
          aria-label={COLOR_NAMES[c] ?? c}
          aria-pressed={c === color}
          title={COLOR_NAMES[c] ?? c}
          onClick={() => onColor(c)}
        />
      ))}
      <span className="toolbar-divider" />
      {sizes.map((s) => (
        <button
          key={s}
          type="button"
          className={s === size ? 'size-option is-active' : 'size-option'}
          aria-label={`Thickness ${s}`}
          aria-pressed={s === size}
          title={`Thickness ${s}`}
          onClick={() => onSize(s)}
        >
          <span className="size-dot" style={{ width: 4 + (s / largest) * 12, height: 4 + (s / largest) * 12 }} />
        </button>
      ))}
    </div>
  );
}

/** Floating tool palette. Buttons never take keyboard focus, so canvas shortcuts keep working. */
export function Toolbar() {
  const tools = useAppStore((s) => s.tools);
  const canUndo = useAppStore((s) => s.canUndo);
  const canRedo = useAppStore((s) => s.canRedo);
  const setTool = useAppStore((s) => s.setTool);
  const updateTools = useAppStore((s) => s.updateTools);

  return (
    <div className="toolbar-dock" onMouseDown={(e) => e.preventDefault()}>
      {tools.tool === 'pen' ? (
        <ToolOptions
          kind="pen"
          colors={PEN_COLORS}
          sizes={PEN_SIZES}
          color={tools.penColor}
          size={tools.penSize}
          onColor={(penColor) => updateTools({ penColor })}
          onSize={(penSize) => updateTools({ penSize })}
        />
      ) : null}
      {tools.tool === 'highlighter' ? (
        <ToolOptions
          kind="highlighter"
          colors={HIGHLIGHTER_COLORS}
          sizes={HIGHLIGHTER_SIZES}
          color={tools.highlighterColor}
          size={tools.highlighterSize}
          onColor={(highlighterColor) => updateTools({ highlighterColor })}
          onSize={(highlighterSize) => updateTools({ highlighterSize })}
        />
      ) : null}
      <div className="toolbar" role="toolbar" aria-label="Drawing tools">
        {TOOLS.map((tool) => (
          <button
            key={tool.id}
            type="button"
            className={tools.tool === tool.id ? 'tool-button is-active' : 'tool-button'}
            aria-label={tool.label}
            aria-pressed={tools.tool === tool.id}
            title={`${tool.label} (${tool.shortcut})`}
            data-tool={tool.id}
            onClick={() => setTool(tool.id)}
          >
            {tool.icon}
          </button>
        ))}
        <span className="toolbar-divider" />
        <button
          type="button"
          className="tool-button"
          aria-label="Insert image"
          title="Insert image"
          onClick={() => openImagePicker()}
        >
          <ImagePlus size={18} />
        </button>
        <span className="toolbar-divider" />
        <button
          type="button"
          className="tool-button"
          aria-label="Undo"
          title="Undo (Ctrl/Cmd+Z)"
          disabled={!canUndo}
          onClick={() => getActiveEngine()?.undo()}
        >
          <Undo2 size={18} />
        </button>
        <button
          type="button"
          className="tool-button"
          aria-label="Redo"
          title="Redo (Shift+Ctrl/Cmd+Z)"
          disabled={!canRedo}
          onClick={() => getActiveEngine()?.redo()}
        >
          <Redo2 size={18} />
        </button>
      </div>
    </div>
  );
}
