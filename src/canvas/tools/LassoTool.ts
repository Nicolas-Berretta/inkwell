/**
 * Lasso selection for handwritten strokes and images.
 *
 *   - Drag on empty space draws a freeform lasso; strokes and unlocked images
 *     that are mostly inside it become selected. A plain click selects the
 *     stroke under it or, when there is none, the unlocked image under it.
 *   - Drag inside the selection frame moves everything selected.
 *   - A single selected image shows corner handles; dragging one resizes the
 *     image, keeping its aspect ratio.
 *   - The engine deletes the selection on Delete / Backspace.
 *
 * Locked images are never selected. While a selection is dragged its strokes
 * are hidden on the committed layers and painted on the live canvas with an
 * offset, so nothing is re-rasterised on the ink layers until the drop;
 * images simply follow as a preview.
 */
import type { Rect } from '../math/geometry';
import { boundsOfPolygon, emptyRect, expandRect, isEmptyRect, rectContainsPoint, unionRect } from '../math/geometry';
import { LASSO_COVERAGE, lassoSelectsStroke, strokeContainsPoint } from '../math/hitTest';
import type { Box, Corner } from '../math/imageGeometry';
import { CORNERS, boxCoverage, boxToRect, cornerAt, cornerPoint, resizeFromCorner } from '../math/imageGeometry';
import { canvasPalette } from '../render/canvasTheme';
import type { ImageItem } from '../render/ImageLayer';
import { fillStrokeItem } from '../render/StrokeLayer';
import type { StrokeItem } from '../render/StrokeModel';
import type { EngineTool, OverlayView, ToolHost, ToolPointer } from './types';

const MIN_LASSO_POINT_GAP_PX = 2;
const CLICK_SLOP_PX = 4;
const PICK_TOLERANCE_PX = 6;
const FRAME_PADDING_PX = 6;
/** Side of a resize handle, and how close the pointer must be to grab it (screen pixels). */
const HANDLE_SIZE_PX = 9;
const HANDLE_REACH_PX = 9;
/** Smallest size (screen pixels, shorter side) an image can be resized to. */
const MIN_IMAGE_SIZE_PX = 24;

type Mode =
  | { kind: 'idle' }
  | { kind: 'lasso'; polygon: number[]; startSx: number; startSy: number; moved: boolean }
  | { kind: 'drag'; startX: number; startY: number; dx: number; dy: number }
  | { kind: 'resize'; imageId: string; corner: Corner; start: Box; box: Box };

function imageBox(item: ImageItem): Box {
  const { x, y, width, height } = item.record;
  return { x, y, width, height };
}

export class LassoTool implements EngineTool {
  private mode: Mode = { kind: 'idle' };
  private readonly selected = new Set<StrokeItem>();
  private readonly selectedImages = new Set<string>();
  private bounds: Rect = emptyRect();

  constructor(private readonly host: ToolHost) {}

  get hasSelection(): boolean {
    return this.selected.size > 0 || this.selectedImages.size > 0;
  }

  /** Ids of everything selected. */
  selection(): { strokeIds: string[]; imageIds: string[] } {
    return { strokeIds: this.selectedIds(), imageIds: [...this.selectedImages] };
  }

  /** Whether a world position lies inside the selection frame. */
  frameContains(x: number, y: number): boolean {
    if (!this.hasSelection) return false;
    return rectContainsPoint(expandRect(this.bounds, this.framePadding()), x, y);
  }

  /** Replaces the selection (used after paste, duplicate and insert). Locked images are skipped. */
  select(strokeIds: readonly string[], imageIds: readonly string[]): void {
    this.clearSelection();
    for (const id of strokeIds) {
      const item = this.host.model.get(id);
      if (item) this.selected.add(item);
    }
    for (const id of imageIds) {
      const image = this.host.image(id);
      if (image && !image.record.locked) this.selectedImages.add(id);
    }
    this.recomputeBounds();
    this.host.requestOverlay();
  }

  begin(pointer: ToolPointer): void {
    const zoom = this.host.camera().zoom;
    const single = this.singleImage();
    const corner = single ? cornerAt(imageBox(single), pointer.x, pointer.y, HANDLE_REACH_PX / zoom) : null;
    if (single && corner) {
      const box = imageBox(single);
      this.mode = { kind: 'resize', imageId: single.record.id, corner, start: box, box };
    } else if (this.frameContains(pointer.x, pointer.y)) {
      this.mode = { kind: 'drag', startX: pointer.x, startY: pointer.y, dx: 0, dy: 0 };
      this.host.setHidden(this.selected, true);
    } else {
      this.clearSelection();
      this.mode = {
        kind: 'lasso',
        polygon: [pointer.x, pointer.y],
        startSx: pointer.sx,
        startSy: pointer.sy,
        moved: false,
      };
    }
    this.host.requestOverlay();
  }

