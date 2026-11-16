/**
 * In-memory model of the strokes on the current page: the records themselves
 * plus cached per-stroke render data (bounds, lazily built `Path2D`) and one
 * spatial index per ink layer.
 */
import type { StrokeRecord, StrokeTool } from '../../types';
import type { Rect } from '../math/geometry';
import { translateRect } from '../math/geometry';
import { SpatialGrid } from '../math/spatialIndex';
import { strokeInkBounds, strokeWidthStats, translatePoints } from '../math/strokeGeometry';
import { buildStrokePath } from './strokePath';

export interface StrokeItem {
  record: StrokeRecord;
  /** World-space bounds of the inked area. */
  bounds: Rect;
  /** Fill path in coordinates relative to (`originX`, `originY`); built on first draw. */
  path: Path2D | null;
  originX: number;
  originY: number;
  maxWidth: number;
  averageWidth: number;
  /** Hidden items are skipped by the ink layers (e.g. while being dragged on the live layer). */
  hidden: boolean;
  lastUsedFrame: number;
}

/** Upper bound on simultaneously cached paths; least recently drawn ones are dropped beyond it. */
const MAX_CACHED_PATHS = 12000;

export class StrokeModel {
  private readonly items = new Map<string, StrokeItem>();
  private readonly grids: Record<StrokeTool, SpatialGrid<StrokeItem>> = {
    pen: new SpatialGrid<StrokeItem>(256),
    highlighter: new SpatialGrid<StrokeItem>(256),
  };
  private maxOrder = 0;
  private cachedPaths = 0;
  private frame = 0;

  get size(): number {
    return this.items.size;
  }

  load(records: readonly StrokeRecord[]): void {
    this.items.clear();
    this.grids.pen.clear();
    this.grids.highlighter.clear();
    this.maxOrder = 0;
    this.cachedPaths = 0;
    for (const record of records) this.add(record);
  }

  get(id: string): StrokeItem | undefined {
    return this.items.get(id);
  }

  /** Paint order for the next new stroke (always on top of everything existing). */
  nextOrder(): number {
    return this.maxOrder + 1;
  }

  add(record: StrokeRecord): StrokeItem {
    const existing = this.items.get(record.id);
    if (existing) this.remove(record.id);
    const bounds = strokeInkBounds(record.points, record.shape);
    const stats = strokeWidthStats(record.points);
    const item: StrokeItem = {
      record,
      bounds,
      path: null,
      originX: bounds.minX,
      originY: bounds.minY,
      maxWidth: stats.max,
      averageWidth: stats.average,
      hidden: false,
      lastUsedFrame: 0,
    };
    this.items.set(record.id, item);
    this.grids[record.tool].insert(item, bounds);
    if (record.order > this.maxOrder) this.maxOrder = record.order;
    return item;
  }

  remove(id: string): StrokeItem | undefined {
    const item = this.items.get(id);
    if (!item) return undefined;
    this.items.delete(id);
    this.grids[item.record.tool].remove(item);
    if (item.path) {
      item.path = null;
      this.cachedPaths--;
    }
    return item;
  }

  /** Moves a stroke. The cached path is reused because it is origin-relative. */
  translate(item: StrokeItem, dx: number, dy: number): void {
    item.record = { ...item.record, points: translatePoints(item.record.points, dx, dy) };
    item.bounds = translateRect(item.bounds, dx, dy);
    item.originX += dx;
    item.originY += dy;
    this.grids[item.record.tool].update(item, item.bounds);
  }

  query(tool: StrokeTool, rect: Rect): StrokeItem[] {
    return this.grids[tool].query(rect);
  }

  queryAll(rect: Rect): StrokeItem[] {
    return this.grids.pen.query(rect).concat(this.grids.highlighter.query(rect));
  }

  /** Returns the item's fill path, building and caching it on first use. */
  pathFor(item: StrokeItem): Path2D {
    item.lastUsedFrame = this.frame;
    if (!item.path) {
      item.path = buildStrokePath(item.record.points, item.originX, item.originY, item.record.shape);
      this.cachedPaths++;
    }
    return item.path;
  }

  beginFrame(): void {
    this.frame++;
  }

  /** Releases paths that were not drawn this frame once the cache grows past its budget. */
  trimPathCache(): void {
    if (this.cachedPaths <= MAX_CACHED_PATHS) return;
    for (const item of this.items.values()) {
      if (item.path && item.lastUsedFrame < this.frame) {
        item.path = null;
        this.cachedPaths--;
      }
    }
  }
}
