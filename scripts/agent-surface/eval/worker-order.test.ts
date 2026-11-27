// @effect-diagnostics nodeBuiltinImport:off globalDate:off - synthetic SQLite records use fixed timestamps.
import * as NodeSqlite from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { workerOrderPrompt, type WorkerOrder } from "./worker-order-fixture.ts";
import { scoreWorkerOrder } from "./worker-order.ts";

function sample(order: WorkerOrder) {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  const workspace = "/fixture";
  const fixture = {
    a: { file: "a.txt", value: "a-value" },
    b: { file: order === "parallel" ? "b.txt" : "b-a-value.txt", value: "b-value" },
  };
  db.exec(`
    CREATE TABLE channel_inbox(input_id, bot_id, state, message_json, kind);
    CREATE TABLE channel_tasks(task_id, bot_id, worker_thread_id, status, task_json);
    CREATE TABLE orchestration_v2_projection_subagents(thread_id, child_thread_id, status, started_at, completed_at, completion_delivery_state, payload_json);
    CREATE TABLE orchestration_v2_projection_turn_items(thread_id, type, status, payload_json);
    CREATE TABLE thread_run_results(thread_id, reported_at, report_json);
    CREATE TABLE channel_outbox(task_id, input_id, kind, destination_kind, state, created_at, message_json);
    INSERT INTO channel_tasks VALUES ('task','bot','parent','completed','{"originInputId":"input","kind":"turn"}');
    INSERT INTO channel_outbox VALUES ('task','input','result','goat','delivered',1,'{"destination":{"threadId":"home"},"text":"a-value b-value"}');
  `);
  db.prepare("INSERT INTO channel_inbox VALUES ('input','bot','replied',?,'goat')").run(
    JSON.stringify({
      text: workerOrderPrompt(order, workspace) + "\n",
      replyAddress: { threadId: "home" },
    }),
  );
  for (const lane of ["a", "b"] as const) {
    const { file, value } = fixture[lane];
    const start = lane === "a" ? 100 : order === "parallel" ? 110 : 200;
    const insert = db.prepare(
      "INSERT INTO orchestration_v2_projection_subagents VALUES ('parent',?,'completed',?,?,'delivered',?)",
    );
    insert.run(
      lane,
      new Date(start - 3).toISOString(),
      new Date(start + 25).toISOString(),
      JSON.stringify({ prompt: "Read " + file, result: value }),
    );
    db.prepare(
      "INSERT INTO orchestration_v2_projection_turn_items VALUES (?,'command_execution','completed',?)",
    ).run(
      lane,
      JSON.stringify({
        input: "node probe.mjs " + file,
        startedAt: new Date(start - 1).toISOString(),
        completedAt: new Date(start + 24).toISOString(),
        output: `WORKER_ORDER ${file} ${start} ${start + 20} ${value}`,
        exitCode: 0,
      }),
    );
  }
  return {
    db,
    score: (id?: string) => scoreWorkerOrder(db, id, order, workspace, fixture),
    [Symbol.dispose]: () => db.close(),
  };
}

it("counts the overlapping work of two successful workers", () => {
  using s = sample("parallel");
  expect(s.score()).toMatchObject({ pass: true, overlapMs: 10 });
});

it("does not count overlapping task lifetimes when the actual probes are sequential", () => {
  using s = sample("parallel");
  s.db.exec(
    `UPDATE orchestration_v2_projection_turn_items SET payload_json=json_set(payload_json,'$.output','WORKER_ORDER b.txt 120 140 b-value') WHERE thread_id='b'`,
  );
  expect(s.score()).toMatchObject({ pass: false, overlapMs: 0, checks: { bothDelivered: true } });
});

it("cannot create overlap from process output outside the recorded command interval", () => {
  using s = sample("parallel");
  s.db.exec(
    `UPDATE orchestration_v2_projection_turn_items SET payload_json=json_set(payload_json,'$.startedAt','1970-01-01T00:00:00.121Z') WHERE thread_id='b'`,
  );
  expect(s.score()).toMatchObject({ pass: false, overlapMs: 0 });
});

it("accepts a second assignment that consumes the first worker's delivered value", () => {
  using s = sample("dependent");
  expect(s.score()).toMatchObject({ pass: true, overlapMs: 0 });
});

it.each([
  [
    "the second worker was launched before A completed",
    `UPDATE orchestration_v2_projection_subagents SET started_at='1970-01-01T00:00:00.101Z' WHERE child_thread_id='b'`,
  ],
  [
    "the second assignment omitted the first value",
    `UPDATE orchestration_v2_projection_subagents SET payload_json=json_set(payload_json,'$.prompt','find a file') WHERE child_thread_id='b'`,
  ],
  [
    "the prerequisite explicitly failed",
    `INSERT INTO thread_run_results VALUES ('a',1,'{"outcome":"failed"}')`,
  ],
  [
    "a worker never returned its evidence",
    `UPDATE orchestration_v2_projection_subagents SET completion_delivery_state='pending' WHERE child_thread_id='a'`,
  ],
  [
    "the parent ran the probe",
    `INSERT INTO orchestration_v2_projection_turn_items SELECT 'parent',type,status,payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id='a'`,
  ],
  [
    "both successful commands belonged to one worker",
    `UPDATE orchestration_v2_projection_turn_items SET thread_id='a'`,
  ],
  [
    "B returned a guessed result",
    `UPDATE orchestration_v2_projection_turn_items SET payload_json=json_set(payload_json,'$.output','WORKER_ORDER b-a-value.txt 200 220 guessed') WHERE thread_id='b'`,
  ],
  ["the final reply was never delivered", `UPDATE channel_outbox SET state='pending'`],
  [
    "a third worker was used",
    `INSERT INTO orchestration_v2_projection_subagents SELECT thread_id,'c',status,started_at,completed_at,completion_delivery_state,payload_json FROM orchestration_v2_projection_subagents WHERE child_thread_id='a'`,
  ],
])("rejects a dependency sample where %s", (_reason, sql) => {
  using s = sample("dependent");
  s.db.exec(sql);
  expect(s.score().pass).toBe(false);
});

it("cannot score an unrelated prompt", () => {
  using s = sample("parallel");
  s.db.exec(
    `UPDATE channel_inbox SET message_json=json_set(message_json,'$.text','a different request')`,
  );
  expect(() => s.score("input")).toThrow("Expected a Bot turn");
});

it("requires a receipt if the same prompt was submitted twice", () => {
  using s = sample("parallel");
  s.db.exec(
    `INSERT INTO channel_inbox SELECT 'other', bot_id, state, message_json, kind FROM channel_inbox`,
  );
  expect(() => s.score()).toThrow("Expected one matching Bot input");
  expect(s.score("input").pass).toBe(true);
});

it("distinguishes a delivered value from a successful parent task", () => {
  using s = sample("dependent");
  s.db.exec("UPDATE channel_tasks SET status='failed'; UPDATE channel_outbox SET kind='failure'");
  expect(s.score()).toMatchObject({
    pass: false,
    taskStatus: "failed",
    replyKind: "failure",
    checks: { bothDelivered: true, ordered: true, deliveredValues: true, completed: false },
  });
});
