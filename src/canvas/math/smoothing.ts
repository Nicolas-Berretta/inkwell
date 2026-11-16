/**
 * Centripetal Catmull-Rom spline evaluation (Barry-Goldman formulation).
 *
 * The centripetal parameterisation (alpha = 0.5) is used because, unlike the
 * uniform variant, it never produces cusps or self-intersections inside a
 * span, which is exactly the artefact that makes fast handwriting look kinked.
 */
import type { Vec2 } from './geometry';

const KNOT_EPSILON = 1e-4;

function knotInterval(ax: number, ay: number, bx: number, by: number): number {
  // distance^alpha with alpha = 0.5  ->  (dx^2 + dy^2)^(1/4)
  const d = Math.sqrt(Math.hypot(bx - ax, by - ay));
  return d > KNOT_EPSILON ? d : KNOT_EPSILON;
}

/**
 * Evaluates the spline segment between P1 and P2 at `u` in [0, 1].
 * P0 and P3 are the neighbouring control points (duplicate the end points at
 * the extremities of a stroke). The result is written into `out`.
 */
export function catmullRomCentripetal(
  p0x: number,
  p0y: number,
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
  p3x: number,
  p3y: number,
  u: number,
  out: Vec2,
): Vec2 {
  const t0 = 0;
  const t1 = t0 + knotInterval(p0x, p0y, p1x, p1y);
  const t2 = t1 + knotInterval(p1x, p1y, p2x, p2y);
  const t3 = t2 + knotInterval(p2x, p2y, p3x, p3y);
  const t = t1 + u * (t2 - t1);

  const a1w = (t - t0) / (t1 - t0);
  const a1x = p0x + (p1x - p0x) * a1w;
  const a1y = p0y + (p1y - p0y) * a1w;
  const a2w = (t - t1) / (t2 - t1);
  const a2x = p1x + (p2x - p1x) * a2w;
  const a2y = p1y + (p2y - p1y) * a2w;
  const a3w = (t - t2) / (t3 - t2);
  const a3x = p2x + (p3x - p2x) * a3w;
  const a3y = p2y + (p3y - p2y) * a3w;

  const b1w = (t - t0) / (t2 - t0);
  const b1x = a1x + (a2x - a1x) * b1w;
  const b1y = a1y + (a2y - a1y) * b1w;
  const b2w = (t - t1) / (t3 - t1);
  const b2x = a2x + (a3x - a2x) * b2w;
  const b2y = a2y + (a3y - a2y) * b2w;

  const cw = (t - t1) / (t2 - t1);
  out.x = b1x + (b2x - b1x) * cw;
  out.y = b1y + (b2y - b1y) * cw;
  return out;
}

/** Unsigned turning angle (radians) between vectors A->B and B->C; 0 for degenerate input. */
export function turningAngle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const ux = bx - ax;
  const uy = by - ay;
  const vx = cx - bx;
  const vy = cy - by;
  const lu = Math.hypot(ux, uy);
  const lv = Math.hypot(vx, vy);
  if (lu < 1e-9 || lv < 1e-9) return 0;
  const cos = (ux * vx + uy * vy) / (lu * lv);
  return Math.acos(cos > 1 ? 1 : cos < -1 ? -1 : cos);
}

/** Exponential low-pass step: moves `previous` towards `target` by `factor` (0..1). */
export function lowPass(previous: number, target: number, factor: number): number {
  return previous + (target - previous) * factor;
}
