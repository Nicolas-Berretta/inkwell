import { BookOpen, Check, ChevronDown, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useAppStore } from '../store/appStore';
import { InlineEdit } from './InlineEdit';
import { RowMenu } from './RowMenu';

/** Top tier of the hierarchy: shows the open notebook and expands into the notebook list. */
export function NotebookPicker() {
  const notebooks = useAppStore((s) => s.notebooks);
  const activeNotebookId = useAppStore((s) => s.activeNotebookId);
  const selectNotebook = useAppStore((s) => s.selectNotebook);
  const addNotebook = useAppStore((s) => s.addNotebook);
  const renameNotebook = useAppStore((s) => s.renameNotebook);
  const removeNotebook = useAppStore((s) => s.removeNotebook);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const active = notebooks.find((n) => n.id === activeNotebookId);

  return (
    <div className="notebook-picker">
      <button
        type="button"
        className="notebook-current"
        aria-expanded={open}
        aria-controls="notebook-list"
        onClick={() => setOpen((value) => !value)}
      >
        <BookOpen size={16} aria-hidden="true" />
        <span className="notebook-name">{active ? active.name : 'No notebook'}</span>
        <ChevronDown size={15} className={open ? 'chevron is-open' : 'chevron'} aria-hidden="true" />
      </button>

      {open ? (
        <div className="notebook-list" id="notebook-list">
          {notebooks.map((notebook) => (
            <div
              key={notebook.id}
              className={notebook.id === activeNotebookId ? 'nav-row is-active' : 'nav-row'}
              role="button"
              tabIndex={0}
              onClick={() => {
                void selectNotebook(notebook.id);
                setOpen(false);
              }}
              onDoubleClick={() => setEditingId(notebook.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.target === e.currentTarget) {
                  void selectNotebook(notebook.id);
                  setOpen(false);
                }
              }}
            >
              <span className="nav-row-check">{notebook.id === activeNotebookId ? <Check size={14} /> : null}</span>
              {editingId === notebook.id ? (
                <InlineEdit
                  value={notebook.name}
                  ariaLabel="Notebook name"
                  onCommit={(name) => {
                    renameNotebook(notebook.id, name);
                    setEditingId(null);
                  }}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <span className="nav-row-label">{notebook.name}</span>
              )}
              <RowMenu
                label={`Actions for notebook ${notebook.name}`}
                items={[
                  { label: 'Rename', icon: <Pencil size={14} />, onSelect: () => setEditingId(notebook.id) },
                  {
                    label: 'Delete',
                    icon: <Trash2 size={14} />,
                    danger: true,
                    onSelect: () => void removeNotebook(notebook.id),
                  },
                ]}
              />
            </div>
          ))}
          <button type="button" className="nav-add" onClick={() => void addNotebook()}>
            <Plus size={14} />
            New notebook
          </button>
        </div>
      ) : null}
    </div>
  );
}
