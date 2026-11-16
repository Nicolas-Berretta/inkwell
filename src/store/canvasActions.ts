/**
 * Clipboard, image and object commands for the canvas, shared by the context
 * menu, the keyboard shortcuts, the toolbar and drag-and-drop.
 *
 * Everything that changes the page goes through `CanvasEngine.changeObjects`
 * (or the engine's image methods), so every command is one undoable step.
 *
 * Clipboard model (see `canvas/math/clipboard.ts` for the rules): copied
 * objects are kept in an internal clipboard that survives page switches.
 * Copying also writes a marker, and the text of copied text boxes, to the
 * system clipboard, so the most recent copy wins wherever it was made.
 */
import type { CanvasEngine, ContextTarget } from '../canvas/CanvasEngine';
import { ImageImportError, isSupportedImageType, prepareImage } from '../canvas/imageImport';
import type { InternalClipboardInfo, PasteMemory, SystemClipboardInfo } from '../canvas/math/clipboard';
import {
  CLIPBOARD_MARKER_TYPE,
  DEFAULT_TEXT_BOX_HEIGHT,
  choosePasteSource,
  cloneObjectSet,
  emptyObjectSet,
  isEmptyObjectSet,
  objectSetBounds,
  rememberPaste,
  textToDocument,
} from '../canvas/math/clipboard';
import type { Rect } from '../canvas/math/geometry';
import { fitImageSize } from '../canvas/math/imageGeometry';
import { round2 } from '../canvas/math/strokeGeometry';
import { newId } from '../db/factories';
import type { ImageEntry, ObjectSet, TextBoxRecord } from '../types';
import { DEFAULT_TEXT_BOX_WIDTH, useAppStore } from './appStore';
import { getActiveEngine } from './engineRegistry';

/** Screen-pixel shift between repeated pastes / duplicates, so copies never hide each other. */
const PASTE_STEP_PX = 16;

export interface Point {
  x: number;
  y: number;
}

interface InternalClipboard extends InternalClipboardInfo {
  objects: ObjectSet;
  /** Bounds of the objects when they were copied. */
  bounds: Rect;
}

let clipboard: InternalClipboard | null = null;
let pasteMemory: PasteMemory | null = null;
/** Objects a menu command wants copied by the `copy` event it is about to trigger. */
let pendingMenuCopy: ObjectSet | null = null;
let imagePicker: { open: () => void } | null = null;
let imagePickerTarget: Point | null = null;

function context(): { engine: CanvasEngine; pageId: string } | null {
  const engine = getActiveEngine();
  const pageId = useAppStore.getState().activePageId;
  return engine && pageId ? { engine, pageId } : null;
}

function textBoxHeight(box: TextBoxRecord): number {
  const element = document.querySelector<HTMLElement>(`[data-text-box="${CSS.escape(box.id)}"]`);
  return element ? element.offsetHeight : DEFAULT_TEXT_BOX_HEIGHT;
}

/** The objects a command applies to. */
export function objectsOfTarget(target: ContextTarget): ObjectSet {
  const set = emptyObjectSet();
  const engine = getActiveEngine();
  if (!engine) return set;
  if (target.kind === 'selection') return engine.selectedObjects();
  if (target.kind === 'image') {
    const entry = engine.imageEntry(target.id);
    if (entry) set.images.push(entry);
  } else if (target.kind === 'textBox') {
    const box = useAppStore.getState().textBoxes.find((candidate) => candidate.id === target.id);
    if (box) set.textBoxes.push(box);
  }
  return set;
}

/** Locked images are protected: they can be copied, but not cut, duplicated away or deleted. */
function withoutLockedImages(set: ObjectSet): ObjectSet {
  return { ...set, images: set.images.filter((entry) => !entry.record.locked) };
}

/** Makes the lasso the active tool right away, so a selection made next is kept and shown. */
function useLassoTool(engine: CanvasEngine): void {
  const store = useAppStore.getState();
  if (store.tools.tool === 'lasso') return;
  store.setTool('lasso');
  engine.setSettings(useAppStore.getState().tools);
}

function insertAndSelect(engine: CanvasEngine, set: ObjectSet): void {
  if (isEmptyObjectSet(set)) return;
  engine.changeObjects(set, emptyObjectSet());
  if (set.strokes.length > 0 || set.images.length > 0) {
    useLassoTool(engine);
    engine.selectObjects(
      set.strokes.map((stroke) => stroke.id),
      set.images.map((entry) => entry.record.id),
    );
  }
}

// ------------------------------------------------------------------- copy, cut

function storeInternally(objects: ObjectSet): InternalClipboard {
  clipboard = {
    token: newId(),
    text: objects.textBoxes.map((box) => box.plainText).join('\n\n'),
    objects,
    bounds: objectSetBounds(objects, textBoxHeight),
  };
  pasteMemory = null;
  return clipboard;
}

