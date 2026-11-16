/**
 * Recognises the geometric shape a rough, hand-drawn stroke was meant to be:
 * a straight line, a rectangle, an ellipse or a triangle ("hold to snap").
 *
 * The approach is template fitting rather than corner detection, because
 * hand-drawn corners are rounded and noisy:
 *
 *   1. The path is resampled evenly along its length.
 *   2. An open path can only be a line: it must stay close to the chord
 *      between its end points and not be much longer than that chord.
 *   3. A path whose ends meet (allowing a small gap or an overshoot) is
 *      fitted against each closed template. A template is accepted only when
 *      the path stays close to it on average and at worst, reaches every
 *      corner, covers its whole outline and is about as long as its
 *      perimeter. The best-fitting accepted template wins.
 *
 * Every threshold is relative to the size of the drawing, so recognition does
 * not depend on zoom. When nothing fits with confidence the result is `null`
 * and the stroke stays freehand: a false snap is worse than no snap.
 *
 * Pure and DOM-free. Paths are flat `[x, y, x, y, ...]` lists.
 */
import { distSqPointToSegment } from './geometry';

export type RecognizedShape =
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'rectangle'; minX: number; minY: number; maxX: number; maxY: number }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number; rotation: number }
  | { kind: 'triangle'; vertices: number[] };

export interface RecognitionOptions {
  /** Smallest extent (same units as the path) of a drawing that counts as intentional. */
  minSize: number;
}

/** Number of evenly spaced points the path is reduced to. */
const RESAMPLE_COUNT = 96;

/** A line may be at most this much longer than the chord between its ends. */
const LINE_MAX_LENGTH_RATIO = 1.12;
/** Largest distance from the chord, as a fraction of the chord length. */
const LINE_MAX_DEVIATION = 0.06;
/** Lines and edges within this angle of horizontal / vertical are made exact. */
const AXIS_SNAP_RADIANS = (5 * Math.PI) / 180;

/** Share of the path at each end that is searched for the point where the outline closes. */
const CLOSE_SEARCH_SHARE = 0.15;
/** Largest gap between the closing points, as a fraction of the path length. */
const CLOSE_MAX_GAP = 0.1;

/** Mean distance from the template, in units of the template scale (perimeter / 8). */
const POLYGON_MAX_MEAN_ERROR = 0.06;
const ELLIPSE_MAX_MEAN_ERROR = 0.07;
/** Worst distance from the template, in units of the template scale. */
const MAX_POINT_ERROR = 0.45;
const ELLIPSE_MAX_POINT_ERROR = 0.3;
/** A template point counts as drawn when the path passes within this many scale units. */
const COVERAGE_REACH = 0.3;
/** Share of the template outline that must be drawn. */
const MIN_COVERAGE = 0.9;
const COVERAGE_SAMPLES = 48;
/** Allowed ratio of path length to template perimeter (rejects doubled or squiggly outlines). */
const MIN_LENGTH_RATIO = 0.75;
const MAX_LENGTH_RATIO = 1.25;

/** Sides that differ by less than this fraction make a square / circle. */
const REGULAR_SNAP = 0.12;
/** Ellipses rounder than this have no reliable orientation and are kept axis-aligned. */
const ELLIPSE_MIN_ROTATED_ASPECT = 1.25;
const ELLIPSE_AXIS_SNAP_RADIANS = (10 * Math.PI) / 180;
/** Triangles with a sharper corner than this are not recognised. */
const TRIANGLE_MIN_ANGLE = (20 * Math.PI) / 180;
/** Share of each end of a side ignored when fitting that side (corners are rounded by hand). */
const SIDE_FIT_TRIM = 0.15;

/** Largest distance (world units) between an ellipse and the polygon that approximates it. */
const ELLIPSE_FLATNESS = 0.02;
const ELLIPSE_MIN_POINTS = 32;
const ELLIPSE_MAX_POINTS = 256;

function pathLength(path: ArrayLike<number>): number {
  let length = 0;
  for (let i = 2; i + 1 < path.length; i += 2) length += Math.hypot(path[i] - path[i - 2], path[i + 1] - path[i - 1]);
  return length;
}

