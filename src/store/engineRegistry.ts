/**
 * Handle to the mounted canvas engine so UI outside the canvas (toolbar
 * buttons, text boxes) can call it without the engine ever living in React
 * state.
 */
import type { CanvasEngine } from '../canvas/CanvasEngine';

let activeEngine: CanvasEngine | null = null;

export function setActiveEngine(engine: CanvasEngine | null): void {
  activeEngine = engine;
}

export function getActiveEngine(): CanvasEngine | null {
  return activeEngine;
}
