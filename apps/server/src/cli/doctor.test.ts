import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { tryAcquireServerOwnerLock } from "../serverOwnerLockFile.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import * as TestClock from "effect/testing/TestClock";

import * as BootService from "../cloud/bootService.ts";
import { runDoctor } from "./doctor.ts";
import { DatabaseMaintenance } from "../persistence/DatabaseMaintenance.ts";

it.effect(
  "--fix reclaims space with the service paused and keeps the V1 database, and --dry-run changes nothing",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-doctor-" });
      const calls: string[] = [];
      const doctor = (dryRun: boolean) =>
        runDoctor(path.join(root, "statev2.sqlite"), {
          fix: true,
          dryRun,
          interactive: false,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeServices.layer,
              Layer.mock(BootService.BootService)({
                withStopped: (operation) =>
                  Effect.sync(() => calls.push("pause")).pipe(
                    Effect.andThen(operation),
                    Effect.ensuring(Effect.sync(() => calls.push("resume"))),
                  ),
              }),
              Layer.succeed(DatabaseMaintenance, {
                inspect: () =>
                  Effect.succeed({
                    databaseBytes: 2000,
                    reclaimableBytes: 1000,
                    incrementalVacuumEnabled: false,
                    legacyDatabaseBytes: 4000,
                  }),
                compact: () =>
                  Effect.sync(() => {
                    calls.push("compact");
                    return {
                      beforeBytes: 2000,
                      afterBytes: 1000,
                      deletedEventCount: 1,
                      deletedReceiptCount: 0,
                    };
                  }),
                removeLegacyDatabase: () => Effect.sync(() => calls.push("remove legacy")),
              }),
            ),
          ),
        );
      yield* doctor(true);
      assert.deepEqual(calls, []);
      yield* doctor(false);
      assert.deepEqual(calls, ["pause", "compact", "resume"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("warns how long reclaiming can take and reports each step with its elapsed time", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-doctor-" });
    const output: string[] = [];
    const steps = [
      ["prune-events", "65 seconds"],
      ["vacuum", "701 seconds"],
      ["rebuild-search", "1 second"],
      ["checkpoint", "1 second"],
    ] as const;
    yield* runDoctor(path.join(root, "statev2.sqlite"), {
      fix: true,
      dryRun: false,
      interactive: false,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(BootService.BootService)({
            withStopped: (operation) =>
              Effect.sync(() => output.push("<pause>")).pipe(
                Effect.andThen(operation),
                Effect.ensuring(Effect.sync(() => output.push("<resume>"))),
              ),
          }),
          Layer.succeed(DatabaseMaintenance, {
            inspect: () =>
              Effect.succeed({
                databaseBytes: 12.8 * 1024 ** 3,
                reclaimableBytes: 0,
                incrementalVacuumEnabled: false,
                legacyDatabaseBytes: null,
              }),
            compact: (_databasePath, onStep) =>
              Effect.gen(function* () {
                for (const [step, duration] of steps) {
                  if (onStep) yield* onStep(step);
                  yield* TestClock.adjust(duration);
                }
                return {
                  beforeBytes: 12.8 * 1024 ** 3,
                  afterBytes: 12.8 * 1024 ** 3,
                  deletedEventCount: 0,
                  deletedReceiptCount: 0,
                };
              }),
            removeLegacyDatabase: () => Effect.void,
          }),
        ),
      ),
      Effect.provideService(Console.Console, {
        ...globalThis.console,
        log: (...args: ReadonlyArray<unknown>) => {
          output.push(...args.join(" ").split("\n"));
        },
      }),
    );

    const paused = output.indexOf("<pause>");
    const resumed = output.indexOf("<resume>");
    assert.isAbove(paused, -1, "the repair must run with the service paused");
    const beforePause = output.slice(0, paused).join("\n");
    const description = beforePause.slice(beforePause.indexOf("Reclaim database space"));
    assert.include(description, "12.80 GiB", "the repair must state the database size up front");
    assert.match(description, /hour/, "the repair must warn it can take over an hour");
    const progress = output
      .slice(paused + 1, resumed)
      .filter((line) => line.trim() !== "" && !line.trim().startsWith("Done"))
      .map((line) => /\[(\d+:\d{2})\]/.exec(line)?.[1] ?? `unprefixed: ${line}`);
    assert.deepEqual(
      progress,
      ["0:00", "1:05", "12:46", "12:47"],
      "each compaction step must print one line with the elapsed time as it starts",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("holds server ownership throughout offline compaction and releases it afterward", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-doctor-lock-" });
    let lockedDuringCompact = false;
    const compact = () =>
      Effect.sync(() => {
        const competing = tryAcquireServerOwnerLock(root, "server:test");
        lockedDuringCompact = competing === undefined;
        competing?.release();
        return { beforeBytes: 10, afterBytes: 5, deletedEventCount: 0, deletedReceiptCount: 0 };
      });
    yield* runDoctor(path.join(root, "statev2.sqlite"), {
      fix: true,
      dryRun: false,
      interactive: false,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(BootService.BootService)({ withStopped: (operation) => operation }),
          Layer.succeed(DatabaseMaintenance, {
            inspect: () =>
              Effect.succeed({
                databaseBytes: 10,
                reclaimableBytes: 1,
                incrementalVacuumEnabled: false,
                legacyDatabaseBytes: null,
              }),
            compact,
            removeLegacyDatabase: () => Effect.void,
          }),
        ),
      ),
    );
    assert.isTrue(lockedDuringCompact);
    const after = tryAcquireServerOwnerLock(root, "server:test");
    assert.isDefined(after);
    after?.release();
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refuses compaction while another server owns the home", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-doctor-busy-" });
    const holder = tryAcquireServerOwnerLock(root, "server:test");
    assert.isDefined(holder);
    const state = yield* makePersistedServerRuntimeState({
      config: { host: undefined, devUrl: undefined },
      port: 3773,
    });
    yield* persistServerRuntimeState({ path: path.join(root, "server-runtime.json"), state });
    yield* Effect.addFinalizer(() => Effect.sync(() => holder?.release()));
    let compacted = false;
    const result = yield* runDoctor(path.join(root, "statev2.sqlite"), {
      fix: true,
      dryRun: false,
      interactive: false,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(BootService.BootService)({ withStopped: (operation) => operation }),
          Layer.succeed(DatabaseMaintenance, {
            inspect: () =>
              Effect.succeed({
                databaseBytes: 10,
                reclaimableBytes: 1,
                incrementalVacuumEnabled: false,
                legacyDatabaseBytes: null,
              }),
            compact: () =>
              Effect.sync(() => {
                compacted = true;
                return {
                  beforeBytes: 10,
                  afterBytes: 5,
                  deletedEventCount: 0,
                  deletedReceiptCount: 0,
                };
              }),
            removeLegacyDatabase: () => Effect.void,
          }),
        ),
      ),
      Effect.result,
    );
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure")
      assert.include(result.failure.message, `GOAT server process ${state.pid}`);
    assert.isFalse(compacted);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
