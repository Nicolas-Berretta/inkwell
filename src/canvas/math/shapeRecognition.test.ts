import { describe, expect, it } from 'vitest';
import type { RecognizedShape } from './shapeRecognition';
import { recognizeShape, resamplePath, shapeVertices, snapLineEnd } from './shapeRecognition';

const OPTIONS = { minSize: 28 };

/** Deterministic pseudo-random numbers in [-0.5, 0.5). */
function randomSource(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296 - 0.5;
  };
}

interface HandOptions {
  seed?: number;
  /** Amplitude of the slow wobble of an unsteady hand. */
  wobble?: number;
  /** Amplitude of per-sample sensor jitter. */
  jitter?: number;
  /** How strongly corners are rounded (number of smoothing passes). */
  rounding?: number;
}

/**
 * Makes a clean polyline look hand-drawn: resampled every few units, corners
 * rounded, a slow wobble and some jitter added.
 */
function handDrawn(clean: number[], options: HandOptions = {}): number[] {
  const { seed = 7, wobble = 3, jitter = 0.8, rounding = 3 } = options;
  const random = randomSource(seed);
  let length = 0;
  for (let i = 2; i < clean.length; i += 2) length += Math.hypot(clean[i] - clean[i - 2], clean[i + 1] - clean[i - 1]);
  let points = resamplePath(clean, Math.max(8, Math.round(length / 4)));
  for (let pass = 0; pass < rounding; pass++) {
    const smooth = points.slice();
    for (let i = 2; i + 3 < points.length; i += 2) {
      smooth[i] = (points[i - 2] + 2 * points[i] + points[i + 2]) / 4;
      smooth[i + 1] = (points[i - 1] + 2 * points[i + 1] + points[i + 3]) / 4;
    }
    points = smooth;
  }
  const phaseX = random() * 6;
  const phaseY = random() * 6;
  const out: number[] = [];
  for (let i = 0; i < points.length; i += 2) {
    const t = i / points.length;
    out.push(
      points[i] + wobble * Math.sin(t * 17 + phaseX) + jitter * random(),
      points[i + 1] + wobble * Math.sin(t * 13 + phaseY) + jitter * random(),
    );
  }
  return out;
}

function ellipsePath(cx: number, cy: number, rx: number, ry: number, fromDeg: number, toDeg: number, rotation = 0): number[] {
  const out: number[] = [];
  for (let deg = fromDeg; deg <= toDeg; deg += 4) {
    const a = (deg * Math.PI) / 180;
    const u = rx * Math.cos(a);
    const v = ry * Math.sin(a);
    out.push(cx + u * Math.cos(rotation) - v * Math.sin(rotation), cy + u * Math.sin(rotation) + v * Math.cos(rotation));
  }
  return out;
}

function reversePath(path: number[]): number[] {
  const out: number[] = [];
  for (let i = path.length - 2; i >= 0; i -= 2) out.push(path[i], path[i + 1]);
  return out;
}

function expectKind<K extends RecognizedShape['kind']>(
  shape: RecognizedShape | null,
  kind: K,
): Extract<RecognizedShape, { kind: K }> {
  expect(shape?.kind).toBe(kind);
  return shape as Extract<RecognizedShape, { kind: K }>;
}

