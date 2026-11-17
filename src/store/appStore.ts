/**
 * Application state (zustand): the notebook hierarchy, the active selection,
 * the text boxes of the open page and UI preferences. Strokes are deliberately
 * NOT kept here: they live in the canvas engine and go straight to the write
 * queue, so drawing never causes a React render.
 */
import { create } from 'zustand';
import { sanitizeCamera } from '../canvas/math/camera';
import { BackupError, backupFileName, exportBackup, importBackup, parseBackupText } from '../db/backup';
import { SECTION_COLORS, createNotebook, createPage, createSection, newId } from '../db/factories';
import { db, flushAll, setPersistenceErrorHandler, setPersistenceStatusHandler, writeQueue } from '../db/persistence';
import {
  deleteNotebookCascade,
  deletePagesCascade,
  deleteSectionsCascade,
  loadTextBoxes,
  loadTextProjection,
  loadWorkspace,
} from '../db/repositories';
import { seedIfEmpty } from '../db/seed';
import type { SaveStatus } from '../db/writeQueue';
import type {
  CameraState,
  Notebook,
  Page,
  PageBackground,
  Section,
  TextBoxRecord,
  ThemeMode,
  ThemePreference,
  ToolId,
  ToolSettings,
} from '../types';
import { MAX_PAGE_DEPTH } from '../types';
import { getActiveEngine } from './engineRegistry';
import { moveItem, normalizePageList, pagesOfSection } from './pageTree';
import type { InkKind, RecentColors } from './palette';
import { addRecentColor, readRecentColors } from './palette';
import { DEFAULT_TOOLS, readTools } from './toolSettings';

export { HIGHLIGHTER_SIZES, PEN_SIZES } from './toolSettings';


const THEME_STORAGE_KEY = 'inkwell.theme';
export const DEFAULT_TEXT_BOX_WIDTH = 340;
/** Offsets that put the caret of a new text box right under the click position. */
const TEXT_BOX_CARET_OFFSET = { x: 11, y: 19 };

export interface Toast {
  id: number;
  kind: 'info' | 'error';
  message: string;
}

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
  resolve: (confirmed: boolean) => void;
}

export interface AppState {
  status: 'loading' | 'ready' | 'error';
  errorMessage: string;
  notebooks: Notebook[];
  sections: Section[];
  pages: Page[];
  activeNotebookId: string | null;
  activeSectionId: string | null;
  activePageId: string | null;
  textBoxes: TextBoxRecord[];
  /** Text box that should grab keyboard focus when it mounts. */
  focusTextBoxId: string | null;
  themePreference: ThemePreference;
  theme: ThemeMode;
  sidebarCollapsed: boolean;
  tools: ToolSettings;
  /** Custom ink colours that were used, most recent first, per tool. */
  recentColors: RecentColors;
  zoom: number;
  canUndo: boolean;
  canRedo: boolean;
  toast: Toast | null;
  confirmRequest: ConfirmRequest | null;
  /** Whether every change has reached local storage. Changes when an action ends, never per pointer move. */
  saveStatus: SaveStatus;

  init(): Promise<void>;
  selectNotebook(notebookId: string): Promise<void>;
  selectSection(sectionId: string): Promise<void>;
  selectPage(pageId: string): Promise<void>;

  addNotebook(): Promise<void>;
  renameNotebook(notebookId: string, name: string): void;
  removeNotebook(notebookId: string): Promise<void>;

  addSection(): Promise<void>;
  renameSection(sectionId: string, name: string): void;
  removeSection(sectionId: string): Promise<void>;

  addPage(): Promise<void>;
  renamePage(pageId: string, title: string): void;
  removePage(pageId: string): Promise<void>;
  movePage(pageId: string, toIndex: number): void;
  indentPage(pageId: string, delta: 1 | -1): void;
  setPageBackground(pageId: string, background: PageBackground): void;
  saveCamera(pageId: string, camera: CameraState): void;

  addTextBox(pageId: string, x: number, y: number): void;
  updateTextBox(id: string, patch: Partial<Omit<TextBoxRecord, 'id' | 'pageId'>>): void;
  /** Adds complete text boxes to the open page (paste, duplicate, undo of a removal). */
  putTextBoxes(records: readonly TextBoxRecord[]): void;
  removeTextBox(id: string): void;
  clearTextBoxFocusRequest(id: string): void;

