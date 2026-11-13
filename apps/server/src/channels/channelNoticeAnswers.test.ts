import { assert, describe, it } from "@effect/vitest";
import { ChannelInputId, ChannelTaskId, MessageId, RunId, ThreadId } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { runMigrations } from "../persistence/Migrations.ts";
import type * as ChannelLedger from "./ChannelLedger.ts";
import {
  deliverNoticeAnswers,
  noticeAnswerText,
  noticeMessageIds,
  resultRunsOf,
} from "./channelNoticeAnswers.ts";

const session = ThreadId.make("goat-bot-session:question-a-set");
const broken = ThreadId.make("goat-bot-session:broken");
const logistics = { id: ChannelTaskId.make("task:logistics"), input: "input:logistics" };
const questionA = { id: ChannelTaskId.make("task:question-a"), input: "input:question-a" };
const goatAddress = { kind: "goat", environmentId: "env", threadId: "goat-bot:main" } as const;

const task = (id: string, input: string, title: string, address: object = goatAddress) => ({
  task: {
    taskId: id,
    title,
    status: id === questionA.id ? "failed" : "completed",
    generation: 1,
    version: 3,
    originInputId: ChannelInputId.make(input),
    originAddress: address,
  },
});

interface Notice {
  readonly thread: ThreadId;
  readonly run: string;
  readonly about: string;
  readonly status: string;
  readonly answer?: string;
  /** Everything the run wrote, oldest first, when it wrote more than its final answer. */
  readonly answers?: ReadonlyArray<string>;
  readonly completedAt: string;
}

/** The session the parent saw: logistics started a command, question a failed, the notice answered. */
const world = (notices: ReadonlyArray<Notice>, tasks: Record<string, unknown>) => {
  const sent: Array<ChannelLedger.ChannelOutboxInsert> = [];
  const runs = (thread: ThreadId) => [
    {
      id: RunId.make("run:logistics"),
      ordinal: 1,
      status: "completed",
      userMessageId: "message:logistics",
      restartContinuationOfRunId: null,
    },
    {
      id: RunId.make("run:question-a"),
      ordinal: 2,
      status: "failed",
      userMessageId: "message:question-a",
      restartContinuationOfRunId: null,
    },
    ...notices
      .filter((notice) => notice.thread === thread)
      .map((notice, index) => ({
        id: RunId.make(notice.run),
        ordinal: 3 + index,
        status: notice.status,
        userMessageId: "message:" + notice.run,
        restartContinuationOfRunId: null,
      })),
  ];
  const threads = {
    getThreadRecords: (
      thread: ThreadId,
      _fields: unknown,
      filter?: { messageRunIds?: string[] },
    ) =>
      thread === broken
        ? Effect.fail({ _tag: "ProjectionReadFailed" } as const)
        : Effect.succeed(
            filter?.messageRunIds === undefined
              ? {
                  runs: runs(thread),
                  messages: notices.map((notice) => ({
                    id: "message:" + notice.run,
                    notification: { aboutRunId: RunId.make(notice.about) },
                  })),
                }
              : {
                  messages: notices
                    .filter((notice) => filter.messageRunIds?.includes(notice.run))
                    .flatMap((notice) =>
                      (notice.answers ?? [notice.answer ?? ""]).map((text) => ({
                        text,
                        streaming: false,
                      })),
                    ),
                },
          ),
  } as never;
  const ledger = {
    getTask: (id: string) => Effect.succeed(tasks[id]),
    enqueueDeliveries: (deliveries: ReadonlyArray<ChannelLedger.ChannelOutboxInsert>) =>
      Effect.sync(() => void sent.push(...deliveries)),
  } as never;
  return { sent, deps: { threads, ledger } };
};

const seed = (notices: ReadonlyArray<Notice>) =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    for (const [message, owner] of [
      ["message:logistics", logistics.id],
      ["message:question-a", questionA.id],
    ] as const)
      for (const thread of [session, broken])
        yield* sql`INSERT INTO channel_bot_session_runs
          (thread_id, message_id, task_id, task_generation, kind, created_at)
          VALUES (${thread}, ${message}, ${owner}, 1, 'task', '1970-01-01T00:00:00.000Z')`;
    for (const [index, notice] of notices.entries()) {
      yield* sql`INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES (${notice.run}, ${notice.thread}, ${3 + index}, 'codex', ${notice.status}, '1970-01-01T00:00:00.000Z',
          ${JSON.stringify({ userMessageId: "message:" + notice.run, completedAt: notice.completedAt })})`;
      yield* sql`INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
        VALUES (${"message:" + notice.run}, ${notice.thread}, 'user', 0, '1970-01-01', '1970-01-01',
          ${JSON.stringify({ notification: { aboutRunId: notice.about } })})`;
    }
    return sql;
  });

const tasks = {
  [logistics.id]: task(logistics.id, logistics.input, "Plan the logistics"),
  [questionA.id]: task(questionA.id, questionA.input, "Where is the payments secret?"),
};
const at = "1970-01-01T00:00:00.000Z";

