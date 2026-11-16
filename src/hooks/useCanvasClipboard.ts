import { useEffect } from 'react';
import { useAppStore } from '../store/appStore';
import {
  copyToClipboardEvent,
  duplicateObjects,
  pasteFromClipboardEvent,
  removeObjects,
} from '../store/canvasActions';
import { getActiveEngine } from '../store/engineRegistry';
import { isTyping } from './useToolShortcuts';

/** Whether the canvas, rather than a text field or a dialog, should react to a clipboard shortcut. */
function canvasHasKeyboard(target: EventTarget | null): boolean {
  if (isTyping(target) || isTyping(document.activeElement)) return false;
  const state = useAppStore.getState();
  return state.activePageId !== null && state.confirmRequest === null;
}

/** True while the user has ordinary page text selected (e.g. in the sidebar), which copy should then use. */
function hasTextSelection(): boolean {
  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed;
}

/**
 * Ctrl/Cmd + C, X, V and D on the canvas. Copy, cut and paste are handled
 * through the browser's clipboard events (not key presses), which is what
 * gives access to the system clipboard without asking for permission.
 */
export function useCanvasClipboard(): void {
  useEffect(() => {
    const onCopyOrCut = (event: ClipboardEvent) => {
      const engine = getActiveEngine();
      if (!engine) return;
      // A menu command triggers this event itself; a key press only counts when the canvas has the keyboard.
      const fromKeyboard = canvasHasKeyboard(event.target) && !hasTextSelection();
      const copied = copyToClipboardEvent(event, fromKeyboard ? engine.selectedObjects() : { strokes: [], images: [], textBoxes: [] });
      if (copied && event.type === 'cut') removeObjects(copied);
    };
    const onPaste = (event: ClipboardEvent) => {
      if (!canvasHasKeyboard(event.target)) return;
      if (pasteFromClipboardEvent(event)) event.preventDefault();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'd' || !canvasHasKeyboard(event.target)) return;
      const engine = getActiveEngine();
      if (!engine || !engine.hasSelection) return;
      // Otherwise the browser would bookmark the page.
      event.preventDefault();
      duplicateObjects(engine.selectedObjects());
    };
    document.addEventListener('copy', onCopyOrCut);
    document.addEventListener('cut', onCopyOrCut);
    document.addEventListener('paste', onPaste);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('copy', onCopyOrCut);
      document.removeEventListener('cut', onCopyOrCut);
      document.removeEventListener('paste', onPaste);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}
