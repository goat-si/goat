import { assert, it } from "@effect/vitest";
import { CommandId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";

import { countHostThreads } from "../../mcp/hostStatusModel.ts";
import * as CommandReceiptStore from "../CommandReceiptStore.ts";
import * as ThreadLaunch from "../ThreadLaunchService.ts";
import * as ThreadManagement from "../ThreadManagementService.ts";
import { makeHarness } from "../testkit/ThreadLaunchHarness.ts";
import { launchInput } from "../testkit/threadLaunchInput.ts";
import { CommitGuard, CommitGuardRefused, type CommitGuardSelector } from "./CommitGuard.ts";

const harnessLayer = (database?: "file") =>
  Layer.provideMerge(
    CommandReceiptStore.layer,
    makeHarness({
      runSetup: () => Effect.never,
      ...(database === "file"
        ? {
            databaseLayer: SqlitePersistence.layerFromPath(
              NodePath.join(
                NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "commit-guard-")),
                "state.sqlite",
              ),
            ).pipe(Layer.provide(NodeServices.layer)),
          }
        : {}),
    }).layer,
  );

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE guard_marks (command_id TEXT PRIMARY KEY, running INTEGER NOT NULL)`;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const running = threads
    .listProjectThreads({ projectId: undefined, includeSubagents: true })
    .pipe(Effect.map((shells) => countHostThreads(shells).running));
  const marks = sql<{ command_id: string; running: number }>`SELECT * FROM guard_marks`;
  return { sql, threads, running, marks };
});

it.effect(
  "a guard refusal on thread.create rolls back the thread, its receipt and the guard's own write",
  () =>
    Effect.gen(function* () {
      const { sql, threads, marks } = yield* setup;
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      const guard: CommitGuardSelector = ({ commandType, commandId }) =>
        commandType === "thread.create"
          ? () =>
              Effect.gen(function* () {
                yield* sql`INSERT INTO guard_marks VALUES (${commandId}, 0)`.pipe(Effect.orDie);
                return yield* new CommitGuardRefused({ reason: "fenced" });
              })
          : undefined;
      const failed = yield* launches
        .launch(launchInput({ command: "cmd:refused", thread: "thread:refused", message: "go" }))
        .pipe(Effect.provideService(CommitGuard, guard), Effect.flip);
      assert.propertyVal(failed, "operation", "create-thread");
      assert.isNull(yield* threads.getThreadShell(ThreadId.make("thread:refused")));
      assert.isTrue(Option.isNone(yield* receipts.getByCommandId(CommandId.make("cmd:refused"))));
      assert.deepEqual(yield* marks, []);
    }).pipe(Effect.provide(harnessLayer())),
);

it.effect.each(["memory", "file"] as const)(
  "the initial message's guard sees the preparing run counted inside the same transaction (%s database)",
  (database) =>
    Effect.gen(function* () {
      const { sql, running, marks } = yield* setup;
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      // Fibers the launch forks inherit the reference, so a selector matches its own command ids.
      const guard: CommitGuardSelector = ({ commandType, commandId }) =>
        commandId !== "cmd:counted" && commandId !== "cmd:counted:initial-message"
          ? undefined
          : () =>
              Effect.gen(function* () {
                yield* Ref.update(calls, (all) => [...all, commandType]);
                if (commandType !== "message.dispatch") return;
                const seen = yield* running.pipe(Effect.orDie);
                yield* sql`INSERT INTO guard_marks VALUES (${commandId}, ${seen})`.pipe(
                  Effect.orDie,
                );
              });
      assert.equal(yield* running.pipe(Effect.orDie), 0);
      const input = launchInput({
        command: "cmd:counted",
        thread: "thread:counted",
        message: "go",
      });
      yield* launches.launch(input).pipe(Effect.provideService(CommitGuard, guard));
      assert.deepEqual(yield* marks, [{ command_id: "cmd:counted:initial-message", running: 1 }]);
      assert.equal(yield* running.pipe(Effect.orDie), 1);
      assert.deepEqual(yield* Ref.get(calls), ["thread.create", "message.dispatch"]);
      // A replay of the whole launch commits nothing new, so the guard never runs again.
      yield* launches.launch(input).pipe(Effect.provideService(CommitGuard, guard));
      assert.deepEqual(yield* Ref.get(calls), ["thread.create", "message.dispatch"]);
    }).pipe(Effect.provide(harnessLayer(database === "file" ? "file" : undefined))),
);

it.effect(
  "a guard refusal on the initial message leaves the thread idle with no run and nothing counted",
  () =>
    Effect.gen(function* () {
      const { sql, threads, running, marks } = yield* setup;
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      const guard: CommitGuardSelector = ({ commandType, commandId }) =>
        commandType === "message.dispatch"
          ? () =>
              Effect.gen(function* () {
                yield* sql`INSERT INTO guard_marks VALUES (${commandId}, 1)`.pipe(Effect.orDie);
                return yield* new CommitGuardRefused({ reason: "fenced" });
              })
          : undefined;
      const failed = yield* launches
        .launch(launchInput({ command: "cmd:late", thread: "thread:late", message: "go" }))
        .pipe(Effect.provideService(CommitGuard, guard), Effect.flip);
      assert.propertyVal(failed, "operation", "dispatch-message");
      const shell = yield* threads.getThreadShell(ThreadId.make("thread:late"));
      assert.isNotNull(shell);
      assert.isNull(shell?.latestRunId ?? null);
      assert.equal(yield* running.pipe(Effect.orDie), 0);
      assert.isTrue(
        Option.isNone(yield* receipts.getByCommandId(CommandId.make("cmd:late:initial-message"))),
      );
      assert.deepEqual(yield* marks, []);
    }).pipe(Effect.provide(harnessLayer())),
);
