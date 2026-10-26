import { describe, expect, it } from "vite-plus/test";
import { StorageCleanItems, type StorageCleanOutcome, type StorageItem } from "@goat/contracts";
import * as Schema from "effect/Schema";

import {
  confirmationFiles,
  cleanupBatches,
  diskSummary,
  initialSelection,
  mergeCleanResults,
  selectionSummary,
  storageTotals,
} from "./DiskUsageSettings.logic";

const item = (overrides: Partial<StorageItem> & Pick<StorageItem, "id" | "kind">): StorageItem => ({
  path: "/w/" + overrides.id,
  label: overrides.id,
  bytes: 1024,
  state: "removable",
  selected: true,
  reason: "",
  token: "t",
  ...overrides,
});

const decodeCleanItems = Schema.decodeUnknownExit(StorageCleanItems);

describe("storage cleanup selection", () => {
  it("models each grouped file path and size for the confirmation", () => {
    const group = item({
      id: "rotated_logs:/logs",
      kind: "rotated_logs",
      path: "/logs",
      files: [
        { path: "/logs/a.log", bytes: 3 },
        { path: "/logs/b.log", bytes: 4 },
      ],
    });
    expect(confirmationFiles(group)).toEqual([
      { path: "/logs/a.log", size: "3 B" },
      { path: "/logs/b.log", size: "4 B" },
    ]);
  });
  const items = [
    item({ id: "a", kind: "worktree", bytes: 3 * 1024 }),
    item({ id: "b", kind: "worktree", state: "needs_attention", selected: false }),
    item({ id: "c", kind: "build_output", selected: false }),
    item({ id: "d", kind: "runtime_version", bytes: null }),
    item({ id: "e", kind: "kache", state: "report_only", selected: false }),
  ];

  it("starts from the safe categories and never counts an item that holds work", () => {
    const selected = initialSelection(items);
    expect([...selected]).toEqual(["a", "d"]);
    // A needs-attention item stays out even if a stale selection still names it.
    const summary = selectionSummary(items, new Set([...selected, "b", "e"]));
    expect(summary.items.map((entry) => entry.id)).toEqual(["a", "d"]);
    expect(summary).toMatchObject({ count: 2, bytes: 3 * 1024, unmeasured: 1 });
  });

  it("splits 201 ticked items into requests the server accepts and merges their outcomes", () => {
    const many = Array.from({ length: 201 }, (_, index) =>
      item({ id: "worktree:" + index, kind: "worktree", token: "token-" + index }),
    );
    const batches = cleanupBatches(many);
    expect(batches.map((batch) => batch.length)).toEqual([200, 1]);
    for (const batch of batches) expect(decodeCleanItems(batch)._tag).toBe("Success");
    expect(batches.flat()).toEqual(many.map(({ id, token }) => ({ id, token })));

    const outcome = (id: string): StorageCleanOutcome => ({
      id,
      kind: "worktree",
      path: "/w/" + id,
      outcome: "removed",
      reason: "",
      bytes: 1,
    });
    expect(
      mergeCleanResults([
        { results: [outcome("a")], freedBytes: 5, logPath: "/logs/storage-cleanup.ndjson" },
        { results: [outcome("b")], freedBytes: 7, logPath: "/logs/storage-cleanup.ndjson" },
      ]),
    ).toEqual({
      results: [outcome("a"), outcome("b")],
      freedBytes: 12,
      logPath: "/logs/storage-cleanup.ndjson",
    });
  });

  it("totals each kind with what cleanup could free", () => {
    expect(
      storageTotals(items).map(({ kind, count, bytes, removableBytes }) => [
        kind,
        count,
        bytes,
        removableBytes,
      ]),
    ).toEqual([
      ["worktree", 2, 4 * 1024, 3 * 1024],
      ["build_output", 1, 1024, 1024],
      ["runtime_version", 1, 0, 0],
      ["kache", 1, 1024, 0],
    ]);
  });

  it("describes free space from the live reading when the host streams one", () => {
    const GB = 1024 ** 3;
    expect(
      diskSummary({ path: "/", availableBytes: 100 * GB, totalBytes: 1000 * GB }, null),
    ).toEqual({
      text: "100 GB free of 1000 GB (10%)",
      level: null,
    });
    expect(
      diskSummary(null, {
        path: "/",
        availableBytes: 40 * GB,
        totalBytes: 2000 * GB,
        level: "elevated",
        since: "2026-10-25T00:00:00.000Z",
      }),
    ).toEqual({ text: "40.0 GB free of 1.95 TB (2%)", level: "elevated" });
    expect(diskSummary(null, null).level).toBeNull();
  });
});
