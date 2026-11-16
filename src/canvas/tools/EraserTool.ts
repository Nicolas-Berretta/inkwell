/**
 * Stroke eraser: every stroke touched by the eraser disc is removed whole.
 * The disc is swept between consecutive pointer positions so quick motions
 * cannot jump over ink, and one drag is a single undo step.
 */
import type { StrokeRecord } from '../../types';
import { strokeTouchesCapsule } from '../math/hitTest';
import { canvasPalette } from '../render/canvasTheme';
import type { EngineTool, OverlayView, ToolHost, ToolPointer } from './types';

/** Eraser radius in screen pixels (constant on screen at any zoom). */
export const ERASER_RADIUS_PX = 9;

export class EraserTool implements EngineTool {
  private erased: StrokeRecord[] = [];
  private lastX = 0;
  private lastY = 0;
  private dragging = false;
  private cursor: { sx: number; sy: number } | null = null;

  constructor(private readonly host: ToolHost) {}

  begin(pointer: ToolPointer): void {
    this.dragging = true;
    this.erased = [];
    this.lastX = pointer.x;
    this.lastY = pointer.y;
    this.setCursor(pointer);
    this.eraseAlong(pointer.x, pointer.y);
  }

  move(pointers: readonly ToolPointer[]): void {
    if (!this.dragging) return;
    for (const pointer of pointers) this.eraseAlong(pointer.x, pointer.y);
    const latest = pointers[pointers.length - 1];
    if (latest) this.setCursor(latest);
  }

  end(pointer: ToolPointer): void {
    if (!this.dragging) return;
    this.eraseAlong(pointer.x, pointer.y);
    this.finish();
  }

  cancel(): void {
    // Strokes already erased stay erased; keep the action undoable.
    if (this.dragging) this.finish();
  }

  hover(pointer: ToolPointer | null): void {
    if (pointer) {
      this.setCursor(pointer);
    } else if (this.cursor) {
      this.cursor = null;
      this.host.requestOverlay();
    }
  }

  drawOverlay(ctx: CanvasRenderingContext2D, view: OverlayView): void {
    if (!this.cursor) return;
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.beginPath();
    ctx.arc(this.cursor.sx, this.cursor.sy, ERASER_RADIUS_PX, 0, Math.PI * 2);
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = canvasPalette(view.theme).eraserRing;
    ctx.stroke();
  }

  private finish(): void {
    this.dragging = false;
    if (this.erased.length > 0) this.host.pushHistory({ type: 'remove', strokes: this.erased });
    this.erased = [];
  }

  private setCursor(pointer: ToolPointer): void {
    this.cursor = { sx: pointer.sx, sy: pointer.sy };
    this.host.requestOverlay();
  }

  private eraseAlong(x: number, y: number): void {
    const radius = ERASER_RADIUS_PX / this.host.camera().zoom;
    const ax = this.lastX;
    const ay = this.lastY;
    this.lastX = x;
    this.lastY = y;
    const candidates = this.host.model.queryAll({
      minX: Math.min(ax, x) - radius,
      minY: Math.min(ay, y) - radius,
      maxX: Math.max(ax, x) + radius,
      maxY: Math.max(ay, y) + radius,
    });
    const hits: string[] = [];
    for (const item of candidates) {
      if (strokeTouchesCapsule(item.record.points, ax, ay, x, y, radius)) hits.push(item.record.id);
    }
    if (hits.length > 0) this.erased.push(...this.host.removeStrokes(hits, false));
  }
}
