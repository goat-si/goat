import noteEditorAsset from "@goat/mobile-note-editor/note-editor.html";
import { Asset } from "expo-asset";

let editorUri: Promise<string> | null = null;
/** Copies the bundled editor page to a readable file the first time a note opens. */
export function loadEditorUri() {
  editorUri ??= Asset.fromModule(noteEditorAsset)
    .downloadAsync()
    .then((asset) => asset.localUri ?? asset.uri)
    .catch((error: unknown) => {
      editorUri = null;
      throw error;
    });
  return editorUri;
}