/** Resamples a path to `count` points spaced evenly along its length. */
export function resamplePath(path: ArrayLike<number>, count: number): number[] {
  const n = Math.floor(path.length / 2);
  const out: number[] = [];
  if (n === 0 || count < 2) return out;
  const total = pathLength(path);
  if (total < 1e-9) {
    for (let k = 0; k < count; k++) out.push(path[0], path[1]);
    return out;
  }
  const step = total / (count - 1);
  out.push(path[0], path[1]);
  let travelled = 0;
  let target = step;
  for (let i = 1; i < n && out.length < count * 2; i++) {
    const ax = path[(i - 1) * 2];
    const ay = path[(i - 1) * 2 + 1];
    const bx = path[i * 2];
    const by = path[i * 2 + 1];
    const segment = Math.hypot(bx - ax, by - ay);
    while (segment > 0 && travelled + segment >= target && out.length < (count - 1) * 2) {
      const t = (target - travelled) / segment;
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t);
      target += step;
    }
    travelled += segment;
  }
  while (out.length < count * 2) out.push(path[(n - 1) * 2], path[(n - 1) * 2 + 1]);
  return out;
}

/** Makes a line exactly horizontal or vertical when it is within a few degrees of it. */
export function snapLineEnd(x1: number, y1: number, x2: number, y2: number): { x: number; y: number } {
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  const slope = Math.tan(AXIS_SNAP_RADIANS);
  if (dy <= dx * slope) return { x: x2, y: y1 };
  if (dx <= dy * slope) return { x: x1, y: y2 };
  return { x: x2, y: y2 };
}

function recognizeLine(points: readonly number[], length: number, minSize: number): RecognizedShape | null {
  const last = points.length - 2;
  const x1 = points[0];
  const y1 = points[1];
  const x2 = points[last];
  const y2 = points[last + 1];
  const chord = Math.hypot(x2 - x1, y2 - y1);
  if (chord < minSize || length > chord * LINE_MAX_LENGTH_RATIO) return null;
  const limit = chord * LINE_MAX_DEVIATION;
  for (let i = 2; i < last; i += 2) {
    if (distSqPointToSegment(points[i], points[i + 1], x1, y1, x2, y2) > limit * limit) return null;
  }
  const end = snapLineEnd(x1, y1, x2, y2);
  return { kind: 'line', x1, y1, x2: end.x, y2: end.y };
}

/**
 * Returns the part of the path that forms a closed outline (dropping a short
 * lead-in or overshoot), or null when the ends do not meet.
 */
function closedPart(points: readonly number[], length: number): number[] | null {
  const n = points.length / 2;
  const span = Math.max(1, Math.floor(n * CLOSE_SEARCH_SHARE));
  let best = Infinity;
  let bestStart = 0;
  let bestEnd = n - 1;
  for (let i = 0; i < span; i++) {
    for (let j = n - span; j < n; j++) {
      const d = Math.hypot(points[i * 2] - points[j * 2], points[i * 2 + 1] - points[j * 2 + 1]);
      // Prefer keeping as much of the path as possible when two closings are equally good.
      if (d < best - 1e-9) {
        best = d;
        bestStart = i;
        bestEnd = j;
      }
    }
  }
  if (best > length * CLOSE_MAX_GAP) return null;
  return points.slice(bestStart * 2, (bestEnd + 1) * 2);
}

interface Fit {
  shape: RecognizedShape;
  error: number;
}

function distanceToPolygon(x: number, y: number, vertices: readonly number[]): number {
  const n = vertices.length / 2;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    const b = ((i + 1) % n) * 2;
    const d = distSqPointToSegment(x, y, vertices[a], vertices[a + 1], vertices[b], vertices[b + 1]);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

function distanceToPath(x: number, y: number, points: readonly number[]): number {
  let best = Infinity;
  for (let i = 0; i < points.length; i += 2) {
    const d = Math.hypot(points[i] - x, points[i + 1] - y);
    if (d < best) best = d;
  }
  return best;
}

function polygonPerimeter(vertices: readonly number[]): number {
  const n = vertices.length / 2;
  let perimeter = 0;
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    const b = ((i + 1) % n) * 2;
    perimeter += Math.hypot(vertices[b] - vertices[a], vertices[b + 1] - vertices[a + 1]);
  }
  return perimeter;
}

/**
 * Scores how well a closed path matches a polygon template. Returns the mean
 * distance in scale units, or null when the path fails one of the hard
 * requirements (worst distance, corners reached, outline covered, length).
 */
