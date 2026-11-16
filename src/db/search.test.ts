import { describe, expect, it } from 'vitest';
import type { Page } from '../types';
import { searchPages } from './search';

function page(id: string, title: string): Page {
  return {
    id,
    sectionId: 's',
    title,
    order: 1,
    depth: 0,
    background: 'blank',
    camera: { x: 0, y: 0, zoom: 1 },
    createdAt: 0,
    updatedAt: 0,
  };
}

const pages = [page('p1', 'Meeting notes'), page('p2', 'Groceries'), page('p3', 'Ideas')];
const texts = [
  { pageId: 'p2', text: 'Buy oat milk\nand two lemons for the weekly meeting snack' },
  { pageId: 'p3', text: 'Build a kite' },
  { pageId: 'gone', text: 'meeting on a deleted page' },
];

describe('searchPages', () => {
  it('returns nothing for an empty query', () => {
    expect(searchPages('   ', pages, texts)).toEqual([]);
  });

  it('matches titles case-insensitively and lists them first', () => {
    const results = searchPages('MEETING', pages, texts);
    expect(results.map((r) => [r.pageId, r.source])).toEqual([
      ['p1', 'title'],
      ['p2', 'text'],
    ]);
    expect(results[0].snippet.slice(results[0].matchStart, results[0].matchStart + results[0].matchLength)).toBe('Meeting');
  });

  it('returns a snippet that highlights the matched text', () => {
    const [result] = searchPages('lemons', pages, texts);
    expect(result.pageId).toBe('p2');
    expect(result.snippet).not.toContain('\n');
    expect(result.snippet.slice(result.matchStart, result.matchStart + result.matchLength)).toBe('lemons');
  });

  it('returns one result per page and ignores text from unknown pages', () => {
    const results = searchPages('i', pages, [...texts, { pageId: 'p3', text: 'kites again' }]);
    expect(new Set(results.map((r) => r.pageId)).size).toBe(results.length);
    expect(results.some((r) => r.pageId === 'gone')).toBe(false);
  });
});
