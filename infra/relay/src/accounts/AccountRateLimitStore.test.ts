// @effect-diagnostics nodeBuiltinImport:off -- Isolated persistence tests own synchronous fixture files.
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it, expect } from "@effect/vitest";
import { consumeWindow, type RateStorage } from "./AccountRateLimitStore.ts";
import { HOURLY_OPERATIONS } from "./AccountLimits.ts";

function storage(db: DatabaseSync): RateStorage {
  return {
    sql: {
      exec: (query: string, ...values: ReadonlyArray<string | number>) =>
        db.prepare(query).all(...values),
    },
    transactionSync: (body) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const value = body();
        db.exec("COMMIT");
        return value;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
it("persists each hourly budget across restart and retains usage on clock rollback and policy change", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-rate-"));
  const file = join(root, "state.sqlite");
  try {
    let db = new DatabaseSync(file);
    for (const op of HOURLY_OPERATIONS) {
      expect(consumeWindow(storage(db), op, 1, 100).allowed).toBe(true);
      expect(consumeWindow(storage(db), op, 1, 101)).toEqual({
        allowed: false,
        retryAfterSeconds: 3600,
      });
    }
    db.close();
    db = new DatabaseSync(file);
    for (const op of HOURLY_OPERATIONS) {
      expect(consumeWindow(storage(db), op, 1, -100).allowed).toBe(false);
      expect(consumeWindow(storage(db), op, 2, 200).allowed).toBe(true);
      expect(consumeWindow(storage(db), op, 1, 300).allowed).toBe(false);
      expect(consumeWindow(storage(db), op, 1, 3_600_000).allowed).toBe(true);
    }
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
