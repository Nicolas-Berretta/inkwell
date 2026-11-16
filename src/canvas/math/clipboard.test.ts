import { describe, expect, it } from 'vitest';
import type { ImageEntry, ObjectSet, StrokeRecord, TextBoxRecord } from '../../types';
import {
  choosePasteSource,
  cloneObjectSet,
  emptyObjectSet,
  isEmptyObjectSet,
  objectSetBounds,
  rememberPaste,
  textToDocument,
} from './clipboard';

const internal = { token: 'copy-1', text: '' };

describe('choosing what a paste inserts', () => {
  it('pastes what was copied in the app while the system clipboard still carries its marker', () => {
    expect(choosePasteSource(internal, { marker: 'copy-1', hasImage: false, text: null })).toBe('internal');
    // Even alongside other formats written by the same copy.
    expect(choosePasteSource({ token: 'copy-1', text: 'note' }, { marker: 'copy-1', hasImage: false, text: 'note' })).toBe('internal');
  });

  it('lets a newer system copy win over an older copy made in the app', () => {
    // A screenshot taken after copying strokes: the marker is gone, an image is there.
    expect(choosePasteSource(internal, { marker: null, hasImage: true, text: null })).toBe('image');
    expect(choosePasteSource(internal, { marker: null, hasImage: false, text: 'from elsewhere' })).toBe('text');
    // A marker from an earlier copy does not count.
    expect(choosePasteSource(internal, { marker: 'copy-0', hasImage: true, text: null })).toBe('image');
  });

  it('prefers an image over text when the system clipboard has both', () => {
    expect(choosePasteSource(null, { marker: null, hasImage: true, text: 'caption' })).toBe('image');
  });

  it('recognises its own copy by the copied text when the browser dropped the marker', () => {
    const copied = { token: 'copy-2', text: 'Meeting notes' };
    expect(choosePasteSource(copied, { marker: null, hasImage: false, text: 'Meeting notes' })).toBe('internal');
    expect(choosePasteSource(copied, { marker: null, hasImage: false, text: 'Other text' })).toBe('text');
  });

  it('falls back to the app clipboard when the system clipboard is empty or unreadable', () => {
    expect(choosePasteSource(internal, null)).toBe('internal');
    expect(choosePasteSource(internal, { marker: null, hasImage: false, text: null })).toBe('internal');
    expect(choosePasteSource(internal, { marker: null, hasImage: false, text: '  \n ' })).toBe('internal');
  });

  it('pastes nothing when there is nothing anywhere', () => {
    expect(choosePasteSource(null, null)).toBe('none');
    expect(choosePasteSource(null, { marker: null, hasImage: false, text: '' })).toBe('none');
    expect(choosePasteSource(null, { marker: 'stale', hasImage: false, text: null })).toBe('none');
  });
});

function stroke(id: string, order: number, points: number[]): StrokeRecord {
  return { id, pageId: 'p1', tool: 'pen', color: '#000000', size: 2, points, order };
}

function image(id: string, order: number, locked = false): ImageEntry {
  return {
    blob: new Blob(['pixels'], { type: 'image/png' }),
    record: { id, pageId: 'p1', x: 100, y: 50, width: 200, height: 100, naturalWidth: 400, naturalHeight: 200, locked, order },
  };
}

function textBox(id: string): TextBoxRecord {
  return { id, pageId: 'p1', x: 10, y: 400, width: 300, content: { type: 'doc' }, plainText: 'hello', updatedAt: 1 };
}

function sampleSet(): ObjectSet {
  return {
    strokes: [stroke('s2', 9, [0, 0, 2, 40, 30, 2]), stroke('s1', 4, [10, 10, 4, 20, 20, 4])],
    images: [image('i2', 7, true), image('i1', 3)],
    textBoxes: [textBox('t1')],
  };
}

