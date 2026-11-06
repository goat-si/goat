import { Extension } from "@tiptap/core";
import type { EnvironmentId } from "@goat/contracts";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import {
  BoldIcon,
  CodeIcon,
  ListChecksIcon,
  ListIcon,
  ListOrderedIcon,
  MinusIcon,
  PaperclipIcon,
  QuoteIcon,
  SquareCodeIcon,
  TextIcon,
  type IconComponent,
} from "~/components/solar";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useStableCallback } from "../hooks/useStableCallback";
import { noteExtensions } from "./noteExtensions";
import { noteDocToMarkdown, noteMarkdownToDoc } from "./noteMarkdown";
import {
  addUploadPlaceholder,
  insertUploads,
  noteUploadPlugin,
  removeUploadPlaceholder,
  uploadEmbed,
  uploadName,
  uploadPlaceholderPos,
} from "./noteUploadPlaceholders";
import { uploadNoteFile } from "./noteUploads";

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

const WEB_URL = /^https?:\/\/[^\s\u0000-\u001f\u007f]+$/i;

export function NoteEditor(props: {
  body: string;
  editable: boolean;
  autoFocus?: boolean;
  onChange: (body: string) => void;
  /** Escape leaves the editor, for example back to the note list. */
  onExit?: () => void;
  /** Where embeds load from and uploads go; without it embeds show their markdown source. */
  embeds?: { environmentId: EnvironmentId; notePath: string; canAttach: boolean };
}) {
  // NoteDetail remounts this editor on reload via editorVersion; draft saves only serialize.
  const [initialContent] = useState(() => noteMarkdownToDoc(props.body, props.embeds?.notePath));
  const fileInput = useRef<HTMLInputElement>(null);
  // Set by the editor's own lifecycle; handlers below run only while it exists.
  const editorRef = useRef<Editor | null>(null);
  const nextBatch = useRef(0);
  // In-flight upload batches by placeholder id.
  const batches = useRef(new Map<string, AbortController>());
  const canAttach = props.editable && props.embeds?.canAttach === true;
  const cancelBatch = useStableCallback((id: string) => {
    batches.current.get(id)?.abort();
    batches.current.delete(id);
    const editor = editorRef.current;
    if (editor && uploadPlaceholderPos(editor.state, id) !== null)
      editor.view.dispatch(removeUploadPlaceholder(editor.state.tr, id));
  });
  const attach = useStableCallback((files: ReadonlyArray<File>, at: number) => {
    const embeds = props.embeds;
    const editor = editorRef.current;
    const [first] = files;
    if (!editor || !embeds || !canAttach || first === undefined) return false;
    const id = `upload-${++nextBatch.current}`;
    const controller = new AbortController();
    batches.current.set(id, controller);
    const label =
      files.length === 1 ? `Uploading ${uploadName(first)}…` : `Uploading ${files.length} files…`;
    editor.view.dispatch(addUploadPlaceholder(editor.state.tr, id, at, label));
    void Promise.all(
      files.map((file) =>
        uploadNoteFile({ environmentId: embeds.environmentId, file, signal: controller.signal }),
      ),
    ).then((results) => {
      batches.current.delete(id);
      if (controller.signal.aborted || editor.isDestroyed) return;
      const done = results.flatMap((result) => (result.ok ? [uploadEmbed(result)] : []));
      const tr = insertUploads(editor.state, id, done);
      if (tr) editor.view.dispatch(tr);
      const failures = results.flatMap((result) => (result.ok || result.cancelled ? [] : [result]));
      const [failure] = failures;
      if (failure)
        toastManager.add({
          type: "error",
          title:
            failures.length === 1
              ? `Couldn’t attach ${failure.name}`
              : `Couldn’t attach ${failures.length} files`,
          description: failures.map((item) => item.message).join(" "),
        });
    });
    return true;
  });
  const [uploads] = useState(() =>
    Extension.create({
      name: "noteUploads",
      addProseMirrorPlugins: () => [noteUploadPlugin((id) => cancelBatch(id))],
    }),
  );
  const editor = useEditor({
    extensions: [
      ...noteExtensions(
        props.embeds
          ? { environmentId: props.embeds.environmentId, notePath: props.embeds.notePath }
          : undefined,
      ),
      uploads,
    ],
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
      // Files are consumed even when the clipboard also carries HTML, so nothing pastes twice.
      handlePaste: (view, event) => {
        const files = [...(event.clipboardData?.files ?? [])];
        if (files.length > 0) return attach(files, view.state.selection.to);
        const text = event.clipboardData?.getData("text/plain").trim() ?? "";
        const { $from, empty } = view.state.selection;
        const embed = view.state.schema.nodes.noteEmbed;
        if (
          !props.embeds ||
          !embed ||
          !WEB_URL.test(text) ||
          !empty ||
          $from.depth !== 1 ||
          $from.parent.type.name !== "paragraph" ||
          $from.parent.content.size > 0
        )
          return false;
        view.dispatch(
          view.state.tr.replaceWith(
            $from.before(1),
            $from.after(1),
            embed.create({ syntax: "url", src: text, text, title: null }),
          ),
        );
        return true;
      },
      handleDrop: (view, event, _slice, moved) => {
        const files = [...(event.dataTransfer?.files ?? [])];
        if (moved || files.length === 0) return false;
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        return attach(files, at ?? view.state.selection.to);
      },
    },
    onUpdate: ({ editor: current }) => props.onChange(noteDocToMarkdown(current.getJSON())),
    onCreate: ({ editor: created }) => {
      editorRef.current = created;
    },
    onDestroy: () => {
      editorRef.current = null;
    },
  });
  useEffect(() => {
    editor?.setEditable(props.editable);
  }, [editor, props.editable]);
  // oxlint-disable-next-line goat/react-effect-budget -- uploads outlive renders; leaving the note abandons them.
  useEffect(() => {
    const inFlight = batches.current;
    return () => {
      for (const controller of inFlight.values()) controller.abort();
      inFlight.clear();
    };
  }, []);
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
            {canAttach && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost-muted"
                      aria-label="Attach files"
                      onClick={() => fileInput.current?.click()}
                    />
                  }
                >
                  <PaperclipIcon aria-hidden />
                </TooltipTrigger>
                <TooltipPopup side="bottom">Attach files</TooltipPopup>
              </Tooltip>
            )}
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              aria-hidden
              tabIndex={-1}
              onChange={(event) => {
                const files = [...(event.currentTarget.files ?? [])];
                event.currentTarget.value = "";
                if (editor) attach(files, editor.state.selection.to);
              }}
            />
          </div>
        </div>
      )}
      <div className="mx-auto w-full max-w-3xl px-4 md:px-8">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
