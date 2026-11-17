/**
 * Tool settings: defaults and loading of what was persisted. Pure and
 * DOM-free, so settings written by any earlier version can be checked in tests.
 */
import type { ToolId, ToolSettings } from '../types';
import { HIGHLIGHTER_FAVORITES, PEN_FAVORITES, normalizeHexColor } from './palette';

export const PEN_SIZES: readonly number[] = [1.5, 2.5, 4, 6.5];
export const HIGHLIGHTER_SIZES: readonly number[] = [12, 18, 26];

export const DEFAULT_TOOLS: ToolSettings = {
  tool: 'pen',
  lassoMode: 'freeform',
  penColor: PEN_FAVORITES[0],
  penSize: PEN_SIZES[1],
  highlighterColor: HIGHLIGHTER_FAVORITES[0],
  highlighterSize: HIGHLIGHTER_SIZES[1],
};

const TOOL_IDS: readonly ToolId[] = ['pen', 'highlighter', 'eraser', 'lasso', 'text', 'pan'];

/** Reads persisted tool settings, filling in anything missing or invalid with defaults. */
export function readTools(value: unknown): ToolSettings {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_TOOLS };
  const raw = value as Partial<Record<keyof ToolSettings, unknown>>;
  const positive = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);
  // Any hex colour is allowed now that custom colours exist; anything else falls back to the default.
  const color = (v: unknown, fallback: string) => normalizeHexColor(v) ?? fallback;
  return {
    tool: TOOL_IDS.includes(raw.tool as ToolId) ? (raw.tool as ToolId) : DEFAULT_TOOLS.tool,
    // Settings saved before the rectangle lasso existed have no mode: they keep the freeform lasso.
    lassoMode: raw.lassoMode === 'rectangle' ? 'rectangle' : 'freeform',
    penColor: color(raw.penColor, DEFAULT_TOOLS.penColor),
    penSize: positive(raw.penSize, DEFAULT_TOOLS.penSize),
    highlighterColor: color(raw.highlighterColor, DEFAULT_TOOLS.highlighterColor),
    highlighterSize: positive(raw.highlighterSize, DEFAULT_TOOLS.highlighterSize),
  };
}

