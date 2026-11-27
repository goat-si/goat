import type { ServerProviderSkill } from "@goat/contracts";
import type { Editor } from "@tiptap/core";
import { createRef, useState } from "react";
import { render } from "../../test/render";
import {
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
  type ComposerPromptEditorProps,
} from "./ComposerPromptEditor";

export function Composer({
  value,
  richTextEnabled,
  skills,
  disabled = false,
  editorRef = createRef<ComposerPromptEditorHandle>(),
  onChange,
  onCommandKeyDown = () => false,
}: {
  value: string;
  richTextEnabled: boolean;
  skills: ReadonlyArray<ServerProviderSkill>;
  disabled?: boolean;
  editorRef?: ComposerPromptEditorProps["editorRef"];
  onChange?: ComposerPromptEditorProps["onChange"] | undefined;
  onCommandKeyDown?: ComposerPromptEditorProps["onCommandKeyDown"] | undefined;
}) {
  const [prompt, setPrompt] = useState({ value, cursor: value.length });
  return (
    <ComposerPromptEditor
      editorRef={editorRef}
      value={prompt.value}
      cursor={prompt.cursor}
      richTextEnabled={richTextEnabled}
      contextRecords={new Map()}
      skills={skills}
      disabled={disabled}
      placeholder=""
      onChange={(...args) => {
        setPrompt({ value: args[0], cursor: args[1] });
        onChange?.(...args);
      }}
      onPaste={() => {}}
      onCommandKeyDown={onCommandKeyDown}
    />
  );
}

function composer(
  value: string,
  richTextEnabled = true,
  skills: ReadonlyArray<ServerProviderSkill> = [],
  onChange?: ComposerPromptEditorProps["onChange"],
  onCommandKeyDown?: ComposerPromptEditorProps["onCommandKeyDown"],
) {
  return (
    <Composer
      value={value}
      richTextEnabled={richTextEnabled}
      skills={skills}
      onChange={onChange}
      onCommandKeyDown={onCommandKeyDown}
    />
  );
}

export function editorIn(container: HTMLElement) {
  const element = container.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
  if (!element) throw new Error("Composer did not mount");
  return element.editor;
}

export async function mountEditor(...props: Parameters<typeof composer>) {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await render(composer(...props)));
  const editor = editorIn(screen.container);
  const environment = stack.move();
  return Object.assign(screen, {
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
    editor,
    /** Rerenders the same composer with new props, as a parent would. */
    update: async (...next: Parameters<typeof composer>) => {
      await screen.rerender(composer(...next));
      return editorIn(screen.container);
    },
  });
}
