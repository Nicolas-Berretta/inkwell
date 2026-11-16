/**
 * Level-of-detail math for page background patterns (ruled lines, dot grid, square grid).
 * When zoomed out, lines would crowd into noise, so the pattern is thinned
 * out (every 2nd, 4th, 8th... line) and faded as it approaches the density
 * limit. Pure math; the canvas drawing lives in `render/backgroundRenderer.ts`.
 */
import type { PageBackground } from '../../types';

export interface PatternSpec {
  /** `lines` are horizontal rules, `grid` adds matching vertical rules, `dots` marks the intersections. */
  kind: 'lines' | 'dots' | 'grid';
  /** Distance between lines / dots in world units. */
  spacing: number;
}

export function patternSpec(background: PageBackground): PatternSpec | null {
  switch (background) {
    case 'ruled':
      return { kind: 'lines', spacing: 32 };
    case 'college':
      return { kind: 'lines', spacing: 24 };
    case 'dots':
      return { kind: 'dots', spacing: 24 };
    case 'grid':
      return { kind: 'grid', spacing: 24 };
    case 'blank':
      return null;
  }
}

export interface PatternLod {
  /** Draw every `stride`-th line/dot (always a power of two, so coarse levels stay aligned). */
  stride: number;
  /** Opacity multiplier in (0, 1]. */
  alpha: number;
}

/**
 * Chooses how much of the pattern to draw so that neighbouring marks are at
 * least `minScreenGap` pixels apart, fading each level in as it gains room.
 */
export function patternLod(spacing: number, zoom: number, minScreenGap: number): PatternLod {
  let stride = 1;
  while (spacing * stride * zoom < minScreenGap && stride < 1 << 20) stride *= 2;
  const gap = spacing * stride * zoom;
  // Fully opaque once marks are twice the minimum gap apart; 40% at the limit.
  const t = Math.min(1, Math.max(0, (gap - minScreenGap) / minScreenGap));
  return { stride, alpha: 0.4 + 0.6 * t };
}

/** First multiple of `step` that is >= `value`. */
export function firstMultipleAtOrAfter(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

/**
 * Device-pixel positions, relative to the canvas edge, of every pattern line
 * that crosses a canvas of `sizePx` pixels along one axis. `offsetPx` is the
 * camera translation in device pixels and `scale` is device pixels per world
 * unit. Positions are whole pixels so lines stay crisp, and they are derived
 * from world multiples of `step`, so the pattern is infinite and pans exactly
 * with the page.
 */
export function linePositions(offsetPx: number, sizePx: number, scale: number, step: number): number[] {
  const first = Math.ceil(offsetPx / scale / step);
  const last = Math.floor((offsetPx + sizePx) / scale / step);
  const out: number[] = [];
  for (let k = first; k <= last; k++) out.push(Math.round(k * step * scale) - offsetPx);
  return out;
}
