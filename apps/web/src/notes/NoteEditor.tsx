import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import {
  BoldIcon,
  CodeIcon,
  ListChecksIcon,
  ListIcon,
  ListOrderedIcon,
  MinusIcon,
  QuoteIcon,
  SquareCodeIcon,
  TextIcon,
  type IconComponent,
} from "~/components/solar";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { noteExtensions } from "./noteExtensions";
import { noteDocToMarkdown, noteMarkdownToDoc } from "./noteMarkdown";

const TOOLS: ReadonlyArray<{ label: string; icon: IconComponent; run: (editor: Editor) => void }> =
  [
    {
      label: "Heading",
      icon: TextIcon,
      run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    { label: "Bold", icon: BoldIcon, run: (e) => e.chain().focus().toggleBold().run() },
    { label: "List", icon: ListIcon, run: (e) => e.chain().focus().toggleBulletList().run() },
    {
      label: "Numbered",
      icon: ListOrderedIcon,
      run: (e) => e.chain().focus().toggleOrderedList().run(),
    },
    {
      label: "Checklist",
      icon: ListChecksIcon,
      run: (e) => e.chain().focus().toggleTaskList().run(),
    },
    { label: "Quote", icon: QuoteIcon, run: (e) => e.chain().focus().toggleBlockquote().run() },
    { label: "Code", icon: CodeIcon, run: (e) => e.chain().focus().toggleCode().run() },
    {
      label: "Code block",
      icon: SquareCodeIcon,
      run: (e) => e.chain().focus().toggleCodeBlock().run(),
    },
    { label: "Rule", icon: MinusIcon, run: (e) => e.chain().focus().setHorizontalRule().run() },
  ];

export function NoteEditor(props: {
  body: string;
  editable: boolean;
  autoFocus?: boolean;
  onChange: (body: string) => void;
  /** Escape leaves the editor, for example back to the note list. */
  onExit?: () => void;
}) {
  // NoteDetail remounts this editor on reload via editorVersion; draft saves only serialize.
  const [initialContent] = useState(() => noteMarkdownToDoc(props.body));
  const editor = useEditor({
    extensions: noteExtensions(),
    content: initialContent,
    editable: props.editable,
    autofocus: props.autoFocus && props.editable ? "end" : false,
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        "aria-label": "Note body",
        role: "textbox",
        "aria-multiline": "true",
        class:
          "note-tiptap chat-markdown min-h-64 py-4 outline-none text-[15px] leading-7 [word-break:keep-all] [overflow-wrap:anywhere] [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:leading-tight [&_h2]:text-lg [&_pre]:whitespace-pre-wrap [&_pre[data-note-raw]]:border [&_pre[data-note-raw]]:border-dashed [&_pre[data-note-raw]]:p-3 [&_hr]:my-4 [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_ul:not([data-type=taskList])]:list-disc [&_ol]:list-decimal",
      },
      handleKeyDown: (_view, event) => {
        if (event.key !== "Escape" || !props.onExit) return false;
        props.onExit();
        return true;
      },
    },
    onUpdate: ({ editor: current }) => props.onChange(noteDocToMarkdown(current.getJSON())),
  });
  useEffect(() => {
    editor?.setEditable(props.editable);
  }, [editor, props.editable]);
  return (
    <div className="flex min-w-0 flex-col" data-note-editor>
      {props.editable && (
        <div className="sticky top-0 z-10 border-b border-border/60 bg-background/95 backdrop-blur-sm">
          <div
            className="mx-auto flex w-full max-w-3xl gap-0.5 overflow-x-auto px-3 py-1 md:px-7"
            role="toolbar"
            aria-label="Note formatting"
          >
            {TOOLS.map((tool) => (
              <Tooltip key={tool.label}>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost-muted"
                      aria-label={tool.label}
                      onClick={() => editor && tool.run(editor)}
                    />
                  }
                >
                  <tool.icon aria-hidden />
                </TooltipTrigger>
                <TooltipPopup side="bottom">{tool.label}</TooltipPopup>
              </Tooltip>
            ))}
          </div>
        </div>
      )}
      <div className="mx-auto w-full max-w-3xl px-4 md:px-8">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
