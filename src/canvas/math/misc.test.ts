import { describe, expect, it } from 'vitest';
import { firstMultipleAtOrAfter, linePositions, patternLod, patternSpec } from './backgroundPattern';
import { parseHexColor, resolveInkColor } from './colors';
import { HistoryStack } from './history';

describe('theme ink mapping', () => {
  it('leaves colours untouched in light mode', () => {
    expect(resolveInkColor('#000000', 'light')).toBe('#000000');
    expect(resolveInkColor('#ffffff', 'light')).toBe('#ffffff');
  });

  it('swaps black and white in dark mode', () => {
    expect(resolveInkColor('#000000', 'dark')).toBe('#ffffff');
    expect(resolveInkColor('#111', 'dark')).toBe('#ffffff');
    expect(resolveInkColor('#ffffff', 'dark')).toBe('#000000');
  });

  it('keeps saturated and mid-tone colours in dark mode', () => {
    expect(resolveInkColor('#e03131', 'dark')).toBe('#e03131');
    expect(resolveInkColor('#00008b', 'dark')).toBe('#00008b');
    expect(resolveInkColor('#808080', 'dark')).toBe('#808080');
    expect(resolveInkColor('not-a-colour', 'dark')).toBe('not-a-colour');
  });

  it('parses short and long hex notation', () => {
    expect(parseHexColor('#fa0')).toEqual({ r: 255, g: 170, b: 0 });
    expect(parseHexColor('1971c2')).toEqual({ r: 25, g: 113, b: 194 });
    expect(parseHexColor('rgb(0,0,0)')).toBeNull();
  });
});

describe('HistoryStack', () => {
  it('undoes and redoes in order', () => {
    const history = new HistoryStack<string>();
    history.push('a');
    history.push('b');
    expect(history.undo()).toBe('b');
    expect(history.undo()).toBe('a');
    expect(history.undo()).toBeUndefined();
    expect(history.redo()).toBe('a');
    expect(history.redo()).toBe('b');
    expect(history.canRedo).toBe(false);
  });

  it('drops redo history when a new action is recorded', () => {
    const history = new HistoryStack<string>();
    history.push('a');
    history.push('b');
    history.undo();
    history.push('c');
    expect(history.canRedo).toBe(false);
    expect(history.undo()).toBe('c');
    expect(history.undo()).toBe('a');
  });

  it('forgets the oldest entries beyond its limit', () => {
    const history = new HistoryStack<number>(3);
    for (let i = 1; i <= 5; i++) history.push(i);
    expect([history.undo(), history.undo(), history.undo(), history.undo()]).toEqual([5, 4, 3, undefined]);
  });
});

describe('background pattern level of detail', () => {
  it('draws every line when there is room', () => {
    expect(patternLod(32, 1, 7)).toEqual({ stride: 1, alpha: 1 });
  });

  it('thins the pattern in powers of two when zoomed out and never goes below the minimum gap', () => {
    for (const zoom of [0.5, 0.2, 0.1, 0.03]) {
      const lod = patternLod(24, zoom, 7);
      expect(Math.log2(lod.stride) % 1).toBe(0);
      expect(24 * lod.stride * zoom).toBeGreaterThanOrEqual(7);
      expect(lod.alpha).toBeGreaterThan(0);
      expect(lod.alpha).toBeLessThanOrEqual(1);
    }
    expect(patternLod(24, 0.1, 7).stride).toBeGreaterThan(patternLod(24, 0.5, 7).stride);
  });

  it('fades marks that are close to the density limit', () => {
    expect(patternLod(24, 0.3, 7).alpha).toBeLessThan(patternLod(24, 0.55, 7).alpha);
  });

  it('describes each page background', () => {
    expect(patternSpec('blank')).toBeNull();
    expect(patternSpec('ruled')).toEqual({ kind: 'lines', spacing: 32 });
    expect(patternSpec('college')?.spacing).toBeLessThan(32);
    expect(patternSpec('dots')?.kind).toBe('dots');
    // The square grid shares the dot grid's spacing, so switching between them keeps the rhythm.
    expect(patternSpec('grid')).toEqual({ kind: 'grid', spacing: patternSpec('dots')?.spacing });
  });

  it('places grid lines on whole device pixels at world multiples of the step', () => {
    // 24 world units at scale 2 (device px per world unit), camera at the origin, 100 px canvas.
    expect(linePositions(0, 100, 2, 24)).toEqual([0, 48, 96]);
    // Fractional zoom and device pixel ratio: still whole pixels, so lines stay crisp.
    for (const position of linePositions(137, 900, 1.37 * 1.5, 24)) {
      expect(Number.isInteger(position)).toBe(true);
      expect(position).toBeGreaterThanOrEqual(-1);
      expect(position).toBeLessThanOrEqual(901);
    }
  });

  it('pans grid lines exactly with the camera and never runs out of them', () => {
    const scale = 2;
    const step = 24;
    // Panning by 10 device pixels shifts every line by 10 pixels.
    expect(linePositions(10, 100, scale, step)).toEqual([38, 86]);
    // Panning by exactly one step reproduces the same picture: the pattern is periodic and infinite.
    expect(linePositions(step * scale, 100, scale, step)).toEqual(linePositions(0, 100, scale, step));
    expect(linePositions(-1e7 * step * scale, 100, scale, step)).toEqual(linePositions(0, 100, scale, step));
    // Negative world coordinates work the same way.
    expect(linePositions(-20, 100, scale, step)).toEqual([20, 68]);
  });

  it('spaces grid lines evenly, proportionally to zoom', () => {
    const at1 = linePositions(0, 400, 1, 24);
    const at2 = linePositions(0, 400, 2, 24);
    expect(at1[1] - at1[0]).toBe(24);
    expect(at2[1] - at2[0]).toBe(48);
  });

  it('finds the first grid line inside the viewport', () => {
    expect(firstMultipleAtOrAfter(50, 32)).toBe(64);
    expect(firstMultipleAtOrAfter(-50, 32)).toBe(-32);
    expect(firstMultipleAtOrAfter(64, 32)).toBe(64);
  });
});
