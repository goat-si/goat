import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { legacyClosedLineageDigest, memoryOperationDigest } from "./MemoryDecider.ts";
import type { MemoryService } from "./MemoryService.ts";
import * as Store from "./MemoryStore.ts";

const strict = { onExcessProperty: "error" } as const;
const decodeHubReceipt = Schema.decodeUnknownEffect(M.MemoryHubReceipt);
const invalid = () => new Store.MemoryStoreConflict({ code: "invalid_output" });
const decode = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError(invalid));

export const makeHubAcknowledgement = (deps: {
  store: Store.MemoryStore["Service"];
  settleHubEntryTx: MemoryService["Service"]["settleHubEntryTx"];
  settleSuggestion: (
    space: M.MemorySpaceId,
    receipt: M.MemoryHubReceipt,
  ) => Effect.Effect<void, Store.MemoryStorageError>;
}) => {
  const { store, settleHubEntryTx, settleSuggestion } = deps;
  const reconcileResolutionSubmission: MemoryService["Service"]["reconcileResolutionSubmission"] =
    Effect.fn("MemoryService.reconcileResolutionSubmission")(function* (input) {
      return yield* store.transact(
        Effect.gen(function* () {
          yield* input.reauthorize;
          const result = yield* store.reconcileResolutionSubmissionTx(input);
          if (!result || result.outcome !== "admitted") return result;
          const operation = result.row.submission?.operation;
          const sequence = result.receipt.hubSequence;
          if (!operation || sequence === null) return yield* invalid();
          if (!M.requiresMemoryFloor2(operation))
            yield* settleHubEntryTx({
              memorySpaceId: input.ownership.memorySpaceId,
              hubEnvironmentId: input.hubEnvironmentId,
              localEnvironmentId: input.localEnvironmentId,
              entry: {
                kind: "operation",
                operation,
                receipt: result.receipt,
                hubSequence: sequence,
              },
            });
          yield* input.reauthorize;
          const row = yield* store.transitionResolutionTicketTx({
            ownership: { ...input.ownership, version: result.row.version },
            now: input.now,
            nextState: "terminal",
            ownedUntil: null,
            nextAttemptAt: input.now,
          });
          if (!row) return yield* new Store.MemoryStoreConflict({ code: "fenced" });
          return { ...result, row };
        }),
      );
    });
  const settleHubAcknowledgement: MemoryService["Service"]["settleHubAcknowledgement"] = Effect.fn(
    "MemoryService.settleHubAcknowledgement",
  )(function* (input) {
    const receipt = yield* decode(decodeHubReceipt(input.receipt, strict));
    return yield* store.transact(
      Effect.gen(function* () {
        yield* input.reauthorize;
        const work = yield* store.readWork(input.workId);
        if (
          !work ||
          work.space !== input.memorySpaceId ||
          !("operationId" in work.metadata) ||
          work.metadata.operationId !== input.operation.operationId ||
          receipt.operationId !== input.operation.operationId ||
          work.memoryId !== receipt.memoryId
        )
          return yield* new Store.MemoryStoreConflict({ code: "identity_mismatch" });
        const stored = yield* store.receipt(input.memorySpaceId, input.operation.operationId);
        const operation = yield* store.readWorkOperation(input.workId);
        if (
          (receipt.operationDigest !== input.operation.operationDigest &&
            (!operation || legacyClosedLineageDigest(operation) !== receipt.operationDigest)) ||
          (stored && stored.operationDigest !== receipt.operationDigest) ||
          (operation && memoryOperationDigest(operation) !== input.operation.operationDigest)
        )
          return yield* new Store.MemoryStoreConflict({ code: "operation_id_reused" });
        const stagedDigest =
          "authorityFirst" in work.metadata ? work.metadata.authorityFirst : undefined;
        if (stagedDigest && stagedDigest !== input.operation.operationDigest)
          return yield* new Store.MemoryStoreConflict({ code: "operation_id_reused" });
        if (!stored && !operation && !stagedDigest)
          return yield* new Store.MemoryStoreConflict({ code: "identity_mismatch" });
        const staged =
          stagedDigest !== undefined ||
          operation?.kind === "move" ||
          (operation !== undefined &&
            M.isMemoryRevisionOperation(operation) &&
            M.requiresMemoryLineageFloor2(operation));
        if (staged || receipt.hubSequence === null) {
          yield* store.acknowledgeOutbox(input.workId, receipt);
          yield* settleSuggestion(input.memorySpaceId, receipt);
          return {
            receipt,
            incorporated: false,
            intent:
              work.kind === "revert_intent"
                ? receipt.outcome === "rejected"
                  ? ("rejected" as const)
                  : ("completed" as const)
                : ("none" as const),
          };
        }
        if (
          !M.validateMemoryResolutionApproval(
            work.metadata.kind === "resolve" ? "resolve" : (operation?.kind ?? "upsert"),
            operation?.kind === "resolve"
              ? operation.resolution.resolutionId
              : work.metadata.kind === "resolve"
                ? work.metadata.resolution?.resolutionId
                : null,
            receipt,
          )
        )
          return yield* new Store.MemoryStoreConflict({ code: "unsupported_protocol" });
        if (operation)
          return yield* settleHubEntryTx({
            ...input,
            entry: { kind: "operation", operation, receipt, hubSequence: receipt.hubSequence },
          });
        if (!("protocolVersion" in work.metadata)) return yield* invalid();
        const meta = work.metadata;
        const resolutionId =
          meta.kind === "resolve"
            ? meta.resolution?.resolutionId
            : meta.kind === "revert"
              ? meta.revertsResolutionId
              : null;
        const compactReceipt: M.MemoryCompactReceipt = {
          memorySpaceId: input.memorySpaceId,
          originEnvironmentId: meta.originEnvironmentId,
          operationKind: meta.kind,
          ...(meta.kind === "upsert" && meta.revision?.provenance.upsertRequestDigest !== undefined
            ? { upsertRequestDigest: meta.revision.provenance.upsertRequestDigest }
            : {}),
          receipt,
          revisionId:
            receipt.outcome === "rejected" || meta.kind === "forget"
              ? null
              : (meta.revision?.revisionId ?? null),
          resolutionId: resolutionId ?? null,
          revertsResolutionId: meta.kind === "revert" ? (resolutionId ?? null) : null,
          attemptId: meta.kind === "resolve" ? meta.operationId : null,
          fencingToken: meta.kind === "resolve" ? (meta.fencingToken ?? null) : null,
          reportGuard:
            resolutionId && receipt.outcome !== "rejected"
              ? {
                  reportId: Store.resolutionReportId(
                    input.memorySpaceId,
                    meta.operationId,
                    resolutionId,
                  ),
                  resolvingEnvironmentId: meta.originEnvironmentId,
                  resolutionId,
                  outcome: meta.kind === "resolve" ? "resolved" : "reverted",
                }
              : null,
        };
        return yield* settleHubEntryTx({
          ...input,
          entry: {
            kind: "metadata",
            operationKind: work.metadata.kind,
            compactReceipt,
            ...(meta.revision ? { revision: meta.revision } : {}),
            memoryId: receipt.memoryId,
            receipt,
            hubSequence: receipt.hubSequence,
            ...(work.metadata.kind === "resolve" && work.metadata.resolution
              ? { resolutionId: work.metadata.resolution.resolutionId }
              : {}),
          },
        });
      }),
    );
  });
  return { reconcileResolutionSubmission, settleHubAcknowledgement };
};