/**
 * Handles a `copy` or `cut` clipboard event: copies the objects a menu command
 * asked for, or else `fallback` (the selection, for a key press). Returns the
 * copied objects, which the caller removes for a cut, or null when there was
 * nothing to copy and the browser should handle the event itself.
 */
export function copyToClipboardEvent(event: ClipboardEvent, fallback: ObjectSet): ObjectSet | null {
  const objects = pendingMenuCopy ?? fallback;
  pendingMenuCopy = null;
  if (isEmptyObjectSet(objects)) return null;
  const stored = storeInternally(objects);
  if (event.clipboardData) {
    event.clipboardData.setData(CLIPBOARD_MARKER_TYPE, stored.token);
    if (stored.text.length > 0) event.clipboardData.setData('text/plain', stored.text);
    event.preventDefault();
  }
  return objects;
}

/** Copies objects from a menu command, through the browser's own copy path so the system clipboard is updated too. */
function copyFromMenu(objects: ObjectSet): void {
  if (isEmptyObjectSet(objects)) return;
  pendingMenuCopy = objects;
  try {
    document.execCommand('copy');
  } catch {
    // Handled below: the browser refused, so only the internal clipboard is used.
  }
  if (pendingMenuCopy !== null) {
    // No copy event was delivered; keep the objects internally so Paste still works inside the app.
    pendingMenuCopy = null;
    storeInternally(objects);
  }
}

export function copyTarget(target: ContextTarget): void {
  copyFromMenu(objectsOfTarget(target));
}

export function cutTarget(target: ContextTarget): void {
  const objects = withoutLockedImages(objectsOfTarget(target));
  copyFromMenu(objects);
  removeObjects(objects);
}

export function removeObjects(objects: ObjectSet): void {
  const ctx = context();
  if (!ctx) return;
  ctx.engine.changeObjects(emptyObjectSet(), withoutLockedImages(objects));
}

export function deleteTarget(target: ContextTarget): void {
  removeObjects(objectsOfTarget(target));
}

export function duplicateObjects(source: ObjectSet): void {
  const ctx = context();
  const objects = withoutLockedImages(source);
  if (!ctx || isEmptyObjectSet(objects)) return;
  const shift = PASTE_STEP_PX / ctx.engine.getCamera().zoom;
  insertAndSelect(
    ctx.engine,
    cloneObjectSet(objects, {
      pageId: ctx.pageId,
      dx: shift,
      dy: shift,
      newId,
      firstStrokeOrder: ctx.engine.nextStrokeOrder(),
      firstImageOrder: ctx.engine.nextImageOrder(),
      now: Date.now(),
    }),
  );
}

export function duplicateTarget(target: ContextTarget): void {
  duplicateObjects(objectsOfTarget(target));
}

// ----------------------------------------------------------------------- paste

function pasteInternal(at: Point): void {
  const ctx = context();
  if (!ctx || !clipboard) return;
  const zoom = ctx.engine.getCamera().zoom;
  pasteMemory = rememberPaste(pasteMemory, clipboard.token, at.x, at.y, 2 / zoom);
  const shift = (pasteMemory.count * PASTE_STEP_PX) / zoom;
  const { bounds } = clipboard;
  insertAndSelect(
    ctx.engine,
    cloneObjectSet(clipboard.objects, {
      pageId: ctx.pageId,
      dx: at.x + shift - (bounds.minX + bounds.maxX) / 2,
      dy: at.y + shift - (bounds.minY + bounds.maxY) / 2,
      newId,
      firstStrokeOrder: ctx.engine.nextStrokeOrder(),
      firstImageOrder: ctx.engine.nextImageOrder(),
      now: Date.now(),
    }),
  );
}

function pasteText(text: string, at: Point): void {
  const ctx = context();
  if (!ctx) return;
  const { content, plainText } = textToDocument(text);
  if (plainText.length === 0) return;
  const box: TextBoxRecord = {
    id: newId(),
    pageId: ctx.pageId,
    x: Math.round(at.x),
    y: Math.round(at.y),
    width: DEFAULT_TEXT_BOX_WIDTH,
    content,
    plainText,
    updatedAt: Date.now(),
  };
  ctx.engine.changeObjects({ strokes: [], images: [], textBoxes: [box] }, emptyObjectSet());
}

function applyPaste(system: SystemClipboardInfo | null, image: Blob | null, at: Point): boolean {
  const source = choosePasteSource(clipboard, system);
  if (source === 'internal') pasteInternal(at);
  else if (source === 'image' && image) void insertImages([image], at);
  else if (source === 'text' && system?.text) pasteText(system.text, at);
  else return false;
  return true;
}

