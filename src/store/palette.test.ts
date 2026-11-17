import { describe, expect, it } from 'vitest';
import { parseHexColor, relativeLuminance, resolveInkColor } from '../canvas/math/colors';
import {
  HIGHLIGHTER_FAVORITES,
  HIGHLIGHTER_PALETTE,
  MAX_RECENT_COLORS,
  PEN_FAVORITES,
  PEN_PALETTE,
  addRecentColor,
  colorName,
  inlineColors,
  isPresetColor,
  normalizeHexColor,
  readRecentColors,
} from './palette';

describe('palettes', () => {
  it('offers clearly more colours than the inline favourites, without duplicates', () => {
    for (const [palette, favorites] of [
      [PEN_PALETTE, PEN_FAVORITES],
      [HIGHLIGHTER_PALETTE, HIGHLIGHTER_FAVORITES],
    ] as const) {
      const colors = palette.map((entry) => entry.color);
      expect(new Set(colors).size).toBe(colors.length);
      expect(colors.length).toBeGreaterThanOrEqual(favorites.length * 2);
      // Every favourite is part of the full palette and every colour is a normalised hex code.
      for (const favorite of favorites) expect(colors).toContain(favorite);
      for (const color of colors) expect(normalizeHexColor(color)).toBe(color);
      for (const entry of palette) expect(entry.name.length).toBeGreaterThan(0);
    }
  });

  it('keeps the colours that existing notes and saved settings already use', () => {
    for (const color of ['#000000', '#e03131', '#1971c2', '#2f9e44', '#f08c00', '#7048e8']) expect(PEN_FAVORITES).toContain(color);
    for (const color of ['#ffe45c', '#9cf08f', '#ffa8cf', '#8fd6ff', '#ffc078']) expect(HIGHLIGHTER_FAVORITES).toContain(color);
  });

  it('only swaps black and white in dark mode; every other preset is painted as chosen', () => {
    for (const { color } of [...PEN_PALETTE, ...HIGHLIGHTER_PALETTE]) {
      const painted = resolveInkColor(color, 'dark');
      if (color === '#000000') expect(painted).toBe('#ffffff');
      else if (color === '#ffffff') expect(painted).toBe('#000000');
      else expect(painted).toBe(color);
    }
  });

  it('keeps highlighter presets light enough to read text through', () => {
    for (const { color } of HIGHLIGHTER_PALETTE) {
      const rgb = parseHexColor(color);
      expect(rgb).not.toBeNull();
      expect(relativeLuminance(rgb!)).toBeGreaterThan(0.45);
    }
  });
});

describe('colour helpers', () => {
  it('normalises hex colours and rejects everything else', () => {
    expect(normalizeHexColor('#ABCDEF')).toBe('#abcdef');
    expect(normalizeHexColor('#0f8')).toBe('#00ff88');
    expect(normalizeHexColor('  #123456 ')).toBe('#123456');
    expect(normalizeHexColor('red')).toBeNull();
    expect(normalizeHexColor('#12345')).toBeNull();
    expect(normalizeHexColor(42)).toBeNull();
  });

  it('names presets and labels custom colours by their code', () => {
    expect(colorName('pen', '#E03131')).toBe('Red');
    expect(colorName('highlighter', '#ffe45c')).toBe('Yellow');
    expect(colorName('pen', '#123456')).toBe('Custom #123456');
    expect(isPresetColor('pen', '#ffe45c')).toBe(false);
    expect(isPresetColor('highlighter', '#FFE45C')).toBe(true);
  });

  it('always shows the selected colour inline, even when it is not a favourite', () => {
    expect(inlineColors('pen', '#e03131')).toEqual([...PEN_FAVORITES]);
    expect(inlineColors('pen', '#E03131')).toEqual([...PEN_FAVORITES]);
    expect(inlineColors('pen', '#0ca678')).toEqual([...PEN_FAVORITES, '#0ca678']);
    expect(inlineColors('highlighter', '#123456')).toEqual([...HIGHLIGHTER_FAVORITES, '#123456']);
  });
});

describe('recent custom colours', () => {
  it('puts the newest first and moves a reused colour back to the front', () => {
    let recents = addRecentColor([], 'pen', '#111111');
    recents = addRecentColor(recents, 'pen', '#222222');
    recents = addRecentColor(recents, 'pen', '#333333');
    expect(recents).toEqual(['#333333', '#222222', '#111111']);
    expect(addRecentColor(recents, 'pen', '#111111')).toEqual(['#111111', '#333333', '#222222']);
    expect(addRecentColor(recents, 'pen', '#222222'.toUpperCase())).toEqual(['#222222', '#333333', '#111111']);
  });

  it('does not record presets or invalid colours', () => {
    expect(addRecentColor(['#111111'], 'pen', '#e03131')).toEqual(['#111111']);
    expect(addRecentColor(['#111111'], 'pen', 'tomato')).toEqual(['#111111']);
    // A pen preset is a custom colour for the highlighter.
    expect(addRecentColor([], 'highlighter', '#e03131')).toEqual(['#e03131']);
  });

  it('keeps a limited number', () => {
    let recents: string[] = [];
    for (let i = 0; i < MAX_RECENT_COLORS + 5; i++) recents = addRecentColor(recents, 'pen', `#0000${(i + 16).toString(16)}`);
    expect(recents).toHaveLength(MAX_RECENT_COLORS);
    expect(recents[0]).toBe(`#0000${(MAX_RECENT_COLORS + 4 + 16).toString(16)}`);
  });

  it('loads saved recents and survives missing or damaged settings', () => {
    expect(readRecentColors({ pen: ['#ABCDEF', '#abcdef', 'nope', 7], highlighter: ['#010203'] })).toEqual({
      pen: ['#abcdef'],
      highlighter: ['#010203'],
    });
    // Settings saved before custom colours existed have no such entry.
    expect(readRecentColors(undefined)).toEqual({ pen: [], highlighter: [] });
    expect(readRecentColors('oops')).toEqual({ pen: [], highlighter: [] });
    expect(readRecentColors({ pen: 'oops' })).toEqual({ pen: [], highlighter: [] });
  });
});