function polygonFitError(points: readonly number[], length: number, vertices: readonly number[]): number | null {
  const perimeter = polygonPerimeter(vertices);
  if (perimeter < 1e-9) return null;
  const ratio = length / perimeter;
  if (ratio < MIN_LENGTH_RATIO || ratio > MAX_LENGTH_RATIO) return null;
  const scale = perimeter / 8;

  let sum = 0;
  for (let i = 0; i < points.length; i += 2) {
    const d = distanceToPolygon(points[i], points[i + 1], vertices);
    if (d > scale * MAX_POINT_ERROR) return null;
    sum += d;
  }

  const reach = scale * COVERAGE_REACH;
  const n = vertices.length / 2;
  for (let i = 0; i < n; i++) {
    if (distanceToPath(vertices[i * 2], vertices[i * 2 + 1], points) > reach) return null;
  }
  let covered = 0;
  let sampled = 0;
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    const b = ((i + 1) % n) * 2;
    const side = Math.hypot(vertices[b] - vertices[a], vertices[b + 1] - vertices[a + 1]);
    const samples = Math.max(2, Math.round((side / perimeter) * COVERAGE_SAMPLES));
    for (let k = 0; k < samples; k++) {
      const t = (k + 0.5) / samples;
      const x = vertices[a] + (vertices[b] - vertices[a]) * t;
      const y = vertices[a + 1] + (vertices[b + 1] - vertices[a + 1]) * t;
      sampled++;
      if (distanceToPath(x, y, points) <= reach) covered++;
    }
  }
  if (covered / sampled < MIN_COVERAGE) return null;
  return sum / (points.length / 2) / scale;
}

function fitRectangle(points: readonly number[], length: number): Fit | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    if (points[i] < minX) minX = points[i];
    if (points[i] > maxX) maxX = points[i];
    if (points[i + 1] < minY) minY = points[i + 1];
    if (points[i + 1] > maxY) maxY = points[i + 1];
  }
  const width = maxX - minX;
  const height = maxY - minY;
  if (width < 1e-9 || height < 1e-9) return null;

  // The bounding box follows the wobbliest point of each side; average the
  // middle part of every side instead (corners are excluded, they are rounded).
  const sums = [0, 0, 0, 0];
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i];
    const y = points[i + 1];
    const distances = [y - minY, maxX - x, maxY - y, x - minX];
    let side = 0;
    for (let s = 1; s < 4; s++) if (distances[s] < distances[side]) side = s;
    const horizontal = side === 0 || side === 2;
    const along = horizontal ? (x - minX) / width : (y - minY) / height;
    if (along < SIDE_FIT_TRIM || along > 1 - SIDE_FIT_TRIM) continue;
    sums[side] += horizontal ? y : x;
    counts[side]++;
  }
  if (counts.some((count) => count === 0)) return null;
  let top = sums[0] / counts[0];
  let right = sums[1] / counts[1];
  let bottom = sums[2] / counts[2];
  let left = sums[3] / counts[3];
  if (right - left < 1e-9 || bottom - top < 1e-9) return null;

  const w = right - left;
  const h = bottom - top;
  if (Math.abs(w - h) <= Math.max(w, h) * REGULAR_SNAP) {
    const half = (w + h) / 4;
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    left = cx - half;
    right = cx + half;
    top = cy - half;
    bottom = cy + half;
  }
  const vertices = [left, top, right, top, right, bottom, left, bottom];
  const error = polygonFitError(points, length, vertices);
  if (error === null || error > POLYGON_MAX_MEAN_ERROR) return null;
  return { shape: { kind: 'rectangle', minX: left, minY: top, maxX: right, maxY: bottom }, error };
}

/** Ramanujan's approximation of the circumference of an ellipse. */
function ellipsePerimeter(a: number, b: number): number {
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}

