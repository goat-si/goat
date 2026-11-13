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

import { renderDigest } from "../orchestration-v2/TurnDigest.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { sessionTaskRuns } from "./channelBotSessionRuns.ts";
import {
  anyLaunchedResultOwed,
  launchedResultOwed,
  owesLaunched,
  readLaunchedEnds,
  settledLaunchWakes,
  type LaunchedEnd,
} from "./channelLaunchedResults.ts";

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
const digestOf = (ids: ReadonlyArray<string>) => ({
  id: ids[0]!,
  text: renderDigest(
    ids[0]!,
    ids.map((id) => ({ id, text: "A launched thread finished." })),
  ),
});

describe("launch wakes folded into one turn", () => {
  const first = wakeId("run:run:c:1", session, "", "channel-child-work:first");
  const mine = wakeId("run:run:c:1");

  it("regression: a wake folded behind another one in a task's own turn settles its end", () => {
    const run = ownRun(first);
    expect(launchedResultOwed(end(), [run], [run], { messages: [digestOf([first, mine])] })).toBe(
      false,
    );
  });

  it("contract: a wake another task's turn holds settles the end only when recovery settled it", () => {
    const run = ownRun(first);
    const messages = [digestOf([first, mine])];
    expect(launchedResultOwed(end(), [], [run], { messages })).toBe(true);
    expect(launchedResultOwed(end(), [], [run], { messages, settled: new Set([mine]) })).toBe(
      false,
    );
  });
});

