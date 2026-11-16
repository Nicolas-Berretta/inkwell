/** Dexie (IndexedDB) schema. All application data lives in this one local database. */
import Dexie, { type Table } from 'dexie';
import type {
  ImageBlobRecord,
  ImageRecord,
  Notebook,
  Page,
  Section,
  SettingRecord,
  StrokeRecord,
  TextBoxRecord,
} from '../types';

export const DATABASE_NAME = 'inkwell';

export class AppDatabase extends Dexie {
  notebooks!: Table<Notebook, string>;
  sections!: Table<Section, string>;
  pages!: Table<Page, string>;
  strokes!: Table<StrokeRecord, string>;
  textBoxes!: Table<TextBoxRecord, string>;
  images!: Table<ImageRecord, string>;
  imageBlobs!: Table<ImageBlobRecord, string>;
  settings!: Table<SettingRecord, string>;

  constructor(name: string = DATABASE_NAME) {
    super(name);
    this.version(1).stores({
      notebooks: 'id',
      sections: 'id, notebookId',
      pages: 'id, sectionId',
      strokes: 'id, pageId',
      textBoxes: 'id, pageId',
      settings: 'key',
    });
    // Version 2 adds images. Only new tables are created, so a version 1
    // database is upgraded in place with all of its existing rows untouched.
    this.version(2).stores({
      images: 'id, pageId',
      imageBlobs: 'id',
    });
  }
}

/** Names of the tables whose rows are keyed by an `id` string. */
export type EntityTableName = 'notebooks' | 'sections' | 'pages' | 'strokes' | 'textBoxes' | 'images' | 'imageBlobs';

export interface EntityRecordMap {
  notebooks: Notebook;
  sections: Section;
  pages: Page;
  strokes: StrokeRecord;
  textBoxes: TextBoxRecord;
  images: ImageRecord;
  imageBlobs: ImageBlobRecord;
}
