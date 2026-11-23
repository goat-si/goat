import { expect, describe, it, vi } from "vite-plus/test";
import { cdp, userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { act } from "../../test/render";
import { serializeEditorDoc } from "~/composer-rich-text-doc";
import { mountEditor } from "./ComposerPromptEditorTiptap.input.test-support";

// CDP drives Chrome's own IME path, which skips deleting a range bounded by an uneditable chip.
describe("an IME composition over a selection with a chip", () => {
  const chip = "[Seed · 2](goat-context://v1/thread/thread_seed)";
  it.each([
    { range: "text and the chip after it", anchor: 1, head: 6, composed: `あ ${chip} RIGHT` },
    { range: "a chip and the text after it", anchor: 5, head: 7, composed: `LEFTあ${chip} RIGHT` },
    {
      range: "a chip and the text after it, backward",
      anchor: 14,
      head: 7,
      composed: `LEFT${chip} あ`,
    },
  ])("replaces $range as typing would", async ({ anchor, head, composed }) => {
    const value = `LEFT${chip} ${chip} RIGHT`;
    await using screen = await mountEditor(`LEFT${chip} ${chip} `);
    const { editor } = screen;
    await act(async () => {
      editor.commands.focus("end");
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(editor.view.dom));
    await userEvent.keyboard("RIGHT");
    expect(serializeEditorDoc(editor.state.doc).value).toBe(value);
    await act(async () => {
      editor.commands.setTextSelection({ from: anchor, to: head });
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(editor.view.dom));
    const session = cdp();
    for (const text of ["u", "u3", "u30", "u304", "u3042"]) {
      await session.send("Input.imeSetComposition", {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      });
    }
    await session.send("Input.insertText", { text: "あ" });
    await vi.waitFor(() => expect(serializeEditorDoc(editor.state.doc).value).toBe(composed));
    await act(async () => {
      editor.commands.undo();
    });
    expect(serializeEditorDoc(editor.state.doc).value).toBe(value);
    expect(editor.state.selection.toJSON()).toEqual({ type: "text", anchor, head });
  });
});
