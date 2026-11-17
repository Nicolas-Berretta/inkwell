import { Minus, Moon, PanelLeft, Plus, Sun } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { getActiveEngine } from '../store/engineRegistry';
import type { PageBackground } from '../types';
import { SaveStatus } from './SaveStatus';

const BACKGROUND_LABELS: Record<PageBackground, string> = {
  blank: 'Blank',
  ruled: 'Ruled',
  college: 'College ruled',
  dots: 'Dot grid',
  grid: 'Grid',
};

const ZOOM_STEP = 1.25;

/** Page header: sidebar toggle, editable title, page background, zoom and theme. */
export function TopBar() {
  const page = useAppStore((s) => s.pages.find((p) => p.id === s.activePageId));
  const zoom = useAppStore((s) => s.zoom);
  const theme = useAppStore((s) => s.theme);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const renamePage = useAppStore((s) => s.renamePage);
  const setPageBackground = useAppStore((s) => s.setPageBackground);
  const setThemePreference = useAppStore((s) => s.setThemePreference);

  return (
    <header className="topbar">
      <button
        type="button"
        className="icon-button"
        aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
        aria-pressed={!sidebarCollapsed}
        title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
        onClick={toggleSidebar}
      >
        <PanelLeft size={18} />
      </button>

      {page ? (
        <input
          className="page-title"
          aria-label="Page title"
          placeholder="Untitled page"
          value={page.title}
          onChange={(e) => renamePage(page.id, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
          }}
        />
      ) : (
        <span className="page-title is-placeholder">No page selected</span>
      )}

      <div className="topbar-controls">
        <SaveStatus />
        {page ? (
          <label className="select-field">
            <span className="visually-hidden">Page background</span>
            <select
              value={page.background}
              onChange={(e) => setPageBackground(page.id, e.target.value as PageBackground)}
              title="Page background"
            >
              {(Object.keys(BACKGROUND_LABELS) as PageBackground[]).map((key) => (
                <option key={key} value={key}>
                  {BACKGROUND_LABELS[key]}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {page ? (
          <div className="zoom-control" role="group" aria-label="Zoom">
            <button
              type="button"
              className="icon-button"
              aria-label="Zoom out"
              title="Zoom out"
              onClick={() => getActiveEngine()?.zoomBy(1 / ZOOM_STEP)}
            >
              <Minus size={16} />
            </button>
            <button
              type="button"
              className="zoom-value"
              title="Reset zoom to 100% (Ctrl/Cmd+0)"
              onClick={() => getActiveEngine()?.resetZoom()}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Zoom in"
              title="Zoom in"
              onClick={() => getActiveEngine()?.zoomBy(ZOOM_STEP)}
            >
              <Plus size={16} />
            </button>
          </div>
        ) : null}

        <button
          type="button"
          className="icon-button"
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          onClick={() => setThemePreference(theme === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </div>
    </header>
  );
}
