import * as NodeUtil from "node:util";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- stable server-owned hashes.
import * as NodeCrypto from "node:crypto";
import * as M from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RepositoryResolver from "../project/RepositoryIdentityResolver.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Store from "./MemoryStore.ts";
import * as Settings from "../serverSettings.ts";
import {
  ProviderMemoryImportRuntime,
  provenanceImportFormat,
} from "./imports/MemoryImportTypes.ts";
import type {
  ImportProviderFacade,
  ImportPorts,
  ImportAddress,
  PreparedImportCommit,
} from "./imports/MemoryImportTypes.ts";
import * as Quota from "./MemoryQuotaService.ts";
import { decideMemoryOperation, memoryOperationDigest } from "./MemoryDecider.ts";
import { scanMemoryValue } from "./MemorySecretScanner.ts";

export class MemoryAccessError extends Schema.TaggedError<MemoryAccessError>()(
  "MemoryAccessError",
  {
    code: M.MemoryFailureCode,
  },
) {
  override get message() {
    return "Memory access denied.";
  }
}
export type MemoryServiceError =
  | MemoryAccessError
  | Store.MemoryStorageError
  | Store.MemoryStoreConflict
  | Store.MemoryCapacityError;
type Permit = Effect.Effect<void, MemoryAccessError>;
type SummaryCommit = {
  readonly work: Store.MemoryWork;
  readonly generated: M.GenerateMemorySummaryExecutionResult;
  readonly input: M.GenerateMemorySummaryInput;
  readonly expectedHeads: ReadonlyArray<M.MemoryRevisionId>;
  /** Re-read committed source/exclusions inside the commit transaction. */
  readonly recheckSource: Effect.Effect<void, MemoryServiceError>;
};
export type IntentBinding = {
  memorySpaceId: M.MemorySpaceId | null;
  coordinatorEpoch: number;
  enabled: boolean;
};
export type IntentCommitInput = {
  assignment: Omit<Store.IntentIdentityInput, "environmentId">;
  expectedEpoch: number;
  /** Fresh shared settings/stop authority; called inside the writer Tx, never cached or networked. */
  readBinding: Effect.Effect<IntentBinding, MemoryAccessError>;
};
export type ValidatedSourceRequest = {
  request: M.MemoryHubSourceReadRequestInput;
  generation: number;
};
export type MemorySourceReadAuthority = {
  readSource: (
    input: ValidatedSourceRequest,
    permit: Permit,
  ) => Effect.Effect<M.MemorySourceReadOutcome, MemoryServiceError | M.MemoryHubError>;
};
export type MemoryOwnerCommittedReader = {
  readCommitted: (
    input: M.MemorySourceReadRequest,
    reauthorize: Permit,
  ) => Effect.Effect<M.MemorySourceReadOutcome, MemoryServiceError>;
};
export class MemoryService extends Context.Service<
  MemoryService,
  {
    readonly importProvider: ImportProviderFacade;
    /** L5 adds readiness/requireBootstrap/syncStatus from its existing Sync instance. */
    readonly importPorts: Omit<ImportPorts, "readiness" | "requireBootstrap" | "syncStatus">;
    readonly commitLocalIntent: (
      input: IntentCommitInput,
    ) => Effect.Effect<
      Store.MaterializedIntent & { receipt: Store.StoredReceipt },
      MemoryServiceError
    >;
    readonly readSource: (
      input: M.MemoryReadSourceInput,
      permit: Permit,
      sourceThread?: M.ScopedThreadRef,
    ) => Effect.Effect<M.MemorySourcePage, MemoryServiceError>;
    readonly prepareSourceRead: (
      input: M.MemoryReadSourceInput,
      permit: Permit,
    ) => Effect.Effect<ValidatedSourceRequest, MemoryServiceError>;
    readonly validateSourceOutcome: (
      input: { request: ValidatedSourceRequest; outcome: M.MemorySourceReadOutcome },
      permit: Permit,
    ) => Effect.Effect<M.MemorySourceReadOutcome, MemoryServiceError>;
    readonly admitHubOperation: (input: {
      authority: Store.HubAuthority;
      operation: M.MemoryOperation;
      resolutionRequest?: M.MemoryHubApplyResolutionInput;
    }) => Effect.Effect<
      M.MemoryHubReceipt,
      | MemoryServiceError
      | M.MemoryHubError
      | M.MemoryHubUnauthorizedError
      | M.MemoryHubForbiddenError
    >;
    readonly admitHubOperationTx: (input: {
      authority: Store.HubAuthority;
      operation: M.MemoryOperation;
      resolutionRequest?: M.MemoryHubApplyResolutionInput;
    }) => Store.InTx<
      M.MemoryHubReceipt,
      | MemoryServiceError
      | M.MemoryHubError
      | M.MemoryHubUnauthorizedError
      | M.MemoryHubForbiddenError
    >;
    readonly settleHubEntryTx: (input: {
      memorySpaceId: M.MemorySpaceId;
      hubEnvironmentId: M.EnvironmentId;
      localEnvironmentId: M.EnvironmentId;
      entry: M.MemoryHubEntry;
      workId?: string;
    }) => Store.InTx<Store.Settlement, MemoryServiceError>;
    readonly receiveHubPage: (input: {
      memorySpaceId: M.MemorySpaceId;
      hubEnvironmentId: M.EnvironmentId;
      localEnvironmentId: M.EnvironmentId;
      expectedSequence: number;
      page: M.MemoryHubPullResult;
      reauthorize: Permit;
    }) => Effect.Effect<readonly Store.Settlement[], MemoryServiceError>;
    readonly reconcileResolutionSubmission: (input: {
      ownership: Store.TicketOwner;
      now: number;
      hubEnvironmentId: M.EnvironmentId;
      localEnvironmentId: M.EnvironmentId;
      rejection?: M.MemoryHubReceipt;
      reauthorize: Permit;
    }) => Effect.Effect<Store.SubmissionReconciliation | null, MemoryServiceError>;
    readonly settleHubAcknowledgement: (input: {
      memorySpaceId: M.MemorySpaceId;
      hubEnvironmentId: M.EnvironmentId;
      localEnvironmentId: M.EnvironmentId;
      workId: string;
      receipt: M.MemoryHubReceipt;
      operation: { operationId: M.MemoryOperationId; operationDigest: string };
      reauthorize: Permit;
    }) => Effect.Effect<Store.Settlement, MemoryServiceError>;
    readonly getProjectBinding: (
      input: M.MemoryProjectBindingGetInput,
      permit: Permit,
    ) => Effect.Effect<M.MemoryProjectBinding, MemoryServiceError>;
    readonly updateProjectBinding: (
      input: M.MemoryProjectBindingUpdateInput,
      permit: Permit,
    ) => Effect.Effect<M.MemoryProjectBindingUpdateResult, MemoryServiceError>;
    readonly resolveProjectKey: (
      space: M.MemorySpaceId,
      project: M.ScopedProjectRef,
    ) => Effect.Effect<M.MemoryProjectKey | null, MemoryServiceError>;
    readonly changes: (
      input: M.MemoryChangesInput,
      permit: Permit,
    ) => Effect.Effect<
      Stream.Stream<M.MemoryChangeSignal, MemoryServiceError>,
      MemoryServiceError,
      Scope.Scope
    >;
    readonly upsert: (
      input: M.MemoryUpsertInput,
      permit: Permit,
      sourceThread?: M.ScopedThreadRef,
    ) => Effect.Effect<Store.StoredReceipt, MemoryServiceError>;
    readonly retryForgetExpansion: (
      intent: Store.PendingForgetIntent,
    ) => Effect.Effect<void, MemoryServiceError>;
    readonly forget: (
      input: M.MemoryForgetInput,
      permit: Permit,
    ) => Effect.Effect<Store.StoredReceipt, MemoryServiceError>;
    readonly revertResolution: (
      input: M.MemoryRevertResolutionInput,
      permit: Permit,
      sourceThread?: M.ScopedThreadRef,
    ) => Effect.Effect<M.MemoryRevertResult, MemoryServiceError>;
    readonly list: (
      input: M.MemoryListInput,
      permit: Permit,
      sourceThread?: M.ScopedThreadRef,
    ) => Effect.Effect<M.MemoryPage, MemoryServiceError>;
    readonly search: (
      input: M.MemorySearchInput,
      permit: Permit,
      sourceThread?: M.ScopedThreadRef,
    ) => Effect.Effect<M.MemoryPage, MemoryServiceError>;
    readonly read: (
      input: M.MemoryReadInput,
      permit: Permit,
      sourceThread?: M.ScopedThreadRef,
    ) => Effect.Effect<M.MemoryItem, MemoryServiceError>;
    readonly history: (
      input: M.MemoryHistoryInput,
      permit: Permit,
      sourceThread?: M.ScopedThreadRef,
    ) => Effect.Effect<M.MemoryHistoryPage, MemoryServiceError>;
    readonly applyReceived: (
      operation: M.MemoryOperation,
      receipt: M.MemoryHubReceipt,
    ) => Effect.Effect<Store.StoredReceipt, MemoryServiceError>;
    readonly commitAcceptedResolution: (
      operation: Extract<M.MemoryOperation, { kind: "resolve" | "revert" }>,
      receipt: M.MemoryHubReceipt,
    ) => Effect.Effect<Store.StoredReceipt, MemoryServiceError>;
    readonly commitSummary: (
      input: SummaryCommit,
    ) => Effect.Effect<Store.StoredReceipt, MemoryServiceError>;
    readonly queueSummary: (work: Store.MemoryWork) => Effect.Effect<void, MemoryServiceError>;
    readonly queueResolution: Store.MemoryStore["Service"]["persistResolutionTicket"];
    readonly recoverWork: Store.MemoryStore["Service"]["dueWork"];
    readonly reconnectParked: (
      operation: M.MemoryOperation,
    ) => Effect.Effect<boolean, MemoryServiceError>;
    readonly resetReportAttempts: (
      input: M.MemoryResetReportAttemptsInput,
      permit: Permit,
    ) => Effect.Effect<M.MemoryResetReportAttemptsResult, MemoryServiceError>;
    readonly readReportTarget: Store.MemoryStore["Service"]["readReportTarget"];
    readonly nextReportWakeAt: (
      now: number,
    ) => Effect.Effect<number | null, Store.MemoryStorageError>;
    readonly acquireReports: Store.MemoryStore["Service"]["acquireReports"];
    readonly acknowledgeClaimedReport: Store.MemoryStore["Service"]["acknowledgeClaimedReport"];
    readonly deferClaimedReport: Store.MemoryStore["Service"]["deferClaimedReport"];
    readonly normalizeExpiredReports: Store.MemoryStore["Service"]["normalizeExpiredReports"];
    readonly purgeDeliveredReportDetails: (input: {
      memorySpaceId?: M.MemorySpaceId;
      now: number;
      limit: number;
    }) => Effect.Effect<
      { removedRows: number; reclaimedLogicalBytes: number },
      Store.MemoryStorageError | Store.MemoryStoreConflict
    >;
    readonly nextReportMaintenanceAt: Effect.Effect<number | null, Store.MemoryStorageError>;
    readonly pendingReports: Store.MemoryStore["Service"]["pendingReports"];
    readonly claimReport: Store.MemoryStore["Service"]["claimReport"];
    readonly acknowledgeReport: Store.MemoryStore["Service"]["acknowledgeReport"];
    readonly failReport: Store.MemoryStore["Service"]["failReport"];
    readonly readContextCandidates: (
      input: M.MemoryListInput,
      permit: Permit,
    ) => Effect.Effect<M.MemoryContextCandidates, MemoryServiceError>;
    readonly readContextRevisions: (
      space: M.MemorySpaceId,
      ids: ReadonlyArray<M.MemoryId>,
      permit: Permit,
    ) => Effect.Effect<M.MemoryContextCandidates, MemoryServiceError>;
  }
