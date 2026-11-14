import * as AutomationHold from "../automationHold.ts";
import { assert, it } from "@effect/vitest";
import { ChannelChildWorkId, ChannelTaskId, RunId, ThreadId } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as ChildStore from "../channels/channelChildWorkStore.ts";
import * as Inbox from "./RemoteReportInbox.ts";
import {
  fixture as reportFixture,
  database as reportDatabase,
  origin as reportOrigin,
  remote as reportRemote,
  runId as reportRun,
  report as makeReport,
  answer as reportAnswer,
} from "./RemoteDispatchCoordinator.testkit.ts";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as LaunchWatchService from "../mcp/LaunchWatchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import Migration0062 from "../persistence/Migrations/081_RemoteReports.ts";
import Migration0063 from "../persistence/Migrations/082_RemoteDispatches.ts";
import Migration0065 from "../persistence/Migrations/084_RemoteDispatchQuestions.ts";
import Migration0068 from "../persistence/Migrations/086_RemoteReportRelay.ts";
import Migration0073 from "../persistence/Migrations/091_MemoryTaskGrantCeiling.ts";
import Migration0089 from "../persistence/Migrations/104_RemoteDispatchObservation.ts";
import Migration0101 from "../persistence/Migrations/113_RemoteReportInboxRunId.ts";
import Migration0137 from "../persistence/Migrations/137_RemoteDispatchDeleteIntent.ts";
import Migration0143 from "../persistence/Migrations/143_RemoteDispatchHostOutage.ts";
import { recordUnreachable } from "./remoteDispatchOutage.ts";
import { publicRow } from "./remoteDispatchModel.ts";
import { decodeRemoteDispatchRows } from "./remoteDispatchRow.ts";
import {
  probeUnreachableThreads,
  reopenUnreachable,
  resolveLostThreadLaunches,
} from "./remoteDispatchRecovery.ts";
import * as Ssh from "../sshRemote/SshRemoteDispatch.ts";
import { withLinkedHost } from "../sshRemote/testkit/LinkedHostFixture.ts";
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
  yield* Migration0137;
  yield* Migration0143;
  const notices: Array<string> = [];
  let reportsAnswer = false;
  const asked: Array<Ssh.SshHostToolCall> = [];
  let answer: Answer = Effect.die("The fixture was not told how to answer resolve.");
  const dependencies = Layer.mergeAll(
    Layer.succeed(SqlClient.SqlClient, sql),
    Layer.mock(LaunchWatchService.LaunchWatchService)({}),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(liveThreadShell(origin)),
      dispatch: (command) =>
        Effect.sync(() => {
          if (command.type === "message.dispatch") notices.push(command.text);
          return { sequence: 1, storedEvents: [] };
        }),
    }),
    Layer.mock(Ssh.SshRemoteDispatch)({
      launchThread: () => Effect.die("A lost launch must never be launched again."),
      callHostTool: (call) => {
        if (call.tool === "goat_origin_reports_wait") return reportsAnswer ? answer : Effect.never;
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
    dependencies,
    notices,
    answerReports: () => {
      reportsAnswer = true;
    },
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

it.effect("lost launch jitter preserves the age fence and varies retry eligibility", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    let draws = 0;
    yield* f.seedLost("1970-01-01T00:00:00.000Z");
    f.answer(
      Effect.fail(
        new Ssh.SshRemoteDispatchError({
          reason: "host_unavailable",
          message: "fixture",
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const coordinator = yield* Coordinator.RemoteDispatchCoordinator;
      yield* TestClock.adjust("599999 millis");
      yield* coordinator.resolveLostLaunches;
      assert.lengthOf(f.asked, 0);
      assert.equal(draws, 0);
      yield* TestClock.adjust("1 milli");
      yield* coordinator.resolveLostLaunches;
      assert.lengthOf(f.asked, 1);
      yield* TestClock.adjust("149999 millis");
      yield* coordinator.resolveLostLaunches;
      assert.lengthOf(f.asked, 1);
      yield* TestClock.adjust("1 milli");
      yield* coordinator.resolveLostLaunches;
      assert.lengthOf(f.asked, 2);
      yield* TestClock.adjust("224999 millis");
      yield* coordinator.resolveLostLaunches;
      assert.lengthOf(f.asked, 2);
      yield* TestClock.adjust("1 milli");
      yield* coordinator.resolveLostLaunches;
      assert.lengthOf(f.asked, 3);
      assert.equal(draws, 3);
      assert.equal((yield* coordinator.get(id))?.state, "lost");
      assert.isNull((yield* coordinator.get(id))?.remoteThreadId);
    }).pipe(
      Effect.provide(f.layer),
      Effect.provideService(Random.Random, {
        nextIntUnsafe: () => 0,
        nextDoubleUnsafe: () => (draws++ === 0 ? 0 : 0.5),
      }),
    );
  }).pipe(Effect.provide(database)),
);

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

it.effect("held: no lost launch resolution sends; release: the timer fences it", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const hold = yield* AutomationHold.makeInMemory({
      reason: "channel-copy",
      heldAt: "2026-10-25T00:00:00.000Z",
    });
    yield* f.seedLost(LONG_AGO);
    f.answer(Effect.succeed({ _tag: "fenced" }));
    yield* Effect.gen(function* () {
      const coordinator = yield* Coordinator.RemoteDispatchCoordinator;
      yield* TestClock.adjust("1 minute");
      assert.lengthOf(f.asked, 0);
      yield* hold.release;
      yield* TestClock.adjust("1 minute");
      assert.lengthOf(f.asked, 1);
      assert.strictEqual((yield* coordinator.get(id))?.state, "cancelled");
    }).pipe(Effect.provide(f.layer), Effect.provideService(AutomationHold.AutomationHold, hold));
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

const offline = Effect.fail(
  new Ssh.SshRemoteDispatchError({ reason: "host_unavailable", message: "offline" }),
);
const resolve = () => resolveLostThreadLaunches({ retryAt: new Map(), start: () => Effect.void });
const ended = (f: Effect.Success<typeof fixture>) => f.sql`UPDATE remote_dispatches SET
  end_reason = 'host_unreachable', ended_at = '1969-12-31T23:30:00.000Z',
  host_unavailable_since = '1969-12-31T22:00:00.000Z', host_last_failed_at = '1969-12-31T23:00:00.000Z'
  WHERE correlation_id = ${id}`;

it.effect(
  "regression #3092: an unknown launch whose host stays unreachable for a day ends and tells its origin once",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.seedLost(LONG_AGO);
      f.answer(offline);
      yield* Effect.gen(function* () {
        yield* resolve();
        for (let i = 0; i < 144; i++) {
          yield* TestClock.adjust("10 minutes");
          yield* resolve();
        }
        const rows = yield* f.sql<{
          end_reason: string | null;
          ended_at: string | null;
        }>`SELECT end_reason, ended_at FROM remote_dispatches WHERE correlation_id = ${id}`;
        assert.equal(rows[0]?.end_reason, "host_unreachable");
        assert.isNotNull(rows[0]?.ended_at);
        assert.lengthOf(f.notices, 1);
        assert.include(f.notices[0], "the launch may still start there");
        yield* resolve();
        assert.lengthOf(f.notices, 1);
      }).pipe(Effect.provide(f.dependencies));
    }).pipe(Effect.provide(database)),
);

it.effect.each(["fenced", "bound"] as const)(
  "regression #3092: an ended unknown launch is fenced or rebound when its host answers again (%s)",
  (kind) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.seedLost(LONG_AGO);
      yield* ended(f);
      f.answer(
        Effect.succeed(
          kind === "fenced"
            ? { _tag: "fenced" }
            : {
                _tag: "bound",
                threadId: remoteThread,
                originThreadId: origin,
                threadExists: true,
                threadDeleted: false,
                activeRunId: null,
              },
        ),
      );
      yield* resolve().pipe(Effect.provide(f.dependencies));
      const rows = yield* f.sql<{
        state: string;
        remote_thread_id: string | null;
        end_reason: string | null;
        ended_at: string | null;
        host_unavailable_since: string | null;
        host_last_failed_at: string | null;
      }>`SELECT state, remote_thread_id, end_reason, ended_at, host_unavailable_since, host_last_failed_at FROM remote_dispatches WHERE correlation_id = ${id}`;
      assert.deepStrictEqual(rows[0], {
        state: kind === "fenced" ? "cancelled" : "running",
        remote_thread_id: kind === "fenced" ? null : remoteThread,
        end_reason: null,
        ended_at: null,
        host_unavailable_since: null,
        host_last_failed_at: null,
      });
    }).pipe(Effect.provide(database)),
);