describe('copying objects for a paste', () => {
  let counter = 0;
  const options = () => ({
    pageId: 'p9',
    dx: 100,
    dy: -20,
    newId: () => `new-${++counter}`,
    firstStrokeOrder: 50,
    firstImageOrder: 20,
    now: 777,
  });

  it('gives every copy a new id on the target page and leaves the originals untouched', () => {
    const original = sampleSet();
    const copy = cloneObjectSet(original, options());
    const ids = [...copy.strokes.map((s) => s.id), ...copy.images.map((i) => i.record.id), ...copy.textBoxes.map((t) => t.id)];
    expect(new Set(ids).size).toBe(5);
    for (const id of ids) expect(id.startsWith('new-')).toBe(true);
    expect(copy.strokes.every((s) => s.pageId === 'p9')).toBe(true);
    expect(copy.images.every((i) => i.record.pageId === 'p9')).toBe(true);
    expect(copy.textBoxes[0].pageId).toBe('p9');
    expect(original).toEqual(sampleSet());
  });

  it('moves everything by the same offset', () => {
    const copy = cloneObjectSet(sampleSet(), options());
    // Copies come out in stacking order: s1 (order 4) before s2 (order 9).
    expect(copy.strokes[0].points).toEqual([110, -10, 4, 120, 0, 4]);
    expect(copy.strokes[1].points).toEqual([100, -20, 2, 140, 10, 2]);
    expect(copy.images[0].record).toMatchObject({ x: 200, y: 30, width: 200, height: 100 });
    expect(copy.textBoxes[0]).toMatchObject({ x: 110, y: 380, width: 300, plainText: 'hello', updatedAt: 777 });
  });

  it('stacks the copies above existing content in their original relative order', () => {
    const copy = cloneObjectSet(sampleSet(), options());
    expect(copy.strokes.map((s) => s.order)).toEqual([50, 51]);
    expect(copy.strokes.map((s) => s.size)).toEqual([2, 2]);
    expect(copy.images.map((i) => i.record.order)).toEqual([20, 21]);
  });

  it('keeps the pixels and unlocks copies of locked images so they can be placed', () => {
    const original = sampleSet();
    const copy = cloneObjectSet(original, options());
    expect(copy.images.map((i) => i.record.locked)).toEqual([false, false]);
    expect(copy.images[1].blob).toBe(original.images[0].blob);
    expect(original.images[0].record.locked).toBe(true);
  });

  it('keeps snapped shapes as shapes', () => {
    const rectangle = { ...stroke('r', 1, [0, 0, 2, 10, 0, 2, 10, 10, 2, 0, 10, 2, 0, 0, 2]), shape: 'rectangle' as const };
    const copy = cloneObjectSet({ strokes: [rectangle], images: [], textBoxes: [] }, options());
    expect(copy.strokes[0].shape).toBe('rectangle');
  });
});

describe('object set helpers', () => {
  it('knows when there is nothing to copy', () => {
    expect(isEmptyObjectSet(emptyObjectSet())).toBe(true);
    expect(isEmptyObjectSet({ strokes: [], images: [], textBoxes: [textBox('t')] })).toBe(false);
  });

  it('measures the bounds of everything in the set', () => {
    const bounds = objectSetBounds(sampleSet(), () => 60);
    // Strokes reach (-1, -1) with their half width, the image reaches x = 300, the text box y = 460.
    expect(bounds).toEqual({ minX: -1, minY: -1, maxX: 310, maxY: 460 });
    expect(objectSetBounds({ strokes: [], images: [], textBoxes: [textBox('t')] }).maxY).toBe(434);
  });
});

describe('repeated pastes', () => {
  it('counts pastes of the same content at the same place', () => {
    let memory = rememberPaste(null, 'copy-1', 100, 100, 2);
    expect(memory.count).toBe(0);
    memory = rememberPaste(memory, 'copy-1', 100, 100, 2);
    expect(memory.count).toBe(1);
    memory = rememberPaste(memory, 'copy-1', 101, 99, 2);
    expect(memory.count).toBe(2);
  });

  it('starts over at a new place or with new content', () => {
    const memory = rememberPaste(rememberPaste(null, 'copy-1', 100, 100, 2), 'copy-1', 100, 100, 2);
    expect(rememberPaste(memory, 'copy-1', 400, 100, 2).count).toBe(0);
    expect(rememberPaste(memory, 'copy-2', 100, 100, 2).count).toBe(0);
  });
});

describe('pasted plain text', () => {
  it('becomes one paragraph per line', () => {
    const { content, plainText } = textToDocument('First line\r\nSecond line\n\nAfter a gap\n');
    expect(plainText).toBe('First line\nSecond line\n\nAfter a gap');
    expect(content).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First line' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second line' }] },
        { type: 'paragraph' },
        { type: 'paragraph', content: [{ type: 'text', text: 'After a gap' }] },
      ],
    });
  });

  it('yields no text for whitespace only', () => {
    expect(textToDocument('  \n\n ').plainText).toBe('');
  });
});
