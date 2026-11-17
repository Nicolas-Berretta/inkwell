import { Eraser, Hand, Highlighter, ImagePlus, Lasso, PenLine, Redo2, SquareDashed, Type, Undo2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { HIGHLIGHTER_SIZES, PEN_SIZES, useAppStore } from '../store/appStore';
import { openImagePicker } from '../store/canvasActions';
import { getActiveEngine } from '../store/engineRegistry';
import type { LassoMode, ToolId } from '../types';
import { ColorPalette } from './ColorPalette';

const TOOLS: ReadonlyArray<{ id: ToolId; label: string; shortcut: string; icon: ReactNode }> = [
  { id: 'pen', label: 'Pen', shortcut: 'P', icon: <PenLine size={18} /> },
  { id: 'highlighter', label: 'Highlighter', shortcut: 'H', icon: <Highlighter size={18} /> },
  { id: 'eraser', label: 'Eraser', shortcut: 'E', icon: <Eraser size={18} /> },
  { id: 'lasso', label: 'Lasso select', shortcut: 'L', icon: <Lasso size={18} /> },
  { id: 'text', label: 'Text', shortcut: 'T', icon: <Type size={18} /> },
  { id: 'pan', label: 'Pan', shortcut: 'V', icon: <Hand size={18} /> },
];

interface ToolOptionsProps {
  sizes: readonly number[];
  color: string;
  size: number;
  onColor: (color: string) => void;
  onSize: (size: number) => void;
  kind: 'pen' | 'highlighter';
}

function ToolOptions({ sizes, color, size, onColor, onSize, kind }: ToolOptionsProps) {
  const largest = sizes[sizes.length - 1];
  return (
    <div className="tool-options" role="group" aria-label={kind === 'pen' ? 'Pen options' : 'Highlighter options'}>
      <ColorPalette kind={kind} color={color} onColor={onColor} />
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

const LASSO_MODES: ReadonlyArray<{ mode: LassoMode; label: string; icon: ReactNode }> = [
  { mode: 'freeform', label: 'Freeform lasso', icon: <Lasso size={17} /> },
  { mode: 'rectangle', label: 'Rectangle selection', icon: <SquareDashed size={17} /> },
];

/** Freeform / rectangle toggle shown while the Lasso tool is active. */
function LassoOptions({ mode, onMode }: { mode: LassoMode; onMode: (mode: LassoMode) => void }) {
  return (
    <div className="tool-options" role="group" aria-label="Lasso options">
      {LASSO_MODES.map((option) => (
        <button
          key={option.mode}
          type="button"
          className={option.mode === mode ? 'size-option lasso-mode is-active' : 'size-option lasso-mode'}
          aria-label={option.label}
          aria-pressed={option.mode === mode}
          title={option.label}
          data-lasso-mode={option.mode}
          onClick={() => onMode(option.mode)}
        >
          {option.icon}
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
          sizes={HIGHLIGHTER_SIZES}
          color={tools.highlighterColor}
          size={tools.highlighterSize}
          onColor={(highlighterColor) => updateTools({ highlighterColor })}
          onSize={(highlighterSize) => updateTools({ highlighterSize })}
        />
      ) : null}
      {tools.tool === 'lasso' ? <LassoOptions mode={tools.lassoMode} onMode={(lassoMode) => updateTools({ lassoMode })} /> : null}
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