it.effect(
  "regression #3092: the unreachable-thread probe never reopens an ended launch that has no thread",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.seedLost(LONG_AGO);
      yield* ended(f);
      f.answer(Effect.succeed({ _tag: "fenced" }));
      f.answerReports();
      yield* probeUnreachableThreads({
        retryAt: new Map(),
        reopen: (key) =>
          reopenUnreachable(key).pipe(Effect.provideService(SqlClient.SqlClient, f.sql)),
        start: () => Effect.void,
      }).pipe(Effect.provide(f.dependencies));
      const rows = yield* f.sql<{
        state: string;
      }>`SELECT state FROM remote_dispatches WHERE correlation_id = ${id}`;
      assert.equal(rows[0]?.state, "lost");
      assert.isFalse(yield* reopenUnreachable(id));
    }).pipe(Effect.provide(database)),
);

it.effect(
  "contract #3092: a gap longer than thirty minutes restarts an unknown launch's outage clock",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.seedLost(LONG_AGO);
      f.answer(offline);
      yield* f.sql`UPDATE remote_dispatches SET state = 'running', remote_thread_id = 'remote-thread' WHERE correlation_id = ${id}`;
      const [row] = yield* f.sql`SELECT * FROM remote_dispatches WHERE correlation_id = ${id}`.pipe(
        Effect.flatMap(decodeRemoteDispatchRows),
      );
      if (row === undefined) return yield* Effect.die("missing fixture");
      yield* Effect.gen(function* () {
        yield* recordUnreachable(publicRow(row));
        yield* TestClock.adjust("31 minutes");
        yield* recordUnreachable(publicRow(row));
        const rows = yield* f.sql<{
          host_unavailable_since: string | null;
        }>`SELECT host_unavailable_since FROM remote_dispatches WHERE correlation_id = ${id}`;
        assert.equal(rows[0]?.host_unavailable_since, "1970-01-01T00:31:00.000Z");
        yield* f.sql`UPDATE remote_dispatches SET state = 'lost', remote_thread_id = NULL,
        host_unavailable_since = NULL, host_last_failed_at = NULL WHERE correlation_id = ${id}`;
        yield* resolve();
        yield* TestClock.adjust("31 minutes");
        yield* resolve();
        const unknown = yield* f.sql<{
          host_unavailable_since: string | null;
        }>`SELECT host_unavailable_since FROM remote_dispatches WHERE correlation_id = ${id}`;
        assert.equal(unknown[0]?.host_unavailable_since, "1970-01-01T01:02:00.000Z");
      }).pipe(Effect.provide(f.dependencies));
    }).pipe(Effect.provide(database)),
);

