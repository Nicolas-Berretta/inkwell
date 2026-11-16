/**
 * Whole-database backup as versioned JSON.
 *
 * Import semantics: REPLACE. A valid backup atomically replaces everything in
 * the database (one transaction: either the whole backup is applied or
 * nothing changes). The file is fully validated before the database is
 * touched, so a malformed or truncated file can never corrupt existing data.
 *
 * Format versions:
 *   1  notebooks, sections, pages, strokes, text boxes, settings
 *   2  adds `images`: each image record with its pixels as base64 (`data`) and
 *      its media type (`mime`)
 * Files of every earlier version are still accepted; a version 1 file simply
 * has no images.
 */
import { MAX_ZOOM, MIN_ZOOM } from '../canvas/math/camera';
import type {
  ImageRecord,
  Notebook,
  Page,
  Section,
  SettingRecord,
  StrokeRecord,
  StrokeShape,
  TextBoxRecord,
} from '../types';
import { IMAGE_MIME_TYPES, MAX_PAGE_DEPTH, PAGE_BACKGROUNDS, STROKE_SHAPES } from '../types';
import { base64ToBytes, bytesToBase64 } from './base64';
import type { AppDatabase } from './database';

export const BACKUP_FORMAT = 'inkwell-backup';
export const BACKUP_VERSION = 2;
/** First format version that carries images. */
const IMAGES_SINCE_VERSION = 2;

/** An image as written to a backup file: its record plus the pixels as base64. */
export interface BackupImage extends ImageRecord {
  /** Media type of the pixels, e.g. `image/png`. */
  mime: string;
  /** Base64-encoded image file. */
  data: string;
}

export interface BackupData {
  notebooks: Notebook[];
  sections: Section[];
  pages: Page[];
  strokes: StrokeRecord[];
  textBoxes: TextBoxRecord[];
  images: BackupImage[];
  settings: SettingRecord[];
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  data: BackupData;
}

/** Raised for any backup that cannot be imported; `message` is safe to show to the user. */
export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

export async function exportBackup(db: AppDatabase): Promise<BackupFile> {
  const snapshot = await db.transaction(
    'r',
    [db.notebooks, db.sections, db.pages, db.strokes, db.textBoxes, db.images, db.imageBlobs, db.settings],
    async () => ({
      notebooks: await db.notebooks.toArray(),
      sections: await db.sections.toArray(),
      pages: await db.pages.toArray(),
      strokes: await db.strokes.toArray(),
      textBoxes: await db.textBoxes.toArray(),
      images: await db.images.toArray(),
      imageBlobs: await db.imageBlobs.toArray(),
      settings: await db.settings.toArray(),
    }),
  );
  // Blobs are read outside the transaction: reading them is asynchronous and would let it auto-commit.
  const blobs = new Map(snapshot.imageBlobs.map((row) => [row.id, row.data]));
  const images: BackupImage[] = [];
  for (const record of snapshot.images) {
    const blob = blobs.get(record.id);
    // An image without pixels cannot be restored, so it is not exported.
    if (!blob) continue;
    images.push({ ...record, mime: blob.type, data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())) });
  }
  const data: BackupData = {
    notebooks: snapshot.notebooks,
    sections: snapshot.sections,
    pages: snapshot.pages,
    strokes: snapshot.strokes,
    textBoxes: snapshot.textBoxes,
    images,
    settings: snapshot.settings,
  };
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), data };
}

/** Parses backup JSON text. Throws `BackupError` with a readable reason on any problem. */
export function parseBackupText(text: string): BackupFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BackupError('The file is not valid JSON.');
  }
  return parseBackup(raw);
}

