import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../test/render";
import { Composer, editorIn } from "./ComposerPromptEditorTiptap.input.test-support";

it.each([true, false])(
  "restores the caret after dictation unlocks the editor (rich text: %s)",
  async (richTextEnabled) => {
    const ui = (disabled: boolean) => (
      <Composer value="Draft" richTextEnabled={richTextEnabled} skills={[]} disabled={disabled} />
    );
    await using screen = await render(ui(false));
    const editor = editorIn(screen.container);
    await act(() => {
      editor.commands.setTextSelection(3);
      editor.view.focus();
    });
    await screen.rerender(ui(true));
    await screen.rerender(ui(false));
    await vi.waitFor(() => {
      expect(editor.view.hasFocus()).toBe(true);
      expect(editor.view.dom.contains(window.getSelection()?.anchorNode ?? null)).toBe(true);
    });
    await userEvent.keyboard("X");
    await vi.waitFor(() => expect(editor.getText()).toBe("DrXaft"));
  },
);

it.each(["other field", "document body"])(
  "does not reclaim focus when it moves away during dictation and ends on the %s",
  async (focusTarget) => {
    const ui = (disabled: boolean) => (
      <>
        <Composer value="Draft" richTextEnabled skills={[]} disabled={disabled} />
        <input aria-label="Other field" />
      </>
    );
    await using screen = await render(ui(false));
    const editor = editorIn(screen.container);
    await act(() => editor.view.focus());
    await screen.rerender(ui(true));
    const other = screen.container.querySelector("input")!;
    other.focus();
    await vi.waitFor(() => expect(document.activeElement).toBe(other));
    if (focusTarget === "document body") other.blur();
    await screen.rerender(ui(false));
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(focusTarget === "document body" ? document.body : other),
    );
  },
);