it.effect.each(["refusal", "malformed"] as const)(
  "an answered %s breaks an unknown launch's outage before another day of failures",
  (contact) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.seedLost(LONG_AGO);
      f.answer(offline);
      yield* Effect.gen(function* () {
        yield* resolve();
        for (let i = 0; i < 138; i++) {
          yield* TestClock.adjust("10 minutes");
          yield* resolve();
        }
        f.answer(
          contact === "refusal"
            ? Effect.fail(
                new Ssh.SshRemoteDispatchError({
                  reason: "remote_refused",
                  message: "no",
                  hostAnswered: true,
                }),
              )
            : Effect.succeed({ unexpected: true }),
        );
        yield* resolve();
        const answered = yield* f.sql<{
          since: string | null;
        }>`SELECT host_unavailable_since AS since FROM remote_dispatches WHERE correlation_id = ${id}`;
        assert.isNull(answered[0]?.since);
        f.answer(offline);
        for (let i = 0; i < 12; i++) {
          yield* TestClock.adjust("10 minutes");
          yield* resolve();
        }
        const rows = yield* f.sql<{
          end_reason: string | null;
          since: string | null;
        }>`SELECT end_reason, host_unavailable_since AS since FROM remote_dispatches WHERE correlation_id = ${id}`;
        assert.isNull(rows[0]?.end_reason);
        assert.equal(rows[0]?.since, "1970-01-01T23:10:00.000Z");
        assert.lengthOf(f.notices, 0);
      }).pipe(Effect.provide(f.dependencies));
    }).pipe(Effect.provide(database)),
);

