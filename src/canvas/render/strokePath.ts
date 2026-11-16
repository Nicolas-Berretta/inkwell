/**
 * Converts stroke geometry into `Path2D` objects, filled with the non-zero rule
 * (see `math/strokeGeometry.ts`). Committed strokes, snapped shapes and the
 * stroke in progress all go through the same outline builder, so ink does not
 * change shape when a stroke is committed.
 */
import type { StrokeShape } from '../../types';
import type { StrokeOutline } from '../math/strokeGeometry';
import { SAMPLE_STRIDE, buildRecordOutline, buildStrokeOutline } from '../math/strokeGeometry';

const TAU = Math.PI * 2;

/**
 * Converts an outline into a path. Coordinates are written relative to
 * (`originX`, `originY`) so paths stay precise far from the world origin and
 * can be moved by changing only the origin.
 */
function outlineToPath(outline: StrokeOutline, originX: number, originY: number): Path2D {
  const path = new Path2D();
  for (const polygon of outline.polygons) {
    path.moveTo(polygon[0] - originX, polygon[1] - originY);
    for (let i = 2; i + 1 < polygon.length; i += 2) path.lineTo(polygon[i] - originX, polygon[i + 1] - originY);
    path.closePath();
  }
  const discs = outline.discs;
  for (let i = 0; i + 2 < discs.length; i += SAMPLE_STRIDE) {
    const x = discs[i] - originX;
    const y = discs[i + 1] - originY;
    const r = Math.max(discs[i + 2], 0.01);
    path.moveTo(x + r, y);
    path.arc(x, y, r, 0, TAU);
  }
  return path;
}

/** Builds the complete fill path of a stored stroke, relative to (`originX`, `originY`). */
export function buildStrokePath(
  points: ArrayLike<number>,
  originX: number,
  originY: number,
  shape?: StrokeShape,
): Path2D {
  return outlineToPath(buildRecordOutline(points, shape), originX, originY);
}

/** Builds the fill path of already sampled `[x, y, radius]` triples (the stroke in progress). */
export function buildSamplesPath(samples: ArrayLike<number>, originX: number, originY: number): Path2D {
  return outlineToPath(buildStrokeOutline(samples), originX, originY);
}
