import { assert, it } from "@effect/vitest";
import { ChannelTask } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { newestAskAt } from "../../channels/channelWaitingTasks.ts";
import { runMigrations } from "../Migrations.ts";

const decodeTask = Schema.decodeUnknownSync(ChannelTask);
const at = (time: string) => "2026-10-12T" + time + ":00.000Z";
const ref = { requestId: "request-1", threadId: "worker-thread" };

const task = (
  taskId: string,
  status: string,
  asks: { questions?: Array<string>; needs?: Array<object> },
) => ({
  taskId,
  conversationId: "c1",
  originBindingId: "b1",
  originAddress: {
    kind: "slack",
    connectionId: "slack-1",
    teamId: "T1",
    channelId: "C1",
    rootTs: "1.1",
  },
  originInputId: "i1",
  requester: {
    ownerId: "o1",
    principalId: "p1",
    displayName: "Jun",
    originKind: "slack",
    externalActorId: "U1",
    runtimeModeCeiling: "approval-required",
    grantedScopes: [],
  },
  title: "Task " + taskId,
  instruction: "Do it.",
  status,
  version: 1,
  generation: 1,
  openQuestions: (asks.questions ?? []).map((time, index) => ({
    questionId: taskId + "-q" + index,
    text: "Which one?",
    askedAt: at(time),
  })),
  ...(asks.needs === undefined ? {} : { observed: { pullRequests: [], needsYou: asks.needs } }),
  createdAt: at("00:00"),
  updatedAt: at("00:00"),
});

/** Each stored task, the value the backfill must give it, and whether it still decodes. */
const rows = [
  [task("open-question", "waiting_input", { questions: ["01:00", "03:00"] }), at("03:00")],
  [
    task("approval", "running", {
      needs: [{ kind: "approval", since: at("04:00"), approval: ref }],
    }),
    at("04:00"),
  ],
  [
    task("approval-unnamed", "waiting_input", {
      questions: ["02:00"],
      needs: [{ kind: "approval", since: at("09:00") }],
    }),
    at("02:00"),
  ],
  [
    task("native-question", "running", {
      needs: [{ kind: "question", since: at("05:00"), question: ref }],
    }),
    at("05:00"),
  ],
  [
    task("native-question-unnamed", "running", {
      needs: [{ kind: "question", since: at("09:00") }],
    }),
    null,
  ],
  [task("sign-in", "running", { needs: [{ kind: "sign_in", since: at("06:00") }] }), at("06:00")],
  [
    task("usage-limit", "running", { needs: [{ kind: "usage_limit", since: at("07:00") }] }),
    at("07:00"),
  ],
  [
    task("completed-approval", "completed", {
      questions: ["09:00"],
      needs: [
        { kind: "approval", since: at("08:00"), approval: ref },
        { kind: "sign_in", since: at("09:30") },
      ],
    }),
    at("08:00"),
  ],
  [task("completed-question", "completed", { questions: ["09:00"] }), null],
] as const;

// A newer server's kind: this one cannot decode the task, and the list cannot show the need.
const unknownKind = task("unknown-kind", "running", {
  needs: [
    { kind: "review", since: at("09:00") },
    { kind: "sign_in", since: at("01:30") },
  ],
});

it.effect("stores each task's newest showable ask, as the open asks list reads it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 138 });
    yield* sql`INSERT INTO channel_conversations
      (conversation_id, owner_id, kind, connection_id, conversation_key, last_activity_at)
      VALUES ('c1', 'o1', 'slack', 'slack-1', 'k1', 'now')`;
    const stored = [...rows.map(([each]) => each), unknownKind] as const;
    for (const each of stored) {
      yield* sql`INSERT INTO channel_tasks (task_id, owner_id, conversation_id, status, version,
        generation, task_json, created_at, updated_at)
        VALUES (${each.taskId}, 'o1', 'c1', ${each.status}, 1, 1, ${JSON.stringify(each)},
          'now', 'now')`;
    }
    yield* sql`INSERT INTO channel_tasks (task_id, owner_id, conversation_id, status, version,
      generation, task_json, created_at, updated_at)
      VALUES ('unreadable', 'o1', 'c1', 'running', 1, 1, 'not json', 'now', 'now')`;

    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 139 }), [
      [139, "ChannelNewestAsk"],
    ]);
    const backfilled = new Map(
      (yield* sql<{ readonly task_id: string; readonly newest_ask_at: string | null }>`
          SELECT task_id, newest_ask_at FROM channel_tasks`).map((row) => [
        row.task_id,
        row.newest_ask_at,
      ]),
    );
    for (const [each, expected] of rows) {
      assert.strictEqual(backfilled.get(each.taskId), expected, each.taskId);
      assert.strictEqual(backfilled.get(each.taskId), newestAskAt(decodeTask(each)), each.taskId);
    }
    assert.throws(() => decodeTask(unknownKind));
    assert.strictEqual(backfilled.get(unknownKind.taskId), at("01:30"));
    assert.strictEqual(
      backfilled.get(unknownKind.taskId),
      newestAskAt(unknownKind as unknown as ChannelTask),
    );
    assert.isNull(backfilled.get("unreadable"));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("completes on malformed tasks, keeping the readable asks of a mixed one", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 138 });
    yield* sql`INSERT INTO channel_conversations
      (conversation_id, owner_id, kind, connection_id, conversation_key, last_activity_at)
      VALUES ('c1', 'o1', 'slack', 'slack-1', 'k1', 'now')`;
    const valid = task("valid", "running", { questions: ["01:00"] });
    const question = valid.openQuestions[0];
    const stored: ReadonlyArray<readonly [string, string, string | null]> = [
      [
        "mixed-questions",
        JSON.stringify({ ...valid, openQuestions: ["oops", 42, null, question] }),
        at("01:00"),
      ],
      [
        "mixed-needs",
        JSON.stringify({
          ...valid,
          openQuestions: [],
          observed: {
            pullRequests: [],
            needsYou: [
              "oops",
              7,
              { kind: "approval", since: at("04:00"), approval: "x" },
              {
                kind: "sign_in",
                since: at("06:00"),
              },
            ],
          },
        }),
        at("06:00"),
      ],
      ["questions-object", JSON.stringify({ ...valid, openQuestions: { a: question } }), null],
      [
        "questions-null",
        JSON.stringify({
          ...valid,
          openQuestions: null,
          observed: { pullRequests: [], needsYou: [{ kind: "usage_limit", since: at("05:00") }] },
        }),
        at("05:00"),
      ],
      ["needs-string", JSON.stringify({ ...valid, observed: { needsYou: "oops" } }), at("01:00")],
      ["no-observed", JSON.stringify(valid), at("01:00")],
      ["not-json", "{not json", null],
      ["scalar-json", JSON.stringify("just a string"), null],
    ];
    for (const [taskId, json] of stored) {
      yield* sql`INSERT INTO channel_tasks (task_id, owner_id, conversation_id, status, version,
        generation, task_json, created_at, updated_at)
        VALUES (${taskId}, 'o1', 'c1', 'running', 1, 1, ${json}, 'now', 'now')`;
    }

    yield* runMigrations({ toMigrationInclusive: 139 });
    const backfilled = new Map(
      (yield* sql<{ readonly task_id: string; readonly newest_ask_at: string | null }>`
          SELECT task_id, newest_ask_at FROM channel_tasks`).map((row) => [
        row.task_id,
        row.newest_ask_at,
      ]),
    );
    for (const [taskId, , expected] of stored) {
      assert.strictEqual(backfilled.get(taskId), expected, taskId);
    }
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
