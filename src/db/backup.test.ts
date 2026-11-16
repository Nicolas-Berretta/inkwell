import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64 } from './base64';
import type { BackupFile } from './backup';
import { BACKUP_FORMAT, BACKUP_VERSION, BackupError, exportBackup, importBackup, parseBackup, parseBackupText } from './backup';
import { AppDatabase } from './database';
import { deleteNotebookCascade, deletePagesCascade, loadImages } from './repositories';
import { seedIfEmpty } from './seed';
import { WriteQueue } from './writeQueue';

/** A few arbitrary bytes standing in for an image file, including values above 127. */
const IMAGE_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 254, 1, 2, 3]);
const IMAGE_BASE64 = bytesToBase64(IMAGE_BYTES);

function sampleBackup(): BackupFile {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: '2026-01-01T00:00:00.000Z',
    data: {
      notebooks: [{ id: 'n1', name: 'Work', order: 1, createdAt: 1, updatedAt: 2 }],
      sections: [{ id: 's1', notebookId: 'n1', name: 'Inbox', color: '#7c5cd6', order: 1, createdAt: 1, updatedAt: 2 }],
      pages: [
        {
          id: 'p1',
          sectionId: 's1',
          title: 'Plan',
          order: 1,
          depth: 0,
          background: 'dots',
          camera: { x: 10, y: -20, zoom: 1.5 },
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      strokes: [{ id: 'k1', pageId: 'p1', tool: 'pen', color: '#000000', size: 2.5, points: [0, 0, 2, 10, 5, 2.4], order: 1 }],
      textBoxes: [
        {
          id: 't1',
          pageId: 'p1',
          x: 40,
          y: 60,
          width: 320,
          content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }] },
          plainText: 'Hello',
          updatedAt: 3,
        },
      ],
      images: [
        {
          id: 'i1',
          pageId: 'p1',
          x: 100,
          y: 200,
          width: 320,
          height: 240,
          naturalWidth: 640,
          naturalHeight: 480,
          locked: true,
          order: 1,
          mime: 'image/png',
          data: IMAGE_BASE64,
        },
      ],
      settings: [{ key: 'theme', value: 'dark' }],
    },
  };
}

/** The same content as written by the previous format version, which had no images. */
function version1Backup(): unknown {
  const backup = structuredClone(sampleBackup()) as any;
  backup.version = 1;
  delete backup.data.images;
  return backup;
}

/** Returns a deep copy of the sample with one mutation applied. */
function broken(mutate: (backup: any) => void): unknown {
  const copy = structuredClone(sampleBackup());
  mutate(copy);
  return copy;
}