  setTool(tool: ToolId): void;
  updateTools(patch: Partial<ToolSettings>): void;
  /** Records a custom colour as recently used for the pen or the highlighter. */
  rememberColor(kind: InkKind, color: string): void;
  setThemePreference(preference: ThemePreference): void;
  toggleSidebar(): void;
  setHistoryState(canUndo: boolean, canRedo: boolean): void;

  exportBackupFile(): Promise<void>;
  importBackupFile(file: File): Promise<void>;

  notify(message: string, kind?: Toast['kind']): void;
  dismissToast(): void;
  confirm(options: { title: string; message: string; confirmLabel?: string; danger?: boolean }): Promise<boolean>;
  resolveConfirm(confirmed: boolean): void;
}

// ------------------------------------------------------------- module helpers

const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

function resolveTheme(preference: ThemePreference): ThemeMode {
  if (preference === 'system') return systemDark() ? 'dark' : 'light';
  return preference;
}

function applyThemeToDocument(theme: ThemeMode, preference: ThemePreference): void {
  document.documentElement.dataset.theme = theme;
  try {
    // Mirror only; IndexedDB stays the source of truth. Lets index.html pick the palette before first paint.
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Storage may be unavailable (private mode); the theme still applies for this session.
  }
}

function readThemePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

const byOrder = <T extends { order: number }>(a: T, b: T) => a.order - b.order;

export function sectionsOfNotebook(sections: readonly Section[], notebookId: string | null): Section[] {
  return sections.filter((section) => section.notebookId === notebookId).sort(byOrder);
}

export { pagesOfSection };

function nextOrder(items: ReadonlyArray<{ order: number }>): number {
  return items.reduce((max, item) => Math.max(max, item.order), 0) + 1;
}

function cleanName(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 200) : fallback;
}

