import { describe, expect, it } from 'vitest';
import {
  MAX_IMAGE_DIMENSION,
  boxContainsPoint,
  boxCoverage,
  cornerAt,
  cornerPoint,
  fitImageSize,
  resizeFromCorner,
  storedImageSize,
} from './imageGeometry';

describe('stored image size', () => {
  it('keeps images that are within the limit untouched', () => {
    expect(storedImageSize(1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(storedImageSize(MAX_IMAGE_DIMENSION, 10)).toEqual({ width: MAX_IMAGE_DIMENSION, height: 10 });
  });

  it('scales oversized images down to the limit, keeping the aspect ratio', () => {
    expect(storedImageSize(8192, 4096)).toEqual({ width: 4096, height: 2048 });
    const portrait = storedImageSize(6000, 8000);
    expect(portrait.height).toBe(4096);
    expect(portrait.width / portrait.height).toBeCloseTo(0.75, 3);
  });

  it('never produces an empty image from an extreme aspect ratio', () => {
    expect(storedImageSize(100000, 3).height).toBeGreaterThanOrEqual(1);
  });
});

describe('placing a new image', () => {
  it('shows a small image at its own size (never upscaled)', () => {
    expect(fitImageSize(200, 100, 1000, 800)).toEqual({ width: 200, height: 100 });
    // Zoomed in, the visible world area is small, but a tiny image is still not enlarged.
    expect(fitImageSize(40, 40, 120, 90)).toEqual({ width: 40, height: 40 });
  });

  it('shrinks a large image to fit within the visible area, keeping the aspect ratio', () => {
    const size = fitImageSize(4000, 3000, 1000, 800);
    expect(size.width).toBeLessThanOrEqual(1000);
    expect(size.height).toBeLessThanOrEqual(800);
    expect(size.width / size.height).toBeCloseTo(4 / 3, 6);
    // It fills a good part of the view rather than a tiny corner of it.
    expect(size.height).toBeGreaterThan(500);
  });

  it('is limited by whichever side is tighter', () => {
    const tall = fitImageSize(1000, 5000, 2000, 1000);
    expect(tall.height).toBeLessThanOrEqual(1000);
    expect(tall.width / tall.height).toBeCloseTo(0.2, 6);
  });
});

describe('resizing from a corner', () => {
  const box = { x: 100, y: 100, width: 200, height: 100 };

  it('keeps the aspect ratio and the opposite corner in place', () => {
    const grown = resizeFromCorner(box, 'se', 500, 300, 10);
    expect(grown.x).toBe(100);
    expect(grown.y).toBe(100);
    expect(grown.width / grown.height).toBeCloseTo(2, 9);
    expect(grown.width).toBeCloseTo(400);

    const fromTopLeft = resizeFromCorner(box, 'nw', 0, 50, 10);
    expect(fromTopLeft.x + fromTopLeft.width).toBeCloseTo(300);
    expect(fromTopLeft.y + fromTopLeft.height).toBeCloseTo(200);
    expect(fromTopLeft.width / fromTopLeft.height).toBeCloseTo(2, 9);
    expect(fromTopLeft.width).toBeCloseTo(300);

    const fromTopRight = resizeFromCorner(box, 'ne', 200, 150, 10);
    expect(fromTopRight.x).toBe(100);
    expect(fromTopRight.y + fromTopRight.height).toBeCloseTo(200);
    expect(fromTopRight.width).toBeCloseTo(100);

    const fromBottomLeft = resizeFromCorner(box, 'sw', 200, 150, 10);
    expect(fromBottomLeft.x + fromBottomLeft.width).toBeCloseTo(300);
    expect(fromBottomLeft.y).toBe(100);
  });

  it('leaves the box unchanged when the corner is not moved', () => {
    for (const corner of ['nw', 'ne', 'se', 'sw'] as const) {
      const point = cornerPoint(box, corner);
      const same = resizeFromCorner(box, corner, point.x, point.y, 10);
      expect(same.x).toBeCloseTo(box.x);
      expect(same.y).toBeCloseTo(box.y);
      expect(same.width).toBeCloseTo(box.width);
      expect(same.height).toBeCloseTo(box.height);
    }
  });

  it('stops at the minimum size instead of collapsing or flipping', () => {
    const tiny = resizeFromCorner(box, 'se', -500, -500, 24);
    expect(tiny.height).toBeCloseTo(24);
    expect(tiny.width).toBeCloseTo(48);
    expect(tiny.x).toBe(100);
    expect(tiny.y).toBe(100);
  });

  it('finds the corner under the pointer', () => {
    expect(cornerAt(box, 102, 97, 6)).toBe('nw');
    expect(cornerAt(box, 300, 200, 6)).toBe('se');
    expect(cornerAt(box, 296, 104, 6)).toBe('ne');
    expect(cornerAt(box, 200, 150, 6)).toBeNull();
    expect(cornerAt(box, 310, 200, 6)).toBeNull();
  });
});

describe('image hit testing', () => {
  const box = { x: 0, y: 0, width: 100, height: 50 };

  it('contains points on and inside its edges only', () => {
    expect(boxContainsPoint(box, 0, 0)).toBe(true);
    expect(boxContainsPoint(box, 100, 50)).toBe(true);
    expect(boxContainsPoint(box, 50, 25)).toBe(true);
    expect(boxContainsPoint(box, 101, 25)).toBe(false);
    expect(boxContainsPoint(box, 50, -1)).toBe(false);
  });

  it('measures how much of the image a lasso encloses', () => {
    const around = [-10, -10, 110, -10, 110, 60, -10, 60];
    const leftHalf = [-10, -10, 50, -10, 50, 60, -10, 60];
    const elsewhere = [200, 200, 300, 200, 300, 300, 200, 300];
    expect(boxCoverage(box, around)).toBe(1);
    expect(boxCoverage(box, leftHalf)).toBeGreaterThan(0.3);
    expect(boxCoverage(box, leftHalf)).toBeLessThan(0.6);
    expect(boxCoverage(box, elsewhere)).toBe(0);
  });
});
