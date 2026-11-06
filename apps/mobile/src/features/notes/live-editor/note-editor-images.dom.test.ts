import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { expect, it, vi } from "vite-plus/test";
import { createNoteImageStore, imagesAfterComposition, imagesChanged } from "./note-editor-images";
import { livePreview, liveTapHandlers, noteImageStore } from "./note-editor-live-preview";
import { noteEditorExtensions } from "./note-editor-state";

const href = "/.attachments/0123456789abcdef.png";

function open(doc = `Before\n\n![Diagram](${href})\n`) {
  const asked: string[] = [];
  const links: string[] = [];
  const store = createNoteImageStore((message) => asked.push(...message.hrefs));
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        noteEditorExtensions("\n"),
        livePreview,
        liveTapHandlers((link) => links.push(link)),
        noteImageStore.of(store),
        imagesAfterComposition,
      ],
    }),
  });
  let composing = false;
  Object.defineProperty(view, "composing", { get: () => composing });
  return {
    view,
    store,
    asked,
    links,
    parent,
    setComposing: (value: boolean) => (composing = value),
    image: () => parent.querySelector<HTMLImageElement>("img.cm-goat-image"),
    [Symbol.dispose]() {
      view.destroy();
      parent.remove();
    },
  };
}

it("asks for a note image and shows it once its URL arrives", async () => {
  using editor = open();
  await vi.waitFor(() => expect(editor.asked).toEqual([href]));
  expect(editor.image()).toBeNull();
  editor.store.receive({ [href]: "https://hub/api/assets/token/a.png" }, []);
  editor.view.dispatch({ effects: imagesChanged.of(null) });
  expect(editor.image()?.getAttribute("src")).toBe("https://hub/api/assets/token/a.png");
});

it("holds a URL that arrives mid-composition until composition ends", async () => {
  using editor = open();
  await vi.waitFor(() => expect(editor.asked).toEqual([href]));
  editor.setComposing(true);
  editor.store.receive({ [href]: "https://hub/a.png" }, []);
  editor.view.dispatch({ effects: imagesChanged.of(null) });
  expect(editor.image()).toBeNull();
  editor.setComposing(false);
  editor.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  await vi.waitFor(() => expect(editor.image()?.getAttribute("src")).toBe("https://hub/a.png"));
});

it("shows video and audio as links that open the file, without asking for an image", async () => {
  const video = "/.attachments/00000000000000aa.mp4";
  using editor = open(
    `![Diagram](${href})\n\n![Demo](${video})\n\n![](https://example.com/talk.mp3?x=1)\n`,
  );
  await vi.waitFor(() => expect(editor.asked).toEqual([href]));
  const media = [...editor.parent.querySelectorAll<HTMLElement>(".cm-goat-link[data-href]")];
  expect(media.map((link) => link.textContent)).toEqual(["▶ Demo", "▶ talk.mp3"]);
  media[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  expect(editor.links).toEqual([video]);
});
