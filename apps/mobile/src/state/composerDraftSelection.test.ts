import { describe, expect, it } from "vite-plus/test";

import {
  readComposerDraftSelection,
  rememberComposerDraftSelection,
} from "./composerDraftSelection";

describe("mobile composer draft selections", () => {
  it("retains each draft's insertion range when another composer moves its caret", () => {
    const threadKey = "caret-environment:caret-thread";
    const newTaskKey = "caret-environment:new-task:caret-draft";
    rememberComposerDraftSelection(threadKey, "Fix this next", { start: 4, end: 8 });
    rememberComposerDraftSelection(newTaskKey, "Another task", { start: 2, end: 2 });

    expect(readComposerDraftSelection(threadKey, "Fix this next")).toEqual({ start: 4, end: 8 });
    expect(readComposerDraftSelection(newTaskKey, "Another task")).toEqual({ start: 2, end: 2 });
  });

  it("ignores a saved insertion range after the draft text changes", () => {
    const key = "caret-environment:edited-thread";
    rememberComposerDraftSelection(key, "old text", { start: 0, end: 3 });

    expect(readComposerDraftSelection(key, "new text")).toBeNull();
    expect(readComposerDraftSelection("caret-environment:unseen-thread", "old text")).toBeNull();
  });

  it("keeps the post-insertion caret when another draft moves its caret", () => {
    const key = "caret-environment:inserted-thread";
    const text = "Fix [Build output](goat-context://v1/terminal/caret-terminal) next";
    const cursor = text.length - " next".length;
    rememberComposerDraftSelection(key, "Fix this next", { start: 4, end: 8 });
    rememberComposerDraftSelection(key, text, { start: cursor, end: cursor });
    rememberComposerDraftSelection("caret-environment:other-thread", "other", { start: 1, end: 1 });

    expect(readComposerDraftSelection(key, text)).toEqual({ start: cursor, end: cursor });
    expect(readComposerDraftSelection(key, "Fix this next")).toBeNull();
  });
});
