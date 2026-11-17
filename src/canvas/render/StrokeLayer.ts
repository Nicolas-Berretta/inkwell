/**
 * One committed-ink canvas (pen layer or highlighter layer).
 *
 * The layer repaints as little as possible:
 *
 *   - nothing at all when neither the camera nor the content changed,
 *   - a brand-new stroke is simply painted on top of the existing pixels,
 *   - edits (erase, move, undo) repaint only the affected rectangles,
 *   - panning shifts the existing pixels and paints only the newly exposed
 *     strips, so pan cost depends on the strip, not on the page,
 *   - only a zoom change, a resize or a theme change repaints the viewport,
 *     and even then only strokes found by the spatial index are visited,
 *   - when such a repaint is expensive (a very dense view), zooming first
 *     rescales the existing bitmap with a CSS transform and repaints crisply
 *     as soon as the gesture pauses, so a zoom gesture never drops frames.
 *
 * The camera translation is snapped to whole device pixels, which is what
 * makes shifted pixels and freshly rasterised strokes line up exactly.
 */
import type { CameraState, StrokeTool, ThemeMode } from '../../types';
import type { Rect } from '../math/geometry';
import { POINT_STRIDE } from '../math/strokeGeometry';
import { inkColor } from './canvasTheme';
import type { StrokeItem, StrokeModel } from './StrokeModel';

interface DeviceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface RenderedView {
  scale: number;
  offX: number;
  offY: number;
}

/** Above this many pending dirty rectangles a full repaint is cheaper. */
const MAX_DIRTY_RECTS = 12;
/** Strokes thinner than this on screen (device px) are drawn as plain centrelines. */
const LOD_MAX_WIDTH_PX = 1.5;
/** Strokes smaller than this on screen (device px) are drawn as plain centrelines. */
const LOD_MAX_EXTENT_PX = 6;
/** Minimum centreline width (device px) so distant ink stays visible. */
const LOD_MIN_LINE_PX = 0.9;
/** A stroke whose centreline is shorter than this (world units) in both directions is a dot. */
const DOT_EPSILON = 1e-6;
/** A viewport repaint is "expensive" beyond this many strokes or this much scripting time. */
const PREVIEW_STROKE_COUNT = 1200;
const PREVIEW_COST_MS = 7;
/** How long zoom must be steady before an expensive view is repainted crisply. */
const ZOOM_SETTLE_MS = 110;
/** The bitmap preview is abandoned once it is stretched or shrunk beyond these factors. */
const PREVIEW_MIN_FACTOR = 0.45;
const PREVIEW_MAX_FACTOR = 2.75;

/** Snaps the camera translation to the device pixel grid. */
export function snappedOffset(cameraCoord: number, scale: number): number {
  return Math.round(cameraCoord * scale);
}

/** Fills one stroke's cached path, translated by an optional world-space offset. */
export function fillStrokeItem(
  ctx: CanvasRenderingContext2D,
  model: StrokeModel,
  item: StrokeItem,
  scale: number,
  offX: number,
  offY: number,
  theme: ThemeMode,
  dx = 0,
  dy = 0,
): void {
  ctx.setTransform(scale, 0, 0, scale, (item.originX + dx) * scale - offX, (item.originY + dy) * scale - offY);
  ctx.fillStyle = inkColor(item.record.color, theme);
  ctx.fill(model.pathFor(item));
}