  move(pointers: readonly ToolPointer[]): void {
    const mode = this.mode;
    const latest = pointers[pointers.length - 1];
    if (!latest || mode.kind === 'idle') return;
    if (mode.kind === 'drag') {
      mode.dx = latest.x - mode.startX;
      mode.dy = latest.y - mode.startY;
      this.previewImages(mode.dx, mode.dy);
    } else if (mode.kind === 'resize') {
      mode.box = resizeFromCorner(mode.start, mode.corner, latest.x, latest.y, MIN_IMAGE_SIZE_PX / this.host.camera().zoom);
      this.host.previewImage(mode.imageId, mode.box);
    } else {
      const minGap = MIN_LASSO_POINT_GAP_PX / this.host.camera().zoom;
      for (const pointer of pointers) {
        const n = mode.polygon.length;
        if (Math.hypot(pointer.x - mode.polygon[n - 2], pointer.y - mode.polygon[n - 1]) >= minGap) {
          mode.polygon.push(pointer.x, pointer.y);
        }
        if (Math.hypot(pointer.sx - mode.startSx, pointer.sy - mode.startSy) > CLICK_SLOP_PX) mode.moved = true;
      }
    }
    this.host.requestOverlay();
  }

  end(pointer: ToolPointer): void {
    const mode = this.mode;
    this.mode = { kind: 'idle' };
    if (mode.kind === 'drag') {
      this.host.setHidden(this.selected, false);
      this.previewImages(null, null);
      const dx = pointer.x - mode.startX;
      const dy = pointer.y - mode.startY;
      if (dx !== 0 || dy !== 0) {
        this.host.translateObjects(this.selectedIds(), [...this.selectedImages], dx, dy);
        this.recomputeBounds();
      }
    } else if (mode.kind === 'resize') {
      const box = resizeFromCorner(mode.start, mode.corner, pointer.x, pointer.y, MIN_IMAGE_SIZE_PX / this.host.camera().zoom);
      this.host.previewImage(mode.imageId, null);
      if (box.width !== mode.start.width || box.x !== mode.start.x || box.y !== mode.start.y) {
        this.host.resizeImage(mode.imageId, box);
      }
      this.recomputeBounds();
    } else if (mode.kind === 'lasso') {
      if (mode.moved && mode.polygon.length >= 6) this.selectInside(mode.polygon);
      else this.selectAt(pointer.x, pointer.y);
    }
    this.host.requestOverlay();
  }

  cancel(): void {
    this.endPreviews();
    this.mode = { kind: 'idle' };
    this.host.requestOverlay();
  }

  hover(): void {
    // The selection frame is static between gestures; nothing to update.
  }

  clearSelection(): void {
    this.endPreviews();
    this.mode = { kind: 'idle' };
    if (!this.hasSelection) return;
    this.selected.clear();
    this.selectedImages.clear();
    this.bounds = emptyRect();
    this.host.requestOverlay();
  }

  /** Deletes the selection as one undoable step. Returns true if anything was deleted. */
  deleteSelection(): boolean {
    if (!this.hasSelection) return false;
    const { strokeIds, imageIds } = this.selection();
    this.clearSelection();
    this.host.removeObjects(strokeIds, imageIds);
    return true;
  }

  /** Drops objects that no longer exist or can no longer be selected (erased, undone, locked). */
  pruneSelection(): void {
    let changed = false;
    for (const item of this.selected) {
      if (this.host.model.get(item.record.id) !== item) {
        this.selected.delete(item);
        changed = true;
      }
    }
    for (const id of this.selectedImages) {
      const image = this.host.image(id);
      if (!image || image.record.locked) {
        this.selectedImages.delete(id);
        changed = true;
      }
    }
    // Images may also have moved or changed size underneath the selection.
    this.recomputeBounds();
    if (changed) this.host.requestOverlay();
  }

