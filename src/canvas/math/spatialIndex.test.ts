import { describe, expect, it } from 'vitest';
import type { Rect } from './geometry';
import { rectsIntersect } from './geometry';
import { SpatialGrid } from './spatialIndex';

const rect = (minX: number, minY: number, maxX: number, maxY: number): Rect => ({ minX, minY, maxX, maxY });

describe('SpatialGrid', () => {
  it('finds items by overlap and returns each item once', () => {
    const grid = new SpatialGrid<string>(100);
    grid.insert('spanning', rect(50, 50, 450, 150));
    grid.insert('far', rect(1000, 1000, 1010, 1010));
    expect(grid.query(rect(0, 0, 500, 500))).toEqual(['spanning']);
    expect(grid.query(rect(900, 900, 1100, 1100))).toEqual(['far']);
    expect(grid.query(rect(600, 600, 700, 700))).toEqual([]);
  });

  it('filters by the real bounds, not just the shared cell', () => {
    const grid = new SpatialGrid<string>(100);
    grid.insert('a', rect(10, 10, 20, 20));
    expect(grid.query(rect(60, 60, 90, 90))).toEqual([]);
  });

  it('handles negative coordinates', () => {
    const grid = new SpatialGrid<string>(64);
    grid.insert('neg', rect(-500, -300, -480, -290));
    expect(grid.query(rect(-490, -295, -100, -100))).toEqual(['neg']);
    expect(grid.query(rect(480, 290, 500, 300))).toEqual([]);
  });

  it('removes and updates items', () => {
    const grid = new SpatialGrid<string>(100);
    grid.insert('a', rect(0, 0, 10, 10));
    grid.update('a', rect(500, 500, 510, 510));
    expect(grid.query(rect(0, 0, 50, 50))).toEqual([]);
    expect(grid.query(rect(490, 490, 520, 520))).toEqual(['a']);
    expect(grid.remove('a')).toBe(true);
    expect(grid.remove('a')).toBe(false);
    expect(grid.size).toBe(0);
    expect(grid.query(rect(490, 490, 520, 520))).toEqual([]);
  });

  it('keeps enormous items queryable', () => {
    const grid = new SpatialGrid<string>(10);
    grid.insert('huge', rect(-50000, -50000, 50000, 50000));
    grid.insert('small', rect(0, 0, 5, 5));
    expect(grid.query(rect(1000, 1000, 1001, 1001))).toEqual(['huge']);
    expect(grid.query(rect(1, 1, 2, 2)).sort()).toEqual(['huge', 'small']);
    grid.remove('huge');
    expect(grid.query(rect(1000, 1000, 1001, 1001))).toEqual([]);
  });

  it('matches a brute-force scan on random data', () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const grid = new SpatialGrid<number>(128);
    const all: Rect[] = [];
    for (let i = 0; i < 600; i++) {
      const x = random() * 6000 - 3000;
      const y = random() * 6000 - 3000;
      const r = rect(x, y, x + random() * 400, y + random() * 400);
      all.push(r);
      grid.insert(i, r);
    }
    for (let q = 0; q < 40; q++) {
      const x = random() * 6000 - 3000;
      const y = random() * 6000 - 3000;
      const query = rect(x, y, x + random() * 1500, y + random() * 1500);
      const expected = all.map((r, i) => (rectsIntersect(r, query) ? i : -1)).filter((i) => i >= 0);
      expect(grid.query(query).sort((a, b) => a - b)).toEqual(expected);
    }
  });
});
