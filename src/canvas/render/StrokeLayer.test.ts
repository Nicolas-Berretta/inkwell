import { beforeAll, describe, expect, it } from 'vitest';
import type { StrokeRecord } from '../../types';
import type { StrokePaintContext } from './StrokeLayer';
import { paintStrokeItems } from './StrokeLayer';
import { StrokeModel } from './StrokeModel';

/**
 * A stand-in for a 2D context that behaves like a real one in the respect that
 * matters here: path points are transformed by the transform that is current
 * when they are added, not by the one that is current when the path is stroked.
 */
class RecordingContext {
  strokeStyle: string | CanvasGradient | CanvasPattern = '';
  fillStyle: string | CanvasGradient | CanvasPattern = '';
  lineWidth = 1;
  lineCap: CanvasLineCap = 'butt';
  lineJoin: CanvasLineJoin = 'miter';
  /** Device-space points of every stroked path. */
  readonly stroked: Array<Array<[number, number]>> = [];
  /** Device-space centre and radius of every filled disc. */
  readonly discs: Array<{ x: number; y: number; r: number }> = [];
  private matrix = [1, 0, 0, 1, 0, 0];
  private path: Array<[number, number]> = [];

  setTransform(a?: number | DOMMatrix2DInit, b = 0, c = 0, d = 1, e = 0, f = 0): void {
    this.matrix = typeof a === 'number' ? [a, b, c, d, e, f] : [1, 0, 0, 1, 0, 0];
  }

  beginPath(): void {
    this.path = [];
  }

  moveTo(x: number, y: number): void {
    this.path.push(this.toDevice(x, y));
  }

  lineTo(x: number, y: number): void {
    this.path.push(this.toDevice(x, y));
  }

  stroke(): void {
    this.stroked.push(this.path.slice());
  }

  /** A filled `Path2D` is transformed by the transform that is current when it is filled. */
  fill(path: unknown): void {
    for (const disc of (path as FakePath2D).discs) {
      const [x, y] = this.toDevice(disc.x, disc.y);
      this.discs.push({ x, y, r: disc.r * this.matrix[0] });
    }
  }

  private toDevice(x: number, y: number): [number, number] {
    const [a, b, c, d, e, f] = this.matrix;
    return [a * x + c * y + e, b * x + d * y + f];
  }
}

/** Minimal `Path2D` for a DOM-free test run: remembers the discs added to it. */
class FakePath2D {
  readonly discs: Array<{ x: number; y: number; r: number }> = [];

  moveTo(): void {}

  lineTo(): void {}

  closePath(): void {}

  arc(x: number, y: number, r: number): void {
    this.discs.push({ x, y, r });
  }
}

beforeAll(() => {
  (globalThis as { Path2D?: unknown }).Path2D = FakePath2D;
});

function dot(id: string, x: number, y: number, order: number, color = '#000000'): StrokeRecord {
  return { id, pageId: 'p', tool: 'pen', color, size: 2.5, points: [x, y, 2.5], order };
}

/** A very short mark: small enough to be drawn as a plain centreline. */
function tick(id: string, x: number, y: number, order: number, color = '#000000'): StrokeRecord {
  return { id, pageId: 'p', tool: 'pen', color, size: 1, points: [x, y, 1, x + 1, y, 1], order };
}

function paint(ctx: RecordingContext, records: StrokeRecord[], scale: number, offX: number, offY: number): void {
  const model = new StrokeModel();
  const items = records.map((record) => model.add(record));
  paintStrokeItems(ctx as unknown as StrokePaintContext, model, items, scale, offX, offY, 'light');
}

describe('painting a tapped dot', () => {
  it('fills the dot as a disc under the pointer, never as a zero-length line', () => {
    const ctx = new RecordingContext();
    // What the previous drawing left behind: the origin-relative transform of some other stroke.
    ctx.setTransform(2, 0, 0, 2, 5000, -3000);
    // Zoom 100% on a 2x display, camera at world (-80, -60).
    paint(ctx, [dot('d', 220, 140, 1)], 2, -160, -120);
    // Browsers do not reliably draw a line from a point to itself, so nothing may be stroked.
    expect(ctx.stroked).toHaveLength(0);
    // World (220, 140) is device ((220 + 80) * 2, (140 + 60) * 2); radius is half the width.
    expect(ctx.discs).toHaveLength(1);
    expect(ctx.discs[0].x).toBeCloseTo(600);
    expect(ctx.discs[0].y).toBeCloseTo(400);
    expect(ctx.discs[0].r).toBeCloseTo(2.5);
  });

  it('keeps dots in place when panned far away, zoomed out, or between other small strokes', () => {
    const ctx = new RecordingContext();
    ctx.setTransform(3, 0, 0, 3, -9999, 9999);
    // Camera at world (52000, 31000), zoom 50%, 1x display.
    paint(ctx, [tick('t1', 52100, 31100, 1), dot('far', 52400, 31300, 2), tick('t2', 52200, 31200, 3)], 0.5, 26000, 15500);
    expect(ctx.discs).toHaveLength(1);
    expect(ctx.discs[0].x).toBeCloseTo(200);
    expect(ctx.discs[0].y).toBeCloseTo(150);
    // The marks before and after the dot are still drawn, each where it belongs.
    expect(ctx.stroked.map((path) => path[0])).toEqual([
      [50, 50],
      [100, 100],
    ]);
  });

  it('treats a two-point stroke whose points coincide as a dot too', () => {
    const ctx = new RecordingContext();
    paint(ctx, [{ ...dot('d', 10, 10, 1), points: [10, 10, 2, 10, 10, 2.5] }], 1, 0, 0);
    expect(ctx.stroked).toHaveLength(0);
    expect(ctx.discs).toHaveLength(1);
  });
});

describe('painting small strokes', () => {
  it('paints a small stroke at its own position whatever transform was left on the canvas', () => {
    const ctx = new RecordingContext();
    ctx.setTransform(2, 0, 0, 2, 5000, -3000);
    paint(ctx, [tick('t', 220, 140, 1)], 2, -160, -120);
    expect(ctx.stroked).toEqual([
      [
        [600, 400],
        [602, 400],
      ],
    ]);
  });

  it('paints every stroke of a batch, and of a later batch, in the right place', () => {
    const ctx = new RecordingContext();
    ctx.setTransform(1, 0, 0, 1, 777, 777);
    paint(ctx, [tick('a', 10, 20, 1), tick('b', 30, 40, 2), tick('c', 50, 60, 3, '#e03131')], 1, 0, 0);
    // Two batches: the black marks together, then the red one.
    expect(ctx.stroked).toHaveLength(2);
    expect(ctx.stroked[0]).toEqual([
      [10, 20],
      [11, 20],
      [30, 40],
      [31, 40],
    ]);
    expect(ctx.stroked[1]).toEqual([
      [50, 60],
      [51, 60],
    ]);
  });

  it('skips hidden strokes', () => {
    const ctx = new RecordingContext();
    const model = new StrokeModel();
    const item = model.add(tick('h', 1, 1, 1));
    item.hidden = true;
    paintStrokeItems(ctx as unknown as StrokePaintContext, model, [item], 1, 0, 0, 'light');
    expect(ctx.stroked).toHaveLength(0);
  });
});
