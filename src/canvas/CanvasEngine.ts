/**
 * Imperative canvas engine. It owns the camera, the stroke model, the canvas
 * layers and all pointer / wheel / keyboard input for the drawing surface.
 *
 * React mounts it once and then only feeds it coarse state (page, tool
 * settings, theme). Nothing that happens per pointer move or per frame goes
 * through React: the engine mutates canvases and one CSS transform directly
 * and reports back through a handful of low-frequency callbacks.
 *
 * Layer stack (bottom to top), all children of the stage element:
 *
 *   background canvas   page pattern
 *   image layer (DOM)   images, moved with a CSS transform; always below ink
 *   text layer (DOM)    rich-text boxes, moved with a CSS transform
 *   ink canvas          committed pen strokes
 *   highlight canvas    committed highlighter strokes (CSS blend mode)
 *   live canvas         stroke in progress, lasso, selection, eraser ring
 */
import type {
  CameraState,
  ImageEntry,
  ImageRecord,
  ObjectSet,
  PageBackground,
  StrokeRecord,
  TextBoxRecord,
  ThemeMode,
  ToolSettings,
} from '../types';
import {
  DEFAULT_CAMERA,
  panByScreenDelta,
  sanitizeCamera,
  screenToWorld,
  wheelZoomFactor,
  zoomAtScreenPoint,
} from './math/camera';
import { emptyObjectSet, isEmptyObjectSet } from './math/clipboard';
import { HistoryStack } from './math/history';
import type { Box } from './math/imageGeometry';
import { round2 } from './math/strokeGeometry';
import { drawBackground } from './render/backgroundRenderer';
import type { ImageItem } from './render/ImageLayer';
import { ImageLayer } from './render/ImageLayer';
import { StrokeLayer, snappedOffset } from './render/StrokeLayer';
import type { StrokeItem } from './render/StrokeModel';
import { StrokeModel } from './render/StrokeModel';
import { DrawTool } from './tools/DrawTool';
import { EraserTool } from './tools/EraserTool';
import { LassoTool } from './tools/LassoTool';
import type { EngineTool, HistoryEntry, OverlayView, ToolHost, ToolPointer } from './tools/types';

export interface EngineElements {
  stage: HTMLElement;
  background: HTMLCanvasElement;
  ink: HTMLCanvasElement;
  highlight: HTMLCanvasElement;
  live: HTMLCanvasElement;
  textLayer: HTMLElement;
  imageLayer: HTMLElement;
}

/** What a right-click landed on. */
export type ContextTarget =
  | { kind: 'canvas' }
  /** Inside the frame of the current lasso selection. */
  | { kind: 'selection' }
  | { kind: 'image'; id: string; locked: boolean }
  | { kind: 'textBox'; id: string };

export interface ContextMenuRequest {
  /** Viewport position of the pointer, for placing the menu. */
  clientX: number;
  clientY: number;
  /** World position of the pointer, for pasting and inserting there. */
  x: number;
  y: number;
  target: ContextTarget;
}

export interface EngineCallbacks {
  /** Strokes were created or changed and must be persisted. */
  onStrokesPut(records: StrokeRecord[]): void;
  /** Strokes were removed and must be deleted from storage. */
  onStrokesDelete(ids: string[]): void;
  /** The camera stopped moving; persist it for the page. */
  onCameraSettled(pageId: string, camera: CameraState): void;
  /** The text tool was clicked on empty canvas at a world position. */
  onTextRequest(pageId: string, x: number, y: number): void;
  onHistoryChange(canUndo: boolean, canRedo: boolean): void;
  /** Image records were created or changed and must be persisted. */
  onImagesPut(records: ImageRecord[]): void;
  /** Images were created; their pixels must be persisted (once, they never change). */
  onImageBlobsPut(entries: ImageEntry[]): void;
  /** Images were removed; their records and pixels must be deleted from storage. */
  onImagesDelete(ids: string[]): void;
  /** Text boxes were added (paste, undo); the UI owns them, the engine only keeps their history. */
  onTextBoxesPut(records: TextBoxRecord[]): void;
  onTextBoxesDelete(ids: string[]): void;
  /** The canvas was right-clicked; show the context menu. */
  onContextMenu(request: ContextMenuRequest): void;
}

type Gesture =
  | { kind: 'pan'; pointerId: number; lastX: number; lastY: number }
  | { kind: 'tool'; pointerId: number; tool: EngineTool }
  | { kind: 'text'; pointerId: number; startX: number; startY: number }
  | { kind: 'pinch'; distance: number; midX: number; midY: number };

const CAMERA_SETTLE_MS = 180;
const FOLLOW_UP_MS = 40;
const TEXT_CLICK_SLOP_PX = 5;
const PEN_ERASER_BUTTON = 5;
const TEXT_BOX_SELECTOR = '[data-text-box]';

const TOOL_CURSORS: Record<ToolSettings['tool'], string> = {
  pen: 'crosshair',
  highlighter: 'crosshair',
  eraser: 'none',
  lasso: 'crosshair',
  text: 'text',
  pan: 'grab',
};

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

export class CanvasEngine implements ToolHost {
  readonly model = new StrokeModel();

