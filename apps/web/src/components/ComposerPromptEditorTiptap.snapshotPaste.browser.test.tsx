import { ComposerContextId } from "@goat/contracts";
import { formatComposerContextReference } from "@goat/shared/composerContextReferences";
import { createRef } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { serializeEditorDoc } from "~/composer-rich-text-doc";
import { editorIn } from "./ComposerPromptEditorTiptap.input.test-support";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
import { snapshotClipboardFixture } from "./chat/snapshotClipboard.testkit";

it.each([
  ["snapshot", false, true, false],
  ["snapshot via HTML fallback", false, true, true],
  ["literal answer", true, false, false],
  ["image only", false, false, false],
] as const)(
  "handles a native PNG paste as %s",
  async (kind, literalText, importsSnapshot, rejectCustom) => {
    const { clipboard, record } = await snapshotClipboardFixture({
      plainImage: kind === "image only",
      rejectCustom,
    });
    if (literalText) clipboard.clearData("text/html");
    let importing: Promise<boolean> | undefined;
    const importedId = ComposerContextId.make("image_local");
    const importContextFragment = vi.fn(() => new Map([[record.contextId, importedId]]));
    await using screen = await render(
      <ComposerPromptEditor
        editorRef={createRef<ComposerPromptEditorHandle>()}
        value=""
        cursor={0}
        richTextEnabled
        literalText={literalText}
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder=""
        onChange={() => {}}
        onPaste={(event, importSnapshot) => {
          if (!importSnapshot) return;
          event.preventDefault();
          event.stopPropagation();
          importing = importSnapshot(() => true);
        }}
        onCommandKeyDown={() => false}
        importContextFragment={importContextFragment}
      />,
    );
    const editor = editorIn(screen.container);
    await act(async () => {
      editor.view.dom.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: clipboard,
          cancelable: true,
          bubbles: true,
        }),
      );
      await importing;
    });
    expect(serializeEditorDoc(editor.state.doc).value).toBe(
      importsSnapshot
        ? formatComposerContextReference({ ...record, contextId: importedId })
        : literalText
          ? formatComposerContextReference(record)
          : "",
    );
  },
);
