/**
 * Pen and highlighter. While the pointer is down the stroke lives only on the
 * live canvas; committed ink is not touched until the stroke is finished.
 *
 * The live sampling is incremental: a spline span becomes final as soon as the
 * control point two positions ahead exists, so finished spans are sampled
 * exactly once and only the short provisional tail is resampled per update.
 * The outline is built from those samples with the same builder as committed
 * strokes, so the ink looks the same before and after it is committed (same
 * caps, same joins, same widths). To keep every update cheap however long the
 * stroke gets, the older part of the stroke is frozen into a path in chunks
 * and only the most recent samples are rebuilt.
 *
 * Hold to snap: when the pointer rests in place at the end of a stroke without
 * being lifted, the rough stroke is replaced by the clean shape it resembles
 * (line, rectangle, ellipse or triangle), if any. A snapped line keeps
 * following the pointer with its far end until the pointer is lifted; closed
 * shapes stay put. The hold timer lives here, outside React, and is cleared
 * whenever the stroke ends or is cancelled.
 */
import type { StrokeRecord, StrokeShape, StrokeTool } from '../../types';
import type { RecognizedShape } from '../math/shapeRecognition';
import { recognizeShape, shapeVertices, snapLineEnd } from '../math/shapeRecognition';
import { POINT_STRIDE, SAMPLE_STRIDE, appendSpanSamples, round2, strokeInkBounds } from '../math/strokeGeometry';
import { StrokeInputFilter } from '../math/strokeInput';
import { canvasPalette, inkColor } from '../render/canvasTheme';
import { buildSamplesPath, buildStrokePath } from '../render/strokePath';
import type { EngineTool, OverlayView, ToolHost, ToolPointer } from './types';

/** How long the pointer must rest before the stroke is snapped to a shape. */
const HOLD_MS = 550;
/** The pointer counts as resting while it stays within this many screen pixels. */
const HOLD_RADIUS_PX = 4;
/** Strokes shorter than this on screen are never snapped (taps, dots, small letters). */
const MIN_SNAP_SIZE_PX = 28;
/** Duration of the highlight that confirms a snap. */
const SNAP_PULSE_MS = 220;
const SNAP_PULSE_FRAME_MS = 30;
/** Extra width of the confirmation highlight around the shape, in screen pixels. */
const SNAP_PULSE_SPREAD_PX = 7;
const SNAP_PULSE_ALPHA = 0.32;
/** Number of live samples after which the oldest ones are frozen into a finished piece of path. */
const LIVE_CHUNK_SAMPLES = 256;

interface SnappedShape {
  shape: RecognizedShape;
  /** Control points of the clean shape, ready to be stored. */
  points: number[];
  originX: number;
  originY: number;
  path: Path2D;
  /** Slightly wider copy of the shape, shown briefly to confirm the snap. */
  pulsePath: Path2D;
  snappedAt: number;
}

interface ActiveStroke {
  tool: StrokeTool;
  color: string;
  size: number;
  filter: StrokeInputFilter;
  originX: number;
  originY: number;
  /** Finished pieces of the stroke, each a complete outline ending in a round cap where the next begins. */
  frozenPath: Path2D;
  /** `[x, y, radius]` samples of the spans that can no longer change and are not frozen yet. */
  stableSamples: number[];
  stableSpans: number;
  /** Outline of the samples after the frozen part, rebuilt on every update. */
  path: Path2D;
  /** Latest pointer position, and the position the pointer has been resting at. */
  pointer: ToolPointer;
  restX: number;
  restY: number;
  holdTimer: number;
  pulseTimer: number;
  snapped: SnappedShape | null;
}

export class DrawTool implements EngineTool {
  private active: ActiveStroke | null = null;

  constructor(private readonly host: ToolHost) {}

  /** The kind of stroke currently being drawn, if any. */
  get drawingTool(): StrokeTool | null {
    return this.active ? this.active.tool : null;
  }

