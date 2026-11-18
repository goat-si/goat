import * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { MemoryAccessError, MemoryServiceError } from "./MemoryService.ts";
import * as Store from "./MemoryStore.ts";

export type ForgetRequest =
  | M.MemoryForgetInput
  | Pick<M.MemoryForgetInput, "memorySpaceId" | "memoryId">;
type Permit = Effect.Effect<void, MemoryAccessError>;
const decodeForget = Schema.decodeUnknownEffect(M.MemoryForgetInput);
const encodeHeads = Schema.encodeSync(Schema.fromJsonString(Schema.Array(M.MemoryRevisionId)));
const strict = { onExcessProperty: "error" } as const;
const invalid = () => new Store.MemoryStoreConflict({ code: "invalid_output" });

export const makeMemoryForget = ({
  store,
  environmentId,
  requireSharing,
  requireScope,
  apply,
  stableUuid,
  hash,
}: {
  readonly store: Store.MemoryStore["Service"];
  readonly environmentId: M.EnvironmentId;
  readonly requireSharing: (space: M.MemorySpaceId) => Permit;
  readonly requireScope: (scope: M.MemoryScope) => Permit;
  readonly apply: (
    op: M.MemoryOperation,
    admission: Store.MemoryAdmissionContext,
    permit: Permit,
  ) => Effect.Effect<Store.StoredReceipt, MemoryServiceError>;
  readonly stableUuid: (input: string) => string;
  readonly hash: (input: string) => string;
}) => {
  return Effect.fn("MemoryService.forget")(function* (input: ForgetRequest, permit: Permit) {
    const explicit =
      "operationId" in input
        ? yield* decodeForget(input, strict).pipe(Effect.mapError(invalid))
        : undefined;
    let intent: M.MemoryForgetInput | undefined;
    return yield* store
      .transact(
        Effect.gen(function* () {
          yield* permit;
          yield* requireSharing(input.memorySpaceId);
          const current = yield* store.loadAggregate(
            input.memorySpaceId,
            input.memoryId,
            {
              when: Store.hasSourceEvidence,
            },
            {},
          );
          if (current.identity) yield* requireScope(current.identity.scope);
          if (!explicit && !current.identity && !current.tombstone)
            return yield* new Store.MemoryStoreConflict({ code: "not_found" });
          const value = explicit ?? {
            memorySpaceId: input.memorySpaceId,
            memoryId: input.memoryId,
            operationId: M.MemoryOperationId.make(
              stableUuid(
                `forget-by-id:${input.memorySpaceId}:${input.memoryId}:${hash(encodeHeads(current.heads))}`,
              ),
            ),
            expectedHeads: current.heads,
          };
          intent = value;
          const old = yield* store.readOperation(value.memorySpaceId, value.operationId);
          if (
            old &&
            (old.kind !== "forget" ||
              old.memoryId !== value.memoryId ||
              encodeHeads(old.expectedHeads) !== encodeHeads(value.expectedHeads))
          )
            return yield* new Store.MemoryStoreConflict({ code: "operation_id_reused" });
          if (current.tombstone && !old) {
            const original = explicit
              ? undefined
              : yield* store.receipt(value.memorySpaceId, current.tombstone.deleteOperationId);
            return {
              operationDigest: original?.operationDigest ?? "0".repeat(64),
              receipt: {
                operationId: current.tombstone.deleteOperationId,
                memoryId: value.memoryId,
                outcome: "noop" as const,
                revisionId: null,
                pendingSync:
                  original !== undefined &&
                  "pendingSync" in original.receipt &&
                  original.receipt.pendingSync,
                ...(original?.receipt.forgetExpansion
                  ? { forgetExpansion: original.receipt.forgetExpansion }
                  : {}),
              },
            };
          }
          // Lifetime evidence survives compaction and is captured before base deletion purges payloads.
          const lineage = yield* store.readImportLineage(value.memorySpaceId, value.memoryId);
          const suppressedSourceKeys = lineage.flatMap((r) =>
            r.kind === "sourceKey" ? [r.sourceKey] : [],
          );
          const suppressedContent = lineage.flatMap((r) =>
            r.kind === "content" ? [r.content] : [],
          );
          // A consolidation that rereads the same run shares its source and watermark with the
          // summary before it; one exclusion per source keeps the tombstone's entries distinct.
          const exclusionsBySource = new Map<string, M.MemorySourceExclusion>();
          for (const { revision, payload } of current.revisions) {
            const p = revision.provenance;
            if (p.sourceThread && p.sourceWatermark) {
              const w = p.sourceWatermark;
              const key = [
                p.sourceThread.environmentId,
                p.sourceThread.threadId,
                w.fromEventId,
                w.toEventId,
                w.throughSequence,
              ].join("\u0000");
              const messageIds = [
                ...new Set([
                  ...(exclusionsBySource.get(key)?.messageIds ?? []),
                  ...(payload?.evidence ?? []).flatMap((e) => e.messageIds),
                ]),
              ];
              if (messageIds.length)
                exclusionsBySource.set(key, {
                  sourceThread: p.sourceThread,
                  sourceWatermark: p.sourceWatermark,
                  messageIds,
                });
            }
          }
          // Merged ids still respect the per-exclusion bound of 100 messages.
          const sourceExclusions = [...exclusionsBySource.values()].flatMap((exclusion) =>
            Array.from({ length: Math.ceil(exclusion.messageIds.length / 100) }, (_, page) => ({
              ...exclusion,
              messageIds: exclusion.messageIds.slice(page * 100, page * 100 + 100),
            })),
          );
          const op: Extract<M.MemoryOperation, { kind: "forget" }> = old ?? {
            protocolVersion: 1,
            kind: "forget",
            memorySpaceId: value.memorySpaceId,
            memoryId: value.memoryId,
            operationId: value.operationId,
            originEnvironmentId: environmentId,
            expectedHeads: value.expectedHeads,
            tombstone: {
              memorySpaceId: value.memorySpaceId,
              memoryId: value.memoryId,
              deleteOperationId: value.operationId,
              deletingEnvironmentId: environmentId,
              deletedAtUtc: M.MemoryUtcTimestamp.make(
                DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
              ),
              suppressedSourceKeys,
              suppressedContent,
              sourceExclusions,
            },
          };
          if (old) return yield* apply(old, Store.localIntent, permit);
          // Every operation stays within the v1 tombstone bound. IDs and digests are immutable;
          // the base receipt and each expansion retain their own local/remote outcome.
          const records = [
            ...suppressedSourceKeys.map((sourceKey) => ({ kind: "sourceKey" as const, sourceKey })),
            ...suppressedContent.map((content) => ({ kind: "content" as const, content })),
            ...sourceExclusions.map((exclusion) => ({ kind: "exclusion" as const, exclusion })),
          ];
          const operations: Extract<M.MemoryOperation, { kind: "forget" }>[] = [];
          for (let offset = 0; offset < Math.max(1, records.length); offset += 100) {
            const fragment = records.slice(offset, offset + 100);
            const operationId =
              offset === 0
                ? value.operationId
                : M.MemoryOperationId.make(
                    stableUuid(`${value.operationId}:lineage-fragment:${offset / 100}`),
                  );
            operations.push({
              ...op,
              operationId,
              expectedHeads: offset === 0 ? value.expectedHeads : [],
              tombstone: {
                ...op.tombstone,
                deleteOperationId: operationId,
                suppressedSourceKeys: fragment.flatMap((r) =>
                  r.kind === "sourceKey" ? [r.sourceKey] : [],
                ),
                suppressedContent: fragment.flatMap((r) =>
                  r.kind === "content" ? [r.content] : [],
                ),
                sourceExclusions: fragment.flatMap((r) =>
                  r.kind === "exclusion" ? [r.exclusion] : [],
                ),
              },
            });
          }
          let base: Store.StoredReceipt | undefined;
          let previous: Store.StoredReceipt | undefined;
          for (const operation of operations) {
            const result = yield* apply(operation, Store.localIntent, permit);
            if (previous) {
              const linked = yield* store.settleForgetExpansion(value.memorySpaceId, {
                ...previous,
                receipt: {
                  ...previous.receipt,
                  forgetExpansion: {
                    requestDigest: previous.operationDigest,
                    operationId: operation.operationId,
                    operationDigest: result.operationDigest,
                    status:
                      result.receipt.outcome === "rejected"
                        ? "rejected"
                        : "pendingSync" in result.receipt && result.receipt.pendingSync
                          ? "pending"
                          : "accepted",
                  },
                },
              });
              if (previous.receipt.operationId === base?.receipt.operationId) base = linked;
            } else base = result;
            previous = result;
          }
          if (!base) return yield* invalid();
          return base;
        }),
      )
      .pipe(
        Effect.catchTags({
          MemoryCapacityError: (error) => {
            const value = intent;
            if (!value) return Effect.fail(error);
            return store
              .transact(
                Effect.gen(function* () {
                  yield* permit;
                  yield* store.preserveForgetIntent({
                    memorySpaceId: value.memorySpaceId,
                    memoryId: value.memoryId,
                    operationId: value.operationId,
                    requestedAtUtc: M.MemoryUtcTimestamp.make(
                      DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
                    ),
                    attempts: 0,
                    lastFailureCode: "capacity_exceeded",
                    operationDigest: null,
                    submissionState: "unsubmitted",
                  });
                }),
              )
              .pipe(Effect.andThen(Effect.fail(error)));
          },
        }),
      );
  });
};
