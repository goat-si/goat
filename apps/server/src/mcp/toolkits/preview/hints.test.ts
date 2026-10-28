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
  expect(previewHints("fetch", { format: "raw", truncated: true })).toEqual({
    next: "Over 25 MiB, so not saved: open the URL with goat_preview_navigate to download it.",
  });
  expect(previewHints("fetch", { format: "raw", truncated: false, savedPath: "/x" })).toEqual({});
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

it("restarts the diff after the caller received a cut tree", async () => {
  const transport = await import("./snapshotTransport.ts");
  const page = (tree: string) => ({
    url: "https://snapshot.test",
    title: "Diff",
    visibleText: "",
    accessibilityTree: tree,
    interactiveElements: [],
    consoleEntries: [],
    networkEntries: [],
    actionTimeline: [],
    treeComplete: true,
    diff: { base: "previous", added: ["- button Added"], removed: [] },
  });
  const key = transport.snapshotDeliveryKey(
    { thread: { threadId: "t", providerSessionId: "s" } },
    "tab",
  );
  const large = transport.boundSnapshotMetadata(page('- text "Long line"\n'.repeat(4000)));
  expect(large.treeCut).toBe(true);
  transport.recordSnapshotDelivery(key, large.treeCut);
  const next = transport.withDeliveredBaseline(key, page("- button Added"));
  expect(next.diff).toEqual({ base: "none", added: [], removed: [] });
  const small = transport.boundSnapshotMetadata(next);
  transport.recordSnapshotDelivery(key, small.treeCut);
  expect(transport.withDeliveredBaseline(key, page("- button Added")).diff).toMatchObject({
    base: "previous",
  });
  const otherTab = transport.snapshotDeliveryKey(
    { thread: { threadId: "t", providerSessionId: "s" } },
    "other",
  );
  expect(transport.withDeliveredBaseline(otherTab, page("x")).diff).toMatchObject({
    base: "previous",
  });
});