  private readonly inkLayer: StrokeLayer;
  private readonly highlightLayer: StrokeLayer;
  private readonly imageLayer: ImageLayer;
  private readonly backgroundCtx: CanvasRenderingContext2D;
  private readonly liveCtx: CanvasRenderingContext2D;
  private readonly drawTool: DrawTool;
  private readonly eraserTool: EraserTool;
  private readonly lassoTool: LassoTool;
  private readonly histories = new Map<string, HistoryStack<HistoryEntry>>();
  private readonly resizeObserver: ResizeObserver;
  private readonly touches = new Map<number, { x: number; y: number }>();

  private cameraState: CameraState = { ...DEFAULT_CAMERA };
  private theme: ThemeMode;
  private toolSettings: ToolSettings;
  private background: PageBackground = 'blank';
  private currentPageId: string | null = null;
  private history = new HistoryStack<HistoryEntry>();

  private cssWidth = 1;
  private cssHeight = 1;
  private dpr = 1;
  private stageLeft = 0;
  private stageTop = 0;

  private rafId = 0;
  private cameraDirty = true;
  private backgroundDirty = true;
  private overlayDirty = true;
  private appliedZoom = 0;

  private gesture: Gesture | null = null;
  /** Last pointer position over the stage (CSS px), or null when the pointer is elsewhere. */
  private lastPointer: { sx: number; sy: number } | null = null;
  private imagesDirty = true;
  private spaceHeld = false;
  private cameraTimer = 0;
  private followUpTimer = 0;
  private safariGestureZoom = 1;
  private destroyed = false;

  constructor(
    private readonly els: EngineElements,
    private readonly callbacks: EngineCallbacks,
    initial: { theme: ThemeMode; settings: ToolSettings },
  ) {
    this.theme = initial.theme;
    this.toolSettings = initial.settings;
    this.inkLayer = new StrokeLayer(els.ink, this.model, 'pen');
    this.highlightLayer = new StrokeLayer(els.highlight, this.model, 'highlighter');
    this.imageLayer = new ImageLayer(els.imageLayer);
    const backgroundCtx = els.background.getContext('2d');
    const liveCtx = els.live.getContext('2d', { desynchronized: true });
    if (!backgroundCtx || !liveCtx) throw new Error('2D canvas context is not available');
    this.backgroundCtx = backgroundCtx;
    this.liveCtx = liveCtx;
    this.drawTool = new DrawTool(this);
    this.eraserTool = new EraserTool(this);
    this.lassoTool = new LassoTool(this);

    const stage = els.stage;
    stage.addEventListener('pointerdown', this.onPointerDown);
    stage.addEventListener('pointermove', this.onPointerMove);
    stage.addEventListener('pointerup', this.onPointerUp);
    stage.addEventListener('pointercancel', this.onPointerCancel);
    stage.addEventListener('pointerleave', this.onPointerLeave);
    stage.addEventListener('wheel', this.onWheel, { passive: false });
    stage.addEventListener('mousedown', this.onMouseDown);
    stage.addEventListener('contextmenu', this.onContextMenu);
    stage.addEventListener('gesturestart', this.onSafariGestureStart);
    stage.addEventListener('gesturechange', this.onSafariGestureChange);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onWindowBlur);
    window.addEventListener('resize', this.onResize);