>()("goat/memory/MemoryService") {}
const encodeSelection = Schema.encodeSync(Schema.fromJsonString(M.MemoryModelSelection));
const encodeHeads = Schema.encodeSync(Schema.fromJsonString(Schema.Array(M.MemoryRevisionId)));
const encodeProjectKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.NullOr(M.MemoryProjectKey)),
);
const strict = { onExcessProperty: "error" } as const;
const encodePageItem = Schema.encodeEffect(Schema.fromJsonString(M.MemoryItem));
const decodeBindingGet = Schema.decodeUnknownEffect(M.MemoryProjectBindingGetInput);
const decodeBindingUpdate = Schema.decodeUnknownEffect(M.MemoryProjectBindingUpdateInput);
const encodeBindingUpdate = Schema.encodeSync(
  Schema.fromJsonString(M.MemoryProjectBindingUpdateInput),
);
const decodeChanges = Schema.decodeUnknownEffect(M.MemoryChangesInput);
const decodeUpsert = Schema.decodeUnknownEffect(M.MemoryUpsertInput);
const decodeForget = Schema.decodeUnknownEffect(M.MemoryForgetInput);
const decodeRevert = Schema.decodeUnknownEffect(M.MemoryRevertResolutionInput);
const decodeRead = Schema.decodeUnknownEffect(M.MemoryReadInput);
const decodeList = Schema.decodeUnknownEffect(M.MemoryListInput);
const decodeSearch = Schema.decodeUnknownEffect(M.MemorySearchInput);
const decodeHistory = Schema.decodeUnknownEffect(M.MemoryHistoryInput);
const decodeSummary = Schema.decodeUnknownEffect(M.GenerateMemorySummaryExecutionResult);
const encodeRevert = Schema.encodeSync(Schema.fromJsonString(M.MemoryRevertResolutionInput));
const decodePage = Schema.decodeUnknownEffect(M.MemoryPage);
const encodeHubReceipt = Schema.encodeEffect(Schema.fromJsonString(M.MemoryHubReceipt));
const encodeReadSource = Schema.encodeEffect(Schema.fromJsonString(M.MemoryReadSourceInput));
const decodeReadSource = Schema.decodeUnknownEffect(M.MemoryReadSourceInput);
const decodeSourceRequest = Schema.decodeUnknownEffect(M.MemoryHubSourceReadRequestInput);
const decodeSourceOutcome = Schema.decodeUnknownEffect(M.MemorySourceReadOutcome);
const encodeSourceThread = Schema.encodeEffect(Schema.fromJsonString(M.ScopedThreadRef));
const encodeSourceWatermark = Schema.encodeEffect(Schema.fromJsonString(M.MemorySourceWatermark));
const decodeOperation = Schema.decodeUnknownEffect(M.MemoryOperation);
const decodeResolutionRequest = Schema.decodeUnknownEffect(M.MemoryHubApplyResolutionInput);
const decodeHubEntry = Schema.decodeUnknownEffect(M.MemoryHubEntry);
const decodeHubPage = Schema.decodeUnknownEffect(M.MemoryHubPullResult);
const decodeHubReceipt = Schema.decodeUnknownEffect(M.MemoryHubReceipt);
const decodeHistoryPage = Schema.decodeUnknownEffect(M.MemoryHistoryPage);
const isConflict = Schema.is(Store.MemoryStoreConflict);
const isFailureCode = Schema.is(M.MemoryFailureCode);
const invalid = () => new Store.MemoryStoreConflict({ code: "invalid_output" });
const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
export const memoryStableUuid = (text: string) => {
  const h = hash(text);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const decodeSummaryPayload = Schema.decodeEffect(M.MemoryPayload);
const decodeDependencyEdges = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(M.MemoryRevisionId)),
);
const decode = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError(invalid));
/** Expand direct edges at authoritative writes. Internally captured closed sets may
 * outlive their bodies; they still require canonical live owners and all available edges. */
