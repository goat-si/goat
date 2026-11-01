import type * as M from "@goat/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Hub from "../MemoryHubService.ts";
import type { MemoryAccessError, MemoryServiceError } from "../MemoryService.ts";
import type * as Store from "../MemoryStore.ts";

export type Permit = Effect.Effect<void, MemoryAccessError, never>;
export type SyncError = Hub.MemoryHubServiceError;
export type ImportError = MemoryServiceError | M.MemoryImportRpcError | M.MemoryRpcError;
export type ImportAddress = {
  readonly memorySpaceId: M.MemorySpaceId;
  readonly environmentId: M.EnvironmentId;
};
export type ImportSourceAddress = ImportAddress & { readonly sourceId: M.MemoryImportSourceId };
export type ImportBatchAddress = ImportAddress & { readonly operationId: M.MemoryOperationId };
/** Logical server slot, never a caller-supplied absolute path. */
export type ImportSlot = {
  readonly format: M.MemoryImportSourceFormat;
  readonly rootSlot: string;
  readonly selection: string | null;
};
/**
 * Revision provenance travels over hub protocol v1, whose peers decode `MemoryImportFormat`
 * strictly. Aside imports record the closest legacy family, a Markdown memory repository;
 * `parserVersion` (aside-semantic-v1) and the `aside/…` source locator still name the source.
 */
export const provenanceImportFormat = (format: M.MemoryImportSourceFormat): M.MemoryImportFormat =>
  format === "aside" ? "omo" : format;
export type ImportRegistrationLookup = ImportAddress &
  (
    | { readonly by: "source"; readonly sourceId: M.MemoryImportSourceId }
    | { readonly by: "slot"; readonly slot: ImportSlot }
  );
export type ImportSelector = Extract<
  M.MemoryImportProviderInput,
  { action: "apply" }
>["items"][number];
/** Bounded UTF-8 text after descriptor checks; ephemeral and never persisted. */
export type ImportSourceFile = {
  readonly selector: string;
  readonly text: string;
  readonly byteCount: number;
  /**
   * Per-file refusal from a reader that reports instead of failing the snapshot (Aside only).
   * `text` is empty and `byteCount` is the on-disk size.
   */
  readonly issue?: M.MemoryImportIssue;
};
export type ImportSnapshot = {
  readonly slot: ImportSlot;
  readonly format: M.MemoryImportSourceFormat;
  readonly parserVersion: string;
  readonly profile: string;
  readonly sourceLocator: string;
  readonly snapshotDigest: string;
  readonly files: readonly ImportSourceFile[];
  readonly commitOid?: string;
};
export type ImportDiscoveredSlot = {
  readonly slot: ImportSlot;
  readonly parserVersion: string;
  readonly profile: string;
  readonly sourceLocator: string;
  readonly label: string;
};
/** Acquisition/cleanup belong to L2/L5 Scope; every returned operation is closed (R=never). */
export type MemoryImportReaderShape = {
  readonly discover: (input: {
    readonly format: M.MemoryImportSourceFormat;
  }) => Effect.Effect<readonly ImportDiscoveredSlot[], M.MemoryImportRpcError, never>;
  readonly read: (input: {
    readonly slot: ImportSlot;
  }) => Effect.Effect<ImportSnapshot, M.MemoryImportRpcError, never>;
};
/** Source fingerprint includes parser version and canonical allowlisted metadata; content is NFC/LF/trim. */
export type ImportCandidate = {
  readonly sourceItemKey: string;
  readonly sourceFingerprint: string;
  readonly contentFingerprint: string;
  readonly title?: string;
  /** Parser emits evidence=[]; L4 attaches import evidence before preparing commit. */
  readonly payload: M.MemoryPayload;
  readonly byteCount: number;
  /** Apply refuses any scope other than an explicit project binding. */
  readonly requiresProject?: boolean;
};
export type ImportParsedItem =
  | { readonly kind: "candidate"; readonly candidate: ImportCandidate }
  | {
      readonly kind: "rejected";
      readonly sourceItemKey: string;
      readonly byteCount: number;
      readonly issue: M.MemoryImportIssue;
      readonly requiresProject?: boolean;
    };
