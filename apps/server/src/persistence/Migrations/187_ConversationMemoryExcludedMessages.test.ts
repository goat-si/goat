import { ChannelInputId, ChannelTaskId } from "@goat/contracts";
import { turnSteerIdsFor, workerLaunchIdsFor } from "../../channels/channelIds.ts";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { setConversationMemoryEnabled } from "../../memory/conversationMemoryPolicy.ts";
import { runMigrations } from "../Migrations.ts";

it.effect("recovers paused edits and ambiguous compacted edits from a 186 database", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 186 });
    let version = 0;
    const event = (type: string, payload: Record<string, unknown>) => {
      version++;
      return sql`INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
         actor_kind, payload_json, metadata_json, application_event_version)
        VALUES (${"rev-" + version}, 'thread', 'recovery', ${version}, ${type}, '2026-11-01',
          'user', ${JSON.stringify(payload)}, '{}', 2)`;
    };
    const message = (id: string, role = "user") =>
      event("message.updated", { id, role, streaming: true });
    yield* message("compacted");
    yield* message("only-before");
    yield* setConversationMemoryEnabled(sql, false);
    yield* message("compacted");
    yield* message("retained", "assistant");
    yield* setConversationMemoryEnabled(sql, true);
    yield* message("compacted");
    yield* message("clean");
    yield* sql`DELETE FROM orchestration_events WHERE event_id='rev-3'`;
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 187 }), [
      [187, "ConversationMemoryExcludedMessages"],
    ]);
    const excluded = sql<{
      message_id: string;
    }>`SELECT message_id FROM conversation_memory_excluded_messages ORDER BY message_id`.pipe(
      Effect.map((rows) => rows.map((row) => row.message_id)),
    );
    assert.deepEqual(yield* excluded, ["compacted", "retained"]);
    yield* setConversationMemoryEnabled(sql, false);
    yield* message("new", "assistant");
    yield* message("new", "assistant");
    assert.deepEqual(yield* excluded, ["compacted", "new", "retained"]);
    yield* event("thread.deleted", {});
    assert.isEmpty(yield* excluded);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("recovers dispatched channel input and follow-up origins from a 186 database", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 186 });
    yield* setConversationMemoryEnabled(sql, false);
    yield* setConversationMemoryEnabled(sql, true);
    yield* sql`INSERT INTO channel_conversations (conversation_id, owner_id, kind, connection_id, conversation_key, last_activity_at)
      VALUES ('c','owner','slack','s','c','now')`;
    yield* sql`INSERT INTO channel_bindings (binding_id,conversation_id,connection_id,reply_address_json,last_activity_at)
      VALUES ('b','c','s','{}','now')`;
    for (const enabled of [0, 1]) {
      const inputId = String(enabled);
      yield* sql`INSERT INTO channel_inbox
        (input_id,owner_id,kind,connection_id,idempotency_key,content_hash,conversation_id,binding_id,message_json,state,accepted_at,conversation_memory_enabled)
        VALUES (${inputId},'owner','slack','s',${inputId},'hash','c','b','{}','accepted','now',${enabled})`;
      yield* sql`INSERT INTO channel_tasks(task_id,owner_id,conversation_id,status,version,generation,task_json,created_at,updated_at)
        VALUES (${inputId},'owner','c','running',1,1,json_object('originInputId',${inputId}),'now','now')`;
    }
    yield* sql`INSERT INTO channel_bot_session_runs(thread_id,message_id,task_id,task_generation,kind,created_at)
      VALUES ('session','initial','0',1,'input','now')`;
    const launch = workerLaunchIdsFor(ChannelTaskId.make("0"), 1);
    yield* sql`INSERT INTO channel_runtime_state (key,value_json,updated_at)
      VALUES (${"channel-worker-context:" + launch.threadId},'{"taskId":"0","generation":1}','now')`;
    yield* sql`INSERT INTO channel_task_events(event_id,task_id,task_version,type,event_json,occurred_at)
      VALUES ('forward','1',1,'task.followup.received','{"actor":"user","payload":{"inputId":"0"}}','now')`;
    const forwarded = turnSteerIdsFor(ChannelInputId.make("0"), "queued").messageId;
    const msg = (thread: string, id: string) =>
      sql`INSERT INTO orchestration_v2_projection_messages (message_id,thread_id,role,streaming,created_at,updated_at,payload_json)
        VALUES (${id},${thread},'user',0,'now','now','{}')`;
    yield* msg(launch.threadId, launch.messageId);
    yield* msg(launch.threadId, "manual-web-turn");
    yield* msg("session", forwarded);
    yield* msg("session", "ordinary");
    yield* runMigrations({ toMigrationInclusive: 187 });
    assert.deepEqual(
      yield* sql`SELECT message_id FROM conversation_memory_excluded_messages ORDER BY message_id`,
      [forwarded, "initial", launch.messageId].sort().map((message_id) => ({ message_id })),
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