/** Validates an already-parsed backup object and returns a clean, typed copy. */
export function parseBackup(raw: unknown): BackupFile {
  const root = asObject(raw, 'The backup');
  if (root.format !== BACKUP_FORMAT) {
    throw new BackupError('This file is not an Inkwell backup.');
  }
  if (typeof root.version !== 'number' || !Number.isInteger(root.version) || root.version < 1) {
    throw new BackupError('The backup has no valid version number.');
  }
  if (root.version > BACKUP_VERSION) {
    throw new BackupError(
      `The backup was created by a newer version of the app (format ${root.version}; this app reads up to ${BACKUP_VERSION}).`,
    );
  }
  const data = asObject(root.data, 'The backup data section');

  const notebooks = asArray(data.notebooks, 'notebooks').map(parseNotebook);
  const sections = asArray(data.sections, 'sections').map(parseSection);
  const pages = asArray(data.pages, 'pages').map(parsePage);
  const strokes = asArray(data.strokes, 'strokes').map(parseStroke);
  const textBoxes = asArray(data.textBoxes, 'textBoxes').map(parseTextBox);
  // Backups written before images existed have no such list.
  const images = root.version >= IMAGES_SINCE_VERSION ? asArray(data.images, 'images').map(parseImage) : [];
  const settings = asArray(data.settings, 'settings').map(parseSetting);

  assertUniqueIds(notebooks, 'notebooks');
  assertUniqueIds(sections, 'sections');
  assertUniqueIds(pages, 'pages');
  assertUniqueIds(strokes, 'strokes');
  assertUniqueIds(textBoxes, 'textBoxes');
  assertUniqueIds(images, 'images');

  const notebookIds = new Set(notebooks.map((n) => n.id));
  const sectionIds = new Set(sections.map((s) => s.id));
  const pageIds = new Set(pages.map((p) => p.id));
  for (const section of sections) {
    if (!notebookIds.has(section.notebookId)) {
      throw new BackupError(`Section "${section.name}" refers to a notebook that is not in the backup.`);
    }
  }
  for (const page of pages) {
    if (!sectionIds.has(page.sectionId)) {
      throw new BackupError(`Page "${page.title}" refers to a section that is not in the backup.`);
    }
  }
  for (const stroke of strokes) {
    if (!pageIds.has(stroke.pageId)) throw new BackupError('A stroke refers to a page that is not in the backup.');
  }
  for (const box of textBoxes) {
    if (!pageIds.has(box.pageId)) throw new BackupError('A text box refers to a page that is not in the backup.');
  }
  for (const image of images) {
    if (!pageIds.has(image.pageId)) throw new BackupError('An image refers to a page that is not in the backup.');
  }

  return {
    format: BACKUP_FORMAT,
    version: root.version,
    exportedAt: typeof root.exportedAt === 'string' ? root.exportedAt : new Date(0).toISOString(),
    data: { notebooks, sections, pages, strokes, textBoxes, images, settings },
  };
}

/** Replaces the entire database content with the backup, atomically. */
export function importBackup(db: AppDatabase, backup: BackupFile): Promise<void> {
  const { data } = backup;
  // Decode every image before the transaction starts, so a bad image cannot leave a half-written database.
  const imageRecords: ImageRecord[] = [];
  const imageBlobs: Array<{ id: string; data: Blob }> = [];
  for (const image of data.images) {
    const bytes = base64ToBytes(image.data);
    if (!bytes) return Promise.reject(new BackupError('An image in the backup has damaged data.'));
    const { mime, data: _encoded, ...record } = image;
    imageRecords.push(record);
    imageBlobs.push({ id: image.id, data: new Blob([bytes], { type: mime }) });
  }
  return db.transaction(
    'rw',
    [db.notebooks, db.sections, db.pages, db.strokes, db.textBoxes, db.images, db.imageBlobs, db.settings],
    async () => {
      await Promise.all([
        db.notebooks.clear(),
        db.sections.clear(),
        db.pages.clear(),
        db.strokes.clear(),
        db.textBoxes.clear(),
        db.images.clear(),
        db.imageBlobs.clear(),
        db.settings.clear(),
      ]);
      await db.notebooks.bulkAdd(data.notebooks);
      await db.sections.bulkAdd(data.sections);
      await db.pages.bulkAdd(data.pages);
      await db.strokes.bulkAdd(data.strokes);
      await db.textBoxes.bulkAdd(data.textBoxes);
      await db.images.bulkAdd(imageRecords);
      await db.imageBlobs.bulkAdd(imageBlobs);
      await db.settings.bulkAdd(data.settings);
    },
  );
}

export function backupFileName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `inkwell-backup-${stamp}.json`;
}

// ------------------------------------------------------------------ validation

type Dict = Record<string, unknown>;

function asObject(value: unknown, label: string): Dict {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BackupError(`${label} is missing or is not an object.`);
  }
  return value as Dict;
}

function asArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new BackupError(`The backup is missing the "${name}" list.`);
  return value;
}

function str(obj: Dict, key: string, where: string): string {
  const value = obj[key];
  if (typeof value !== 'string') throw new BackupError(`${where}: "${key}" must be text.`);
  return value;
}

function id(obj: Dict, key: string, where: string): string {
  const value = str(obj, key, where);
  if (value.length === 0) throw new BackupError(`${where}: "${key}" must not be empty.`);
  return value;
}

function num(obj: Dict, key: string, where: string): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BackupError(`${where}: "${key}" must be a finite number.`);
  }
  return value;
}

function assertUniqueIds(rows: ReadonlyArray<{ id: string }>, name: string): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) throw new BackupError(`The "${name}" list contains a duplicate id.`);
    seen.add(row.id);
  }
}

function parseNotebook(raw: unknown, index: number): Notebook {
  const where = `Notebook #${index + 1}`;
  const o = asObject(raw, where);
  return {
    id: id(o, 'id', where),
    name: str(o, 'name', where),
    order: num(o, 'order', where),
    createdAt: num(o, 'createdAt', where),
    updatedAt: num(o, 'updatedAt', where),
  };
}

function parseSection(raw: unknown, index: number): Section {
  const where = `Section #${index + 1}`;
  const o = asObject(raw, where);
  return {
    id: id(o, 'id', where),
    notebookId: id(o, 'notebookId', where),
    name: str(o, 'name', where),
    color: str(o, 'color', where),
    order: num(o, 'order', where),
    createdAt: num(o, 'createdAt', where),
    updatedAt: num(o, 'updatedAt', where),
  };
}

