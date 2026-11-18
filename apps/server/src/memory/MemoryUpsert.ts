import { floorWriteId } from "./store/FloorWrites.ts";
import { hubReceiptCodec } from "./store/StoreCodecs.ts";
import * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Store from "./MemoryStore.ts";
import * as Quota from "./MemoryQuotaService.ts";
import {
  closureCap,
  normalizeMemoryDependencies,
  requireClosureCapacity,
  validateSummaryDependencies,
} from "./MemoryDependencies.ts";
import { areAutomaticallyUsable, recordMemoryOrigin } from "./MemoryRevisionMarks.ts";
import { matchesActivePersonWords } from "./MemoryPersonWords.ts";
import { redactMemoryText } from "./MemorySecretScanner.ts";
import type { MemoryAccessError, MemoryServiceError } from "./MemoryService.ts";

const strict = { onExcessProperty: "error" } as const;
const decodeUpsert = Schema.decodeUnknownEffect(M.MemoryUpsertInput);
const decodePayload = Schema.decodeEffect(M.MemoryPayload);
export type MemorySuggestionAcceptance = {
  readonly origin: M.ScopedThreadRef;
  readonly unverified: boolean;
};
const encodeUpsertRequest = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      input: M.MemoryUpsertInput,
      caller: Schema.NullOr(M.ScopedThreadRef),
      acceptance: Schema.optionalKey(
        Schema.Struct({ origin: M.ScopedThreadRef, unverified: Schema.Boolean }),
      ),
    }),
  ),
);
const decode = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(Effect.mapError(() => new Store.MemoryStoreConflict({ code: "invalid_output" })));
type Permit = Effect.Effect<void, MemoryAccessError>;

