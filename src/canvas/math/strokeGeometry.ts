/**
 * Turns stored stroke control points into renderable geometry.
 *
 * A stroke is stored as flat `[x, y, width]` triples. For rendering it is
 * resampled along a centripetal Catmull-Rom spline into "samples"
 * (`[x, y, radius]` triples, radius = half width), and the samples are turned
 * into one closed outline polygon that is traced like a pen plotter would:
 *
 *   - forwards along one side of the stroke, around a semicircular cap whose
 *     radius is the half width at the end, backwards along the other side and
 *     around the cap at the start,
 *   - at a gentle bend both sides are mitred,
 *   - at a sharp bend the outer side follows a circular arc (round join) and
 *     the inner side passes through the centre point.
 *
 * That outline is the boundary of the union of every segment's trapezoid, the
 * pie slice on the outside of every bend and the half disc at each end, all
 * of them wound the same way. Its winding number is therefore never negative
 * and is positive exactly on the inked area, so a non-zero fill paints the
 * stroke with no holes, spikes or flat cut-offs however tightly it folds, and
 * with uniform coverage (a translucent stroke does not darken where it
 * crosses itself). Being a single contour also keeps anti-aliasing seams from
 * appearing between a cap or join and the body of the stroke.
 *
 * Snapped shapes with corners (see `shapeRecognition.ts`) skip the spline and
 * use `buildClosedOutline`, which keeps corners crisp with mitre joins.
 *
 * Everything in this module is DOM-free; `render/strokePath.ts` converts the
 * result into a `Path2D`.
 */
import type { StrokeShape } from '../../types';
import type { Rect } from './geometry';
import { boundsOfPolygon, emptyRect, polygonSignedArea } from './geometry';
import { catmullRomCentripetal, turningAngle } from './smoothing';

/** Numbers per stored control point: x, y, width. */
export const POINT_STRIDE = 3;
/** Numbers per render sample: x, y, radius. */
export const SAMPLE_STRIDE = 3;

/** Maximum distance (world units) the flattened curve may deviate from the true spline. */
const FLATNESS_TOLERANCE = 0.03;
/** Maximum turning angle (radians) absorbed by a single flattened piece. */
const MAX_PIECE_ANGLE = 0.2;
const MAX_SUBDIVISIONS = 20;

const scratch = { x: 0, y: 0 };

export function pointCount(points: ArrayLike<number>): number {
  return Math.floor(points.length / POINT_STRIDE);
}

/**
 * Number of straight pieces needed to flatten span `i` (between control points
 * `i` and `i + 1`) within tolerance. Straight spans need a single piece because
 * a trapezoid already interpolates width linearly.
 */
export function spanSubdivisions(points: ArrayLike<number>, i: number): number {
  const n = pointCount(points);
  const i0 = Math.max(i - 1, 0) * POINT_STRIDE;
  const i1 = i * POINT_STRIDE;
  const i2 = (i + 1) * POINT_STRIDE;
  const i3 = Math.min(i + 2, n - 1) * POINT_STRIDE;
  const angleIn = turningAngle(points[i0], points[i0 + 1], points[i1], points[i1 + 1], points[i2], points[i2 + 1]);
  const angleOut = turningAngle(points[i1], points[i1 + 1], points[i2], points[i2 + 1], points[i3], points[i3 + 1]);
  const turn = angleIn + angleOut;
  if (turn < 1e-3) return 1;
  const chord = Math.hypot(points[i2] - points[i1], points[i2 + 1] - points[i1 + 1]);
  // Sagitta of a chord subtending `turn` radians is about chord * turn / 8 and
  // shrinks with the square of the subdivision count.
  const byFlatness = Math.sqrt((chord * turn) / (8 * FLATNESS_TOLERANCE));
  const byAngle = turn / MAX_PIECE_ANGLE;
  const count = Math.ceil(Math.max(byFlatness, byAngle));
  return count < 1 ? 1 : count > MAX_SUBDIVISIONS ? MAX_SUBDIVISIONS : count;
}

/**
 * Appends the samples of span `i`, excluding its start point and including its
 * end point, to `out`. The neighbours `i - 1` and `i + 2` shape the curve, so a
 * span is only final once control point `i + 2` exists (or the stroke ended).
 */
