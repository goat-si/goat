import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { stored } from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import type { MemoryStorageError } from "./StoreModel.ts";

export interface ThreadLineage {
  readonly state: "tracked" | "unknown" | "overflow";
  readonly revisions: readonly M.MemoryRevisionId[];
}

// Bounds the walk over app-owned task results.
const MAX_TASK_RESULT_SOURCES = 100;
const limit = M.MEMORY_THREAD_LINEAGE_MAX;
const encodeRevisions = Schema.encodeSync(Schema.fromJsonString(Schema.Array(M.MemoryRevisionId)));

export const makeThreadLineage = ({ sql, transact }: Pick<StoreKernel, "sql" | "transact">) => {
  const readOwnLineage = Effect.fn("ThreadLineage.readOwn")(function* (thread: M.ScopedThreadRef) {
    const { environmentId, threadId } = thread;
    const rows = yield* stored(
      "thread-lineage-read",
      sql<{ space: string; state: ThreadLineage["state"]; revision_id: string | null }>`
        SELECT h.space,h.state,r.revision_id FROM memory_thread_lineages h
        LEFT JOIN memory_thread_lineage_revisions r USING(environment_id,thread_id)
        WHERE h.environment_id=${environmentId} AND h.thread_id=${threadId} ORDER BY r.ordinal`,
    );
    return {
      space: rows[0]?.space,
      state: rows[0]?.state ?? "tracked",
      revisions: rows.flatMap((row) =>
        row.revision_id === null ? [] : [M.MemoryRevisionId.make(row.revision_id)],
      ),
    };
  });
  const hasUnknownOrigin = Effect.fn("ThreadLineage.hasUnknownOrigin")(function* (
    thread: M.ScopedThreadRef,
  ) {
    const unknown = yield* stored(
      "thread-lineage-origin",
      sql`SELECT 1 FROM orchestration_events
      WHERE application_event_version=2 AND aggregate_kind='thread' AND stream_id=${thread.threadId}
      AND ((event_type='thread.created' AND (
        json_extract(payload_json,'$.forkedFrom.type') IN ('run','provider_thread')
        OR json_extract(payload_json,'$.lineage.relationshipToParent')='fork'
        OR json_extract(payload_json,'$.historyOrigin')='v1_import'
        OR (json_extract(payload_json,'$.creationSource')='provider' AND (
          json_extract(payload_json,'$.lineage.relationshipToParent')='subagent'
          OR json_extract(payload_json,'$.forkedFrom.type')='node'
          OR json_extract(payload_json,'$.lineage.parentThreadId') IS NOT NULL))))
        OR (event_type='provider-thread.updated' AND json_extract(payload_json,'$.forkedFrom.providerThreadId') IS NOT NULL)
        OR (event_type='provider-thread.updated' AND json_extract(payload_json,'$.status')='not_loaded' AND json_extract(payload_json,'$.nativeThreadRef') IS NOT NULL AND json_extract(payload_json,'$.providerSessionId') IS NULL)
        OR (event_type IN ('context-transfer.created','context-transfer.updated')
          AND json_extract(payload_json,'$.type') IS NOT 'subagent_spawn'
          AND json_extract(payload_json,'$.type') IS NOT 'subagent_result'
          AND json_extract(payload_json,'$.targetThreadId')=${thread.threadId}
          AND json_extract(payload_json,'$.sourceThreadId')!=${thread.threadId})) LIMIT 1`,
    );
    return unknown.length > 0;
  });
  const taskResultSources = (threadId: M.ThreadId) =>
    stored(
      "thread-lineage-results",
      sql<{ source: string | null; linked: number }>`
      SELECT DISTINCT json_extract(t.payload_json,'$.sourceThreadId') AS source,
        (EXISTS(SELECT 1 FROM orchestration_events s
          WHERE s.application_event_version=2 AND s.aggregate_kind='thread' AND s.stream_id=${threadId}
          AND s.event_type='subagent.updated' AND json_extract(s.payload_json,'$.origin')='app_owned'
          AND json_extract(s.payload_json,'$.childThreadId')=json_extract(t.payload_json,'$.sourceThreadId'))
        AND EXISTS(SELECT 1 FROM orchestration_events c
          WHERE c.application_event_version=2 AND c.aggregate_kind='thread'
          AND c.stream_id=json_extract(t.payload_json,'$.sourceThreadId') AND c.event_type='thread.created'
          AND json_extract(c.payload_json,'$.lineage.parentThreadId')=${threadId}
          AND json_extract(c.payload_json,'$.lineage.relationshipToParent')='subagent'
          AND json_extract(c.payload_json,'$.creationSource') IS NOT 'provider')
        AND NOT EXISTS(SELECT 1 FROM orchestration_events d
          WHERE d.application_event_version=2 AND d.aggregate_kind='thread'
          AND d.stream_id=json_extract(t.payload_json,'$.sourceThreadId') AND d.event_type='thread.deleted')) AS linked
      FROM orchestration_events t
      WHERE t.application_event_version=2 AND t.aggregate_kind='thread' AND t.stream_id=${threadId}
      AND t.event_type IN ('context-transfer.created','context-transfer.updated')
      AND json_extract(t.payload_json,'$.type')='subagent_result'
      AND json_extract(t.payload_json,'$.targetThreadId')=${threadId}
      AND json_extract(t.payload_json,'$.sourceThreadId') IS NOT ${threadId}`,
    );
  const collect = Effect.fn("ThreadLineage.collect")(function* (
    thread: M.ScopedThreadRef,
    space: M.MemorySpaceId,
    own: Effect.Success<ReturnType<typeof readOwnLineage>>,
  ): Effect.fn.Return<ThreadLineage, MemoryStorageError> {
    if (own.space !== undefined && own.space !== space) return { state: "unknown", revisions: [] };
    const revisions = new Set(own.revisions);
    const result = (state: ThreadLineage["state"]): ThreadLineage => ({
      state,
      revisions: [...revisions].slice(0, limit),
    });
    let state: ThreadLineage["state"] = (yield* hasUnknownOrigin(thread)) ? "unknown" : own.state;
    const visited = new Set<string>([thread.threadId]);
    const pending = [thread.threadId];
    for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
      for (const { source, linked } of yield* taskResultSources(next)) {
        if (!source || !linked || visited.has(source)) {
          state = "unknown";
          continue;
        }
        visited.add(source);
        if (visited.size > MAX_TASK_RESULT_SOURCES + 1) return result("overflow");
        const child = { ...thread, threadId: M.ThreadId.make(source) };
        const lineage = yield* readOwnLineage(child);
        if (lineage.space !== undefined && lineage.space !== space) {
          state = "unknown";
          continue;
        }
        for (const revision of lineage.revisions) revisions.add(revision);
        if (revisions.size > limit) return result("overflow");
        if ((yield* hasUnknownOrigin(child)) || lineage.state === "unknown") state = "unknown";
        else if (state === "tracked" && lineage.state === "overflow") state = "overflow";
        pending.push(child.threadId);
      }
    }
    return result(state);
  });
  const readThreadLineage = Effect.fn("MemoryStore.readThreadLineage")(function* (
    thread: M.ScopedThreadRef,
    space: M.MemorySpaceId,
  ) {
    return yield* collect(thread, space, yield* readOwnLineage(thread));
  });
  const appendThreadLineage = Effect.fn("MemoryStore.appendThreadLineage")(function* (
    thread: M.ScopedThreadRef,
    space: M.MemorySpaceId,
    revisions: ReadonlyArray<M.MemoryRevisionId>,
    markUnknown = false,
  ) {
    return yield* transact(
      Effect.gen(function* () {
        const { environmentId, threadId } = thread;
        const own = yield* readOwnLineage(thread);
        if (own.space !== undefined && own.space !== space) return false;
        const previous = yield* collect(thread, space, own);
        const union = new Set([...previous.revisions, ...revisions]);
        const state = markUnknown ? "unknown" : union.size > limit ? "overflow" : previous.state;
        const added = [...union].slice(own.revisions.length, limit);
        if (own.space === undefined || state !== own.state || added.length)
          yield* stored(
            "thread-lineage-header",
            sql`INSERT INTO memory_thread_lineages (environment_id,thread_id,space,state,count)
              VALUES (${environmentId},${threadId},${space},${state},${Math.min(union.size, limit)})
              ON CONFLICT(environment_id,thread_id) DO UPDATE SET state=excluded.state,count=excluded.count`,
          );
        if (added.length)
          yield* stored(
            "thread-lineage-write",
            sql`INSERT INTO memory_thread_lineage_revisions (environment_id,thread_id,ordinal,revision_id)
              SELECT ${environmentId},${threadId},key+${own.revisions.length},value
              FROM json_each(${encodeRevisions(added)})`,
          );
        return true;
      }),
    );
  });
  const deleteThreadLineage = Effect.fn("MemoryStore.deleteThreadLineage")(function* ({
    environmentId,
    threadId,
  }: M.ScopedThreadRef) {
    yield* transact(
      Effect.gen(function* () {
        yield* stored(
          "thread-lineage-delete-revisions",
          sql`DELETE FROM memory_thread_lineage_revisions WHERE environment_id=${environmentId} AND thread_id=${threadId}`,
        );
        yield* stored(
          "thread-lineage-delete",
          sql`DELETE FROM memory_thread_lineages WHERE environment_id=${environmentId} AND thread_id=${threadId}`,
        );
      }),
    );
  });
  return { readThreadLineage, appendThreadLineage, deleteThreadLineage };
};