function fitEllipse(points: readonly number[], length: number): Fit | null {
  const n = points.length / 2;
  let meanX = 0;
  let meanY = 0;
  for (let i = 0; i < points.length; i += 2) {
    meanX += points[i];
    meanY += points[i + 1];
  }
  meanX /= n;
  meanY /= n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < points.length; i += 2) {
    const dx = points[i] - meanX;
    const dy = points[i + 1] - meanY;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  // Orientation of the major axis from the covariance of the outline points.
  let rotation = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const spread = Math.sqrt((sxx - syy) * (sxx - syy) + 4 * sxy * sxy);
  const major = (sxx + syy + spread) / 2;
  const minor = (sxx + syy - spread) / 2;
  const aspect = minor > 1e-9 ? Math.sqrt(major / minor) : Infinity;
  if (aspect < ELLIPSE_MIN_ROTATED_ASPECT) {
    rotation = 0;
  } else {
    // Snap to the nearest axis when close, so most ellipses come out upright.
    const quarter = Math.PI / 2;
    const nearest = Math.round(rotation / quarter) * quarter;
    // Adding zero turns a negative zero from the rounding into a plain zero.
    if (Math.abs(rotation - nearest) <= ELLIPSE_AXIS_SNAP_RADIANS) rotation = nearest + 0;
  }

  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    const u = points[i] * cos + points[i + 1] * sin;
    const v = -points[i] * sin + points[i + 1] * cos;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  let rx = (maxU - minU) / 2;
  let ry = (maxV - minV) / 2;
  if (rx < 1e-9 || ry < 1e-9) return null;
  const centreU = (minU + maxU) / 2;
  const centreV = (minV + maxV) / 2;

  const ratio = length / ellipsePerimeter(rx, ry);
  if (ratio < MIN_LENGTH_RATIO || ratio > MAX_LENGTH_RATIO) return null;

  const bins = new Array<boolean>(COVERAGE_SAMPLES).fill(false);
  let sum = 0;
  for (let i = 0; i < points.length; i += 2) {
    const u = (points[i] * cos + points[i + 1] * sin - centreU) / rx;
    const v = (-points[i] * sin + points[i + 1] * cos - centreV) / ry;
    const deviation = Math.abs(Math.hypot(u, v) - 1);
    if (deviation > ELLIPSE_MAX_POINT_ERROR) return null;
    sum += deviation;
    const turn = (Math.atan2(v, u) + Math.PI) / (2 * Math.PI);
    bins[Math.min(COVERAGE_SAMPLES - 1, Math.floor(turn * COVERAGE_SAMPLES))] = true;
  }
  const error = sum / n;
  if (error > ELLIPSE_MAX_MEAN_ERROR) return null;
  // 96 points over 48 angular bins: a gap in the bins is a part of the outline that was not drawn.
  if (bins.filter(Boolean).length / COVERAGE_SAMPLES < MIN_COVERAGE) return null;

  if (Math.abs(rx - ry) <= Math.max(rx, ry) * REGULAR_SNAP) {
    rx = ry = (rx + ry) / 2;
    rotation = 0;
  } else if (Math.abs(Math.abs(rotation) - Math.PI / 2) < 1e-9) {
    // Express an upright ellipse without a rotation.
    [rx, ry] = [ry, rx];
    rotation = 0;
  }
  const cx = centreU * cos - centreV * sin;
  const cy = centreU * sin + centreV * cos;
  return { shape: { kind: 'ellipse', cx, cy, rx, ry, rotation }, error };
}

/** Convex hull (Andrew's monotone chain) as indices into the flat point list. */
function convexHull(points: readonly number[]): number[] {
  const n = points.length / 2;
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => points[a * 2] - points[b * 2] || points[a * 2 + 1] - points[b * 2 + 1],
  );
  const cross = (o: number, a: number, b: number) =>
    (points[a * 2] - points[o * 2]) * (points[b * 2 + 1] - points[o * 2 + 1]) -
    (points[a * 2 + 1] - points[o * 2 + 1]) * (points[b * 2] - points[o * 2]);
  const hull: number[] = [];
  for (const i of order) {
    while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], i) <= 0) hull.pop();
    hull.push(i);
  }
  const lower = hull.length + 1;
  for (let k = order.length - 2; k >= 0; k--) {
    const i = order[k];
    while (hull.length >= lower && cross(hull[hull.length - 2], hull[hull.length - 1], i) <= 0) hull.pop();
    hull.push(i);
  }
  hull.pop();
  return hull;
}

interface FittedLine {
  x: number;
  y: number;
  dx: number;
  dy: number;
}

