/** First-run content: one notebook, one section and one page so the app is usable immediately. */
import type { AppDatabase } from './database';
import { SECTION_COLORS, createNotebook, createPage, createSection } from './factories';

/** Seeds the database when it holds no notebooks. Returns true if it seeded. */
export function seedIfEmpty(db: AppDatabase): Promise<boolean> {
  return db.transaction('rw', [db.notebooks, db.sections, db.pages], async () => {
    if ((await db.notebooks.count()) > 0) return false;
    const notebook = createNotebook('My Notebook', 1);
    const section = createSection(notebook.id, 'Quick Notes', 1, SECTION_COLORS[0]);
    const page = createPage(section.id, 'Untitled page', 1, 'ruled');
    await db.notebooks.add(notebook);
    await db.sections.add(section);
    await db.pages.add(page);
    return true;
  });
}
