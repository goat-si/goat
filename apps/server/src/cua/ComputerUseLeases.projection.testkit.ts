/** Shared fixtures for the ComputerUseLeases tests: an in-memory database and projection rows. */
import {
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  EnvironmentId,
  Handoff,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export const database = NodeSqliteClient.layer({ filename: ":memory:" });

const encodeHandoff = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(Handoff)));
// The layer is shared across tests, so each test keeps to its own threads.
export const thread = ThreadId.make("thread-person");
export const other = ThreadId.make("thread-bot");
export const appsThread = ThreadId.make("thread-apps");
export const turnThread = ThreadId.make("thread-turn");
export const offThread = ThreadId.make("thread-off");

/** A run of `threadId` in the projection, at `status`. */
export const run = (threadId: ThreadId, id: string, ordinal: number, status: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES (${id}, ${threadId}, ${ordinal}, 'codex', ${status}, '2026-01-01', '{}')
    `;
  });

/** An approved grant for `threadId`, live for an hour. */
export const grant = (threadId: ThreadId, id: string, apps?: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const handoff: Handoff = {
      handoffId: TurnItemId.make(id),
      kind: "approval",
      title: "Allow computer use?",
      reason: "test",
      requestedBy: {
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        path: COMPUTER_USE_GRANT_HANDOFF_PATH,
      },
      target: { environmentId: EnvironmentId.make("env"), path: COMPUTER_USE_GRANT_HANDOFF_PATH },
      dedupeKey: id,
      state: "completed",
      expiresAt: DateTime.add(now, { hours: 1 }),
      createdAt: now,
      actor: { type: "server" },
      ...(apps === undefined ? {} : { apps }),
    };
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
      VALUES (${id}, ${threadId}, 'run', 0, 'human_handoff', 'completed', '2026-01-01',
        ${'{"handoff":' + encodeHandoff(handoff) + "}"})
    `;
    return handoff;
  });
