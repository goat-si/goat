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

it.each(["first", "second"] as const)(
  "keeps paste order when the %s attachment completes first",
  async (finishesFirst) => {
    const key = `env:overlap-${finishesFirst}`;
    const makeFile = (id: string) => ({
      id,
      type: "file" as const,
      name: `${id}.png`,
      mimeType: "text/plain",
      sizeBytes: 1,
      fileUri: `file:///${id}.png`,
    });
    setComposerDraftText(key, "Before ");
    const first = captureComposerDraftInsertion(key, { start: 7, end: 7 });
    const second = captureComposerDraftInsertion(key, { start: 7, end: 7 });
    setComposerDraftText(key, "Before typed");
    rememberComposerDraftSelection(key, "Before typed", { start: 12, end: 12 });
    const firstDone = Promise.withResolvers<void>();
    const secondDone = Promise.withResolvers<void>();
    const firstPaste = firstDone.promise.then(() =>
      appendComposerDraftAttachments(key, [makeFile("first")], {
        appendReference: true,
        insertion: first,
      }),
    );
    const secondPaste = secondDone.promise.then(() =>
      appendComposerDraftAttachments(key, [makeFile("second")], {
        appendReference: true,
        insertion: second,
      }),
    );
    if (finishesFirst === "first") {
      firstDone.resolve();
      await firstPaste;
      secondDone.resolve();
      await secondPaste;
    } else {
      secondDone.resolve();
      await secondPaste;
      firstDone.resolve();
      await firstPaste;
    }
    const expected =
      "Before [first.png](goat-context://v1/file/first) [second.png](goat-context://v1/file/second) typed";
    expect(getComposerDraftSnapshot(key).text).toBe(expected);
    expect(captureComposerDraftInsertion(key)).toMatchObject({
      start: expected.length,
      end: expected.length,
    });
  },
);
