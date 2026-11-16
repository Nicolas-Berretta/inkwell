/**
 * Geometry for images placed on the page: how large an image is stored and
 * shown, resizing from a corner while keeping the aspect ratio, and hit
 * testing. Pure and DOM-free.
 */
import type { Rect } from './geometry';
import { pointInPolygon } from './geometry';

/** Images whose longest side exceeds this many pixels are scaled down before they are stored. */
export const MAX_IMAGE_DIMENSION = 4096;
/** Image files larger than this are re-encoded before they are stored, even when their dimensions fit. */
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
/** Share of the viewport a newly inserted image may fill. */
const INSERT_VIEWPORT_SHARE = 0.8;

export interface Size {
  width: number;
  height: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Pixel size an image is stored at: unchanged unless its longest side exceeds `maxDimension`. */
export function storedImageSize(width: number, height: number, maxDimension = MAX_IMAGE_DIMENSION): Size {
  const longest = Math.max(width, height);
  if (longest <= maxDimension) return { width, height };
  const scale = maxDimension / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Size, in world units, at which a new image is placed: small enough to fit
 * comfortably in the visible part of the page and never larger than its own
 * pixels (one image pixel per world unit), so it is never upscaled.
 */
export function fitImageSize(naturalWidth: number, naturalHeight: number, viewWidth: number, viewHeight: number): Size {
  const scale = Math.min(
    1,
    (viewWidth * INSERT_VIEWPORT_SHARE) / naturalWidth,
    (viewHeight * INSERT_VIEWPORT_SHARE) / naturalHeight,
  );
  return { width: naturalWidth * scale, height: naturalHeight * scale };
}

export type Corner = 'nw' | 'ne' | 'se' | 'sw';

export const CORNERS: readonly Corner[] = ['nw', 'ne', 'se', 'sw'];

export function cornerPoint(box: Box, corner: Corner): { x: number; y: number } {
  return {
    x: corner === 'nw' || corner === 'sw' ? box.x : box.x + box.width,
    y: corner === 'nw' || corner === 'ne' ? box.y : box.y + box.height,
  };
}

/** The corner of `box` within `reach` of the point, if any. */
export function cornerAt(box: Box, x: number, y: number, reach: number): Corner | null {
  for (const corner of CORNERS) {
    const point = cornerPoint(box, corner);
    if (Math.abs(point.x - x) <= reach && Math.abs(point.y - y) <= reach) return corner;
  }
  return null;
}

/**
 * Resizes `box` by dragging one corner to the point, keeping the aspect ratio
 * and the opposite corner in place. The box never becomes smaller than
 * `minSize` on its shorter side and never flips.
 */
export function resizeFromCorner(box: Box, corner: Corner, x: number, y: number, minSize: number): Box {
  const signX = corner === 'ne' || corner === 'se' ? 1 : -1;
  const signY = corner === 'se' || corner === 'sw' ? 1 : -1;
  const anchorX = signX > 0 ? box.x : box.x + box.width;
  const anchorY = signY > 0 ? box.y : box.y + box.height;
  // The dragged corner follows whichever axis asks for the larger image.
  const scale = Math.max(
    ((x - anchorX) * signX) / box.width,
    ((y - anchorY) * signY) / box.height,
    minSize / Math.min(box.width, box.height),
  );
  const width = box.width * scale;
  const height = box.height * scale;
  return {
    x: signX > 0 ? anchorX : anchorX - width,
    y: signY > 0 ? anchorY : anchorY - height,
    width,
    height,
  };
}

export function boxContainsPoint(box: Box, x: number, y: number): boolean {
  return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
}

export function boxToRect(box: Box): Rect {
  return { minX: box.x, minY: box.y, maxX: box.x + box.width, maxY: box.y + box.height };
}

/** Fraction (0..1) of a box that lies inside the polygon, estimated on a 5 x 5 grid of points. */
export function boxCoverage(box: Box, polygon: ArrayLike<number>): number {
  const steps = 5;
  let inside = 0;
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) {
      const x = box.x + (box.width * (i + 0.5)) / steps;
      const y = box.y + (box.height * (j + 0.5)) / steps;
      if (pointInPolygon(x, y, polygon)) inside++;
    }
  }
  return inside / (steps * steps);
}