describe('straight lines', () => {
  it('snaps a wobbly diagonal line to its end points', () => {
    const path = handDrawn([100, 100, 380, 240], { wobble: 4 });
    const line = expectKind(recognizeShape(path, OPTIONS), 'line');
    expect(Math.hypot(line.x1 - 100, line.y1 - 100)).toBeLessThan(8);
    expect(Math.hypot(line.x2 - 380, line.y2 - 240)).toBeLessThan(8);
  });

  it('makes nearly horizontal and nearly vertical lines exact', () => {
    const horizontal = expectKind(recognizeShape(handDrawn([50, 200, 400, 212]), OPTIONS), 'line');
    expect(horizontal.y2).toBe(horizontal.y1);
    expect(Math.abs(horizontal.x2 - 400)).toBeLessThan(6);
    const vertical = expectKind(recognizeShape(handDrawn([300, 40, 290, 330]), OPTIONS), 'line');
    expect(vertical.x2).toBe(vertical.x1);
  });

  it('keeps the angle of a clearly slanted line', () => {
    const line = expectKind(recognizeShape(handDrawn([0, 0, 300, 60]), OPTIONS), 'line');
    expect(line.y2).not.toBe(line.y1);
    expect(snapLineEnd(0, 0, 300, 60)).toEqual({ x: 300, y: 60 });
    expect(snapLineEnd(0, 0, 300, 10)).toEqual({ x: 300, y: 0 });
    expect(snapLineEnd(5, 0, -4, -200)).toEqual({ x: 5, y: -200 });
  });

  it('ignores marks too short to be intentional', () => {
    expect(recognizeShape([10, 10, 14, 11, 19, 12], OPTIONS)).toBeNull();
    expect(recognizeShape([10, 10], OPTIONS)).toBeNull();
    expect(recognizeShape([], OPTIONS)).toBeNull();
  });
});

describe('rectangles', () => {
  it('snaps a rough rectangle to an axis-aligned one', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const path = handDrawn([100, 100, 420, 104, 416, 300, 96, 296, 102, 106], { seed });
      const rect = expectKind(recognizeShape(path, OPTIONS), 'rectangle');
      expect(Math.abs(rect.minX - 98)).toBeLessThan(10);
      expect(Math.abs(rect.maxX - 418)).toBeLessThan(10);
      expect(Math.abs(rect.minY - 102)).toBeLessThan(10);
      expect(Math.abs(rect.maxY - 298)).toBeLessThan(10);
    }
  });

  it('snaps a nearly square outline to an exact square', () => {
    const path = handDrawn([200, 100, 392, 96, 398, 300, 204, 306, 198, 104], { seed: 9 });
    const rect = expectKind(recognizeShape(path, OPTIONS), 'rectangle');
    expect(rect.maxX - rect.minX).toBeCloseTo(rect.maxY - rect.minY, 9);
    expect(Math.abs(rect.maxX - rect.minX - 200)).toBeLessThan(12);
  });

  it('accepts a small gap or an overshoot where the outline closes, in either direction', () => {
    const gap = handDrawn([100, 100, 300, 100, 300, 240, 100, 240, 100, 125]);
    expectKind(recognizeShape(gap, OPTIONS), 'rectangle');
    const overshoot = handDrawn([100, 100, 300, 100, 300, 240, 100, 240, 100, 100, 130, 100]);
    expectKind(recognizeShape(overshoot, OPTIONS), 'rectangle');
    const counterClockwise = handDrawn([100, 100, 100, 240, 300, 240, 300, 100, 104, 98]);
    expectKind(recognizeShape(counterClockwise, OPTIONS), 'rectangle');
  });

  it('describes the rectangle as a closed outline with four corners', () => {
    const vertices = shapeVertices({ kind: 'rectangle', minX: 0, minY: 0, maxX: 10, maxY: 6 });
    expect(vertices).toEqual([0, 0, 10, 0, 10, 6, 0, 6, 0, 0]);
  });
});

