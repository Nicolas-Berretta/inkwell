import { describe, expect, it } from 'vitest';
import type { Page } from '../types';
import { moveItem, normalizePageList, pagesOfSection } from './pageTree';

function page(id: string, order: number, depth: number, sectionId = 's1'): Page {
  return {
    id,
    sectionId,
    title: id,
    order,
    depth,
    background: 'blank',
    camera: { x: 0, y: 0, zoom: 1 },
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('page outline helpers', () => {
  it('lists the pages of a section in order', () => {
    const pages = [page('b', 2, 0), page('x', 1, 0, 's2'), page('a', 1, 0)];
    expect(pagesOfSection(pages, 's1').map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('renumbers pages and reports only the ones that changed', () => {
    const { pages, changed } = normalizePageList([page('a', 1, 0), page('b', 5, 1), page('c', 3, 1)], 99);
    expect(pages.map((p) => p.order)).toEqual([1, 2, 3]);
    expect(changed.map((p) => p.id)).toEqual(['b']);
    expect(changed[0].updatedAt).toBe(99);
  });

  it('repairs indentation so the outline is always valid', () => {
    const { pages } = normalizePageList([page('a', 1, 2), page('b', 2, 2), page('c', 3, 7), page('d', 4, 0)]);
    expect(pages.map((p) => p.depth)).toEqual([0, 1, 2, 0]);
  });

  it('moves an item to the requested final index', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveItem(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
  });
});
