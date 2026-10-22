import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { noteExtensions } from "./noteExtensions";
import { noteDocToMarkdown, noteMarkdownToDoc } from "./noteMarkdown";

export function NoteEditor(props: {
  body: string;
  editable: boolean;
  onChange: (body: string) => void;
}) {
  // NoteDetail remounts this editor on reload via editorVersion; draft saves only serialize.
  const [initialContent] = useState(() => noteMarkdownToDoc(props.body));
  const editor = useEditor({
    extensions: noteExtensions(),
    content: initialContent,
    editable: props.editable,
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        "aria-label": "Note body",
        role: "textbox",
        "aria-multiline": "true",
        class:
          "note-tiptap chat-markdown min-h-64 p-4 outline-none text-sm leading-relaxed [&_pre]:whitespace-pre-wrap [&_pre[data-note-raw]]:border [&_pre[data-note-raw]]:border-dashed [&_pre[data-note-raw]]:p-3 [&_hr]:my-4 [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_ul:not([data-type=taskList])]:list-disc [&_ol]:list-decimal",
      },
    },
    onUpdate: ({ editor: current }) => props.onChange(noteDocToMarkdown(current.getJSON())),
  });
  useEffect(() => {
    editor?.setEditable(props.editable);
  }, [editor, props.editable]);
  return (
    <div className="min-w-0 rounded-lg border border-border">
      {props.editable && (
        <div
          className="flex flex-wrap gap-1 border-b border-border p-2"
          role="toolbar"
          aria-label="Note formatting"
        >
          <Button
            size="xs"
            variant="ghost"
            onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
          >
            Heading
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => editor?.chain().focus().toggleBold().run()}
          >
            Bold
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => editor?.chain().focus().toggleBulletList().run()}
          >
            List
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => editor?.chain().focus().toggleOrderedList().run()}
          >
            Numbered
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => editor?.chain().focus().toggleTaskList().run()}
          >
            Checklist
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => editor?.chain().focus().toggleBlockquote().run()}
          >
            Quote
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => editor?.chain().focus().toggleCode().run()}
          >
            Code
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
          >
            Code block
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => editor?.chain().focus().setHorizontalRule().run()}
          >
            Rule
          </Button>
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}
