/**
 * Batched writer in front of IndexedDB.
 *
 * Callers (drawing, typing, panning) only drop records into in-memory maps and
 * never wait for IO. Everything queued during one task (one pointer event, one
 * key press, one command) is handed to IndexedDB together, in a single
 * transaction, as soon as that task ends: an action is on its way to disk the
 * moment it is finished, not after a delay. Later writes to the same row
 * replace earlier ones, and a delete cancels a pending put (and vice versa).
 *
 * A batch that fails to write (for example because the storage quota is
 * exceeded) is not dropped: it goes back into the queue, the status becomes
 * `error`, and it is written again with the next change or on `retry()`.
 *
 * `flush()` writes immediately and is called when the tab is hidden or closed
 * and before any operation that needs the database to be up to date.
 */
import type { SettingRecord } from '../types';
import type { AppDatabase, EntityRecordMap, EntityTableName } from './database';

const ENTITY_TABLES: readonly EntityTableName[] = [
  'notebooks',
  'sections',
  'pages',
  'strokes',
  'textBoxes',
  'images',
  'imageBlobs',
];

type PendingPuts = { [K in EntityTableName]: Map<string, EntityRecordMap[K]> };
type PendingDeletes = Record<EntityTableName, Set<string>>;

interface Batch {
  puts: PendingPuts;
  deletes: PendingDeletes;
  settings: Map<string, SettingRecord>;
}

function emptyPuts(): PendingPuts {
  return {
    notebooks: new Map(),
    sections: new Map(),
    pages: new Map(),
    strokes: new Map(),
    textBoxes: new Map(),
    images: new Map(),
    imageBlobs: new Map(),
  };
}

function emptyDeletes(): PendingDeletes {
  return {
    notebooks: new Set(),
    sections: new Set(),
    pages: new Set(),
    strokes: new Set(),
    textBoxes: new Set(),
    images: new Set(),
    imageBlobs: new Set(),
  };
}

/** `saved`: everything is in IndexedDB. `saving`: a write is queued or in flight. `error`: the last write failed. */
export type SaveStatus = 'saved' | 'saving' | 'error';

export class WriteQueue {
  private puts = emptyPuts();
  private deletes = emptyDeletes();
  private settings = new Map<string, SettingRecord>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private microtaskQueued = false;
  private chain: Promise<void> = Promise.resolve();
  private inFlight = 0;
  private failed = false;
  private currentStatus: SaveStatus = 'saved';

  /**
   * @param delayMs  0 (the default) writes as soon as the current task ends;
   *                 a positive value waits that long first (used by tests).
   */
  constructor(
    private readonly db: AppDatabase,
    private readonly delayMs = 0,
    private readonly onError: (error: unknown) => void = (error) => console.error('Failed to save changes', error),
    private readonly onStatus: (status: SaveStatus) => void = () => undefined,
  ) {}

  get status(): SaveStatus {
    return this.currentStatus;
  }

  get hasPending(): boolean {
    if (this.settings.size > 0) return true;
    return ENTITY_TABLES.some((table) => this.puts[table].size > 0 || this.deletes[table].size > 0);
  }

  put<K extends EntityTableName>(table: K, record: EntityRecordMap[K]): void {
    this.deletes[table].delete(record.id);
    (this.puts[table] as Map<string, EntityRecordMap[K]>).set(record.id, record);
    this.schedule();
  }

  delete(table: EntityTableName, id: string): void {
    this.puts[table].delete(id);
    this.deletes[table].add(id);
    this.schedule();
  }

  putSetting(key: string, value: unknown): void {
    this.settings.set(key, { key, value });
    this.schedule();
  }

  /** Drops everything that has not been written yet (used before a full database replace). */
  discard(): void {
    this.cancelTimer();
    this.puts = emptyPuts();
    this.deletes = emptyDeletes();
    this.settings = new Map();
    this.failed = false;
    this.updateStatus();
  }

