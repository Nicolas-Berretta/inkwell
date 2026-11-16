import { describe, expect, it } from 'vitest';
import { distSqPointToSegment, polygonSignedArea } from './geometry';
import { catmullRomCentripetal, turningAngle } from './smoothing';
import {
  appendSpanSamples,
  buildClosedOutline,
  buildRecordOutline,
  buildStrokeOutline,
  buildStrokeSamples,
  spanSubdivisions,
  strokeBounds,
  strokeInkBounds,
  strokeWidthStats,
  translatePoints,
} from './strokeGeometry';

const out = { x: 0, y: 0 };

describe('centripetal Catmull-Rom', () => {
  it('interpolates its inner control points', () => {
    catmullRomCentripetal(0, 0, 10, 5, 22, 3, 30, 12, 0, out);
    expect(out.x).toBeCloseTo(10, 9);
    expect(out.y).toBeCloseTo(5, 9);
    catmullRomCentripetal(0, 0, 10, 5, 22, 3, 30, 12, 1, out);
    expect(out.x).toBeCloseTo(22, 9);
    expect(out.y).toBeCloseTo(3, 9);
  });

  it('stays on the line for collinear control points', () => {
    for (const u of [0.1, 0.5, 0.9]) {
      catmullRomCentripetal(0, 0, 10, 10, 20, 20, 30, 30, u, out);
      expect(out.x).toBeCloseTo(out.y, 9);
      expect(out.x).toBeGreaterThan(10);
      expect(out.x).toBeLessThan(20);
    }
  });

  it('stays finite with duplicated end points', () => {
    catmullRomCentripetal(0, 0, 0, 0, 10, 0, 10, 0, 0.5, out);
    expect(Number.isFinite(out.x)).toBe(true);
    expect(out.x).toBeCloseTo(5, 6);
    expect(out.y).toBeCloseTo(0, 9);
  });

  it('does not overshoot on a sharp corner between unevenly spaced points', () => {
    // Uniform Catmull-Rom loops here; the centripetal variant must stay near the control polygon.
    const pts = [0, 0, 1, 0, 1.2, 0, 1.2, 30];
    let maxOvershoot = 0;
    for (let u = 0; u <= 1; u += 0.05) {
      catmullRomCentripetal(pts[0], pts[1], pts[2], pts[3], pts[4], pts[5], pts[6], pts[7], u, out);
      maxOvershoot = Math.max(maxOvershoot, Math.sqrt(distSqPointToSegment(out.x, out.y, 1, 0, 1.2, 0)));
    }
    expect(maxOvershoot).toBeLessThan(0.1);
  });

  it('measures turning angles', () => {
    expect(turningAngle(0, 0, 1, 0, 2, 0)).toBeCloseTo(0);
    expect(turningAngle(0, 0, 1, 0, 1, 1)).toBeCloseTo(Math.PI / 2);
    expect(turningAngle(0, 0, 1, 0, 1, 0)).toBe(0);
  });
});

