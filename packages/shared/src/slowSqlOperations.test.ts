import { assert, it } from "vite-plus/test";
import { measureNativeSql, recordSlowSql, recentSlowSql } from "./slowSqlOperations.ts";

it("bounds and expires slow SQL evidence without retaining SQL or bindings", () => {
  const completedAtMs = 9_000_000_000_000;
  for (let index = 0; index < 70; index++) {
    recordSlowSql({
      connection: "writer",
      operation: "execute",
      owner: `ProjectionStore.apply:${index}`,
      nativeMs: 51,
      completedAtMs,
    });
  }
  for (const nativeMs of [49, Number.NaN, Number.POSITIVE_INFINITY]) {
    recordSlowSql({
      connection: "reader",
      operation: "execute",
      owner: "fast",
      nativeMs,
      completedAtMs,
    });
  }
  const records = recentSlowSql(completedAtMs);
  assert.lengthOf(records, 64);
  assert.equal(records[0]?.owner, "ProjectionStore.apply:6");
  assert.equal(records.at(-1)?.owner, "ProjectionStore.apply:69");
  assert.deepEqual(recentSlowSql(completedAtMs - 1), []);
  assert.lengthOf(recentSlowSql(completedAtMs + 60_000), 64);
  assert.deepEqual(recentSlowSql(completedAtMs + 60_001), []);
  assert.deepEqual(Object.keys(records[0] ?? {}).sort(), [
    "completedAtMs",
    "connection",
    "nativeMs",
    "operation",
    "owner",
  ]);
  recordSlowSql({
    connection: "reader",
    operation: "prepare",
    owner: "x".repeat(200),
    nativeMs: 50,
    completedAtMs,
  });
  assert.equal(recentSlowSql(completedAtMs).at(-1)?.owner.length, 160);
});

it("preserves the return value and original native failure", () => {
  const operation = { connection: "writer", operation: "execute", owner: "test.native" } as const;
  const result = {};
  assert.strictEqual(
    measureNativeSql(operation, () => result),
    result,
  );
  const failure = new Error("native failure");
  assert.throws(
    () =>
      measureNativeSql(operation, () => {
        throw failure;
      }),
    failure,
  );
});
