import { useEffect } from 'react';
import { useAppStore } from '../store/appStore';
import type { ToolId } from '../types';

const TOOL_KEYS: Record<string, ToolId> = {
  p: 'pen',
  h: 'highlighter',
  e: 'eraser',
  l: 'lasso',
  t: 'text',
  v: 'pan',
};

/** True when keyboard input is going into a text field or a rich-text editor. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

/** Single-letter tool shortcuts, active whenever the user is not typing. */
export function useToolShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      const tool = TOOL_KEYS[e.key.toLowerCase()];
      if (!tool) return;
      e.preventDefault();
      useAppStore.getState().setTool(tool);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