describe('ellipses', () => {
  it('snaps a rough circle to an exact circle', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const path = handDrawn(ellipsePath(300, 250, 104, 96, -80, 285), { seed, rounding: 0 });
      const circle = expectKind(recognizeShape(path, OPTIONS), 'ellipse');
      expect(circle.rx).toBeCloseTo(circle.ry, 9);
      expect(Math.abs(circle.rx - 100)).toBeLessThan(10);
      expect(Math.hypot(circle.cx - 300, circle.cy - 250)).toBeLessThan(10);
    }
  });

  it('snaps a rough oval to an upright ellipse', () => {
    const path = handDrawn(ellipsePath(300, 250, 170, 80, 10, 372), { seed: 3, rounding: 0 });
    const ellipse = expectKind(recognizeShape(path, OPTIONS), 'ellipse');
    expect(ellipse.rotation).toBe(0);
    expect(Math.abs(ellipse.rx - 170)).toBeLessThan(12);
    expect(Math.abs(ellipse.ry - 80)).toBeLessThan(12);

    const tall = expectKind(recognizeShape(handDrawn(ellipsePath(0, 0, 60, 150, 0, 360), { rounding: 0 }), OPTIONS), 'ellipse');
    expect(tall.rotation).toBe(0);
    expect(tall.ry).toBeGreaterThan(tall.rx * 2);
  });

  it('keeps the tilt of a clearly slanted oval', () => {
    const path = handDrawn(ellipsePath(300, 250, 180, 70, 0, 360, Math.PI / 5), { rounding: 0 });
    const ellipse = expectKind(recognizeShape(path, OPTIONS), 'ellipse');
    expect(Math.abs(ellipse.rotation - Math.PI / 5)).toBeLessThan(0.1);
    expect(Math.abs(ellipse.rx - 180)).toBeLessThan(14);
  });

  it('approximates the ellipse outline with a smooth closed polygon', () => {
    const vertices = shapeVertices({ kind: 'ellipse', cx: 10, cy: 20, rx: 100, ry: 50, rotation: 0 });
    expect(vertices.slice(0, 2)).toEqual(vertices.slice(-2));
    expect(vertices.length / 2).toBeGreaterThan(64);
    for (let i = 0; i < vertices.length; i += 2) {
      expect(Math.hypot((vertices[i] - 10) / 100, (vertices[i + 1] - 20) / 50)).toBeCloseTo(1, 9);
    }
  });
});

describe('triangles', () => {
  it('snaps a rough triangle to three straight sides', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const path = handDrawn([250, 80, 420, 330, 90, 320, 246, 84], { seed });
      const triangle = expectKind(recognizeShape(path, OPTIONS), 'triangle');
      expect(triangle.vertices).toHaveLength(6);
      for (const [x, y] of [
        [250, 80],
        [420, 330],
        [90, 320],
      ]) {
        let nearest = Infinity;
        for (let i = 0; i < 6; i += 2) nearest = Math.min(nearest, Math.hypot(triangle.vertices[i] - x, triangle.vertices[i + 1] - y));
        expect(nearest).toBeLessThan(16);
      }
    }
  });

  it('levels a nearly horizontal base', () => {
    const triangle = expectKind(recognizeShape(handDrawn([200, 100, 350, 300, 60, 306, 198, 104]), OPTIONS), 'triangle');
    const ys = [triangle.vertices[1], triangle.vertices[3], triangle.vertices[5]].sort((a, b) => a - b);
    expect(ys[2]).toBe(ys[1]);
  });

  it('recognises a right triangle instead of a rectangle', () => {
    expectKind(recognizeShape(handDrawn([100, 100, 100, 300, 360, 300, 104, 102]), OPTIONS), 'triangle');
  });
});