function firstImage(files: Iterable<File>): File | null {
  for (const file of files) if (file.type.startsWith('image/')) return file;
  return null;
}

/** Handles a `paste` clipboard event on the canvas. Returns true when something was pasted. */
export function pasteFromClipboardEvent(event: ClipboardEvent): boolean {
  const ctx = context();
  const data = event.clipboardData;
  if (!ctx || !data) return false;
  const image = firstImage(data.files);
  const system: SystemClipboardInfo = {
    marker: data.getData(CLIPBOARD_MARKER_TYPE) || null,
    hasImage: image !== null,
    text: data.getData('text/plain') || null,
  };
  return applyPaste(system, image, ctx.engine.pasteAnchor());
}

/** Reads what the browser lets a page read from the system clipboard; null when it is not allowed. */
async function readSystemClipboard(): Promise<{ info: SystemClipboardInfo; image: Blob | null } | null> {
  if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') return null;
  try {
    const items = await navigator.clipboard.read();
    let image: Blob | null = null;
    let text: string | null = null;
    for (const item of items) {
      const imageType = item.types.find((type) => type.startsWith('image/'));
      if (imageType && !image) image = await item.getType(imageType);
      if (item.types.includes('text/plain') && text === null) text = await (await item.getType('text/plain')).text();
    }
    // The marker format is not exposed by this API; the text written by the same copy identifies it instead.
    return { info: { marker: null, hasImage: image !== null, text }, image };
  } catch {
    return null;
  }
}

/** Paste from the context menu, at the position the menu was opened. */
export async function pasteAt(at: Point): Promise<void> {
  const system = await readSystemClipboard();
  if (!applyPaste(system ? system.info : null, system ? system.image : null, at)) {
    useAppStore.getState().notify('There is nothing to paste.');
  }
}

// ---------------------------------------------------------------------- images

/** Inserts image files centred on a world position, as one undoable step, and selects them. */
export async function insertImages(files: readonly Blob[], at: Point): Promise<void> {
  const store = useAppStore.getState();
  const prepared: Array<{ blob: Blob; width: number; height: number }> = [];
  let failure: string | null = null;
  for (const file of files) {
    try {
      prepared.push(await prepareImage(file));
    } catch (error) {
      failure = error instanceof ImageImportError ? error.message : 'The image could not be inserted.';
    }
  }
  if (failure) store.notify(failure, 'error');
  // The page may have changed while the images were being decoded; insert on whatever is open now.
  const ctx = context();
  if (!ctx || prepared.length === 0) return;
  const view = ctx.engine.viewSize();
  const step = PASTE_STEP_PX / ctx.engine.getCamera().zoom;
  const firstOrder = ctx.engine.nextImageOrder();
  const images: ImageEntry[] = prepared.map((image, index) => {
    const size = fitImageSize(image.width, image.height, view.width, view.height);
    return {
      blob: image.blob,
      record: {
        id: newId(),
        pageId: ctx.pageId,
        x: round2(at.x - size.width / 2 + index * step),
        y: round2(at.y - size.height / 2 + index * step),
        width: round2(size.width),
        height: round2(size.height),
        naturalWidth: image.width,
        naturalHeight: image.height,
        locked: false,
        order: firstOrder + index,
      },
    };
  });
  insertAndSelect(ctx.engine, { strokes: [], images, textBoxes: [] });
}

/** Image files among dropped or picked files. */
export function imageFilesOf(files: Iterable<File>): File[] {
  return [...files].filter((file) => isSupportedImageType(file.type));
}

/** Registers the hidden file input that the "Insert image" commands open. */
export function registerImagePicker(picker: { open: () => void } | null): void {
  imagePicker = picker;
}

/** Opens the file picker; the chosen images are placed at `at`, or in the middle of the view. */
export function openImagePicker(at: Point | null = null): void {
  imagePickerTarget = at;
  imagePicker?.open();
}

/** Called by the file input when files were chosen. */
export function insertPickedImages(files: Iterable<File>): void {
  const ctx = context();
  if (!ctx) return;
  const picked = [...files];
  let at = imagePickerTarget;
  imagePickerTarget = null;
  if (!at) {
    const camera = ctx.engine.getCamera();
    const view = ctx.engine.viewSize();
    at = { x: camera.x + view.width / 2, y: camera.y + view.height / 2 };
  }
  void insertImages(picked, at);
}

export function setImageLocked(id: string, locked: boolean): void {
  getActiveEngine()?.setImageLocked(id, locked);
}

export function restackImage(id: string, where: 'front' | 'back'): void {
  getActiveEngine()?.restackImage(id, where);
}
