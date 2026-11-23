// @effect-diagnostics-next-line nodeBuiltinImport:off -- match a receipt to an existing transcript without copying its query.
import * as NodeCrypto from "node:crypto";
import * as M from "@goat/contracts";
import { goatCallTarget } from "@goat/contracts/agentSurface/callArguments";
import { resolveAgentSurfaceEntry } from "@goat/contracts/agentSurface/resolve";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import * as Store from "./MemoryStore.ts";
import type * as Service from "./MemoryService.ts";

type Ref = typeof M.TurnMemoryRef.Type;
const encodeResult = Schema.encodeSync(Schema.fromJsonString(M.TurnMemoryResult));
const encodeRefs = Schema.encodeSync(Schema.fromJsonString(Schema.Array(M.TurnMemoryRef)));
const decodeRefs = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(M.TurnMemoryRef)));
const decodeToolInput = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown));
const digest = (query: string) => NodeCrypto.createHash("sha256").update(query).digest("hex");
// A database-wide failure can also prevent the per-turn failure marker from being written.
let untrackedWriteFailure = false;
const eventLimit = 32;
const responseByteLimit = 60 * 1024;

export function recordTurnMemory(
  sql: SqlClient.SqlClient,
  threadId: M.ThreadId,
  runId: M.RunId,
  space: M.MemorySpaceId,
  kind: "automatic" | "recall",
  items: readonly Ref[],
  query?: string,
) {
  // Drop bodies before constructing an effect which the transport might retain across a send.
  const refs = encodeRefs(items.map(({ memoryId, revisionId }) => ({ memoryId, revisionId })));
  const queryDigest = query === undefined ? null : digest(query);
  return sql`INSERT INTO turn_memory_receipts(thread_id, run_id, space, kind, query_digest, refs_json)
    SELECT ${threadId}, ${runId}, ${space}, ${kind}, ${queryDigest}, ${refs}
    WHERE NOT EXISTS (SELECT 1 FROM orchestration_v2_events WHERE thread_id=${threadId} AND event_type='thread.deleted')
      AND (SELECT COUNT(*) FROM turn_memory_receipts WHERE thread_id=${threadId}
           AND run_id=${runId} AND space=${space}) <= ${eventLimit}`.pipe(
    Effect.asVoid,
    Effect.catch(() =>
      sql`INSERT OR IGNORE INTO turn_memory_receipt_failures(thread_id, run_id, space)
        VALUES (${threadId}, ${runId}, ${space})`.pipe(
        Effect.asVoid,
        Effect.catch(() =>
          Effect.sync(() => {
            untrackedWriteFailure = true;
          }),
        ),
        Effect.andThen(Effect.logWarning("Could not record turn memory receipt")),
      ),
    ),
  );
}