/** Pure: no filesystem, SQL, clock, randomness or model calls. Unsafe keys fail the whole file. */
export type MemoryImportParser = (
  input: ImportSnapshot,
) => Effect.Effect<readonly ImportParsedItem[], M.MemoryImportRpcError, never>;
export type MemoryImportParsers = {
  readonly [F in M.MemoryImportSourceFormat]: MemoryImportParser;
};

export type ImportSession = {
  readonly sessionId: string;
  readonly parserVersion: string;
  readonly profile: string;
  readonly snapshotDigest: string;
  readonly createdAtUtc: typeof M.MemoryUtcTimestamp.Type;
  readonly expiresAtUtc: typeof M.MemoryUtcTimestamp.Type;
  readonly newItems: number;
  readonly bodyBytes: number;
  /** Accepted charges survive exact chunk retries and cannot be reset by preview. */
  readonly applied: readonly {
    readonly sourceItemKey: string;
    readonly sourceFingerprint: string;
    readonly bodyBytes: number;
  }[];
};
/** Private versioned registration_json envelope. No source bytes or provider absolute roots. */
export type ImportRegistration = ImportSourceAddress & {
  readonly codecVersion: 1;
  readonly version: number;
  readonly slot: ImportSlot;
  readonly source: M.MemoryImportSource;
  readonly sourceLocator: string;
  readonly session: ImportSession | null;
};
export type ImportFrozenSelection = {
  /** Body-free settlement link, captured by the Store when this selection commits. */
  readonly observation?: NonNullable<ImportItem["pending"]>;
  readonly settled?: boolean;
  readonly selector: ImportSelector;
  readonly memoryId: M.MemoryId;
  readonly operationId: M.MemoryOperationId;
  readonly revisionId: M.MemoryRevisionId;
  readonly result: M.MemoryImportItemResult | null;
};
/** Strict completed_items_json envelope: immutable IDs/digest, remaining selectors, no body. */
export type ImportBatch = ImportBatchAddress & {
  readonly kind: "detailed";
  readonly codecVersion: 1;
  readonly selectionDigest: string;
  readonly sourceId: M.MemoryImportSourceId;
  readonly sessionId: string;
  readonly selections: readonly ImportFrozenSelection[];
  readonly receipt: M.MemoryImportReceipt;
  readonly createdAtUtc: typeof M.MemoryUtcTimestamp.Type;
};
export type ImportRetiredBatchGuard = {
  readonly kind: "retired";
  readonly codecVersion: 1;
  readonly selectionDigest: string;
};
export type ImportItem = ImportSourceAddress & {
  readonly codecVersion: 1;
  readonly sourceItemKey: string;
  readonly scope: M.MemoryScope;
  readonly memoryId: M.MemoryId;
  readonly accepted: {
    readonly sourceFingerprint: string;
    readonly contentFingerprint: string;
    readonly revisionId: M.MemoryRevisionId;
    readonly operationId: M.MemoryOperationId;
  } | null;
  readonly pending: {
    readonly sourceFingerprint: string;
    readonly contentFingerprint: string;
    readonly revisionId: M.MemoryRevisionId;
    readonly operationId: M.MemoryOperationId;
  } | null;
  readonly rejected: {
    readonly sourceFingerprint: string;
    readonly issue: M.MemoryImportIssue;
  } | null;
  readonly outcome: M.MemoryImportOutcome;
};
export type ImportMatch =
  | { readonly kind: "none" }
  | { readonly kind: "source_suppressed"; readonly memoryId: M.MemoryId }
  | { readonly kind: "content_suppressed"; readonly memoryId: M.MemoryId }
  | { readonly kind: "pending_forget"; readonly memoryId: M.MemoryId }
  | {
      readonly kind: "live";
      readonly memoryId: M.MemoryId;
      readonly revision: M.MemoryRevision;
      readonly payload: M.MemoryPayload;
    };
