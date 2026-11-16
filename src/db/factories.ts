/** Constructors for new domain records with sensible defaults. */
import { DEFAULT_CAMERA } from '../canvas/math/camera';
import type { Notebook, Page, PageBackground, Section } from '../types';

export const SECTION_COLORS: readonly string[] = [
  '#7c5cd6',
  '#2f8fdd',
  '#1fa67a',
  '#e0a019',
  '#e2603a',
  '#d6457f',
  '#5b6ee1',
  '#3aa3a3',
];

export function newId(): string {
  return crypto.randomUUID();
}

export function createNotebook(name: string, order: number): Notebook {
  const now = Date.now();
  return { id: newId(), name, order, createdAt: now, updatedAt: now };
}

export function createSection(notebookId: string, name: string, order: number, color: string): Section {
  const now = Date.now();
  return { id: newId(), notebookId, name, color, order, createdAt: now, updatedAt: now };
}

export function createPage(
  sectionId: string,
  title: string,
  order: number,
  background: PageBackground = 'blank',
  depth = 0,
): Page {
  const now = Date.now();
  return {
    id: newId(),
    sectionId,
    title,
    order,
    depth,
    background,
    camera: { ...DEFAULT_CAMERA },
    createdAt: now,
    updatedAt: now,
  };
}