export class StrokeLayer {
  private readonly ctx: CanvasRenderingContext2D;
  private widthPx = 0;
  private heightPx = 0;
  private dpr = 1;
  private rendered: RenderedView | null = null;
  private fullDirty = true;
  private dirtyRects: Rect[] = [];
  private pendingTop: StrokeItem[] = [];
  private requestedScale = 0;
  private scaleChangedAt = 0;
  private lastRepaintCostMs = 0;
  private lastRepaintCount = 0;
  private previewing = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly model: StrokeModel,
    private readonly tool: StrokeTool,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context is not available');
    this.ctx = ctx;
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    if (w !== this.widthPx || h !== this.heightPx) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.widthPx = w;
      this.heightPx = h;
    }
    this.dpr = dpr;
    this.invalidateAll();
  }

  invalidateAll(): void {
    this.fullDirty = true;
    this.dirtyRects.length = 0;
    this.pendingTop.length = 0;
  }

  /** Marks a world-space rectangle for repaint. */
  invalidateRect(rect: Rect): void {
    if (this.fullDirty) return;
    this.dirtyRects.push(rect);
    if (this.dirtyRects.length > MAX_DIRTY_RECTS) this.invalidateAll();
  }

  /** Queues a stroke that sits above everything already painted. */
  paintOnTop(item: StrokeItem): void {
    if (this.fullDirty) return;
    this.pendingTop.push(item);
  }

  /**
   * Brings the canvas up to date for the camera. Returns true when the layer
   * is showing a rescaled preview and still needs a crisp repaint, in which
   * case the caller must call `render` again shortly.
   */
  render(camera: CameraState, theme: ThemeMode, now: number): boolean {
    const scale = camera.zoom * this.dpr;
    const offX = snappedOffset(camera.x, scale);
    const offY = snappedOffset(camera.y, scale);
    const previous = this.rendered;
    const ctx = this.ctx;
    const regions: DeviceRect[] = [];

    if (scale !== this.requestedScale) {
      this.requestedScale = scale;
      this.scaleChangedAt = now;
    }

    // Mid-zoom on an expensive view: rescale the pixels we already have instead of repainting.
    if (previous && !this.fullDirty && previous.scale !== scale && this.isExpensive()) {
      const factor = scale / previous.scale;
      const settled = now - this.scaleChangedAt >= ZOOM_SETTLE_MS;
      if (!settled && factor > PREVIEW_MIN_FACTOR && factor < PREVIEW_MAX_FACTOR) {
        const tx = (previous.offX * factor - offX) / this.dpr;
        const ty = (previous.offY * factor - offY) / this.dpr;
        this.canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${factor})`;
        this.previewing = true;
        return true;
      }
    }
    if (this.previewing) {
      this.canvas.style.transform = '';
      this.previewing = false;
    }

    let full = this.fullDirty || !previous || previous.scale !== scale;
    if (!full && previous) {
      const dx = previous.offX - offX;
      const dy = previous.offY - offY;
      if (dx !== 0 || dy !== 0) {
        if (Math.abs(dx) >= this.widthPx || Math.abs(dy) >= this.heightPx) {
          full = true;
        } else {
          this.shiftPixels(dx, dy);
          if (dx > 0) regions.push({ x: 0, y: 0, w: dx, h: this.heightPx });
          else if (dx < 0) regions.push({ x: this.widthPx + dx, y: 0, w: -dx, h: this.heightPx });
          if (dy > 0) regions.push({ x: 0, y: 0, w: this.widthPx, h: dy });
          else if (dy < 0) regions.push({ x: 0, y: this.heightPx + dy, w: this.widthPx, h: -dy });
        }
      } else if (this.dirtyRects.length === 0 && this.pendingTop.length === 0) {
        return false;
      }
    }

    this.rendered = { scale, offX, offY };

    if (full) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.widthPx, this.heightPx);
      const started = performance.now();
      this.lastRepaintCount = this.paintRegion({ x: 0, y: 0, w: this.widthPx, h: this.heightPx }, scale, offX, offY, theme);
      this.lastRepaintCostMs = performance.now() - started;
    } else {
      for (const item of this.pendingTop) {
        if (!item.hidden && this.model.get(item.record.id) === item) {
          this.paintItems([item], scale, offX, offY, theme);
        }
      }
      for (const rect of this.dirtyRects) {
        const region = this.toDeviceRect(rect, scale, offX, offY);
        if (region) regions.push(region);
      }
      for (const region of regions) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.beginPath();
        ctx.rect(region.x, region.y, region.w, region.h);
        ctx.clip();
        ctx.clearRect(region.x, region.y, region.w, region.h);
        this.paintRegion(region, scale, offX, offY, theme);
        ctx.restore();
      }
    }

    this.fullDirty = false;
    this.dirtyRects.length = 0;
    this.pendingTop.length = 0;
    return false;
  }

  /**
   * Whether repainting the whole viewport is too slow to do on every frame of
   * a zoom gesture. Scripting time alone under-reports GPU-backed canvases
   * (rasterisation is deferred), so the stroke count is considered as well.
   */
  private isExpensive(): boolean {
    return this.lastRepaintCount > PREVIEW_STROKE_COUNT || this.lastRepaintCostMs > PREVIEW_COST_MS;
  }

  /** Moves the already rendered pixels by a whole number of device pixels. */
  private shiftPixels(dx: number, dy: number): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(this.canvas, dx, dy);
    ctx.globalCompositeOperation = 'source-over';
  }

  private toDeviceRect(rect: Rect, scale: number, offX: number, offY: number): DeviceRect | null {
    const x0 = Math.max(0, Math.floor(rect.minX * scale - offX) - 2);
    const y0 = Math.max(0, Math.floor(rect.minY * scale - offY) - 2);
    const x1 = Math.min(this.widthPx, Math.ceil(rect.maxX * scale - offX) + 2);
    const y1 = Math.min(this.heightPx, Math.ceil(rect.maxY * scale - offY) + 2);
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /** Paints every stroke intersecting the region and returns how many were visited. */
  private paintRegion(region: DeviceRect, scale: number, offX: number, offY: number, theme: ThemeMode): number {
    const world: Rect = {
      minX: (region.x + offX) / scale,
      minY: (region.y + offY) / scale,
      maxX: (region.x + region.w + offX) / scale,
      maxY: (region.y + region.h + offY) / scale,
    };
    const items = this.model.query(this.tool, world);
    items.sort(byPaintOrder);
    this.paintItems(items, scale, offX, offY, theme);
    return items.length;
  }

  private paintItems(items: readonly StrokeItem[], scale: number, offX: number, offY: number, theme: ThemeMode): void {
    paintStrokeItems(this.ctx, this.model, items, scale, offX, offY, theme);
  }
}

/** The part of a 2D canvas context that painting strokes needs. */
export type StrokePaintContext = Pick<
  CanvasRenderingContext2D,
  'setTransform' | 'beginPath' | 'moveTo' | 'lineTo' | 'stroke' | 'fill' | 'strokeStyle' | 'fillStyle' | 'lineWidth' | 'lineCap' | 'lineJoin'
>;

/**
 * Paints items in order, batching consecutive low-detail strokes into a single
 * stroke call.
 *
 * A canvas transforms path points when they are added to the path, not when
 * the path is stroked. The world transform therefore has to be in place before
 * the first `moveTo` of a batch: whatever transform the previous drawing left
 * behind (for example the origin-relative one of a filled stroke) would
 * otherwise send the batch to a different part of the page.
 */
export function paintStrokeItems(
  ctx: StrokePaintContext,
  model: StrokeModel,
  items: readonly StrokeItem[],
  scale: number,
  offX: number,
  offY: number,
  theme: ThemeMode,
): void {
  const minLineWidth = LOD_MIN_LINE_PX / scale;
  let batchColor = '';
  let batchWidth = 0;
  let batchOpen = false;

  const flush = () => {
    if (!batchOpen) return;
    ctx.strokeStyle = batchColor;
    ctx.lineWidth = batchWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    batchOpen = false;
  };

  for (const item of items) {
    if (item.hidden) continue;
    const bounds = item.bounds;
    const extentPx = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) * scale;
    // A dot (a tap: every control point in one place) has no centreline to draw. Browsers do not
    // reliably paint a zero-length line, so a dot is always filled as the disc it is.
    const isDot =
      bounds.maxX - bounds.minX - item.maxWidth < DOT_EPSILON && bounds.maxY - bounds.minY - item.maxWidth < DOT_EPSILON;
    const lowDetail = !isDot && (item.maxWidth * scale < LOD_MAX_WIDTH_PX || extentPx < LOD_MAX_EXTENT_PX);

    if (!lowDetail) {
      flush();
      fillStrokeItem(ctx as CanvasRenderingContext2D, model, item, scale, offX, offY, theme);
      continue;
    }

    // Far-away or tiny ink: variable width and spline detail are sub-pixel
    // here, so a centreline through the control points is visually identical.
    const color = inkColor(item.record.color, theme);
    const width = Math.max(item.averageWidth, minLineWidth);
    const quantised = Math.round(width * 8) / 8;
    if (!batchOpen || color !== batchColor || quantised !== batchWidth) {
      flush();
      // Path points are in world coordinates, so the world transform must be set before they are added.
      ctx.setTransform(scale, 0, 0, scale, -offX, -offY);
      ctx.beginPath();
      batchOpen = true;
      batchColor = color;
      batchWidth = quantised;
    }
    const points = item.record.points;
    ctx.moveTo(points[0], points[1]);
    for (let i = POINT_STRIDE; i + 2 < points.length; i += POINT_STRIDE) {
      ctx.lineTo(points[i], points[i + 1]);
    }
  }
  flush();
}

function byPaintOrder(a: StrokeItem, b: StrokeItem): number {
  return a.record.order - b.record.order;
}
