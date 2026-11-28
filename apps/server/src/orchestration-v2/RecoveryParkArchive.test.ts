import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadArchiveGate from "./ThreadArchiveGate.ts";
import * as ThreadHistoryArchive from "./ThreadHistoryArchive.ts";

const now = Date.parse("2026-10-22T00:00:00.000Z");
const at = DateTime.formatIso(DateTime.makeUnsafe(now - 40 * 86_400_000));
const layer = () =>
  ThreadHistoryArchive.layer.pipe(
    Layer.provide(
      Layer.succeed(
        ThreadArchiveGate.ThreadArchiveGate,
        ThreadArchiveGate.makeThreadArchiveGateSlot(),
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "recovery-archive-" })),
    Layer.provideMerge(NodeServices.layer),
  );

it.effect("a parked hold protects its notice from history archiving until released", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const archive = yield* ThreadHistoryArchive.ThreadHistoryArchive;
    for (const thread of ["parked", "ordinary"]) {
      yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${thread}, 'project', ${thread}, 'codex', 'full-access', 'default', ${at}, ${at}, json_object('settledAt', ${at}))`;
      const item = thread === "parked" ? "turn-item:recovery-parked:run:parked" : "ordinary-item";
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json) VALUES (${item}, ${thread}, 1, 'system_notice', 'waiting', ${at}, '{}')`;
    }
    yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json) VALUES ('run:parked', 'parked', 1, 'codex', 'queued', ${at}, '{"queueHeld":true}')`;
    const policy = { archiveAfterDays: 30, deleteAfterDays: null, now };
    assert.equal((yield* archive.runPass(policy)).archivedThreads, 1);
    assert.lengthOf(
      yield* sql`SELECT turn_item_id FROM orchestration_v2_projection_turn_items WHERE thread_id = 'parked'`,
      1,
    );
    assert.lengthOf(
      yield* sql`SELECT turn_item_id FROM orchestration_v2_projection_turn_items WHERE thread_id = 'ordinary'`,
      0,
    );
    yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed', payload_json = '{"queueHeld":false}' WHERE run_id = 'run:parked'`;
    assert.equal((yield* archive.runPass(policy)).archivedThreads, 1);
    assert.lengthOf(
      yield* sql`SELECT turn_item_id FROM orchestration_v2_projection_turn_items WHERE thread_id = 'parked'`,
      0,
    );
  }).pipe(Effect.provide(layer())),
);
