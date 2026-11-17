import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StrokeRecord } from '../types';
import { AppDatabase } from './database';
import type { SaveStatus } from './writeQueue';
import { WriteQueue } from './writeQueue';

function stroke(id: string, x = 0): StrokeRecord {
  return { id, pageId: 'p1', tool: 'pen', color: '#000000', size: 2.5, points: [x, 0, 2.5, x + 10, 5, 2.5], order: 1 };
}

/** Lets the queue's end-of-task write start, then waits for IndexedDB to finish it. */
async function endOfTask(queue: WriteQueue): Promise<void> {
  await Promise.resolve();
  await queue.flush();
}

describe('saving each action as it ends', () => {
  let db: AppDatabase;
  let counter = 0;
  let transactions: string[][];

  beforeEach(async () => {
    db = new AppDatabase(`write-queue-test-${++counter}`);
    await db.open();
    // Count the transactions the queue opens, to see how writes are batched.
    transactions = [];
    const backend = db.backendDB();
    const original = backend.transaction.bind(backend);
    backend.transaction = ((names: string | string[], mode?: IDBTransactionMode) => {
      if (mode === 'readwrite') transactions.push([names].flat());
      return original(names, mode);
    }) as IDBDatabase['transaction'];
  });

  afterEach(async () => {
    await db.delete();
  });

  it('hands a change to IndexedDB as soon as the current task ends, with no timer', async () => {
    const queue = new WriteQueue(db);
    queue.put('strokes', stroke('a'));
    // Still the same task: nothing has been issued yet...
    expect(transactions).toHaveLength(0);
    // ...and one microtask later (no timers ran) the write transaction exists.
    await Promise.resolve();
    expect(transactions).toEqual([['strokes']]);
    await queue.flush();
    expect(await db.strokes.get('a')).toEqual(stroke('a'));
  });

  it('writes everything changed by one action in a single transaction', async () => {
    const queue = new WriteQueue(db);
    // A paste: many strokes, an image with its pixels, and a setting, all in one task.
    for (let i = 0; i < 40; i++) queue.put('strokes', stroke(`s${i}`, i));
    queue.put('images', { id: 'i1', pageId: 'p1', x: 0, y: 0, width: 10, height: 10, naturalWidth: 10, naturalHeight: 10, locked: false, order: 1 });
    queue.put('imageBlobs', { id: 'i1', data: new Blob(['pixels'], { type: 'image/png' }) });
    queue.putSetting('tools', { tool: 'lasso' });
    await endOfTask(queue);
    expect(transactions).toHaveLength(1);
    expect(transactions[0].sort()).toEqual(['imageBlobs', 'images', 'settings', 'strokes']);
    expect(await db.strokes.count()).toBe(40);
    expect(await db.images.count()).toBe(1);
    expect((await db.imageBlobs.get('i1'))?.data.size).toBe(6);
  });

  it('uses a separate transaction for each later action', async () => {
    const queue = new WriteQueue(db);
    queue.put('strokes', stroke('a'));
    await endOfTask(queue);
    queue.put('strokes', stroke('b'));
    await endOfTask(queue);
    queue.delete('strokes', 'a');
    await endOfTask(queue);
    expect(transactions).toHaveLength(3);
    expect((await db.strokes.toArray()).map((s) => s.id)).toEqual(['b']);
  });

  it('keeps only the last state of a row changed several times in one action', async () => {
    const queue = new WriteQueue(db);
    queue.put('strokes', stroke('a', 1));
    queue.put('strokes', stroke('a', 2));
    queue.put('strokes', stroke('gone'));
    queue.delete('strokes', 'gone');
    await endOfTask(queue);
    expect(await db.strokes.toArray()).toEqual([stroke('a', 2)]);
  });

  it('still supports a delay for callers that ask for one', async () => {
    const queue = new WriteQueue(db, 10_000);
    queue.put('strokes', stroke('a'));
    await Promise.resolve();
    expect(transactions).toHaveLength(0);
    await queue.flush();
    expect(await db.strokes.count()).toBe(1);
  });

  it('reports saving while a write is under way and saved when it is done', async () => {
    const statuses: SaveStatus[] = [];
    const queue = new WriteQueue(db, 0, undefined, (status) => statuses.push(status));
    expect(queue.status).toBe('saved');
    queue.put('strokes', stroke('a'));
    expect(queue.status).toBe('saving');
    await endOfTask(queue);
    expect(queue.status).toBe('saved');
    expect(statuses).toEqual(['saving', 'saved']);
    // Moving the pointer queues nothing, so the status does not change between actions.
    queue.put('strokes', stroke('b'));
    queue.put('strokes', stroke('c'));
    await endOfTask(queue);
    expect(statuses).toEqual(['saving', 'saved', 'saving', 'saved']);
  });

  it('keeps changes that could not be written, reports the error, and saves them on retry', async () => {
    const errors: unknown[] = [];
    const statuses: SaveStatus[] = [];
    const queue = new WriteQueue(db, 0, (error) => errors.push(error), (status) => statuses.push(status));
    const backend = db.backendDB();
    const working = backend.transaction;
    // The storage is full: every write is refused.
    backend.transaction = (() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    }) as IDBDatabase['transaction'];

    queue.put('strokes', stroke('a'));
    queue.delete('strokes', 'old');
    await endOfTask(queue);
    expect(errors).toHaveLength(1);
    expect((errors[0] as DOMException).name).toBe('QuotaExceededError');
    expect(queue.status).toBe('error');
    expect(queue.hasPending).toBe(true);
    expect(await db.strokes.count()).toBe(0);

    // A newer change to the same row made while the error lasts wins over the failed one.
    queue.put('strokes', stroke('a', 99));
    await endOfTask(queue);
    expect(queue.status).toBe('error');

    // Space is available again.
    backend.transaction = working;
    await queue.retry();
    expect(queue.status).toBe('saved');
    expect(queue.hasPending).toBe(false);
    expect(await db.strokes.toArray()).toEqual([stroke('a', 99)]);
    expect(statuses[statuses.length - 1]).toBe('saved');
    expect(statuses).toContain('error');
  });

  it('never writes half of a batch when one record is refused', async () => {
    const errors: unknown[] = [];
    const queue = new WriteQueue(db, 0, (error) => errors.push(error));
    queue.put('strokes', stroke('good'));
    // A record without its key cannot be stored.
    queue.put('strokes', { ...stroke('bad'), id: undefined as unknown as string });
    await endOfTask(queue);
    expect(errors).toHaveLength(1);
    expect(await db.strokes.count()).toBe(0);
    expect(queue.status).toBe('error');
  });

  it('forgets failed changes when the queue is discarded', async () => {
    const queue = new WriteQueue(db, 0, () => undefined);
    const backend = db.backendDB();
    backend.transaction = (() => {
      throw new Error('refused');
    }) as IDBDatabase['transaction'];
    queue.put('strokes', stroke('a'));
    await endOfTask(queue);
    expect(queue.status).toBe('error');
    queue.discard();
    expect(queue.status).toBe('saved');
    expect(queue.hasPending).toBe(false);
  });
});