describe('stroke sampling', () => {
  // A quarter circle of radius 50 sampled every 15 degrees, constant width 4.
  const arc: number[] = [];
  for (let deg = 0; deg <= 90; deg += 15) {
    const a = (deg * Math.PI) / 180;
    arc.push(50 * Math.cos(a), 50 * Math.sin(a), 4);
  }

  it('returns a single disc for a dot and nothing for an empty stroke', () => {
    expect(buildStrokeSamples([])).toEqual([]);
    expect(buildStrokeSamples([3, 4, 6])).toEqual([3, 4, 3]);
  });

  it('does not subdivide straight spans', () => {
    const line = [0, 0, 2, 10, 0, 2, 20, 0, 2, 30, 0, 2];
    expect(spanSubdivisions(line, 1)).toBe(1);
    expect(buildStrokeSamples(line)).toHaveLength(4 * 3);
  });

  it('passes through every control point and halves the width into a radius', () => {
    const samples = buildStrokeSamples(arc);
    for (let i = 0; i < arc.length; i += 3) {
      let found = false;
      for (let s = 0; s < samples.length; s += 3) {
        if (Math.abs(samples[s] - arc[i]) < 1e-9 && Math.abs(samples[s + 1] - arc[i + 1]) < 1e-9) {
          found = true;
          expect(samples[s + 2]).toBeCloseTo(2);
        }
      }
      expect(found).toBe(true);
    }
  });

  it('subdivides curves so the flattened centreline hugs the true curve', () => {
    const samples = buildStrokeSamples(arc);
    expect(samples.length / 3).toBeGreaterThan(arc.length / 3);
    for (let s = 0; s < samples.length; s += 3) {
      const radius = Math.hypot(samples[s], samples[s + 1]);
      expect(Math.abs(radius - 50)).toBeLessThan(0.25);
    }
    // No piece turns by more than a modest angle, so the outline looks round when zoomed in.
    for (let s = 3; s + 5 < samples.length; s += 3) {
      const turn = turningAngle(samples[s - 3], samples[s - 2], samples[s], samples[s + 1], samples[s + 3], samples[s + 4]);
      expect(turn).toBeLessThan(0.21);
    }
  });

  it('interpolates width along a span', () => {
    const tapered = [0, 0, 2, 10, 4, 2, 14, 14, 6, 14, 24, 6];
    const samples: number[] = [];
    appendSpanSamples(samples, tapered, 1);
    const radii = samples.filter((_, index) => index % 3 === 2);
    expect(radii.length).toBeGreaterThan(1);
    expect(radii[radii.length - 1]).toBe(3);
    for (let i = 1; i < radii.length; i++) expect(radii[i]).toBeGreaterThan(radii[i - 1]);
    expect(radii[0]).toBeGreaterThan(1);
  });

  it('produces identical spans whether sampled incrementally or all at once', () => {
    // The live stroke appends finished spans one by one; the committed stroke samples everything.
    const whole = buildStrokeSamples(arc);
    const incremental = [arc[0], arc[1], arc[2] / 2];
    for (let count = 3; count <= arc.length / 3; count++) {
      const partial = arc.slice(0, count * 3);
      appendSpanSamples(incremental, partial, count - 3);
    }
    appendSpanSamples(incremental, arc, arc.length / 3 - 2);
    expect(incremental).toEqual(whole);
  });
});

/** Winding number of a closed polygon (flat `[x, y]` list) around a point. */
function windingNumber(polygon: number[], x: number, y: number): number {
  let winding = 0;
  const n = polygon.length / 2;
  for (let i = 0; i < n; i++) {
    const ax = polygon[i * 2];
    const ay = polygon[i * 2 + 1];
    const bx = polygon[((i + 1) % n) * 2];
    const by = polygon[((i + 1) % n) * 2 + 1];
    const side = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (ay <= y) {
      if (by > y && side > 0) winding++;
    } else if (by <= y && side < 0) {
      winding--;
    }
  }
  return winding;
}

/** Whether a non-zero fill of the outline paints the point. */
function isInked(outline: { polygons: number[][]; discs: number[] }, x: number, y: number): boolean {
  let winding = 0;
  for (const polygon of outline.polygons) winding += windingNumber(polygon, x, y);
  if (winding !== 0) return true;
  for (let i = 0; i < outline.discs.length; i += 3) {
    if (Math.hypot(x - outline.discs[i], y - outline.discs[i + 1]) <= outline.discs[i + 2]) return true;
  }
  return false;
}

/** Distance from a point to the centreline through the samples. */
function distanceToCentreline(samples: number[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i + 5 < samples.length; i += 3) {
    best = Math.min(best, distSqPointToSegment(x, y, samples[i], samples[i + 1], samples[i + 3], samples[i + 4]));
  }
  return Math.sqrt(best);
}