/** Total-least-squares line through the points nearest to side `side` of the triangle, corners excluded. */
function fitTriangleSide(points: readonly number[], vertices: readonly number[], side: number): FittedLine | null {
  const ax = vertices[side * 2];
  const ay = vertices[side * 2 + 1];
  const bx = vertices[((side + 1) % 3) * 2];
  const by = vertices[((side + 1) % 3) * 2 + 1];
  const lengthSq = (bx - ax) * (bx - ax) + (by - ay) * (by - ay);
  if (lengthSq < 1e-9) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i];
    const y = points[i + 1];
    const t = ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / lengthSq;
    if (t < SIDE_FIT_TRIM || t > 1 - SIDE_FIT_TRIM) continue;
    const own = distSqPointToSegment(x, y, ax, ay, bx, by);
    let nearest = true;
    for (let other = 0; other < 3 && nearest; other++) {
      if (other === side) continue;
      const ox = vertices[other * 2];
      const oy = vertices[other * 2 + 1];
      const px = vertices[((other + 1) % 3) * 2];
      const py = vertices[((other + 1) % 3) * 2 + 1];
      if (distSqPointToSegment(x, y, ox, oy, px, py) < own) nearest = false;
    }
    if (nearest) {
      xs.push(x);
      ys.push(y);
    }
  }
  if (xs.length < 3) return null;
  let meanX = 0;
  let meanY = 0;
  for (let i = 0; i < xs.length; i++) {
    meanX += xs[i];
    meanY += ys[i];
  }
  meanX /= xs.length;
  meanY /= xs.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxx += (xs[i] - meanX) * (xs[i] - meanX);
    syy += (ys[i] - meanY) * (ys[i] - meanY);
    sxy += (xs[i] - meanX) * (ys[i] - meanY);
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { x: meanX, y: meanY, dx: Math.cos(angle), dy: Math.sin(angle) };
}

function triangleAngles(v: readonly number[]): number[] {
  const angles: number[] = [];
  for (let i = 0; i < 3; i++) {
    const p = i * 2;
    const a = ((i + 1) % 3) * 2;
    const b = ((i + 2) % 3) * 2;
    const ux = v[a] - v[p];
    const uy = v[a + 1] - v[p + 1];
    const wx = v[b] - v[p];
    const wy = v[b + 1] - v[p + 1];
    const cos = (ux * wx + uy * wy) / (Math.hypot(ux, uy) * Math.hypot(wx, wy));
    angles.push(Math.acos(Math.max(-1, Math.min(1, cos))));
  }
  return angles;
}

function fitTriangle(points: readonly number[], length: number): Fit | null {
  const hull = convexHull(points);
  if (hull.length < 3) return null;
  // The corners of a drawn triangle are (close to) the three hull points spanning the largest area.
  let bestArea = 0;
  let corners: [number, number, number] | null = null;
  for (let a = 0; a < hull.length; a++) {
    for (let b = a + 1; b < hull.length; b++) {
      for (let c = b + 1; c < hull.length; c++) {
        const ia = hull[a] * 2;
        const ib = hull[b] * 2;
        const ic = hull[c] * 2;
        const area = Math.abs(
          (points[ib] - points[ia]) * (points[ic + 1] - points[ia + 1]) -
            (points[ib + 1] - points[ia + 1]) * (points[ic] - points[ia]),
        );
        if (area > bestArea) {
          bestArea = area;
          corners = [ia, ib, ic];
        }
      }
    }
  }
  if (!corners || bestArea < 1e-9) return null;
  const rough: number[] = [];
  for (const index of corners) rough.push(points[index], points[index + 1]);

  // Hand-drawn corners are rounded, so the hull corners sit slightly inside the
  // intended ones: fit a line to each side and intersect neighbouring lines.
  const sides = [fitTriangleSide(points, rough, 0), fitTriangleSide(points, rough, 1), fitTriangleSide(points, rough, 2)];
  const limit = (polygonPerimeter(rough) / 8) * MAX_POINT_ERROR;
  const vertices = rough.slice();
  for (let i = 0; i < 3; i++) {
    // Vertex i is where side i-1 (ending there) meets side i (starting there).
    const first = sides[(i + 2) % 3];
    const second = sides[i];
    if (!first || !second) continue;
    const denominator = first.dx * second.dy - first.dy * second.dx;
    if (Math.abs(denominator) < 0.2) continue;
    const t = ((second.x - first.x) * second.dy - (second.y - first.y) * second.dx) / denominator;
    const x = first.x + first.dx * t;
    const y = first.y + first.dy * t;
    if (Math.hypot(x - rough[i * 2], y - rough[i * 2 + 1]) <= limit) {
      vertices[i * 2] = x;
      vertices[i * 2 + 1] = y;
    }
  }

  // Make nearly horizontal / vertical sides exact.
  const slope = Math.tan(AXIS_SNAP_RADIANS);
  for (let i = 0; i < 3; i++) {
    const a = i * 2;
    const b = ((i + 1) % 3) * 2;
    const dx = Math.abs(vertices[b] - vertices[a]);
    const dy = Math.abs(vertices[b + 1] - vertices[a + 1]);
    if (dy <= dx * slope) {
      vertices[a + 1] = vertices[b + 1] = (vertices[a + 1] + vertices[b + 1]) / 2;
    } else if (dx <= dy * slope) {
      vertices[a] = vertices[b] = (vertices[a] + vertices[b]) / 2;
    }
  }

  if (Math.min(...triangleAngles(vertices)) < TRIANGLE_MIN_ANGLE) return null;
  const error = polygonFitError(points, length, vertices);
  if (error === null || error > POLYGON_MAX_MEAN_ERROR) return null;
  return { shape: { kind: 'triangle', vertices }, error };
}