describe('backup validation', () => {
  it('accepts a well-formed backup and returns an equivalent copy', () => {
    expect(parseBackup(sampleBackup())).toEqual(sampleBackup());
  });

  it('parses JSON text', () => {
    expect(parseBackupText(JSON.stringify(sampleBackup())).data.pages[0].title).toBe('Plan');
  });

  it('rejects text that is not JSON', () => {
    expect(() => parseBackupText('{not json')).toThrow(BackupError);
    expect(() => parseBackupText('{not json')).toThrow(/not valid JSON/);
  });

  it('rejects files that are not Inkwell backups', () => {
    expect(() => parseBackup({ hello: 'world' })).toThrow(/not an Inkwell backup/);
    expect(() => parseBackup(null)).toThrow(BackupError);
    expect(() => parseBackup([])).toThrow(BackupError);
  });

  it('rejects backups from a newer format version', () => {
    expect(() => parseBackup(broken((b) => (b.version = BACKUP_VERSION + 1)))).toThrow(/newer version/);
    expect(() => parseBackup(broken((b) => (b.version = 'one')))).toThrow(/version/);
  });

  it('accepts every page background, including the square grid', () => {
    for (const background of ['blank', 'ruled', 'college', 'dots', 'grid']) {
      const parsed = parseBackup(broken((b) => (b.data.pages[0].background = background)));
      expect(parsed.data.pages[0].background).toBe(background);
    }
  });

  it('keeps the optional shape of snapped strokes and accepts strokes without one', () => {
    // Backups written before shapes existed have no "shape" key at all.
    expect('shape' in parseBackup(sampleBackup()).data.strokes[0]).toBe(false);

    for (const shape of ['line', 'rectangle', 'ellipse', 'triangle']) {
      const parsed = parseBackup(broken((b) => (b.data.strokes[0].shape = shape)));
      expect(parsed.data.strokes[0].shape).toBe(shape);
    }
    const rectangle = { id: 'k2', pageId: 'p1', tool: 'pen', color: '#000000', size: 2.5, order: 2, shape: 'rectangle' };
    const points = [0, 0, 2.5, 40, 0, 2.5, 40, 30, 2.5, 0, 30, 2.5, 0, 0, 2.5];
    const parsed = parseBackup(broken((b) => b.data.strokes.push({ ...rectangle, points })));
    expect(parsed.data.strokes[1]).toEqual({ ...rectangle, points });
  });

  it('rejects an unknown or malformed stroke shape', () => {
    expect(() => parseBackup(broken((b) => (b.data.strokes[0].shape = 'hexagon')))).toThrow(/Stroke #1.*shape/);
    expect(() => parseBackup(broken((b) => (b.data.strokes[0].shape = 3)))).toThrow(/Stroke #1.*shape/);
    expect(() => parseBackup(broken((b) => (b.data.strokes[0].shape = null)))).toThrow(/Stroke #1.*shape/);
  });

  it('still accepts backups of the previous format version, which have no images', () => {
    const parsed = parseBackup(version1Backup());
    expect(parsed.version).toBe(1);
    expect(parsed.data.images).toEqual([]);
    expect(parsed.data.strokes).toEqual(sampleBackup().data.strokes);
    expect(parsed.data.textBoxes).toEqual(sampleBackup().data.textBoxes);
    // An "images" list in a version 1 file is not part of that format and is ignored.
    const stray = version1Backup() as any;
    stray.data.images = 'not a list';
    expect(parseBackup(stray).data.images).toEqual([]);
  });

  it('requires the image list from format version 2 on', () => {
    expect(() => parseBackup(broken((b) => delete b.data.images))).toThrow(/"images"/);
    expect(parseBackup(broken((b) => (b.data.images = []))).data.images).toEqual([]);
  });

  it('rejects malformed images with a message naming the image and the field', () => {
    const image = (mutate: (image: any) => void) => () => parseBackup(broken((b) => mutate(b.data.images[0])));
    expect(image((i) => (i.width = 0))).toThrow(/Image #1.*"width" must be positive/);
    expect(image((i) => (i.naturalHeight = -4))).toThrow(/Image #1.*"naturalHeight"/);
    expect(image((i) => (i.x = 'left'))).toThrow(/Image #1.*"x"/);
    expect(image((i) => (i.locked = 'yes'))).toThrow(/Image #1.*"locked"/);
    expect(image((i) => (i.mime = 'image/svg+xml'))).toThrow(/Image #1.*unsupported image type "image\/svg\+xml"/);
    expect(image((i) => (i.mime = 'text/html'))).toThrow(/Image #1.*unsupported image type/);
    expect(image((i) => (i.data = 'not base64!'))).toThrow(/Image #1.*base64/);
    expect(image((i) => (i.data = ''))).toThrow(/Image #1.*base64/);
    expect(image((i) => delete i.data)).toThrow(/Image #1.*"data"/);
    expect(image((i) => (i.id = ''))).toThrow(/Image #1/);
    expect(() => parseBackup(broken((b) => (b.data.images[0].pageId = 'ghost')))).toThrow(/image refers to a page/i);
    expect(() => parseBackup(broken((b) => b.data.images.push({ ...b.data.images[0] })))).toThrow(/"images".*duplicate/);
  });

  it('rejects missing tables', () => {
    expect(() => parseBackup(broken((b) => delete b.data.strokes))).toThrow(/"strokes"/);
    expect(() => parseBackup(broken((b) => (b.data = 5)))).toThrow(BackupError);
  });

  it('rejects malformed records with a message naming the record', () => {
    expect(() => parseBackup(broken((b) => (b.data.pages[0].title = 7)))).toThrow(/Page #1.*title/);
    expect(() => parseBackup(broken((b) => (b.data.pages[0].background = 'plaid')))).toThrow(/background/);
    expect(() => parseBackup(broken((b) => (b.data.pages[0].camera.zoom = 0)))).toThrow(/zoom/);
    expect(() => parseBackup(broken((b) => (b.data.notebooks[0].id = '')))).toThrow(/Notebook #1/);
    expect(() => parseBackup(broken((b) => (b.data.textBoxes[0].content = 'text')))).toThrow(/Text box #1/);
  });

  it('rejects corrupt stroke geometry', () => {
    expect(() => parseBackup(broken((b) => (b.data.strokes[0].points = [1, 2])))).toThrow(/triples/);
    expect(() => parseBackup(broken((b) => (b.data.strokes[0].points = [1, 2, null])))).toThrow(/finite number/);
    expect(() => parseBackup(broken((b) => (b.data.strokes[0].points = [1, 2, -3])))).toThrow(/negative width/);
    expect(() => parseBackup(broken((b) => (b.data.strokes[0].tool = 'crayon')))).toThrow(/tool/);
  });

  it('rejects dangling references and duplicate ids', () => {
    expect(() => parseBackup(broken((b) => (b.data.sections[0].notebookId = 'missing')))).toThrow(/notebook that is not in the backup/);
    expect(() => parseBackup(broken((b) => (b.data.pages[0].sectionId = 'missing')))).toThrow(/section that is not in the backup/);
    expect(() => parseBackup(broken((b) => (b.data.strokes[0].pageId = 'missing')))).toThrow(/page that is not in the backup/);
    expect(() => parseBackup(broken((b) => b.data.pages.push(b.data.pages[0])))).toThrow(/duplicate id/);
  });

  it('clamps out-of-range zoom instead of failing', () => {
    const parsed = parseBackup(broken((b) => (b.data.pages[0].camera.zoom = 400)));
    expect(parsed.data.pages[0].camera.zoom).toBe(8);
  });

  it('strips unknown fields from records', () => {
    const parsed = parseBackup(broken((b) => (b.data.notebooks[0].evil = '<script>')));
    expect(parsed.data.notebooks[0]).not.toHaveProperty('evil');
  });
});

describe('backup round trip against IndexedDB', () => {
  let db: AppDatabase;
  let counter = 0;

  beforeEach(() => {
    db = new AppDatabase(`backup-test-${++counter}`);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('seeds an empty database exactly once', async () => {
    expect(await seedIfEmpty(db)).toBe(true);
    expect(await seedIfEmpty(db)).toBe(false);
    expect(await db.notebooks.count()).toBe(1);
    expect(await db.sections.count()).toBe(1);
    expect(await db.pages.count()).toBe(1);
  });

  it('exports what was imported', async () => {
    await importBackup(db, sampleBackup());
    const exported = await exportBackup(db);
    expect(exported.format).toBe(BACKUP_FORMAT);
    expect(exported.version).toBe(BACKUP_VERSION);
    expect(exported.data).toEqual(sampleBackup().data);
    // The exported file must itself be importable.
    expect(parseBackupText(JSON.stringify(exported)).data).toEqual(sampleBackup().data);
  });

  it('replaces existing content instead of merging', async () => {
    await seedIfEmpty(db);
    await importBackup(db, sampleBackup());
    expect((await db.notebooks.toArray()).map((n) => n.id)).toEqual(['n1']);
    expect((await db.pages.toArray()).map((p) => p.id)).toEqual(['p1']);
  });

  it('leaves the database untouched when an import fails part-way', async () => {
    await seedIfEmpty(db);
    const before = await exportBackup(db);
    const bad = sampleBackup();
    // Bypasses validation on purpose: a duplicate primary key makes the write itself fail.
    bad.data.strokes.push({ ...bad.data.strokes[0] });
    await expect(importBackup(db, bad)).rejects.toBeDefined();
    expect((await exportBackup(db)).data).toEqual(before.data);
  });

  it('cascades notebook deletion to sections, pages, strokes and text boxes', async () => {
    await importBackup(db, sampleBackup());
    await deleteNotebookCascade(db, 'n1');
    const { data } = await exportBackup(db);
    expect(data.notebooks).toEqual([]);
    expect(data.sections).toEqual([]);
    expect(data.pages).toEqual([]);
    expect(data.strokes).toEqual([]);
    expect(data.textBoxes).toEqual([]);
    expect(data.images).toEqual([]);
    expect(await db.imageBlobs.count()).toBe(0);
    expect(data.settings).toHaveLength(1);
  });

  it('stores image pixels as binary data, separate from the image record', async () => {
    await importBackup(db, sampleBackup());
    const record = await db.images.get('i1');
    // The record that is rewritten when an image moves carries no pixel data.
    expect(record).toEqual({
      id: 'i1',
      pageId: 'p1',
      x: 100,
      y: 200,
      width: 320,
      height: 240,
      naturalWidth: 640,
      naturalHeight: 480,
      locked: true,
      order: 1,
    });
    const [entry] = await loadImages(db, 'p1');
    expect(entry.record).toEqual(record);
    expect(entry.blob.type).toBe('image/png');
    expect(new Uint8Array(await entry.blob.arrayBuffer())).toEqual(IMAGE_BYTES);
  });

  it('round-trips images byte for byte through export and import', async () => {
    await importBackup(db, sampleBackup());
    const exported = await exportBackup(db);
    const text = JSON.stringify(exported);
    await db.images.clear();
    await db.imageBlobs.clear();
    await importBackup(db, parseBackupText(text));
    const [entry] = await loadImages(db, 'p1');
    expect(entry.record.locked).toBe(true);
    expect(new Uint8Array(await entry.blob.arrayBuffer())).toEqual(IMAGE_BYTES);
  });

  it('imports a backup of the previous format version and clears images that were there', async () => {
    await importBackup(db, sampleBackup());
    await importBackup(db, parseBackup(version1Backup()));
    expect(await db.images.count()).toBe(0);
    expect(await db.imageBlobs.count()).toBe(0);
    expect((await db.strokes.toArray()).map((stroke) => stroke.id)).toEqual(['k1']);
    expect((await db.textBoxes.toArray()).map((box) => box.id)).toEqual(['t1']);
  });

  it('deletes the images of a deleted page and leaves other pages alone', async () => {
    const backup = sampleBackup();
    backup.data.pages.push({ ...backup.data.pages[0], id: 'p2', title: 'Other' });
    backup.data.images.push({ ...backup.data.images[0], id: 'i2', pageId: 'p2' });
    await importBackup(db, backup);
    await deletePagesCascade(db, ['p1']);
    expect((await db.images.toArray()).map((image) => image.id)).toEqual(['i2']);
    expect((await db.imageBlobs.toArray()).map((blob) => blob.id)).toEqual(['i2']);
  });

  it('skips an image whose pixels are missing instead of failing the page', async () => {
    await importBackup(db, sampleBackup());
    await db.imageBlobs.delete('i1');
    expect(await loadImages(db, 'p1')).toEqual([]);
    expect((await exportBackup(db)).data.images).toEqual([]);
  });

  it('upgrades a version 1 database in place without touching its data', async () => {
    const name = `upgrade-test-${++counter}`;
    // The schema exactly as the first release created it.
    const old = new Dexie(name);
    old.version(1).stores({
      notebooks: 'id',
      sections: 'id, notebookId',
      pages: 'id, sectionId',
      strokes: 'id, pageId',
      textBoxes: 'id, pageId',
      settings: 'key',
    });
    const { data } = sampleBackup();
    await old.table('notebooks').bulkAdd(data.notebooks);
    await old.table('sections').bulkAdd(data.sections);
    await old.table('pages').bulkAdd(data.pages);
    await old.table('strokes').bulkAdd(data.strokes);
    await old.table('textBoxes').bulkAdd(data.textBoxes);
    await old.table('settings').bulkAdd(data.settings);
    old.close();

    const upgraded = new AppDatabase(name);
    try {
      expect(await upgraded.notebooks.toArray()).toEqual(data.notebooks);
      expect(await upgraded.pages.toArray()).toEqual(data.pages);
      expect(await upgraded.strokes.toArray()).toEqual(data.strokes);
      expect(await upgraded.textBoxes.toArray()).toEqual(data.textBoxes);
      expect(await upgraded.settings.toArray()).toEqual(data.settings);
      // The new tables exist and are usable.
      expect(await upgraded.images.count()).toBe(0);
      await upgraded.images.add({ ...data.images[0] });
      expect(await upgraded.images.where('pageId').equals('p1').count()).toBe(1);
      expect(upgraded.verno).toBe(2);
    } finally {
      await upgraded.delete();
    }
  });

  it('batches queued writes and lets the latest change to a row win', async () => {
    await importBackup(db, sampleBackup());
    const queue = new WriteQueue(db, 10_000);
    const stroke = sampleBackup().data.strokes[0];
    queue.put('strokes', { ...stroke, id: 'k2' });
    queue.put('strokes', { ...stroke, id: 'k2', color: '#e03131' });
    queue.put('strokes', { ...stroke, id: 'k3' });
    queue.delete('strokes', 'k3');
    queue.delete('strokes', 'k1');
    queue.putSetting('theme', 'light');
    expect(await db.strokes.count()).toBe(1);
    await queue.flush();
    const strokes = await db.strokes.toArray();
    expect(strokes.map((s) => [s.id, s.color])).toEqual([['k2', '#e03131']]);
    expect((await db.settings.get('theme'))?.value).toBe('light');
    expect(queue.hasPending).toBe(false);
  });

  it('discards unwritten changes on request', async () => {
    const queue = new WriteQueue(db, 10_000);
    queue.put('notebooks', sampleBackup().data.notebooks[0]);
    queue.discard();
    await queue.flush();
    expect(await db.notebooks.count()).toBe(0);
  });
});

describe('base64', () => {
  it('round-trips every byte value, including large inputs', () => {
    const bytes = new Uint8Array(100_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) % 256;
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe('aGk=');
    expect(base64ToBytes('')).toEqual(new Uint8Array(0));
  });

  it('rejects text that is not base64', () => {
    expect(base64ToBytes('abc')).toBeNull();
    expect(base64ToBytes('ab=c')).toBeNull();
    expect(base64ToBytes('a b+')).toBeNull();
    expect(base64ToBytes('data:image/png;base64,AAAA')).toBeNull();
  });
});