    this.resizeObserver = new ResizeObserver(this.onResize);
    this.resizeObserver.observe(stage);
    this.applyToolState();
    this.onResize();
  }

  // ---------------------------------------------------------------- public API

  destroy(): void {
    if (this.destroyed) return;
    // Ends a stroke in progress, which also clears the draw tool's hold-to-snap timers.
    this.cancelGesture();
    this.flushCamera();
    this.destroyed = true;
    const stage = this.els.stage;
    stage.removeEventListener('pointerdown', this.onPointerDown);
    stage.removeEventListener('pointermove', this.onPointerMove);
    stage.removeEventListener('pointerup', this.onPointerUp);
    stage.removeEventListener('pointercancel', this.onPointerCancel);
    stage.removeEventListener('pointerleave', this.onPointerLeave);
    stage.removeEventListener('wheel', this.onWheel);
    stage.removeEventListener('mousedown', this.onMouseDown);
    stage.removeEventListener('contextmenu', this.onContextMenu);
    stage.removeEventListener('gesturestart', this.onSafariGestureStart);
    stage.removeEventListener('gesturechange', this.onSafariGestureChange);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onWindowBlur);
    window.removeEventListener('resize', this.onResize);
    this.resizeObserver.disconnect();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    if (this.followUpTimer) window.clearTimeout(this.followUpTimer);
    this.followUpTimer = 0;
    this.imageLayer.clear();
  }

  /** Replaces the displayed page. Pass `null` to show an empty surface. */
  loadPage(
    page: { id: string; camera: CameraState; background: PageBackground } | null,
    strokes: readonly StrokeRecord[],
    images: readonly ImageEntry[] = [],
  ): void {
    this.cancelGesture();
    this.flushCamera();
    this.lassoTool.clearSelection();
    this.currentPageId = page ? page.id : null;
    this.model.load(strokes);
    this.imageLayer.load(images);
    this.imagesDirty = true;
    this.cameraState = sanitizeCamera(page ? page.camera : null);
    this.background = page ? page.background : 'blank';
    if (page) {
      let history = this.histories.get(page.id);
      if (!history) {
        history = new HistoryStack<HistoryEntry>();
        this.histories.set(page.id, history);
      }
      this.history = history;
    } else {
      this.history = new HistoryStack<HistoryEntry>();
    }
    this.inkLayer.invalidateAll();
    this.highlightLayer.invalidateAll();
    this.cameraDirty = true;
    this.backgroundDirty = true;
    this.overlayDirty = true;
    this.emitHistory();
    this.renderNow();
  }

  /** Forgets the undo history of a page (e.g. after the page was deleted). */
  forgetPage(pageId: string): void {
    this.histories.delete(pageId);
  }

  setSettings(settings: ToolSettings): void {
    const toolChanged = settings.tool !== this.toolSettings.tool;
    this.toolSettings = settings;
    if (toolChanged) {
      this.cancelGesture();
      this.lassoTool.clearSelection();
      this.eraserTool.hover(null);
      // Leaving the text tool ends text editing, so the caret never lingers under a drawing tool.
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && this.els.textLayer.contains(focused)) focused.blur();
    }
    this.applyToolState();
    this.requestOverlay();
  }

  setTheme(theme: ThemeMode): void {
    if (theme === this.theme) return;
    this.theme = theme;
    this.inkLayer.invalidateAll();
    this.highlightLayer.invalidateAll();
    this.backgroundDirty = true;
    this.overlayDirty = true;
    this.schedule();
  }

  setBackground(background: PageBackground): void {
    if (background === this.background) return;
    this.background = background;
    this.backgroundDirty = true;
    this.schedule();
  }

  getCamera(): CameraState {
    return { ...this.cameraState };
  }

  /** Zooms by a factor around the centre of the viewport (toolbar buttons). */
  zoomBy(factor: number): void {
    this.setCamera(
      zoomAtScreenPoint(this.cameraState, this.cssWidth / 2, this.cssHeight / 2, this.cameraState.zoom * factor),
    );
  }

  /** Returns to 100% zoom, keeping the centre of the viewport in place. */
  resetZoom(): void {
    this.setCamera(zoomAtScreenPoint(this.cameraState, this.cssWidth / 2, this.cssHeight / 2, 1));
  }

  undo(): void {
    const entry = this.history.undo();
    if (!entry) return;
    this.applyHistory(entry, true);
    this.emitHistory();
  }

  redo(): void {
    const entry = this.history.redo();
    if (!entry) return;
    this.applyHistory(entry, false);
    this.emitHistory();
  }

  /** Emits a pending camera change immediately (page switch, tab hide, unmount). */
  flushCamera(): void {
    if (!this.cameraTimer) return;
    window.clearTimeout(this.cameraTimer);
    this.cameraTimer = 0;
    if (this.currentPageId) this.callbacks.onCameraSettled(this.currentPageId, this.getCamera());
  }

  // ------------------------------------------------- objects, selection, images

  /** Converts a viewport position (`clientX` / `clientY`) to world coordinates. */
  clientToWorld(clientX: number, clientY: number): { x: number; y: number } {
    this.measureStage();
    return screenToWorld(this.cameraState, clientX - this.stageLeft, clientY - this.stageTop);
  }

  /** Where keyboard pastes land: under the pointer when it is over the canvas, else the centre of the view. */
  pasteAnchor(): { x: number; y: number } {
    const point = this.lastPointer ?? { sx: this.cssWidth / 2, sy: this.cssHeight / 2 };
    return screenToWorld(this.cameraState, point.sx, point.sy);
  }

  /** Size of the visible part of the page in world units. */
  viewSize(): { width: number; height: number } {
    return { width: this.cssWidth / this.cameraState.zoom, height: this.cssHeight / this.cameraState.zoom };
  }

  get hasSelection(): boolean {
    return this.lassoTool.hasSelection;
  }

  /** Everything in the lasso selection (strokes and images). */
  selectedObjects(): ObjectSet {
    const { strokeIds, imageIds } = this.lassoTool.selection();
    const set = emptyObjectSet();
    for (const id of strokeIds) {
      const item = this.model.get(id);
      if (item) set.strokes.push(item.record);
    }
    for (const id of imageIds) {
      const image = this.imageLayer.get(id);
      if (image) set.images.push({ record: image.record, blob: image.blob });
    }
    return set;
  }

  /** Selects the given strokes and images with the lasso (the caller makes the lasso the active tool). */
  selectObjects(strokeIds: readonly string[], imageIds: readonly string[]): void {
    this.lassoTool.select(strokeIds, imageIds);
  }

  deleteSelection(): boolean {
    return this.lassoTool.deleteSelection();
  }

  imageEntry(id: string): ImageEntry | undefined {
    const image = this.imageLayer.get(id);
    return image ? { record: image.record, blob: image.blob } : undefined;
  }

  /** Paint orders that put new strokes / images in front of everything on the page. */
  nextStrokeOrder(): number {
    return this.model.nextOrder();
  }

  nextImageOrder(): number {
    return this.imageLayer.frontOrder();
  }

  /**
   * Adds and / or removes page objects as one undoable step (paste, cut,
   * duplicate, insert image, delete). Objects that no longer exist are ignored.
   */
  changeObjects(added: ObjectSet, removed: ObjectSet): void {
    if (!this.currentPageId) return;
    this.cancelGesture();
    const actuallyRemoved = this.takeObjects(removed);
    this.putObjects(added);
    if (isEmptyObjectSet(added) && isEmptyObjectSet(actuallyRemoved)) return;
    this.pushHistory({ type: 'objects', added, removed: actuallyRemoved });
  }

  /** Locks or unlocks an image (undoable). A locked image leaves the selection. */
  setImageLocked(id: string, locked: boolean): void {
    const image = this.imageLayer.get(id);
    if (!image || image.record.locked === locked) return;
    this.changeImage(image.record, { ...image.record, locked });
  }

  /** Moves an image in front of or behind every other image (undoable). Ink always stays on top. */
  restackImage(id: string, where: 'front' | 'back'): void {
    const image = this.imageLayer.get(id);
    if (!image || image.record.locked) return;
    const order = where === 'front' ? this.imageLayer.frontOrder() : this.imageLayer.backOrder();
    this.changeImage(image.record, { ...image.record, order });
  }

  // ------------------------------------------------------------------ ToolHost

  camera(): CameraState {
    return this.cameraState;
  }

  settings(): ToolSettings {
    return this.toolSettings;
  }

  pageId(): string | null {
    return this.currentPageId;
  }

  addStroke(record: StrokeRecord): void {
    this.insertRecords([record]);
    this.pushHistory({ type: 'add', strokes: [record] });
  }

  removeStrokes(ids: readonly string[], recordHistory: boolean): StrokeRecord[] {
    const removed: StrokeRecord[] = [];
    for (const id of ids) {
      const item = this.model.remove(id);
      if (!item) continue;
      removed.push(item.record);
      this.layerFor(item).invalidateRect(item.bounds);
    }
    if (removed.length === 0) return removed;
    this.callbacks.onStrokesDelete(removed.map((record) => record.id));
    this.lassoTool.pruneSelection();
    if (recordHistory) this.pushHistory({ type: 'remove', strokes: removed });
    this.schedule();
    return removed;
  }

  translateStrokes(ids: readonly string[], dx: number, dy: number, recordHistory: boolean): void {
    const changed: StrokeRecord[] = [];
    for (const id of ids) {
      const item = this.model.get(id);
      if (!item) continue;
      const layer = this.layerFor(item);
      layer.invalidateRect(item.bounds);
      this.model.translate(item, dx, dy);
      layer.invalidateRect(item.bounds);
      changed.push(item.record);
    }
    if (changed.length === 0) return;
    this.callbacks.onStrokesPut(changed);
    if (recordHistory) this.pushHistory({ type: 'move', ids: changed.map((record) => record.id), imageIds: [], dx, dy });
    this.schedule();
  }

  translateObjects(strokeIds: readonly string[], imageIds: readonly string[], dx: number, dy: number): void {
    this.translateStrokes(strokeIds, dx, dy, false);
    const moved = this.translateImages(imageIds, dx, dy);
    const ids = strokeIds.filter((id) => this.model.get(id) !== undefined);
    if (ids.length === 0 && moved.length === 0) return;
    this.pushHistory({ type: 'move', ids, imageIds: moved, dx, dy });
  }

  removeObjects(strokeIds: readonly string[], imageIds: readonly string[]): void {
    const removed = emptyObjectSet();
    for (const id of strokeIds) {
      const item = this.model.get(id);
      if (item) removed.strokes.push(item.record);
    }
    for (const id of imageIds) {
      const entry = this.imageEntry(id);
      // Locked images are protected from every kind of deletion.
      if (entry && !entry.record.locked) removed.images.push(entry);
    }
    this.changeObjects(emptyObjectSet(), removed);
  }

  images(): ImageItem[] {
    return this.imageLayer.all();
  }

  image(id: string): ImageItem | undefined {
    return this.imageLayer.get(id);
  }

  selectableImageAt(x: number, y: number): ImageItem | null {
    return this.imageLayer.topAt(x, y, false);
  }

  previewImage(id: string, box: Box | null): void {
    this.imageLayer.preview(id, box);
    this.imagesDirty = true;
    this.requestOverlay();
  }

  resizeImage(id: string, box: Box): void {
    const image = this.imageLayer.get(id);
    if (!image || image.record.locked) return;
    this.changeImage(image.record, {
      ...image.record,
      x: round2(box.x),
      y: round2(box.y),
      width: round2(box.width),
      height: round2(box.height),
    });
  }

  pushHistory(entry: HistoryEntry): void {
    this.history.push(entry);
    this.emitHistory();
  }

  setHidden(items: Iterable<StrokeItem>, hidden: boolean): void {
    for (const item of items) {
      if (item.hidden === hidden) continue;
      item.hidden = hidden;
      this.layerFor(item).invalidateRect(item.bounds);
    }
    this.schedule();
  }

  requestOverlay(): void {
    this.overlayDirty = true;
    this.schedule();
  }

  // ------------------------------------------------------------------- history

  private applyHistory(entry: HistoryEntry, revert: boolean): void {
    this.cancelGesture();
    this.lassoTool.clearSelection();
    switch (entry.type) {
      case 'add':
        if (revert) this.removeStrokes(entry.strokes.map((s) => s.id), false);
        else this.insertRecords(entry.strokes);
        break;
      case 'remove':
        if (revert) this.insertRecords(entry.strokes);
        else this.removeStrokes(entry.strokes.map((s) => s.id), false);
        break;
      case 'move':
        this.translateStrokes(entry.ids, revert ? -entry.dx : entry.dx, revert ? -entry.dy : entry.dy, false);
        this.translateImages(entry.imageIds, revert ? -entry.dx : entry.dx, revert ? -entry.dy : entry.dy);
        break;
      case 'objects':
        this.takeObjects(revert ? entry.added : entry.removed);
        this.putObjects(revert ? entry.removed : entry.added);
        break;
      case 'image':
        this.applyImageRecord(revert ? entry.before : entry.after);
        break;
    }
  }

  /** Puts objects on the page and into storage, without recording history. */
  private putObjects(set: ObjectSet): void {
    this.insertRecords(set.strokes);
    if (set.images.length > 0) {
      for (const entry of set.images) this.imageLayer.add(entry);
      this.callbacks.onImagesPut(set.images.map((entry) => entry.record));
      this.callbacks.onImageBlobsPut(set.images.slice());
      this.imagesDirty = true;
      this.schedule();
    }
    if (set.textBoxes.length > 0) this.callbacks.onTextBoxesPut(set.textBoxes.slice());
  }

  /** Takes objects off the page and out of storage, without recording history. Returns what existed. */
  private takeObjects(set: ObjectSet): ObjectSet {
    const taken = emptyObjectSet();
    taken.strokes = this.removeStrokes(set.strokes.map((stroke) => stroke.id), false);
    for (const { record } of set.images) {
      const entry = this.imageLayer.remove(record.id);
      if (entry) taken.images.push(entry);
    }
    if (taken.images.length > 0) {
      this.callbacks.onImagesDelete(taken.images.map((entry) => entry.record.id));
      this.lassoTool.pruneSelection();
      this.requestOverlay();
    }
    if (set.textBoxes.length > 0) {
      taken.textBoxes = set.textBoxes.slice();
      this.callbacks.onTextBoxesDelete(set.textBoxes.map((box) => box.id));
    }
    return taken;
  }

  private translateImages(ids: readonly string[], dx: number, dy: number): string[] {
    const moved: string[] = [];
    for (const id of ids) {
      const image = this.imageLayer.get(id);
      if (!image) continue;
      this.applyImageRecord({ ...image.record, x: round2(image.record.x + dx), y: round2(image.record.y + dy) });
      moved.push(id);
    }
    return moved;
  }

  /** Changes one image in place as an undoable step. */
  private changeImage(before: ImageRecord, after: ImageRecord): void {
    this.cancelGesture();
    this.applyImageRecord(after);
    this.pushHistory({ type: 'image', before, after });
  }

  private applyImageRecord(record: ImageRecord): void {
    if (!this.imageLayer.get(record.id)) return;
    this.imageLayer.update(record);
    this.callbacks.onImagesPut([record]);
    this.imagesDirty = true;
    // A locked image leaves the selection; a moved or resized one changes the selection frame.
    this.lassoTool.pruneSelection();
    this.requestOverlay();
  }

  private insertRecords(records: readonly StrokeRecord[]): void {
    if (records.length === 0) return;
    for (const record of records) {
      const onTop = record.order >= this.model.nextOrder();
      const item = this.model.add(record);
      const layer = this.layerFor(item);
      if (onTop) layer.paintOnTop(item);
      else layer.invalidateRect(item.bounds);
    }
    this.callbacks.onStrokesPut(records.slice());
    this.schedule();
  }

  private emitHistory(): void {
    this.callbacks.onHistoryChange(this.history.canUndo, this.history.canRedo);
  }

  private layerFor(item: StrokeItem): StrokeLayer {
    return item.record.tool === 'highlighter' ? this.highlightLayer : this.inkLayer;
  }

  // -------------------------------------------------------------------- camera

  private setCamera(next: CameraState): void {
    const current = this.cameraState;
    if (next.x === current.x && next.y === current.y && next.zoom === current.zoom) return;
    this.cameraState = next;
    this.cameraDirty = true;
    this.schedule();
    // The page moved under a stroke in progress, so the pointer is not resting on it.
    this.drawTool.interruptHold();
    if (this.cameraTimer) window.clearTimeout(this.cameraTimer);
    this.cameraTimer = window.setTimeout(() => {
      this.cameraTimer = 0;
      if (this.currentPageId) this.callbacks.onCameraSettled(this.currentPageId, this.getCamera());
    }, CAMERA_SETTLE_MS);
  }

  private applyTextLayerTransform(): void {
    const { x, y, zoom } = this.cameraState;
    const layer = this.els.textLayer;
    layer.style.transform = `translate(${-x * zoom}px, ${-y * zoom}px) scale(${zoom})`;
    if (zoom !== this.appliedZoom) {
      this.appliedZoom = zoom;
      // Lets per-box chrome (drag handle, format bar) keep a constant on-screen size.
      layer.style.setProperty('--inv-zoom', String(1 / zoom));
    }
  }

  // ----------------------------------------------------------------- rendering

  private schedule(): void {
    if (this.rafId || this.destroyed) return;
    this.rafId = requestAnimationFrame(this.frame);
  }

  private renderNow(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.frame();
  }

  private readonly frame = (): void => {
    this.rafId = 0;
    if (this.destroyed) return;
    const camera = this.cameraState;
    this.model.beginFrame();

    if (this.cameraDirty) {
      this.applyTextLayerTransform();
      this.imageLayer.setCamera(camera);
      this.backgroundDirty = true;
      this.overlayDirty = true;
    }
    if (this.cameraDirty || this.imagesDirty) {
      // Images outside the view (plus a margin, so panning never reveals a blank) are hidden.
      const marginX = this.cssWidth / camera.zoom / 2;
      const marginY = this.cssHeight / camera.zoom / 2;
      this.imageLayer.cull({
        minX: camera.x - marginX,
        minY: camera.y - marginY,
        maxX: camera.x + this.cssWidth / camera.zoom + marginX,
        maxY: camera.y + this.cssHeight / camera.zoom + marginY,
      });
      this.imagesDirty = false;
    }
    if (this.backgroundDirty) {
      drawBackground(
        this.backgroundCtx,
        this.els.background.width,
        this.els.background.height,
        this.dpr,
        camera,
        this.background,
        this.theme,
      );
    }
    // The layers decide for themselves whether anything has to be repainted.
    const now = performance.now();
    const inkPending = this.inkLayer.render(camera, this.theme, now);
    const highlightPending = this.highlightLayer.render(camera, this.theme, now);
    if (this.overlayDirty) this.renderOverlay();
    // A layer showing a rescaled zoom preview asks to be rendered again once the zoom settles.
    if ((inkPending || highlightPending) && !this.followUpTimer) {
      this.followUpTimer = window.setTimeout(() => {
        this.followUpTimer = 0;
        this.schedule();
      }, FOLLOW_UP_MS);
    }

    this.cameraDirty = false;
    this.backgroundDirty = false;
    this.overlayDirty = false;
    this.model.trimPathCache();
  };

  private renderOverlay(): void {
    const ctx = this.liveCtx;
    const live = this.els.live;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, live.width, live.height);
    // A highlighter stroke in progress must blend exactly like committed highlighter ink.
    live.classList.toggle('is-highlighter', this.drawTool.drawingTool === 'highlighter');

    const scale = this.cameraState.zoom * this.dpr;
    const view: OverlayView = {
      scale,
      offX: snappedOffset(this.cameraState.x, scale),
      offY: snappedOffset(this.cameraState.y, scale),
      dpr: this.dpr,
      zoom: this.cameraState.zoom,
      theme: this.theme,
    };
    this.drawTool.drawOverlay(ctx, view);
    if (this.toolSettings.tool === 'lasso') this.lassoTool.drawOverlay(ctx, view);
    if (this.toolSettings.tool === 'eraser' || (this.gesture?.kind === 'tool' && this.gesture.tool === this.eraserTool)) {
      this.eraserTool.drawOverlay(ctx, view);
    }
  }

  private readonly onResize = (): void => {
    if (this.destroyed) return;
    const stage = this.els.stage;
    const width = Math.max(1, stage.clientWidth);
    const height = Math.max(1, stage.clientHeight);
    const dpr = window.devicePixelRatio || 1;
    this.measureStage();
    if (width === this.cssWidth && height === this.cssHeight && dpr === this.dpr) return;
    this.cssWidth = width;
    this.cssHeight = height;
    this.dpr = dpr;
    for (const canvas of [this.els.background, this.els.live]) {
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
    }
    this.inkLayer.resize(width, height, dpr);
    this.highlightLayer.resize(width, height, dpr);
    this.cameraDirty = true;
    this.backgroundDirty = true;
    this.overlayDirty = true;
    // Resizing clears the canvases; repaint in the same task to avoid a blank frame.
    this.renderNow();
  };

  private measureStage(): void {
    const rect = this.els.stage.getBoundingClientRect();
    this.stageLeft = rect.left;
    this.stageTop = rect.top;
  }

  // --------------------------------------------------------------------- input

  private toPointer(e: PointerEvent): ToolPointer {
    const sx = e.clientX - this.stageLeft;
    const sy = e.clientY - this.stageTop;
    const world = screenToWorld(this.cameraState, sx, sy);
    return { sx, sy, x: world.x, y: world.y, pressure: e.pressure, time: e.timeStamp, pointerType: e.pointerType };
  }

  private isPanIntent(e: PointerEvent): boolean {
    return e.button === 1 || (e.button === 0 && (this.spaceHeld || this.toolSettings.tool === 'pan'));
  }

  private toolForPointer(e: PointerEvent): EngineTool | null {
    if (e.button === PEN_ERASER_BUTTON) return this.eraserTool;
    if (e.button !== 0) return null;
    switch (this.toolSettings.tool) {
      case 'pen':
      case 'highlighter':
        return this.drawTool;
      case 'eraser':
        return this.eraserTool;
      case 'lasso':
        return this.lassoTool;
      default:
        return null;
    }
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.measureStage();
    this.lastPointer = { sx: e.clientX - this.stageLeft, sy: e.clientY - this.stageTop };
    const insideTextBox = e.target instanceof Element && e.target.closest(TEXT_BOX_SELECTOR) !== null;

    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size === 2) {
        this.cancelGesture();
        this.beginPinch();
        return;
      }
      if (this.touches.size > 2) return;
    }
    if (this.gesture) return;

    if (this.isPanIntent(e)) {
      this.gesture = { kind: 'pan', pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY };
    } else if (insideTextBox) {
      return;
    } else if (e.button === 0 && this.toolSettings.tool === 'text') {
      this.gesture = { kind: 'text', pointerId: e.pointerId, startX: e.clientX, startY: e.clientY };
    } else {
      const tool = this.toolForPointer(e);
      if (!tool) return;
      this.gesture = { kind: 'tool', pointerId: e.pointerId, tool };
      tool.begin(this.toPointer(e));
    }
    this.capture(e.pointerId);
    this.updateCursor();
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const gesture = this.gesture;
    this.lastPointer = { sx: e.clientX - this.stageLeft, sy: e.clientY - this.stageTop };
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (gesture?.kind === 'pinch') {
        this.updatePinch(gesture);
        return;
      }
    }
    if (!gesture) {
      if (this.toolSettings.tool === 'eraser' && e.pointerType !== 'touch') this.eraserTool.hover(this.toPointer(e));
      return;
    }
    if (gesture.kind === 'pinch' || gesture.pointerId !== e.pointerId) return;

    if (gesture.kind === 'pan') {
      this.setCamera(panByScreenDelta(this.cameraState, e.clientX - gesture.lastX, e.clientY - gesture.lastY));
      gesture.lastX = e.clientX;
      gesture.lastY = e.clientY;
    } else if (gesture.kind === 'tool') {
      // Coalesced events expose every sensor sample since the last frame (pens report 120-240 Hz).
      const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      const events = coalesced.length > 0 ? coalesced : [e];
      const pointers: ToolPointer[] = new Array(events.length);
      for (let i = 0; i < events.length; i++) pointers[i] = this.toPointer(events[i]);
      gesture.tool.move(pointers);
    }
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    this.touches.delete(e.pointerId);
    const gesture = this.gesture;
    if (!gesture) return;
    if (gesture.kind === 'pinch') {
      if (this.touches.size < 2) this.gesture = null;
      return;
    }
    if (gesture.pointerId !== e.pointerId) return;
    this.gesture = null;
    this.release(e.pointerId);
    if (gesture.kind === 'tool') {
      gesture.tool.end(this.toPointer(e));
    } else if (gesture.kind === 'text') {
      const moved = Math.hypot(e.clientX - gesture.startX, e.clientY - gesture.startY);
      if (moved <= TEXT_CLICK_SLOP_PX && this.currentPageId) {
        const pointer = this.toPointer(e);
        this.callbacks.onTextRequest(this.currentPageId, pointer.x, pointer.y);
      }
    }
    this.updateCursor();
  };

  private readonly onPointerCancel = (e: PointerEvent): void => {
    this.touches.delete(e.pointerId);
    const gesture = this.gesture;
    if (!gesture) return;
    if (gesture.kind === 'pinch') {
      if (this.touches.size < 2) this.gesture = null;
      return;
    }
    if (gesture.pointerId === e.pointerId) this.cancelGesture();
  };

  private readonly onPointerLeave = (): void => {
    if (this.gesture) return;
    this.eraserTool.hover(null);
    this.lastPointer = null;
  };

  private capture(pointerId: number): void {
    try {
      this.els.stage.setPointerCapture(pointerId);
    } catch {
      // The pointer may already be gone (e.g. synthetic events); capture is an optimisation only.
    }
  }

  private release(pointerId: number): void {
    try {
      if (this.els.stage.hasPointerCapture(pointerId)) this.els.stage.releasePointerCapture(pointerId);
    } catch {
      // Nothing to release.
    }
  }

  private cancelGesture(): void {
    const gesture = this.gesture;
    if (!gesture) return;
    this.gesture = null;
    if (gesture.kind === 'tool') gesture.tool.cancel();
    if (gesture.kind !== 'pinch') this.release(gesture.pointerId);
    this.updateCursor();
  }

  private pinchMetrics(): { distance: number; midX: number; midY: number } | null {
    if (this.touches.size < 2) return null;
    const [a, b] = [...this.touches.values()];
    return {
      distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
      midX: (a.x + b.x) / 2 - this.stageLeft,
      midY: (a.y + b.y) / 2 - this.stageTop,
    };
  }

  private beginPinch(): void {
    const metrics = this.pinchMetrics();
    if (metrics) this.gesture = { kind: 'pinch', ...metrics };
  }

  private updatePinch(gesture: Extract<Gesture, { kind: 'pinch' }>): void {
    const metrics = this.pinchMetrics();
    if (!metrics) return;
    const panned = panByScreenDelta(this.cameraState, metrics.midX - gesture.midX, metrics.midY - gesture.midY);
    const zoom = panned.zoom * (metrics.distance / gesture.distance);
    this.setCamera(zoomAtScreenPoint(panned, metrics.midX, metrics.midY, zoom));
    gesture.distance = metrics.distance;
    gesture.midX = metrics.midX;
    gesture.midY = metrics.midY;
  }

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.measureStage();
    const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? this.cssHeight : 1;
    let dx = e.deltaX * unit;
    let dy = e.deltaY * unit;
    if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd + wheel and trackpad pinch (delivered as ctrl+wheel): zoom around the cursor.
      const sx = e.clientX - this.stageLeft;
      const sy = e.clientY - this.stageTop;
      this.setCamera(zoomAtScreenPoint(this.cameraState, sx, sy, this.cameraState.zoom * wheelZoomFactor(dy)));
      return;
    }
    if (e.shiftKey && dx === 0) {
      dx = dy;
      dy = 0;
    }
    this.setCamera(panByScreenDelta(this.cameraState, -dx, -dy));
  };

  /** Safari reports trackpad pinches as proprietary gesture events instead of ctrl+wheel. */
  private readonly onSafariGestureStart = (e: Event): void => {
    e.preventDefault();
    this.safariGestureZoom = this.cameraState.zoom;
  };

  private readonly onSafariGestureChange = (e: Event): void => {
    e.preventDefault();
    const gestureEvent = e as Event & { scale?: number; clientX?: number; clientY?: number };
    if (typeof gestureEvent.scale !== 'number') return;
    this.measureStage();
    const sx = (gestureEvent.clientX ?? this.stageLeft + this.cssWidth / 2) - this.stageLeft;
    const sy = (gestureEvent.clientY ?? this.stageTop + this.cssHeight / 2) - this.stageTop;
    this.setCamera(zoomAtScreenPoint(this.cameraState, sx, sy, this.safariGestureZoom * gestureEvent.scale));
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    // Stops the browser's middle-click auto-scroll so the button can pan.
    if (e.button === 1) e.preventDefault();
  };

  private readonly onContextMenu = (e: MouseEvent): void => {
    // While text is being edited the browser's own menu (text copy / paste, spelling) is kept.
    const editing = document.activeElement instanceof HTMLElement && document.activeElement.isContentEditable;
    if (editing && e.target instanceof Node && document.activeElement?.contains(e.target)) return;
    e.preventDefault();
    // A right-click never draws or pans; this also ends the stroke that Ctrl+click starts on macOS.
    this.cancelGesture();
    if (!this.currentPageId) return;
    this.measureStage();
    const { x, y } = screenToWorld(this.cameraState, e.clientX - this.stageLeft, e.clientY - this.stageTop);
    this.callbacks.onContextMenu({ clientX: e.clientX, clientY: e.clientY, x, y, target: this.contextTargetAt(e, x, y) });
  };

  /** Decides what a right-click refers to: the selection, a text box, an image or the empty page. */
  private contextTargetAt(e: MouseEvent, x: number, y: number): ContextTarget {
    if (this.lassoTool.frameContains(x, y)) return { kind: 'selection' };
    // Text boxes ignore pointer events under most tools, so they are found by their rectangles.
    for (const box of this.els.textLayer.querySelectorAll<HTMLElement>(TEXT_BOX_SELECTOR)) {
      const rect = box.getBoundingClientRect();
      const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
      if (inside && box.dataset.textBox) return { kind: 'textBox', id: box.dataset.textBox };
    }
    const image = this.imageLayer.topAt(x, y, true);
    if (image) return { kind: 'image', id: image.record.id, locked: image.record.locked };
    return { kind: 'canvas' };
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (isEditableTarget(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (e.code === 'Space' && !mod) {
      e.preventDefault();
      if (!this.spaceHeld) {
        this.spaceHeld = true;
        this.applyToolState();
      }
      return;
    }
    if (mod && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && key === 'y') {
      e.preventDefault();
      this.redo();
      return;
    }
    if (mod && key === '0') {
      e.preventDefault();
      this.resetZoom();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.lassoTool.hasSelection) {
      e.preventDefault();
      this.lassoTool.deleteSelection();
      return;
    }
    if (e.key === 'Escape') {
      this.cancelGesture();
      this.lassoTool.clearSelection();
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Space' && this.spaceHeld) {
      this.spaceHeld = false;
      this.applyToolState();
    }
  };

  private readonly onWindowBlur = (): void => {
    if (this.spaceHeld) {
      this.spaceHeld = false;
      this.applyToolState();
    }
  };

  /** Reflects tool state on the stage element; CSS uses it to route pointer events. */
  private applyToolState(): void {
    const stage = this.els.stage;
    stage.dataset.tool = this.toolSettings.tool;
    if (this.spaceHeld) stage.dataset.panning = 'true';
    else delete stage.dataset.panning;
    this.updateCursor();
  }

  private updateCursor(): void {
    let cursor = TOOL_CURSORS[this.toolSettings.tool];
    if (this.gesture?.kind === 'pan') cursor = 'grabbing';
    else if (this.spaceHeld) cursor = 'grab';
    this.els.stage.style.cursor = cursor;
  }
}
