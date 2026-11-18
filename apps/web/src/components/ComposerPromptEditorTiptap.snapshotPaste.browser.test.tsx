import { ComposerContextId, EnvironmentId } from "@goat/contracts";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextFragment,
} from "@goat/shared/composerContextClipboard";
import { formatComposerContextReference } from "@goat/shared/composerContextReferences";
import { createRef } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { serializeEditorDoc } from "~/composer-rich-text-doc";
import { editorIn } from "./ComposerPromptEditorTiptap.input.test-support";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

it.each([
  ["snapshot", false, true],
  ["literal answer", true, false],
  ["image only", false, false],
] as const)("handles a native PNG paste as %s", async (kind, literalText, importsSnapshot) => {
  const record = {
    version: 1 as const,
    kind: "image" as const,
    contextId: ComposerContextId.make("image_snapshot"),
    label: "shot.png",
    attachmentId: "snapshot",
    name: "shot.png",
    mimeType: "image/png",
    sizeBytes: 3,
    source: {
      kind: "snap-shot" as const,
      capturedAt: "2026-01-01T00:00:00.000Z",
      appName: "Finder",
      windowTitle: "Downloads",
    },
  };
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
      onPaste={() => {}}
      onCommandKeyDown={() => false}
      importContextFragment={importContextFragment}
    />,
  );
  const transfer = new DataTransfer();
  transfer.items.add(new File(["png"], "shot.png", { type: "image/png" }));
  if (kind !== "image only") {
    const fragment = encodeComposerContextFragment({
      version: 1,
      source: { environmentId: EnvironmentId.make("snapshot-source") },
      records: [record],
    });
    if (!fragment) throw new Error("Could not make snapshot clipboard fixture.");
    transfer.setData(COMPOSER_CONTEXT_CLIPBOARD_MIME, fragment);
    transfer.setData("text/plain", formatComposerContextReference(record));
  }
  const editor = editorIn(screen.container);
  await act(async () => {
    editor.view.dom.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: transfer,
        cancelable: true,
        bubbles: true,
      }),
    );
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe(
    importsSnapshot
      ? formatComposerContextReference({ ...record, contextId: importedId })
      : literalText
        ? formatComposerContextReference(record)
        : "",
  );
});
