import { describe, expect, it } from 'vitest';
import {
  boundsOfPolygon,
  distSqPointToSegment,
  distSqSegmentToSegment,
  pointInPolygon,
  polygonSignedArea,
  rectsIntersect,
  segmentsIntersect,
} from './geometry';

describe('pointInPolygon', () => {
  const square = [0, 0, 10, 0, 10, 10, 0, 10];
  // "C" shape: a square with a notch cut into its right side.
  const concave = [0, 0, 10, 0, 10, 3, 4, 3, 4, 7, 10, 7, 10, 10, 0, 10];

  it('detects points inside and outside a convex polygon', () => {
    expect(pointInPolygon(5, 5, square)).toBe(true);
    expect(pointInPolygon(15, 5, square)).toBe(false);
    expect(pointInPolygon(-1, -1, square)).toBe(false);
  });

  it('handles concave polygons', () => {
    expect(pointInPolygon(2, 5, concave)).toBe(true);
    expect(pointInPolygon(8, 5, concave)).toBe(false);
    expect(pointInPolygon(8, 1.5, concave)).toBe(true);
  });

  it('gives the same answer regardless of winding direction', () => {
    const reversed: number[] = [];
    for (let i = square.length - 2; i >= 0; i -= 2) reversed.push(square[i], square[i + 1]);
    expect(pointInPolygon(5, 5, reversed)).toBe(true);
    expect(pointInPolygon(11, 5, reversed)).toBe(false);
  });

  it('rejects degenerate polygons', () => {
    expect(pointInPolygon(0, 0, [0, 0, 1, 1])).toBe(false);
  });
});

describe('segment distances', () => {
  it('measures point-to-segment distance at the interior and past both ends', () => {
    expect(distSqPointToSegment(5, 3, 0, 0, 10, 0)).toBeCloseTo(9);
    expect(distSqPointToSegment(-4, 3, 0, 0, 10, 0)).toBeCloseTo(25);
    expect(distSqPointToSegment(13, 4, 0, 0, 10, 0)).toBeCloseTo(25);
  });

  it('treats a zero-length segment as a point', () => {
    expect(distSqPointToSegment(3, 4, 0, 0, 0, 0)).toBeCloseTo(25);
  });

  it('detects crossing, touching and disjoint segments', () => {
    expect(segmentsIntersect(0, 0, 10, 10, 0, 10, 10, 0)).toBe(true);
    expect(segmentsIntersect(0, 0, 10, 0, 5, 0, 5, 5)).toBe(true);
    expect(segmentsIntersect(0, 0, 10, 0, 0, 1, 10, 1)).toBe(false);
    expect(segmentsIntersect(0, 0, 4, 0, 6, 0, 10, 0)).toBe(false);
  });

  it('measures segment-to-segment distance', () => {
    expect(distSqSegmentToSegment(0, 0, 10, 10, 0, 10, 10, 0)).toBe(0);
    expect(distSqSegmentToSegment(0, 0, 10, 0, 0, 3, 10, 3)).toBeCloseTo(9);
    expect(distSqSegmentToSegment(0, 0, 4, 0, 7, 4, 7, 9)).toBeCloseTo(25);
  });
});

describe('rect and polygon helpers', () => {
  it('computes polygon bounds', () => {
    expect(boundsOfPolygon([3, -2, 9, 4, -1, 7])).toEqual({ minX: -1, minY: -2, maxX: 9, maxY: 7 });
  });

  it('tests rectangle overlap including shared edges', () => {
    const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    expect(rectsIntersect(a, { minX: 10, minY: 5, maxX: 20, maxY: 6 })).toBe(true);
    expect(rectsIntersect(a, { minX: 10.1, minY: 5, maxX: 20, maxY: 6 })).toBe(false);
  });

  it('reports signed area with opposite signs for opposite windings', () => {
    const forward = [0, 0, 4, 0, 4, 3, 0, 3];
    const backward = [0, 3, 4, 3, 4, 0, 0, 0];
    expect(polygonSignedArea(forward)).toBeCloseTo(12);
    expect(polygonSignedArea(backward)).toBeCloseTo(-12);
  });
});