function emptyDocument(): unknown {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

/** Remembers which page was last open in each section (session only). */
const lastPageBySection = new Map<string, string>();
let selectionToken = 0;
let initPromise: Promise<void> | null = null;
let toastCounter = 0;
let searchTextsCache: Promise<Array<{ pageId: string; text: string }>> | null = null;

/** Plain-text projection of all text boxes for search; cached until text changes. */
export function getSearchTexts(): Promise<Array<{ pageId: string; text: string }>> {
  if (!searchTextsCache) {
    searchTextsCache = flushAll().then(() => loadTextProjection(db));
    searchTextsCache.catch(() => {
      searchTextsCache = null;
    });
  }
  return searchTextsCache;
}

function invalidateSearchTexts(): void {
  searchTextsCache = null;
}

function downloadJson(fileName: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------- store

export const useAppStore = create<AppState>((set, get) => {
  /** Makes a page (or no page) the active one, loading its text boxes first. */
  async function activate(notebookId: string | null, sectionId: string | null, pageId: string | null): Promise<void> {
    const token = ++selectionToken;
    await flushAll();
    const textBoxes = pageId ? await loadTextBoxes(db, pageId) : [];
    if (token !== selectionToken) return;
    const page = pageId ? get().pages.find((p) => p.id === pageId) : undefined;
    if (sectionId && pageId) lastPageBySection.set(sectionId, pageId);
    set({
      activeNotebookId: notebookId,
      activeSectionId: sectionId,
      activePageId: page ? page.id : null,
      textBoxes: page ? textBoxes : [],
      focusTextBoxId: null,
      zoom: page ? sanitizeCamera(page.camera).zoom : 1,
      canUndo: false,
      canRedo: false,
    });
    writeQueue.putSetting('lastPageId', page ? page.id : null);
  }

  function preferredPage(sectionId: string): string | null {
    const pages = pagesOfSection(get().pages, sectionId);
    const remembered = lastPageBySection.get(sectionId);
    if (remembered && pages.some((p) => p.id === remembered)) return remembered;
    return pages[0]?.id ?? null;
  }

  function activateSection(sectionId: string | null): Promise<void> {
    if (!sectionId) return activate(get().activeNotebookId, null, null);
    const section = get().sections.find((s) => s.id === sectionId);
    if (!section) return Promise.resolve();
    return activate(section.notebookId, section.id, preferredPage(section.id));
  }

  function activateNotebook(notebookId: string | null): Promise<void> {
    if (!notebookId) return activate(null, null, null);
    const first = sectionsOfNotebook(get().sections, notebookId)[0];
    if (!first) return activate(notebookId, null, null);
    return activate(notebookId, first.id, preferredPage(first.id));
  }

  function replacePages(sectionId: string, ordered: readonly Page[]): void {
    const { pages, changed } = normalizePageList(ordered);
    for (const page of changed) writeQueue.put('pages', page);
    set((state) => ({ pages: state.pages.filter((p) => p.sectionId !== sectionId).concat(pages) }));
  }

  function patchPage(pageId: string, patch: Partial<Page>): Page | null {
    const current = get().pages.find((p) => p.id === pageId);
    if (!current) return null;
    const next: Page = { ...current, ...patch, updatedAt: Date.now() };
    set((state) => ({ pages: state.pages.map((p) => (p.id === pageId ? next : p)) }));
    writeQueue.put('pages', next);
    return next;
  }

  async function hydrate(): Promise<void> {
    await seedIfEmpty(db);
    const workspace = await loadWorkspace(db);
    const themePreference = readThemePreference(workspace.settings.get('theme'));
    const theme = resolveTheme(themePreference);
    applyThemeToDocument(theme, themePreference);
    lastPageBySection.clear();
    invalidateSearchTexts();
    set({
      notebooks: workspace.notebooks,
      sections: workspace.sections,
      pages: workspace.pages,
      themePreference,
      theme,
      sidebarCollapsed: workspace.settings.get('sidebarCollapsed') === true,
      tools: readTools(workspace.settings.get('tools')),
      recentColors: readRecentColors(workspace.settings.get('recentColors')),
    });

    const lastPageId = workspace.settings.get('lastPageId');
    const lastPage = typeof lastPageId === 'string' ? workspace.pages.find((p) => p.id === lastPageId) : undefined;
    const lastSection = lastPage ? workspace.sections.find((s) => s.id === lastPage.sectionId) : undefined;
    if (lastPage && lastSection) {
      await activate(lastSection.notebookId, lastSection.id, lastPage.id);
    } else {
      await activateNotebook(workspace.notebooks[0]?.id ?? null);
    }
    set({ status: 'ready', errorMessage: '' });
  }

  return {
    status: 'loading',
    errorMessage: '',
    notebooks: [],
    sections: [],
    pages: [],
    activeNotebookId: null,
    activeSectionId: null,
    activePageId: null,
    textBoxes: [],
    focusTextBoxId: null,
    themePreference: 'system',
    theme: resolveTheme('system'),
    sidebarCollapsed: false,
    tools: { ...DEFAULT_TOOLS },
    recentColors: { pen: [], highlighter: [] },
    zoom: 1,
    canUndo: false,
    canRedo: false,
    toast: null,
    confirmRequest: null,
    saveStatus: 'saved',

    init() {
      if (!initPromise) {
        setPersistenceErrorHandler((error) => {
          console.error('Failed to save changes', error);
          const full = error instanceof DOMException && error.name === 'QuotaExceededError';
          get().notify(
            full
              ? 'Recent changes could not be saved: this browser has no storage space left for Inkwell.'
              : 'Could not save recent changes to local storage.',
            'error',
          );
        });
        setPersistenceStatusHandler((saveStatus) => set({ saveStatus }));
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
          const { themePreference } = get();
          if (themePreference !== 'system') return;
          const theme = resolveTheme('system');
          applyThemeToDocument(theme, themePreference);
          set({ theme });
        });
        initPromise = hydrate().catch((error: unknown) => {
          console.error('Failed to open the local database', error);
          set({
            status: 'error',
            errorMessage: error instanceof Error ? error.message : 'The local database could not be opened.',
          });
        });
      }
      return initPromise;
    },

    selectNotebook: (notebookId) => activateNotebook(notebookId),
    selectSection: (sectionId) => activateSection(sectionId),
    selectPage(pageId) {
      const page = get().pages.find((p) => p.id === pageId);
      const section = page ? get().sections.find((s) => s.id === page.sectionId) : undefined;
      if (!page || !section) return Promise.resolve();
      return activate(section.notebookId, section.id, page.id);
    },

    // ---------------------------------------------------------------- notebooks

    async addNotebook() {
      const { notebooks } = get();
      const notebook = createNotebook(`Notebook ${notebooks.length + 1}`, nextOrder(notebooks));
      const section = createSection(notebook.id, 'New Section', 1, SECTION_COLORS[0]);
      const page = createPage(section.id, 'Untitled page', 1);
      writeQueue.put('notebooks', notebook);
      writeQueue.put('sections', section);
      writeQueue.put('pages', page);
      set((state) => ({
        notebooks: state.notebooks.concat(notebook),
        sections: state.sections.concat(section),
        pages: state.pages.concat(page),
      }));
      await activate(notebook.id, section.id, page.id);
    },

    renameNotebook(notebookId, name) {
      const current = get().notebooks.find((n) => n.id === notebookId);
      if (!current) return;
      const next: Notebook = { ...current, name: cleanName(name, current.name), updatedAt: Date.now() };
      set((state) => ({ notebooks: state.notebooks.map((n) => (n.id === notebookId ? next : n)) }));
      writeQueue.put('notebooks', next);
    },

    async removeNotebook(notebookId) {
      const notebook = get().notebooks.find((n) => n.id === notebookId);
      if (!notebook) return;
      const confirmed = await get().confirm({
        title: 'Delete notebook?',
        message: `"${notebook.name}" and all of its sections and pages will be permanently deleted.`,
        confirmLabel: 'Delete notebook',
        danger: true,
      });
      if (!confirmed) return;
      await flushAll();
      await deleteNotebookCascade(db, notebookId);
      invalidateSearchTexts();
      const sectionIds = new Set(get().sections.filter((s) => s.notebookId === notebookId).map((s) => s.id));
      const wasActive = get().activeNotebookId === notebookId;
      set((state) => ({
        notebooks: state.notebooks.filter((n) => n.id !== notebookId),
        sections: state.sections.filter((s) => s.notebookId !== notebookId),
        pages: state.pages.filter((p) => !sectionIds.has(p.sectionId)),
      }));
      if (wasActive) await activateNotebook(get().notebooks[0]?.id ?? null);
    },

    // ----------------------------------------------------------------- sections

    async addSection() {
      const { activeNotebookId, sections } = get();
      if (!activeNotebookId) return;
      const siblings = sectionsOfNotebook(sections, activeNotebookId);
      const color = SECTION_COLORS[siblings.length % SECTION_COLORS.length];
      const section = createSection(activeNotebookId, 'New Section', nextOrder(siblings), color);
      const page = createPage(section.id, 'Untitled page', 1);
      writeQueue.put('sections', section);
      writeQueue.put('pages', page);
      set((state) => ({ sections: state.sections.concat(section), pages: state.pages.concat(page) }));
      await activate(activeNotebookId, section.id, page.id);
    },

    renameSection(sectionId, name) {
      const current = get().sections.find((s) => s.id === sectionId);
      if (!current) return;
      const next: Section = { ...current, name: cleanName(name, current.name), updatedAt: Date.now() };
      set((state) => ({ sections: state.sections.map((s) => (s.id === sectionId ? next : s)) }));
      writeQueue.put('sections', next);
    },

    async removeSection(sectionId) {
      const section = get().sections.find((s) => s.id === sectionId);
      if (!section) return;
      const confirmed = await get().confirm({
        title: 'Delete section?',
        message: `"${section.name}" and all of its pages will be permanently deleted.`,
        confirmLabel: 'Delete section',
        danger: true,
      });
      if (!confirmed) return;
      await flushAll();
      await deleteSectionsCascade(db, [sectionId]);
      invalidateSearchTexts();
      const wasActive = get().activeSectionId === sectionId;
      set((state) => ({
        sections: state.sections.filter((s) => s.id !== sectionId),
        pages: state.pages.filter((p) => p.sectionId !== sectionId),
      }));
      if (wasActive) {
        const next = sectionsOfNotebook(get().sections, section.notebookId)[0];
        if (next) await activateSection(next.id);
        else await activate(section.notebookId, null, null);
      }
    },

    // -------------------------------------------------------------------- pages

    async addPage() {
      const { activeNotebookId, activeSectionId, activePageId, pages } = get();
      if (!activeSectionId) return;
      const siblings = pagesOfSection(pages, activeSectionId);
      const page = createPage(activeSectionId, 'Untitled page', 0);
      // Insert right after the open page (keeping its level) or at the end of the section.
      const activeIndex = siblings.findIndex((p) => p.id === activePageId);
      const insertAt = activeIndex >= 0 ? activeIndex + 1 : siblings.length;
      if (activeIndex >= 0) page.depth = siblings[activeIndex].depth;
      const ordered = siblings.slice();
      ordered.splice(insertAt, 0, page);
      // `replacePages` assigns the final order and queues the new page for writing.
      replacePages(activeSectionId, ordered);
      await activate(activeNotebookId, activeSectionId, page.id);
    },

    renamePage(pageId, title) {
      patchPage(pageId, { title: title.slice(0, 300) });
    },

    async removePage(pageId) {
      const page = get().pages.find((p) => p.id === pageId);
      if (!page) return;
      const confirmed = await get().confirm({
        title: 'Delete page?',
        message: `"${page.title || 'Untitled page'}" and everything on it will be permanently deleted.`,
        confirmLabel: 'Delete page',
        danger: true,
      });
      if (!confirmed) return;
      await flushAll();
      await deletePagesCascade(db, [pageId]);
      invalidateSearchTexts();
      getActiveEngine()?.forgetPage(pageId);
      const siblings = pagesOfSection(get().pages, page.sectionId);
      const index = siblings.findIndex((p) => p.id === pageId);
      const remaining = siblings.filter((p) => p.id !== pageId);
      replacePages(page.sectionId, remaining);
      if (get().activePageId === pageId) {
        const neighbour = remaining[Math.min(index, remaining.length - 1)];
        lastPageBySection.delete(page.sectionId);
        await activate(get().activeNotebookId, page.sectionId, neighbour ? neighbour.id : null);
      }
    },

    movePage(pageId, toIndex) {
      const page = get().pages.find((p) => p.id === pageId);
      if (!page) return;
      const siblings = pagesOfSection(get().pages, page.sectionId);
      const from = siblings.findIndex((p) => p.id === pageId);
      if (from < 0 || from === toIndex) return;
      replacePages(page.sectionId, moveItem(siblings, from, toIndex));
    },

    indentPage(pageId, delta) {
      const page = get().pages.find((p) => p.id === pageId);
      if (!page) return;
      const siblings = pagesOfSection(get().pages, page.sectionId);
      const index = siblings.findIndex((p) => p.id === pageId);
      const maxDepth = index <= 0 ? 0 : Math.min(MAX_PAGE_DEPTH, siblings[index - 1].depth + 1);
      const depth = Math.max(0, Math.min(maxDepth, page.depth + delta));
      if (depth === page.depth) return;
      const updated: Page = { ...page, depth, updatedAt: Date.now() };
      writeQueue.put('pages', updated);
      replacePages(page.sectionId, siblings.map((p) => (p.id === pageId ? updated : p)));
    },

    setPageBackground(pageId, background) {
      patchPage(pageId, { background });
    },

    saveCamera(pageId, camera) {
      // Ignore late camera reports while the database is being (re)loaded or replaced.
      if (get().status !== 'ready') return;
      const page = patchPage(pageId, { camera });
      if (page && get().activePageId === pageId) set({ zoom: camera.zoom });
    },

    // --------------------------------------------------------------- text boxes

    addTextBox(pageId, x, y) {
      if (get().activePageId !== pageId) return;
      const box: TextBoxRecord = {
        id: newId(),
        pageId,
        x: Math.round(x - TEXT_BOX_CARET_OFFSET.x),
        y: Math.round(y - TEXT_BOX_CARET_OFFSET.y),
        width: DEFAULT_TEXT_BOX_WIDTH,
        content: emptyDocument(),
        plainText: '',
        updatedAt: Date.now(),
      };
      // Not persisted yet: an empty box is removed again on blur.
      set((state) => ({ textBoxes: state.textBoxes.concat(box), focusTextBoxId: box.id }));
    },

    updateTextBox(id, patch) {
      const current = get().textBoxes.find((box) => box.id === id);
      if (!current) return;
      const next: TextBoxRecord = { ...current, ...patch, updatedAt: Date.now() };
      set((state) => ({ textBoxes: state.textBoxes.map((box) => (box.id === id ? next : box)) }));
      writeQueue.put('textBoxes', next);
      if (patch.plainText !== undefined) invalidateSearchTexts();
    },

    putTextBoxes(records) {
      const pageId = get().activePageId;
      const fresh = records.filter((record) => record.pageId === pageId);
      if (fresh.length === 0) return;
      const ids = new Set(fresh.map((record) => record.id));
      set((state) => ({ textBoxes: state.textBoxes.filter((box) => !ids.has(box.id)).concat(fresh) }));
      for (const record of fresh) writeQueue.put('textBoxes', record);
      invalidateSearchTexts();
    },

    removeTextBox(id) {
      if (!get().textBoxes.some((box) => box.id === id)) return;
      set((state) => ({
        textBoxes: state.textBoxes.filter((box) => box.id !== id),
        focusTextBoxId: state.focusTextBoxId === id ? null : state.focusTextBoxId,
      }));
      writeQueue.delete('textBoxes', id);
      invalidateSearchTexts();
    },

    clearTextBoxFocusRequest(id) {
      if (get().focusTextBoxId === id) set({ focusTextBoxId: null });
    },

    // -------------------------------------------------------------- preferences

    setTool(tool) {
      get().updateTools({ tool });
    },

    updateTools(patch) {
      const tools = { ...get().tools, ...patch };
      set({ tools });
      writeQueue.putSetting('tools', tools);
    },

    rememberColor(kind, color) {
      const current = get().recentColors;
      const next = addRecentColor(current[kind], kind, color);
      if (next.length === current[kind].length && next.every((entry, index) => entry === current[kind][index])) return;
      const recentColors = { ...current, [kind]: next };
      set({ recentColors });
      writeQueue.putSetting('recentColors', recentColors);
    },

    setThemePreference(preference) {
      const theme = resolveTheme(preference);
      applyThemeToDocument(theme, preference);
      set({ themePreference: preference, theme });
      writeQueue.putSetting('theme', preference);
    },

    toggleSidebar() {
      const sidebarCollapsed = !get().sidebarCollapsed;
      set({ sidebarCollapsed });
      writeQueue.putSetting('sidebarCollapsed', sidebarCollapsed);
    },

    setHistoryState(canUndo, canRedo) {
      if (get().canUndo !== canUndo || get().canRedo !== canRedo) set({ canUndo, canRedo });
    },

    // ------------------------------------------------------------------- backup

    async exportBackupFile() {
      try {
        await flushAll();
        const backup = await exportBackup(db);
        downloadJson(backupFileName(), backup);
        get().notify('Backup exported.');
      } catch (error) {
        console.error('Backup export failed', error);
        get().notify('The backup could not be exported.', 'error');
      }
    },

    async importBackupFile(file) {
      let backup;
      try {
        backup = parseBackupText(await file.text());
      } catch (error) {
        const reason = error instanceof BackupError ? error.message : 'The file could not be read.';
        get().notify(`Import failed. ${reason} Nothing was changed.`, 'error');
        return;
      }
      const { notebooks, pages } = backup.data;
      const confirmed = await get().confirm({
        title: 'Replace all notes with this backup?',
        message:
          `The backup contains ${notebooks.length} notebook${notebooks.length === 1 ? '' : 's'} and ` +
          `${pages.length} page${pages.length === 1 ? '' : 's'}. Importing replaces everything currently ` +
          'stored in this browser. Export a backup first if you want to keep your current notes.',
        confirmLabel: 'Replace everything',
        danger: true,
      });
      if (!confirmed) return;
      try {
        await flushAll();
        // Take the open page away first so no component writes into the old data while it is replaced.
        selectionToken++;
        set({ status: 'loading', activePageId: null, textBoxes: [] });
        await flushAll();
        writeQueue.discard();
        await importBackup(db, backup);
        await hydrate();
        get().notify('Backup imported.');
      } catch (error) {
        console.error('Backup import failed', error);
        await hydrate().catch(() => undefined);
        get().notify('Import failed while writing to local storage. Your previous notes were kept.', 'error');
      }
    },

    // ----------------------------------------------------------------- feedback

    notify(message, kind = 'info') {
      set({ toast: { id: ++toastCounter, kind, message } });
    },

    dismissToast() {
      set({ toast: null });
    },

    confirm(options) {
      get().confirmRequest?.resolve(false);
      return new Promise<boolean>((resolve) => {
        set({
          confirmRequest: {
            title: options.title,
            message: options.message,
            confirmLabel: options.confirmLabel ?? 'Confirm',
            danger: options.danger ?? false,
            resolve,
          },
        });
      });
    },

    resolveConfirm(confirmed) {
      const request = get().confirmRequest;
      if (!request) return;
      set({ confirmRequest: null });
      request.resolve(confirmed);
    },
  };
});