  drawOverlay(ctx: CanvasRenderingContext2D, view: OverlayView): void {
    const palette = canvasPalette(view.theme);
    const mode = this.mode;
    const dx = mode.kind === 'drag' ? mode.dx : 0;
    const dy = mode.kind === 'drag' ? mode.dy : 0;

    if (mode.kind === 'drag') {
      const ordered = [...this.selected].sort((a, b) => a.record.order - b.record.order);
      for (const item of ordered) {
        ctx.globalAlpha = item.record.tool === 'highlighter' ? 0.45 : 1;
        fillStrokeItem(ctx, this.host.model, item, view.scale, view.offX, view.offY, view.theme, dx, dy);
      }
      ctx.globalAlpha = 1;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineWidth = Math.max(1, view.dpr);
    ctx.strokeStyle = palette.selectionStroke;
    ctx.fillStyle = palette.selectionFill;
    ctx.setLineDash([5 * view.dpr, 4 * view.dpr]);

    if (mode.kind === 'lasso' && mode.polygon.length >= 4) {
      ctx.beginPath();
      for (let i = 0; i < mode.polygon.length; i += 2) {
        const px = mode.polygon[i] * view.scale - view.offX;
        const py = mode.polygon[i + 1] * view.scale - view.offY;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    const single = this.singleImage();
    if (single) {
      // One image: a tight solid frame with a handle on every corner.
      const box = mode.kind === 'resize' ? mode.box : { ...imageBox(single), x: single.record.x + dx, y: single.record.y + dy };
      ctx.setLineDash([]);
      const x = Math.round(box.x * view.scale - view.offX);
      const y = Math.round(box.y * view.scale - view.offY);
      const w = Math.round(box.width * view.scale);
      const h = Math.round(box.height * view.scale);
      ctx.strokeRect(x + 0.5, y + 0.5, w, h);
      const size = HANDLE_SIZE_PX * view.dpr;
      for (const corner of CORNERS) {
        const point = cornerPoint({ x, y, width: w, height: h }, corner);
        ctx.fillStyle = palette.handleFill;
        ctx.fillRect(point.x - size / 2, point.y - size / 2, size, size);
        ctx.strokeRect(Math.round(point.x - size / 2) + 0.5, Math.round(point.y - size / 2) + 0.5, Math.round(size), Math.round(size));
      }
    } else if (this.hasSelection && !isEmptyRect(this.bounds)) {
      const pad = FRAME_PADDING_PX * view.dpr;
      const x = (this.bounds.minX + dx) * view.scale - view.offX - pad;
      const y = (this.bounds.minY + dy) * view.scale - view.offY - pad;
      const w = (this.bounds.maxX - this.bounds.minX) * view.scale + pad * 2;
      const h = (this.bounds.maxY - this.bounds.minY) * view.scale + pad * 2;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
    }
    ctx.setLineDash([]);
  }

  /** The selected image when the selection is exactly one image and nothing else. */
  private singleImage(): ImageItem | null {
    if (this.selected.size > 0 || this.selectedImages.size !== 1) return null;
    const [id] = this.selectedImages;
    return this.host.image(id) ?? null;
  }

  /** World-space padding of the selection frame (a single image is framed tightly). */
  private framePadding(): number {
    return this.singleImage() ? 0 : FRAME_PADDING_PX / this.host.camera().zoom;
  }

  private selectedIds(): string[] {
    return [...this.selected].map((item) => item.record.id);
  }

  private previewImages(dx: number | null, dy: number | null): void {
    for (const id of this.selectedImages) {
      const image = this.host.image(id);
      if (!image) continue;
      if (dx === null || dy === null) this.host.previewImage(id, null);
      else this.host.previewImage(id, { ...imageBox(image), x: image.record.x + dx, y: image.record.y + dy });
    }
  }

  /** Ends whatever drag is in progress without applying it. */
  private endPreviews(): void {
    if (this.mode.kind === 'drag') {
      this.host.setHidden(this.selected, false);
      this.previewImages(null, null);
    } else if (this.mode.kind === 'resize') {
      this.host.previewImage(this.mode.imageId, null);
    }
  }

  private selectInside(polygon: number[]): void {
    const candidates = this.host.model.queryAll(boundsOfPolygon(polygon));
    for (const item of candidates) {
      if (lassoSelectsStroke(item.record.points, polygon)) this.selected.add(item);
    }
    for (const image of this.host.images()) {
      if (!image.record.locked && boxCoverage(imageBox(image), polygon) >= LASSO_COVERAGE) {
        this.selectedImages.add(image.record.id);
      }
    }
    this.recomputeBounds();
  }

  private selectAt(x: number, y: number): void {
    const tolerance = PICK_TOLERANCE_PX / this.host.camera().zoom;
    const candidates = this.host.model.queryAll({
      minX: x - tolerance,
      minY: y - tolerance,
      maxX: x + tolerance,
      maxY: y + tolerance,
    });
    let top: StrokeItem | null = null;
    for (const item of candidates) {
      if (!strokeContainsPoint(item.record.points, x, y, tolerance)) continue;
      if (!top || isAbove(item, top)) top = item;
    }
    if (top) {
      this.selected.add(top);
    } else {
      // Ink is drawn above images, so an image is only picked where no stroke is.
      const image = this.host.selectableImageAt(x, y);
      if (image) this.selectedImages.add(image.record.id);
    }
    this.recomputeBounds();
  }

  private recomputeBounds(): void {
    let bounds = emptyRect();
    for (const item of this.selected) bounds = unionRect(bounds, item.bounds);
    for (const id of this.selectedImages) {
      const image = this.host.image(id);
      if (image) bounds = unionRect(bounds, boxToRect(imageBox(image)));
    }
    this.bounds = bounds;
  }
}

/** The highlighter canvas sits above the pen canvas; within a layer, higher order wins. */
function isAbove(a: StrokeItem, b: StrokeItem): boolean {
  if (a.record.tool !== b.record.tool) return a.record.tool === 'highlighter';
  return a.record.order > b.record.order;
}