/** Captured under the writer lock; commit rechecks heads, binding and previous independently. */
export type ImportTarget = {
  readonly identity: M.MemoryIdentityRecord | null;
  readonly heads: readonly M.MemoryRevisionId[];
  readonly forgotten: boolean;
  readonly pendingForget: boolean;
  readonly acceptedParent: Store.MemoryParentState | null;
  /** Only an active single head with a canonical hub approval can be an alias parent. */
  readonly alias: { readonly revision: M.MemoryRevision; readonly payload: M.MemoryPayload } | null;
};
export type ImportBatchPreflight =
  | { readonly kind: "new" }
  | {
      readonly kind: "partial";
      readonly batch: ImportBatch;
      readonly receipt: M.MemoryImportReceipt;
    }
  | { readonly kind: "completed"; readonly receipt: M.MemoryImportReceipt }
  | { readonly kind: "retired" };
export type LocalImportReadiness = {
  readonly memorySpaceId: M.MemorySpaceId | null;
  readonly bootstrap: "unbound" | "staging" | "ready";
};
/** Bounded candidate and captured CAS/parent fences, never a Reader or raw file handle. */
export type PreparedImportCommit = {
  /** Batch-only rejection: preserve previous exactly, or leave a new identity unallocated (next rejected, no observations). */
  readonly rejectOnly?: {
    readonly issue: M.MemoryImportIssue;
    readonly capacity?: M.MemoryCapacityExceeded;
  };
  readonly registrationVersion: number;
  readonly registration: ImportRegistration;
  readonly batch: ImportBatch;
  readonly selection: ImportFrozenSelection;
  readonly candidate: ImportCandidate;
  readonly previous: ImportItem | null;
  readonly next: ImportItem;
  readonly expectedHeads: readonly M.MemoryRevisionId[];
  readonly parents: readonly M.MemoryRevisionId[];
  readonly projectBinding: M.MemoryProjectBinding | null;
};
export type ImportPorts = {
  readonly readRegistration: (
    input: ImportRegistrationLookup,
    permit: Permit,
  ) => Effect.Effect<ImportRegistration | undefined, MemoryServiceError, never>;
  readonly saveRegistration: (
    input: ImportAddress & { next: ImportRegistration; expectedVersion: number | null },
    permit: Permit,
  ) => Effect.Effect<ImportRegistration, MemoryServiceError, never>;
  readonly preflightBatch: (
    input: ImportBatchAddress & { selectionDigest: string },
    permit: Permit,
  ) => Effect.Effect<ImportBatchPreflight, MemoryServiceError | M.MemoryImportRpcError, never>;
  readonly readReceipt: (
    input: ImportBatchAddress,
    permit: Permit,
  ) => Effect.Effect<M.MemoryImportReceipt, MemoryServiceError | M.MemoryRpcError, never>;
  readonly readItem: (
    input: ImportSourceAddress & { sourceItemKey: string },
    permit: Permit,
  ) => Effect.Effect<ImportItem | undefined, MemoryServiceError, never>;
  readonly findMatch: (
    input: ImportAddress & { source: M.MemorySourceKey; content: M.MemoryContentSuppression },
    permit: Permit,
  ) => Effect.Effect<ImportMatch, MemoryServiceError, never>;
  readonly prepareTarget: (
    input: ImportAddress & {
      readonly memoryId: M.MemoryId;
      readonly scope: M.MemoryScope;
      readonly acceptedRevisionId: M.MemoryRevisionId | null;
    },
    permit: Permit,
  ) => Effect.Effect<ImportTarget, MemoryServiceError, never>;
  readonly binding: (
    input: M.MemoryProjectBindingGetInput,
    permit: Permit,
  ) => Effect.Effect<M.MemoryProjectBinding, MemoryServiceError, never>;
  readonly resolveProjectKey: (
    space: M.MemorySpaceId,
    project: M.ScopedProjectRef,
  ) => Effect.Effect<M.MemoryProjectKey | null, MemoryServiceError, never>;
  readonly commit: (
    input: PreparedImportCommit,
    permit: Permit,
  ) => Effect.Effect<M.MemoryImportItemResult, MemoryServiceError, never>;
  readonly readiness: () => Effect.Effect<LocalImportReadiness, SyncError, never>;
  readonly requireBootstrap: (space: M.MemorySpaceId) => Effect.Effect<void, SyncError, never>;
  readonly syncStatus: (
    input: M.MemorySyncStatusInput,
    permit: Permit,
  ) => Effect.Effect<M.MemorySyncStatus, SyncError, never>;
};
export type ImportPrimitives = {
  readonly uuid: () => string;
  readonly now: () => Effect.Effect<number, never, never>;
  readonly environmentId: M.EnvironmentId;
};
export type ImportRuntimeShape = {
  readonly run: (
    input: M.MemoryImportProviderInput,
    permit: Permit,
  ) => Effect.Effect<M.MemoryImportProviderResult, ImportError, never>;
};
/** Invocation environment only. Service construction must not acquire this tag or Sync. */
export class ProviderMemoryImportRuntime extends Context.Service<
  ProviderMemoryImportRuntime,
  ImportRuntimeShape
