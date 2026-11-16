import { Download, Search, Upload, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { NotebookPicker } from './NotebookPicker';
import { PageList } from './PageList';
import { SearchResults } from './SearchResults';
import { SectionList } from './SectionList';

/** Collapsible navigation: notebooks, sections, pages, search and backup. */
export function Sidebar() {
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const exportBackupFile = useAppStore((s) => s.exportBackupFile);
  const importBackupFile = useAppStore((s) => s.importBackupFile);
  const [query, setQuery] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searching = query.trim().length > 0;

  return (
    <aside className="sidebar" aria-label="Notebooks" inert={collapsed}>
      <div className="sidebar-inner">
        <div className="sidebar-brand">Inkwell</div>

        <div className="search-field">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            placeholder="Search titles and text"
            aria-label="Search all pages"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('');
            }}
          />
          {searching ? (
            <button type="button" className="icon-button is-small" aria-label="Clear search" onClick={() => setQuery('')}>
              <X size={14} />
            </button>
          ) : null}
        </div>

        {searching ? (
          <SearchResults query={query} onNavigate={() => setQuery('')} />
        ) : (
          <>
            <NotebookPicker />
            <div className="sidebar-panes">
              <SectionList />
              <PageList />
            </div>
          </>
        )}

        <div className="sidebar-footer">
          <button type="button" className="button is-quiet" onClick={() => void exportBackupFile()}>
            <Download size={15} />
            Export Backup (.json)
          </button>
          <button type="button" className="button is-quiet" onClick={() => fileInputRef.current?.click()}>
            <Upload size={15} />
            Import Backup
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="visually-hidden"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void importBackupFile(file);
            }}
          />
        </div>
      </div>
    </aside>
  );
}
