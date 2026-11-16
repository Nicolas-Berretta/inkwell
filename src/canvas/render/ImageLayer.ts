/**
 * The images of the current page. Each image is an `<img>` inside a layer that
 * carries the camera as one CSS transform (exactly like the text layer), so
 * images pan and zoom with the page without any per-frame work and the
 * browser resamples them sharply at every zoom level.
 *
 * The layer sits below the ink canvases: ink and highlighter are drawn on top
 * of images. It never receives pointer events; the engine hit-tests images
 * itself. Images outside the viewport are hidden so they cost nothing.
 */
import type { CameraState, ImageEntry, ImageRecord } from '../../types';
import type { Rect } from '../math/geometry';
import { rectsIntersect } from '../math/geometry';
import type { Box } from '../math/imageGeometry';
import { boxContainsPoint } from '../math/imageGeometry';

export interface ImageItem {
  record: ImageRecord;
  blob: Blob;
  /** Object URL of `blob`, revoked when the image leaves the layer. */
  url: string;
  element: HTMLDivElement;
  /** Geometry currently shown; differs from the record while the image is being dragged or resized. */
  shown: Box;
  culled: boolean;
}

const LOCK_ICON =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';

function recordBox(record: ImageRecord): Box {
  return { x: record.x, y: record.y, width: record.width, height: record.height };
}

export class ImageLayer {
  private readonly items = new Map<string, ImageItem>();

  constructor(private readonly root: HTMLElement) {}

  get size(): number {
    return this.items.size;
  }

  /** Replaces the whole content (page switch). */
  load(entries: readonly ImageEntry[]): void {
    this.clear();
    for (const entry of entries) this.add(entry);
  }

  clear(): void {
    for (const item of this.items.values()) this.dispose(item);
    this.items.clear();
  }

  get(id: string): ImageItem | undefined {
    return this.items.get(id);
  }

  all(): ImageItem[] {
    return [...this.items.values()];
  }

  /** Stacking order for an image placed in front of / behind every existing one. */
  frontOrder(): number {
    let order = 0;
    for (const item of this.items.values()) order = Math.max(order, item.record.order);
    return order + 1;
  }

  backOrder(): number {
    let order = 0;
    for (const item of this.items.values()) order = Math.min(order, item.record.order);
    return order - 1;
  }

  add(entry: ImageEntry): ImageItem {
    const existing = this.items.get(entry.record.id);
    if (existing) {
      this.dispose(existing);
      this.items.delete(entry.record.id);
    }
    const element = document.createElement('div');
    element.className = 'canvas-image';
    element.dataset.imageId = entry.record.id;
    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    img.decoding = 'async';
    img.addEventListener('error', () => element.classList.add('is-broken'));
    const url = URL.createObjectURL(entry.blob);
    img.src = url;
    const badge = document.createElement('span');
    badge.className = 'canvas-image-lock';
    badge.title = 'Locked';
    badge.innerHTML = LOCK_ICON;
    element.append(img, badge);

    const item: ImageItem = { record: entry.record, blob: entry.blob, url, element, shown: recordBox(entry.record), culled: false };
    this.items.set(entry.record.id, item);
    this.apply(item);
    this.root.appendChild(element);
    return item;
  }

  remove(id: string): ImageEntry | undefined {
    const item = this.items.get(id);
    if (!item) return undefined;
    this.items.delete(id);
    this.dispose(item);
    return { record: item.record, blob: item.blob };
  }

  /** Replaces an image's record (moved, resized, locked, restacked). */
  update(record: ImageRecord): void {
    const item = this.items.get(record.id);
    if (!item) return;
    item.record = record;
    item.shown = recordBox(record);
    this.apply(item);
  }

  /** Shows an image at a temporary position / size while it is dragged; `null` returns to the record. */
  preview(id: string, box: Box | null): void {
    const item = this.items.get(id);
    if (!item) return;
    item.shown = box ?? recordBox(item.record);
    this.apply(item);
  }

  /** Topmost image under a world position. */
  topAt(x: number, y: number, includeLocked: boolean): ImageItem | null {
    let top: ImageItem | null = null;
    for (const item of this.items.values()) {
      if (item.record.locked && !includeLocked) continue;
      if (!boxContainsPoint(recordBox(item.record), x, y)) continue;
      if (!top || item.record.order > top.record.order) top = item;
    }
    return top;
  }

  setCamera(camera: CameraState): void {
    this.root.style.transform = `translate(${-camera.x * camera.zoom}px, ${-camera.y * camera.zoom}px) scale(${camera.zoom})`;
    this.root.style.setProperty('--inv-zoom', String(1 / camera.zoom));
  }

  /** Hides every image that does not intersect the visible world rectangle. */
  cull(view: Rect): void {
    for (const item of this.items.values()) {
      const box = item.shown;
      const visible = rectsIntersect(view, { minX: box.x, minY: box.y, maxX: box.x + box.width, maxY: box.y + box.height });
      if (visible === item.culled) {
        item.culled = !visible;
        item.element.hidden = !visible;
      }
    }
  }

  private apply(item: ImageItem): void {
    const { element, shown, record } = item;
    element.style.left = `${shown.x}px`;
    element.style.top = `${shown.y}px`;
    element.style.width = `${shown.width}px`;
    element.style.height = `${shown.height}px`;
    element.style.zIndex = String(record.order);
    element.classList.toggle('is-locked', record.locked);
  }

  private dispose(item: ImageItem): void {
    item.element.remove();
    URL.revokeObjectURL(item.url);
  }
}
