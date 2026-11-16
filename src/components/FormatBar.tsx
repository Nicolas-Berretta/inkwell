import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { Bold, Code2, Heading1, Heading2, Italic, List, ListChecks } from 'lucide-react';
import type { ReactNode } from 'react';

interface FormatBarProps {
  editor: Editor;
}

interface FormatButtonProps {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}

function FormatButton({ label, active, onClick, children }: FormatButtonProps) {
  return (
    <button
      type="button"
      className={active ? 'format-button is-active' : 'format-button'}
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Compact formatting controls for the focused text container. */
export function FormatBar({ editor }: FormatBarProps) {
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      bullets: e.isActive('bulletList'),
      tasks: e.isActive('taskList'),
      code: e.isActive('codeBlock'),
    }),
  });

  return (
    <div className="format-bar" role="toolbar" aria-label="Text formatting">
      <FormatButton label="Bold (Ctrl+B)" active={active.bold} onClick={() => editor.chain().focus().toggleBold().run()}>
        <Bold size={14} />
      </FormatButton>
      <FormatButton label="Italic (Ctrl+I)" active={active.italic} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Italic size={14} />
      </FormatButton>
      <span className="format-divider" />
      <FormatButton
        label="Heading 1"
        active={active.h1}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
      >
        <Heading1 size={14} />
      </FormatButton>
      <FormatButton
        label="Heading 2"
        active={active.h2}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        <Heading2 size={14} />
      </FormatButton>
      <span className="format-divider" />
      <FormatButton label="Bullet list" active={active.bullets} onClick={() => editor.chain().focus().toggleBulletList().run()}>
        <List size={14} />
      </FormatButton>
      <FormatButton label="Checklist" active={active.tasks} onClick={() => editor.chain().focus().toggleTaskList().run()}>
        <ListChecks size={14} />
      </FormatButton>
      <FormatButton label="Code block" active={active.code} onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
        <Code2 size={14} />
      </FormatButton>
    </div>
  );
}
