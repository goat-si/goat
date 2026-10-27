import { expect, it } from "vite-plus/test";
import { previewHints, snapshotTransportHints } from "./hints.ts";

it("gives the next useful browser step without claiming action confirmation", () => {
  expect(previewHints("status", { tabId: null })).toEqual({
    next: "No tab yet: call goat_preview_open with a url.",
  });
  expect(previewHints("snapshot", { treeComplete: false })).toEqual({
    next: "Narrow with interactiveOnly or scope, or read the text with goat_preview_read.",
  });
  expect(previewHints("click", {})).toEqual({
    next: "Unconfirmed: check with goat_preview_snapshot diff:true.",
  });
  expect(previewHints("status", { tabId: "tab" })).toEqual({});
  expect(snapshotTransportHints({ omitted: ["tree_budget"] }, true)).toMatchObject({
    treeComplete: false,
    omitted: ["tree_budget", "transport_budget"],
  });
});

it("bounds semantic diffs together with snapshot text and reports transport omissions", async () => {
  const { boundSnapshotMetadata, MAX_SNAPSHOT_TEXT_BYTES } = await import("./snapshotTransport.ts");
  const result = boundSnapshotMetadata({
    url: "https://snapshot.test",
    title: "Diff",
    visibleText: "",
    accessibilityTree: '- button "Save" [ref=goat-ref]',
    interactiveElements: [],
    consoleEntries: [],
    networkEntries: [],
    actionTimeline: [],
    treeComplete: true,
    diff: {
      base: "previous",
      added: ["Large added line".repeat(10000)],
      removed: ["Large removed line".repeat(10000)],
    },
  });
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(MAX_SNAPSHOT_TEXT_BYTES);
  expect(result.value).toMatchObject({ treeComplete: false, omitted: ["transport_budget"] });
});