describe('stroke outline', () => {
  it('turns a straight stroke into a single polygon with a semicircle at each end', () => {
    const outline = buildStrokeOutline([0, 0, 2, 10, 0, 2, 20, 0, 2]);
    expect(outline.polygons).toHaveLength(1);
    expect(outline.discs).toEqual([]);
    // A 20 x 4 rectangle plus two half discs of radius 2.
    const expected = 80 + Math.PI * 4;
    expect(Math.abs(polygonSignedArea(outline.polygons[0]) - expected) / expected).toBeLessThan(0.005);
  });

  it('rounds both ends with a cap whose radius is the half width at that end', () => {
    // Thin start (radius 1), bold end (radius 3).
    const outline = buildStrokeOutline([0, 0, 1, 20, 0, 3]);
    // The tip of each cap is inked almost a full radius beyond the end point...
    expect(isInked(outline, -0.97, 0)).toBe(true);
    expect(isInked(outline, 22.9, 0)).toBe(true);
    expect(isInked(outline, -1.05, 0)).toBe(false);
    expect(isInked(outline, 23.1, 0)).toBe(false);
    // ...the cap follows a circle, so it is as wide as the stroke where it meets the body...
    expect(isInked(outline, 20.3, 2.9)).toBe(true);
    for (let deg = -85; deg <= 85; deg += 10) {
      const a = (deg * Math.PI) / 180;
      expect(isInked(outline, 20 + 2.95 * Math.cos(a), 2.95 * Math.sin(a))).toBe(true);
      expect(isInked(outline, 20 + 3.05 * Math.cos(a), 3.05 * Math.sin(a))).toBe(false);
      expect(isInked(outline, -0.97 * Math.cos(a), 0.97 * Math.sin(a))).toBe(true);
      expect(isInked(outline, -1.04 * Math.cos(a), 1.04 * Math.sin(a))).toBe(false);
    }
    // ...and the corners a flat or square cap would fill stay empty.
    expect(isInked(outline, 22.5, 2.5)).toBe(false);
    expect(isInked(outline, -0.8, -0.8)).toBe(false);
  });

  it('keeps the requested width along a gentle curve', () => {
    const samples: number[] = [];
    for (let deg = 0; deg <= 90; deg += 5) {
      const a = (deg * Math.PI) / 180;
      samples.push(100 * Math.cos(a), 100 * Math.sin(a), 3);
    }
    const outline = buildStrokeOutline(samples);
    expect(outline.polygons).toHaveLength(1);
    // Quarter annulus between radius 97 and 103, plus the two round caps.
    const expected = (Math.PI / 4) * (103 * 103 - 97 * 97) + Math.PI * 9;
    expect(Math.abs(polygonSignedArea(outline.polygons[0]) - expected) / expected).toBeLessThan(0.01);
  });

  it('rounds the outside of a sharp corner instead of cutting or spiking it', () => {
    const outline = buildStrokeOutline([0, 0, 2, 30, 0, 2, 30, 30, 2]);
    expect(outline.polygons).toHaveLength(1);
    expect(outline.discs).toEqual([]);
    // The outside of the corner at (30, 0) is a quarter circle of radius 2.
    for (let deg = -85; deg <= -5; deg += 10) {
      const a = (deg * Math.PI) / 180;
      expect(isInked(outline, 30 + 1.95 * Math.cos(a), 1.95 * Math.sin(a))).toBe(true);
      expect(isInked(outline, 30 + 2.05 * Math.cos(a), 2.05 * Math.sin(a))).toBe(false);
    }
    // A mitre would reach (32, -2); a bevel would stop short of the circle.
    expect(isInked(outline, 31.8, -1.8)).toBe(false);
    // The inside of the corner is filled right into the angle.
    expect(isInked(outline, 28.1, 1.9)).toBe(true);
    expect(isInked(outline, 27.9, 2.1)).toBe(false);
  });

  it('rounds a full reversal like a cap', () => {
    const outline = buildStrokeOutline([0, 0, 2, 30, 0, 2, 0, 0.001, 2]);
    expect(isInked(outline, 31.9, 0)).toBe(true);
    expect(isInked(outline, 31.5, 1.5)).toBe(false);
    expect(isInked(outline, 15, 0)).toBe(true);
  });

  it('paints exactly the swept area of the pen: no holes, spikes or negative winding', () => {
    let seed = 11;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let round = 0; round < 30; round++) {
      // Erratic strokes with tight turns and segments shorter than the pen is wide.
      const points: number[] = [];
      let x = 0;
      let y = 0;
      let angle = random() * 6;
      const width = 1 + random() * 7;
      for (let i = 0; i < 40; i++) {
        angle += (random() - 0.5) * 3.4;
        const step = 0.5 + random() * 6;
        x += Math.cos(angle) * step;
        y += Math.sin(angle) * step;
        points.push(x, y, width);
      }
      const samples = buildStrokeSamples(points);
      const outline = buildStrokeOutline(samples);
      expect(outline.polygons).toHaveLength(1);
      const polygon = outline.polygons[0];
      for (const value of polygon) expect(Number.isFinite(value)).toBe(true);
      const radius = width / 2;
      for (let probe = 0; probe < 400; probe++) {
        const px = x * random() * 1.2 + (random() - 0.5) * 40;
        const py = y * random() * 1.2 + (random() - 0.5) * 40;
        const winding = windingNumber(polygon, px, py);
        // Same-direction pieces only: a non-zero fill can never cancel into a hole.
        expect(winding).toBeGreaterThanOrEqual(0);
        const distance = distanceToCentreline(samples, px, py);
        // Mitres at gentle bends reach at most a couple of percent beyond the radius.
        if (distance < radius * 0.97) expect(winding).toBeGreaterThan(0);
        if (distance > radius * 1.03) expect(winding).toBe(0);
      }
    }
  });

  it('does not fold when segments are shorter than the stroke is wide', () => {
    // A tight wiggle with a very wide pen: a naive offset curve would fold over itself here.
    const samples = [0, 0, 5, 2, 0.4, 5, 4, 0, 5, 6, 0.4, 5, 8, 0, 5];
    const outline = buildStrokeOutline(samples);
    for (let px = -4.5; px <= 12.5; px += 0.5) {
      for (let py = -4.5; py <= 5; py += 0.5) {
        const distance = distanceToCentreline(samples, px, py);
        if (distance < 4.85) expect(isInked(outline, px, py)).toBe(true);
        if (distance > 5.15) expect(isInked(outline, px, py)).toBe(false);
      }
    }
  });

  it('handles dots, empty input and repeated samples', () => {
    expect(buildStrokeOutline([])).toEqual({ polygons: [], discs: [] });
    // A single tap is one round dot.
    expect(buildStrokeOutline([5, 5, 3])).toEqual({ polygons: [], discs: [5, 5, 3] });
    expect(buildStrokeOutline([5, 5, 2, 5, 5, 3])).toEqual({ polygons: [], discs: [5, 5, 3] });
    const outline = buildStrokeOutline([0, 0, 2, 0, 0, 3, 10, 0, 2]);
    expect(outline.polygons).toHaveLength(1);
    expect(isInked(outline, -2.9, 0)).toBe(true);
    for (const value of outline.polygons[0]) expect(Number.isFinite(value)).toBe(true);
  });
});

