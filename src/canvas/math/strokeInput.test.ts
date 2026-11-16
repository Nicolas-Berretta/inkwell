import { describe, expect, it } from 'vitest';
import { StrokeInputFilter, isRealPressure, pressureWidthFactor, velocityWidthFactor } from './strokeInput';

function widths(points: number[]): number[] {
  return points.filter((_, index) => index % 3 === 2);
}

function drawLine(filter: StrokeInputFilter, stepPx: number, steps: number, dtMs: number, pressure = 0.5): void {
  for (let i = 0; i <= steps; i++) filter.add({ x: i * stepPx, y: 0, pressure, time: i * dtMs });
}

describe('pressure detection', () => {
  it('only trusts pens that report varying pressure', () => {
    expect(isRealPressure('pen', 0.37)).toBe(true);
    expect(isRealPressure('pen', 0.5)).toBe(false);
    expect(isRealPressure('mouse', 0.37)).toBe(false);
    expect(isRealPressure('touch', 0)).toBe(false);
  });

  it('maps pressure and speed to monotonic width factors', () => {
    expect(pressureWidthFactor(0.9)).toBeGreaterThan(pressureWidthFactor(0.2));
    expect(velocityWidthFactor(0.1)).toBeGreaterThan(velocityWidthFactor(2));
    expect(velocityWidthFactor(50)).toBe(velocityWidthFactor(2.2));
  });
});

