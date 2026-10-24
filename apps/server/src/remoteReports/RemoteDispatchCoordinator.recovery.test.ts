import { assert, it } from "@effect/vitest";
import { RunId, ThreadId } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
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

const origin = ThreadId.make("recovery-origin");
const remoteThread = ThreadId.make("remote-thread");
const id = "channel-child-remote:lost";
const readKey = "4".repeat(64);

type Answer = Effect.Effect<unknown, Ssh.SshRemoteDispatchError>;

/** A coordinator whose host answers resolve as told and refuses to be launched on again. */
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const migration of [Migration0062, Migration0063, Migration0065, Migration0068])
    yield* migration;
  yield* sql`CREATE TABLE scheduled_tasks (task_id TEXT PRIMARY KEY)`;
  for (const migration of [Migration0073, Migration0089, Migration0101]) yield* migration;
  const asked: Array<Ssh.SshHostToolCall> = [];
  let answer: Answer = Effect.die("The fixture was not told how to answer resolve.");
  const dependencies = Layer.mergeAll(
    Layer.succeed(SqlClient.SqlClient, sql),
    Layer.mock(LaunchWatchService.LaunchWatchService)({}),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(liveThreadShell(origin)),
    }),
    Layer.mock(Ssh.SshRemoteDispatch)({
      launchThread: () => Effect.die("A lost launch must never be launched again."),
      callHostTool: (call) => {
        if (call.tool !== "goat_origin_resolve_binding") return Effect.never;
        asked.push(call);
        return answer;
      },
    }),
  );
  // A row the origin marked lost, as a restart or a transport failure leaves it.
  const seedLost = (updatedAt: string) =>
    sql`INSERT INTO remote_dispatches (correlation_id, kind, origin_thread_id, host, read_key,
      delivery, state, last_error, created_at, updated_at)
      VALUES (${id}, 'thread', ${origin}, 'box', ${readKey}, 'wake', 'lost',
        'Launch outcome unknown; check goat_thread_list with host.', ${updatedAt}, ${updatedAt})`;
  return {
    layer: Coordinator.layer.pipe(Layer.provide(dependencies)),
    asked,
    answer: (value: Answer) => {
      answer = value;
    },
    seedLost,
    sql,
  };
});

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const LONG_AGO = "1969-12-31T23:00:00.000Z";
const test = <E>(
  name: string,
  body: (
    f: Effect.Success<typeof fixture>,
    coordinator: Coordinator.RemoteDispatchCoordinator["Service"],
  ) => Effect.Effect<void, E>,
) =>
  it.effect(name, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        yield* body(f, yield* Coordinator.RemoteDispatchCoordinator);
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(database)),
  );

test("a lost launch the destination bound and started is rebound with its run, never relaunched", (f, coordinator) =>
  Effect.gen(function* () {
    yield* f.seedLost(LONG_AGO);
    const runId = RunId.make("remote-run");
    f.answer(
      Effect.succeed({
        _tag: "bound",
        threadId: remoteThread,
        originThreadId: origin,
        threadExists: true,
        threadDeleted: false,
        activeRunId: runId,
      }),
    );
    yield* coordinator.resolveLostLaunches;
    // The fence is a write on the destination, authorized only by the row's own read key.
    assert.deepStrictEqual(
      f.asked.map((call) => [call.writes, call.arguments]),
      [[true, { correlationId: id, readKey }]],
    );
    const record = yield* coordinator.get(id);
    assert.strictEqual(record?.state, "running");
    assert.strictEqual(record?.remoteThreadId, remoteThread);
    assert.strictEqual(record?.launchedRunId, runId);
    assert.isNull(record?.lastError);
  }));

test("a fenced launch is recorded cancelled, the one answer that proves nothing ran", (f, coordinator) =>
  Effect.gen(function* () {
    yield* f.seedLost(LONG_AGO);
    f.answer(Effect.succeed({ _tag: "fenced" }));
    yield* coordinator.resolveLostLaunches;
    const record = yield* coordinator.get(id);
    assert.strictEqual(record?.state, "cancelled");
    assert.include(record?.lastError ?? "", "fenced");
  }));

test("an unanswered or unfinished resolve keeps the launch lost and asks again only after a backoff", (f, coordinator) =>
  Effect.gen(function* () {
    yield* f.seedLost(LONG_AGO);
    // An older destination has no resolve tool: absence of an answer proves nothing.
    f.answer(
      Effect.fail(
        new Ssh.SshRemoteDispatchError({ reason: "remote_outdated", message: "Unknown tool" }),
      ),
    );
    yield* coordinator.resolveLostLaunches;
    yield* coordinator.resolveLostLaunches;
    assert.strictEqual(f.asked.length, 1);
    assert.strictEqual((yield* coordinator.get(id))?.state, "lost");
    // Bound, but the thread is not created yet: the launch may still land or unbind.
    f.answer(
      Effect.succeed({
        _tag: "bound",
        threadId: remoteThread,
        originThreadId: origin,
        threadExists: false,
        threadDeleted: false,
        activeRunId: null,
      }),
    );
    yield* TestClock.adjust("5 minutes");
    yield* coordinator.resolveLostLaunches;
    assert.strictEqual(f.asked.length, 2);
    const record = yield* coordinator.get(id);
    assert.strictEqual(record?.state, "lost");
    assert.isNull(record?.remoteThreadId);
  }));

test("a launch lost only moments ago is left alone while it may still bind", (f, coordinator) =>
  Effect.gen(function* () {
    yield* f.seedLost("1970-01-01T00:00:00.000Z");
    f.answer(Effect.succeed({ _tag: "fenced" }));
    yield* coordinator.resolveLostLaunches;
    assert.strictEqual(f.asked.length, 0);
    assert.strictEqual((yield* coordinator.get(id))?.state, "lost");
  }));

test("a thread deleted on the destination is recorded cancelled", (f, coordinator) =>
  Effect.gen(function* () {
    yield* f.seedLost(LONG_AGO);
    f.answer(
      Effect.succeed({
        _tag: "bound",
        threadId: remoteThread,
        originThreadId: origin,
        threadExists: true,
        threadDeleted: true,
        activeRunId: null,
      }),
    );
    yield* coordinator.resolveLostLaunches;
    const record = yield* coordinator.get(id);
    assert.strictEqual(record?.state, "cancelled");
    assert.include(record?.lastError ?? "", "deleted");
  }));

test("a row another writer settles while the destination answers is left as that writer set it", (f, coordinator) =>
  Effect.gen(function* () {
    yield* f.seedLost(LONG_AGO);
    // The answer arrives after another writer already settled the row.
    f.answer(
      f.sql`UPDATE remote_dispatches SET state = 'settled' WHERE correlation_id = ${id}`.pipe(
        Effect.orDie,
        Effect.as({
          _tag: "bound",
          threadId: remoteThread,
          originThreadId: origin,
          threadExists: true,
          threadDeleted: false,
          activeRunId: RunId.make("remote-run"),
        }),
      ),
    );
    yield* coordinator.resolveLostLaunches;
    const record = yield* coordinator.get(id);
    assert.strictEqual(record?.state, "settled");
    assert.isNull(record?.remoteThreadId);
  }));
