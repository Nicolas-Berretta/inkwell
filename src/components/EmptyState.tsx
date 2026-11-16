import { useAppStore } from '../store/appStore';

/** Shown over the canvas when there is no page to display. */
export function EmptyState() {
  const hasNotebook = useAppStore((s) => s.activeNotebookId !== null);
  const hasSection = useAppStore((s) => s.activeSectionId !== null);
  const addNotebook = useAppStore((s) => s.addNotebook);
  const addSection = useAppStore((s) => s.addSection);
  const addPage = useAppStore((s) => s.addPage);

  const action = !hasNotebook
    ? { text: 'There are no notebooks yet.', label: 'Create a notebook', run: addNotebook }
    : !hasSection
      ? { text: 'This notebook has no sections.', label: 'Add a section', run: addSection }
      : { text: 'This section has no pages.', label: 'Add a page', run: addPage };

  return (
    <div className="empty-state">
      <p>{action.text}</p>
      <button type="button" className="button is-primary" onClick={() => void action.run()}>
        {action.label}
      </button>
    </div>
  );
}
