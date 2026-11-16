/** Pure helpers for the flat, ordered page list with indentation ("sub-pages"). */
import type { Page } from '../types';
import { MAX_PAGE_DEPTH } from '../types';

/** Pages of one section in display order. */
export function pagesOfSection(pages: readonly Page[], sectionId: string): Page[] {
  return pages.filter((page) => page.sectionId === sectionId).sort((a, b) => a.order - b.order);
}

/**
 * Renumbers `order` and repairs indentation so the list is always a valid
 * outline: the first page is top-level and no page is more than one level
 * deeper than the page above it. Returns only the pages that changed.
 */
export function normalizePageList(ordered: readonly Page[], now = Date.now()): { pages: Page[]; changed: Page[] } {
  const pages: Page[] = [];
  const changed: Page[] = [];
  let previousDepth = -1;
  ordered.forEach((page, index) => {
    const order = index + 1;
    const depth = Math.max(0, Math.min(page.depth, previousDepth + 1, MAX_PAGE_DEPTH));
    previousDepth = depth;
    if (page.order === order && page.depth === depth) {
      pages.push(page);
      return;
    }
    const next: Page = { ...page, order, depth, updatedAt: now };
    pages.push(next);
    changed.push(next);
  });
  return { pages, changed };
}

/** Moves the item at `from` so that it ends up at index `to` of the resulting list. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = list.slice();
  if (from < 0 || from >= next.length) return next;
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}
