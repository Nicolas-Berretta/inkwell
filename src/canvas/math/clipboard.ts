/**
 * Rules for copying and pasting page objects (strokes, images, text boxes).
 *
 * Inkwell keeps what was copied inside the app in an internal clipboard,
 * because strokes and images cannot be represented faithfully on the system
 * clipboard. The system clipboard still decides what a paste means, so the
 * most recent copy always wins wherever it was made:
 *
 *   - copying in Inkwell also writes a marker (and the text of copied text
 *     boxes) to the system clipboard,
 *   - pasting uses the internal clipboard when the system clipboard still
 *     holds that marker (or exactly that text), an image when the system
 *     clipboard holds one, and plain text otherwise,
 *   - when the system clipboard cannot be read at all, the internal clipboard
 *     is used.
 *
 * Pure and DOM-free.
 */
import type { ImageEntry, ObjectSet, StrokeRecord, TextBoxRecord } from '../../types';
import type { Rect } from './geometry';
import { emptyRect, unionRect } from './geometry';
import { round2, strokeInkBounds, translatePoints } from './strokeGeometry';

/** Custom clipboard format that carries the token of the internal clipboard content. */
export const CLIPBOARD_MARKER_TYPE = 'application/x-inkwell-clipboard';

export type PasteSource = 'internal' | 'image' | 'text' | 'none';

export interface InternalClipboardInfo {
  /** Identifies one copy operation. */
  token: string;
  /** Plain text that was written to the system clipboard for this copy ('' when none). */
  text: string;
}

export interface SystemClipboardInfo {
  /** Value of the marker format, when present. */
  marker: string | null;
  hasImage: boolean;
  text: string | null;
}

/** Decides what a paste inserts. `system` is null when the system clipboard could not be read. */
export function choosePasteSource(internal: InternalClipboardInfo | null, system: SystemClipboardInfo | null): PasteSource {
  if (!system) return internal ? 'internal' : 'none';
  if (internal && system.marker === internal.token) return 'internal';
  if (system.hasImage) return 'image';
  const text = system.text ?? '';
  if (text.trim().length > 0) {
    // Some browsers drop the marker format; the text written by the same copy identifies it instead.
    if (internal && internal.text.length > 0 && text === internal.text) return 'internal';
    return 'text';
  }
  return internal ? 'internal' : 'none';
}

export function emptyObjectSet(): ObjectSet {
  return { strokes: [], images: [], textBoxes: [] };
}

export function isEmptyObjectSet(set: ObjectSet): boolean {
  return set.strokes.length === 0 && set.images.length === 0 && set.textBoxes.length === 0;
}

/** Height assumed for a text box whose rendered height is unknown. */
export const DEFAULT_TEXT_BOX_HEIGHT = 34;

/** World-space bounds of everything in the set. `textBoxHeight` reports rendered heights when known. */
export function objectSetBounds(set: ObjectSet, textBoxHeight: (box: TextBoxRecord) => number = () => DEFAULT_TEXT_BOX_HEIGHT): Rect {
  let bounds = emptyRect();
  for (const stroke of set.strokes) bounds = unionRect(bounds, strokeInkBounds(stroke.points, stroke.shape));
  for (const { record } of set.images) {
    bounds = unionRect(bounds, { minX: record.x, minY: record.y, maxX: record.x + record.width, maxY: record.y + record.height });
  }
  for (const box of set.textBoxes) {
    bounds = unionRect(bounds, { minX: box.x, minY: box.y, maxX: box.x + box.width, maxY: box.y + textBoxHeight(box) });
  }
  return bounds;
}

export interface CloneOptions {
  pageId: string;
  /** Translation applied to every object. */
  dx: number;
  dy: number;
  newId: () => string;
  /** Paint order given to the first copied stroke / image; the rest follow in their original order. */
  firstStrokeOrder: number;
  firstImageOrder: number;
  now: number;
}

/**
 * Copies a set of objects for pasting: new ids, the target page, translated,
 * and stacked above existing content while keeping their relative order.
 * Copies of locked images are unlocked so they can be placed.
 */
export function cloneObjectSet(set: ObjectSet, options: CloneOptions): ObjectSet {
  const { pageId, dx, dy, newId } = options;
  const strokes: StrokeRecord[] = [...set.strokes]
    .sort((a, b) => a.order - b.order)
    .map((stroke, index) => ({
      ...stroke,
      id: newId(),
      pageId,
      points: translatePoints(stroke.points, dx, dy),
      order: options.firstStrokeOrder + index,
    }));
  const images: ImageEntry[] = [...set.images]
    .sort((a, b) => a.record.order - b.record.order)
    .map(({ record, blob }, index) => ({
      blob,
      record: {
        ...record,
        id: newId(),
        pageId,
        x: round2(record.x + dx),
        y: round2(record.y + dy),
        locked: false,
        order: options.firstImageOrder + index,
      },
    }));
  const textBoxes: TextBoxRecord[] = set.textBoxes.map((box) => ({
    ...box,
    id: newId(),
    pageId,
    x: Math.round(box.x + dx),
    y: Math.round(box.y + dy),
    updatedAt: options.now,
  }));
  return { strokes, images, textBoxes };
}

export interface PasteMemory {
  token: string;
  x: number;
  y: number;
  count: number;
}

/**
 * Tracks repeated pastes of the same content at the same spot, so that each
 * further copy can be shifted and does not hide the previous one. Returns the
 * updated memory; `count` is how many times this paste has already happened
 * there (0 for the first).
 */
export function rememberPaste(previous: PasteMemory | null, token: string, x: number, y: number, tolerance: number): PasteMemory {
  const repeated =
    previous !== null &&
    previous.token === token &&
    Math.abs(previous.x - x) <= tolerance &&
    Math.abs(previous.y - y) <= tolerance;
  return { token, x, y, count: repeated ? previous.count + 1 : 0 };
}

/** Converts pasted plain text into a rich-text document (one paragraph per line) and its search text. */
export function textToDocument(text: string): { content: unknown; plainText: string } {
  const lines = text.replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '').split('\n');
  return {
    content: {
      type: 'doc',
      content: lines.map((line) => (line.length > 0 ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' })),
    },
    plainText: lines.join('\n').trim(),
  };
}
