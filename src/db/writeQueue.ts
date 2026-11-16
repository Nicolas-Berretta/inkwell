/**
 * Debounced, batched writer in front of IndexedDB.
 *
 * Hot paths (drawing, typing, panning) only drop records into in-memory maps;
 * a short timer later writes everything pending in a single transaction, so
 * interaction never waits on IO. Later writes to the same row replace earlier
 * ones, and a delete cancels a pending put (and vice versa).
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

export class WriteQueue {
  private puts = emptyPuts();
  private deletes = emptyDeletes();
  private settings = new Map<string, SettingRecord>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: AppDatabase,
    private readonly delayMs = 250,
    private readonly onError: (error: unknown) => void = (error) => console.error('Failed to save changes', error),
  ) {}

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
    const written = this.db.isOpen()
      ? this.write(batch)
      : previous.then(() => this.db.open()).then(() => this.write(batch));
    this.chain = Promise.all([previous, written.catch(this.onError)]).then(() => undefined);
    return this.chain;
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
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

      for (const table of tables) {
        const store = transaction.objectStore(table);
        for (const id of batch.deletes[table]) store.delete(id);
        for (const record of batch.puts[table].values()) store.put(record);
      }
      if (batch.settings.size > 0) {
        const store = transaction.objectStore('settings');
        for (const setting of batch.settings.values()) store.put(setting);
      }
      // Ask for the commit right away instead of waiting for the request callbacks to drain.
      if (typeof transaction.commit === 'function') transaction.commit();
    });
  }
}
