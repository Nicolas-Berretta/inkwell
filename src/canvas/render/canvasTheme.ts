/** Colours used by canvas-drawn chrome (patterns, selection, cursors) per theme. */
import type { ThemeMode } from '../../types';
import { resolveInkColor } from '../math/colors';

export interface CanvasPalette {
  ruleLine: string;
  dot: string;
  selectionStroke: string;
  selectionFill: string;
  /** Fill of the resize handles on a selected image. */
  handleFill: string;
  eraserRing: string;
}

const PALETTES: Record<ThemeMode, CanvasPalette> = {
  light: {
    ruleLine: 'rgb(196, 208, 226)',
    dot: 'rgb(176, 180, 190)',
    selectionStroke: 'rgb(106, 79, 196)',
    selectionFill: 'rgba(106, 79, 196, 0.07)',
    handleFill: 'rgb(255, 255, 255)',
    eraserRing: 'rgba(40, 40, 46, 0.75)',
  },
  dark: {
    ruleLine: 'rgb(58, 66, 82)',
    dot: 'rgb(84, 87, 96)',
    selectionStroke: 'rgb(168, 148, 240)',
    selectionFill: 'rgba(168, 148, 240, 0.1)',
    handleFill: 'rgb(28, 28, 31)',
    eraserRing: 'rgba(236, 236, 240, 0.8)',
  },
};

export function canvasPalette(theme: ThemeMode): CanvasPalette {
  return PALETTES[theme];
}

const inkCache: Record<ThemeMode, Map<string, string>> = { light: new Map(), dark: new Map() };

/** Memoised render-time ink colour for the theme (stored colours are never mutated). */
export function inkColor(color: string, theme: ThemeMode): string {
  const cache = inkCache[theme];
  let resolved = cache.get(color);
  if (resolved === undefined) {
    resolved = resolveInkColor(color, theme);
    cache.set(color, resolved);
  }
  return resolved;
}
