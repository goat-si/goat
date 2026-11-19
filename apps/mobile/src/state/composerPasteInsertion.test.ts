import { expect, it } from "vite-plus/test";
import {
  appendComposerDraftAttachments,
  captureComposerDraftInsertion,
  getComposerDraftSnapshot,
  rememberComposerDraftSelection,
  setComposerDraftText,
} from "./use-composer-drafts";

it("keeps a pending paste before text typed at its caret, and the caret after that text", async () => {
  const key = "environment-1:typing-at-paste-point";
  const image = {
    id: "image",
    type: "file" as const,
    name: "picture.png",
    mimeType: "text/plain",
    sizeBytes: 4,
    fileUri: "file:///picture.png",
  };
  setComposerDraftText(key, "Before ");
  const insertion = captureComposerDraftInsertion(key, { start: 7, end: 7 });
  const write = Promise.withResolvers<void>();
  const pending = write.promise.then(() =>
    appendComposerDraftAttachments(key, [image], { appendReference: true, insertion }),
  );
  setComposerDraftText(key, "Before yaz");
  rememberComposerDraftSelection(key, "Before yaz", { start: 10, end: 10 });
  write.resolve();
  expect(await pending).toBe(0);
  const link = "[picture.png](goat-context://v1/file/image)";
  expect(getComposerDraftSnapshot(key).text).toBe(`Before ${link} yaz`);
  const caret = `Before ${link} yaz`.length;
  expect(captureComposerDraftInsertion(key)).toMatchObject({ start: caret, end: caret });
});
