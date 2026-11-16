import { describe, expect, it } from 'vitest';
import { fractionInsidePolygon, lassoSelectsStroke, strokeContainsPoint, strokeTouchesCapsule } from './hitTest';

const horizontal = [0, 0, 4, 50, 0, 4, 100, 0, 4];
const dot = [10, 10, 6];

describe('eraser hit testing', () => {
  it('hits a stroke the eraser path crosses', () => {
    expect(strokeTouchesCapsule(horizontal, 30, -20, 30, 20, 1)).toBe(true);
  });

  it('accounts for the eraser radius and the stroke width', () => {
    // Stroke half-width 2 + eraser radius 5 reaches 7 units from the centreline.
    expect(strokeTouchesCapsule(horizontal, 20, 6.5, 40, 6.5, 5)).toBe(true);
    expect(strokeTouchesCapsule(horizontal, 20, 7.5, 40, 7.5, 5)).toBe(false);
  });

  it('misses strokes beyond either end', () => {
    expect(strokeTouchesCapsule(horizontal, 110, -5, 110, 5, 3)).toBe(false);
  });

  it('handles single-point strokes', () => {
    expect(strokeTouchesCapsule(dot, 0, 10, 6, 10, 1.5)).toBe(true);
    expect(strokeTouchesCapsule(dot, 0, 10, 4, 10, 1.5)).toBe(false);
    expect(strokeContainsPoint(dot, 12, 10, 0)).toBe(true);
    expect(strokeContainsPoint([], 0, 0, 100)).toBe(false);
  });
});

describe('lasso selection', () => {
  const lasso = [-10, -10, 60, -10, 60, 10, -10, 10];

  it('measures how much of a stroke is enclosed', () => {
    expect(fractionInsidePolygon(horizontal, lasso)).toBeCloseTo(2 / 3);
    expect(fractionInsidePolygon(dot, lasso)).toBe(0);
  });

  it('selects strokes that are mostly inside and ignores the rest', () => {
    expect(lassoSelectsStroke(horizontal, lasso)).toBe(true);
    expect(lassoSelectsStroke([0, 0, 4, 200, 0, 4, 300, 0, 4], lasso)).toBe(false);
    expect(lassoSelectsStroke([], lasso)).toBe(false);
  });
});