describe("a background command's answer goes to the request whose run started it", () => {
  it.effect(
    "a command the logistics turn started answers under the logistics question after that turn ended, while question a's failure stands (set 3 question a)",
    () =>
      Effect.gen(function* () {
        const notices = [
          {
            thread: session,
            run: "run:notice",
            about: "run:logistics",
            status: "completed",
            answer: "The payments billing API key is in the 1Password vault named Ops.",
            completedAt: at,
          },
        ];
        const sql = yield* seed(notices);
        const { sent, deps } = world(notices, tasks);
        assert.strictEqual(yield* deliverNoticeAnswers({ sql, ...deps }), 1);
        assert.lengthOf(sent, 1);
        assert.strictEqual(sent[0]?.message.inReplyToInputId, logistics.input);
        assert.strictEqual(sent[0]?.message.destination.kind, "goat");
        assert.strictEqual(
          sent[0]?.message.text,
          "The payments billing API key is in the 1Password vault named Ops.",
        );
        assert.strictEqual(sent[0]?.inputId, undefined);
        // A second pass sends nothing more.
        assert.strictEqual(yield* deliverNoticeAnswers({ sql, ...deps }), 0);
        assert.lengthOf(sent, 1);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "regression: a launch wake stamped with its launching run is answered once, as the task's result, never also as a notice answer",
    () =>
      Effect.gen(function* () {
        const notices = [
          {
            thread: session,
            run: "launch-watch:" + encodeURIComponent(session) + "::child:run:run:child:1",
            about: "run:logistics",
            status: "completed",
            answer: "The child thread finished its fix.",
            completedAt: at,
          },
        ];
        const sql = yield* seed(notices);
        const { sent, deps } = world(notices, tasks);
        assert.strictEqual(yield* deliverNoticeAnswers({ sql, ...deps }), 0);
        assert.lengthOf(sent, 0);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("stays quiet for NO_REPLY, an empty answer, or a notice run that failed", () =>
    Effect.gen(function* () {
      const notices = [
        {
          thread: session,
          run: "run:quiet",
          about: "run:logistics",
          status: "completed",
          answer: "  NO_REPLY ",
          completedAt: at,
        },
        {
          thread: session,
          run: "run:empty",
          about: "run:logistics",
          status: "completed",
          answer: "",
          completedAt: at,
        },
        {
          thread: session,
          run: "run:failed",
          about: "run:logistics",
          status: "failed",
          answer: "partial",
          completedAt: at,
        },
        {
          thread: session,
          run: "run:mention",
          about: "run:logistics",
          status: "completed",
          answer: "NO_REPLY was not right: it is in Ops.",
          completedAt: at,
        },
      ];
      const sql = yield* seed(notices);
      const { sent, deps } = world(notices, tasks);
      yield* deliverNoticeAnswers({ sql, ...deps });
      assert.deepStrictEqual(
        sent.map((delivery) => delivery.message.text),
        ["NO_REPLY was not right: it is in Ops."],
      );
      const markers = yield* sql<{ readonly key: string; readonly value_json: string }>`
        SELECT key, value_json FROM channel_runtime_state WHERE key LIKE 'notice-answer:%' ORDER BY key`;
      assert.lengthOf(markers, 4);
      assert.strictEqual(yield* deliverNoticeAnswers({ sql, ...deps }), 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("keeps going past notices it cannot read, and retries them later", () =>
    Effect.gen(function* () {
      const failing = Array.from({ length: 20 }, (_, index) => ({
        thread: broken,
        run: "run:broken-" + String(index).padStart(2, "0"),
        about: "run:logistics",
        status: "completed",
        answer: "unreachable",
        completedAt: at,
      }));
      const good = {
        thread: session,
        run: "run:late",
        about: "run:logistics",
        status: "completed",
        answer: "Done.",
        completedAt: "1970-01-01T00:00:01.000Z",
      };
      const sql = yield* seed([...failing, good]);
      const { sent, deps } = world([...failing, good], tasks);
      yield* deliverNoticeAnswers({ sql, ...deps });
      assert.lengthOf(sent, 0);
      yield* deliverNoticeAnswers({ sql, ...deps });
      assert.deepStrictEqual(
        sent.map((delivery) => delivery.message.text),
        ["Done."],
      );
      const attempts = () =>
        sql<{ readonly attempts: number }>`
          SELECT json_extract(value_json, '$.attempts') AS attempts FROM channel_runtime_state
          WHERE key = 'notice-answer:goat-bot-session:broken:run:broken-00'`;
      assert.strictEqual((yield* attempts())[0]?.attempts, 1);
      yield* TestClock.adjust("3 minutes");
      yield* deliverNoticeAnswers({ sql, ...deps });
      assert.strictEqual((yield* attempts())[0]?.attempts, 2);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "still answers a notice, unread or waiting to retry, that ended more than a week ago",
    () =>
      Effect.gen(function* () {
        const old = (run: string, answer: string) => ({
          thread: session,
          run,
          about: "run:logistics",
          status: "completed",
          answer,
          completedAt: at,
        });
        const notices = [old("run:unread", "First."), old("run:retrying", "Second.")];
        const sql = yield* seed(notices);
        yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at)
        VALUES ('notice-answer:goat-bot-session:question-a-set:run:retrying',
          ${JSON.stringify({ state: "retry", attempts: 9, nextAt: at })}, ${at})`;
        const { sent, deps } = world(notices, tasks);
        yield* TestClock.adjust("8 days");
        yield* deliverNoticeAnswers({ sql, ...deps });
        assert.sameMembers(
          sent.map((delivery) => delivery.message.text),
          ["First.", "Second."],
        );
        yield* deliverNoticeAnswers({ sql, ...deps });
        assert.lengthOf(sent, 2);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("sends nothing when the request is stopped between the check and the send", () =>
    Effect.gen(function* () {
      const notices = [
        {
          thread: session,
          run: "run:notice",
          about: "run:logistics",
          status: "completed",
          answer: "Done.",
          completedAt: at,
        },
      ];
      const sql = yield* seed(notices);
      let reads = 0;
      const live = tasks[logistics.id];
      if (live === undefined) throw new Error("The logistics task is missing");
      const stopping = {
        ...tasks,
        // The judgement reads the task first; the person stops it before the send.
        get [logistics.id]() {
          reads += 1;
          return reads === 1 ? live : { task: { ...live.task, status: "cancelled" } };
        },
      };
      const { sent, deps } = world(notices, stopping);
      assert.strictEqual(yield* deliverNoticeAnswers({ sql, ...deps }), 0);
      assert.lengthOf(sent, 0);
      const marker = yield* sql<{ readonly state: string; readonly reason: string }>`
        SELECT json_extract(value_json, '$.state') AS state, json_extract(value_json, '$.reason') AS reason
        FROM channel_runtime_state WHERE key = 'notice-answer:goat-bot-session:question-a-set:run:notice'`;
      assert.deepStrictEqual(marker[0], { state: "skipped", reason: "stale" });
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

describe("a notice answer's shape and place", () => {
  it("names the request on a channel without threads, and leaves GOAT and Slack text as written", () => {
    const of = (kind: string) =>
      noticeAnswerText(
        { title: "Plan the logistics", originAddress: { kind } as never },
        "In Ops.",
      );
    assert.strictEqual(of("goat"), "In Ops.");
    assert.strictEqual(of("slack"), "In Ops.");
    assert.strictEqual(of("imessage"), 'About "Plan the logistics": In Ops.');
  });

  it("is never the task's result, while the notice run stays the task's own", () => {
    const runs = [
      { id: "run:logistics", userMessageId: MessageId.make("message:logistics") },
      { id: "run:notice", userMessageId: MessageId.make("message:notice") },
    ];
    const notices = noticeMessageIds([
      { id: "message:logistics" },
      { id: "message:notice", notification: { aboutRunId: "run:logistics" } },
    ]);
    assert.deepStrictEqual(
      resultRunsOf(runs, notices).map((run) => run.id),
      ["run:logistics"],
    );
    assert.lengthOf(runs, 2);
  });

  it("keeps stamped launch wakes as results while excluding command notices", () => {
    const notices = noticeMessageIds([
      {
        id: "message:launch-watch:session::child:run:child",
        notification: { aboutRunId: "run:parent" },
      },
      { id: "message:command", notification: { aboutRunId: "run:parent" } },
    ]);
    assert.deepStrictEqual([...notices], ["message:command"]);
  });
});
describe("which answer a notice run gives, and to whom", () => {
  it.effect("stays quiet when the run wrote on the way but ended with an empty answer", () =>
    Effect.gen(function* () {
      const notices = [
        {
          thread: session,
          run: "run:midway",
          about: "run:logistics",
          status: "completed",
          answers: ["Checking the vault now.", ""],
          completedAt: at,
        },
      ];
      const sql = yield* seed(notices);
      const { sent, deps } = world(notices, tasks);
      yield* deliverNoticeAnswers({ sql, ...deps });
      assert.lengthOf(sent, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("answers each request whose run started a command, under that request only", () =>
    Effect.gen(function* () {
      const notices = [
        {
          thread: session,
          run: "run:about-logistics",
          about: "run:logistics",
          status: "completed",
          answer: "The van is booked.",
          completedAt: at,
        },
        {
          thread: session,
          run: "run:about-a",
          about: "run:question-a",
          status: "completed",
          answer: "It is in the Ops vault.",
          completedAt: "1970-01-01T00:00:01.000Z",
        },
      ];
      const sql = yield* seed(notices);
      const { sent, deps } = world(notices, tasks);
      yield* deliverNoticeAnswers({ sql, ...deps });
      assert.deepStrictEqual(
        sent.map((delivery) => [delivery.message.inReplyToInputId, delivery.message.text]),
        [
          [logistics.input, "The van is booked."],
          [questionA.input, "It is in the Ops vault."],
        ],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
