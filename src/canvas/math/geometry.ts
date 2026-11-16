/** Pure 2D geometry helpers. No DOM dependencies. */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function emptyRect(): Rect {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function isEmptyRect(r: Rect): boolean {
  return r.minX > r.maxX || r.minY > r.maxY;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function rectContainsPoint(r: Rect, x: number, y: number): boolean {
  return x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY;
}

export function expandRect(r: Rect, amount: number): Rect {
  return {
    minX: r.minX - amount,
    minY: r.minY - amount,
    maxX: r.maxX + amount,
    maxY: r.maxY + amount,
  };
}

export function unionRect(a: Rect, b: Rect): Rect {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

export function translateRect(r: Rect, dx: number, dy: number): Rect {
  return { minX: r.minX + dx, minY: r.minY + dy, maxX: r.maxX + dx, maxY: r.maxY + dy };
}

/** Bounding box of a flat `[x, y, x, y, ...]` polygon. */
export function boundsOfPolygon(polygon: ArrayLike<number>): Rect {
  const r = emptyRect();
  for (let i = 0; i + 1 < polygon.length; i += 2) {
    const x = polygon[i];
    const y = polygon[i + 1];
    if (x < r.minX) r.minX = x;
    if (x > r.maxX) r.maxX = x;
    if (y < r.minY) r.minY = y;
    if (y > r.maxY) r.maxY = y;
  }
  return r;
}

/**
 * Even-odd point-in-polygon test (ray casting) over a flat `[x, y, ...]`
 * vertex list. The polygon is implicitly closed.
 */
export function pointInPolygon(x: number, y: number, polygon: ArrayLike<number>): boolean {
  const n = polygon.length >> 1;
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i * 2];
    const yi = polygon[i * 2 + 1];
    const xj = polygon[j * 2];
    const yj = polygon[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Squared distance from point P to segment AB. */
export function distSqPointToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  let t = lenSq > 0 ? ((px - ax) * abx + (py - ay) * aby) / lenSq : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + abx * t);
  const dy = py - (ay + aby * t);
  return dx * dx + dy * dy;
}

function orientation(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** True when segments AB and CD properly cross or touch. */
export function segmentsIntersect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const d1 = orientation(cx, cy, dx, dy, ax, ay);
  const d2 = orientation(cx, cy, dx, dy, bx, by);
  const d3 = orientation(ax, ay, bx, by, cx, cy);
  const d4 = orientation(ax, ay, bx, by, dx, dy);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  const onSegment = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    Math.min(px, qx) <= rx && rx <= Math.max(px, qx) && Math.min(py, qy) <= ry && ry <= Math.max(py, qy);
  if (d1 === 0 && onSegment(cx, cy, dx, dy, ax, ay)) return true;
  if (d2 === 0 && onSegment(cx, cy, dx, dy, bx, by)) return true;
  if (d3 === 0 && onSegment(ax, ay, bx, by, cx, cy)) return true;
  if (d4 === 0 && onSegment(ax, ay, bx, by, dx, dy)) return true;
  return false;
}

/** Squared minimum distance between segments AB and CD (0 when they intersect). */
export function distSqSegmentToSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number {
  if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    distSqPointToSegment(ax, ay, cx, cy, dx, dy),
    distSqPointToSegment(bx, by, cx, cy, dx, dy),
    distSqPointToSegment(cx, cy, ax, ay, bx, by),
    distSqPointToSegment(dx, dy, ax, ay, bx, by),
  );
}

/** Signed area of a flat polygon (positive for increasing-angle winding in y-down space). */
export function polygonSignedArea(polygon: ArrayLike<number>): number {
  const n = polygon.length >> 1;
  let sum = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    sum += polygon[j * 2] * polygon[i * 2 + 1] - polygon[i * 2] * polygon[j * 2 + 1];
  }
  return sum / 2;
}
