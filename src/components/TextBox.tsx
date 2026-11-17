import type { JSONContent } from '@tiptap/core';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import type { Editor } from '@tiptap/react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { GripVertical } from 'lucide-react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { registerFlusher } from '../db/persistence';
import { useAppStore } from '../store/appStore';
import { getActiveEngine } from '../store/engineRegistry';
import type { TextBoxRecord } from '../types';
import { FormatBar } from './FormatBar';

const EXTENSIONS = [StarterKit, TaskList, TaskItem.configure({ nested: true })];
/** Typing is saved this long after the first unsaved key press, and immediately when the box loses focus. */
const SAVE_DELAY_MS = 250;
const MIN_WIDTH = 140;
const MAX_WIDTH = 1600;

interface TextBoxProps {
  box: TextBoxRecord;
  autoFocus: boolean;
}

interface DragState {
  mode: 'move' | 'resize';
  pointerId: number;
  startClientX: number;
  startClientY: number;
  originX: number;
  originY: number;
  originWidth: number;
  x: number;
  y: number;
  width: number;
}

/**
 * A rich-text container positioned in world coordinates. The surrounding text
 * layer carries the camera transform, so the box pans and zooms with the page
 * without re-rendering.
 */
export const TextBox = memo(function TextBox({ box, autoFocus }: TextBoxProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const [focused, setFocused] = useState(false);
  const boxId = box.id;

  const saveNow = useCallback(() => {
    const instance = editorRef.current;
    if (saveTimerRef.current === null) return;
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    if (!instance || instance.isDestroyed) return;
    useAppStore.getState().updateTextBox(boxId, {
      content: instance.getJSON(),
      plainText: instance.getText({ blockSeparator: '\n' }).trim(),
    });
  }, [boxId]);

  const editor = useEditor({
    extensions: EXTENSIONS,
    content: box.content as JSONContent,
    editorProps: {
      attributes: { class: 'text-box-editor', spellcheck: 'true' },
      handleKeyDown: (view, event) => {
        if (event.key !== 'Escape') return false;
        (view.dom as HTMLElement).blur();
        return true;
      },
    },
    onUpdate: ({ editor: instance }) => {
      editorRef.current = instance;
      if (saveTimerRef.current === null) saveTimerRef.current = window.setTimeout(saveNow, SAVE_DELAY_MS);
    },
    onFocus: () => setFocused(true),
    onBlur: ({ editor: instance }) => {
      editorRef.current = instance;
      setFocused(false);
      saveNow();
      // A container the user never typed into (or emptied) does not stay on the page.
      if (instance.getText().trim().length === 0) useAppStore.getState().removeTextBox(boxId);
    },
  });

  // Make sure a pending debounced edit is written when the tab is hidden or the page changes.
  useEffect(() => registerFlusher(saveNow), [saveNow]);

  useEffect(() => {
    if (!autoFocus || !editor) return;
    editor.commands.focus('end');
    useAppStore.getState().clearTextBoxFocusRequest(boxId);
  }, [autoFocus, boxId, editor]);

  const beginDrag = (mode: DragState['mode']) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      mode,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      originX: box.x,
      originY: box.y,
      originWidth: box.width,
      x: box.x,
      y: box.y,
      width: box.width,
    };
  };

  const onDragMove = (e: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    const root = rootRef.current;
    if (!drag || !root || drag.pointerId !== e.pointerId) return;
    // Screen deltas become world deltas by dividing by the live zoom.
    const zoom = getActiveEngine()?.getCamera().zoom ?? 1;
    const dx = (e.clientX - drag.startClientX) / zoom;
    const dy = (e.clientY - drag.startClientY) / zoom;
    if (drag.mode === 'move') {
      drag.x = Math.round(drag.originX + dx);
      drag.y = Math.round(drag.originY + dy);
      root.style.left = `${drag.x}px`;
      root.style.top = `${drag.y}px`;
    } else {
      drag.width = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, drag.originWidth + dx)));
      root.style.width = `${drag.width}px`;
    }
  };

  const endDrag = (e: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const store = useAppStore.getState();
    if (drag.mode === 'move') {
      if (drag.x !== drag.originX || drag.y !== drag.originY) store.updateTextBox(boxId, { x: drag.x, y: drag.y });
    } else if (drag.width !== drag.originWidth) {
      store.updateTextBox(boxId, { width: drag.width });
    }
  };

  return (
    <div
      ref={rootRef}
      className={focused ? 'text-box is-focused' : 'text-box'}
      data-text-box={boxId}
      style={{ left: box.x, top: box.y, width: box.width }}
    >
      {/* preventDefault on mousedown keeps the editor focused while its chrome is used. */}
      <div className="text-box-chrome" onMouseDown={(e) => e.preventDefault()}>
        <button
          type="button"
          className="text-box-grip"
          aria-label="Move text box"
          title="Drag to move"
          onPointerDown={beginDrag('move')}
          onPointerMove={onDragMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <GripVertical size={14} />
        </button>
        {focused && editor ? <FormatBar editor={editor} /> : null}
      </div>
      <EditorContent editor={editor} />
      <div
        className="text-box-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize text box"
        title="Drag to resize"
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={beginDrag('resize')}
        onPointerMove={onDragMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
    </div>
  );
});
