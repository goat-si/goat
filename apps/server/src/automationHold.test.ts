import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { AUTOMATION_HOLD_FILE_NAME, encodeAutomationHold } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as AutomationHold from "./automationHold.ts";

const hold = { reason: "channel-copy", heldAt: "2026-10-25T00:00:00.000Z" } as const;

const withStateDir = <A, E, R>(
  run: (input: { readonly stateDir: string; readonly holdPath: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-automation-hold-" });
    return yield* run({ stateDir, holdPath: path.join(stateDir, AUTOMATION_HOLD_FILE_NAME) });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("AutomationHold", () => {
  it.effect("holds nothing on a state directory without a hold file", () =>
    withStateDir(({ stateDir }) =>
      Effect.gen(function* () {
        const service = yield* AutomationHold.makeFromStateDir(stateDir);
        assert.equal(yield* service.current, null);
        yield* service.awaitRelease;
      }),
    ),
  );

  it.effect("holds a copied state until release removes the file and wakes waiters", () =>
    withStateDir(({ stateDir, holdPath }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(holdPath, encodeAutomationHold(hold));
        const service = yield* AutomationHold.makeFromStateDir(stateDir);
        assert.deepEqual(yield* service.current, hold);
        const waiter = yield* service.awaitRelease.pipe(Effect.forkChild);

        yield* service.release;

        yield* Fiber.join(waiter);
        assert.equal(yield* service.current, null);
        assert.isFalse(yield* fs.exists(holdPath));
        // A restart reads the removed file and stays resumed; a second release is a no-op.
        assert.equal(yield* (yield* AutomationHold.makeFromStateDir(stateDir)).current, null);
        yield* service.release;
      }),
    ),
  );

  it.effect("keeps holding when the hold file cannot be decoded", () =>
    withStateDir(({ stateDir, holdPath }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(holdPath, "{not json");
        const service = yield* AutomationHold.makeFromStateDir(stateDir);
        assert.notEqual(yield* service.current, null);
      }),
    ),
  );

  it.effect("stays held when the release cannot remove the file", () =>
    withStateDir(({ stateDir, holdPath }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(holdPath, encodeAutomationHold(hold));
        const service = yield* AutomationHold.makeFromStateDir(stateDir);
        // A directory in its place makes the removal fail without depending on file modes.
        yield* fs.remove(holdPath);
        yield* fs.makeDirectory(holdPath);
        yield* fs.writeFileString(`${holdPath}/keep`, "");

        const exit = yield* Effect.exit(service.release);

        assert.isTrue(Exit.isFailure(exit));
        assert.deepEqual(yield* service.current, hold);
      }),
    ),
  );
});
