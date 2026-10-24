import { assert, it } from "@effect/vitest";
import { OrchestratorMcpFailure, ThreadId } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as LaunchWatchService from "../mcp/LaunchWatchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import Migration0062 from "../persistence/Migrations/070_RemoteReports.ts";
import Migration0063 from "../persistence/Migrations/071_RemoteDispatches.ts";
import Migration0065 from "../persistence/Migrations/073_RemoteDispatchQuestions.ts";
import Migration0068 from "../persistence/Migrations/075_RemoteReportRelay.ts";
import Migration0073 from "../persistence/Migrations/080_MemoryTaskGrantCeiling.ts";
import Migration0089 from "../persistence/Migrations/093_RemoteDispatchObservation.ts";
import Migration0101 from "../persistence/Migrations/102_RemoteReportInboxRunId.ts";
import * as Ssh from "../sshRemote/SshRemoteDispatch.ts";
import * as Coordinator from "./RemoteDispatchCoordinator.ts";

const isRemoteDispatchError = Schema.is(Coordinator.RemoteDispatchError);
const origin = ThreadId.make("pre-send-origin");

/** The smallest launch harness: dispatch migrations plus an ssh launch that fails as told. */
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const migration of [Migration0062, Migration0063, Migration0065, Migration0068])
    yield* migration;
  yield* sql`CREATE TABLE scheduled_tasks (task_id TEXT PRIMARY KEY)`;
  for (const migration of [Migration0073, Migration0089, Migration0101]) yield* migration;
  let launchError: Ssh.SshRemoteDispatchError | undefined;
  const dependencies = Layer.mergeAll(
    Layer.succeed(SqlClient.SqlClient, sql),
    Layer.mock(LaunchWatchService.LaunchWatchService)({}),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(liveThreadShell(origin)),
    }),
    Layer.mock(Ssh.SshRemoteDispatch)({
      launchThread: (_input, check) =>
        Effect.gen(function* () {
          yield* check;
          if (launchError !== undefined) return yield* launchError;
          return yield* Effect.die("The fixture expects every launch to fail.");
        }),
    }),
  );
  return {
    layer: Coordinator.layer.pipe(Layer.provide(dependencies)),
    failLaunch: (value: Ssh.SshRemoteDispatchError) => {
      launchError = value;
    },
  };
});

const database = NodeSqliteClient.layer({ filename: ":memory:" });

const launchThread = (
  coordinator: Coordinator.RemoteDispatchCoordinator["Service"],
  beforeLaunch: Effect.Effect<void, OrchestratorMcpFailure> = Effect.void,
) =>
  coordinator.launch(
    {
      kind: "thread",
      originThreadId: origin,
      delivery: "wake",
      launch: {
        host: "box",
        cwd: "/fixture",
        workspace: { type: "cwd" },
        title: "fixture",
        runtimeMode: "full-access",
        callerRuntimeMode: "full-access",
      },
    },
    beforeLaunch,
  );

it.effect("a beforeLaunch refusal deletes the row and wraps the failure as authorize", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const coordinator = yield* Coordinator.RemoteDispatchCoordinator;
      const refusal = new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "fixture refusal",
      });
      const refused = yield* launchThread(coordinator, Effect.fail(refusal)).pipe(Effect.result);
      // Proven pre-send: the surfaces recognize the wrap and release their reservations,
      // while the cause keeps the refusal the caller should see.
      assert.equal(refused._tag, "Failure");
      if (refused._tag !== "Failure") return;
      assert.isTrue(isRemoteDispatchError(refused.failure));
      if (!isRemoteDispatchError(refused.failure)) return;
      assert.equal(refused.failure.stage, "authorize");
      assert.strictEqual(refused.failure.cause, refusal);
      assert.equal((yield* coordinator.listForOrigin(origin)).length, 0);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(database)),
);

it.effect("a remote refusal before the launch lands deletes the row and wraps as authorize", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.failLaunch(new Ssh.SshRemoteDispatchError({ reason: "remote_refused", message: "no" }));
    yield* Effect.gen(function* () {
      const coordinator = yield* Coordinator.RemoteDispatchCoordinator;
      const refused = yield* launchThread(coordinator).pipe(Effect.result);
      assert.equal(refused._tag, "Failure");
      if (refused._tag !== "Failure") return;
      assert.isTrue(isRemoteDispatchError(refused.failure));
      if (!isRemoteDispatchError(refused.failure)) return;
      assert.equal(refused.failure.stage, "authorize");
      assert.instanceOf(refused.failure.cause, Ssh.SshRemoteDispatchError);
      assert.equal((yield* coordinator.listForOrigin(origin)).length, 0);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(database)),
);

it.effect("a refusal flagged launchMayHaveStarted keeps the row lost and arrives unwrapped", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    // The launch call landed but its acknowledgement did not: nothing here proves the remote
    // thread does not exist, so the row stays as lost and no pre-send wrap applies.
    const uncertainty = new Ssh.SshRemoteDispatchError({
      reason: "remote_refused",
      message: "no thread acknowledgement",
      launchMayHaveStarted: true,
    });
    f.failLaunch(uncertainty);
    yield* Effect.gen(function* () {
      const coordinator = yield* Coordinator.RemoteDispatchCoordinator;
      const refused = yield* launchThread(coordinator).pipe(Effect.result);
      assert.equal(refused._tag, "Failure");
      if (refused._tag !== "Failure") return;
      assert.strictEqual(refused.failure, uncertainty);
      const records = yield* coordinator.listForOrigin(origin);
      assert.equal(records.length, 1);
      assert.equal(records[0]!.state, "lost");
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(database)),
);