export function appendSpanSamples(out: number[], points: ArrayLike<number>, i: number): void {
  const n = pointCount(points);
  const i0 = Math.max(i - 1, 0) * POINT_STRIDE;
  const i1 = i * POINT_STRIDE;
  const i2 = (i + 1) * POINT_STRIDE;
  const i3 = Math.min(i + 2, n - 1) * POINT_STRIDE;
  const r1 = points[i1 + 2] / 2;
  const r2 = points[i2 + 2] / 2;
  const subdivisions = spanSubdivisions(points, i);
  for (let s = 1; s < subdivisions; s++) {
    const u = s / subdivisions;
    catmullRomCentripetal(
      points[i0],
      points[i0 + 1],
      points[i1],
      points[i1 + 1],
      points[i2],
      points[i2 + 1],
      points[i3],
      points[i3 + 1],
      u,
      scratch,
    );
    out.push(scratch.x, scratch.y, r1 + (r2 - r1) * u);
  }
  out.push(points[i2], points[i2 + 1], r2);
}

/** Resamples a whole stroke into `[x, y, radius]` samples along the smoothed centreline. */
export function buildStrokeSamples(points: ArrayLike<number>): number[] {
  const n = pointCount(points);
  const out: number[] = [];
  if (n === 0) return out;
  out.push(points[0], points[1], points[2] / 2);
  for (let i = 0; i + 1 < n; i++) appendSpanSamples(out, points, i);
  return out;
}

export interface StrokeOutline {
  /**
   * Closed polygons as flat `[x, y, ...]` lists, to be filled together with
   * the non-zero rule. Stroke bodies have positive signed area (y-down); the
   * inner boundary of a closed shape winds the opposite way to cut the hole.
   */
  polygons: number[][];
  /** Full discs as flat `[x, y, radius]` triples (a single tap is one round dot). */
  discs: number[];
}

/** Bends up to this angle are mitred on both sides (cos of ~0.3 rad). */
const MITRE_MIN_COS = 0.955;
/** Safety factor on the "inner mitre would fold back" test. */
const FOLD_MARGIN = 1.5;
/** Largest angle (radians) spanned by one straight piece of a round cap or join. */
const ARC_STEP = 0.2;

/**
 * Appends the points of a circular arc around (`cx`, `cy`) to `out`. The arc
 * starts at the offset (`ox`, `oy`) from the centre and sweeps by `sweep`
 * radians (positive = the direction of a canvas arc with increasing angle).
 * The start point is always written; the end point only when `includeEnd`.
 */
function appendArc(
  out: number[],
  cx: number,
  cy: number,
  ox: number,
  oy: number,
  sweep: number,
  includeEnd: boolean,
): void {
  const pieces = Math.max(1, Math.ceil(Math.abs(sweep) / ARC_STEP));
  const last = includeEnd ? pieces : pieces - 1;
  for (let k = 0; k <= last; k++) {
    const a = (sweep * k) / pieces;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    out.push(cx + ox * cos - oy * sin, cy + ox * sin + oy * cos);
  }
}

/**
 * Builds the filled outline of a sampled stroke (see the module comment): one
 * polygon with round caps and round joins, or a single disc for a dot.
 */