const inspectTurnMemory = Effect.fn("TurnMemory.inspect")(function* (
  sql: SqlClient.SqlClient,
  input: M.TurnMemoryInput,
  read: (ref: Ref) => Effect.Effect<M.MemoryItem, Service.MemoryServiceError>,
  authorize: Effect.Effect<void, Service.MemoryAccessError>,
) {
  yield* authorize;
  const rows = yield* sql<{
    id: number;
    kind: "automatic" | "recall";
    query_digest: string | null;
    refs_json: string;
  }>`
    SELECT id,kind,query_digest,refs_json FROM turn_memory_receipts
    WHERE thread_id=${input.threadId} AND run_id=${input.runId} AND space=${input.memorySpaceId}
    ORDER BY id LIMIT ${eventLimit + 1}`.pipe(
    Effect.mapError((cause) => new Store.MemoryStorageError({ stage: "turn-receipts", cause })),
  );
  const failures = yield* sql<{
    count: number;
  }>`SELECT COUNT(*) AS count FROM turn_memory_receipt_failures
    WHERE thread_id=${input.threadId} AND run_id=${input.runId} AND space=${input.memorySpaceId}`.pipe(
    Effect.mapError((cause) => new Store.MemoryStorageError({ stage: "turn-receipts", cause })),
  );
  const incomplete = untrackedWriteFailure || (failures[0]?.count ?? 0) > 0;
  // The receipt owns only a digest. Read query text from this run's existing transcript.
  const queries = new Map<string, string>();
  if (rows.some((row) => row.kind === "recall")) {
    const calls = yield* sql<{ tool: string; args: string }>`SELECT
        json_extract(payload_json,'$.toolName') AS tool, json_extract(payload_json,'$.input') AS args
      FROM orchestration_v2_projection_turn_items WHERE thread_id=${input.threadId} AND run_id=${input.runId}
      AND type='dynamic_tool' AND tool IN ('goat_call','goat.goat_call','mcp__goat__goat_call',
        'memory_recall','goat_memory_recall','goat.memory_recall','goat.goat_memory_recall',
        'mcp__goat__memory_recall','mcp__goat__goat_memory_recall')
      AND typeof(args)='text' AND length(args)<=8192 ORDER BY ordinal LIMIT 256`.pipe(
      Effect.mapError((cause) => new Store.MemoryStorageError({ stage: "turn-queries", cause })),
    );
    for (const { tool, args } of calls) {
      const decoded = decodeToolInput(args);
      if (decoded._tag === "None") continue;
      let input = decoded.value;
      if (tool.endsWith("goat_call")) {
        const target = goatCallTarget(input);
        if (
          typeof target.path !== "string" ||
          resolveAgentSurfaceEntry(target.path)?.path !== "memory.recall"
        )
          continue;
        input = target.args;
      }
      if (
        typeof input === "object" &&
        input !== null &&
        "query" in input &&
        typeof input.query === "string"
      ) {
        queries.set(digest(input.query), input.query);
      }
    }
  }
  const events: Array<M.TurnMemoryResult["events"][number]> = [];
  const visible = new Map<M.MemoryId, M.MemoryItem | null>();
  for (const row of rows.slice(0, eventLimit)) {
    const refs = yield* decodeRefs(row.refs_json).pipe(
      Effect.mapError(() => new Store.MemoryStoreConflict({ code: "invalid_output" })),
    );
    const items: Array<M.TurnMemoryResult["events"][number]["items"][number]> = [];
    for (const ref of refs) {
      if (!visible.has(ref.memoryId)) {
        visible.set(ref.memoryId, yield* read(ref).pipe(Effect.orElseSucceed(() => null)));
      }
      const item = visible.get(ref.memoryId);
      if (item?.status !== "active" || item.localAvailability.exposure !== "visible") continue;
      items.push({
        ...ref,
        excerpt:
          item.revision.revisionId === ref.revisionId
            ? Array.from(item.payload.text).slice(0, 128).join("")
            : null,
      });
    }
    events.push({
      id: String(row.id),
      kind: row.kind,
      items,
      query:
        items.length === refs.length && row.query_digest
          ? (queries.get(row.query_digest) ?? null)
          : null,
    });
  }
  yield* authorize;
  let truncated = rows.length > eventLimit;
  while (
    Buffer.byteLength(encodeResult({ events, truncated: true, incomplete }), "utf8") >
    responseByteLimit
  ) {
    events.pop();
    truncated = true;
  }
  return { events, truncated, ...(incomplete ? { incomplete: true } : {}) };
});

export const makeTurnMemoryReader =
  (
    sql: SqlClient.SqlClient,
    store: Store.MemoryStore["Service"],
    read: Service.MemoryService["Service"]["read"],
  ) =>
  (input: M.TurnMemoryInput, permit: Effect.Effect<void, Service.MemoryAccessError>) =>
    store.transact(
      inspectTurnMemory(
        sql,
        input,
        ({ memoryId }) => read({ memorySpaceId: input.memorySpaceId, memoryId }, permit),
        permit,
      ),
      { finalGuard: permit },
    );
