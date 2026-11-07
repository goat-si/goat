import { it } from "@effect/vitest";
import {
  ChannelChildWorkId,
  ChannelTaskId,
  MessageId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
} from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect } from "vite-plus/test";

import { runMigrations } from "../persistence/Migrations.ts";
import { launchedResultOwed, owesLaunched, type LaunchedEnd } from "./channelLaunchedResults.ts";

const session = ThreadId.make("goat-bot-session:s");
const child = ThreadId.make("channel-child-work:c");
const endIso = "2026-11-07T11:52:07.000Z";
const runId = RunId.make("run:c:1");

const wakeId = (event: string, launcher: string = session, host = "", thread: string = child) =>
  "message:launch-watch:" +
  [launcher, host, thread].map(encodeURIComponent).join(":") +
  ":" +
  event;

const ownRun = (messageId: string) =>
  ({ id: RunId.make("wake"), userMessageId: MessageId.make(messageId) }) as OrchestrationV2Run;

const end = (overrides: Partial<LaunchedEnd> = {}): LaunchedEnd => ({
  launcherThreadId: session,
  childThreadId: child,
  runId,
  endIso,
  watch: { detached: false, skippedRuns: [], reportedEnds: {} },
  ...overrides,
});

describe("launchedResultOwed", () => {
  it("is owed until the task's own runs hold the wake for the child's end", () => {
    expect(launchedResultOwed(end(), [])).toBe(true);
    expect(launchedResultOwed(end(), [ownRun(wakeId("run:run:c:1"))])).toBe(false);
    // A retried attempt's wake carries the attempt; it reports the same end.
    expect(launchedResultOwed(end(), [ownRun(wakeId("run:run:c:1") + ":attempt-2")])).toBe(false);
  });

  it("does not take another run, launcher, host, thread or event's wake for this end", () => {
    for (const other of [
      wakeId("run:run:c:12"),
      wakeId("run:run:c"),
      wakeId("run:run:c:1", "goat-bot-session:other"),
      wakeId("run:run:c:1", session, "mini"),
      wakeId("run:run:c:1", session, "", "channel-child-work:other"),
      wakeId("question:run:c:1:q1"),
      "message:run:c:1",
    ])
      expect(launchedResultOwed(end(), [ownRun(other)])).toBe(true);
  });

  it("matches a later end of a run retried in place by its end, never by time", () => {
    const retried = end({
      endIso: "2026-11-07T11:55:00.000Z",
      watch: { detached: false, skippedRuns: [], reportedEnds: { [runId]: endIso } },
    });
    // The first end's wake does not cover the retry's end, whatever its time.
    expect(launchedResultOwed(retried, [ownRun(wakeId("run:run:c:1"))])).toBe(true);
    expect(launchedResultOwed(retried, [ownRun(wakeId("run:run:c:1:end:" + endIso))])).toBe(true);
    expect(
      launchedResultOwed(retried, [ownRun(wakeId("run:run:c:1:end:2026-11-07T11:55:00.000Z"))]),
    ).toBe(false);
    // A first end the watch recorded as this very end is covered by the first wake.
    const first = end({
      watch: { detached: false, skippedRuns: [], reportedEnds: { [runId]: endIso } },
    });
    expect(launchedResultOwed(first, [ownRun(wakeId("run:run:c:1"))])).toBe(false);
    // An end that could not be read takes any wake for the run.
    expect(
      launchedResultOwed(end({ endIso: null }), [ownRun(wakeId("run:run:c:1:end:unknown:1"))]),
    ).toBe(false);
  });

  it("is not owed when no wake is coming: no watch, an unwatched one, or a run the child went on from", () => {
    expect(launchedResultOwed(end({ watch: null }), [])).toBe(false);
    expect(
      launchedResultOwed(end({ watch: { detached: true, skippedRuns: [], reportedEnds: {} } }), []),
    ).toBe(false);
    expect(
      launchedResultOwed(
        end({ watch: { detached: false, skippedRuns: [runId], reportedEnds: {} } }),
        [],
      ),
    ).toBe(false);
  });

  it("stays owed when the watch could not be read", () => {
    expect(launchedResultOwed(end({ watch: "unreadable" }), [])).toBe(true);
    expect(launchedResultOwed(end({ watch: "unreadable" }), [ownRun(wakeId("run:run:c:1"))])).toBe(
      false,
    );
  });
  it("stays owed for a wake on the launcher that is not one of the task's runs, watched or not", () => {
    const unowned = ownRun(wakeId("run:run:c:1"));
    expect(launchedResultOwed(end(), [], [unowned])).toBe(true);
    expect(launchedResultOwed(end({ watch: null }), [], [unowned])).toBe(true);
  });
});
it.effect("keeps a session busy while a wake that arrived since its first read still runs", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    const task = { taskId: ChannelTaskId.make("task:probe"), generation: 1 };
    yield* sql`INSERT INTO channel_bot_session_runs
      (thread_id, message_id, task_id, task_generation, kind, created_at)
      VALUES (${session}, 'message:launch', ${task.taskId}, 1, 'task', '2026-11-07T00:00:00.000Z')`;
    const record = {
      ownerId: "owner",
      taskId: task.taskId,
      childWorkId: ChannelChildWorkId.make("probe"),
      generation: 1,
      callerThreadId: session,
      callerRunId: RunId.make("launch"),
      requestKey: "probe",
      promptDigest: "digest",
      surface: "thread_launch",
      destination: { threadId: child },
      state: "completed",
      createdAt: "2026-11-07T00:00:00.000Z",
      updatedAt: "2026-11-07T00:00:00.000Z",
    } as const;
    yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at)
      VALUES ('child-work:task:probe:probe', ${JSON.stringify(record)}, '2026-11-07T00:00:00.000Z')`;
    const sessionRuns = [
      {
        id: RunId.make("launch"),
        ordinal: 1,
        status: "completed",
        userMessageId: "message:launch",
      },
      {
        id: RunId.make("wake"),
        ordinal: 2,
        status: "running",
        userMessageId: wakeId("run:run:c:1"),
      },
    ];
    const threads = {
      getThreadRecords: (threadId: string) =>
        Effect.succeed(
          threadId === child
            ? { runs: [{ id: runId, ordinal: 1, status: "completed", completedAt: null }] }
            : { runs: sessionRuns, messages: [] },
        ),
    } as never;
    const owed = yield* owesLaunched(
      {
        threads,
        sql,
        watch: () => Effect.succeed({ detached: false, skippedRuns: [], reportedEnds: {} }),
      },
      session,
      task,
      [record as never],
    );
    expect(owed).toBe(true);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
