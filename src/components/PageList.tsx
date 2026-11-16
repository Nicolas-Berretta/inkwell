import { IndentDecrease, IndentIncrease, Pencil, Plus, Trash2 } from 'lucide-react';
import type { CSSProperties, DragEvent } from 'react';
import { useMemo, useState } from 'react';
import { pagesOfSection, useAppStore } from '../store/appStore';
import { MAX_PAGE_DEPTH } from '../types';
import { InlineEdit } from './InlineEdit';
import { RowMenu } from './RowMenu';

const DRAG_TYPE = 'application/x-inkwell-page';

/** Bottom tier: pages of the open section, with sub-page indentation and drag reordering. */
export function PageList() {
  const pages = useAppStore((s) => s.pages);
  const activeSectionId = useAppStore((s) => s.activeSectionId);
  const activePageId = useAppStore((s) => s.activePageId);
  const selectPage = useAppStore((s) => s.selectPage);
  const addPage = useAppStore((s) => s.addPage);
  const renamePage = useAppStore((s) => s.renamePage);
  const removePage = useAppStore((s) => s.removePage);
  const movePage = useAppStore((s) => s.movePage);
  const indentPage = useAppStore((s) => s.indentPage);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  /** Gap index (0..n) where the dragged page would be inserted. */
  const [dropGap, setDropGap] = useState<number | null>(null);
  const visible = useMemo(
    () => (activeSectionId ? pagesOfSection(pages, activeSectionId) : []),
    [pages, activeSectionId],
  );

  const onDragOverRow = (e: DragEvent<HTMLDivElement>, index: number) => {
    if (!draggingId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    setDropGap(e.clientY < rect.top + rect.height / 2 ? index : index + 1);
  };

  const finishDrag = (commit: boolean) => {
    if (commit && draggingId !== null && dropGap !== null) {
      const from = visible.findIndex((p) => p.id === draggingId);
      if (from >= 0) movePage(draggingId, dropGap > from ? dropGap - 1 : dropGap);
    }
    setDraggingId(null);
    setDropGap(null);
  };

  return (
    <section className="pane pane-pages" aria-label="Pages">
      <div className="pane-header">
        <h2>Pages</h2>
        <button
          type="button"
          className="icon-button is-small"
          aria-label="Add page"
          title="Add page"
          disabled={!activeSectionId}
          onClick={() => void addPage()}
        >
          <Plus size={15} />
        </button>
      </div>
      <div
        className="pane-list"
        onDragLeave={(e) => {
          if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setDropGap(null);
        }}
      >
        {visible.map((page, index) => {
          const previous = visible[index - 1];
          const canIndent = index > 0 && page.depth < Math.min(MAX_PAGE_DEPTH, previous.depth + 1);
          const classes = ['nav-row', 'page-row'];
          if (page.id === activePageId) classes.push('is-active');
          if (page.id === draggingId) classes.push('is-dragging');
          if (dropGap === index) classes.push('drop-before');
          if (dropGap === index + 1 && index === visible.length - 1) classes.push('drop-after');
          return (
            <div
              key={page.id}
              className={classes.join(' ')}
              style={{ '--depth': page.depth } as CSSProperties}
              role="button"
              tabIndex={0}
              aria-current={page.id === activePageId ? 'page' : undefined}
              draggable={editingId !== page.id}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, page.id);
                e.dataTransfer.effectAllowed = 'move';
                setDraggingId(page.id);
              }}
              onDragOver={(e) => onDragOverRow(e, index)}
              onDrop={(e) => {
                e.preventDefault();
                finishDrag(true);
              }}
              onDragEnd={() => finishDrag(false)}
              onClick={() => void selectPage(page.id)}
              onDoubleClick={() => setEditingId(page.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.target === e.currentTarget) void selectPage(page.id);
              }}
            >
              {editingId === page.id ? (
                <InlineEdit
                  value={page.title}
                  ariaLabel="Page title"
                  onCommit={(title) => {
                    renamePage(page.id, title);
                    setEditingId(null);
                  }}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <span className={page.title ? 'nav-row-label' : 'nav-row-label is-untitled'}>
                  {page.title || 'Untitled page'}
                </span>
              )}
              <RowMenu
                label={`Actions for page ${page.title || 'Untitled page'}`}
                items={[
                  { label: 'Rename', icon: <Pencil size={14} />, onSelect: () => setEditingId(page.id) },
                  {
                    label: 'Make subpage',
                    icon: <IndentIncrease size={14} />,
                    disabled: !canIndent,
                    onSelect: () => indentPage(page.id, 1),
                  },
                  {
                    label: 'Promote',
                    icon: <IndentDecrease size={14} />,
                    disabled: page.depth === 0,
                    onSelect: () => indentPage(page.id, -1),
                  },
                  { label: 'Delete', icon: <Trash2 size={14} />, danger: true, onSelect: () => void removePage(page.id) },
                ]}
              />
            </div>
          );
        })}
        {activeSectionId && visible.length === 0 ? <p className="pane-empty">No pages</p> : null}
      </div>
    </section>
  );
}
