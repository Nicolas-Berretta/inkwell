/** Contracts between the canvas engine and its pointer tools. */
import type { CameraState, ImageRecord, ObjectSet, StrokeRecord, ThemeMode, ToolSettings } from '../../types';
import type { Box } from '../math/imageGeometry';
import type { ImageItem } from '../render/ImageLayer';
import type { StrokeItem, StrokeModel } from '../render/StrokeModel';

/** A pointer sample translated into both screen (CSS px) and world coordinates. */
export interface ToolPointer {
  sx: number;
  sy: number;
  x: number;
  y: number;
  pressure: number;
  time: number;
  pointerType: string;
}

/** Device-space view used for drawing overlays on the live canvas. */
export interface OverlayView {
  /** Device pixels per world unit (zoom * devicePixelRatio). */
  scale: number;
  /** Camera translation in device pixels, snapped to the pixel grid. */
  offX: number;
  offY: number;
  dpr: number;
  zoom: number;
  theme: ThemeMode;
}

export type HistoryEntry =
  | { type: 'add'; strokes: StrokeRecord[] }
  | { type: 'remove'; strokes: StrokeRecord[] }
  /** Strokes and images moved together by the same offset. */
  | { type: 'move'; ids: string[]; imageIds: string[]; dx: number; dy: number }
  /** Mixed objects added and / or removed in one step (paste, cut, duplicate, delete). */
  | { type: 'objects'; added: ObjectSet; removed: ObjectSet }
  /** One image changed in place (resized, locked, restacked). */
  | { type: 'image'; before: ImageRecord; after: ImageRecord };

/** What a tool may ask of the engine. */
export interface ToolHost {
  readonly model: StrokeModel;
  camera(): CameraState;
  settings(): ToolSettings;
  pageId(): string | null;
  /** Commits a finished stroke (persisted, undoable). */
  addStroke(record: StrokeRecord): void;
  /** Removes strokes and returns their records; optionally records one undo step. */
  removeStrokes(ids: readonly string[], recordHistory: boolean): StrokeRecord[];
  /** Moves strokes; optionally records one undo step. */
  translateStrokes(ids: readonly string[], dx: number, dy: number, recordHistory: boolean): void;
  /** Moves strokes and images together as one undo step. */
  translateObjects(strokeIds: readonly string[], imageIds: readonly string[], dx: number, dy: number): void;
  /** Removes strokes and images together as one undo step. */
  removeObjects(strokeIds: readonly string[], imageIds: readonly string[]): void;
  /** Every image on the page. */
  images(): ImageItem[];
  image(id: string): ImageItem | undefined;
  /** Topmost unlocked image under a world position. */
  selectableImageAt(x: number, y: number): ImageItem | null;
  /** Shows an image at a temporary position / size during a drag; `null` ends the preview. */
  previewImage(id: string, box: Box | null): void;
  /** Commits a new position / size for an image as one undo step. */
  resizeImage(id: string, box: Box): void;
  pushHistory(entry: HistoryEntry): void;
  /** Hides or shows strokes on the committed ink layers. */
  setHidden(items: Iterable<StrokeItem>, hidden: boolean): void;
  /** Requests a repaint of the live overlay canvas. */
  requestOverlay(): void;
}

export interface EngineTool {
  begin(pointer: ToolPointer): void;
  move(pointers: readonly ToolPointer[]): void;
  end(pointer: ToolPointer): void;
  cancel(): void;
  /** Called for pointer movement without a pressed button; `null` when the pointer leaves. */
  hover(pointer: ToolPointer | null): void;
  /** Paints the tool's transient visuals on the (already cleared) live canvas. */
  drawOverlay(ctx: CanvasRenderingContext2D, view: OverlayView): void;
}