export function buildStrokeOutline(samples: ArrayLike<number>): StrokeOutline {
  const outline: StrokeOutline = { polygons: [], discs: [] };

  // Drop consecutive duplicates so every segment has a direction.
  const xs: number[] = [];
  const ys: number[] = [];
  const rs: number[] = [];
  for (let i = 0; i + 2 < samples.length; i += SAMPLE_STRIDE) {
    const last = xs.length - 1;
    if (last >= 0 && Math.hypot(samples[i] - xs[last], samples[i + 1] - ys[last]) < 1e-9) {
      if (samples[i + 2] > rs[last]) rs[last] = samples[i + 2];
      continue;
    }
    xs.push(samples[i]);
    ys.push(samples[i + 1]);
    rs.push(samples[i + 2]);
  }
  const n = xs.length;
  if (n === 0) return outline;
  if (n === 1) {
    outline.discs.push(xs[0], ys[0], rs[0]);
    return outline;
  }

  // `minus` is the side at -normal (walked forwards), `plus` the side at +normal (walked backwards).
  const minus: number[] = [];
  const plus: number[] = [];
  let startNx = 0;
  let startNy = 0;
  let inLength = 0;
  let inNx = 0;
  let inNy = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i];
    const y = ys[i];
    const r = rs[i];
    let outLength = 0;
    let outNx = 0;
    let outNy = 0;
    if (i + 1 < n) {
      const dx = xs[i + 1] - x;
      const dy = ys[i + 1] - y;
      outLength = Math.hypot(dx, dy);
      outNx = -dy / outLength;
      outNy = dx / outLength;
    }

    if (i === 0) {
      startNx = outNx;
      startNy = outNy;
      minus.push(x - outNx * r, y - outNy * r);
      plus.push(x + outNx * r, y + outNy * r);
    } else if (i === n - 1) {
      // End cap: from the minus side, around the front of the stroke, to the plus side.
      appendArc(minus, x, y, -inNx * r, -inNy * r, Math.PI, false);
      plus.push(x + inNx * r, y + inNy * r);
    } else {
      // The normals are the directions rotated by 90 degrees, so they enclose the turning angle.
      const cos = inNx * outNx + inNy * outNy;
      const tanHalf = cos > -1 ? Math.sqrt((1 - cos) / (1 + cos)) : Infinity;
      const folds = Math.min(inLength, outLength) < r * tanHalf * FOLD_MARGIN;
      if (cos < MITRE_MIN_COS || folds) {
        const cross = inNx * outNy - inNy * outNx;
        const angle = Math.atan2(Math.abs(cross), cos);
        if (cross < 0) {
          // The plus side is the outside of the bend; rotating its normal backwards passes the front.
          appendArc(plus, x, y, inNx * r, inNy * r, -angle, true);
          minus.push(x - inNx * r, y - inNy * r, x, y, x - outNx * r, y - outNy * r);
        } else {
          appendArc(minus, x, y, -inNx * r, -inNy * r, angle, true);
          plus.push(x + inNx * r, y + inNy * r, x, y, x + outNx * r, y + outNy * r);
        }
      } else {
        // Mitre: offset along the bisector, lengthened so both adjacent edges keep their width.
        let mx = inNx + outNx;
        let my = inNy + outNy;
        const ml = Math.hypot(mx, my);
        mx /= ml;
        my /= ml;
        const reach = r / (mx * inNx + my * inNy);
        minus.push(x - mx * reach, y - my * reach);
        plus.push(x + mx * reach, y + my * reach);
      }
    }
    inLength = outLength;
    inNx = outNx;
    inNy = outNy;
  }

  const polygon = minus;
  for (let i = plus.length - 2; i >= 0; i -= 2) polygon.push(plus[i], plus[i + 1]);
  // Start cap: from the plus side, around the back of the stroke, to the minus side.
  // Its first point is the plus-side start offset that was just appended, so skip it.
  const cap: number[] = [];
  appendArc(cap, xs[0], ys[0], startNx * rs[0], startNy * rs[0], Math.PI, false);
  for (let i = 2; i < cap.length; i++) polygon.push(cap[i]);
  outline.polygons.push(polygon);
  return outline;
}

/** Whether a snapped shape is a closed outline (its first control point is repeated at the end). */
export function isClosedShape(shape: StrokeShape | undefined): boolean {
  return shape === 'rectangle' || shape === 'triangle' || shape === 'ellipse';
}

/**
 * Distinct vertices of a closed shape's control points (`[x, y, width]`
 * triples), without the repeated closing point, as flat `[x, y]` pairs.
 */
function closedVertices(points: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i + 2 < points.length; i += POINT_STRIDE) {
    const last = out.length - 2;
    if (last >= 0 && Math.hypot(points[i] - out[last], points[i + 1] - out[last + 1]) < 1e-9) continue;
    out.push(points[i], points[i + 1]);
  }
  if (out.length >= 4 && Math.hypot(out[0] - out[out.length - 2], out[1] - out[out.length - 1]) < 1e-9) {
    out.length -= 2;
  }
  return out;
}

/**
 * Offsets every vertex of a closed polygon along its mitre by `distance`
 * (positive = towards the inside of a polygon with positive signed area).
 * Returns null when a corner is too sharp for a finite mitre.
 */
function offsetClosedPolygon(vertices: readonly number[], distance: number): number[] | null {
  const n = vertices.length / 2;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const prev = ((i + n - 1) % n) * 2;
    const cur = i * 2;
    const next = ((i + 1) % n) * 2;
    const inX = vertices[cur] - vertices[prev];
    const inY = vertices[cur + 1] - vertices[prev + 1];
    const outX = vertices[next] - vertices[cur];
    const outY = vertices[next + 1] - vertices[cur + 1];
    const inLen = Math.hypot(inX, inY);
    const outLen = Math.hypot(outX, outY);
    const inNx = -inY / inLen;
    const inNy = inX / inLen;
    let mx = inNx - outY / outLen;
    let my = inNy + outX / outLen;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-6) return null;
    mx /= ml;
    my /= ml;
    const reach = distance / (mx * inNx + my * inNy);
    out.push(vertices[cur] + mx * reach, vertices[cur + 1] + my * reach);
  }
  return out;
}

