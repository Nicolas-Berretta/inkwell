/**
 * Draws the page background pattern (ruled lines / square grid / dot grid) for the current
 * camera. Marks are generated from world coordinates every time, so the
 * pattern is infinite, pans and zooms with the page and stays pixel-crisp.
 */
import type { CameraState, PageBackground, ThemeMode } from '../../types';
import { linePositions, patternLod, patternSpec } from '../math/backgroundPattern';
import { canvasPalette } from './canvasTheme';

const MIN_LINE_GAP_PX = 7;
const MIN_DOT_GAP_PX = 14;
const MAX_ROUND_DOTS = 6000;

export function drawBackground(
  ctx: CanvasRenderingContext2D,
  widthPx: number,
  heightPx: number,
  dpr: number,
  camera: CameraState,
  background: PageBackground,
  theme: ThemeMode,
): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, widthPx, heightPx);
  const spec = patternSpec(background);
  if (!spec) return;

  const palette = canvasPalette(theme);
  const scale = camera.zoom * dpr;
  const offX = Math.round(camera.x * scale);
  const offY = Math.round(camera.y * scale);

  if (spec.kind === 'lines' || spec.kind === 'grid') {
    const lod = patternLod(spec.spacing, camera.zoom, MIN_LINE_GAP_PX);
    const step = spec.spacing * lod.stride;
    const thickness = Math.max(1, Math.round(dpr * 0.75));
    ctx.globalAlpha = lod.alpha;
    ctx.fillStyle = palette.ruleLine;
    // One path and one fill, so grid intersections are not painted twice (they would look darker when faded).
    ctx.beginPath();
    for (const y of linePositions(offY, heightPx, scale, step)) ctx.rect(0, y, widthPx, thickness);
    if (spec.kind === 'grid') {
      for (const x of linePositions(offX, widthPx, scale, step)) ctx.rect(x, 0, thickness, heightPx);
    }
    ctx.fill();
    ctx.globalAlpha = 1;
    return;
  }

  const lod = patternLod(spec.spacing, camera.zoom, MIN_DOT_GAP_PX);
  const step = spec.spacing * lod.stride;
  const firstX = Math.ceil(offX / scale / step);
  const lastX = Math.floor((offX + widthPx) / scale / step);
  const firstY = Math.ceil(offY / scale / step);
  const lastY = Math.floor((offY + heightPx) / scale / step);
  const radius = Math.min(2.2, Math.max(0.9, 1.15 * Math.sqrt(camera.zoom))) * dpr;
  const count = (lastX - firstX + 1) * (lastY - firstY + 1);
  const round = count <= MAX_ROUND_DOTS;

  ctx.globalAlpha = lod.alpha;
  ctx.fillStyle = palette.dot;
  ctx.beginPath();
  for (let ky = firstY; ky <= lastY; ky++) {
    const y = Math.round(ky * step * scale) - offY;
    for (let kx = firstX; kx <= lastX; kx++) {
      const x = Math.round(kx * step * scale) - offX;
      if (round) {
        ctx.moveTo(x + radius, y);
        ctx.arc(x, y, radius, 0, Math.PI * 2);
      } else {
        ctx.rect(x - radius, y - radius, radius * 2, radius * 2);
      }
    }
  }
  ctx.fill();
  ctx.globalAlpha = 1;
}