function parsePage(raw: unknown, index: number): Page {
  const where = `Page #${index + 1}`;
  const o = asObject(raw, where);
  const background = str(o, 'background', where);
  if (!(PAGE_BACKGROUNDS as readonly string[]).includes(background)) {
    throw new BackupError(`${where}: unknown background "${background}".`);
  }
  const depth = num(o, 'depth', where);
  if (!Number.isInteger(depth) || depth < 0 || depth > MAX_PAGE_DEPTH) {
    throw new BackupError(`${where}: "depth" must be a whole number between 0 and ${MAX_PAGE_DEPTH}.`);
  }
  const camera = asObject(o.camera, `${where} camera`);
  const zoom = num(camera, 'zoom', `${where} camera`);
  if (zoom <= 0) throw new BackupError(`${where} camera: "zoom" must be positive.`);
  return {
    id: id(o, 'id', where),
    sectionId: id(o, 'sectionId', where),
    title: str(o, 'title', where),
    order: num(o, 'order', where),
    depth,
    background: background as Page['background'],
    camera: {
      x: num(camera, 'x', `${where} camera`),
      y: num(camera, 'y', `${where} camera`),
      zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)),
    },
    createdAt: num(o, 'createdAt', where),
    updatedAt: num(o, 'updatedAt', where),
  };
}

function parseStroke(raw: unknown, index: number): StrokeRecord {
  const where = `Stroke #${index + 1}`;
  const o = asObject(raw, where);
  const tool = str(o, 'tool', where);
  if (tool !== 'pen' && tool !== 'highlighter') throw new BackupError(`${where}: unknown tool "${tool}".`);
  const size = num(o, 'size', where);
  if (size <= 0) throw new BackupError(`${where}: "size" must be positive.`);
  const points = o.points;
  if (!Array.isArray(points) || points.length === 0 || points.length % 3 !== 0) {
    throw new BackupError(`${where}: "points" must be a non-empty list of x, y, width triples.`);
  }
  for (let i = 0; i < points.length; i++) {
    const value: unknown = points[i];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new BackupError(`${where}: "points" contains a value that is not a finite number.`);
    }
    if (i % 3 === 2 && value < 0) throw new BackupError(`${where}: "points" contains a negative width.`);
  }
  const stroke: StrokeRecord = {
    id: id(o, 'id', where),
    pageId: id(o, 'pageId', where),
    tool,
    color: str(o, 'color', where),
    size,
    points: points as number[],
    order: num(o, 'order', where),
  };
  // Optional: only strokes that were snapped to a shape carry it, so older backups stay valid.
  if (o.shape !== undefined) {
    if (typeof o.shape !== 'string' || !(STROKE_SHAPES as readonly string[]).includes(o.shape)) {
      throw new BackupError(`${where}: unknown shape "${String(o.shape)}".`);
    }
    stroke.shape = o.shape as StrokeShape;
  }
  return stroke;
}

function parseTextBox(raw: unknown, index: number): TextBoxRecord {
  const where = `Text box #${index + 1}`;
  const o = asObject(raw, where);
  const width = num(o, 'width', where);
  if (width <= 0) throw new BackupError(`${where}: "width" must be positive.`);
  if (typeof o.content !== 'object' || o.content === null) {
    throw new BackupError(`${where}: "content" must be a document object.`);
  }
  return {
    id: id(o, 'id', where),
    pageId: id(o, 'pageId', where),
    x: num(o, 'x', where),
    y: num(o, 'y', where),
    width,
    content: o.content,
    plainText: str(o, 'plainText', where),
    updatedAt: num(o, 'updatedAt', where),
  };
}

function parseImage(raw: unknown, index: number): BackupImage {
  const where = `Image #${index + 1}`;
  const o = asObject(raw, where);
  const positive = (key: string): number => {
    const value = num(o, key, where);
    if (value <= 0) throw new BackupError(`${where}: "${key}" must be positive.`);
    return value;
  };
  if (typeof o.locked !== 'boolean') throw new BackupError(`${where}: "locked" must be true or false.`);
  const mime = str(o, 'mime', where);
  if (!IMAGE_MIME_TYPES.includes(mime)) throw new BackupError(`${where}: unsupported image type "${mime}".`);
  const data = str(o, 'data', where);
  if (data.length === 0 || base64ToBytes(data) === null) {
    throw new BackupError(`${where}: "data" must be the image file encoded as base64.`);
  }
  return {
    id: id(o, 'id', where),
    pageId: id(o, 'pageId', where),
    x: num(o, 'x', where),
    y: num(o, 'y', where),
    width: positive('width'),
    height: positive('height'),
    naturalWidth: positive('naturalWidth'),
    naturalHeight: positive('naturalHeight'),
    locked: o.locked,
    order: num(o, 'order', where),
    mime,
    data,
  };
}

function parseSetting(raw: unknown, index: number): SettingRecord {
  const where = `Setting #${index + 1}`;
  const o = asObject(raw, where);
  return { key: id(o, 'key', where), value: o.value };
}
