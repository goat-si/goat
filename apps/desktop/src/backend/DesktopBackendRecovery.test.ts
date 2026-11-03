// @effect-diagnostics nodeBuiltinImport:off -- The fixture joins its isolated temporary path.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePath from "node:path";
import { makeRecoveryBudget } from "./DesktopBackendRecovery.ts";

it.effect(
  "six ready-then-fail generations persist pause across parent construction and manual Retry resets only the record",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-recovery-" });
        const path = NodePath.join(dir, "owner.json");
        const owner = yield* makeRecoveryBudget();
        yield* owner.initialize(path);
        for (let failure = 0; failure < 6; failure++)
          yield* owner.fail(1000 + failure, `run-${failure}`, "exit80");
        assert.equal((yield* owner.current).pause, "crash-loop");
        const next = yield* makeRecoveryBudget();
        yield* next.initialize(path);
        assert.equal((yield* next.current).pause, "crash-loop");
        assert.isTrue(yield* next.reset);
        const retried = yield* makeRecoveryBudget();
        yield* retried.initialize(path);
        assert.equal((yield* retried.current).pause, null);
        assert.deepEqual((yield* retried.current).attempts, []);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("record write failure disables automatic restart", () =>
  Effect.gen(function* () {
    const owner = yield* makeRecoveryBudget();
    yield* owner.initialize("/isolated/owner.json");
    assert.equal((yield* owner.fail(1, "A", "exit80")).record.pause, "record-unavailable");
  }).pipe(Effect.provide(FileSystem.layerNoop({}))),
);

it.effect("bounded crash history survives reset and reload and old records still load", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = NodePath.join(yield* fs.makeTempDirectoryScoped(), "owner.json");
      yield* fs.writeFileString(
        path,
        '{"version":1,"attempts":[],"attempt":0,"lastWallTime":0,"pause":null,"generation":"","outcome":""}',
      );
      const owner = yield* makeRecoveryBudget();
      yield* owner.initialize(path);
      for (let n = 0; n < 21; n++) {
        yield* owner.fail(n * 700_000, String(n), "x".repeat(256));
        yield* owner.reset;
      }
      const contents = yield* fs.readFileString(path);
      const oldSchema = Schema.Struct({
        version: Schema.Literal(1),
        attempts: Schema.Array(Schema.Number),
        attempt: Schema.Number,
        lastWallTime: Schema.Number,
        pause: Schema.NullOr(Schema.String),
        generation: Schema.String,
        outcome: Schema.String,
      });
      const old = yield* Schema.decodeEffect(Schema.fromJsonString(oldSchema))(contents);
      assert.isFalse("history" in old);
      assert.isBelow(new TextEncoder().encode(contents).length, 4096);
      const next = yield* makeRecoveryBudget();
      yield* next.initialize(path);
      assert.equal((yield* next.current).history?.length, 8);
      assert.equal((yield* next.current).notifiedKey, "x".repeat(64));
      assert.isFalse((yield* next.fail(21 * 700_000, "next", "x".repeat(256))).notify);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a fourth exit after a lapse notifies even when its key is unchanged", () =>
  Effect.gen(function* () {
    const owner = yield* makeRecoveryBudget();
    for (const n of [0, 1, 2, 3]) yield* owner.fail(n * 60_000, "a", "same");
    assert.isTrue((yield* owner.fail(6 * 60 * 60_000 + 1, "b", "same")).notify);
  }).pipe(Effect.provide(FileSystem.layerNoop({}))),
);

it.effect("escaped and multibyte outcomes remain below the recovery record byte limit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = NodePath.join(yield* fs.makeTempDirectoryScoped(), "owner.json");
      const owner = yield* makeRecoveryBudget();
      yield* owner.initialize(path);
      for (let n = 0; n < 8; n++) {
        yield* owner.fail(
          n * 700_000,
          "\u0001".repeat(128),
          ("\u0001".repeat(32) + "😀".repeat(32)).repeat(4),
        );
        yield* owner.reset;
      }
      yield* owner.fail(
        8 * 700_000,
        "\u0001".repeat(128),
        ("\u0001".repeat(32) + "😀".repeat(32)).repeat(4),
      );
      assert.isAtMost(new TextEncoder().encode(yield* fs.readFileString(path)).length, 4096);
      const next = yield* makeRecoveryBudget();
      yield* next.initialize(path);
      assert.isNull((yield* next.current).pause);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
