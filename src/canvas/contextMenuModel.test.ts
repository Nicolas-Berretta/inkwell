import { describe, expect, it } from 'vitest';
import type { MenuEntry } from './contextMenuModel';
import { buildContextMenu, clampMenuPosition } from './contextMenuModel';

const enabled = (entries: MenuEntry[]) => entries.filter((entry) => !entry.disabled).map((entry) => entry.action);
const actions = (entries: MenuEntry[]) => entries.map((entry) => entry.action);

describe('canvas context menu', () => {
  it('offers only Paste and Insert image on the empty page, with the editing commands disabled', () => {
    const menu = buildContextMenu({ kind: 'canvas' });
    expect(actions(menu)).toEqual(['cut', 'copy', 'paste', 'duplicate', 'delete', 'insertImage']);
    expect(enabled(menu)).toEqual(['paste', 'insertImage']);
  });

  it('enables every editing command on a selection or a text box', () => {
    for (const target of [{ kind: 'selection' }, { kind: 'textBox' }] as const) {
      const menu = buildContextMenu(target);
      expect(enabled(menu)).toEqual(['cut', 'copy', 'paste', 'duplicate', 'delete', 'insertImage']);
      expect(actions(menu)).not.toContain('lock');
    }
  });

  it('adds locking and stacking commands on an image', () => {
    const menu = buildContextMenu({ kind: 'image', locked: false });
    expect(actions(menu)).toEqual([
      'cut',
      'copy',
      'paste',
      'duplicate',
      'delete',
      'insertImage',
      'lock',
      'bringToFront',
      'sendToBack',
    ]);
    expect(menu.every((entry) => !entry.disabled)).toBe(true);
  });

  it('protects a locked image: it can only be copied or unlocked', () => {
    const menu = buildContextMenu({ kind: 'image', locked: true });
    expect(actions(menu)).toContain('unlock');
    expect(actions(menu)).not.toContain('lock');
    expect(enabled(menu)).toEqual(['copy', 'paste', 'insertImage', 'unlock']);
  });

  it('marks Delete as destructive and groups the image commands', () => {
    const menu = buildContextMenu({ kind: 'image', locked: false });
    expect(menu.filter((entry) => entry.danger).map((entry) => entry.action)).toEqual(['delete']);
    expect(menu.filter((entry) => entry.startsGroup).map((entry) => entry.action)).toEqual(['insertImage', 'lock']);
  });
});

describe('menu placement', () => {
  it('opens at the pointer when there is room', () => {
    expect(clampMenuPosition(100, 120, 200, 300, 1400, 900)).toEqual({ left: 100, top: 120 });
  });

  it('moves in from the right and bottom edges so the whole menu is visible', () => {
    expect(clampMenuPosition(1390, 890, 200, 300, 1400, 900)).toEqual({ left: 1192, top: 592 });
  });

  it('never leaves the top-left corner, even in a viewport smaller than the menu', () => {
    expect(clampMenuPosition(-50, -50, 200, 300, 1400, 900)).toEqual({ left: 8, top: 8 });
    expect(clampMenuPosition(50, 50, 200, 300, 150, 200)).toEqual({ left: 8, top: 8 });
  });
});
