/**
 * In-memory full-text search over page titles and the plain-text projection
 * of text boxes. Pure functions: the caller supplies the data, so searching
 * while typing never touches IndexedDB.
 */
import type { Page } from '../types';

export interface SearchResult {
  pageId: string;
  /** Where the match was found. */
  source: 'title' | 'text';
  /** Short excerpt around the first match (the title itself for title matches). */
  snippet: string;
  /** Offset and length of the match inside `snippet`, for highlighting. */
  matchStart: number;
  matchLength: number;
}

const SNIPPET_CONTEXT = 36;

function normalise(value: string): string {
  return value.toLocaleLowerCase();
}

function excerpt(text: string, index: number, length: number): Pick<SearchResult, 'snippet' | 'matchStart' | 'matchLength'> {
  const flat = text.replace(/\s+/g, ' ');
  // Whitespace collapsing can shift offsets, so locate the match again in the flattened text.
  const needle = normalise(text.slice(index, index + length)).replace(/\s+/g, ' ');
  const at = Math.max(0, normalise(flat).indexOf(needle));
  const start = Math.max(0, at - SNIPPET_CONTEXT);
  const end = Math.min(flat.length, at + needle.length + SNIPPET_CONTEXT);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < flat.length ? '…' : '';
  return {
    snippet: prefix + flat.slice(start, end) + suffix,
    matchStart: prefix.length + (at - start),
    matchLength: needle.length,
  };
}

/**
 * Returns at most one result per page: a title match if there is one,
 * otherwise the first text match. Title matches are listed first.
 */
export function searchPages(
  query: string,
  pages: readonly Page[],
  texts: ReadonlyArray<{ pageId: string; text: string }>,
  limit = 50,
): SearchResult[] {
  const needle = normalise(query.trim());
  if (!needle) return [];

  const titleMatches: SearchResult[] = [];
  const matchedPages = new Set<string>();
  for (const page of pages) {
    const index = normalise(page.title).indexOf(needle);
    if (index < 0) continue;
    matchedPages.add(page.id);
    titleMatches.push({ pageId: page.id, source: 'title', snippet: page.title, matchStart: index, matchLength: needle.length });
  }

  const knownPages = new Set(pages.map((page) => page.id));
  const textMatches: SearchResult[] = [];
  for (const entry of texts) {
    if (matchedPages.has(entry.pageId) || !knownPages.has(entry.pageId)) continue;
    const index = normalise(entry.text).indexOf(needle);
    if (index < 0) continue;
    matchedPages.add(entry.pageId);
    textMatches.push({ pageId: entry.pageId, source: 'text', ...excerpt(entry.text, index, needle.length) });
  }

  return titleMatches.concat(textMatches).slice(0, limit);
}
