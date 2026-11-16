/**
 * Render-time colour mapping. Stored stroke colours are never modified; the
 * theme only changes how they are painted, so "black" ink reads as white on a
 * dark page (and white as black), exactly like OneNote.
 */
import type { ThemeMode } from '../../types';

interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function parseHexColor(color: string): Rgb | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return null;
  let hex = match[1];
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  const value = parseInt(hex, 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

/** Relative luminance (0 = black, 1 = white) per WCAG. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function isNeutral({ r, g, b }: Rgb): boolean {
  return Math.max(r, g, b) - Math.min(r, g, b) <= 24;
}

const DARK_LIMIT = 0.05;
const LIGHT_LIMIT = 0.85;

/**
 * Maps an authored ink colour to the colour to paint for the given theme.
 * In dark mode near-black neutrals become white and near-white neutrals
 * become black; every other colour is left untouched.
 */
export function resolveInkColor(color: string, theme: ThemeMode): string {
  if (theme === 'light') return color;
  const rgb = parseHexColor(color);
  if (!rgb || !isNeutral(rgb)) return color;
  const luminance = relativeLuminance(rgb);
  if (luminance <= DARK_LIMIT) return '#ffffff';
  if (luminance >= LIGHT_LIMIT) return '#000000';
  return color;
}