describe('snapped shape outlines', () => {
  const square = [0, 0, 2, 10, 0, 2, 10, 10, 2, 0, 10, 2, 0, 0, 2];

  it('keeps rectangle corners crisp with mitre joins', () => {
    const outline = buildClosedOutline(square);
    expect(outline).not.toBeNull();
    const [outer, inner] = outline!.polygons;
    // Outer boundary: the square grown by half the width, with exact right-angle corners.
    expect(outer.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([-1, -1, 11, -1, 11, 11, -1, 11]);
    expect(polygonSignedArea(outer)).toBeCloseTo(144);
    // Inner boundary: shrunk by half the width and wound the other way to cut the hole.
    expect(polygonSignedArea(inner)).toBeCloseTo(-64);
    expect(isInked(outline!, -0.99, -0.99)).toBe(true);
    expect(isInked(outline!, 10.99, 10.99)).toBe(true);
    expect(isInked(outline!, 5, 5)).toBe(false);
    expect(isInked(outline!, 1.1, 1.1)).toBe(false);
    expect(isInked(outline!, 0.9, 5)).toBe(true);
  });

  it('gives the same outline whichever way the shape was drawn', () => {
    const reversed = [0, 0, 2, 0, 10, 2, 10, 10, 2, 10, 0, 2, 0, 0, 2];
    const outline = buildClosedOutline(reversed)!;
    expect(polygonSignedArea(outline.polygons[0])).toBeCloseTo(144);
    expect(polygonSignedArea(outline.polygons[1])).toBeCloseTo(-64);
  });

  it('keeps triangle corners pointed', () => {
    const triangle = [0, 0, 2, 40, 0, 2, 0, 30, 2, 0, 0, 2];
    const outline = buildClosedOutline(triangle)!;
    // The right-angle corner at the origin is an exact corner, not a rounded one.
    expect(isInked(outline, -0.95, -0.95)).toBe(true);
    expect(isInked(outline, -1.05, -0.5)).toBe(false);
    expect(isInked(outline, 10, 8)).toBe(false);
    // Sharp corners reach beyond half the width; the ink bounds must include them.
    const ink = strokeInkBounds(triangle, 'triangle');
    const centreline = strokeBounds(triangle);
    expect(ink.maxX).toBeGreaterThan(centreline.maxX + 1);
    expect(ink.minX).toBeCloseTo(-1);
    for (let i = 0; i < outline.polygons[0].length; i += 2) {
      expect(outline.polygons[0][i]).toBeLessThanOrEqual(ink.maxX + 1e-9);
      expect(outline.polygons[0][i + 1]).toBeLessThanOrEqual(ink.maxY + 1e-9);
    }
  });

  it('fills the whole shape when the pen is wider than the shape', () => {
    const outline = buildClosedOutline([0, 0, 30, 10, 0, 30, 10, 10, 30, 0, 10, 30, 0, 0, 30])!;
    expect(outline.polygons).toHaveLength(1);
    expect(isInked(outline, 5, 5)).toBe(true);
  });

  it('falls back to a regular stroke for points that are not a closed shape', () => {
    expect(buildClosedOutline([0, 0, 2, 10, 0, 2])).toBeNull();
    expect(buildClosedOutline([0, 0, 2, 10, 0, 2, 20, 0, 2, 0, 0, 2])).toBeNull();
    const fallback = buildRecordOutline([0, 0, 2, 10, 0, 2], 'rectangle');
    expect(fallback.polygons).toHaveLength(1);
    expect(isInked(fallback, 5, 0)).toBe(true);
  });

  it('draws a snapped line as a straight stroke with round caps', () => {
    const outline = buildRecordOutline([0, 0, 4, 100, 0, 4], 'line');
    expect(outline.polygons).toHaveLength(1);
    expect(isInked(outline, 101.9, 0)).toBe(true);
    expect(isInked(outline, 101.6, 1.6)).toBe(false);
  });

  it('only smooths strokes that are not corner shapes', () => {
    // The same control points: a freehand stroke is rounded by the spline, a rectangle is not.
    const freehand = buildRecordOutline(square);
    const rectangle = buildRecordOutline(square, 'rectangle');
    expect(isInked(rectangle, 10.9, -0.9)).toBe(true);
    expect(isInked(freehand, 10.9, -0.9)).toBe(false);
  });
});

describe('stroke metrics', () => {
  const points = [0, 0, 2, 10, -5, 6, 4, 8, 4];

  it('expands bounds by half the local width', () => {
    expect(strokeBounds(points)).toEqual({ minX: -1, minY: -8, maxX: 13, maxY: 10 });
  });

  it('summarises widths', () => {
    expect(strokeWidthStats(points)).toEqual({ max: 6, average: 4 });
    expect(strokeWidthStats([])).toEqual({ max: 0, average: 0 });
  });

  it('translates positions without touching widths or the source', () => {
    const moved = translatePoints(points, 2.5, -1);
    expect(moved).toEqual([2.5, -1, 2, 12.5, -6, 6, 6.5, 7, 4]);
    expect(points[0]).toBe(0);
  });
});