/**
 * Returns the shape a hand-drawn path was meant to be, or null when it does
 * not clearly look like a line, rectangle, ellipse or triangle.
 */
export function recognizeShape(path: ArrayLike<number>, options: RecognitionOptions): RecognizedShape | null {
  if (path.length < 4) return null;
  for (let i = 0; i < path.length; i++) if (!Number.isFinite(path[i])) return null;
  const length = pathLength(path);
  if (length < options.minSize) return null;
  const points = resamplePath(path, RESAMPLE_COUNT);

  const line = recognizeLine(points, length, options.minSize);
  if (line) return line;

  const part = closedPart(points, length);
  if (!part) return null;
  const outlineLength = pathLength(part);
  const outline = resamplePath(part, RESAMPLE_COUNT);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < outline.length; i += 2) {
    if (outline[i] < minX) minX = outline[i];
    if (outline[i] > maxX) maxX = outline[i];
    if (outline[i + 1] < minY) minY = outline[i + 1];
    if (outline[i + 1] > maxY) maxY = outline[i + 1];
  }
  const width = maxX - minX;
  const height = maxY - minY;
  if (Math.max(width, height) < options.minSize || Math.min(width, height) < options.minSize / 2) return null;

  let best: Fit | null = null;
  for (const fit of [fitRectangle(outline, outlineLength), fitEllipse(outline, outlineLength), fitTriangle(outline, outlineLength)]) {
    if (fit && (!best || fit.error < best.error)) best = fit;
  }
  return best ? best.shape : null;
}

/**
 * Vertices of a recognised shape as a flat `[x, y, ...]` list: the two ends of
 * a line, or the outline of a closed shape with its first point repeated at
 * the end. Ellipses are approximated by enough points to look smooth.
 */
export function shapeVertices(shape: RecognizedShape): number[] {
  switch (shape.kind) {
    case 'line':
      return [shape.x1, shape.y1, shape.x2, shape.y2];
    case 'rectangle':
      return [
        shape.minX,
        shape.minY,
        shape.maxX,
        shape.minY,
        shape.maxX,
        shape.maxY,
        shape.minX,
        shape.maxY,
        shape.minX,
        shape.minY,
      ];
    case 'triangle':
      return [...shape.vertices, shape.vertices[0], shape.vertices[1]];
    case 'ellipse': {
      const radius = Math.max(shape.rx, shape.ry);
      const halfStep = Math.acos(Math.max(-1, 1 - ELLIPSE_FLATNESS / radius));
      const wanted = halfStep > 0 ? Math.ceil(Math.PI / halfStep) : ELLIPSE_MAX_POINTS;
      const count = Math.min(ELLIPSE_MAX_POINTS, Math.max(ELLIPSE_MIN_POINTS, wanted));
      const cos = Math.cos(shape.rotation);
      const sin = Math.sin(shape.rotation);
      const out: number[] = [];
      for (let k = 0; k < count; k++) {
        const a = (k / count) * Math.PI * 2;
        const u = shape.rx * Math.cos(a);
        const v = shape.ry * Math.sin(a);
        out.push(shape.cx + u * cos - v * sin, shape.cy + u * sin + v * cos);
      }
      out.push(out[0], out[1]);
      return out;
    }
  }
}
