import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { makeShellThreadRows } from "../orchestration-v2/ProjectionShellThreadRows.ts";
import { stored } from "./store/StoreCodecs.ts";

const decodeMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(M.OrchestrationV2ConversationMessageJson),
);
const normalize = (text: string) => text.normalize("NFC").replace(/\s+/gu, " ").trim();

export const matchesActivePersonWords = Effect.fn("MemoryService.matchesActivePersonWords")(
  function* (threadId: M.ThreadId, text: string) {
    const words = normalize(text);
    if (Array.from(words).length < 4) return false;
    const sql = yield* SqlClient.SqlClient;
    const { isSilentShellRun } = makeShellThreadRows(sql);
    const [row] = yield* stored(
      "person-words-root",
      sql<{ payload_json: string }>`
        SELECT m.payload_json FROM orchestration_v2_projection_threads t
        JOIN orchestration_v2_projection_runs r ON r.thread_id=t.thread_id AND r.run_id=(
          SELECT active.run_id FROM orchestration_v2_projection_runs active
          WHERE active.thread_id=t.thread_id
            AND active.status IN ('preparing','starting','running','waiting')
            AND NOT ${isSilentShellRun("active")}
          ORDER BY active.ordinal DESC,active.run_id DESC LIMIT 1
        )
        JOIN orchestration_v2_projection_messages m ON m.thread_id=r.thread_id
          AND m.message_id=json_extract(r.payload_json,'$.userMessageId')
        WHERE t.thread_id=${threadId} AND t.deleted_at IS NULL AND t.archived_at IS NULL`,
    );
    if (!row) return false;
    const message = yield* decodeMessage(row.payload_json).pipe(Effect.option);
    if (message._tag === "None") return false;
    const root = message.value;
    return (
      root.role === "user" &&
      root.ingress === "person" &&
      root.createdBy === "user" &&
      (root.creationSource === "web" || root.creationSource === "mobile") &&
      root.scheduledTaskId === undefined &&
      root.senderThreadId === undefined &&
      root.context?.guest === undefined &&
      root.delegatedCompletion === undefined &&
      root.notification === undefined &&
      normalize(root.text).includes(words)
    );
  },
);