it.effect("a revived launch delivers its report once while its channel child remains failed", () =>
  Effect.gen(function* () {
    const f = yield* reportFixture;
    const childId = ChannelChildWorkId.make("revived-child");
    const taskId = ChannelTaskId.make("revived-task");
    const correlation = "channel-child-remote:revived";
    const child = {
      childWorkId: childId,
      ownerId: "owner",
      taskId,
      generation: 1,
      surface: "ssh_thread_launch" as const,
      callerThreadId: reportOrigin,
      requestKey: "request",
      promptDigest: "digest",
      state: "failed" as const,
      destination: { correlationId: correlation, host: "box" },
      createdAt: "1969-12-31T22:00:00.000Z",
      updatedAt: "1969-12-31T23:00:00.000Z",
    };
    yield* f.sql`CREATE TABLE channel_runtime_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL)`;
    yield* f.sql`INSERT INTO channel_runtime_state (key, value_json, updated_at) VALUES (${`child-work:${taskId}:${childId}`}, ${JSON.stringify(child)}, ${child.updatedAt})`;
    yield* f.sql`INSERT INTO remote_dispatches (correlation_id, kind, origin_thread_id, host, read_key, delivery, state, end_reason, ended_at, created_at, updated_at)
      VALUES (${correlation}, 'thread', ${reportOrigin}, 'box', ${"4".repeat(64)}, 'next_turn', 'lost', 'host_unreachable', '1969-12-31T23:00:00.000Z', '1969-12-31T22:00:00.000Z', '1969-12-31T23:00:00.000Z')`;
    yield* Effect.gen(function* () {
      const c = yield* Coordinator.RemoteDispatchCoordinator;
      const resolving = yield* Effect.forkChild(c.resolveLostLaunches);
      const resolveCall = yield* Queue.take(f.calls);
      assert.equal(resolveCall.call.tool, "goat_origin_resolve_binding");
      yield* Queue.offer(
        resolveCall.reply,
        Effect.succeed({
          _tag: "bound",
          threadId: reportRemote,
          originThreadId: reportOrigin,
          threadExists: true,
          threadDeleted: false,
          activeRunId: reportRun,
        }),
      );
      yield* Fiber.join(resolving);
      const first = yield* Queue.take(f.calls);
      assert.equal(first.call.tool, "goat_origin_reports_wait");
      yield* Queue.offer(
        first.reply,
        Effect.succeed(reportAnswer([makeReport(1, "completed")], "completed", true)),
      );
      yield* Queue.take(f.commits);
      const second = yield* Queue.take(f.calls);
      yield* Queue.offer(
        second.reply,
        Effect.succeed(reportAnswer([makeReport(1, "completed")], "completed")),
      );
      yield* Queue.take(f.commits);
      const inbox = yield* f.sql<{
        text: string;
      }>`SELECT text FROM remote_report_inbox WHERE correlation_id = ${correlation}`;
      assert.lengthOf(inbox, 1);
      assert.include(inbox[0]!.text, "report-1");
      const originInbox = yield* Inbox.RemoteReportInbox;
      const pending = yield* originInbox.pending(reportOrigin);
      assert.lengthOf(pending.texts, 1);
      assert.include(pending.texts[0]!, "report-1");
      assert.isNotNull(pending.throughId);
      yield* originInbox.consume(reportOrigin, pending.throughId!);
      assert.lengthOf((yield* originInbox.pending(reportOrigin)).texts, 0);
      assert.equal((yield* c.get(correlation))?.reportCursor, 1);
      const stored = yield* ChildStore.ChannelChildWorkStore;
      assert.equal((yield* stored.get(taskId, childId))?.state, "failed");
    }).pipe(Effect.provide(Layer.mergeAll(f.layer, ChildStore.layer, Inbox.layer)));
  }).pipe(Effect.provide(reportDatabase)),
);

it.effect(
  "rejected MCP initialization between unreachable contacts does not restart the outage",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.seedLost(LONG_AGO);
      let calls = 0;
      const result = yield* withLinkedHost(
        () => ({ result: {} }),
        Effect.gen(function* () {
          yield* resolve();
          yield* TestClock.adjust("10 minutes");
          yield* resolve();
          const clock = yield* f.sql<{
            since: string | null;
          }>`SELECT host_unavailable_since AS since FROM remote_dispatches WHERE correlation_id = ${id}`;
          assert.equal(clock[0]?.since, "1970-01-01T00:00:00.000Z");
          for (let i = 0; i < 143; i++) {
            yield* TestClock.adjust("10 minutes");
            yield* resolve();
          }
          const rows = yield* f.sql<{
            end_reason: string | null;
          }>`SELECT end_reason FROM remote_dispatches WHERE correlation_id = ${id}`;
          assert.equal(rows[0]?.end_reason, "host_unreachable");
        }).pipe(
          Effect.provide(
            Layer.mock(Threads.ThreadManagementService)({
              getThreadShell: () => Effect.succeed(liveThreadShell(origin)),
              dispatch: (command) =>
                Effect.sync(() => {
                  if (command.type === "message.dispatch") f.notices.push(command.text);
                  return { sequence: 1, storedEvents: [] };
                }),
            }),
          ),
        ),
        undefined,
        undefined,
        () => (calls++ % 2 === 0 ? "offline" : "reject"),
      );
      assert.equal(result.result._tag, "Success");
      assert.equal(result.record.filter((entry) => entry.method === "tools/call").length, 0);
      assert.lengthOf(f.notices, 1);
    }).pipe(Effect.provide(database)),
);