/** True when every edge of `offset` still points the same way as the matching edge of `vertices`. */
function keepsEdgeDirections(vertices: readonly number[], offset: readonly number[]): boolean {
  const n = vertices.length / 2;
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    const b = ((i + 1) % n) * 2;
    const dot =
      (vertices[b] - vertices[a]) * (offset[b] - offset[a]) + (vertices[b + 1] - vertices[a + 1]) * (offset[b + 1] - offset[a + 1]);
    if (dot <= 0) return false;
  }
  return true;
}

/**
 * Builds the outline of a closed, uniform-width shape (rectangle, triangle,
 * ellipse) straight from its control points, with no spline smoothing: an
 * outer boundary and an inner boundary, each offset by half the width with
 * mitre joins, so corners stay crisp. The inner boundary winds the opposite
 * way and cuts the hole under the non-zero rule; it is left out when the pen
 * is so wide that the shape has no hole. Returns null when the points do not
 * describe a closed shape, in which case the caller falls back to the regular
 * stroke outline.
 */
export function buildClosedOutline(points: ArrayLike<number>): StrokeOutline | null {
  let vertices = closedVertices(points);
  if (vertices.length < 6) return null;
  const area = polygonSignedArea(vertices);
  if (Math.abs(area) < 1e-9) return null;
  if (area < 0) {
    // Normalise to positive winding so the offset direction is known.
    const reversed: number[] = [];
    for (let i = vertices.length - 2; i >= 0; i -= 2) reversed.push(vertices[i], vertices[i + 1]);
    vertices = reversed;
  }
  const half = strokeWidthStats(points).max / 2;
  const outer = offsetClosedPolygon(vertices, -half);
  if (!outer) return null;
  const outline: StrokeOutline = { polygons: [outer], discs: [] };
  const inner = offsetClosedPolygon(vertices, half);
  if (inner && keepsEdgeDirections(vertices, inner)) {
    const hole: number[] = [];
    for (let i = inner.length - 2; i >= 0; i -= 2) hole.push(inner[i], inner[i + 1]);
    outline.polygons.push(hole);
  }
  return outline;
}

/** Outline of a stored stroke: crisp closed outline for closed shapes, smoothed stroke otherwise. */
export function buildRecordOutline(points: ArrayLike<number>, shape?: StrokeShape): StrokeOutline {
  if (isClosedShape(shape)) {
    const closed = buildClosedOutline(points);
    if (closed) return closed;
  }
  return buildStrokeOutline(buildStrokeSamples(points));
}

/**
 * Bounding box of everything a stored stroke paints. Mitred corners of closed
 * shapes reach further than half the width, so those use the real outline.
 */
export function strokeInkBounds(points: ArrayLike<number>, shape?: StrokeShape): Rect {
  if (shape === 'rectangle' || shape === 'triangle') {
    const closed = buildClosedOutline(points);
    if (closed) return boundsOfPolygon(closed.polygons[0]);
  }
  return strokeBounds(points);
}

/** Bounding box of the inked area of a stroke (centreline expanded by half the local width). */
export function strokeBounds(points: ArrayLike<number>): Rect {
  const r = emptyRect();
  for (let i = 0; i + 2 < points.length; i += POINT_STRIDE) {
    const x = points[i];
    const y = points[i + 1];
    const half = points[i + 2] / 2;
    if (x - half < r.minX) r.minX = x - half;
    if (x + half > r.maxX) r.maxX = x + half;
    if (y - half < r.minY) r.minY = y - half;
    if (y + half > r.maxY) r.maxY = y + half;
  }
  return r;
}

export interface WidthStats {
  max: number;
  average: number;
}

export function strokeWidthStats(points: ArrayLike<number>): WidthStats {
  const n = pointCount(points);
  if (n === 0) return { max: 0, average: 0 };
  let max = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const w = points[i * POINT_STRIDE + 2];
    if (w > max) max = w;
    sum += w;
  }
  return { max, average: sum / n };
}

/** Returns a translated copy of a stroke's control points. */
export function translatePoints(points: ArrayLike<number>, dx: number, dy: number): number[] {
  const out = new Array<number>(points.length);
  for (let i = 0; i + 2 < points.length; i += POINT_STRIDE) {
    out[i] = round2(points[i] + dx);
    out[i + 1] = round2(points[i + 1] + dy);
    out[i + 2] = points[i + 2];
  }
  return out;
}

/** Rounds to two decimals; keeps stored strokes compact without visible loss at any zoom. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
