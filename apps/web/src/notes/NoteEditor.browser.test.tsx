import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { NoteEditor } from "./NoteEditor";
import { noteMarkdownToDoc } from "./noteMarkdown";

vi.mock("./noteMarkdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./noteMarkdown")>();
  return { ...actual, noteMarkdownToDoc: vi.fn(actual.noteMarkdownToDoc) };
});

it("parses once per document load while toolbar edits serialize and rerender the draft", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const saved: string[] = [];
  function Draft({ editable }: { editable: boolean }) {
    const [body, setBody] = useState("original\n");
    return (
      <NoteEditor
        body={body}
        editable={editable}
        onChange={(next) => {
          saved.push(next);
          setBody(next);
        }}
      />
    );
  }
  vi.mocked(noteMarkdownToDoc).mockClear();
  try {
    await act(async () => root.render(<Draft editable />));
    expect(noteMarkdownToDoc).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".tiptap p")?.textContent).toBe("original");
    const heading = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Heading",
    )!;
    await act(async () => heading.click());
    expect(saved.at(-1)).toBe("## original\n");
    expect(container.querySelector(".tiptap h2")?.textContent).toBe("original");
    await act(async () => root.render(<Draft editable={false} />));
    expect(noteMarkdownToDoc).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<Draft key="reload" editable />));
    expect(noteMarkdownToDoc).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
