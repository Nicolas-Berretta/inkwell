/**
 * Ink colour palettes and the bookkeeping for custom colours. Pure and
 * DOM-free.
 *
 * Each tool shows a few favourites inline in the toolbar and the full palette
 * in a popover, where any other colour can be picked as well. Custom colours
 * that were used are remembered per tool, most recent first.
 */
import { parseHexColor } from '../canvas/math/colors';

export interface PaletteColor {
  color: string;
  name: string;
}

export type InkKind = 'pen' | 'highlighter';

/** Pen colours shown inline in the toolbar. */
export const PEN_FAVORITES: readonly string[] = ['#000000', '#e03131', '#1971c2', '#2f9e44', '#f08c00', '#7048e8'];

/** Full pen palette: neutrals first, then the hues in spectrum order. */
export const PEN_PALETTE: readonly PaletteColor[] = [
  { color: '#000000', name: 'Black' },
  { color: '#495057', name: 'Dark gray' },
  { color: '#868e96', name: 'Gray' },
  { color: '#ced4da', name: 'Light gray' },
  { color: '#ffffff', name: 'White' },
  { color: '#7f4f24', name: 'Brown' },
  { color: '#a61e1e', name: 'Dark red' },
  { color: '#e03131', name: 'Red' },
  { color: '#f76707', name: 'Vermilion' },
  { color: '#f08c00', name: 'Orange' },
  { color: '#fab005', name: 'Yellow' },
  { color: '#74b816', name: 'Lime' },
  { color: '#2f9e44', name: 'Green' },
  { color: '#087f5b', name: 'Dark green' },
  { color: '#0ca678', name: 'Teal' },
  { color: '#1098ad', name: 'Cyan' },
  { color: '#4dabf7', name: 'Light blue' },
  { color: '#1971c2', name: 'Blue' },
  { color: '#1c3f94', name: 'Navy' },
  { color: '#4c5fd5', name: 'Indigo' },
  { color: '#7048e8', name: 'Purple' },
  { color: '#9c36b5', name: 'Grape' },
  { color: '#c2255c', name: 'Magenta' },
  { color: '#f06595', name: 'Pink' },
];

/** Highlighter colours shown inline in the toolbar. */
export const HIGHLIGHTER_FAVORITES: readonly string[] = ['#ffe45c', '#9cf08f', '#ffa8cf', '#8fd6ff', '#ffc078'];

/** Full highlighter palette: light, saturated tints that keep text readable underneath. */
export const HIGHLIGHTER_PALETTE: readonly PaletteColor[] = [
  { color: '#ffe45c', name: 'Yellow' },
  { color: '#d4f05c', name: 'Lime' },
  { color: '#9cf08f', name: 'Green' },
  { color: '#86ecd0', name: 'Mint' },
  { color: '#8fd6ff', name: 'Blue' },
  { color: '#a9b9ff', name: 'Periwinkle' },
  { color: '#cfa8ff', name: 'Lavender' },
  { color: '#ffa8cf', name: 'Pink' },
  { color: '#ffa39e', name: 'Coral' },
  { color: '#ffc078', name: 'Orange' },
  { color: '#e6cf9c', name: 'Sand' },
  { color: '#cfd4da', name: 'Gray' },
];

export function paletteOf(kind: InkKind): readonly PaletteColor[] {
  return kind === 'pen' ? PEN_PALETTE : HIGHLIGHTER_PALETTE;
}

export function favoritesOf(kind: InkKind): readonly string[] {
  return kind === 'pen' ? PEN_FAVORITES : HIGHLIGHTER_FAVORITES;
}

/** How many custom colours are remembered per tool. */
export const MAX_RECENT_COLORS = 8;

/** Normalises a colour to lowercase `#rrggbb`; null when it is not a hex colour. */
export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const rgb = parseHexColor(value);
  if (!rgb) return null;
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(rgb.r)}${hex(rgb.g)}${hex(rgb.b)}`;
}

export function sameColor(a: string, b: string): boolean {
  const left = normalizeHexColor(a);
  return left !== null && left === normalizeHexColor(b);
}

export function isPresetColor(kind: InkKind, color: string): boolean {
  return paletteOf(kind).some((entry) => sameColor(entry.color, color));
}

/** Name of a colour for labels and tooltips: the preset's name, or the hex code of a custom colour. */
export function colorName(kind: InkKind, color: string): string {
  const preset = paletteOf(kind).find((entry) => sameColor(entry.color, color));
  return preset ? preset.name : `Custom ${normalizeHexColor(color) ?? color}`;
}

/**
 * Colours shown inline in the toolbar: the favourites, plus the selected
 * colour when it is not one of them, so the selection is always visible.
 */
export function inlineColors(kind: InkKind, selected: string): string[] {
  const favorites = [...favoritesOf(kind)];
  return favorites.some((color) => sameColor(color, selected)) ? favorites : [...favorites, selected];
}

/**
 * Remembers a custom colour that was used: most recent first, no duplicates,
 * capped at `MAX_RECENT_COLORS`. Preset colours are not recorded (they are
 * always available) and invalid colours are ignored.
 */
export function addRecentColor(recents: readonly string[], kind: InkKind, color: string): string[] {
  const normalized = normalizeHexColor(color);
  if (!normalized || isPresetColor(kind, normalized)) return [...recents];
  return [normalized, ...recents.filter((recent) => !sameColor(recent, normalized))].slice(0, MAX_RECENT_COLORS);
}

export interface RecentColors {
  pen: string[];
  highlighter: string[];
}

/** Reads the persisted recent colours, tolerating anything stored by an older or damaged setting. */
export function readRecentColors(value: unknown): RecentColors {
  const list = (raw: unknown): string[] => {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const entry of raw) {
      const color = normalizeHexColor(entry);
      if (color && !out.includes(color)) out.push(color);
    }
    return out.slice(0, MAX_RECENT_COLORS);
  };
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  return { pen: list(record.pen), highlighter: list(record.highlighter) };
}
