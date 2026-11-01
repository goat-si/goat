import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadArchiveGate from "./ThreadArchiveGate.ts";
import * as ThreadHistoryArchive from "./ThreadHistoryArchive.ts";
import * as ThreadHistoryArchiveLabels from "./ThreadHistoryArchiveLabels.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const now = Date.parse("2026-10-22T00:00:00.000Z");
const at = DateTime.formatIso(DateTime.makeUnsafe(now - 40 * 86_400_000));

it.effect("records archive changes on threads and corrects drift at startup", () =>
  Effect.gen(function* () {
    const recorded = yield* Queue.unbounded<{
      readonly threadId: string;
      readonly historyArchive: unknown;
    }>();
    const database = Layer.mergeAll(
      ThreadHistoryArchive.layer.pipe(
        Layer.provide(
          Layer.succeed(
            ThreadArchiveGate.ThreadArchiveGate,
            ThreadArchiveGate.makeThreadArchiveGateSlot(),
          ),
        ),
      ),
    ).pipe(
      Layer.provideMerge(SqlitePersistence.layerMemory),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "thread-archive-labels-" }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const archive = yield* ThreadHistoryArchive.ThreadHistoryArchive;
      // "stale" says archived but has no archive; "idle" has history to archive.
      for (const [threadId, payload] of [
        ["stale", '{"historyArchive":"archived"}'],
        ["idle", "{}"],
      ] as const)
        yield* sql`INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
          VALUES (${threadId}, 'project', ${threadId}, 'codex', 'full-access', 'default', ${at}, ${at}, ${payload})`;
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
        VALUES ('idle:item', 'idle', 0, 'command_execution', 'completed', ${at}, '{"id":"idle:item","output":"x"}')`;
      yield* Effect.scoped(
        Layer.build(
          ThreadHistoryArchiveLabels.layer.pipe(
            Layer.provide(
              Layer.mock(ThreadManagement.ThreadManagementService)({
                dispatch: (command) =>
                  Queue.offer(recorded, {
                    threadId: "threadId" in command ? String(command.threadId) : "",
                    historyArchive:
                      "historyArchive" in command ? command.historyArchive : undefined,
                  }).pipe(Effect.as(undefined as never)),
              }),
            ),
            Layer.provide(Layer.succeed(ThreadHistoryArchive.ThreadHistoryArchive, archive)),
          ),
        ).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              assert.deepEqual(yield* Queue.take(recorded), {
                threadId: "stale",
                historyArchive: null,
              });
              yield* archive.runPass({ archiveAfterDays: 30, deleteAfterDays: null, now });
              assert.deepEqual(yield* Queue.take(recorded), {
                threadId: "idle",
                historyArchive: "archived",
              });
              yield* archive.restore("idle");
              assert.deepEqual(yield* Queue.take(recorded), {
                threadId: "idle",
                historyArchive: null,
              });
            }),
          ),
        ),
      );
    }).pipe(Effect.provide(database));
  }),
);
