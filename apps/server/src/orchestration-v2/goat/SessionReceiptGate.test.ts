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