  /** Tries again to write changes that could not be saved. */
  retry(): Promise<void> {
    return this.flush();
  }

  /**
   * Writes all pending changes now. Resolves once every write issued so far has completed.
   *
   * When the database is open, the transaction is created and all requests are
   * issued synchronously inside this call. That matters during `pagehide`: a
   * browser only lets writes finish that were already handed over before the
   * page is torn down, so nothing here may wait for a later tick.
   */
  flush(): Promise<void> {
    this.cancelTimer();
    if (!this.hasPending) return this.chain;
    const batch: Batch = { puts: this.puts, deletes: this.deletes, settings: this.settings };
    this.puts = emptyPuts();
    this.deletes = emptyDeletes();
    this.settings = new Map();

    const previous = this.chain;
    this.inFlight++;
    this.updateStatus();
    const written = this.db.isOpen()
      ? this.write(batch)
      : previous.then(() => this.db.open()).then(() => this.write(batch));
    const settled = written.then(
      () => {
        this.failed = false;
      },
      (error: unknown) => {
        // Keep what could not be written so it is saved by the next attempt.
        this.restore(batch);
        this.failed = true;
        this.onError(error);
      },
    );
    this.chain = Promise.all([previous, settled]).then(() => {
      this.inFlight--;
      this.updateStatus();
    });
    return this.chain;
  }

  private schedule(): void {
    this.updateStatus();
    if (this.delayMs > 0) {
      if (this.timer !== null) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.delayMs);
      return;
    }
    // One write per task: everything queued by the current event handler goes into the same transaction.
    if (this.microtaskQueued) return;
    this.microtaskQueued = true;
    queueMicrotask(() => {
      this.microtaskQueued = false;
      void this.flush();
    });
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private updateStatus(): void {
    const status: SaveStatus = this.failed && this.inFlight === 0 ? 'error' : this.hasPending || this.inFlight > 0 ? 'saving' : 'saved';
    if (status === this.currentStatus) return;
    this.currentStatus = status;
    this.onStatus(status);
  }

  /** Puts a batch that failed to write back into the queue, without overriding newer changes to the same rows. */
  private restore(batch: Batch): void {
    for (const table of ENTITY_TABLES) {
      const puts = this.puts[table] as Map<string, { id: string }>;
      const deletes = this.deletes[table];
      for (const [id, record] of batch.puts[table] as Map<string, { id: string }>) {
        if (!puts.has(id) && !deletes.has(id)) puts.set(id, record);
      }
      for (const id of batch.deletes[table]) {
        if (!puts.has(id) && !deletes.has(id)) deletes.add(id);
      }
    }
    for (const [key, setting] of batch.settings) {
      if (!this.settings.has(key)) this.settings.set(key, setting);
    }
  }

  /** Issues one native IndexedDB transaction for the batch. Requests are queued synchronously. */
  private write(batch: Batch): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const tables = ENTITY_TABLES.filter((table) => batch.puts[table].size > 0 || batch.deletes[table].size > 0);
      const storeNames: string[] = batch.settings.size > 0 ? [...tables, 'settings'] : [...tables];
      const transaction = this.db.backendDB().transaction(storeNames, 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error('The write transaction was aborted.'));
      transaction.onerror = () => reject(transaction.error ?? new Error('The write transaction failed.'));

      try {
        for (const table of tables) {
          const store = transaction.objectStore(table);
          for (const id of batch.deletes[table]) store.delete(id);
          for (const record of batch.puts[table].values()) store.put(record);
        }
        if (batch.settings.size > 0) {
          const store = transaction.objectStore('settings');
          for (const setting of batch.settings.values()) store.put(setting);
        }
      } catch (error) {
        // A request was refused outright: abandon the whole batch so it is never half written.
        transaction.abort();
        reject(error);
        return;
      }
      // Ask for the commit right away instead of waiting for the request callbacks to drain.
      if (typeof transaction.commit === 'function') transaction.commit();
    });
  }
}
