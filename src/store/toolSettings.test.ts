import { describe, expect, it } from 'vitest';
import { readTools } from './toolSettings';

describe('loading saved tool settings', () => {
  it('loads settings saved before lasso modes and custom colours existed', () => {
    // Exactly what the previous version stored.
    const old = { tool: 'lasso', penColor: '#e03131', penSize: 4, highlighterColor: '#9cf08f', highlighterSize: 26 };
    expect(readTools(old)).toEqual({ ...old, lassoMode: 'freeform' });
  });

  it('keeps a chosen lasso mode and custom colours', () => {
    const saved = readTools({ tool: 'pen', lassoMode: 'rectangle', penColor: '#0CA678', highlighterColor: '#123456' });
    expect(saved.lassoMode).toBe('rectangle');
    expect(saved.penColor).toBe('#0ca678');
    expect(saved.highlighterColor).toBe('#123456');
  });

  it('falls back to defaults for anything missing or invalid', () => {
    const saved = readTools({ tool: 'magic', lassoMode: 'circle', penColor: 'tomato', penSize: -3 });
    expect(saved.tool).toBe('pen');
    expect(saved.lassoMode).toBe('freeform');
    expect(saved.penColor).toBe('#000000');
    expect(saved.penSize).toBe(2.5);
    expect(readTools(null)).toEqual(readTools({}));
  });
});
