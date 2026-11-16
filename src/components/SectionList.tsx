import { Pencil, Plus, Trash2 } from 'lucide-react';
import type { CSSProperties } from 'react';
import { useMemo, useState } from 'react';
import { sectionsOfNotebook, useAppStore } from '../store/appStore';
import { InlineEdit } from './InlineEdit';
import { RowMenu } from './RowMenu';

/** Middle tier: colour-coded section tabs of the open notebook. */
export function SectionList() {
  const sections = useAppStore((s) => s.sections);
  const activeNotebookId = useAppStore((s) => s.activeNotebookId);
  const activeSectionId = useAppStore((s) => s.activeSectionId);
  const selectSection = useAppStore((s) => s.selectSection);
  const addSection = useAppStore((s) => s.addSection);
  const renameSection = useAppStore((s) => s.renameSection);
  const removeSection = useAppStore((s) => s.removeSection);
  const [editingId, setEditingId] = useState<string | null>(null);
  const visible = useMemo(() => sectionsOfNotebook(sections, activeNotebookId), [sections, activeNotebookId]);

  return (
    <section className="pane pane-sections" aria-label="Sections">
      <div className="pane-header">
        <h2>Sections</h2>
        <button
          type="button"
          className="icon-button is-small"
          aria-label="Add section"
          title="Add section"
          disabled={!activeNotebookId}
          onClick={() => void addSection()}
        >
          <Plus size={15} />
        </button>
      </div>
      <div className="pane-list">
        {visible.map((section) => (
          <div
            key={section.id}
            className={section.id === activeSectionId ? 'nav-row section-row is-active' : 'nav-row section-row'}
            style={{ '--section-color': section.color } as CSSProperties}
            role="button"
            tabIndex={0}
            aria-current={section.id === activeSectionId ? 'true' : undefined}
            onClick={() => void selectSection(section.id)}
            onDoubleClick={() => setEditingId(section.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.target === e.currentTarget) void selectSection(section.id);
            }}
          >
            <span className="section-tab" aria-hidden="true" />
            {editingId === section.id ? (
              <InlineEdit
                value={section.name}
                ariaLabel="Section name"
                onCommit={(name) => {
                  renameSection(section.id, name);
                  setEditingId(null);
                }}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <span className="nav-row-label">{section.name}</span>
            )}
            <RowMenu
              label={`Actions for section ${section.name}`}
              items={[
                { label: 'Rename', icon: <Pencil size={14} />, onSelect: () => setEditingId(section.id) },
                { label: 'Delete', icon: <Trash2 size={14} />, danger: true, onSelect: () => void removeSection(section.id) },
              ]}
            />
          </div>
        ))}
        {visible.length === 0 ? <p className="pane-empty">No sections</p> : null}
      </div>
    </section>
  );
}