>()("goat/memory/imports/MemoryImportTypes/ProviderMemoryImportRuntime") {}
/** L4 implements this signature; L5 binds the existing Service/Sync instances once. */
export type MakeProviderMemoryImport = (
  ports: ImportPorts,
  reader: MemoryImportReaderShape,
  parsers: MemoryImportParsers,
  primitives: ImportPrimitives,
) => ImportRuntimeShape;
export type ImportProviderFacade = (
  input: M.MemoryImportProviderInput,
  permit: Permit,
) => Effect.Effect<M.MemoryImportProviderResult, ImportError, ProviderMemoryImportRuntime>;

export type ImportInTx<A> = Store.InTx<
  A,
  Store.MemoryStorageError | Store.MemoryStoreConflict | Store.MemoryCapacityError
>;
/** Same Store.Transaction journal; Service discharges it with requireOuter and permit after lock. */
export type ImportStorePorts = {
  readonly readImportRegistrationTx: (
    input: ImportRegistrationLookup,
  ) => ImportInTx<ImportRegistration | undefined>;
  readonly writeImportRegistrationTx: (
    input: ImportAddress & { next: ImportRegistration; expectedVersion: number | null },
  ) => ImportInTx<ImportRegistration>;
  readonly readImportBatchTx: (
    input: ImportBatchAddress,
  ) => ImportInTx<
    | ImportBatch
    | (typeof Store.ImportCompletedNoopCodec.Type & { readonly receipt: M.MemoryImportReceipt })
    | ImportRetiredBatchGuard
    | undefined
  >;
  readonly readImportReceiptTx: (
    input: ImportBatchAddress,
  ) => ImportInTx<M.MemoryImportReceipt | undefined>;
  readonly readImportItemTx: (
    input: ImportSourceAddress & { sourceItemKey: string },
  ) => ImportInTx<ImportItem | undefined>;
  readonly findImportMatchTx: (
    input: ImportAddress & { source: M.MemorySourceKey; content: M.MemoryContentSuppression },
  ) => ImportInTx<ImportMatch>;
  readonly commitImportItemTx: (input: {
    registrationVersion: number;
    batch: ImportBatch;
    previous: ImportItem | null;
    next: ImportItem;
    preserveItem?: boolean;
    contentFingerprint: string;
    commitIntent: Effect.Effect<void, MemoryServiceError, Store.Transaction>;
  }) => Store.InTx<M.MemoryImportItemResult, MemoryServiceError>;
};