export const makeUpsert = (deps: {
  readonly sql: SqlClient.SqlClient;
  readonly store: Store.MemoryStore["Service"];
  readonly submitFloorWrite?: Effect.Effect<void, MemoryServiceError>;
  readonly environmentId: M.EnvironmentId;
  readonly readBoundMemoryHubId: (
    space: M.MemorySpaceId,
  ) => Effect.Effect<M.EnvironmentId, MemoryServiceError>;
  readonly requireSharing: (space: M.MemorySpaceId) => Permit;
  readonly requireCaller: (sourceThread?: M.ScopedThreadRef) => Permit;
  readonly requireScope: (scope: M.MemoryScope) => Permit;
  readonly apply: (
    op: M.MemoryOperation,
    admission: Store.MemoryAdmissionContext,
    permit: Permit,
  ) => Effect.Effect<Store.StoredReceipt, MemoryServiceError>;
  readonly stableUuid: (input: string) => string;
  readonly hash: (input: string) => string;
}) => {
  const {
    sql,
    store,
    environmentId,
    requireSharing,
    readBoundMemoryHubId,
    requireCaller,
    requireScope,
    apply,
    stableUuid,
    hash,
  } = deps;
  const write = Effect.fn("MemoryService.stageUpsert")(function* (
    input: M.MemoryUpsertInput,
    permit: Permit,
    sourceThread?: M.ScopedThreadRef,
    remember?: { readonly allowUnverified: boolean },
    acceptance?: MemorySuggestionAcceptance,
  ) {
    const value = yield* decode(decodeUpsert(input, strict));
    return yield* store.transact(
      Effect.gen(function* () {
        yield* permit;
        yield* requireSharing(value.memorySpaceId);
        yield* requireCaller(sourceThread);
        const requestDigest = hash(
          yield* decode(
            encodeUpsertRequest({
              input: value,
              caller: sourceThread ?? null,
              ...(acceptance ? { acceptance } : {}),
            }),
          ),
        );
        const prior = yield* store.receipt(value.memorySpaceId, value.operationId);
        if (prior) {
          const rows = yield* sql<{
            request_digest: string | null;
            origin_environment_id: string;
          }>`
            SELECT json_extract(compact_json,'$.upsertRequestDigest') AS request_digest,
              json_extract(compact_json,'$.originEnvironmentId') AS origin_environment_id
            FROM memory_compact_receipts WHERE space=${value.memorySpaceId} AND operation_id=${value.operationId}
            UNION ALL SELECT json_extract(metadata_json,'$.revision.provenance.upsertRequestDigest') AS request_digest,origin_environment_id
            FROM memory_events WHERE memory_space_id=${value.memorySpaceId} AND operation_id=${value.operationId} LIMIT 1`.pipe(
            Effect.mapError(
              (cause) => new Store.MemoryStorageError({ stage: "upsert-replay", cause }),
            ),
          );
          if (
            rows[0]?.origin_environment_id !== environmentId ||
            rows[0]?.request_digest !== requestDigest
          )
            return yield* new Store.MemoryStoreConflict({ code: "operation_id_reused" });
          // Receipt recovery precedes the new-write lineage fence and dependency reads.
          // Never reconstruct the first operation with today's context or revive its body.
          if (!("hubSequence" in prior.receipt)) return prior;
          const acknowledged = prior.receipt;
          const receipt: M.MemoryMutationReceipt = {
            operationId: acknowledged.operationId,
            memoryId: acknowledged.memoryId,
            outcome: acknowledged.outcome,
            revisionId:
              acknowledged.outcome === "rejected"
                ? null
                : M.MemoryRevisionId.make(
                    stableUuid(`${value.memorySpaceId}:${value.operationId}:revision`),
                  ),
            pendingSync: false,
            ...(acknowledged.failureCode ? { failureCode: acknowledged.failureCode } : {}),
            ...(acknowledged.capacity ? { capacity: acknowledged.capacity } : {}),
            ...(acknowledged.forgetExpansion
              ? { forgetExpansion: acknowledged.forgetExpansion }
              : {}),
            ...(acknowledged.forgetRetryOf ? { forgetRetryOf: acknowledged.forgetRetryOf } : {}),
          };
          return { operationDigest: prior.operationDigest, receipt };
        }
        const workId = floorWriteId(value.memorySpaceId, value.operationId);
        const staged = yield* store.readWork(workId);
        if (staged && "authorityFirst" in staged.metadata && staged.metadata.authorityFirst) {
          if (staged.metadata.revision?.provenance.upsertRequestDigest !== requestDigest)
            return yield* new Store.MemoryStoreConflict({ code: "operation_id_reused" });
          const [row] = yield* sql<{ completed_receipt_json: string | null }>`
            SELECT completed_receipt_json FROM memory_outbox WHERE id=${workId}`.pipe(
            Effect.mapError(
              (cause) => new Store.MemoryStorageError({ stage: "floor-write-replay", cause }),
            ),
          );
          const terminal = row?.completed_receipt_json
            ? yield* hubReceiptCodec.decode(row.completed_receipt_json, strict)
            : undefined;
          if (terminal?.capacity) return yield* new Store.MemoryCapacityError(terminal.capacity);
          if (terminal?.outcome === "rejected")
            return yield* new Store.MemoryStoreConflict({
              code: terminal.failureCode ?? "invalid_output",
            });
          if (staged.status === "cancelled")
            return yield* new Store.MemoryStoreConflict({ code: "source_invalidated" });
          return {
            operationDigest: staged.metadata.authorityFirst,
            receipt: {
              operationId: value.operationId,
              memoryId: value.memoryId,
              outcome: terminal?.outcome ?? ("accepted" as const),
              revisionId: null,
              pendingSync: !terminal,
            },
          };
        }
        yield* requireScope(value.scope);
        const space = value.memorySpaceId;
        const limit = yield* closureCap(space);
        const lineage = sourceThread
          ? yield* store.readThreadLineage(sourceThread, space)
          : undefined;
        const current =
          remember || value.expectedHeads.length
            ? yield* store.loadAggregate(space, value.memoryId, { heads: true }, {})
            : undefined;
        const heads =
          current?.revisions.filter((pair) =>
            value.expectedHeads.includes(pair.revision.revisionId),
          ) ?? [];
        const inherited = new Set(
          heads.flatMap((pair) => pair.payload?.derivedFromMemoryRevisions ?? []),
        );
        const supplied = value.payload.derivedFromMemoryRevisions;
        const known = new Set([...inherited, ...supplied, ...(lineage?.revisions ?? [])]);
        if (
          remember &&
          lineage?.state === "tracked" &&
          known.size > limit &&
          limit === M.MEMORY_DERIVED_REVISIONS_MAX_V1
        )
          return yield* new Store.MemoryStoreConflict({ code: "hub_upgrade_required" });
        const unverified = lineage !== undefined && lineage.state !== "tracked";
        if (unverified) {
          if (
            !sourceThread ||
            !remember?.allowUnverified ||
            current?.identity ||
            !(yield* matchesActivePersonWords(sourceThread.threadId, value.payload.text))
          )
            return yield* new Store.MemoryStoreConflict({ code: "thread_lineage_incomplete" });
          if (limit === M.MEMORY_DERIVED_REVISIONS_MAX_V1)
            return yield* new Store.MemoryStoreConflict({ code: "hub_upgrade_required" });
        }

        yield* requireClosureCapacity(known.size, limit);
        const revisionId = M.MemoryRevisionId.make(
          stableUuid(`${space}:${value.operationId}:revision`),
        );
        let payload: M.MemoryPayload = yield* normalizeMemoryDependencies(
          space,
          redactMemoryText({
            ...value.payload,
            derivedFromMemoryRevisions: supplied.filter((id) => !inherited.has(id)),
          }),
        );
        if (lineage || inherited.size) {
          const dependencies = [
            ...new Set([
              ...payload.derivedFromMemoryRevisions,
              ...inherited,
              ...(lineage?.revisions ?? []),
            ]),
          ];
          yield* requireClosureCapacity(dependencies.length, limit);
          payload = yield* decode(
            decodePayload({ ...payload, derivedFromMemoryRevisions: dependencies }, strict),
          );
          yield* validateSummaryDependencies(space, payload);
        }
        const marked =
          unverified ||
          acceptance?.unverified ||
          !(yield* areAutomaticallyUsable(
            space,
            heads.map((head) => head.revision.revisionId),
          ));
        if ((marked || acceptance) && limit === M.MEMORY_DERIVED_REVISIONS_MAX_V1)
          return yield* new Store.MemoryStoreConflict({ code: "hub_upgrade_required" });
        const origin = current?.identity
          ? undefined
          : (acceptance?.origin ?? (remember ? sourceThread : undefined));
        const wide = payload.derivedFromMemoryRevisions.length > M.MEMORY_DERIVED_REVISIONS_MAX_V1;
        const forgetFence =
          marked || acceptance
            ? yield* store.readCursor(space, yield* readBoundMemoryHubId(space))
            : undefined;
        const op: M.MemoryOperation = {
          protocolVersion: 1,
          kind: "upsert",
          ...(forgetFence === undefined ? {} : { forgetFence }),
          memorySpaceId: value.memorySpaceId,
          memoryId: value.memoryId,
          operationId: value.operationId,
          originEnvironmentId: environmentId,
          expectedHeads: value.expectedHeads,

          revision: {
            memorySpaceId: value.memorySpaceId,
            memoryId: value.memoryId,
            operationId: value.operationId,
            revisionId,
            payloadRef: revisionId,
            parents: value.expectedHeads,
            scope: value.scope,
            assertionKind: value.assertionKind,
            provenance: {
              environmentId,
              upsertRequestDigest: requestDigest,
              ...(marked ? { unverified: true as const } : {}),
              ...(origin && (marked || wide || acceptance)
                ? { originThreadId: origin.threadId }
                : {}),
            },
            createdAtUtc: M.MemoryUtcTimestamp.make(
              DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
            ),
          },
          payload,
        };
        const result = yield* apply(op, Store.localIntent, permit);
        if (result.receipt.outcome !== "rejected" && origin && !M.requiresMemoryFloor2(op))
          yield* recordMemoryOrigin(space, value.memoryId, origin);
        return result;
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    );
  }, Quota.withStoreReclaim(environmentId));
  return Effect.fn("MemoryService.upsert")(function* (...args: Parameters<typeof write>) {
    const staged = yield* write(...args);
    const waiting = (result: Store.StoredReceipt) =>
      "pendingSync" in result.receipt &&
      result.receipt.pendingSync &&
      result.receipt.revisionId === null;
    if (!deps.submitFloorWrite || !waiting(staged)) return staged;
    yield* args[1];
    yield* deps.submitFloorWrite;
    const settled = yield* write(...args);
    if (waiting(settled)) return yield* new Store.MemoryStoreConflict({ code: "hub_unavailable" });
    return settled;
  });
};
