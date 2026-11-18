import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { stored } from "./store/StoreCodecs.ts";

const legacyPayload = (payload: M.MemoryPayload) =>
  payload.derivedFromMemoryRevisions.length > M.MEMORY_DERIVED_REVISIONS_MAX_V1
    ? { ...payload, derivedFromMemoryRevisions: [] }
    : payload;

const clientRevision = (revision: M.MemoryRevision) => {
  const { unverified, originThreadId, ...provenance } = revision.provenance;
  return unverified || originThreadId ? { ...revision, provenance } : revision;
};

export const makeMemoryViewProjection = (sql: SqlClient.SqlClient) => {
  const marksFor = Effect.fn("MemoryService.readProjectedMarks")(function* (
    space: M.MemorySpaceId,
    memoryId: M.MemoryId,
    revisionId: M.MemoryRevisionId | undefined,
  ) {
    const [row] = yield* stored(
      "memory-project-marks",
      sql<{ thread_id: string | null; provenance: "unverified" | null }>`
        SELECT (SELECT thread_id FROM memory_origins WHERE space=${space} AND memory_id=${memoryId}) AS thread_id,
          (SELECT provenance FROM memory_revision_marks WHERE space=${space} AND revision_id=${revisionId ?? null}) AS provenance`,
    );
    return {
      ...(row?.thread_id ? { originThreadId: M.ThreadId.make(row.thread_id) } : {}),
      ...(row?.provenance ? { provenance: row.provenance } : {}),
    };
  });
  const item = Effect.fn("MemoryService.projectItem")(function* (
    item: M.MemoryItem,
    includeMarks?: true,
  ) {
    const projected =
      item.status === "active"
        ? {
            ...item,
            revision: clientRevision(item.revision),
            payload: includeMarks ? item.payload : legacyPayload(item.payload),
          }
        : item;
    if (!includeMarks) return projected;
    const marks = yield* marksFor(
      item.memorySpaceId,
      item.memoryId,
      item.status === "active" ? item.revision.revisionId : undefined,
    );
    return { ...projected, marks };
  });
  const revision = Effect.fn("MemoryService.projectHistoryRevision")(function* (
    pair: { revision: M.MemoryRevision; payload: M.MemoryPayload | null },
    includeMarks?: true,
  ) {
    const { memorySpaceId, memoryId, revisionId } = pair.revision;
    return {
      revision: clientRevision(pair.revision),
      payload: includeMarks || pair.payload === null ? pair.payload : legacyPayload(pair.payload),
      ...(includeMarks ? { marks: yield* marksFor(memorySpaceId, memoryId, revisionId) } : {}),
    };
  });
  return { item, revision };
};
