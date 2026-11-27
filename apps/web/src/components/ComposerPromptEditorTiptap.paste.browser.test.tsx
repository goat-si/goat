import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act } from "../../test/render";
import { serializeEditorDoc } from "~/composer-rich-text-doc";
import { mountEditor } from "./ComposerPromptEditorTiptap.input.test-support";

it.each([
  ["**DEV**", "**DEV**!"],
  ["*DEV*", "*DEV*!"],
  ["~~DEV~~", "~~DEV~~!"],
  ["`DEV`", "`DEV`!"],
  ["***DEV***", "***DEV***!"],
])("types after the closing markers of pasted %s", async (pasted, typed) => {
  await using screen = await mountEditor("");
  const { editor } = screen;
  await act(async () => {
    editor.view.focus();
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", pasted);
    editor.view.dom.dispatchEvent(new ClipboardEvent("paste", { clipboardData, cancelable: true }));
  });
  await userEvent.keyboard("!");
  expect(serializeEditorDoc(editor.state.doc).value).toBe(typed);
});
