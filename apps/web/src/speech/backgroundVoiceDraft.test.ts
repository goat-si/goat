import { expect, it, vi } from "vite-plus/test";
import { captureBackgroundVoiceDraft } from "./backgroundVoiceDraft";

it("fences a recording to its originating draft across edits, deletion and replacement", () => {
  let draft: string | null = "original";
  let exists = true;
  let changed = () => {};
  const write = vi.fn();
  const binding = captureBackgroundVoiceDraft({
    ownerKey: "thread-a",
    selection: { start: 8, end: 8 },
    read: () => draft,
    exists: () => exists,
    write,
    subscribe: (listener) => {
      changed = listener;
      return () => {};
    },
  });
  expect(binding.readDraft()).toMatchObject({
    ownerKey: "thread-a",
    text: "original",
    revision: 0,
  });
  draft = null;
  changed();
  draft = "original";
  changed();
  expect(binding.readDraft()).toMatchObject({
    ownerKey: "thread-a",
    text: "original",
    revision: 2,
  });
  exists = false;
  expect(binding.readDraft()).toBeNull();
  expect(write).not.toHaveBeenCalled();
  binding.dispose();
});
