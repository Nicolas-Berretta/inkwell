/**
 * Camera / viewport transform math.
 *
 * Convention: `camera.x / camera.y` is the world coordinate displayed at the
 * top-left corner of the viewport and `camera.zoom` is screen pixels per world
 * unit, so
 *
 *   screen = (world - camera) * zoom
 *   world  = camera + screen / zoom
 */
import type { CameraState } from '../../types';
import type { Rect, Vec2 } from './geometry';

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

export const DEFAULT_CAMERA: CameraState = { x: -80, y: -60, zoom: 1 };

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function screenToWorld(camera: CameraState, sx: number, sy: number): Vec2 {
  return { x: camera.x + sx / camera.zoom, y: camera.y + sy / camera.zoom };
}

export function worldToScreen(camera: CameraState, wx: number, wy: number): Vec2 {
  return { x: (wx - camera.x) * camera.zoom, y: (wy - camera.y) * camera.zoom };
}

/** Moves the content by a screen-space delta (content follows the pointer). */
export function panByScreenDelta(camera: CameraState, dx: number, dy: number): CameraState {
  return { x: camera.x - dx / camera.zoom, y: camera.y - dy / camera.zoom, zoom: camera.zoom };
}

/**
 * Changes zoom while keeping the world point under the given screen position
 * fixed, which is what makes zooming feel anchored to the cursor.
 */
export function zoomAtScreenPoint(camera: CameraState, sx: number, sy: number, nextZoom: number): CameraState {
  const zoom = clampZoom(nextZoom);
  const anchor = screenToWorld(camera, sx, sy);
  return { x: anchor.x - sx / zoom, y: anchor.y - sy / zoom, zoom };
}

/** World-space rectangle covered by a viewport of the given CSS pixel size. */
export function visibleWorldRect(camera: CameraState, width: number, height: number): Rect {
  return {
    minX: camera.x,
    minY: camera.y,
    maxX: camera.x + width / camera.zoom,
    maxY: camera.y + height / camera.zoom,
  };
}

/**
 * Converts a wheel delta into a multiplicative zoom factor. Trackpad pinches
 * deliver many small deltas; mouse wheels deliver large notches, which are
 * capped so one notch never jumps more than ~28%.
 */
export function wheelZoomFactor(deltaY: number): number {
  const capped = Math.max(-25, Math.min(25, deltaY));
  return Math.exp(-capped * 0.01);
}

export function sanitizeCamera(camera: Partial<CameraState> | undefined | null): CameraState {
  const x = camera && Number.isFinite(camera.x) ? (camera.x as number) : DEFAULT_CAMERA.x;
  const y = camera && Number.isFinite(camera.y) ? (camera.y as number) : DEFAULT_CAMERA.y;
  const zoom = camera && Number.isFinite(camera.zoom) ? clampZoom(camera.zoom as number) : DEFAULT_CAMERA.zoom;
  return { x, y, zoom };
}
