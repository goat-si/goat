import { expect, it } from "@effect/vitest";
import { RunId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SessionReceiptGate from "./SessionReceiptGate.ts";
import * as Fixture from "./SessionReceipt.testkit.ts";

it.effect.each(["restart", "delegated"] as const)(
  "resolves the %s parent to its origin receipt and prefers an own message intent",
  (kind) =>
    Effect.gen(function* () {
      yield* Fixture.seed;
      const sql = yield* SqlClient.SqlClient;
      const gate = yield* SessionReceiptGate.SessionReceiptGate;
      const child = RunId.make("receipt-child");
      yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      SELECT ${child}, thread_id, 2, provider, status, requested_at,
        json_set(payload_json, '$.id', ${child}, '$.userMessageId', 'child-message', '$.restartContinuationOfRunId', ${kind === "restart" ? Fixture.runId : null})
      FROM orchestration_v2_projection_runs WHERE run_id = ${Fixture.runId}`;
      if (kind === "delegated")
        yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('child-message', ${Fixture.threadId}, 'user', 0, '1970-01-01', '1970-01-01', ${JSON.stringify({ delegatedCompletion: { parentRunId: Fixture.runId } })})`;
      expect((yield* gate.inspect(Fixture.threadId, child)).state).toBe("held");
      yield* Fixture.settle;
      expect((yield* gate.inspect(Fixture.threadId, child)).state).toBe("settled");
      yield* sql`INSERT INTO channel_bot_session_runs (thread_id, message_id, task_id, task_generation, kind, created_at)
      VALUES (${Fixture.threadId}, 'child-message', 'receipt-task', 2, 'task', '1970-01-01')`;
      expect((yield* gate.inspect(Fixture.threadId, child)).state).toBe("invalid");
    }).pipe(Effect.provide(Fixture.layer)),
);

it.effect.each([
  "absent",
  "missing-parent",
  "cycle",
  "missing-receipt",
  "failed",
  "ambiguous",
] as const)("receipt state %s is distinguished without opening an unresolved gate", (kind) =>
  Effect.gen(function* () {
    yield* Fixture.seed;
    const sql = yield* SqlClient.SqlClient;
    const gate = yield* SessionReceiptGate.SessionReceiptGate;
    if (["absent", "missing-parent", "cycle"].includes(kind)) {
      yield* sql`DELETE FROM channel_bot_session_runs`;
      if (kind !== "absent")
        yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json = json_set(payload_json,
        '$.restartContinuationOfRunId', ${kind === "cycle" ? Fixture.runId : "unknown-parent"})`;
    } else if (kind === "missing-receipt") yield* sql`DELETE FROM channel_outbox`;
    else yield* sql`UPDATE channel_outbox SET state = ${kind}`;
    expect((yield* gate.inspect(Fixture.threadId, Fixture.runId)).state).toBe(
      kind === "absent"
        ? "absent"
        : kind === "missing-receipt"
          ? "held"
          : ["failed", "ambiguous"].includes(kind)
            ? "settled"
            : "invalid",
    );
  }).pipe(Effect.provide(Fixture.layer)),
);
it.effect(
  "a launched thread's end wake answers for the run that launched it, with its own status",
  () =>
    Effect.gen(function* () {
      yield* Fixture.seed;
      const sql = yield* SqlClient.SqlClient;
      const gate = yield* SessionReceiptGate.SessionReceiptGate;
      const wakeFor = (launched: string) =>
        "message:launch-watch:" +
        [Fixture.threadId, "", launched].map(encodeURIComponent).join(":") +
        ":run:run:" +
        launched +
        ":1";
      yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at) VALUES (
      'child-work:receipt-task:probe',
      ${JSON.stringify({
        taskId: "receipt-task",
        childWorkId: "probe",
        generation: 1,
        callerThreadId: Fixture.threadId,
        callerRunId: Fixture.runId,
        surface: "thread_launch",
        destination: { threadId: "thread:probe" },
        state: "completed",
      })},
      '1970-01-01')`;
      const addWake = (id: RunId, ordinal: number, launched: string) =>
        sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      SELECT ${id}, thread_id, ${ordinal}, provider, 'running', requested_at,
        json_set(payload_json, '$.id', ${id}, '$.userMessageId', ${wakeFor(launched)}, '$.restartContinuationOfRunId', NULL)
      FROM orchestration_v2_projection_runs WHERE run_id = ${Fixture.runId}`;
      const wake = RunId.make("receipt-wake");
      yield* addWake(wake, 2, "thread:probe");
      const held = yield* gate.inspect(Fixture.threadId, wake);
      expect(held.state).toBe("held");
      expect(held.state === "held" ? held.status : undefined).toBe("running");
      yield* Fixture.settle;
      expect((yield* gate.inspect(Fixture.threadId, wake)).state).toBe("settled");
      const stray = RunId.make("receipt-stray-wake");
      yield* addWake(stray, 3, "thread:unrecorded");
      expect((yield* gate.inspect(Fixture.threadId, stray)).state).toBe("absent");
    }).pipe(Effect.provide(Fixture.layer)),
);
it.effect("a background command's notice run answers for the run that started the command", () =>
  Effect.gen(function* () {
    yield* Fixture.seed;
    const sql = yield* SqlClient.SqlClient;
    const gate = yield* SessionReceiptGate.SessionReceiptGate;
    const notice = RunId.make("receipt-notice");
    yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      SELECT ${notice}, thread_id, 2, provider, 'running', requested_at,
        json_set(payload_json, '$.id', ${notice}, '$.userMessageId', 'notice-message', '$.restartContinuationOfRunId', NULL)
      FROM orchestration_v2_projection_runs WHERE run_id = ${Fixture.runId}`;
    yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('notice-message', ${Fixture.threadId}, 'user', 0, '1970-01-01', '1970-01-01',
        ${JSON.stringify({ notification: { source: { kind: "command" }, outcome: "completed", summary: "Command ended", aboutRunId: Fixture.runId } })})`;
    yield* Fixture.settle;
    expect((yield* gate.inspect(Fixture.threadId, notice)).state).toBe("settled");
    yield* sql`UPDATE channel_tasks SET status = 'cancelled' WHERE task_id = 'receipt-task'`;
    expect((yield* gate.inspect(Fixture.threadId, notice)).state).toBe("invalid");
  }).pipe(Effect.provide(Fixture.layer)),
);
it.effect(
  "contract: a launch wake stamped with its launching run answers for that run without a launch record",
  () =>
    Effect.gen(function* () {
      yield* Fixture.seed;
      const sql = yield* SqlClient.SqlClient;
      const gate = yield* SessionReceiptGate.SessionReceiptGate;
      const wakeId =
        "message:launch-watch:" +
        [Fixture.threadId, "", "thread:unrecorded"].map(encodeURIComponent).join(":") +
        ":run:run:unrecorded:1";
      const wake = RunId.make("receipt-stamped-wake");
      yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      SELECT ${wake}, thread_id, 2, provider, 'running', requested_at,
        json_set(payload_json, '$.id', ${wake}, '$.userMessageId', ${wakeId}, '$.restartContinuationOfRunId', NULL)
      FROM orchestration_v2_projection_runs WHERE run_id = ${Fixture.runId}`;
      yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
      VALUES (${wakeId}, ${Fixture.threadId}, 'user', 0, '1970-01-01', '1970-01-01',
        ${JSON.stringify({ notification: { source: { kind: "background_task" }, outcome: "completed", summary: "Thread finished", aboutRunId: Fixture.runId } })})`;
      expect((yield* gate.inspect(Fixture.threadId, wake)).state).toBe("held");
      yield* Fixture.settle;
      expect((yield* gate.inspect(Fixture.threadId, wake)).state).toBe("settled");
    }).pipe(Effect.provide(Fixture.layer)),
);