/** A session whose launching runs and their child-work rows are stored, with one digest run. */
const foldedSession = (input: {
  readonly launches: ReadonlyArray<{
    readonly task: string;
    readonly run: string;
    readonly threads: ReadonlyArray<string>;
  }>;
  readonly digest: ReadonlyArray<string>;
  readonly stored?: (thread: string) => boolean;
  readonly digestStatus?: string;
  /** When the digest's turn began; null for one that never left the queue. */
  readonly digestStartedAt?: string | null;
}) =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    const records: Array<{ readonly taskId: string }> = [];
    for (const launch of input.launches) {
      yield* sql`INSERT INTO channel_bot_session_runs
        (thread_id, message_id, task_id, task_generation, kind, created_at)
        VALUES (${session}, ${"message:" + launch.run}, ${launch.task}, 1, 'task', '2026-11-07T00:00:00.000Z')`;
      for (const thread of launch.threads) {
        const record = {
          ownerId: "owner",
          taskId: ChannelTaskId.make(launch.task),
          childWorkId: ChannelChildWorkId.make(launch.run + "-" + thread),
          generation: 1,
          callerThreadId: session,
          callerRunId: RunId.make(launch.run),
          requestKey: launch.run + thread,
          promptDigest: "digest",
          surface: "thread_launch",
          destination: { threadId: ThreadId.make(thread) },
          state: "completed",
          createdAt: "2026-11-07T00:00:00.000Z",
          updatedAt: "2026-11-07T00:00:00.000Z",
        } as const;
        records.push(record);
        if (input.stored?.(thread) === false) continue;
        yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at)
          VALUES (${"child-work:" + launch.task + ":" + record.childWorkId}, ${JSON.stringify(record)}, '2026-11-07T00:00:00.000Z')`;
      }
    }
    const wakes = input.digest.map((thread) => wakeId("run:run:c:1", session, "", thread));
    const digest = digestOf(wakes);
    const sessionRuns = [
      ...input.launches.map((launch, index) => ({
        id: RunId.make(launch.run),
        ordinal: index + 1,
        status: "completed",
        userMessageId: "message:" + launch.run,
      })),
      {
        id: RunId.make("digest"),
        ordinal: input.launches.length + 1,
        status: input.digestStatus ?? "completed",
        startedAt:
          input.digestStartedAt === undefined ? "2026-11-07T00:01:00.000Z" : input.digestStartedAt,
        userMessageId: digest.id,
      },
    ];
    const threads = {
      getThreadRecords: (threadId: string) =>
        Effect.succeed(
          threadId === session
            ? { runs: sessionRuns, messages: [digest] }
            : { runs: [{ id: runId, ordinal: 1, status: "completed", completedAt: null }] },
        ),
    } as never;
    const owes = (task: string) =>
      owesLaunched(
        {
          threads,
          sql,
          watch: () => Effect.succeed({ detached: false, skippedRuns: [], reportedEnds: {} }),
        },
        session,
        { taskId: ChannelTaskId.make(task), generation: 1 },
        records.filter((record) => record.taskId === task) as never,
      );
    /** What the worker-report checks see for a task: recovery's settled wakes, then the debt. */
    const recovered = (task: string) =>
      Effect.gen(function* () {
        const ref = { taskId: ChannelTaskId.make(task), generation: 1 };
        const own = yield* sessionTaskRuns(
          sql,
          session,
          { runs: sessionRuns, messages: [digest] } as never,
          ref,
        );
        const ends = yield* readLaunchedEnds(
          {
            threads,
            watch: () => Effect.succeed({ detached: false, skippedRuns: [], reportedEnds: {} }),
          },
          records.filter((record) => record.taskId === task) as never,
          1,
          session,
        );
        const runs = sessionRuns as never;
        const settled = yield* settledLaunchWakes(sql, session, ends, own, runs, [digest]);
        const owed = anyLaunchedResultOwed(ends, own, runs, { messages: [digest], settled });
        return { owed, own: own.map((run) => run.id as string) };
      });
    return { owes, recovered };
  });

const childA = "channel-child-work:a";
const childB = "channel-child-work:b";

it.effect(
  "regression: a session whose task's two launched threads ended in one folded turn owes nothing, so it can rotate",
  () =>
    Effect.gen(function* () {
      const { owes } = yield* foldedSession({
        launches: [{ task: "task:one", run: "launch-one", threads: [childA, childB] }],
        digest: [childA, childB],
      });
      expect(yield* owes("task:one")).toBe(false);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "regression: a digest folded before wakes named their launching run settles each task's own end",
  () =>
    Effect.gen(function* () {
      const { owes } = yield* foldedSession({
        launches: [
          { task: "task:one", run: "launch-one", threads: [childA] },
          { task: "task:two", run: "launch-two", threads: [childB] },
        ],
        digest: [childA, childB],
      });
      expect(yield* owes("task:one")).toBe(false);
      expect(yield* owes("task:two")).toBe(false);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("invariant: a folded wake whose launching run is unknown or ambiguous stays owed", () =>
  Effect.gen(function* () {
    const ambiguous = yield* foldedSession({
      launches: [
        { task: "task:one", run: "launch-one", threads: [childA] },
        { task: "task:two", run: "launch-two", threads: [childB] },
        { task: "task:three", run: "launch-three", threads: [childB] },
      ],
      digest: [childA, childB],
    });
    expect(yield* ambiguous.owes("task:two")).toBe(true);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("invariant: a folded wake with no stored launch record stays owed", () =>
  Effect.gen(function* () {
    const missing = yield* foldedSession({
      launches: [
        { task: "task:one", run: "launch-one", threads: [childA] },
        { task: "task:two", run: "launch-two", threads: [childB] },
      ],
      digest: [childA, childB],
      stored: (thread) => thread !== childB,
    });
    expect(yield* missing.owes("task:two")).toBe(true);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

const twoTasksFolded = (digestStatus: string, digestStartedAt?: string | null) =>
  foldedSession({
    launches: [
      { task: "task:one", run: "launch-one", threads: [childA] },
      { task: "task:two", run: "launch-two", threads: [childB] },
    ],
    digest: [childA, childB],
    digestStatus,
    ...(digestStartedAt === undefined ? {} : { digestStartedAt }),
  });

const STARTED = "2026-11-07T00:01:00.000Z";

it.effect.each([
  ["preparing", true],
  ["queued", true],
  ["starting", true],
  ["running", true],
  ["waiting", true],
  ["completed", false],
  ["interrupted", true],
  ["failed", true],
  ["cancelled", true],
  ["rolled_back", true],
] as const)(
  "contract: another task's stored digest that is %s leaves this task owed: %s; only a completed turn credits, whenever it started",
  ([status, owed]) =>
    Effect.gen(function* () {
      const { recovered } = yield* twoTasksFolded(status, STARTED);
      // The digest is never one of task two's runs, so its answer is never task two's result.
      expect(yield* recovered("task:two")).toEqual({ owed, own: ["launch-two"] });
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "regression: another task's digest whose provider start was refused ends failed with a start time and credits nothing",
  () =>
    Effect.gen(function* () {
      // The run is written running with startedAt before the provider is asked; a refusal fails it.
      const { recovered } = yield* twoTasksFolded("failed", STARTED);
      expect(yield* recovered("task:two")).toEqual({ owed: true, own: ["launch-two"] });
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "regression: another task's stored digest cancelled while still queued credits nothing, so this task stays owed as on dev",
  () =>
    Effect.gen(function* () {
      const { recovered } = yield* twoTasksFolded("cancelled", null);
      expect(yield* recovered("task:two")).toEqual({ owed: true, own: ["launch-two"] });
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
