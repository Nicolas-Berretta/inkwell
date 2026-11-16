import { describe, expect, it } from 'vitest';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  clampZoom,
  panByScreenDelta,
  sanitizeCamera,
  screenToWorld,
  visibleWorldRect,
  wheelZoomFactor,
  worldToScreen,
  zoomAtScreenPoint,
} from './camera';

describe('camera transforms', () => {
  const camera = { x: 120, y: -40, zoom: 2.5 };

  it('round-trips between screen and world space', () => {
    const world = screenToWorld(camera, 310, 95);
    const screen = worldToScreen(camera, world.x, world.y);
    expect(screen.x).toBeCloseTo(310, 9);
    expect(screen.y).toBeCloseTo(95, 9);
  });

  it('maps the viewport origin to the camera position', () => {
    expect(screenToWorld(camera, 0, 0)).toEqual({ x: 120, y: -40 });
  });

  it('pans so the content follows the pointer', () => {
    const before = worldToScreen(camera, 200, 200);
    const panned = panByScreenDelta(camera, 30, -12);
    const after = worldToScreen(panned, 200, 200);
    expect(after.x - before.x).toBeCloseTo(30, 9);
    expect(after.y - before.y).toBeCloseTo(-12, 9);
  });

  it('keeps the world point under the cursor fixed while zooming', () => {
    const anchor = screenToWorld(camera, 400, 300);
    for (const zoom of [0.3, 1, 4.2]) {
      const zoomed = zoomAtScreenPoint(camera, 400, 300, zoom);
      const screen = worldToScreen(zoomed, anchor.x, anchor.y);
      expect(zoomed.zoom).toBe(zoom);
      expect(screen.x).toBeCloseTo(400, 6);
      expect(screen.y).toBeCloseTo(300, 6);
    }
  });

  it('clamps zoom to the supported range', () => {
    expect(clampZoom(1000)).toBe(MAX_ZOOM);
    expect(clampZoom(0.0001)).toBe(MIN_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(zoomAtScreenPoint(camera, 0, 0, 999).zoom).toBe(MAX_ZOOM);
  });

  it('computes the visible world rectangle', () => {
    expect(visibleWorldRect(camera, 1000, 500)).toEqual({ minX: 120, minY: -40, maxX: 520, maxY: 160 });
  });

  it('turns wheel deltas into bounded, symmetric zoom factors', () => {
    expect(wheelZoomFactor(0)).toBe(1);
    expect(wheelZoomFactor(-10)).toBeGreaterThan(1);
    expect(wheelZoomFactor(10)).toBeLessThan(1);
    expect(wheelZoomFactor(10) * wheelZoomFactor(-10)).toBeCloseTo(1, 12);
    expect(wheelZoomFactor(100000)).toBe(wheelZoomFactor(25));
  });

  it('repairs invalid stored cameras', () => {
    expect(sanitizeCamera({ x: Number.NaN, y: 5, zoom: 500 })).toEqual({ x: -80, y: 5, zoom: MAX_ZOOM });
    expect(sanitizeCamera(null).zoom).toBe(1);
  });
});
