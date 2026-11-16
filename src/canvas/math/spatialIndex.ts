/**
 * Uniform grid spatial hash.
 *
 * Items are registered in every grid cell their bounding box overlaps, so a
 * viewport query only touches the cells under the viewport instead of every
 * stroke on the page. Items whose bounds would span an excessive number of
 * cells are kept in a small overflow set that every query checks.
 */
import type { Rect } from './geometry';
import { rectsIntersect } from './geometry';

const CELL_OFFSET = 1 << 25;
const CELL_SPAN = 1 << 26;
const MAX_CELLS_PER_ITEM = 1024;

interface Entry {
  bounds: Rect;
  minCx: number;
  minCy: number;
  maxCx: number;
  maxCy: number;
  oversized: boolean;
}

function cellKey(cx: number, cy: number): number {
  // Two 26-bit lanes packed into one exactly-representable double.
  return (cx + CELL_OFFSET) * CELL_SPAN + (cy + CELL_OFFSET);
}

export class SpatialGrid<T> {
  private readonly cells = new Map<number, Set<T>>();
  private readonly entries = new Map<T, Entry>();
  private readonly oversized = new Set<T>();

  constructor(readonly cellSize = 256) {
    if (!(cellSize > 0)) throw new Error('SpatialGrid cell size must be positive');
  }

  get size(): number {
    return this.entries.size;
  }

  has(item: T): boolean {
    return this.entries.has(item);
  }

  clear(): void {
    this.cells.clear();
    this.entries.clear();
    this.oversized.clear();
  }

  insert(item: T, bounds: Rect): void {
    if (this.entries.has(item)) this.remove(item);
    const minCx = this.cellCoord(bounds.minX);
    const minCy = this.cellCoord(bounds.minY);
    const maxCx = this.cellCoord(bounds.maxX);
    const maxCy = this.cellCoord(bounds.maxY);
    const cellCount = (maxCx - minCx + 1) * (maxCy - minCy + 1);
    const oversized = !(cellCount <= MAX_CELLS_PER_ITEM);
    this.entries.set(item, { bounds: { ...bounds }, minCx, minCy, maxCx, maxCy, oversized });
    if (oversized) {
      this.oversized.add(item);
      return;
    }
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const key = cellKey(cx, cy);
        let cell = this.cells.get(key);
        if (!cell) {
          cell = new Set<T>();
          this.cells.set(key, cell);
        }
        cell.add(item);
      }
    }
  }

  remove(item: T): boolean {
    const entry = this.entries.get(item);
    if (!entry) return false;
    this.entries.delete(item);
    if (entry.oversized) {
      this.oversized.delete(item);
      return true;
    }
    for (let cx = entry.minCx; cx <= entry.maxCx; cx++) {
      for (let cy = entry.minCy; cy <= entry.maxCy; cy++) {
        const key = cellKey(cx, cy);
        const cell = this.cells.get(key);
        if (!cell) continue;
        cell.delete(item);
        if (cell.size === 0) this.cells.delete(key);
      }
    }
    return true;
  }

  update(item: T, bounds: Rect): void {
    this.insert(item, bounds);
  }

  /** Returns every item whose bounding box intersects `rect` (each item once, unordered). */
  query(rect: Rect): T[] {
    const result: T[] = [];
    if (this.entries.size === 0) return result;
    const minCx = this.cellCoord(rect.minX);
    const minCy = this.cellCoord(rect.minY);
    const maxCx = this.cellCoord(rect.maxX);
    const maxCy = this.cellCoord(rect.maxY);
    const cellCount = (maxCx - minCx + 1) * (maxCy - minCy + 1);

    // When the query covers more cells than exist, scanning the items is cheaper.
    if (!(cellCount <= this.cells.size)) {
      for (const [item, entry] of this.entries) {
        if (rectsIntersect(entry.bounds, rect)) result.push(item);
      }
      return result;
    }

    const seen = new Set<T>();
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const cell = this.cells.get(cellKey(cx, cy));
        if (!cell) continue;
        for (const item of cell) {
          if (seen.has(item)) continue;
          seen.add(item);
          if (rectsIntersect(this.entries.get(item)!.bounds, rect)) result.push(item);
        }
      }
    }
    for (const item of this.oversized) {
      if (rectsIntersect(this.entries.get(item)!.bounds, rect)) result.push(item);
    }
    return result;
  }

  private cellCoord(value: number): number {
    const c = Math.floor(value / this.cellSize);
    const limit = CELL_OFFSET - 1;
    return c < -limit ? -limit : c > limit ? limit : c;
  }
}