  begin(pointer: ToolPointer): void {
    this.stopTimers();
    const settings = this.host.settings();
    const tool: StrokeTool = settings.tool === 'highlighter' ? 'highlighter' : 'pen';
    const size = tool === 'highlighter' ? settings.highlighterSize : settings.penSize;
    const filter = new StrokeInputFilter({
      tool,
      size,
      zoom: this.host.camera().zoom,
      pointerType: pointer.pointerType,
    });
    filter.add(pointer);
    this.active = {
      tool,
      color: tool === 'highlighter' ? settings.highlighterColor : settings.penColor,
      size,
      filter,
      originX: pointer.x,
      originY: pointer.y,
      frozenPath: new Path2D(),
      stableSamples: [filter.points[0], filter.points[1], filter.points[2] / 2],
      stableSpans: 0,
      path: new Path2D(),
      pointer,
      restX: pointer.sx,
      restY: pointer.sy,
      holdTimer: 0,
      pulseTimer: 0,
      snapped: null,
    };
    this.restartHold();
    this.rebuildLiveGeometry();
    this.host.requestOverlay();
  }

  move(pointers: readonly ToolPointer[]): void {
    const active = this.active;
    if (!active || pointers.length === 0) return;
    const latest = pointers[pointers.length - 1];
    active.pointer = latest;

    if (active.snapped) {
      // A snapped line can still be aimed; closed shapes ignore further movement.
      if (active.snapped.shape.kind === 'line') {
        const line = active.snapped.shape;
        const end = snapLineEnd(line.x1, line.y1, latest.x, latest.y);
        this.setSnapped({ ...line, x2: end.x, y2: end.y }, active.snapped.snappedAt);
        this.host.requestOverlay();
      }
      return;
    }

    let changed = false;
    for (const pointer of pointers) {
      if (active.filter.add(pointer)) changed = true;
    }
    if (Math.hypot(latest.sx - active.restX, latest.sy - active.restY) > HOLD_RADIUS_PX) {
      active.restX = latest.sx;
      active.restY = latest.sy;
      this.restartHold();
    }
    if (changed) {
      this.rebuildLiveGeometry();
      this.host.requestOverlay();
    }
  }

  end(pointer: ToolPointer): void {
    const active = this.active;
    if (!active) return;
    this.stopTimers();
    this.active = null;
    const pageId = this.host.pageId();
    if (pageId) {
      const record: StrokeRecord = {
        id: crypto.randomUUID(),
        pageId,
        tool: active.tool,
        color: active.color,
        size: active.size,
        points: [],
        order: this.host.model.nextOrder(),
      };
      if (active.snapped) {
        record.points = active.snapped.points;
        record.shape = active.snapped.shape.kind;
      } else {
        active.filter.add(pointer);
        active.filter.finish();
        record.points = active.filter.points.slice();
      }
      this.host.addStroke(record);
    }
    this.host.requestOverlay();
  }

  cancel(): void {
    if (!this.active) return;
    this.stopTimers();
    this.active = null;
    this.host.requestOverlay();
  }

  /**
   * Restarts the hold countdown. The engine calls this when the view moves
   * under a stroke in progress (wheel pan or zoom), because the pointer is
   * then not resting on one spot of the page.
   */
  interruptHold(): void {
    if (this.active && !this.active.snapped) this.restartHold();
  }

  hover(): void {
    // Drawing tools have no hover visuals; the CSS cursor is enough.
  }

