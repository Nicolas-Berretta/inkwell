/**
 * Hit testing between tools and stroke centrelines (flat `[x, y, width]` triples).
 * Pure math; candidate strokes are narrowed down by the spatial index first.
 */
import { distSqPointToSegment, distSqSegmentToSegment, pointInPolygon } from './geometry';
import { POINT_STRIDE, pointCount } from './strokeGeometry';

/**
 * True when the capsule swept from A to B with the given radius touches the
 * inked area of the stroke. Used by the eraser, which sweeps a disc between
 * consecutive pointer positions so fast movements cannot skip over strokes.
 */
export function strokeTouchesCapsule(
  points: ArrayLike<number>,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  radius: number,
): boolean {
  const n = pointCount(points);
  if (n === 0) return false;
  if (n === 1) {
    const reach = radius + points[2] / 2;
    return distSqPointToSegment(points[0], points[1], ax, ay, bx, by) <= reach * reach;
  }
  for (let i = 0; i + 1 < n; i++) {
    const o = i * POINT_STRIDE;
    const reach = radius + Math.max(points[o + 2], points[o + 5]) / 2;
    const d = distSqSegmentToSegment(points[o], points[o + 1], points[o + 3], points[o + 4], ax, ay, bx, by);
    if (d <= reach * reach) return true;
  }
  return false;
}

/** True when the point lies on (or within `tolerance` of) the inked area of the stroke. */
export function strokeContainsPoint(points: ArrayLike<number>, x: number, y: number, tolerance: number): boolean {
  return strokeTouchesCapsule(points, x, y, x, y, tolerance);
}

/** Fraction (0..1) of a stroke's control points that lie inside the polygon. */
export function fractionInsidePolygon(points: ArrayLike<number>, polygon: ArrayLike<number>): number {
  const n = pointCount(points);
  if (n === 0) return 0;
  let inside = 0;
  for (let i = 0; i < n; i++) {
    if (pointInPolygon(points[i * POINT_STRIDE], points[i * POINT_STRIDE + 1], polygon)) inside++;
  }
  return inside / n;
}

/** Share of a stroke that must be enclosed by the lasso for it to be selected. */
export const LASSO_COVERAGE = 0.6;

export function lassoSelectsStroke(points: ArrayLike<number>, polygon: ArrayLike<number>): boolean {
  return fractionInsidePolygon(points, polygon) >= LASSO_COVERAGE;
}
