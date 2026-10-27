import * as Effect from "effect/Effect";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { makeWorkerRateLimits } from "./RelayRateLimits.ts";
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

it.effect(
  "production Worker rate keys isolate stage, account and publishing environment while bindings deny closed on outages",
  () =>
    Effect.gen(function* () {
      const calls: { binding: string; key: string }[] = [];
      let mode: "allow" | "deny" | "outage" = "allow";
      const limit = (binding: string, key: string) =>
        Effect.suspend(() => {
          calls.push({ binding, key });
          return mode === "outage"
            ? Effect.fail("fixture outage")
            : Effect.succeed({ success: mode === "allow" });
        });
      const bindings = (stage: string) => ({
        stage,
        hourly: (key: string) =>
          limit("hourly", key).pipe(
            Effect.map((result) => ({ allowed: result.success, retryAfterSeconds: 42 })),
          ),
        mobile: (key: string) => limit("mobile", key),
        publish: (key: string) => limit("publish", key),
      });
      const rates = yield* makeWorkerRateLimits(bindings("prod"));
      yield* rates.charge({ userId: "owner", operation: "link" });
      yield* rates.charge({ userId: "owner", operation: "connect" });
      yield* rates.charge({ userId: "owner", operation: "mobile_registration" });
      expect(calls[0]?.key).toBe(calls[1]?.key);
      expect(calls[0]?.key).toBe(calls[2]?.key);
      expect(calls[0]?.key).toMatch(/^[0-9a-f]{64}$/);
      yield* rates.charge({ userId: "other", operation: "link" });
      expect(calls[3]?.key).not.toBe(calls[0]?.key);
      yield* rates.charge({
        userId: "owner",
        operation: "activity_publish",
        environmentId: "a:b",
        environmentPublicKey: "c",
      });
      yield* rates.charge({
        userId: "owner",
        operation: "activity_publish",
        environmentId: "a",
        environmentPublicKey: "b:c",
      });
      expect(calls[4]?.key).not.toBe(calls[5]?.key);
      const preview = yield* makeWorkerRateLimits(bindings("preview"));
      yield* preview.charge({ userId: "owner", operation: "link" });
      expect(calls[6]?.key).not.toBe(calls[0]?.key);
      for (const operation of ["link", "mobile_registration", "activity_publish"] as const) {
        mode = "deny";
        expect(yield* Effect.flip(rates.charge({ userId: "owner", operation }))).toMatchObject({
          _tag: "RelayRateLimitExceededError",
          operation,
          retryAfterSeconds: operation === "link" ? 42 : 60,
        });
        mode = "outage";
        expect((yield* Effect.flip(rates.charge({ userId: "owner", operation })))._tag).toBe(
          "RelayAuthorizationUnavailableError",
        );
      }
    }).pipe(Effect.provide(NodeCrypto.layer)),
);
