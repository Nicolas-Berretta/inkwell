/** Domain model shared by the database, the store, the canvas engine and the UI. */

export type ThemeMode = 'light' | 'dark';
export type ThemePreference = 'system' | ThemeMode;

export type PageBackground = 'blank' | 'ruled' | 'college' | 'dots' | 'grid';

export const PAGE_BACKGROUNDS: readonly PageBackground[] = ['blank', 'ruled', 'college', 'dots', 'grid'];

export interface CameraState {
  /** World coordinate shown at the left edge of the viewport. */
  x: number;
  /** World coordinate shown at the top edge of the viewport. */
  y: number;
  /** Screen pixels per world unit. */
  zoom: number;
}

export interface Notebook {
  id: string;
  name: string;
  order: number;
  createdAt: number;
  updatedAt: number;
}

export interface Section {
  id: string;
  notebookId: string;
  name: string;
  color: string;
  order: number;
  createdAt: number;
  updatedAt: number;
}

/** Deepest sub-page indentation level (0 = top-level page). */
export const MAX_PAGE_DEPTH = 2;

export interface Page {
  id: string;
  sectionId: string;
  title: string;
  order: number;
  /** Indentation level inside the section's flat, ordered page list. */
  depth: number;
  background: PageBackground;
  camera: CameraState;
  createdAt: number;
  updatedAt: number;
}

export type StrokeTool = 'pen' | 'highlighter';

/** Clean geometric shapes a hand-drawn stroke can be snapped to. */
export type StrokeShape = 'line' | 'rectangle' | 'ellipse' | 'triangle';

export const STROKE_SHAPES: readonly StrokeShape[] = ['line', 'rectangle', 'ellipse', 'triangle'];

export interface StrokeRecord {
  id: string;
  pageId: string;
  tool: StrokeTool;
  /** Colour as authored (light-theme colour). Theme mapping happens at render time. */
  color: string;
  /** Nominal width in world units. */
  size: number;
  /** Flat `[x, y, width, x, y, width, ...]` triples in world coordinates. */
  points: number[];
  /** Paint order within the page; higher values are drawn later (on top). */
  order: number;
  /**
   * Set when the stroke was snapped to a geometric shape; absent for freehand
   * ink. `points` then hold the shape's vertices at one uniform width: the two
   * end points of a line, or the outline of a closed shape with its first
   * point repeated at the end. Rectangles and triangles are joined by straight
   * segments with crisp corners instead of being smoothed.
   */
  shape?: StrokeShape;
}

/** Raster formats that can be placed on a page. */
export const IMAGE_MIME_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/avif',
];

/**
 * An image placed on a page. This is the small, frequently rewritten record
 * (moving or resizing an image rewrites only this); the pixels live in a
 * separate `ImageBlobRecord` with the same id.
 */
export interface ImageRecord {
  id: string;
  pageId: string;
  /** Top-left corner and size in world coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Pixel size of the stored image. */
  naturalWidth: number;
  naturalHeight: number;
  /** A locked image cannot be selected, moved, resized or deleted until it is unlocked. */
  locked: boolean;
  /** Stacking order among the images of the page; higher values are in front. */
  order: number;
}

/** Binary data of an image, stored once and never rewritten. */
export interface ImageBlobRecord {
  /** Same id as the `ImageRecord` it belongs to. */
  id: string;
  data: Blob;
}

/** An image together with its pixels, as handled in memory (canvas, clipboard, undo history). */
export interface ImageEntry {
  record: ImageRecord;
  blob: Blob;
}

/** A group of page objects that is copied, pasted, removed or restored together. */
export interface ObjectSet {
  strokes: StrokeRecord[];
  images: ImageEntry[];
  textBoxes: TextBoxRecord[];
}

export interface TextBoxRecord {
  id: string;
  pageId: string;
  x: number;
  y: number;
  width: number;
  /** Tiptap/ProseMirror document JSON. */
  content: unknown;
  /** Plain-text projection of `content`, used by search. */
  plainText: string;
  updatedAt: number;
}

export interface SettingRecord {
  key: string;
  value: unknown;
}

export type ToolId = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'text' | 'pan';

export interface ToolSettings {
  tool: ToolId;
  penColor: string;
  penSize: number;
  highlighterColor: string;
  highlighterSize: number;
}
