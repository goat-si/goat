// @effect-diagnostics nodeBuiltinImport:off - inspect the temporary SQLite spool after a failed batch.
import { describe, expect, it, vi } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { UsageContribution } from "./usageAggregation.ts";
import { UsageHistoryPages } from "./usageHistoryPages.ts";

function contribution(id: number): UsageContribution {
  return {
    bucketId: id,
    record: {
      provider: "claude",
      timestampMs: 1_786_000_000_000,
      model: "claude-fable-5",
      sessionId: "session-a",
      totals: {
        uncachedInputTokens: 2,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 5,
        reasoningTokens: 0,
      },
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: `turn-${id}`,
    },
  };
}

describe("usage contribution spool", () => {
  it("rolls back a failed batch and propagates the error", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "usage-batch-test-"));
    vi.stubEnv("TMPDIR", directory);
    let journalMode: unknown;
    const exec = NodeSqlite.DatabaseSync.prototype.exec;
    using _exec = vi.spyOn(NodeSqlite.DatabaseSync.prototype, "exec").mockImplementation(function (
      this: NodeSqlite.DatabaseSync,
      sql: string,
    ) {
      exec.call(this, sql);
      if (sql.includes("CREATE TABLE pages")) {
        journalMode = this.prepare("PRAGMA journal_mode").get()?.journal_mode;
      }
    });
    const pages = new UsageHistoryPages();
    try {
      const scan = pages.contributions();
      for (let i = 0; i < 14_000; i++) scan.set(`turn-${i}`, contribution(i));
      Array.from(scan.values());
      const spool = NodePath.join(directory, NodeFS.readdirSync(directory)[0]!, "pages.sqlite");
      const db = new NodeSqlite.DatabaseSync(spool, { readOnly: true });
      try {
        const count = () => db.prepare("SELECT count(*) AS count FROM contributions").get()?.count;
        const before = count();
        scan.set("new-row", contribution(14_000));
        const failure = new Error("serialization failed");
        scan.set(
          "bad-row",
          Object.assign(contribution(14_001), {
            toJSON: () => {
              throw failure;
            },
          }),
        );
        expect(() => Array.from(scan.values())).toThrow(failure);
        expect(count()).toBe(before);
        expect(journalMode).toBe("memory");
      } finally {
        db.close();
      }
    } finally {
      pages.close();
      vi.unstubAllEnvs();
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves scan isolation, updates and insertion order across spill batches", () => {
    const pages = new UsageHistoryPages();
    try {
      const scan = pages.contributions();
      const otherScan = pages.contributions();
      const count = 14_000;
      for (let i = 0; i < count; i++) scan.set(`turn-${i}`, contribution(i));

      const first = contribution(-1);
      const last = contribution(-2);
      scan.set("turn-0", first);
      scan.set(`turn-${count - 1}`, last);
      otherScan.set("turn-0", contribution(10));
      expect(scan.get("turn-0")).toEqual(first);
      expect(scan.get(`turn-${count - 1}`)).toEqual(last);
      expect(otherScan.get("turn-0")).toEqual(contribution(10));
      expect(Array.from(scan.values(), ({ bucketId }) => bucketId)).toEqual(
        Array.from({ length: count }, (_, i) => (i === 0 ? -1 : i === count - 1 ? -2 : i)),
      );

      scan.set("discarded", contribution(-3));
      scan.clear();
      expect(Array.from(scan.values())).toEqual([]);
      expect(scan.get("turn-0")).toBeUndefined();
      expect(otherScan.get("turn-0")).toEqual(contribution(10));
      scan.set("turn-0", contribution(5));
      expect(scan.get("turn-0")).toEqual(contribution(5));
    } finally {
      pages.close();
    }
  });
});