const normalizeMemoryDependencies = Effect.fn("MemoryService.normalizeMemoryDependencies")(
  function* (
    space: M.MemorySpaceId,
    payload: M.MemoryPayload,
    allowPruned = false,
    resolutionHeads: ReadonlyArray<M.MemoryRevisionId> = [],
    resolvingMemoryId?: M.MemoryId,
  ) {
    const sql = yield* SqlClient.SqlClient;
    const revisions = [...new Set(payload.derivedFromMemoryRevisions)];
    for (let index = 0; index < revisions.length; index++) {
      if (revisions.length > 100)
        return yield* new Store.MemoryStoreConflict({ code: "invalid_output" });
      const revision = revisions[index]!;
      // Only authoritative resolution inputs may use this memory's own history
      // while its current frontier is quarantined. Foreign owners still need visibility.
      const rows = yield* sql<{ dependencies_json: string | null }>`
        SELECT p.dependencies_json FROM memory_revisions r
        JOIN memory_items i ON i.space=r.space AND i.memory_id=r.memory_id
        LEFT JOIN memory_payloads p ON p.space=r.space AND p.payload_ref=r.payload_ref AND p.memory_id=r.memory_id
        WHERE r.space=${space} AND r.revision_id=${revision}
        AND NOT EXISTS (SELECT 1 FROM memory_inbox_pending q WHERE q.space=r.space AND q.operation_id=r.operation_id AND q.record_kind='operation')
        AND (i.status='active' AND json_extract(i.availability_json,'$.exposure')='visible'
          OR r.memory_id=${resolvingMemoryId ?? null} AND r.revision_id IN (SELECT value FROM json_each(${encodeHeads(resolutionHeads)})))
        AND i.status NOT IN ('forgotten','blocked')
        AND NOT EXISTS (SELECT 1 FROM memory_pending_forget_intents f WHERE f.space=r.space AND f.memory_id=r.memory_id)
      `.pipe(
        Effect.mapError(
          (cause) => new Store.MemoryStorageError({ stage: "memory-dependencies", cause }),
        ),
      );
      if (!rows[0] || (rows[0].dependencies_json === null && !allowPruned))
        return yield* new Store.MemoryStoreConflict({ code: "source_invalidated" });
      if (rows[0].dependencies_json !== null) {
        const edges = yield* decode(decodeDependencyEdges(rows[0].dependencies_json, strict));
        for (const edge of edges) if (!revisions.includes(edge)) revisions.push(edge);
      }
    }
    return { ...payload, derivedFromMemoryRevisions: revisions };
  },
);
/** Consumers of a previously admitted closed set verify every still-available edge. */
export const validateSummaryDependencies = Effect.fn("MemoryService.validateSummaryDependencies")(
  function* (
    space: M.MemorySpaceId,
    payload: M.MemoryPayload,
    resolution?: {
      readonly memoryId: M.MemoryId;
      readonly revisions: ReadonlyArray<M.MemoryRevisionId>;
    },
  ) {
    const normalized = yield* normalizeMemoryDependencies(
      space,
      payload,
      true,
      resolution?.revisions ?? [],
      resolution?.memoryId,
    );
    if (
      normalized.derivedFromMemoryRevisions.length !==
      new Set(payload.derivedFromMemoryRevisions).size
    )
      return yield* new Store.MemoryStoreConflict({ code: "source_invalidated" });
  },
);
const make = Effect.fnUntraced(function* (
  sourceReadAuthority?: MemorySourceReadAuthority["readSource"],
) {
  const repositoryResolver = yield* RepositoryResolver.RepositoryIdentityResolver;
  const store = yield* Store.MemoryStore;
  const committedSettings = yield* Settings.MemoryHubCommittedSettings;
  const quota = yield* Quota.MemoryQuotaService;
  const identity = yield* Environment.ServerEnvironmentIdentity;
  const environmentId = yield* identity.getEnvironmentId;
  const sql = yield* SqlClient.SqlClient;
  const query = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError((cause) => new Store.MemoryStorageError({ stage: "service-read", cause })),
    );
  const requireSharing = Effect.fnUntraced(function* (space: M.MemorySpaceId) {
    const binding = yield* committedSettings.read;
    if (binding.settings.mode === "disabled" || binding.settings.memorySpaceId !== space)
      return yield* new MemoryAccessError({ code: "bootstrap_required" });
  });
  const resetReportAttempts: MemoryService["Service"]["resetReportAttempts"] = Effect.fn(
    "MemoryService.resetReportAttempts",
  )(function* (input, permit) {
    const value = yield* decode(
      Schema.decodeUnknownEffect(M.MemoryResetReportAttemptsInput)(input, strict),
    );
    return yield* store.transact(
      Effect.gen(function* () {
        yield* permit;
        if (value.environmentId !== environmentId)
          return yield* new MemoryAccessError({ code: "identity_mismatch" });
        yield* requireSharing(value.memorySpaceId);
        const result = yield* store.resetReportAttemptsTx(value, yield* Clock.currentTimeMillis);
        yield* permit;
        return result;
      }),
    );
  });
  const projectRoot = Effect.fn("MemoryService.projectRoot")(function* (
    project: M.ScopedProjectRef,
  ) {
    if (project.environmentId !== environmentId)
      return yield* new MemoryAccessError({ code: "identity_mismatch" });
    const rows = yield* query(
      sql<{
        workspace_root: string;
      }>`SELECT workspace_root FROM projection_projects WHERE project_id=${project.projectId} AND deleted_at IS NULL`,
    );
    if (!rows[0]) return yield* new Store.MemoryStoreConflict({ code: "not_found" });
    return rows[0].workspace_root;
  });
  // Preparation observes repository-derived bindings without publishing them.
  const readProjectBinding = Effect.fn("MemoryService.readProjectBinding")(function* (
    input: M.MemoryProjectBindingGetInput,
    permit: Permit,
  ) {
    const value = yield* decode(decodeBindingGet(input, strict));
    yield* permit;
    const root = yield* projectRoot(value.project);
    const old = yield* store.getProjectBinding(value.memorySpaceId, value.project);
    if (old?.repositoryKey) return old;
    const observed = yield* repositoryResolver.resolve(root);
    yield* permit;
    if (!observed) return old ?? { ...value, projectKey: null, repositoryKey: null, version: 0 };
    const repositoryKey = {
      kind: "repository" as const,
      groupingKey: M.repositoryGroupingKeyOf(observed),
    };
    return {
      ...value,
      repositoryKey,
      projectKey: old?.projectKey?.kind === "explicit" ? old.projectKey : repositoryKey,
      version: old?.version ?? 0,
    };
  });
  const getProjectBinding = Effect.fn("MemoryService.getProjectBinding")(function* (
    input: M.MemoryProjectBindingGetInput,
    permit: Permit,
  ) {
    return yield* store.transact(
      Effect.gen(function* () {
        const binding = yield* readProjectBinding(input, permit);
        const old = yield* store.getProjectBinding(binding.memorySpaceId, binding.project);
        if (
          !NodeUtil.isDeepStrictEqual(
            old ?? { ...input, projectKey: null, repositoryKey: null, version: 0 },
            binding,
          )
        )
          yield* store.putProjectBinding(
            binding,
            old?.version ?? null,
            yield* Clock.currentTimeMillis,
          );
        return binding;
      }),
    );
  });
  const updateProjectBinding = Effect.fn("MemoryService.updateProjectBinding")(function* (
    input: M.MemoryProjectBindingUpdateInput,
    permit: Permit,
  ) {
    const value = yield* decode(decodeBindingUpdate(input, strict));
    yield* getProjectBinding(
      { memorySpaceId: value.memorySpaceId, project: value.project },
      permit,
    );
    return yield* store.transact(
      Effect.gen(function* () {
        yield* permit;
        yield* projectRoot(value.project);
        const id = `binding:${value.memorySpaceId}:${value.requestId}`;
        const digest = hash(encodeBindingUpdate(value));
        const replay = yield* store.readWork(id);
        if (replay) {
          if (replay.metadata.kind !== "binding" || replay.metadata.requestDigest !== digest)
            return yield* new Store.MemoryStoreConflict({ code: "operation_id_reused" });
          return replay.metadata.result;
        }
        const old = (yield* store.getProjectBinding(value.memorySpaceId, value.project)) ?? {
          memorySpaceId: value.memorySpaceId,
          project: value.project,
          repositoryKey: null,
          projectKey: null,
          version: 0,
        };
        if (old.version !== value.expectedVersion)
          return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
        const projectKey =
          value.action === "setExplicit"
            ? { kind: "explicit" as const, sharedProjectId: value.sharedProjectId }
            : old.repositoryKey;
        const changed = encodeProjectKey(projectKey) !== encodeProjectKey(old.projectKey);
        const binding = { ...old, projectKey, version: old.version + Number(changed) };
        if (changed)
          yield* store.putProjectBinding(
            binding,
            (yield* store.getProjectBinding(value.memorySpaceId, value.project))?.version ?? null,
            yield* Clock.currentTimeMillis,
          );
        const result = { binding, requestId: value.requestId };
        yield* store.enqueueWork({
          id,
          space: value.memorySpaceId,
          memoryId: null,
          kind: "admin",
          status: "completed",
          metadata: { kind: "binding", requestDigest: digest, result },
          payloadRef: null,
          attempt: 0,
          nextAttemptAt: 0,
          claimedBy: null,
          claimedUntil: null,
        });
        return result;
      }),
    );
  });
  const resolveProjectKey = (space: M.MemorySpaceId, project: M.ScopedProjectRef) =>
    getProjectBinding({ memorySpaceId: space, project }, Effect.void).pipe(
      Effect.map((binding) => binding.projectKey),
    );
  const changes = Effect.fn("MemoryService.changes")(function* (
    input: M.MemoryChangesInput,
    permit: Permit,
  ) {
    const value = yield* decode(decodeChanges(input, strict));
    yield* permit;
    const stream = yield* store.changes(value.memorySpaceId);
    return stream.pipe(Stream.tap(() => permit));
  });
  const requireScope = (scope: M.MemoryScope) =>
    scope.kind === "thread" && scope.thread.environmentId !== environmentId
      ? Effect.fail(new MemoryAccessError({ code: "identity_mismatch" }))
      : Effect.void;
  const decide = (
    current: Store.MemoryAggregate,
    op: M.MemoryOperation,
    admission: Store.MemoryAdmissionContext,
    receipt?: M.MemoryHubReceipt,
    ancestry?: Store.MemoryAncestry,
  ) =>
    Effect.try({
      try: () =>
        decideMemoryOperation(
          current,
          op,
          admission,
          admission.kind === "approvedReplica" ? undefined : scanMemoryValue(op),
          receipt,
          ancestry,
        ),
      catch: (cause) => (isConflict(cause) ? cause : invalid()),
    });
  const requireImportNotSuppressed = Effect.fnUntraced(function* (op: M.MemoryOperation) {
    if (op.kind === "forget" || !op.revision.provenance.importSource) return;
    const source = op.revision.provenance.importSource;
    const keys = [
      {
        environmentId: op.revision.provenance.environmentId,
        sourceId: source.sourceId,
        sourceItemKey: source.sourceItemKey,
      },
      ...source.sourceAliases,
    ];
    const fingerprints = [source.contentFingerprint, ...source.acceptedContentFingerprints];
    for (let index = 0; index < Math.max(keys.length, fingerprints.length); index++) {
      const match = yield* store.findImportMatchTx({
        memorySpaceId: op.memorySpaceId,
        environmentId,
        source: keys[index % keys.length]!,
        content: {
          scope: op.revision.scope,
          assertionKind: op.revision.assertionKind,
          contentFingerprint: fingerprints[index % fingerprints.length]!,
        },
      });
      if (match.kind === "pending_forget")
        return yield* new Store.MemoryStoreConflict({ code: "forget_pending" });
      if (match.kind === "source_suppressed" || match.kind === "content_suppressed")
        return yield* new Store.MemoryStoreConflict({ code: "forgotten" });
    }
  });
  const apply = Effect.fn("MemoryService.apply")(function* (
    op: M.MemoryOperation,
    admission: Store.MemoryAdmissionContext,
    permit: Permit,
    approval?: M.MemoryHubReceipt,
  ) {
    const digest = yield* Effect.try({ try: () => memoryOperationDigest(op), catch: invalid });
    return yield* store.transact(
      Effect.gen(function* () {
        yield* permit;
        const old = yield* store.receipt(op.memorySpaceId, op.operationId);
        if (old) {
          if (
            old.operationDigest !== digest &&
            (admission.kind !== "localIntent" ||
              old.receipt.forgetExpansion?.requestDigest !== digest)
          )
            return yield* new Store.MemoryStoreConflict({ code: "operation_id_reused" });
          if (
            !(
              admission.kind === "approvedReplica" &&
              approval &&
              (!("hubSequence" in old.receipt) || old.receipt.hubSequence === null)
            )
          )
            return old;
        }
        // The decider needs the DAG, head/restored payloads, and only the reverted resolution.
        const current = yield* store.loadAggregate(
          op.memorySpaceId,
          op.memoryId,
          op.kind === "forget"
            ? {}
            : { heads: true, revisionIds: op.kind === "revert" ? [op.restoredRevisionId] : [] },
          op.kind === "forget"
            ? {}
            : {
                ...(op.kind === "revert" ? { resolutionId: op.revertsResolutionId } : {}),
                revision: op.revision,
                ...(op.kind === "resolve"
                  ? { metadataRevisionIds: op.resolution.inputRevisionIds }
                  : {}),
              },
        );
        if (admission.kind !== "approvedReplica" && current.pendingForget && op.kind !== "forget")
          return yield* new Store.MemoryStoreConflict({ code: "forget_pending" });
        let ancestry: Store.MemoryAncestry | undefined;
        if (op.kind !== "forget") {
          if (admission.kind !== "approvedReplica") yield* requireScope(op.revision.scope);
          ancestry = yield* store.readAncestry(op.memorySpaceId, op.memoryId, op.revision.parents);
          if (ancestry.parents.some((p) => p.status === "crossMemory"))
            return yield* new Store.MemoryStoreConflict({ code: "identity_mismatch" });
          if (
            admission.kind !== "approvedReplica" &&
            ancestry.parents.some((p) => p.status === "compacted")
          )
            return yield* new Store.MemoryStoreConflict({ code: "base_compacted" });
        }
        if (admission.kind !== "approvedReplica") yield* requireImportNotSuppressed(op);
        const decision = yield* decide(current, op, admission, approval, ancestry);
        return yield* quota.commit(decision, environmentId, permit);
      }).pipe(
        Effect.tap(() =>
          admission.kind === "approvedReplica" && approval
            ? store.reconcileOperationReportTx({
                operation: op,
                receipt: approval,
                localEnvironmentId: environmentId,
              })
            : Effect.void,
        ),
      ),
    );
  });
  const requireImportAddress = (address: ImportAddress) =>
    address.environmentId === environmentId
      ? Effect.void
      : Effect.fail(new Store.MemoryStoreConflict({ code: "not_found" }));
  const importTransaction = <A, E, R>(
    address: ImportAddress,
    permit: Permit,
    effect: Effect.Effect<A, E, R>,
  ) =>
    store.transact(
      Effect.gen(function* () {
        yield* permit;
        yield* requireImportAddress(address);
        yield* store.requireImportLineageCompleteTx(address.memorySpaceId);
        return yield* effect;
      }),
      { requireOuter: true },
    );
  const commitImport = Effect.fn("MemoryService.commitImport")(function* (
    input: PreparedImportCommit,
    permit: Permit,
  ) {
    return yield* importTransaction(
      input.batch,
      permit,
      Effect.gen(function* () {
        const { candidate, next, previous, registration } = input;
        // L4 may pass an unfinished frozen selection. Results are materialized here, IDs never regenerated.
        const itemResult: M.MemoryImportItemResult = input.rejectOnly
          ? {
              sourceItemKey: next.sourceItemKey,
              outcome: "rejected",
              memoryId: null,
              revisionId: null,
              ...input.rejectOnly,
            }
          : (input.selection.result ?? {
              sourceItemKey: next.sourceItemKey,
              outcome: next.outcome,
              memoryId:
                next.outcome === "suppressed" || next.outcome === "rejected" ? null : next.memoryId,
              revisionId:
                next.outcome === "suppressed" || next.outcome === "rejected"
                  ? null
                  : next.outcome === "noop"
                    ? ((next.pending ?? next.accepted)?.revisionId ?? null)
                    : input.selection.revisionId,
              ...(next.outcome === "rejected" && next.rejected
                ? { issue: next.rejected.issue }
                : {}),
            });
        const selection = { ...input.selection, result: itemResult };
        const selections = input.batch.selections.map((s) =>
          s.selector.sourceItemKey === next.sourceItemKey ? selection : s,
        );
        const remaining = selections.filter((s) => s.result === null).length;
        const batch = {
          ...input.batch,
          selections,
          receipt: {
            ...input.batch.receipt,
            state: remaining === 0 ? ("completed" as const) : ("partial" as const),
            remaining,
            items: selections.flatMap((s) => (s.result ? [s.result] : [])),
          },
        };
        if (
          registration.environmentId !== environmentId ||
          next.environmentId !== environmentId ||
          registration.memorySpaceId !== batch.memorySpaceId ||
          registration.sourceId !== batch.sourceId ||
          next.sourceId !== batch.sourceId ||
          next.memorySpaceId !== batch.memorySpaceId ||
          selection.memoryId !== next.memoryId ||
          selection.selector.sourceItemKey !== next.sourceItemKey ||
          candidate.sourceItemKey !== next.sourceItemKey ||
          candidate.sourceFingerprint !== selection.selector.sourceFingerprint ||
          !NodeUtil.isDeepStrictEqual(
            input.selection,
            input.batch.selections.find((s) => s.selector.sourceItemKey === next.sourceItemKey),
          ) ||
          (!input.rejectOnly && !NodeUtil.isDeepStrictEqual(next.scope, selection.selector.scope))
        )
          return yield* new Store.MemoryStoreConflict({ code: "identity_mismatch" });
        yield* requireScope(selection.selector.scope);
        if (
          input.rejectOnly &&
          (previous
            ? !NodeUtil.isDeepStrictEqual(next, previous)
            : next.outcome !== "rejected" ||
              next.accepted !== null ||
              next.pending !== null ||
              !NodeUtil.isDeepStrictEqual(next.scope, selection.selector.scope))
        )
          return yield* new Store.MemoryStoreConflict({ code: "identity_mismatch" });
        // Sync readiness is observed outside SQL; published local state is authoritative after lock.
        const ready = yield* query(
          sql`SELECT 1 FROM memory_compaction_state WHERE space=${batch.memorySpaceId} AND published=1`,
        );
        if (!ready.length)
          return yield* new Store.MemoryStoreConflict({ code: "bootstrap_required" });
        const commitIntent = Effect.gen(function* () {
          yield* permit;
          const savedRegistration = yield* store.readImportRegistrationTx({
            ...batch,
            by: "source",
          });
          if (
            !NodeUtil.isDeepStrictEqual(savedRegistration, registration) ||
            registration.version !== input.registrationVersion ||
            !NodeUtil.isDeepStrictEqual(next.accepted, previous?.accepted ?? null) ||
            (!input.rejectOnly && next.outcome !== selection.result?.outcome)
          )
            return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
          if (selection.selector.project) {
            const project = selection.selector.project;
            yield* projectRoot(project);
            const binding = yield* readProjectBinding(
              { memorySpaceId: batch.memorySpaceId, project },
              permit,
            );
            if (
              !input.projectBinding ||
              !NodeUtil.isDeepStrictEqual(binding, input.projectBinding) ||
              selection.selector.scope.kind !== "project" ||
              !NodeUtil.isDeepStrictEqual(binding.projectKey, selection.selector.scope.projectKey)
            )
              return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
            const storedBinding = yield* store.getProjectBinding(batch.memorySpaceId, project);
            if (
              !NodeUtil.isDeepStrictEqual(
                storedBinding ?? {
                  memorySpaceId: batch.memorySpaceId,
                  project,
                  projectKey: null,
                  repositoryKey: null,
                  version: 0,
                },
                binding,
              )
            )
              yield* store.putProjectBinding(
                binding,
                storedBinding?.version ?? null,
                yield* Clock.currentTimeMillis,
              );
          } else if (selection.selector.scope.kind === "project" || input.projectBinding !== null) {
            return yield* new Store.MemoryStoreConflict({ code: "identity_mismatch" });
          }
          if (previous && !NodeUtil.isDeepStrictEqual(previous.scope, next.scope))
            return yield* new Store.MemoryStoreConflict({ code: "identity_mismatch" });
          if (input.rejectOnly) return;
          const match = yield* store.findImportMatchTx({
            ...batch,
            source: {
              environmentId,
              sourceId: batch.sourceId,
              sourceItemKey: candidate.sourceItemKey,
            },
            content: {
              scope: next.scope,
              assertionKind: "inference",
              contentFingerprint: candidate.contentFingerprint,
            },
          });
          if (next.outcome === "suppressed") {
            if (
              match.kind !== "source_suppressed" &&
              match.kind !== "content_suppressed" &&
              match.kind !== "pending_forget"
            )
              return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
            return;
          }
          if (next.outcome === "rejected") {
            if (
              !next.rejected ||
              next.rejected.sourceFingerprint !== candidate.sourceFingerprint ||
              itemResult.issue !== next.rejected.issue
            )
              return yield* new Store.MemoryStoreConflict({ code: "invalid_output" });
            return;
          }
          const priorObservation = previous?.pending ?? previous?.accepted;
          const current = yield* store.loadAggregate(
            batch.memorySpaceId,
            next.memoryId,
            {
              revisionIds: [
                ...(priorObservation ? [priorObservation.revisionId] : []),
                ...input.parents,
              ],
            },
            {},
          );
          if (current.identity && !NodeUtil.isDeepStrictEqual(current.identity.scope, next.scope))
            return yield* new Store.MemoryStoreConflict({ code: "identity_mismatch" });
          if (current.tombstone) return yield* new Store.MemoryStoreConflict({ code: "forgotten" });
          if (current.pendingForget)
            return yield* new Store.MemoryStoreConflict({ code: "forget_pending" });
          if (
            current.heads.length !== input.expectedHeads.length ||
            !current.heads.every((h) => input.expectedHeads.includes(h))
          )
            return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
          if (next.outcome === "noop") {
            const observation = previous?.pending ?? previous?.accepted;
            const payload = current.revisions.find(
              (r) => r.revision.revisionId === observation?.revisionId,
            )?.payload;
            if (
              !observation ||
              observation.sourceFingerprint !== candidate.sourceFingerprint ||
              observation.contentFingerprint !== candidate.contentFingerprint ||
              payload?.text !== candidate.payload.text ||
              !NodeUtil.isDeepStrictEqual(next.pending, previous?.pending ?? null)
            )
              return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
            return;
          }
          // Updated imports branch only from their last accepted observation, never a pending proposal.
          let parents = previous?.accepted ? [previous.accepted.revisionId] : [];
          let alias: { revision: M.MemoryRevision; payload: M.MemoryPayload } | undefined;
          if (
            next.outcome === "aliased" &&
            !previous?.accepted &&
            !previous?.pending &&
            input.parents.length === 1
          ) {
            const parent = current.revisions.find(
              (r) => r.revision.revisionId === input.parents[0],
            );
            const accepted = parent
              ? yield* store.receipt(batch.memorySpaceId, parent.revision.operationId)
              : undefined;
            if (
              !parent ||
              current.item?.status !== "active" ||
              current.heads.length !== 1 ||
              current.heads[0] !== parent.revision.revisionId ||
              parent.payload?.text !== candidate.payload.text ||
              !accepted ||
              !("hubSequence" in accepted.receipt) ||
              accepted.receipt.hubSequence === null ||
              accepted.receipt.outcome === "rejected"
            )
              return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
            parents = [parent.revision.revisionId];
            alias = { revision: parent.revision, payload: parent.payload! };
          }
          if (
            parents.length !== input.parents.length ||
            !parents.every((h) => input.parents.includes(h)) ||
            (current.identity &&
              next.outcome !== "aliased" &&
              (!previous || previous.memoryId !== next.memoryId))
          )
            return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
          const observation = next.pending;
          if (
            !observation ||
            observation.operationId !== selection.operationId ||
            observation.revisionId !== selection.revisionId ||
            observation.sourceFingerprint !== candidate.sourceFingerprint ||
            observation.contentFingerprint !== candidate.contentFingerprint
          )
            return yield* new Store.MemoryStoreConflict({ code: "identity_mismatch" });
          const operation = yield* decode(
            decodeOperation(
              {
                protocolVersion: 1,
                kind: "upsert",
                memorySpaceId: batch.memorySpaceId,
                memoryId: next.memoryId,
                operationId: selection.operationId,
                originEnvironmentId: environmentId,
                expectedHeads: input.parents,
                revision: {
                  memorySpaceId: batch.memorySpaceId,
                  memoryId: next.memoryId,
                  operationId: selection.operationId,
                  revisionId: selection.revisionId,
                  payloadRef: alias?.revision.payloadRef ?? selection.revisionId,
                  parents: input.parents,
                  scope: next.scope,
                  assertionKind: "inference",
                  createdAtUtc: batch.createdAtUtc,
                  provenance: {
                    environmentId,
                    importSource: {
                      sourceId: registration.sourceId,
                      format: provenanceImportFormat(registration.source.format),
                      parserVersion: registration.source.parserVersion,
                      sourceLocator: registration.sourceLocator,
                      sourceItemKey: candidate.sourceItemKey,
                      sourceFingerprint: candidate.sourceFingerprint,
                      contentFingerprint: candidate.contentFingerprint,
                      sourceAliases: [],
                      acceptedContentFingerprints: [],
                    },
                  },
                },
                payload: alias?.payload ?? candidate.payload,
              },
              strict,
            ),
          );
          if (operation.kind !== "upsert")
            return yield* new Store.MemoryStoreConflict({ code: "invalid_output" });
          const receipt = yield* apply(
            operation,
            { ...Store.localIntent, localExpectedHeads: input.expectedHeads },
            permit,
          );
          if ((receipt.receipt.outcome === "conflicted") !== (next.outcome === "conflicted"))
            return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
          if (receipt.receipt.outcome === "rejected")
            return yield* new Store.MemoryStoreConflict({ code: "invalid_output" });
          // Parent-aware intent records the frozen operation, unlike the initial-only local draft materializer.
          yield* store.enqueueWork({
            id: `import:${environmentId}:${batch.operationId}:${selection.operationId}`,
            space: batch.memorySpaceId,
            memoryId: next.memoryId,
            kind: "admin",
            status: "completed",
            metadata: {
              protocolVersion: 1,
              kind: "upsert",
              operationId: selection.operationId,
              memorySpaceId: batch.memorySpaceId,
              memoryId: next.memoryId,
              originEnvironmentId: environmentId,
              expectedHeads: input.parents,
              revision: operation.revision,
            },
            payloadRef: operation.revision.payloadRef,
            attempt: 0,
            nextAttemptAt: 0,
            claimedBy: null,
            claimedUntil: null,
          });
          yield* permit;
        });
        const result = yield* store.commitImportItemTx({
          registrationVersion: input.registrationVersion,
          batch,
          previous,
          next,
          commitIntent,
          preserveItem: input.rejectOnly !== undefined,
          contentFingerprint: candidate.contentFingerprint,
        });
        yield* permit;
        return result;
      }),
    );
  });
  const importPorts: MemoryService["Service"]["importPorts"] = {
    readRegistration: (input, permit) =>
      importTransaction(input, permit, store.readImportRegistrationTx(input)),
    saveRegistration: (input, permit) =>
      importTransaction(input, permit, store.writeImportRegistrationTx(input)),
    preflightBatch: (input, permit) =>
      importTransaction(
        input,
        permit,
        Effect.gen(function* () {
          const batch = yield* store.readImportBatchTx(input);
          if (!batch) return { kind: "new" as const };
          if (batch.selectionDigest !== input.selectionDigest)
            return yield* new M.MemoryImportRpcError({
              issue: "operation_id_reused",
              operationId: input.operationId,
            });
          if (batch.kind === "retired") return { kind: "retired" as const };
          return batch.kind === "completed-noop-ref" || batch.receipt.state === "completed"
            ? { kind: "completed" as const, receipt: batch.receipt }
            : { kind: "partial" as const, batch, receipt: batch.receipt };
        }),
      ),
    readReceipt: (input, permit) =>
      importTransaction(input, permit, store.readImportReceiptTx(input)).pipe(
        Effect.flatMap((receipt) =>
          receipt
            ? Effect.succeed(receipt)
            : Effect.fail(new M.MemoryRpcError({ code: "not_found" })),
        ),
      ),
    readItem: (input, permit) => importTransaction(input, permit, store.readImportItemTx(input)),
    findMatch: (input, permit) => importTransaction(input, permit, store.findImportMatchTx(input)),
    prepareTarget: (input, permit) =>
      importTransaction(
        input,
        permit,
        Effect.gen(function* () {
          yield* requireScope(input.scope);
          const current = yield* store.loadAggregate(
            input.memorySpaceId,
            input.memoryId,
            { heads: true },
            {},
          );
          if (current.identity && !NodeUtil.isDeepStrictEqual(current.identity.scope, input.scope))
            return yield* new Store.MemoryStoreConflict({ code: "identity_mismatch" });
          const acceptedParent =
            input.acceptedRevisionId === null
              ? null
              : (yield* store.readAncestry(input.memorySpaceId, input.memoryId, [
                  input.acceptedRevisionId,
                ])).parents[0]!;
          const head =
            current.item?.status === "active" &&
            current.heads.length === 1 &&
            !current.pendingForget &&
            !current.tombstone
              ? current.revisions.find((r) => r.revision.revisionId === current.heads[0])
              : undefined;
          const approval = head
            ? yield* store.receipt(input.memorySpaceId, head.revision.operationId)
            : undefined;
          return {
            identity: current.identity ?? null,
            heads: current.heads,
            forgotten: current.tombstone !== undefined,
            pendingForget: current.pendingForget !== undefined,
            acceptedParent,
            alias:
              head?.payload &&
              approval &&
              "hubSequence" in approval.receipt &&
              approval.receipt.hubSequence !== null &&
              approval.receipt.outcome !== "rejected"
                ? { revision: head.revision, payload: head.payload }
                : null,
          };
        }),
      ),
    binding: readProjectBinding,
    resolveProjectKey: (space, project) =>
      readProjectBinding({ memorySpaceId: space, project }, Effect.void).pipe(
        Effect.map((binding) => binding.projectKey),
      ),
    commit: commitImport,
  };
  const commitLocalIntent: MemoryService["Service"]["commitLocalIntent"] = Effect.fn(
    "MemoryService.commitLocalIntent",
  )(function* (input) {
    const permit = Effect.gen(function* () {
      const binding = yield* input.readBinding;
      if (
        !binding.enabled ||
        binding.coordinatorEpoch !== input.expectedEpoch ||
        binding.memorySpaceId !== input.assignment.memorySpaceId
      )
        return yield* new MemoryAccessError({ code: "fenced" });
    });
    return yield* store.transact(
      Effect.gen(function* () {
        yield* permit;
        let materialized = yield* store.materializeLocalIntentTx({
          ...input.assignment,
          environmentId,
        });
        if (materialized.operation.kind !== "forget") {
          const payload = yield* normalizeMemoryDependencies(
            materialized.operation.memorySpaceId,
            materialized.operation.payload,
          ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
          const operation = { ...materialized.operation, payload };
          materialized = { operation, operationDigest: memoryOperationDigest(operation) };
        }
        const receipt = yield* apply(materialized.operation, Store.localIntent, permit);
        yield* permit;
        yield* store.completeLocalIntentTx({
          environmentId,
          intentId: input.assignment.intentId,
          materialized,
          now: yield* Clock.currentTimeMillis,
        });
        return { ...materialized, receipt };
      }),
    );
  });
  const requireCaller = (thread?: M.ScopedThreadRef) =>
    thread && thread.environmentId !== environmentId
      ? Effect.fail(new MemoryAccessError({ code: "identity_mismatch" }))
      : Effect.void;
  const requireCompleteLineage = Effect.fn("MemoryService.requireCompleteLineage")(function* (
    space: M.MemorySpaceId,
    thread?: M.ScopedThreadRef,
  ) {
    yield* requireCaller(thread);
    const lineage = thread ? yield* store.readThreadLineage(thread, space) : undefined;
    if (lineage && lineage.state !== "tracked")
      return yield* new Store.MemoryStoreConflict({ code: "thread_lineage_incomplete" });
    return lineage;
  });
  // Called inside the response's writer transaction. Only returned bodies count;
  // one append per call, even for history/search pages with multiple revisions.
  const consume = Effect.fn("MemoryService.consume")(function* (
    space: M.MemorySpaceId,
    thread: M.ScopedThreadRef | undefined,
    pairs: ReadonlyArray<{ revision: M.MemoryRevision; payload: M.MemoryPayload | null }>,
  ) {
    if (!thread || !pairs.some((pair) => pair.payload !== null)) return;
    yield* requireCaller(thread);
    const revisions = new Set<M.MemoryRevisionId>();
    for (const pair of pairs) {
      if (!pair.payload) continue;
      const closed = yield* normalizeMemoryDependencies(space, pair.payload, true).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      revisions.add(pair.revision.revisionId);
      for (const id of closed.derivedFromMemoryRevisions) revisions.add(id);
    }
    yield* store.appendThreadLineage(thread, space, [...revisions]);
  });
  const upsert = Effect.fn("MemoryService.upsert")(function* (
    input: M.MemoryUpsertInput,
    permit: Permit,
    sourceThread?: M.ScopedThreadRef,
  ) {
    const value = yield* decode(decodeUpsert(input, strict));
    return yield* store.transact(
      Effect.gen(function* () {
        yield* permit;
        yield* requireSharing(value.memorySpaceId);
        yield* requireCaller(sourceThread);
        const requestDigest = hash(
          yield* decode(
            Schema.encodeEffect(
              Schema.fromJsonString(
                Schema.Struct({
                  input: M.MemoryUpsertInput,
                  caller: Schema.NullOr(M.ScopedThreadRef),
                }),
              ),
            )({ input: value, caller: sourceThread ?? null }),
          ),
        );
        const prior = yield* store.receipt(value.memorySpaceId, value.operationId);
        if (prior) {
          const rows = yield* query(sql<{
            request_digest: string | null;
            origin_environment_id: string;
          }>`
            SELECT json_extract(compact_json,'$.upsertRequestDigest') AS request_digest,
              json_extract(compact_json,'$.originEnvironmentId') AS origin_environment_id
            FROM memory_compact_receipts WHERE space=${value.memorySpaceId} AND operation_id=${value.operationId}
            UNION ALL SELECT json_extract(metadata_json,'$.revision.provenance.upsertRequestDigest') AS request_digest,origin_environment_id
            FROM memory_events WHERE memory_space_id=${value.memorySpaceId} AND operation_id=${value.operationId} LIMIT 1`);
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
                    memoryStableUuid(`${value.memorySpaceId}:${value.operationId}:revision`),
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
        yield* requireScope(value.scope);
        const lineage = yield* requireCompleteLineage(value.memorySpaceId, sourceThread);
        const revisionId = M.MemoryRevisionId.make(
          memoryStableUuid(`${value.memorySpaceId}:${value.operationId}:revision`),
        );
        let payload: M.MemoryPayload = yield* normalizeMemoryDependencies(
          value.memorySpaceId,
          value.payload,
        ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
        if (lineage) {
          payload = yield* decode(
            decodeSummaryPayload(
              {
                ...payload,
                derivedFromMemoryRevisions: [
                  ...new Set([...payload.derivedFromMemoryRevisions, ...lineage.revisions]),
                ],
              },
              strict,
            ),
          );
          yield* validateSummaryDependencies(value.memorySpaceId, payload).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
        }
        const op: M.MemoryOperation = {
          protocolVersion: 1,
          kind: "upsert",
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
            provenance: { environmentId, upsertRequestDigest: requestDigest },
            createdAtUtc: M.MemoryUtcTimestamp.make(
              DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
            ),
          },
          payload,
        };
        return yield* apply(op, Store.localIntent, permit);
      }),
    );
  });
  const forget = Effect.fn("MemoryService.forget")(function* (
    input: M.MemoryForgetInput,
    permit: Permit,
  ) {
    const value = yield* decode(decodeForget(input, strict));
    return yield* store
      .transact(
        Effect.gen(function* () {
          yield* permit;
          yield* requireSharing(value.memorySpaceId);
          const current = yield* store.loadAggregate(
            value.memorySpaceId,
            value.memoryId,
            {
              when: Store.hasSourceEvidence,
            },
            {},
          );
          if (current.identity) yield* requireScope(current.identity.scope);
          const old = yield* store.readOperation(value.memorySpaceId, value.operationId);
          if (
            old &&
            (old.kind !== "forget" ||
              old.memoryId !== value.memoryId ||
              encodeHeads(old.expectedHeads) !== encodeHeads(value.expectedHeads))
          )
            return yield* new Store.MemoryStoreConflict({ code: "operation_id_reused" });
          if (current.tombstone && !old)
            return {
              operationDigest: "0".repeat(64),
              receipt: {
                operationId: current.tombstone.deleteOperationId,
                memoryId: value.memoryId,
                outcome: "noop" as const,
                revisionId: null,
                pendingSync: false,
              },
            };
          // Lifetime evidence survives compaction and is captured before base deletion purges payloads.
          const lineage = yield* store.readImportLineage(value.memorySpaceId, value.memoryId);
          const suppressedSourceKeys = lineage.flatMap((r) =>
            r.kind === "sourceKey" ? [r.sourceKey] : [],
          );
          const suppressedContent = lineage.flatMap((r) =>
            r.kind === "content" ? [r.content] : [],
          );
          const sourceExclusions: M.MemorySourceExclusion[] = [];
          for (const { revision, payload } of current.revisions) {
            const p = revision.provenance;
            if (p.sourceThread && p.sourceWatermark) {
              const messageIds = [
                ...new Set((payload?.evidence ?? []).flatMap((e) => e.messageIds)),
              ];
              if (messageIds.length)
                sourceExclusions.push({
                  sourceThread: p.sourceThread,
                  sourceWatermark: p.sourceWatermark,
                  messageIds,
                });
            }
          }
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
                    memoryStableUuid(`${value.operationId}:lineage-fragment:${offset / 100}`),
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
          return base!;
        }),
      )
      .pipe(
        Effect.catchTags({
          MemoryCapacityError: (error) =>
            store
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
              .pipe(Effect.andThen(Effect.fail(error))),
        }),
      );
  });

  const retryForgetExpansion = Effect.fn("MemoryService.retryForgetExpansion")(function* (
    intent: Store.PendingForgetIntent,
  ) {
    const original = yield* store.readOperation(intent.memorySpaceId, intent.operationId);
    if (
      !original ||
      original.kind !== "forget" ||
      memoryOperationDigest(original) !== intent.operationDigest
    )
      return yield* new Store.MemoryStoreConflict({ code: "identity_mismatch" });
    const operationId = M.MemoryOperationId.make(
      memoryStableUuid(`${intent.operationId}:${intent.attempts}:retry`),
    );
    const operation: M.MemoryOperation = {
      ...original,
      operationId,
      tombstone: { ...original.tombstone, deleteOperationId: operationId },
    };
    yield* store
      .transact(
        Effect.gen(function* () {
          const current = yield* store.loadAggregate(intent.memorySpaceId, intent.memoryId, {}, {});
          if (current.identity) yield* requireScope(current.identity.scope);
          const decision = yield* decide(current, operation, Store.localIntent);
          const receipt = {
            ...decision.receipt,
            forgetRetryOf: {
              operationId: intent.operationId,
              operationDigest: intent.operationDigest!,
            },
          };
          // Failed retries retain one bounded intent and the original rejection, not another event per sweep.
          yield* quota.withAdmission(
            { operation, admission: Store.localIntent, environmentId, receipt },
            store.apply({ ...decision, receipt }),
          );
        }),
      )
      .pipe(
        Effect.catchTags({
          MemoryCapacityError: (error) =>
            store.preserveForgetIntent(intent).pipe(Effect.andThen(Effect.fail(error))),
        }),
      );
  });

  const revertResolution = Effect.fn("MemoryService.revertResolution")(function* (
    input: M.MemoryRevertResolutionInput,
    permit: Permit,
    sourceThread?: M.ScopedThreadRef,
  ) {
    const value = yield* decode(decodeRevert(input, strict));
    return yield* store.transact(
      Effect.gen(function* () {
        yield* permit;
        yield* requireSharing(value.memorySpaceId);
        yield* requireCaller(sourceThread);
        const current = yield* store.loadAggregate(
          value.memorySpaceId,
          value.memoryId,
          { revisionIds: [value.restoredRevisionId] },
          { resolutionId: value.resolutionId },
        );
        if (current.identity) yield* requireScope(current.identity.scope);
        const resolution = current.resolutions.find((r) => r.resolutionId === value.resolutionId);
        if (!resolution) return yield* new Store.MemoryStoreConflict({ code: "not_found" });
        const result = {
          operationId: value.operationId,
          memoryId: value.memoryId,
          resolutionId: value.resolutionId,
          revertDeadlineUtc: resolution.revertDeadlineUtc,
        };
        const refuse = (status: "forgotten" | "revision_changed") =>
          store
            .recordRevertResultTx({
              space: value.memorySpaceId,
              memoryId: value.memoryId,
              resolutionId: value.resolutionId,
              operationId: value.operationId,
              slot: { status },
            })
            .pipe(Effect.as({ ...result, status }));
        const approved = yield* store.receipt(value.memorySpaceId, value.operationId);
        if (
          approved &&
          "hubSequence" in approved.receipt &&
          approved.receipt.outcome === "accepted"
        ) {
          const operation = yield* store.readOperation(value.memorySpaceId, value.operationId);
          if (
            operation?.kind !== "revert" ||
            operation.restoredRevisionId !== value.restoredRevisionId ||
            operation.revertsResolutionId !== value.resolutionId
          )
            return yield* new Store.MemoryStoreConflict({ code: "operation_id_reused" });
          yield* store.recordRevertResultTx({
            space: value.memorySpaceId,
            memoryId: value.memoryId,
            resolutionId: value.resolutionId,
            operationId: value.operationId,
            slot: { status: "accepted", revisionId: operation.revision.revisionId },
          });
          return {
            ...result,
            status: "accepted" as const,
            receipt: {
              operationId: value.operationId,
              memoryId: value.memoryId,
              outcome: "accepted" as const,
              revisionId: operation.revision.revisionId,
              pendingSync: false,
            },
            localAvailability: current.item!.localAvailability,
          };
        }
        const staged = yield* store.readWorkOperation(
          `revert:${value.memorySpaceId}:${value.operationId}`,
        );
        if (staged) {
          if (staged.kind !== "revert")
            return yield* new Store.MemoryStoreConflict({ code: "operation_id_reused" });
          yield* store.stageRevertIntent({
            operation: staged,
            requestDigest: hash(encodeRevert(value)),
          });
          return { ...result, status: "pending" as const };
        }
        yield* requireCompleteLineage(value.memorySpaceId, sourceThread);
        if (current.tombstone || current.pendingForget) return yield* refuse("forgotten");
        if (
          current.heads.length !== 1 ||
          current.heads[0] !== resolution.resultRevisionId ||
          value.expectedHeads[0] !== resolution.resultRevisionId
        )
          return yield* refuse("revision_changed");
        const now = yield* Clock.currentTimeMillis;

        const original = current.revisions.find(
          (r) => r.revision.revisionId === value.restoredRevisionId,
        );
        if (!original?.payload || !resolution.inputRevisionIds.includes(value.restoredRevisionId))
          return yield* refuse("revision_changed");
        const revisionId = M.MemoryRevisionId.make(memoryStableUuid(`${value.operationId}:revert`));
        yield* store.stageRevertIntent({
          requestDigest: hash(encodeRevert(value)),
          operation: {
            protocolVersion: 1,
            kind: "revert",
            memorySpaceId: value.memorySpaceId,
            memoryId: value.memoryId,
            operationId: value.operationId,
            originEnvironmentId: environmentId,
            expectedHeads: value.expectedHeads,
            revertsResolutionId: value.resolutionId,
            restoredRevisionId: value.restoredRevisionId,
            payload: original.payload,
            revision: {
              ...original.revision,
              revisionId,
              operationId: value.operationId,
              parents: value.expectedHeads,
              payloadRef: revisionId,
              provenance: { environmentId },
              createdAtUtc: M.MemoryUtcTimestamp.make(DateTime.formatIso(DateTime.makeUnsafe(now))),
            },
          },
        });
        return { ...result, status: "pending" as const };
      }),
    );
  });
  const read = Effect.fn("MemoryService.read")(function* (
    input: M.MemoryReadInput,
    permit: Permit,
    sourceThread?: M.ScopedThreadRef,
  ) {
    const value = yield* decode(decodeRead(input, strict));
    return yield* store.transact(
      Effect.gen(function* () {
        yield* permit;
        const current = yield* store.readAccess(value.memorySpaceId, value.memoryId);
        if (!current.item) return yield* new Store.MemoryStoreConflict({ code: "not_found" });
        if (current.identity) yield* requireScope(current.identity.scope);
        yield* permit;
        yield* consume(
          value.memorySpaceId,
          sourceThread,
          current.item.status === "active" ? [current.item] : [],
        );
        return current.item;
      }),
    );
  });
  const page = Effect.fn("MemoryService.page")(function* (
    input: M.MemoryListInput | M.MemorySearchInput,
    permit: Permit,
    sourceThread?: M.ScopedThreadRef,
  ) {
    yield* permit;
    const scope = input.scope ?? { kind: "user" as const };
    yield* requireScope(scope);
    const scopeKey =
      scope.kind === "user"
        ? "user"
        : scope.kind === "thread"
          ? `thread:${scope.thread.environmentId.length}:${scope.thread.environmentId}:${scope.thread.threadId}`
          : scope.projectKey.kind === "repository"
            ? `repository:${scope.projectKey.groupingKey}`
            : `explicit:${scope.projectKey.sharedProjectId}`;
    const normalizedQuery = "query" in input ? input.query.normalize("NFC").trim() : undefined;
    const binding =
      "query" in input
        ? {
            memorySpaceId: input.memorySpaceId,
            queryDigest: NodeCrypto.createHash("sha256").update(normalizedQuery!).digest("hex"),
            mode: input.mode,
            scopeKey: NodeCrypto.createHash("sha256").update(scopeKey).digest("hex"),
          }
        : undefined;
    const cursor = input.cursor
      ? yield* Effect.try({
          try: () =>
            binding
              ? M.decodeMemorySearchCursor(input.cursor!, binding)
              : M.MemoryId.make(input.cursor!),
          catch: () => new Store.MemoryStoreConflict({ code: "invalid_cursor" }),
        })
      : undefined;
    if ("query" in input) {
      // Commit the bounded recovery batch even when substring is refused until ready.
      const coverage = yield* store.searchCoverage({
        memorySpaceId: input.memorySpaceId,
        scope: input.scope ?? { kind: "user" },
        limit: input.limit,
      });
      if (!coverage.ready) {
        yield* permit;
        if (input.mode === "substring")
          return yield* new Store.MemoryStoreConflict({ code: "unavailable" });
        const rows = yield* query(
          sql<{
            watermark: number;
          }>`SELECT coalesce((SELECT projection_watermark FROM memory_compaction_state WHERE space=${input.memorySpaceId}),0) AS watermark`,
        );
        const watermark = rows[0]!.watermark;
        yield* permit;
        return {
          items: [],
          projectionWatermark: watermark,
          nextCursor: null,
          indexCoverage: {
            status: "unavailable" as const,
            eligibleItems: 0,
            indexedItems: 0,
            unindexedItems: 0,
            projectionWatermark: watermark,
          },
        };
      }
    }
    return yield* store.transact(
      Effect.gen(function* () {
        yield* permit;
        const filter: Store.MemoryReadFilter = {
          memorySpaceId: input.memorySpaceId,
          scope,
          limit: input.limit,
          ...(cursor ? { afterMemoryId: cursor } : {}),
        };
        const coverage = "query" in input ? yield* store.searchCoverage(filter) : undefined;
        const searched =
          "query" in input && coverage?.ready
            ? yield* store.search(filter, normalizedQuery!, input.mode)
            : undefined;
        if ("query" in input && input.mode === "substring" && !coverage?.ready)
          return yield* new Store.MemoryStoreConflict({ code: "unavailable" });
        let items = "query" in input ? (searched?.items ?? []) : yield* store.list(filter);
        let nextCursor =
          "query" in input
            ? searched && !searched.exhausted && searched.examinedAfterMemoryId
              ? M.encodeMemorySearchCursor(binding!, searched.examinedAfterMemoryId)
              : null
            : items.length === input.limit
              ? (items.at(-1)?.memoryId ?? null)
              : null;
        if (!("query" in input)) {
          let bytes = 2048;
          const bounded: M.MemoryItem[] = [];
          for (const item of items) {
            const encoded = yield* query(encodePageItem(item));
            const size = new TextEncoder().encode(encoded).length + 1;
            if (bytes + size > M.MEMORY_PAGE_MAX_UTF8_BYTES) {
              if (!bounded.length)
                return yield* new Store.MemoryStoreConflict({ code: "payload_too_large" });
              nextCursor = bounded.at(-1)!.memoryId;
              break;
            }
            bytes += size;
            bounded.push(item);
          }
          items = bounded;
        }
        if ("includeQuarantined" in input && !input.includeQuarantined)
          items = items.filter((i) => i.status !== "quarantined");
        const rows = yield* query(
          sql<{
            watermark: number;
          }>`SELECT coalesce((SELECT projection_watermark FROM memory_compaction_state WHERE space=${input.memorySpaceId}),0) AS watermark`,
        );
        const state = {
          watermark: rows[0]!.watermark,
          eligible: coverage?.ready ? coverage.eligible : 0,
          indexed: coverage?.ready
            ? "query" in input && input.mode === "substring"
              ? coverage.eligible
              : coverage.indexed
            : 0,
        };
        yield* permit;
        yield* consume(
          input.memorySpaceId,
          sourceThread,
          items.flatMap((item) => (item.status === "active" ? [item] : [])),
        );
        return yield* decode(
          decodePage(
            {
              items,
              projectionWatermark: state.watermark,
              nextCursor,
              ...("query" in input
                ? {
                    indexCoverage: {
                      status: !coverage?.ready
                        ? "unavailable"
                        : state.eligible === state.indexed
                          ? "available"
                          : state.indexed === 0
                            ? "unavailable"
                            : "partial",
                      eligibleItems: state.eligible,
                      indexedItems: state.indexed,
                      unindexedItems: state.eligible - state.indexed,
                      projectionWatermark: state.watermark,
                    },
                  }
                : {}),
            },
            strict,
          ),
        );
      }),
    );
  });
  const list = (input: M.MemoryListInput, permit: Permit, sourceThread?: M.ScopedThreadRef) =>
    decode(decodeList(input, strict)).pipe(Effect.flatMap((v) => page(v, permit, sourceThread)));
  const search = Effect.fn("MemoryService.search")(function* (
    input: M.MemorySearchInput,
    permit: Permit,
    sourceThread?: M.ScopedThreadRef,
  ) {
    // Validate every non-cursor field first, preserving strictness and its error channel.
    const { cursor: _cursor, ...rest } = input;
    yield* decode(decodeSearch(rest, strict));
    const value = yield* decodeSearch(input, strict).pipe(
      Effect.mapError(() => new Store.MemoryStoreConflict({ code: "invalid_cursor" })),
    );
    return yield* page(value, permit, sourceThread);
  });
  const history = Effect.fn("MemoryService.history")(function* (
    input: M.MemoryHistoryInput,
    permit: Permit,
    sourceThread?: M.ScopedThreadRef,
  ) {
    const value = yield* decode(decodeHistory(input, strict));
    return yield* store.transact(
      Effect.gen(function* () {
        yield* permit;
        const current = yield* store.readAccess(value.memorySpaceId, value.memoryId);
        if (!current.item) return yield* new Store.MemoryStoreConflict({ code: "not_found" });
        if (current.identity) yield* requireScope(current.identity.scope);
        if (value.resolutionInputsFor !== undefined) {
          const result = yield* store.readResolutionInputsPage({
            ...value,
            resolutionInputsFor: value.resolutionInputsFor,
          });
          yield* permit;
          yield* consume(value.memorySpaceId, sourceThread, result.page.revisions);
          return result.page;
        }
        const { page, consumed } = yield* store.historyPage(value, current.item, environmentId);
        yield* permit;
        yield* consume(value.memorySpaceId, sourceThread, consumed);
        return yield* decode(decodeHistoryPage(page, strict));
      }),
    );
  });
  const reconnectParked = Effect.fn("MemoryService.reconnectParked")(function* (
    op: M.MemoryOperation,
  ) {
    if (op.kind === "forget") return false;
    return yield* store.transact(
      Effect.gen(function* () {
        const current = yield* store.loadAggregate(
          op.memorySpaceId,
          op.memoryId,
          { heads: true },
          {
            revision: op.revision,
            ...(op.kind === "resolve"
              ? { metadataRevisionIds: op.resolution.inputRevisionIds }
              : {}),
          },
        );
        const old = yield* store.receipt(op.memorySpaceId, op.operationId);
        if (!old || !("hubSequence" in old.receipt)) return false;
        const ancestry = yield* store.readAncestry(
          op.memorySpaceId,
          op.memoryId,
          op.revision.parents,
        );
        if (ancestry.parents.some((p) => p.status !== "retained" && p.status !== "compacted"))
          return false;
        const decision = yield* decide(current, op, Store.approvedReplica, old.receipt, ancestry);
        yield* store.reconnectParked(decision, current.generation);
        return !decision.pending;
      }),
    );
  });
  const commitSummary = Effect.fn("MemoryService.commitSummary")(function* (input: SummaryCommit) {
    const generated = yield* decode(decodeSummary(input.generated, strict));
    const work = input.work;
    if (work.metadata.kind !== "summary" || !work.memoryId)
      return yield* new Store.MemoryStoreConflict({ code: "unsupported_operation" });
    const meta = work.metadata;
    if (
      generated.execution.environmentId !== environmentId ||
      generated.execution.providerInstanceId !== meta.modelSelection.instanceId ||
      encodeSelection(generated.execution.requestedModelSelection) !==
        encodeSelection(meta.modelSelection)
    )
      return yield* new Store.MemoryStoreConflict({ code: "identity_mismatch" });
    if (!M.validateMemoryGenerationResult(input.input, generated.result)) return yield* invalid();
    if (scanMemoryValue(generated.result).kind !== "allowed")
      return yield* new Store.MemoryStoreConflict({ code: "secret_detected" });
    return yield* store.transact(
      Effect.gen(function* () {
        const currentWork = yield* store.readWork(work.id);
        if (
          !currentWork ||
          currentWork.status !== "running" ||
          currentWork.claimedBy !== work.claimedBy ||
          currentWork.attempt !== work.attempt ||
          currentWork.claimedUntil !== work.claimedUntil ||
          work.claimedUntil === null ||
          work.claimedUntil <= (yield* Clock.currentTimeMillis)
        )
          return yield* new Store.MemoryStoreConflict({ code: "attempt_expired" });
        yield* input.recheckSource;
        const current = yield* store.loadAggregate(
          M.MemorySpaceId.make(work.space),
          work.memoryId!,
          {},
          {},
        );
        if (current.tombstone || current.pendingForget)
          return yield* new Store.MemoryStoreConflict({ code: "forgotten" });
        if (encodeHeads(current.heads) !== encodeHeads(input.expectedHeads))
          return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
        const lineage = yield* store.readThreadLineage(
          meta.sourceThread,
          M.MemorySpaceId.make(work.space),
        );
        if (lineage.state !== "tracked")
          return yield* new Store.MemoryStoreConflict({ code: "source_invalidated" });
        // The final input also carries lineage across in-memory generation chunks. Rebuilds
        // without the old summary must not inherit dependencies from the discarded head.
        const payload = yield* decode(
          decodeSummaryPayload(
            {
              text: generated.result.text,
              evidence: generated.result.evidence,
              derivedFromMemoryRevisions: [
                ...new Set([
                  ...lineage.revisions,
                  ...(input.input.previousSummary?.derivedFromMemoryRevisions ?? []),
                ]),
              ],
            },
            strict,
          ),
        );
        yield* validateSummaryDependencies(M.MemorySpaceId.make(work.space), payload).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
        const execution = generated.execution;
        const receipt = yield* apply(
          {
            protocolVersion: 1,
            kind: "upsert",
            memorySpaceId: M.MemorySpaceId.make(work.space),
            memoryId: work.memoryId!,
            operationId: meta.operationId,
            originEnvironmentId: environmentId,
            expectedHeads: input.expectedHeads,
            payload,
            revision: {
              memorySpaceId: M.MemorySpaceId.make(work.space),
              memoryId: work.memoryId!,
              revisionId: meta.revisionId,
              operationId: meta.operationId,
              parents: input.expectedHeads,
              scope: { kind: "thread", thread: meta.sourceThread },
              payloadRef: meta.revisionId,
              assertionKind: generated.result.assertionKind,
              createdAtUtc: M.MemoryUtcTimestamp.make(
                DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
              ),
              provenance: {
                environmentId,
                providerInstanceId: execution.providerInstanceId,
                provider: execution.effectiveProvider,
                requestedModelSelection: execution.requestedModelSelection,
                effectiveModel: execution.effectiveModel,
                sourceThread: meta.sourceThread,
                sourceWatermark: meta.sourceWatermark,
              },
            },
          },
          Store.localIntent,
          Effect.void,
        );
        if (!(yield* store.completeSummaryWork(work)))
          return yield* new Store.MemoryStoreConflict({ code: "attempt_expired" });
        return receipt;
      }),
    );
  });
  const queueSummary = Effect.fn("MemoryService.queueSummary")(function* (work: Store.MemoryWork) {
    if (
      !["summary", "consolidate"].includes(work.kind) ||
      work.metadata.kind !== "summary" ||
      work.metadata.sourceThread.environmentId !== environmentId
    )
      return yield* new Store.MemoryStoreConflict({ code: "unsupported_operation" });
    yield* store.transact(store.enqueueWork(work));
  });
  const readContextCandidates = Effect.fn("MemoryService.readContextCandidates")(function* (
    input: M.MemoryListInput,
    permit: Permit,
  ) {
    const result = yield* list(input, permit);
    return {
      memorySpaceId: input.memorySpaceId,
      projectionWatermark: result.projectionWatermark,
      nextCursor: result.nextCursor,
      items: result.items.flatMap((i) =>
        i.status === "active" && i.localAvailability.exposure === "visible"
          ? [
              {
                memoryId: i.memoryId,
                revisionId: i.revision.revisionId,
                scope: i.scope,
                provenance: i.revision.provenance,
                assertionKind: i.revision.assertionKind,
                text: i.payload.text,
              },
            ]
          : [],
      ),
    };
  });
  const readContextRevisions = Effect.fn("MemoryService.readContextRevisions")(function* (
    space: M.MemorySpaceId,
    ids: ReadonlyArray<M.MemoryId>,
    permit: Permit,
  ) {
    return yield* store.transact(
      Effect.gen(function* () {
        yield* permit;
        if (ids.length > M.MEMORY_PAGE_MAX_ITEMS)
          return yield* new Store.MemoryStoreConflict({ code: "payload_too_large" });
        const items = yield* Effect.forEach(ids, (memoryId) =>
          read({ memorySpaceId: space, memoryId }, permit),
        );
        const rows = yield* query(
          sql<{
            watermark: number;
          }>`SELECT projection_watermark AS watermark FROM memory_compaction_state WHERE space=${space}`,
        );
        yield* permit;
        return {
          memorySpaceId: space,
          projectionWatermark: rows[0]?.watermark ?? 0,
          nextCursor: null,
          items: items.flatMap((i) =>
            i.status === "active" && i.localAvailability.exposure === "visible"
              ? [
                  {
                    memoryId: i.memoryId,
                    revisionId: i.revision.revisionId,
                    scope: i.scope,
                    provenance: i.revision.provenance,
                    assertionKind: i.revision.assertionKind,
                    text: i.payload.text,
                  },
                ]
              : [],
          ),
        };
      }),
    );
  });
  const sourceLocator = Effect.fn("MemoryService.sourceLocator")(function* (
    input: M.MemoryReadSourceInput,
  ) {
    const aggregate = yield* store.loadAggregate(
      input.memorySpaceId,
      input.memoryId,
      { heads: true },
      {},
    );
    if (aggregate.tombstone || aggregate.pendingForget)
      return yield* new Store.MemoryStoreConflict({ code: "forgotten" });
    if (!aggregate.item || aggregate.item.localAvailability.exposure !== "visible")
      return yield* new Store.MemoryStoreConflict({ code: "source_invalidated" });
    const thread = yield* decode(encodeSourceThread(input.sourceThread));
    for (const pair of aggregate.revisions) {
      const provenance = pair.revision.provenance;
      if (
        !aggregate.heads.includes(pair.revision.revisionId) ||
        !pair.payload ||
        !provenance.sourceThread ||
        !provenance.sourceWatermark
      )
        continue;
      if ((yield* decode(encodeSourceThread(provenance.sourceThread))) !== thread) continue;
      const evidence = new Set(
        pair.payload.evidence
          .filter(
            (value) =>
              value.origin === "thread" &&
              value.sourceThread?.environmentId === input.sourceThread.environmentId &&
              value.sourceThread.threadId === input.sourceThread.threadId &&
              value.watermark?.fromEventId === provenance.sourceWatermark?.fromEventId &&
              value.watermark?.toEventId === provenance.sourceWatermark?.toEventId &&
              value.watermark?.throughSequence === provenance.sourceWatermark?.throughSequence,
          )
          .flatMap((value) => value.messageIds),
      );
      if (input.messageIds.every((id) => evidence.has(id)))
        return {
          generation: aggregate.generation,
          sourceWatermark: provenance.sourceWatermark,
          pair,
        };
    }
    return yield* new Store.MemoryStoreConflict({ code: "source_invalidated" });
  });
  const prepareSourceRead: MemoryService["Service"]["prepareSourceRead"] = Effect.fn(
    "MemoryService.prepareSourceRead",
  )(function* (input, permit) {
    const value = yield* decode(decodeReadSource(input, strict));
    return yield* store.transact(
      Effect.gen(function* () {
        yield* permit;
        const locator = yield* sourceLocator(value);
        const encoded = yield* decode(encodeReadSource(value));
        return {
          generation: locator.generation,
          request: {
            ...value,
            protocolVersion: 1 as const,
            sourceWatermark: locator.sourceWatermark,
            requestId: M.MemorySourceReadRequestId.make(
              memoryStableUuid(`${environmentId}:${locator.generation}:${encoded}`),
            ),
            authorizedScopes: ["memory:read", "orchestration:read"] as const,
          },
        };
      }),
    );
  });
  const validateSourceOutcome: MemoryService["Service"]["validateSourceOutcome"] = Effect.fn(
    "MemoryService.validateSourceOutcome",
  )(function* (input, permit) {
    return yield* store.transact(
      Effect.gen(function* () {
        yield* permit;
        const request = yield* decode(decodeSourceRequest(input.request.request, strict));
        const outcome = yield* decode(decodeSourceOutcome(input.outcome, strict));
        // Owner denial is authoritative after the live permit, even if the locator changed.
        if (outcome.kind === "denied") return outcome;
        const { memorySpaceId, memoryId, sourceThread, messageIds, limit, cursor } = request;
        const locator = yield* sourceLocator({
          memorySpaceId,
          memoryId,
          sourceThread,
          messageIds,
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (
          locator.generation !== input.request.generation ||
          (yield* decode(encodeSourceWatermark(locator.sourceWatermark))) !==
            (yield* decode(encodeSourceWatermark(request.sourceWatermark)))
        )
          return yield* new Store.MemoryStoreConflict({ code: "source_invalidated" });
        if (outcome.kind === "available") {
          if (
            (yield* decode(encodeSourceThread(outcome.page.sourceThread))) !==
              (yield* decode(encodeSourceThread(request.sourceThread))) ||
            (yield* decode(encodeSourceWatermark(outcome.page.watermark))) !==
              (yield* decode(encodeSourceWatermark(request.sourceWatermark))) ||
            outcome.page.messages.length > request.limit ||
            outcome.page.messages.some((message) => !request.messageIds.includes(message.messageId))
          )
            return yield* new Store.MemoryStoreConflict({ code: "source_invalidated" });
          if (scanMemoryValue(outcome).kind !== "allowed")
            return { kind: "unavailable" as const, code: "secret_detected" as const };
        }
        return outcome;
      }),
    );
  });
  const readSource: MemoryService["Service"]["readSource"] = Effect.fn("MemoryService.readSource")(
    function* (input, permit, sourceThread) {
      yield* permit;
      // L5 binds Sync's existing authority seam; production remains closed without that port.
      if (!sourceReadAuthority) return yield* new MemoryAccessError({ code: "unavailable" });
      const request = yield* prepareSourceRead(input, permit);
      yield* permit;
      const outcome = yield* sourceReadAuthority(request, permit).pipe(
        Effect.catchTags({
          MemoryHubError: (error) =>
            Effect.gen(function* () {
              if (error.code === "capacity_exceeded" && error.capacity) {
                const { dimension, current, limit, reclaimable } = error.capacity;
                return yield* new Store.MemoryCapacityError({
                  dimension,
                  current,
                  limit,
                  reclaimable,
                });
              }
              return yield* new Store.MemoryStoreConflict({
                code: isFailureCode(error.code) ? error.code : "source_unavailable",
              });
            }),
        }),
      );
      yield* permit;
      return yield* store.transact(
        Effect.gen(function* () {
          const validated = yield* validateSourceOutcome({ request, outcome }, permit);
          yield* permit;
          if (validated.kind === "available") {
            if (sourceThread && validated.page.messages.length) {
              const locator = yield* sourceLocator(input);
              yield* consume(input.memorySpaceId, sourceThread, [locator.pair]);
            }
            return validated.page;
          }
          if (validated.kind === "denied")
            return yield* new MemoryAccessError({ code: "unavailable" });
          return yield* new Store.MemoryStoreConflict({ code: validated.code });
        }),
      );
    },
  );
  const admitHubOperationTx: MemoryService["Service"]["admitHubOperationTx"] = Effect.fn(
    "MemoryService.admitHubOperationTx",
  )(function* (input) {
    // These effects require the outer Store transaction and run after its SQL write lock.
    yield* input.authority.reauthorize;
    const member = yield* store.requireHubMemberTx(input.authority.principal);
    const now = yield* input.authority.now;
    const op = yield* decode(decodeOperation(input.operation, strict));
    if (
      op.memorySpaceId !== member.memorySpaceId ||
      op.originEnvironmentId !== member.environmentId
    )
      return yield* new M.MemoryHubForbiddenError({});
    const digest = memoryOperationDigest(op);
    const replay = yield* store.readHubReceiptTx(op.memorySpaceId, op.operationId);
    if (replay) {
      if (replay.entry.receipt.operationDigest !== digest)
        return yield* new Store.MemoryStoreConflict({ code: "operation_id_reused" });
      return replay.entry.receipt;
    }
    // Resolve recomputes lineage from its input payloads; the decider needs heads and restored.
    const current = yield* store.loadAggregate(
      op.memorySpaceId,
      op.memoryId,
      op.kind === "forget"
        ? {}
        : {
            heads: true,
            revisionIds:
              op.kind === "resolve"
                ? op.expectedHeads
                : op.kind === "revert"
                  ? [op.restoredRevisionId]
                  : [],
          },
      op.kind === "forget"
        ? {}
        : {
            ...(op.kind === "revert" ? { resolutionId: op.revertsResolutionId } : {}),
            revision: op.revision,
            ...(op.kind === "resolve"
              ? { metadataRevisionIds: op.resolution.inputRevisionIds }
              : {}),
          },
    );
    // Only the read-only semantic decision is caught; every subsequent write can fail the outer transaction.
    const prepared = yield* Effect.gen(function* () {
      yield* requireImportNotSuppressed(op);
      if (op.kind !== "forget" && current.pendingForget)
        return yield* new Store.MemoryStoreConflict({ code: "forget_pending" });
      let approval: M.MemoryResolutionApproval | undefined;
      if (op.kind === "resolve") {
        if (!input.resolutionRequest)
          return yield* new M.MemoryHubError({ code: "lease_required" });
        const request = yield* decode(decodeResolutionRequest(input.resolutionRequest, strict));
        const lease = current.fence?.activeLease;
        if (
          request.memorySpaceId !== op.memorySpaceId ||
          request.holderEnvironmentId !== member.environmentId ||
          M.encodeMemoryOperation(request.operation) !== M.encodeMemoryOperation(op)
        )
          return yield* new M.MemoryHubError({ code: "identity_mismatch" });
        if (!lease) return yield* new M.MemoryHubError({ code: "lease_required" });
        if (
          lease.attemptId !== request.attemptId ||
          lease.holderEnvironmentId !== member.environmentId ||
          lease.fencingToken !== op.fencingToken ||
          current.fence?.highestFencingToken !== op.fencingToken
        )
          return yield* new M.MemoryHubError({ code: "fenced" });
        if (
          Date.parse(lease.expiresAtHubTime) <= now ||
          Date.parse(lease.attemptDeadlineHubTime) <= now
        )
          return yield* new M.MemoryHubError({ code: "lease_expired" });
        if (
          encodeSelection(lease.frozenDefaultModelSelection) !==
            encodeSelection(op.resolution.requestedModelSelection) ||
          op.resolution.resolvingEnvironmentId !== member.environmentId
        )
          return yield* new M.MemoryHubError({ code: "identity_mismatch" });
        const inputs = current.revisions.filter((pair) =>
          op.expectedHeads.includes(pair.revision.revisionId),
        );
        if (inputs.length !== op.expectedHeads.length || inputs.some((pair) => !pair.payload))
          return yield* new Store.MemoryStoreConflict({ code: "missing_parent" });
        const inherited = inputs.flatMap((pair) => pair.payload!.derivedFromMemoryRevisions);
        const dependencies = [...new Set([...op.expectedHeads, ...inherited])];
        // Recompute from authoritative payloads inside the admission transaction. A
        // member may neither omit inherited lineage nor race an external forget.
        const payload = yield* decode(
          decodeSummaryPayload({ ...op.payload, derivedFromMemoryRevisions: dependencies }, strict),
        );
        if (
          encodeHeads([...op.payload.derivedFromMemoryRevisions].sort()) !==
          encodeHeads([...dependencies].sort())
        )
          return yield* invalid();
        yield* validateSummaryDependencies(
          op.memorySpaceId,
          {
            ...payload,
            derivedFromMemoryRevisions: inherited.filter((id) => !op.expectedHeads.includes(id)),
          },
          { memoryId: op.memoryId, revisions: dependencies },
        ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
        const iso = (value: number) =>
          M.MemoryUtcTimestamp.make(DateTime.formatIso(DateTime.makeUnsafe(value)));
        approval = {
          resolutionId: op.resolution.resolutionId,
          appliedAtUtc: iso(now),
          revertDeadlineUtc: iso(now + M.MEMORY_REVERT_WINDOW_MS),
        };
      } else if (input.resolutionRequest)
        return yield* new M.MemoryHubError({ code: "identity_mismatch" });
      if (op.kind !== "forget") {
        const normalized = yield* normalizeMemoryDependencies(
          op.memorySpaceId,
          op.payload,
          op.kind === "resolve",
          op.kind === "resolve" ? op.payload.derivedFromMemoryRevisions : [],
          op.kind === "resolve" ? op.memoryId : undefined,
        ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
        // The member signs the operation digest. Never rewrite its payload under that ID.
        if (
          encodeHeads([...normalized.derivedFromMemoryRevisions].sort()) !==
          encodeHeads([...op.payload.derivedFromMemoryRevisions].sort())
        )
          return yield* invalid();
      }
      const ancestry =
        op.kind === "forget"
          ? undefined
          : yield* store.readAncestry(op.memorySpaceId, op.memoryId, op.revision.parents);
      const decision = yield* Effect.try({
        try: () =>
          decideMemoryOperation(
            current,
            op,
            Store.hubAdmission,
            scanMemoryValue(op),
            undefined,
            ancestry,
            now,
          ),
        catch: (cause) => (isConflict(cause) ? cause : invalid()),
      });
      return { kind: "decision" as const, decision, approval };
    }).pipe(
      Effect.catchTags({
        MemoryHubError: (error) =>
          Effect.succeed({ kind: "refusal" as const, failureCode: error.code }),
        MemoryStoreConflict: (error) =>
          Effect.succeed({ kind: "refusal" as const, failureCode: error.code }),
      }),
    );
    if (prepared.kind === "refusal") {
      if (prepared.failureCode === "capacity_exceeded")
        return yield* new Store.MemoryStoreConflict({ code: "capacity_exceeded" });
      const ledger = yield* store.appendHubEntryTx({
        operation: op,
        operationDigest: digest,
        outcome: "rejected",
        failureCode: prepared.failureCode,
        now,
      });
      yield* settleHubEntryTx({
        memorySpaceId: op.memorySpaceId,
        hubEnvironmentId: environmentId,
        localEnvironmentId: environmentId,
        entry: ledger.entry,
      });
      return ledger.entry.receipt;
    }
    const { decision, approval } = prepared;
    return yield* quota.withAdmission(
      { operation: op, admission: Store.hubAdmission, environmentId, receipt: decision.receipt },
      Effect.gen(function* () {
        const ledger = yield* store.appendHubEntryTx({
          operation: op,
          operationDigest: digest,
          outcome: decision.receipt.outcome === "noop" ? "accepted" : decision.receipt.outcome,
          ...(approval ? { resolutionApproval: approval } : {}),
          now,
        });
        yield* store.apply({
          ...decision,
          receipt: ledger.entry.receipt,
          ...(op.kind === "resolve"
            ? {
                execution: {
                  requestedModelSelection: op.resolution.requestedModelSelection,
                  effectiveProvider: op.resolution.effectiveProvider,
                  effectiveModel: op.resolution.effectiveModel,
                  providerInstanceId: op.resolution.requestedModelSelection.instanceId,
                  environmentId: member.environmentId,
                },
              }
            : {}),
        });
        if (current.fence?.activeLease)
          yield* store.transitionHubLeaseTx({
            authority: input.authority,
            action: {
              kind: "invalidate",
              memoryId: op.memoryId,
              expectedToken: current.fence.highestFencingToken,
              reason: op.kind === "forget" ? "forget" : "heads",
            },
          });
        // Hub-local work receives the same terminal settlement as an ACK or pulled entry.
        yield* settleHubEntryTx({
          memorySpaceId: op.memorySpaceId,
          hubEnvironmentId: environmentId,
          localEnvironmentId: environmentId,
          entry: ledger.entry,
        });
        return ledger.entry.receipt;
      }),
    );
  });
  // Transport entry: owns the rollback boundary. Tx callers must propagate capacity failures.
  const admitHubOperation: MemoryService["Service"]["admitHubOperation"] = (input) =>
    store.transact(admitHubOperationTx(input), { requireOuter: true }).pipe(
      Effect.catchTags({
        MemoryCapacityError: (error) =>
          store.transact(
            Effect.gen(function* () {
              // The failed append/apply has rolled back before this separate authorization/replay read.
              yield* input.authority.reauthorize;
              const member = yield* store.requireHubMemberTx(input.authority.principal);
              if (
                input.operation.memorySpaceId !== member.memorySpaceId ||
                input.operation.originEnvironmentId !== member.environmentId
              )
                return yield* new M.MemoryHubForbiddenError({});
              const digest = memoryOperationDigest(input.operation);
              const replay = yield* store.readHubReceiptTx(
                input.operation.memorySpaceId,
                input.operation.operationId,
              );
              if (replay) {
                if (replay.entry.receipt.operationDigest !== digest)
                  return yield* new Store.MemoryStoreConflict({ code: "operation_id_reused" });
                return replay.entry.receipt;
              }
              return yield* decode(
                decodeHubReceipt(
                  {
                    operationId: input.operation.operationId,
                    memoryId: input.operation.memoryId,
                    operationDigest: digest,
                    outcome: "rejected" as const,
                    hubSequence: null,
                    failureCode: "capacity_exceeded" as const,
                    capacity: {
                      code: "capacity_exceeded" as const,
                      dimension: error.dimension,
                      current: error.current ?? error.limit,
                      limit: error.limit,
                      reclaimable: 0,
                    },
                  },
                  strict,
                ),
              );
            }),
          ),
      }),
    );
  const settleHubEntryTx: MemoryService["Service"]["settleHubEntryTx"] = Effect.fn(
    "MemoryService.settleHubEntryTx",
  )(function* (input) {
    const entry = yield* decode(decodeHubEntry(input.entry, strict));
    if (
      entry.kind === "operation" &&
      (entry.operation.memorySpaceId !== input.memorySpaceId ||
        memoryOperationDigest(entry.operation) !== entry.receipt.operationDigest)
    )
      return yield* invalid();
    const old = yield* store.receipt(input.memorySpaceId, entry.receipt.operationId);
    if (old && old.operationDigest !== entry.receipt.operationDigest)
      return yield* new Store.MemoryStoreConflict({ code: "operation_id_reused" });
    if (
      old &&
      "hubSequence" in old.receipt &&
      old.receipt.hubSequence !== null &&
      (yield* decode(encodeHubReceipt(old.receipt))) !==
        (yield* decode(
          encodeHubReceipt({
            ...entry.receipt,
            ...(old.receipt.forgetExpansion
              ? { forgetExpansion: old.receipt.forgetExpansion }
              : {}),
            ...(old.receipt.forgetRetryOf ? { forgetRetryOf: old.receipt.forgetRetryOf } : {}),
          }),
        ))
    )
      return yield* new Store.MemoryStoreConflict({ code: "identity_mismatch" });
    const incorporated =
      entry.receipt.outcome !== "rejected" &&
      (!old || !("hubSequence" in old.receipt) || old.receipt.hubSequence === null);
    if (entry.kind === "operation")
      yield* apply(entry.operation, Store.approvedReplica, Effect.void, entry.receipt);
    else yield* store.settleMetadataEntryTx({ memorySpaceId: input.memorySpaceId, entry });
    if (entry.kind === "metadata" && entry.compactReceipt)
      yield* store.reconcileResolutionReportTx({
        record: entry.compactReceipt,
        localEnvironmentId: input.localEnvironmentId,
      });
    const workId = input.workId ?? `sync:${input.memorySpaceId}:${entry.receipt.operationId}`;
    const work =
      (yield* store.readWork(workId)) ??
      (input.workId
        ? undefined
        : yield* store.readWork(`revert:${input.memorySpaceId}:${entry.receipt.operationId}`));
    if (
      work &&
      "operationId" in work.metadata &&
      work.metadata.operationId === entry.receipt.operationId
    )
      yield* store.acknowledgeOutbox(work.id, entry.receipt);
    return {
      receipt: entry.receipt,
      incorporated,
      intent:
        work?.kind === "revert_intent"
          ? entry.receipt.outcome === "rejected"
            ? "rejected"
            : "completed"
          : "none",
    };
  });
  const receiveHubPage: MemoryService["Service"]["receiveHubPage"] = Effect.fn(
    "MemoryService.receiveHubPage",
  )(function* (input) {
    const page = yield* decode(decodeHubPage(input.page, strict));
    if (page.checkpoint)
      return yield* new Store.MemoryStoreConflict({ code: "bootstrap_required" });
    let previous = input.expectedSequence;
    for (const entry of page.entries) {
      if (entry.hubSequence <= previous || entry.hubSequence > page.throughSequence)
        return yield* new Store.MemoryStoreConflict({ code: "invalid_cursor" });
      previous = entry.hubSequence;
    }
    if (previous !== page.throughSequence || page.throughSequence < input.expectedSequence)
      return yield* new Store.MemoryStoreConflict({ code: "invalid_cursor" });
    return yield* store.transact(
      Effect.gen(function* () {
        yield* input.reauthorize;
        const current = yield* store.readCursor(input.memorySpaceId, input.hubEnvironmentId);
        if (current >= page.throughSequence) return [];
        return yield* store.withReceivedCursor(
          {
            memorySpaceId: input.memorySpaceId,
            hubEnvironmentId: input.hubEnvironmentId,
            expectedSequence: input.expectedSequence,
            afterSequence: page.throughSequence,
          },
          Effect.forEach(page.entries, (entry) => settleHubEntryTx({ ...input, entry })),
        );
      }),
    );
  });
  const reconcileResolutionSubmission: MemoryService["Service"]["reconcileResolutionSubmission"] =
    Effect.fn("MemoryService.reconcileResolutionSubmission")(function* (input) {
      return yield* store.transact(
        Effect.gen(function* () {
          yield* input.reauthorize;
          const result = yield* store.reconcileResolutionSubmissionTx(input);
          if (!result || result.outcome !== "admitted") return result;
          const operation = result.row.submission!.operation;
          yield* settleHubEntryTx({
            memorySpaceId: input.ownership.memorySpaceId,
            hubEnvironmentId: input.hubEnvironmentId,
            localEnvironmentId: input.localEnvironmentId,
            entry: {
              kind: "operation",
              operation,
              receipt: result.receipt,
              hubSequence: result.receipt.hubSequence!,
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
          receipt.operationDigest !== input.operation.operationDigest ||
          work.memoryId !== receipt.memoryId
        )
          return yield* new Store.MemoryStoreConflict({ code: "identity_mismatch" });
        const stored = yield* store.receipt(input.memorySpaceId, input.operation.operationId);
        const operation = yield* store.readWorkOperation(input.workId);
        if (
          (stored && stored.operationDigest !== input.operation.operationDigest) ||
          (operation && memoryOperationDigest(operation) !== input.operation.operationDigest)
        )
          return yield* new Store.MemoryStoreConflict({ code: "operation_id_reused" });
        if (!stored && !operation)
          return yield* new Store.MemoryStoreConflict({ code: "identity_mismatch" });
        if (receipt.hubSequence === null) {
          if (receipt.outcome !== "rejected") return yield* invalid();
          yield* store.acknowledgeOutbox(input.workId, receipt);
          return {
            receipt,
            incorporated: false,
            intent: work.kind === "revert_intent" ? ("rejected" as const) : ("none" as const),
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
  return MemoryService.of({
    importPorts,
    importProvider: (input, permit) =>
      Effect.gen(function* () {
        yield* permit;
        return yield* (yield* ProviderMemoryImportRuntime).run(input, permit);
      }),
    commitLocalIntent,
    readSource,
    prepareSourceRead,
    validateSourceOutcome,
    admitHubOperation,
    admitHubOperationTx,
    settleHubEntryTx,
    receiveHubPage,
    reconcileResolutionSubmission,
    settleHubAcknowledgement,
    getProjectBinding,
    updateProjectBinding,
    resolveProjectKey,
    changes,
    upsert,
    forget,
    retryForgetExpansion,
    revertResolution,
    read,
    list,
    search,
    history,
    commitSummary,
    queueSummary,
    reconnectParked,
    applyReceived: (op, receipt) => apply(op, Store.approvedReplica, Effect.void, receipt),
    commitAcceptedResolution: (op, receipt) =>
      apply(op, Store.approvedReplica, Effect.void, receipt),
    queueResolution: store.persistResolutionTicket,
    recoverWork: store.dueWork,
    resetReportAttempts,
    readReportTarget: store.readReportTarget,
    nextReportWakeAt: (now) => store.nextReportWakeAt(now, environmentId),
    acquireReports: (input) =>
      input.owner === environmentId ? store.acquireReports(input) : Effect.succeed([]),
    acknowledgeClaimedReport: (input) =>
      input.owner === environmentId ? store.acknowledgeClaimedReport(input) : Effect.succeed(false),
    deferClaimedReport: (input) =>
      input.owner === environmentId ? store.deferClaimedReport(input) : Effect.succeed(false),
    normalizeExpiredReports: (now) => store.normalizeExpiredReports(now, environmentId),
    purgeDeliveredReportDetails: (input) =>
      store.transact(store.purgeDeliveredReportDetailsTx({ ...input, environmentId })),
    nextReportMaintenanceAt: store.nextReportMaintenanceAt(environmentId),
    pendingReports: store.pendingReports,
    claimReport: store.claimReport,
    acknowledgeReport: store.acknowledgeReport,
    failReport: store.failReport,
    readContextCandidates,
    readContextRevisions,
  });
});
export const layer = Layer.effect(MemoryService, make());
/** Bind an application-owned callback, without importing Sync or constructing a cyclic layer. */
export const layerWithSourceReadAuthority = (authority: MemorySourceReadAuthority["readSource"]) =>
  Layer.effect(MemoryService, make(authority));
