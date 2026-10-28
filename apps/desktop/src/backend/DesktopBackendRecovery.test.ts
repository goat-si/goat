// @effect-diagnostics nodeBuiltinImport:off -- The fixture joins its isolated temporary path.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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
    assert.equal((yield* owner.fail(1, "A", "exit80")).pause, "record-unavailable");
  }).pipe(Effect.provide(FileSystem.layerNoop({}))),
);
