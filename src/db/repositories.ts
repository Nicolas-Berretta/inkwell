/**
 * Read and structural-write access to the database. High-frequency row
 * updates go through the `WriteQueue`; the functions here cover loading and
 * cascading deletes, which must see a fully flushed database.
 */
import type { ImageEntry, Notebook, Page, Section, StrokeRecord, TextBoxRecord } from '../types';
import type { AppDatabase } from './database';

export interface Workspace {
  notebooks: Notebook[];
  sections: Section[];
  pages: Page[];
  settings: Map<string, unknown>;
}

const byOrder = <T extends { order: number }>(a: T, b: T) => a.order - b.order;

export async function loadWorkspace(db: AppDatabase): Promise<Workspace> {
  const [notebooks, sections, pages, settingRows] = await Promise.all([
    db.notebooks.toArray(),
    db.sections.toArray(),
    db.pages.toArray(),
    db.settings.toArray(),
  ]);
  return {
    notebooks: notebooks.sort(byOrder),
    sections: sections.sort(byOrder),
    pages: pages.sort(byOrder),
    settings: new Map(settingRows.map((row) => [row.key, row.value])),
  };
}

export function loadStrokes(db: AppDatabase, pageId: string): Promise<StrokeRecord[]> {
  return db.strokes.where('pageId').equals(pageId).toArray();
}

export function loadTextBoxes(db: AppDatabase, pageId: string): Promise<TextBoxRecord[]> {
  return db.textBoxes.where('pageId').equals(pageId).toArray();
}

/** Loads the images of a page together with their pixels. An image whose pixels are missing is skipped. */
export async function loadImages(db: AppDatabase, pageId: string): Promise<ImageEntry[]> {
  const records = await db.images.where('pageId').equals(pageId).toArray();
  const blobs = await db.imageBlobs.bulkGet(records.map((record) => record.id));
  const entries: ImageEntry[] = [];
  records.forEach((record, index) => {
    const blob = blobs[index];
    if (blob) entries.push({ record, blob: blob.data });
  });
  return entries;
}

/** Deletes pages together with all of their strokes, text boxes and images. */
export function deletePagesCascade(db: AppDatabase, pageIds: readonly string[]): Promise<void> {
  const ids = [...pageIds];
  return db.transaction('rw', [db.pages, db.strokes, db.textBoxes, db.images, db.imageBlobs], async () => {
    if (ids.length === 0) return;
    await db.strokes.where('pageId').anyOf(ids).delete();
    await db.textBoxes.where('pageId').anyOf(ids).delete();
    const imageIds = await db.images.where('pageId').anyOf(ids).primaryKeys();
    await db.imageBlobs.bulkDelete(imageIds);
    await db.images.bulkDelete(imageIds);
    await db.pages.bulkDelete(ids);
  });
}

/** Deletes sections and everything inside them. */
export function deleteSectionsCascade(db: AppDatabase, sectionIds: readonly string[]): Promise<void> {
  const ids = [...sectionIds];
  return db.transaction('rw', [db.sections, db.pages, db.strokes, db.textBoxes, db.images, db.imageBlobs], async () => {
    if (ids.length === 0) return;
    const pageIds = await db.pages.where('sectionId').anyOf(ids).primaryKeys();
    await deletePagesCascade(db, pageIds);
    await db.sections.bulkDelete(ids);
  });
}

/** Deletes a notebook and everything inside it. */
export function deleteNotebookCascade(db: AppDatabase, notebookId: string): Promise<void> {
  return db.transaction(
    'rw',
    [db.notebooks, db.sections, db.pages, db.strokes, db.textBoxes, db.images, db.imageBlobs],
    async () => {
      const sectionIds = await db.sections.where('notebookId').equals(notebookId).primaryKeys();
      await deleteSectionsCascade(db, sectionIds);
      await db.notebooks.delete(notebookId);
    },
  );
}

/** Plain-text projection of every text box, used to build the search index. */
export async function loadTextProjection(db: AppDatabase): Promise<Array<{ pageId: string; text: string }>> {
  const rows: Array<{ pageId: string; text: string }> = [];
  await db.textBoxes.each((box) => {
    if (box.plainText) rows.push({ pageId: box.pageId, text: box.plainText });
  });
  return rows;
}
