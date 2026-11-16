/**
 * Turns an image file (picked, dropped or pasted) into what is stored on a
 * page: its pixel size and a Blob that is small enough to keep.
 *
 * Images are stored as they are whenever possible. They are re-encoded only
 * when the longest side exceeds `MAX_IMAGE_DIMENSION` pixels (scaled down to
 * that), when the file is larger than `MAX_IMAGE_BYTES`, or when the format
 * is uncompressed (BMP), so a single photo cannot bloat the database.
 */
import { IMAGE_MIME_TYPES } from '../types';
import { MAX_IMAGE_BYTES, storedImageSize } from './math/imageGeometry';

export interface PreparedImage {
  blob: Blob;
  /** Pixel size of `blob`. */
  width: number;
  height: number;
}

/** Raised when a file cannot be used as an image; `message` is safe to show to the user. */
export class ImageImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageImportError';
  }
}

const JPEG_QUALITY = 0.9;
const WEBP_QUALITY = 0.92;

export function isSupportedImageType(type: string): boolean {
  return IMAGE_MIME_TYPES.includes(type);
}

function encode(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function prepareImage(file: Blob): Promise<PreparedImage> {
  if (!isSupportedImageType(file.type)) {
    throw new ImageImportError('Only PNG, JPEG, WebP, GIF, BMP and AVIF images can be inserted.');
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ImageImportError('The image could not be read. The file may be damaged.');
  }
  try {
    const { width, height } = bitmap;
    if (width < 1 || height < 1) throw new ImageImportError('The image is empty.');
    const stored = storedImageSize(width, height);
    const scaled = stored.width !== width || stored.height !== height;
    if (!scaled && file.size <= MAX_IMAGE_BYTES && file.type !== 'image/bmp') {
      return { blob: file, width, height };
    }

    const canvas = document.createElement('canvas');
    canvas.width = stored.width;
    canvas.height = stored.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new ImageImportError('The image could not be processed.');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, stored.width, stored.height);
    // Photos stay JPEG; everything else becomes WebP, which keeps transparency
    // (browsers that cannot encode WebP fall back to PNG by themselves).
    const encoded =
      file.type === 'image/jpeg'
        ? await encode(canvas, 'image/jpeg', JPEG_QUALITY)
        : await encode(canvas, 'image/webp', WEBP_QUALITY);
    if (!encoded || !isSupportedImageType(encoded.type)) throw new ImageImportError('The image could not be processed.');
    // Re-encoding at the same size is only worth keeping when it actually saved space.
    if (!scaled && encoded.size >= file.size) return { blob: file, width, height };
    return { blob: encoded, width: stored.width, height: stored.height };
  } finally {
    bitmap.close();
  }
}
