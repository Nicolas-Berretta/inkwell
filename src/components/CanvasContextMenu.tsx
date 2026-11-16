import {
  BringToFront,
  ClipboardPaste,
  Copy,
  CopyPlus,
  ImagePlus,
  Lock,
  LockOpen,
  Scissors,
  SendToBack,
  Trash2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ContextMenuRequest } from '../canvas/CanvasEngine';
import type { MenuAction } from '../canvas/contextMenuModel';
import { buildContextMenu, clampMenuPosition } from '../canvas/contextMenuModel';
import {
  copyTarget,
  cutTarget,
  deleteTarget,
  duplicateTarget,
  openImagePicker,
  pasteAt,
  restackImage,
  setImageLocked,
} from '../store/canvasActions';

const ICONS: Record<MenuAction, ReactNode> = {
  cut: <Scissors size={15} />,
  copy: <Copy size={15} />,
  paste: <ClipboardPaste size={15} />,
  duplicate: <CopyPlus size={15} />,
  delete: <Trash2 size={15} />,
  insertImage: <ImagePlus size={15} />,
  lock: <Lock size={15} />,
  unlock: <LockOpen size={15} />,
  bringToFront: <BringToFront size={15} />,
  sendToBack: <SendToBack size={15} />,
};

const SHORTCUTS: Partial<Record<MenuAction, string>> = {
  cut: 'X',
  copy: 'C',
  paste: 'V',
  duplicate: 'D',
};

const MODIFIER = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

interface CanvasContextMenuProps {
  request: ContextMenuRequest;
  onClose: () => void;
}

function run(action: MenuAction, request: ContextMenuRequest): void {
  const { target } = request;
  const at = { x: request.x, y: request.y };
  switch (action) {
    case 'cut':
      return cutTarget(target);
    case 'copy':
      return copyTarget(target);
    case 'paste':
      return void pasteAt(at);
    case 'duplicate':
      return duplicateTarget(target);
    case 'delete':
      return deleteTarget(target);
    case 'insertImage':
      return openImagePicker(at);
    case 'lock':
    case 'unlock':
      if (target.kind === 'image') setImageLocked(target.id, action === 'lock');
      return;
    case 'bringToFront':
    case 'sendToBack':
      if (target.kind === 'image') restackImage(target.id, action === 'bringToFront' ? 'front' : 'back');
      return;
  }
}

/**
 * Right-click menu of the canvas. It closes on Escape, on a click elsewhere,
 * when the page is scrolled or zoomed, and when the window is resized or
 * loses focus, and it is always placed fully inside the viewport.
 */
export function CanvasContextMenu({ request, onClose }: CanvasContextMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const entries = buildContextMenu(request.target);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    setPosition(clampMenuPosition(request.clientX, request.clientY, rect.width, rect.height, window.innerWidth, window.innerHeight));
  }, [request]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current || !(e.target instanceof Node) || rootRef.current.contains(e.target)) return;
      onClose();
      // Like a native menu, the click that dismisses it is not also a pen stroke or a selection.
      if (e.target instanceof Element && e.target.closest('.stage')) e.stopPropagation();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('wheel', onClose, { capture: true, passive: true });
    window.addEventListener('gesturestart', onClose, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('wheel', onClose, true);
      window.removeEventListener('gesturestart', onClose, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={rootRef}
      className="menu context-menu"
      role="menu"
      aria-label="Canvas actions"
      data-target={request.target.kind}
      // Rendered off-screen for one frame while its size is measured.
      style={position ? { left: position.left, top: position.top } : { left: 0, top: 0, visibility: 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
      // Keeps keyboard focus where it was, so shortcuts keep working after the menu closes.
      onMouseDown={(e) => e.preventDefault()}
    >
      {entries.map((entry) => (
        <div key={entry.action} className={entry.startsGroup ? 'context-menu-group' : undefined}>
          <button
            type="button"
            role="menuitem"
            className={entry.danger ? 'menu-item is-danger' : 'menu-item'}
            data-action={entry.action}
            disabled={entry.disabled}
            onClick={() => {
              onClose();
              run(entry.action, request);
            }}
          >
            {ICONS[entry.action]}
            <span>{entry.label}</span>
            {SHORTCUTS[entry.action] ? <kbd className="menu-shortcut">{MODIFIER + SHORTCUTS[entry.action]}</kbd> : null}
          </button>
        </div>
      ))}
    </div>
  );
}
