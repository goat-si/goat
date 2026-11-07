import * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Projection from "../orchestration-v2/ProjectionStore.ts";
import * as Settings from "../serverSettings.ts";
import * as Service from "./MemoryService.ts";
import * as Store from "./MemoryStore.ts";
import * as Sync from "./MemorySyncService.ts";
import { scopeKey } from "./store/StoreCodecs.ts";
import { recallMatch, recallTerms } from "./store/SearchText.ts";

const decodeRecallInput = Schema.decodeEffect(M.MemoryRecallInput);
const encodeRecallResult = Schema.encodeUnknownEffect(M.MemoryRecallResult);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const building = "Memory search index is still building; try again shortly.";
const weakNote =
  "No strong matches. Rephrase, try the other language, or include a key name or id.";
const packedNote = "Some matches did not fit in the response.";
const scopeNote = "Some project identities are unresolved; related-thread coverage is incomplete.";
const relationBoost = { this_thread: 1, project_thread: 0.6, project: 0.6, user: 0.4 } as const;
export const matchingTerms = (text: string, terms: readonly string[]) => {
  const normalized = text.normalize("NFC").toLowerCase();
  return terms.filter((term) => {
    if (/[_\-.:/\uac00-\ud7a3]/u.test(term)) return normalized.includes(term);
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}`, "u").test(normalized);
  });
};

export class MemoryRecall extends Context.Service<
  MemoryRecall,
  {
    readonly recall: (
      input: M.MemoryRecallInput,
      permit: Effect.Effect<void, Service.MemoryAccessError>,
      caller?: M.ScopedThreadRef,
    ) => Effect.Effect<M.MemoryRecallResult, Service.MemoryServiceError>;
  }
>()("goat/memory/MemoryRecall") {}

export const layer = Layer.effect(
  MemoryRecall,
  Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    const service = yield* Service.MemoryService;
    const sync = yield* Sync.MemorySyncService;
    const projection = yield* Projection.ProjectionStoreV2;
    const settings = yield* Settings.MemoryHubCommittedSettings;
    const environmentId = yield* (yield* Environment.ServerEnvironmentIdentity).getEnvironmentId;
    const fenced = () => new Store.MemoryStoreConflict({ code: "fenced" });
    const unavailable = () => new Service.MemoryAccessError({ code: "unavailable" });
    const recall = Effect.fn("MemoryRecall.recall")(function* (
      input: M.MemoryRecallInput,
      permit: Effect.Effect<void, Service.MemoryAccessError>,
      caller?: M.ScopedThreadRef,
    ) {
      const value = yield* decodeRecallInput(input, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError(unavailable));
      const epoch = (yield* settings.read).version;
      const readiness = yield* sync.readLocalReadiness().pipe(Effect.mapError(unavailable));
      if ((yield* settings.read).version !== epoch) return yield* fenced();
      if (!readiness.memorySpaceId || readiness.bootstrap !== "ready") return yield* unavailable();
      const space = readiness.memorySpaceId;
      if (value.memorySpaceId && value.memorySpaceId !== space) return yield* fenced();
      if (caller && caller.environmentId !== environmentId)
        return yield* new Service.MemoryAccessError({ code: "identity_mismatch" });
      yield* permit;
      const initialShell = caller
        ? yield* projection.getThreadShell(caller.threadId).pipe(Effect.mapError(unavailable))
        : undefined;
      if (caller && initialShell && initialShell.id !== caller.threadId) return yield* fenced();
      const projectId =
        initialShell && !initialShell.deletedAt ? initialShell.projectId : undefined;
      const guard = Effect.gen(function* () {
        if ((yield* settings.read).version !== epoch) return yield* fenced();
        yield* permit;
        if ((yield* settings.read).version !== epoch) return yield* fenced();
      });
      const discoveryGuard = Effect.gen(function* () {
        yield* guard;
        if (!caller) return;
        const shell = yield* projection
          .getThreadShell(caller.threadId)
          .pipe(Effect.mapError(unavailable));
        if (
          (shell && shell.id !== caller.threadId) ||
          (shell && !shell.deletedAt ? shell.projectId : undefined) !== projectId
        )
          return yield* fenced();
      });
      yield* discoveryGuard;
      if (projectId) {
        const project = { environmentId, projectId };
        const binding = yield* store.getProjectBinding(space, project);
        if (!binding?.projectKey) {
          const admission = discoveryGuard.pipe(
            Effect.mapError((error) =>
              error._tag === "MemoryStoreConflict" ? unavailable() : error,
            ),
          );
          yield* store.transact(
            service.getProjectBinding({ memorySpaceId: space, project }, admission),
            { finalGuard: guard },
          );
        }
      }
      yield* guard;
      return yield* store.transact(
        Effect.gen(function* () {
          yield* permit;
          const relations = new Map<string, M.MemoryRecallHit["relation"]>([["user", "user"]]);
          let truncated = false;
          let projectScopeUnavailable = !!caller;
          if (caller) {
            relations.set(scopeKey({ kind: "thread", thread: caller }), "this_thread");
            const shell = yield* projection
              .getThreadShell(caller.threadId)
              .pipe(Effect.mapError(unavailable));
            if (
              (shell && shell.id !== caller.threadId) ||
              (shell && !shell.deletedAt ? shell.projectId : undefined) !== projectId
            )
              return yield* fenced();
            if (shell && !shell.deletedAt) {
              const binding = yield* store.getProjectBinding(space, {
                environmentId,
                projectId: shell.projectId,
              });
              if (binding?.projectKey) {
                projectScopeUnavailable = false;
                relations.set(
                  scopeKey({ kind: "project", projectKey: binding.projectKey }),
                  "project",
                );
                const related = yield* store.relatedThreads(
                  space,
                  environmentId,
                  binding.projectKey,
                  caller.threadId,
                );
                truncated = related.truncated;
                projectScopeUnavailable ||= related.unresolvedProjects;
                for (const threadId of related.threads)
                  relations.set(
                    scopeKey({ kind: "thread", thread: { environmentId, threadId } }),
                    "project_thread",
                  );
              }
            }
          }
          const keys = [...relations.keys()];
          const backfill = yield* store.searchCoverage({
            memorySpaceId: space,
            scope: { kind: "user" },
            limit: 1,
          });
          const totals = yield* store.recallCoverage(space, keys);
          const terms = recallTerms(value.query);
          const match = recallMatch(terms);
          const selection =
            backfill.ready && match
              ? yield* store.recallCandidates(space, keys, match)
              : { candidates: [], scanned: 0 };
          const coverage: M.MemoryRecallCoverage = {
            status: !backfill.ready
              ? "unavailable"
              : selection.scanned < totals.eligible ||
                  totals.eligible > totals.indexed ||
                  truncated ||
                  projectScopeUnavailable
                ? "partial"
                : "complete",
            eligibleItems: totals.eligible,
            scannedItems: selection.scanned,
            unindexedItems: Math.max(0, totals.eligible - totals.indexed),
            relatedThreadsTruncated: truncated,
            projectScopeUnavailable,
            projectionWatermark: totals.watermark,
          };
          const now = yield* Clock.currentTimeMillis;
          const scores = selection.candidates.map((candidate) => -candidate.rank);
          const min = Math.min(...scores),
            max = Math.max(...scores);
          const ranked: Array<{
            hit: M.MemoryRecallHit;
            revision: M.MemoryRevision;
            payload: M.MemoryPayload;
          }> = [];
          for (const candidate of selection.candidates) {
            const relation = relations.get(candidate.scopeKey);
            if (!relation) continue;
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
              aggregate.heads[0] !== item.revision.revisionId
            )
              continue;
            const pair = aggregate.revisions.find(
              (entry) => entry.revision.revisionId === item.revision.revisionId,
            );
            if (!pair?.payload) continue;
            const matchedTerms = matchingTerms(pair.payload.text, terms);
            const termCoverage = terms.length ? matchedTerms.length / terms.length : 0;
            const rel = min === max ? 1 : (-candidate.rank - min) / (max - min);
            const ageDays = Math.max(0, now - Date.parse(pair.revision.createdAtUtc)) / 86400000;
            const score = Math.max(
              0,
              Math.min(
                1,
                0.65 * rel * termCoverage +
                  0.2 * 0.5 ** (ageDays / 30) +
                  0.15 * relationBoost[relation],
              ),
            );
            ranked.push({
              revision: pair.revision,
              payload: pair.payload,
              hit: {
                memoryId: item.memoryId,
                revisionId: pair.revision.revisionId,
                scope: item.scope,
                assertionKind: pair.revision.assertionKind,
                createdAtUtc: pair.revision.createdAtUtc,
                ...(pair.revision.provenance.sourceThread
                  ? { sourceThread: pair.revision.provenance.sourceThread }
                  : {}),
                text: pair.payload.text,
                relation,
                score,
                match: termCoverage < 0.34 ? "weak" : "strong",
                matchedTerms,
              },
            });
            ranked.sort(
              (a, b) =>
                b.hit.score - a.hit.score ||
                b.hit.createdAtUtc.localeCompare(a.hit.createdAtUtc) ||
                a.hit.memoryId.localeCompare(b.hit.memoryId),
            );
            if (ranked.length > (value.limit ?? 8)) ranked.pop();
          }
          const selected: typeof ranked = [];
          const base = {
            memorySpaceId: space,
            projectionWatermark: totals.watermark,
            terms,
            indexCoverage: coverage,
          };
          const encode = encodeRecallResult;
          const makeResult = (items: M.MemoryRecallHit[], note?: string) => {
            const combined = [note, ...(projectScopeUnavailable ? [scopeNote] : [])]
              .filter(Boolean)
              .join(" ");
            return { ...base, items, ...(combined ? { note: combined } : {}) };
          };
          let note = !backfill.ready ? building : weakNote;
          let overflow = false;
          for (const candidate of ranked.slice(0, value.limit ?? 8)) {
            const hits = [...selected.map((entry) => entry.hit), candidate.hit];
            const trialNote = hits.some((hit) => hit.match === "strong") ? undefined : weakNote;
            const trial = makeResult(hits, trialNote);
            const bytes = yield* encodeJson(trial).pipe(
              Effect.mapError(() => new Store.MemoryStoreConflict({ code: "invalid_output" })),
            );
            if (new TextEncoder().encode(bytes).length > M.MEMORY_PAGE_MAX_UTF8_BYTES) {
              overflow = true;
              note = packedNote;
              continue;
            }
            yield* encode(trial).pipe(
              Effect.mapError(() => new Store.MemoryStoreConflict({ code: "invalid_output" })),
            );
            selected.push(candidate);
            note = overflow ? packedNote : (trialNote ?? "");
          }
          let result = makeResult(
            selected.map((entry) => entry.hit),
            note || undefined,
          );
          while (
            new TextEncoder().encode(
              yield* encodeJson(result).pipe(
                Effect.mapError(() => new Store.MemoryStoreConflict({ code: "invalid_output" })),
              ),
            ).length > M.MEMORY_PAGE_MAX_UTF8_BYTES &&
            selected.length
          ) {
            selected.pop();
            result = makeResult(
              selected.map((entry) => entry.hit),
              packedNote,
            );
          }
          yield* encode(result).pipe(
            Effect.mapError(() => new Store.MemoryStoreConflict({ code: "invalid_output" })),
          );
          yield* permit;
          yield* service.consumeReturned(space, caller, selected);
          return result;
        }),
        { finalGuard: guard },
      );
    });
    return MemoryRecall.of({ recall });
  }),
);