describe('StrokeInputFilter', () => {
  it('drops near-duplicate samples', () => {
    const filter = new StrokeInputFilter({ tool: 'pen', size: 3, zoom: 1, pointerType: 'mouse' });
    filter.add({ x: 0, y: 0, pressure: 0.5, time: 0 });
    for (let i = 1; i <= 20; i++) {
      expect(filter.add({ x: 0.02 * i, y: 0.01, pressure: 0.5, time: i })).toBe(false);
    }
    expect(filter.count).toBe(1);
  });

  it('scales the duplicate threshold with zoom', () => {
    const zoomedIn = new StrokeInputFilter({ tool: 'pen', size: 3, zoom: 8, pointerType: 'mouse' });
    zoomedIn.add({ x: 0, y: 0, pressure: 0.5, time: 0 });
    // 0.5 world units is 4 screen pixels at 8x zoom: clearly a new point.
    expect(zoomedIn.add({ x: 0.5, y: 0, pressure: 0.5, time: 8 })).toBe(true);
  });

  it('keeps highlighter width constant', () => {
    const filter = new StrokeInputFilter({ tool: 'highlighter', size: 18, zoom: 1, pointerType: 'mouse' });
    drawLine(filter, 6, 30, 4);
    expect(new Set(widths(filter.points))).toEqual(new Set([18]));
  });

  it('draws thinner lines for fast mouse movement than for slow movement', () => {
    const slow = new StrokeInputFilter({ tool: 'pen', size: 4, zoom: 1, pointerType: 'mouse' });
    drawLine(slow, 2, 60, 16);
    const fast = new StrokeInputFilter({ tool: 'pen', size: 4, zoom: 1, pointerType: 'mouse' });
    drawLine(fast, 40, 60, 8);
    const last = (filter: StrokeInputFilter) => filter.points[filter.points.length - 1];
    expect(last(fast)).toBeLessThan(last(slow));
  });

  it('follows pen pressure and smooths width changes', () => {
    const filter = new StrokeInputFilter({ tool: 'pen', size: 4, zoom: 1, pointerType: 'pen' });
    for (let i = 0; i <= 40; i++) filter.add({ x: i * 3, y: 0, pressure: 0.15, time: i * 4 });
    const light = filter.points[filter.points.length - 1];
    for (let i = 41; i <= 80; i++) filter.add({ x: i * 3, y: 0, pressure: 0.95, time: i * 4 });
    const heavy = filter.points[filter.points.length - 1];
    expect(heavy).toBeGreaterThan(light * 1.5);

    // The jump from light to heavy pressure is spread over several points instead of one step.
    const w = widths(filter.points);
    let largestStep = 0;
    for (let i = 1; i < w.length; i++) largestStep = Math.max(largestStep, Math.abs(w[i] - w[i - 1]));
    expect(largestStep).toBeLessThan((heavy - light) * 0.4);
  });

  it('varies width only modestly, like a ballpoint rather than a calligraphy nib', () => {
    // A mouse stroke that alternates between crawling and darting.
    const filter = new StrokeInputFilter({ tool: 'pen', size: 4, zoom: 1, pointerType: 'mouse' });
    let x = 0;
    let time = 0;
    filter.add({ x, y: 0, pressure: 0.5, time });
    for (let burst = 0; burst < 8; burst++) {
      const fast = burst % 2 === 1;
      for (let i = 0; i < 25; i++) {
        x += fast ? 30 : 1.5;
        time += fast ? 6 : 16;
        filter.add({ x, y: 0, pressure: 0.5, time });
      }
    }
    filter.finish();
    const w = widths(filter.points);
    const thinnest = Math.min(...w);
    const boldest = Math.max(...w);
    expect(boldest).toBeGreaterThan(thinnest * 1.15);
    expect(boldest).toBeLessThan(thinnest * 1.6);
    expect(thinnest).toBeGreaterThan(4 * 0.7);
    expect(boldest).toBeLessThan(4 * 1.15);
    // The stroke neither opens with a blob nor ends in a pinched taper.
    expect(w[0]).toBeGreaterThan(4 * 0.85);
    expect(w[0]).toBeLessThan(4 * 1.05);
    expect(w[w.length - 1]).toBeGreaterThan(4 * 0.7);
  });

  it('limits how fast the width may change along the stroke', () => {
    const filter = new StrokeInputFilter({ tool: 'pen', size: 4, zoom: 2, pointerType: 'pen' });
    // Pressure slams between very light and very heavy on every sample.
    for (let i = 0; i <= 120; i++) filter.add({ x: i * 0.9, y: 0, pressure: i % 2 === 0 ? 0.05 : 0.98, time: i * 4 });
    filter.finish();
    const points = filter.points;
    for (let i = 3; i < points.length; i += 3) {
      const screenDistance = Math.hypot(points[i] - points[i - 3], points[i + 1] - points[i - 2]) * 2;
      // 3% of the nominal size per screen pixel, plus the two-decimal rounding of stored values.
      expect(Math.abs(points[i + 2] - points[i - 1])).toBeLessThanOrEqual(4 * 0.03 * screenDistance + 0.011);
    }
  });

  it('smooths positional jitter', () => {
    const filter = new StrokeInputFilter({ tool: 'pen', size: 3, zoom: 1, pointerType: 'mouse' });
    for (let i = 0; i <= 60; i++) {
      filter.add({ x: i * 3, y: i % 2 === 0 ? 1.5 : -1.5, pressure: 0.5, time: i * 8 });
    }
    const ys = filter.points.filter((_, index) => index % 3 === 1).slice(4);
    const amplitude = Math.max(...ys) - Math.min(...ys);
    expect(amplitude).toBeLessThan(3);
  });

  it('ends exactly where the pointer was lifted', () => {
    const filter = new StrokeInputFilter({ tool: 'pen', size: 3, zoom: 1, pointerType: 'mouse' });
    drawLine(filter, 5, 20, 8);
    filter.add({ x: 100.6, y: 0.3, pressure: 0.5, time: 170 });
    filter.finish();
    const n = filter.points.length;
    expect(Math.hypot(filter.points[n - 3] - 100.6, filter.points[n - 2] - 0.3)).toBeLessThan(0.7);
  });

  it('stores finite, rounded triples', () => {
    const filter = new StrokeInputFilter({ tool: 'pen', size: 2.5, zoom: 1.37, pointerType: 'mouse' });
    drawLine(filter, 3.33333, 25, 7);
    expect(filter.points.length % 3).toBe(0);
    for (const value of filter.points) {
      expect(Number.isFinite(value)).toBe(true);
      expect(Math.abs(value * 100 - Math.round(value * 100))).toBeLessThan(1e-6);
    }
  });
});
