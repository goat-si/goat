import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { matchingTerms } from "./MemoryRecall.ts";
import type * as Store from "./MemoryStore.ts";
import { scopeKey } from "./store/StoreCodecs.ts";
import { recallMatch, recallTerms } from "./store/SearchText.ts";

type StoreService = Store.MemoryStore["Service"];
const encodeThreadIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(M.ThreadId)));

export const relatedKeysFor = Effect.fn("MemorySnapshot.relatedKeysFor")(function* (
  store: StoreService,
  sql: SqlClient.SqlClient,
  space: M.MemorySpaceId,
  own: M.ScopedThreadRef,
  project: M.ScopedProjectRef,
) {
  const binding = yield* store.getProjectBinding(space, project);
  if (!binding?.projectKey) return new Map<string, string>();
  const related = yield* store.relatedThreads(
    space,
    own.environmentId,
    binding.projectKey,
    own.threadId,
  );
  if (!related.threads.length) return new Map<string, string>();
  const ids = yield* encodeThreadIds(related.threads);
  const rows = yield* sql<{ thread_id: string; project_id: string; version: number }>`
    SELECT t.thread_id,t.project_id,b.version
    FROM orchestration_v2_projection_threads t
    JOIN memory_project_bindings b ON b.project_id=t.project_id
    WHERE b.memory_space_id=${space} AND b.environment_id=${own.environmentId}
      AND t.thread_id IN (SELECT value FROM json_each(${ids})) AND t.deleted_at IS NULL`;
  return new Map(
    rows.map((row) => [
      scopeKey({
        kind: "thread",
        thread: { environmentId: own.environmentId, threadId: M.ThreadId.make(row.thread_id) },
      }),
      JSON.stringify([row.project_id, row.version]),
    ]),
  );
});

export const isRelated = (scope: M.MemoryScope, own: M.ScopedThreadRef) =>
  scope.kind === "thread" &&
  (scope.thread.environmentId !== own.environmentId || scope.thread.threadId !== own.threadId);

export const selectRelated = Effect.fn("MemorySnapshot.selectRelated")(function* (
  store: StoreService,
  sql: SqlClient.SqlClient,
  space: M.MemorySpaceId,
  own: M.ScopedThreadRef,
  project: M.ScopedProjectRef,
  message: string,
  selectedIds: ReadonlySet<M.MemoryId>,
) {
  const terms = recallTerms(message.slice(0, 500));
  const match = recallMatch(terms);
  const empty = { items: [] as M.MemoryContextCandidate[], bindings: new Map<string, string>() };
  if (!match) return empty;
  return yield* store.transact(
    Effect.gen(function* () {
      const lineage = yield* store.readThreadLineage(own, space);
      if (lineage.state !== "tracked") return empty;
      const keys = yield* relatedKeysFor(store, sql, space, own, project);
      if (!keys.size) return empty;
      const selection = yield* store.recallCandidates(space, [...keys.keys()], match);
      const revisions = new Set(lineage.revisions);
      const result: M.MemoryContextCandidate[] = [];
      for (const candidate of selection.candidates) {
        if (selectedIds.has(candidate.memoryId)) continue;
        const aggregate = yield* store.loadAggregate(
          space,
          candidate.memoryId,
          { heads: true },
          {},
        );
        const item = aggregate.item;
        if (
          aggregate.tombstone ||
          aggregate.pendingForget ||
          aggregate.heads.length !== 1 ||
          !item ||
          item.status !== "active" ||
          item.memorySpaceId !== space ||
          item.localAvailability.exposure !== "visible" ||
          scopeKey(item.scope) !== candidate.scopeKey ||
          !keys.has(candidate.scopeKey) ||
          aggregate.heads[0] !== item.revision.revisionId
        )
          continue;
        const pair = aggregate.revisions.find(
          (entry) => entry.revision.revisionId === item.revision.revisionId,
        );
        if (!pair?.payload || matchingTerms(pair.payload.text, terms).length / terms.length < 0.34)
          continue;
        const closure = [pair.revision.revisionId, ...pair.payload.derivedFromMemoryRevisions];
        const next = new Set([...revisions, ...closure]);
        if (next.size > 80) continue;
        result.push({
          memoryId: item.memoryId,
          revisionId: pair.revision.revisionId,
          scope: item.scope,
          provenance: pair.revision.provenance,
          assertionKind: pair.revision.assertionKind,
          text: pair.payload.text,
        });
        for (const revision of closure) revisions.add(revision);
        if (result.length === 3) break;
      }
      return { items: result, bindings: keys };
    }),
  );
});