describe('strokes that must stay freehand', () => {
  it('does not snap a scribble', () => {
    const zigzag: number[] = [];
    for (let i = 0; i <= 12; i++) zigzag.push(100 + i * 18, i % 2 === 0 ? 100 : 220);
    expect(recognizeShape(handDrawn(zigzag), OPTIONS)).toBeNull();

    // Scribbling back and forth and ending near the start (a closed path that fills an area).
    const filled = [...zigzag];
    for (let i = 12; i >= 0; i--) filled.push(100 + i * 18, i % 2 === 0 ? 130 : 190);
    expect(recognizeShape(handDrawn(filled), OPTIONS)).toBeNull();
  });

  it('does not snap handwritten-letter-like squiggles', () => {
    const letterS = [...reversePath(ellipsePath(200, 150, 50, 50, -270, -30)), ...ellipsePath(200, 250, 50, 50, -90, 120)];
    expect(recognizeShape(handDrawn(letterS, { rounding: 1 }), OPTIONS)).toBeNull();

    const letterH = handDrawn([100, 60, 102, 300, 104, 200, 150, 170, 190, 200, 194, 300], { rounding: 4 });
    expect(recognizeShape(letterH, OPTIONS)).toBeNull();

    const letterM = handDrawn([100, 300, 100, 180, 140, 150, 170, 300, 172, 180, 215, 150, 245, 300], { rounding: 4 });
    expect(recognizeShape(letterM, OPTIONS)).toBeNull();

    // Cursive "e": a loop with a tail on both sides.
    const loop = [60, 220, 120, 215, ...reversePath(ellipsePath(160, 170, 45, 55, -200, 100)), 230, 225, 280, 215];
    expect(recognizeShape(handDrawn(loop, { rounding: 1 }), OPTIONS)).toBeNull();
  });

  it('does not snap an open arc', () => {
    expect(recognizeShape(handDrawn(ellipsePath(300, 300, 120, 120, 0, 90), { rounding: 0 }), OPTIONS)).toBeNull();
    expect(recognizeShape(handDrawn(ellipsePath(300, 300, 120, 120, 0, 180), { rounding: 0 }), OPTIONS)).toBeNull();
    expect(recognizeShape(handDrawn(ellipsePath(300, 300, 120, 120, 0, 250), { rounding: 0 }), OPTIONS)).toBeNull();
    // A shallow bow is still not a straight line.
    expect(recognizeShape(handDrawn(ellipsePath(0, 0, 200, 200, 240, 300), { rounding: 0, wobble: 1 }), OPTIONS)).toBeNull();
  });

  it('does not snap closed outlines that are not one of the shapes', () => {
    const figureEight: number[] = [];
    for (let deg = 0; deg <= 360; deg += 4) {
      const a = (deg * Math.PI) / 180;
      figureEight.push(300 + 120 * Math.sin(a), 250 + 70 * Math.sin(2 * a));
    }
    expect(recognizeShape(handDrawn(figureEight, { rounding: 0 }), OPTIONS)).toBeNull();

    const letterL = handDrawn([100, 100, 160, 100, 160, 260, 300, 260, 300, 320, 100, 320, 100, 104]);
    expect(recognizeShape(letterL, OPTIONS)).toBeNull();

    const star: number[] = [];
    for (let k = 0; k <= 10; k++) {
      const a = (k * Math.PI) / 5 - Math.PI / 2;
      const r = k % 2 === 0 ? 130 : 55;
      star.push(300 + r * Math.cos(a), 300 + r * Math.sin(a));
    }
    expect(recognizeShape(handDrawn(star, { rounding: 1 }), OPTIONS)).toBeNull();

    // A diamond is neither an axis-aligned rectangle nor an ellipse.
    const diamond = handDrawn([300, 100, 440, 250, 300, 400, 160, 250, 298, 104]);
    expect(recognizeShape(diamond, OPTIONS)).toBeNull();

    // An outline traced twice is a scribble, not a circle.
    const twice = handDrawn(ellipsePath(300, 300, 100, 100, 0, 720), { rounding: 0 });
    expect(recognizeShape(twice, OPTIONS)).toBeNull();
  });

  it('rejects non-finite input', () => {
    expect(recognizeShape([0, 0, NaN, 5, 100, 100], OPTIONS)).toBeNull();
  });
});

describe('resampling', () => {
  it('spaces points evenly and keeps both ends', () => {
    const points = resamplePath([0, 0, 10, 0, 10, 30], 9);
    expect(points).toHaveLength(18);
    expect(points.slice(0, 2)).toEqual([0, 0]);
    expect(points.slice(-2)).toEqual([10, 30]);
    for (let i = 2; i < points.length; i += 2) {
      const step = Math.abs(points[i] - points[i - 2]) + Math.abs(points[i + 1] - points[i - 1]);
      expect(step).toBeCloseTo(5, 9);
    }
  });
});
