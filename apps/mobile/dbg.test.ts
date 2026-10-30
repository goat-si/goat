import { it } from "vite-plus/test";
it("dbg", async () => {
  const _x = 1; // { EditorState } from "@codemirror/state";
  const _x = 1; // { noteEditorExtensions, noteEditorChanges, noteText } from "./src/features/notes/live-editor/note-editor-state.ts";
  const s = EditorState.create({
    doc: "x\ny",
    extensions: [
      noteEditorExtensions("\n"),
      EditorState.transactionExtender.of((tr) => {
        console.log(
          "ext",
          JSON.stringify(noteEditorChanges(tr.startState.doc, tr.changes, "\n")),
          tr.state.doc.length,
        );
        return null;
      }),
    ],
  });
  const t = s.update({ changes: { from: 1, insert: "a\r\nb" } });
  console.log(
    JSON.stringify(noteText(t.state)),
    JSON.stringify(noteEditorChanges(s.doc, t.changes, "\n")),
  );
});
