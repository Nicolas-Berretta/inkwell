/**
 * What the canvas context menu offers for the thing under the pointer, and
 * where the menu is placed. Pure and DOM-free; `components/CanvasContextMenu`
 * renders it.
 */

export type MenuTargetKind =
  | { kind: 'canvas' }
  /** The current lasso selection (strokes and / or unlocked images). */
  | { kind: 'selection' }
  | { kind: 'image'; locked: boolean }
  | { kind: 'textBox' };

export type MenuAction =
  | 'cut'
  | 'copy'
  | 'paste'
  | 'duplicate'
  | 'delete'
  | 'insertImage'
  | 'lock'
  | 'unlock'
  | 'bringToFront'
  | 'sendToBack';

export interface MenuEntry {
  action: MenuAction;
  label: string;
  disabled: boolean;
  danger: boolean;
  /** Starts a new group (drawn with a divider above it). */
  startsGroup: boolean;
}

/**
 * Builds the menu. The editing commands are always listed and disabled when
 * they do not apply, so the menu keeps the same shape everywhere. A locked
 * image can only be copied or unlocked.
 */
export function buildContextMenu(target: MenuTargetKind): MenuEntry[] {
  const onObject = target.kind !== 'canvas';
  const locked = target.kind === 'image' && target.locked;
  const entry = (action: MenuAction, label: string, disabled: boolean, extra: Partial<MenuEntry> = {}): MenuEntry => ({
    action,
    label,
    disabled,
    danger: false,
    startsGroup: false,
    ...extra,
  });
  const entries: MenuEntry[] = [
    entry('cut', 'Cut', !onObject || locked),
    entry('copy', 'Copy', !onObject),
    entry('paste', 'Paste', false),
    entry('duplicate', 'Duplicate', !onObject || locked),
    entry('delete', 'Delete', !onObject || locked, { danger: true }),
    entry('insertImage', 'Insert image…', false, { startsGroup: true }),
  ];
  if (target.kind === 'image') {
    entries.push(
      entry(locked ? 'unlock' : 'lock', locked ? 'Unlock' : 'Lock', false, { startsGroup: true }),
      entry('bringToFront', 'Bring to front', locked),
      entry('sendToBack', 'Send to back', locked),
    );
  }
  return entries;
}

/**
 * Top-left position for a menu of the given size opened at a point, moved as
 * needed so the whole menu stays inside the viewport with a small margin.
 */
export function clampMenuPosition(
  x: number,
  y: number,
  menuWidth: number,
  menuHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 8,
): { left: number; top: number } {
  const maxLeft = viewportWidth - menuWidth - margin;
  const maxTop = viewportHeight - menuHeight - margin;
  return {
    left: Math.max(margin, Math.min(x, maxLeft)),
    top: Math.max(margin, Math.min(y, maxTop)),
  };
}
