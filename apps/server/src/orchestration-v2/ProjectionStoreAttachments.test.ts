import { assert, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { createDeterministicAttachmentId } from "../attachmentStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);
const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect("counts a page rendered through goat_call as the thread's attachment", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("goat-call-page");
    const attachmentId = createDeterministicAttachmentId(threadId, "page")!;
    const page = { attachmentId, title: "Chart", height: 300 };
    const envelope = { status: "ok", value: { htmlRender: page } };
    const call = (turnItemId: string, path: string) => ({
      turnItemId,
      payload: {
        toolName: "mcp__goat__goat_call",
        input: { path, args: { title: "Chart" } },
        output: [{ type: "text", text: JSON.stringify(envelope) }],
      },
    });
    // The second call names another tool, so its result is not a page whatever it holds.
    for (const [ordinal, { turnItemId, payload }] of [
      call("render", "html.render"),
      call("send", "thread.send"),
    ].entries()) {
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json) VALUES (${turnItemId}, ${threadId}, ${ordinal}, 'dynamic_tool', 'completed', '2026-10-24T00:00:00Z', ${encodeUnknownJsonString(payload)})`;
    }
    assert.deepEqual(yield* store.getThreadAttachmentIds(threadId), [attachmentId]);
  }).pipe(Effect.provide(layerTest)),
);