  drawOverlay(ctx: CanvasRenderingContext2D, view: OverlayView): void {
    const active = this.active;
    if (!active) return;
    const snapped = active.snapped;
    const originX = snapped ? snapped.originX : active.originX;
    const originY = snapped ? snapped.originY : active.originY;
    ctx.setTransform(view.scale, 0, 0, view.scale, originX * view.scale - view.offX, originY * view.scale - view.offY);
    if (snapped) {
      const fade = 1 - (performance.now() - snapped.snappedAt) / SNAP_PULSE_MS;
      if (fade > 0) {
        ctx.globalAlpha = SNAP_PULSE_ALPHA * fade;
        ctx.fillStyle = canvasPalette(view.theme).selectionStroke;
        ctx.fill(snapped.pulsePath);
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = inkColor(active.color, view.theme);
      ctx.fill(snapped.path);
      return;
    }
    ctx.fillStyle = inkColor(active.color, view.theme);
    ctx.fill(active.frozenPath);
    ctx.fill(active.path);
  }

  // ------------------------------------------------------------- hold to snap

  private restartHold(): void {
    const active = this.active;
    if (!active) return;
    if (active.holdTimer) window.clearTimeout(active.holdTimer);
    active.holdTimer = window.setTimeout(this.onHold, HOLD_MS);
  }

  private stopTimers(): void {
    const active = this.active;
    if (!active) return;
    if (active.holdTimer) window.clearTimeout(active.holdTimer);
    if (active.pulseTimer) window.clearTimeout(active.pulseTimer);
    active.holdTimer = 0;
    active.pulseTimer = 0;
  }

  /** The pointer has rested for `HOLD_MS`: snap the stroke if it clearly resembles a shape. */
  private readonly onHold = (): void => {
    const active = this.active;
    if (!active) return;
    active.holdTimer = 0;
    if (active.snapped) return;

    const points = active.filter.points;
    const path: number[] = [];
    for (let i = 0; i + 2 < points.length; i += POINT_STRIDE) path.push(points[i], points[i + 1]);
    // The stabilised points trail the pointer slightly; the shape should end where the pointer rests.
    path.push(active.pointer.x, active.pointer.y);

    const shape = recognizeShape(path, { minSize: MIN_SNAP_SIZE_PX / this.host.camera().zoom });
    if (!shape) return;
    this.setSnapped(shape, performance.now());
    this.host.requestOverlay();
    this.runPulse();
  };

  private setSnapped(shape: RecognizedShape, snappedAt: number): void {
    const active = this.active;
    if (!active) return;
    const kind: StrokeShape = shape.kind;
    const vertices = shapeVertices(shape);
    const points: number[] = [];
    const pulsePoints: number[] = [];
    const pulseWidth = active.size + (2 * SNAP_PULSE_SPREAD_PX) / this.host.camera().zoom;
    for (let i = 0; i + 1 < vertices.length; i += 2) {
      const x = round2(vertices[i]);
      const y = round2(vertices[i + 1]);
      points.push(x, y, active.size);
      pulsePoints.push(x, y, pulseWidth);
    }
    const bounds = strokeInkBounds(points, kind);
    active.snapped = {
      shape,
      points,
      originX: bounds.minX,
      originY: bounds.minY,
      path: buildStrokePath(points, bounds.minX, bounds.minY, kind),
      pulsePath: buildStrokePath(pulsePoints, bounds.minX, bounds.minY, kind),
      snappedAt,
    };
  }

  /** Repaints the overlay while the snap highlight fades out. */
  private runPulse(): void {
    const active = this.active;
    if (!active || !active.snapped) return;
    const snappedAt = active.snapped.snappedAt;
    const tick = (): void => {
      if (this.active !== active) return;
      active.pulseTimer = 0;
      this.host.requestOverlay();
      if (performance.now() - snappedAt < SNAP_PULSE_MS) {
        active.pulseTimer = window.setTimeout(tick, SNAP_PULSE_FRAME_MS);
      }
    };
    active.pulseTimer = window.setTimeout(tick, SNAP_PULSE_FRAME_MS);
  }

  // ------------------------------------------------------------ live geometry

  private rebuildLiveGeometry(): void {
    const active = this.active;
    if (!active) return;
    const points = active.filter.points;
    const count = active.filter.count;
    const samples = active.stableSamples;

    // Spans 0 .. count-3 can no longer change: their trailing neighbour exists.
    while (active.stableSpans < count - 2) {
      appendSpanSamples(samples, points, active.stableSpans);
      active.stableSpans++;
    }
    // Freeze older samples. Consecutive pieces share one sample, where both have a round cap of
    // the same radius, so together they cover exactly what one continuous outline would.
    while (samples.length >= LIVE_CHUNK_SAMPLES * SAMPLE_STRIDE) {
      const chunk = samples.slice(0, LIVE_CHUNK_SAMPLES * SAMPLE_STRIDE);
      active.frozenPath.addPath(buildSamplesPath(chunk, active.originX, active.originY));
      samples.splice(0, (LIVE_CHUNK_SAMPLES - 1) * SAMPLE_STRIDE);
    }
    // The last span is provisional: sample it onto the end, build the path, then drop it again.
    const stableLength = samples.length;
    if (count >= 2) appendSpanSamples(samples, points, count - 2);
    active.path = buildSamplesPath(samples, active.originX, active.originY);
    samples.length = stableLength;
  }
}
