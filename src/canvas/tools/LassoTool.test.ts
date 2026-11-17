import { describe, expect, it } from 'vitest';
import { LASSO_COVERAGE, lassoSelectsStroke } from '../math/hitTest';
import { boxCoverage } from '../math/imageGeometry';
import { rectanglePolygon } from './LassoTool';

describe('rectangle selection', () => {
  it('spans the two drag points in any direction', () => {
    const expected = [10, 20, 110, 20, 110, 80, 10, 80];
    expect(rectanglePolygon(10, 20, 110, 80)).toEqual(expected);
    expect(rectanglePolygon(110, 80, 10, 20)).toEqual(expected);
    expect(rectanglePolygon(110, 20, 10, 80)).toEqual(expected);
  });

  it('selects by the same rule as the freeform lasso: at least 60% of a stroke inside', () => {
    expect(LASSO_COVERAGE).toBe(0.6);
    const rect = rectanglePolygon(0, 0, 100, 100);
    // Ten control points along a line, from x = 40 to x = 130.
    const stroke = (startX: number) => Array.from({ length: 10 }, (_, i) => [startX + i * 10, 50, 2]).flat();
    // Points at 40..90 inside (6 of 10): selected.
    expect(lassoSelectsStroke(stroke(40), rect)).toBe(true);
    // Points at 50..90 inside (5 of 10): not selected.
    expect(lassoSelectsStroke(stroke(50), rect)).toBe(false);
    // Fully inside.
    expect(lassoSelectsStroke(stroke(0), rect)).toBe(true);
  });

  it('selects images by the same coverage rule', () => {
    const rect = rectanglePolygon(0, 0, 100, 100);
    expect(boxCoverage({ x: 10, y: 10, width: 50, height: 50 }, rect)).toBe(1);
    expect(boxCoverage({ x: 60, y: 10, width: 100, height: 50 }, rect)).toBeLessThan(LASSO_COVERAGE);
    expect(boxCoverage({ x: 20, y: 10, width: 100, height: 50 }, rect)).toBeGreaterThanOrEqual(LASSO_COVERAGE);
  });

  it('gives the same result as an equivalent hand-drawn rectangular lasso', () => {
    const rect = rectanglePolygon(0, 0, 100, 60);
    const drawn = [0, 0, 50, 0, 100, 0, 100, 30, 100, 60, 50, 60, 0, 60, 0, 30];
    const strokes = [
      [10, 10, 2, 90, 50, 2],
      [80, 30, 2, 150, 30, 2, 200, 30, 2],
      [-20, -20, 2, 20, 20, 2, 40, 40, 2],
    ];
    for (const points of strokes) expect(lassoSelectsStroke(points, rect)).toBe(lassoSelectsStroke(points, drawn));
  });
});
