# 030 — WP3: hub synchronization and conflict leases (rev 11b)

Committed GOAT memories converge through one configured hub. Every environment, including
the hub, writes on equal terms. Conflicts quarantine only the affected memory; the first
successful hub claimant resolves it using that environment's frozen default provider and
applies the approved result immediately. Forget propagates before pending content is sent.

- Date: 2026-10-14. Status: current P correction plan after reflection r2 MISALIGNED (G-4 Medium) and audit r2 FAIL
  (A2 #1 High, #2 Medium) on `dbf5c77bc`; r1 and r2 findings are folded below. Repeat reflection and independent A
  remain coordinator work; implementation and runtime closure are not claimed.
- Baseline: branch `goat/memory-wp3-hub-sync`, integrated WP2 HEAD `637b30327`
  (`637b3032772c50b7d3bc1d53f4ef90387768358a`); dev `637a98351` (#171) is an ancestor.
  WP2 includes `115eeed2b` and `637b30327`. Recheck the baseline before implementation.
- Authority: [000 decisions](000_plan.md#decisions-main-dispositions-of-m1-m20),
  [Shared names](000_plan.md#shared-names-all-phase-docs-must-use-these) and
  [Enforcement inventory](000_plan.md#enforcement-inventory). M1–M20 govern this plan.
  [001](001_architect_proposal.md) supplies rationale; amended decisions take precedence.
- Inputs: [WP1](010_wp1_contracts.md), [WP2](020_wp2_store_service.md),
  [WP4](040_wp4_mcp_injection.md). Wire schemas remain WP1-owned.

## 1. Scope, loop spec and completion

Archetype: satisfy-spec. Trigger: WP3 stale-check/runtime-port mismatch against implemented
WP2. Goal: an executable hub-sync plan and then one WP3 implementation PR on WP2.
Non-goals: live hub configuration, live/provider data writes, automatic hub election,
split-brain failover, team sharing, cross-space migration, semantic merging of different IDs,
provider cloud launch/resume changes, client UI and WP4 RPC/MCP activation.
Verifier: this rewrite uses only the two-file formatting check, manual links/anchors and
`git diff --check`; implementation focused behavior tests run in PR CI only (NOT RUN here).
Stop for this authoring slice: commit the two requested plans once without pushing, then
hand rev 11b to the coordinator for repeat reflection and independent A. Memory artifact: this file and the
[WP3 cycle](000_plan.md#wp3-cycle-hub-sync). Terminal outcomes: READY_FOR_REVIEW or
BLOCKED on a concrete unresolved interface/requirement. Escalation: source changes that
invalidate frozen interfaces or require a product decision go to the coordinator before lanes
start. This bounded planner does not launch another cycle, perform reflection or enter A/B.

WP3 implements M6–M9 and sync portions of M1/M2/M5/M10/M11/M14/M16/M18/M19/M20.
Jun selected juns-macbook-pro for the first deployment; this is a settings value, never a
hostname/origin/identity assumption. All six providers participate from first release:
Codex, Claude, Cursor, Grok, OpenCode v1/v2 and Antigravity. Use existing TextGeneration
one-shot runners; unavailable selection produces a typed failure, no provider/model fallback.

Implementation completion needs exact-head focused PR CI, independent code review and
integrated H/A/B scenarios. Requirement 7/M19 additionally needs actual packaged backend
execution off-host from the same SHA; a desktop build is insufficient. Source-runtime and
packaged-runtime evidence are distinct. WP2 D is incomplete (code review r5 and CI in progress).
This plan does not promote WP2 to D or any new case to PASS/CLOSED.

## 2. Current source evidence

Every source path:line below refers to integrated `637b30327`, unless explicitly marked dev.
These are observed source interfaces/behavior, not execution evidence. Line numbers must be
refreshed after source changes. `S/` means `apps/server/src/`; `C/` means `packages/contracts/src/`.

| Anchor                                                                                                                               | Current behavior and WP3 consequence                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `S/memory/MemoryService.ts:98–106,317–338,1035–1037`                                                                                 | Receive and accepted-resolution accept operation + receipt. Internal apply returns an existing same-ID receipt; a dedicated settlement seam must reconcile local receipt promotion and incorporation. No public hub admission or source reader. |
| `S/memory/MemoryStore.ts:427–477,529–538,694–735`                                                                                    | Transaction, cursor, outbox, checkpoint/materialization and candidate/ticket ports exist; hub production, metadata ingestion and registry ownership do not.                                                                                     |
| `S/memory/MemoryStore.ts:886–912`                                                                                                    | transact reuses its transaction journal when nested and otherwise serializes one SQL transaction; post-commit publication is shared. Explicit Tx ports below use this owner.                                                                    |
| `S/memory/MemoryDecider.ts:115–136`                                                                                                  | Current non-replica expected-head check also affects hubAdmission; local CAS must be separated from valid concurrent-branch hub admission. Resolve reads canonical identity fence activeLease.                                                  |
| `S/memory/MemoryStore.ts:1328–1415,1678–1681,1966–2015`                                                                              | Purge preserves forget sync work; accepted resolve/revert creates report rows on receivers; ACK updates receipt/work, not compensation incorporation.                                                                                           |
| `S/memory/MemoryStore.ts:3243–3381,3506–3517,3831–3865`                                                                              | Replica staging/install, published compaction-state readiness, stable first materialization and compact receipt/prune exist; no hub producer/token manager.                                                                                     |
| `S/memory/MemoryWorker.ts:375–395,569,616–617`                                                                                       | Generic execution accepts summary/consolidate/rebuild only; summary renewWork precedes each provider call and expiry follows retryWork backoff. Preserve this behavior and invalid-summary regeneration.                                        |
| `S/memory/MemoryQuotaService.ts:12–40,588–627`; `S/memory/MemoryStore.ts:2773–2791,3705–3754`; `S/memory/MemoryFtsMaintenance.ts:13` | Admission, growth samples, allocation measurement and FTS state exist; no readStorageStatus assembler. Existing log charge does not include the hub tail.                                                                                       |
| `C/memory.ts:96–174,931–978,1061–1080,1839–1915,2024–2072,2281`                                                                      | Constants, all five hub table usage names, status, leases, metadata entry, checkpoint records and eleven paths are already defined. Consume them without competing DTOs.                                                                        |
| `S/persistence/Migrations.ts:86–87,172–173`; `S/persistence/reconcileGoatMigrationIds.ts:17–18`                                      | 070 ProjectionTurnItemRequestIndex and 071 Memory are occupied. Next planned slot is 072 MemoryHubSync.                                                                                                                                         |
| `S/server.ts:588–605,775–813,1167–1185`                                                                                              | Reuse WP2 memory layer values and application startup/router scope; preserve #171 CloudTaskSource.layer supplied to routes. Hub HTTP is a sibling of browser-auth API before static fallback.                                                   |
| `S/auth/ServerSecretStore.ts:143,204,292`; `S/auth/EnvironmentAuth.ts:671,1291`; `S/http.ts:315`                                     | Named secret operations and generic cookie-preferred HTTP/MCP auth exist. Hub bearer auth is separate; raw orchestration route helper is unsuitable.                                                                                            |
| `S/environment/ServerEnvironment.ts:228,293`                                                                                         | Persisted identity/descriptor exist; runtime memoryHubProtocolVersion advertisement remains WP3 work.                                                                                                                                           |
| `C/settings.ts:1179,1765`; `S/serverSettings.ts:1224,1228`; `packages/shared/src/serverSettings.ts:600`                              | WP1 schema/reserved-key protection exists; dedicated runtime settings CAS and guards in both generic runtime paths/shared merger remain WP3 work.                                                                                               |
| `S/sshRemote/SshRemoteDispatch.ts:977,1288,1313`; `S/remoteReports/RemoteReportService.ts:129,255,276`                               | Identity/authority discipline is reference only. Neither SSH nor thread-send/readKey relay carries memory operations/source routes.                                                                                                             |
| `S/textGeneration/TextGeneration.ts:76`; dev `packages/provider-core/src/server/ProviderAdapter.ts:418,619`                          | Resolve uses TextGeneration. #171 cloud input/observation-only resume does not change this seam and is not WP3 scope.                                                                                                                           |
| `S/orchestration-v2/ThreadTitleRegenerationService.ts:73–78`                                                                         | getThreadRecords is a committed-message reader precedent, not a public MemoryService source API or authority grant.                                                                                                                             |

## 3. Implemented WP2 ports versus ports WP3 adds

Names in the right column are the frozen non-wire proposal in section 4, not baseline exports.
WP3 extends the existing Store/Service/Decider/Quota modules; it does not pretend the WP2
handoff is complete or move wire ownership. No second local SQL connection or table inventory.

| Concern                | Implemented WP2 ports / facts                                                                                                                            | Ports WP3 adds / correct consumption                                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hub admission          | Internal apply and quota admission contexts; no exported hub admission                                                                                   | admitHubOperationTx plus checked membership/receipt/sequence ports in one outer transaction.                                                                                                    |
| Concurrent edits       | Non-replica expectedHeads CAS currently applies to hubAdmission                                                                                          | Decider distinguishes localIntent CAS from hubAdmission known-parent branch merge; resolve/revert still require exact frontier/lease. H/A/B siblings become a quarantined frontier.             |
| Fencing                | Canonical identity ledger fence is read by decider                                                                                                       | transitionHubLeaseTx writes hub lease and identity highest token/activeLease atomically; revoke/head/forget invalidate both.                                                                    |
| Outbox                 | readEligibleOutbox(space, now, limit) returns MemoryWork[]; readWorkOperation(id) returns operation; acknowledgeOutbox(id, receipt) updates receipt/work | Restore one operation at a time, encode to enforce byte limits, per-operation retry; settleHubEntryTx is common ACK/pull incorporation/promotion/terminal intent path. No fictitious batch ACK. |
| Approved incorporation | applyReceived(operation, receipt), commitAcceptedResolution(operation, receipt); same-ID early return                                                    | Settlement bypasses early return only to promote local receipt and incorporate approved compensation once, without new admission. Cursor/flags/revert completion atomic.                        |
| Body-free entry        | MemoryHubEntry metadata arm exists on wire; no receiving port                                                                                            | settleHubEntryTx branches to metadata ingest without fabricating operation, including rejected/purged revision/tombstone.                                                                       |
| Unbound intent         | putLocalIntent and object-argument materializeLocalIntent returning {operation, operationDigest}; readiness published=1                                  | listMaterializableIntents, assignIntentIdentityTx and bootstrap progress; initial hub must publish a checkpoint before materialization. Assigned IDs survive retry.                             |
| Checkpoint             | installCheckpointPage and completeCheckpoint are replica ports                                                                                           | prepareHubCheckpointTx/readHubCheckpointPageTx/publishCheckpointAndFloorTx plus member-bound immutable-expiry token pins and advanceBootstrapTx.                                                |
| Resolve recovery       | persistResolutionTicket and candidate CAS exist; generic worker excludes resolve                                                                         | readRecoverableResolutionTickets, acquireResolutionTicketTx, transitionResolutionTicketTx and persistResolutionSubmissionTx; registry alone owns recovery/execute.                              |
| Generation             | TextGeneration.resolveMemoryConflict(input), no pinned resolve method on Worker                                                                          | Registry calls TextGeneration with lease frozen selection, validates trusted execution envelope and holds slot through finalization. Worker stays summary/deferred owner.                       |
| Forget                 | Base deletion and excess suppression are separate operations; forgetExpansion/forgetRetryOf receipt fields                                               | Preserve every ID/digest/result; definitive refusal uses bounded retry intents; uncertain delivery retries identical bytes. Purge must not cancel forget sync.                                  |
| Eligibility            | forget_pending is excluded by candidate CAS; invalid summaries cancel and regenerate from latest committed source                                        | Recheck before claim/generation/source output; preserve per-provider-call summary renewWork and owned retryWork. No stale payload reuse.                                                        |
| Source read            | Private Worker summary reader; no public readSource/authority/owner reader                                                                               | Inject non-wire MemorySourceReadAuthority and committed owner reader through MemoryService/SyncService; WP4 activates live compound permit and user RPC.                                        |
| Reports                | Receive creates resolve/revert report rows; ID hash(space:operation:resolution)                                                                          | resolutionReportId shared helper + reconcileResolutionReportTx; body-free guards on replicas, resolve-holder/revert-submitter delivery only; checkpoint/ACK use same key.                       |
| Storage                | readStorageGrowth, measureAllocation, counters, ftsState and maintenance samples                                                                         | readStorageStatus assembler plus readHubUsageTx; include tail/members/leases/relay/retention in global logical budget, not only discoverable measurements.                                      |

## 4. L1 frozen non-wire interfaces

These TypeScript signatures are additions to existing inline Context.Service interfaces.
`M` = @goat/contracts, `Store` = MemoryStore, `Effect` = effect/Effect. The types below
are server-private codecs; the separate §4.3 L1-0 amendment is the only new wire schema. L1 defines/exports them from MemoryStore
(or MemoryService for source seams). Runtime codecs reject excess properties and bound encoded
bytes; error classes stay Schema.TaggedError. Proposed signatures are frozen for lane handoff,
subject to architect reflection and independent A, not a claim that they compile today.

```ts
type Space = M.MemorySpaceId;
type Env = M.EnvironmentId;
type OpId = M.MemoryOperationId;
type MetadataEntry = Extract<M.MemoryHubEntry, { kind: "metadata" }>;
type ResolveOperation = Extract<M.MemoryOperation, { kind: "resolve" }>;
type StorageError = Store.MemoryStorageError;
type PortError = StorageError | Store.MemoryStoreConflict;
type AdmissionError = PortError | Store.MemoryCapacityError;
type ServiceError = MemoryServiceError;
type Permit = Effect.Effect<void, MemoryAccessError>;
// Unexported constructor; only Store.transact provides this context.
// Tx ports require its journal/context and cannot be called as standalone writes.
type InTx<A, E = PortError> = Effect.Effect<A, E, Store.Transaction>;

type HubMember = {
  memorySpaceId: Space;
  environmentId: Env;
  credentialDigest: string;
  credentialVersion: number;
  status: "active" | "revoked";
  joinedAt: number | null;
};
type HubAuthority = {
  principal: M.MemoryHubPrincipal;
  // Hub Clock is read inside the Tx AFTER SQL lock acquisition, never caller-supplied.
  now: InTx<number, StorageError>;
  // Effect re-reads active membership/version/space AFTER acquiring the SQL lock.
  reauthorize: InTx<void, M.MemoryHubUnauthorizedError | M.MemoryHubForbiddenError | StorageError>;
};
type HubLedgerRecord = { entry: M.MemoryHubEntry; committedAt: number };
type Settlement = {
  receipt: M.MemoryHubReceipt;
  incorporated: boolean;
  intent: "none" | "completed" | "rejected" | "review";
};
type AssignedIntent = {
  intent: Store.LocalMemoryIntent;
  memorySpaceId: Space;
  operationId: OpId;
  revisionId: M.MemoryRevisionId;
};
type HubCheckpointHandle = {
  checkpointId: string;
  snapshotToken: string;
  memorySpaceId: Space;
  hubEnvironmentId: Env;
  memberEnvironmentId: Env;
  credentialVersion: number;
  checkpointSequence: number;
  retentionFloor: number;
  firstIssuedAt: number;
  expiresAt: number;
  pageCount: number;
};
type HubRetention = {
  memorySpaceId: Space;
  checkpointId: string | null;
  checkpointSequence: number;
  retentionFloor: number;
  causalBoundary: M.MemoryCausalBoundary | null;
  compaction: M.MemoryCompactionStatus;
};
type HubUsage = {
  tables: readonly M.MemoryStorageTableUsage[];
  tailRows: number;
  tailBytes: number;
  permanentMetadataBytes: number;
  activeMembers: number;
  liveHandles: number;
  stagingBytes: number;
  checkpointBytes: number; // exact encoded next required snapshot, including valid revert inputs
  publishedPinnedBytes: number; // unique bytes of retained published/pinned pages
  liveSourceReads: number;
  sourcePayloadBytes: number;
};
type PersistedAdminAction =
  | Exclude<M.MemoryHubSettingsUpdateInput, { action: "installCredential" }>
  | Omit<Extract<M.MemoryHubSettingsUpdateInput, { action: "installCredential" }>, "credential">;
type AdminRecord = {
  requestId: OpId;
  requestDigest: string;
  expectedVersion: number;
  stage: "prepared" | "activated" | "ready" | "acknowledged";
  action: PersistedAdminAction;
  secretName: string | null;
  result: Omit<M.MemoryHubSettingsUpdateResult, "credential"> | null;
  memberVersion: number | null;
}; // Never persists credential bytes; private secret reference only.
type TicketState =
  | "recoverable"
  | "running"
  | "submitting"
  | "approved"
  | "finalizing"
  | "terminal";
type TicketRow = {
  ticket: M.MemoryResolutionLease;
  version: number;
  state: TicketState;
  owner: string | null;
  coordinatorEpoch: number;
  ownedUntil: number | null;
  nextAttemptAt: number;
  submission: M.MemoryHubApplyResolutionInput | null;
  submissionDigest: string | null;
  approval: M.MemoryHubReceipt | null;
};
type SyncWorkCandidate = {
  work: Store.MemoryWork;
  operationId: OpId;
  operationDigest: string;
  version: number;
};
type SyncWorkOwner = {
  workId: string;
  operationId: OpId;
  operationDigest: string;
  owner: string;
  version: number;
  ownedUntil: number;
};
type TicketKey = { memorySpaceId: Space; attemptId: OpId };
type TicketOwner = TicketKey & { owner: string; coordinatorEpoch: number; version: number };
```

Store additions/changed declarations (all hub SQL stays here):

```ts
// Type-only export: export type { Transaction }; its runtime tag/constructor stays private.
transact: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.Effect<A, E | StorageError, Exclude<R, Store.Transaction>>;
withReceivedCursor: <A, E, R>(
  input: {
    memorySpaceId: Space;
    hubEnvironmentId: Env;
    afterSequence: number;
    expectedSequence: number;
  },
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | PortError, Exclude<R, Store.Transaction>>;
// Static fixtures: InTx loses Transaction; Transaction | OtherService retains OtherService.
reserveHubCheckpointTx: (input: {
  memorySpaceId: Space;
  checkpointDeltaBytes: number;
  publishedPinnedDeltaBytes: number;
}) => InTx<HubUsage, AdmissionError>;
prepareClaimAttemptTx: (input: {
  memorySpaceId: Space;
  candidateId: string;
  expectedGeneration: number;
  conflictHeads: readonly M.MemoryRevisionId[];
  // Absent: recover existing input before reading current default provider availability.
  // Present: insert only if no attempt exists; never overwrite a stored claim.
  proposedClaim?: M.MemoryHubClaimInput;
}) => InTx<{ claim: M.MemoryHubClaimInput; generation: number } | null>;
readEligibleOutbox: (space: Space, now: number, limit: number) =>
  Effect.Effect<readonly SyncWorkCandidate[], StorageError>;
acquireSyncWorkTx: (input: {
  workId: string;
  operationId: OpId;
  operationDigest: string;
  owner: string;
  expectedVersion: number;
  now: number;
  ownedUntil: number;
}) => InTx<SyncWorkOwner | null>;
retrySyncWorkTx: (input: {
  ownership: SyncWorkOwner;
  now: number;
  nextAttemptAt: number;
  failureCode: M.MemoryFailureCode | null;
}) => InTx<boolean>;
// Auth reads are non-mutating. Transactional authorization uses the Tx version.
readHubMember: (space: Space, environment: Env) =>
  Effect.Effect<HubMember | undefined, StorageError>;
findHubMemberByCredential: (credentialDigest: string) =>
  Effect.Effect<HubMember | undefined, StorageError>;
requireHubMemberTx: (principal: M.MemoryHubPrincipal) =>
  InTx<HubMember, StorageError | M.MemoryHubUnauthorizedError | M.MemoryHubForbiddenError>;
readHubReceiptTx: (space: Space, operationId: OpId) => InTx<HubLedgerRecord | undefined>;
appendHubEntryTx: (input: {
  operation: M.MemoryOperation;
  operationDigest: string;
  // Sequence is allocated here; Store codecs enforce receipt/entry identity.
  outcome: M.MemoryHubReceipt["outcome"];
  failureCode?: M.MemoryFailureCode;
  capacity?: M.MemoryCapacityExceeded;
  resolutionApproval?: M.MemoryResolutionApproval;
  now: number; // obtained by authority.now under this outer transaction
}) => InTx<HubLedgerRecord, AdmissionError>;
readHubTailTx: (input: {
  memorySpaceId: Space;
  afterSequence: number;
  highWatermark: number | null;
  limit: number;
  maxBytes: number;
}) => InTx<M.MemoryHubPullResult, PortError | M.MemoryHubError>;
transitionHubLeaseTx: (input: {
  authority: HubAuthority;
  action:
    | { kind: "claim"; request: M.MemoryHubClaimInput }
    | { kind: "renew"; request: M.MemoryHubRenewInput }
    | { kind: "release"; request: M.MemoryHubReleaseInput }
    | {
        kind: "invalidate";
        memoryId: M.MemoryId;
        expectedToken: number;
        reason: "heads" | "forget" | "revoke";
      };
}) =>
  InTx<
    M.MemoryResolutionLease | M.MemoryHubReleaseResult | null,
    AdmissionError | M.MemoryHubError | M.MemoryHubUnauthorizedError | M.MemoryHubForbiddenError
  >;
readHubAdminTx: (requestId: OpId) => InTx<AdminRecord | undefined>;
writeHubAdminTx: (input: { record: AdminRecord; expectedStage: AdminRecord["stage"] | null }) =>
  InTx<AdminRecord, AdmissionError>;
activateHubMemberTx: (input: {
  requestId: OpId;
  requestDigest: string;
  memorySpaceId: Space;
  environmentId: Env;
  expectedCredentialVersion: number | null;
  next: { credentialDigest: string; credentialVersion: number } | "revoked";
  now: number;
}) => InTx<HubMember, AdmissionError>;
readPendingHubAdmins: (limit: number) => Effect.Effect<readonly AdminRecord[], StorageError>;
listMaterializableIntents: (environment: Env, limit: number) =>
  Effect.Effect<readonly Store.LocalMemoryIntent[], StorageError>;
assignIntentIdentityTx: (input: {
  environmentId: Env;
  intentId: string;
  memorySpaceId: Space;
  operationId: OpId;
  revisionId: M.MemoryRevisionId;
}) => InTx<AssignedIntent>;
advanceBootstrapTx: (input: {
  memorySpaceId: Space;
  hubEnvironmentId: Env;
  expectedState: "unbound" | "staging" | "ready";
  nextState: "staging" | "ready";
  checkpointId: string;
  snapshotToken: string | null;
  checkpointSequence: number;
  nextCursor: string | null;
}) => InTx<void>;
prepareHubCheckpointTx: (input: {
  authority: HubAuthority;
  checkpointId: string;
  snapshotToken: string;
  hubEnvironmentId: Env;
}) => InTx<HubCheckpointHandle, AdmissionError | M.MemoryHubError>;
readHubCheckpointPageTx: (input: {
  authority: HubAuthority;
  snapshotToken: string;
  cursor: string | null;
}) =>
  InTx<
    M.MemoryHubCheckpointPage,
    PortError | M.MemoryHubError | M.MemoryHubUnauthorizedError | M.MemoryHubForbiddenError
  >;
readHubRetentionTx: (space: Space) => InTx<HubRetention>;
publishCheckpointAndFloorTx: (input: {
  memorySpaceId: Space;
  checkpointId: string;
  expectedFloor: number;
  nextFloor: number;
  now: number;
}) => InTx<HubRetention, AdmissionError>;
compactEligibleHistoryTx: (input: {
  memorySpaceId: Space;
  expectedFloor: number;
  now: number;
  limit: number;
}) => InTx<M.MemoryCompactionStatus>;
readHubUsageTx: (space: Space) => InTx<HubUsage>;
purgeHubTransientTx: (input: {
  memorySpaceId: Space;
  memoryId?: M.MemoryId;
  now: number;
  limit: number;
}) => InTx<{ removedRows: number; cleanupPending: boolean }>;
// Four distinct typed SQL ports; each is called under HubService's outer transaction.
// A post-lock membership or scope failure surfaces as the auth errors so transport keeps 401/403.
requestHubSourceReadTx: (authority: HubAuthority, input: M.MemoryHubSourceReadRequestInput) =>
  InTx<
    M.MemoryHubSourceReadRequestResult,
    AdmissionError | M.MemoryHubError | M.MemoryHubUnauthorizedError | M.MemoryHubForbiddenError
  >;
collectHubSourceReadsTx: (authority: HubAuthority, input: M.MemoryHubSourceReadCollectInput) =>
  InTx<
    M.MemoryHubSourceReadCollectResult,
    PortError | M.MemoryHubError | M.MemoryHubUnauthorizedError | M.MemoryHubForbiddenError
  >;
respondHubSourceReadTx: (authority: HubAuthority, input: M.MemoryHubSourceReadRespondInput) =>
  InTx<
    M.MemoryHubSourceReadRespondResult,
    AdmissionError | M.MemoryHubError | M.MemoryHubUnauthorizedError | M.MemoryHubForbiddenError
  >;
resultHubSourceReadTx: (authority: HubAuthority, input: M.MemoryHubSourceReadResultInput) =>
  InTx<
    M.MemoryHubSourceReadResultResult,
    PortError | M.MemoryHubError | M.MemoryHubUnauthorizedError | M.MemoryHubForbiddenError
  >;
readRecoverableResolutionTickets: (input: { now: number; limit: number }) =>
  Effect.Effect<readonly TicketRow[], StorageError>;
acquireResolutionTicketTx: (input: {
  key: TicketKey;
  expectedVersion: number;
  owner: string;
  coordinatorEpoch: number;
  now: number;
  ownedUntil: number;
}) => InTx<TicketRow | null>;
transitionResolutionTicketTx: (input: {
  ownership: TicketOwner;
  nextState: TicketState;
  now: number;
  ownedUntil: number | null;
  nextAttemptAt: number;
  approval?: M.MemoryHubReceipt;
  // Definitive terminal outcomes only: retires the frozen claim of this attempt.
  retireClaim?: { expectedGeneration: number; attemptId: string };
}) => InTx<TicketRow | null>;
persistResolutionSubmissionTx: (input: {
  ownership: TicketOwner;
  submission: M.MemoryHubApplyResolutionInput;
  digest: string;
}) => InTx<TicketRow>;
reconcileResolutionReportTx: (input: { record: M.MemoryCompactReceipt; localEnvironmentId: Env }) =>
  InTx<{ reportId: M.MemoryReportDelivery["reportId"] | null; deliverable: boolean }>;
```

MemoryService/Quota additions and pure helper:

```ts
// Invoked only by HubService, not RPC/MCP/Worker; caller owns store.transact.
admitHubOperationTx: (input: {
  authority: HubAuthority;
  operation: M.MemoryOperation;
  // resolve is admitted ONLY through applyResolution carrying its full lease request.
  resolutionRequest?: M.MemoryHubApplyResolutionInput;
}) =>
  InTx<
    M.MemoryHubReceipt,
    ServiceError | M.MemoryHubError | M.MemoryHubUnauthorizedError | M.MemoryHubForbiddenError
  >;
settleHubEntryTx: (input: {
  memorySpaceId: Space;
  hubEnvironmentId: Env;
  localEnvironmentId: Env;
  entry: M.MemoryHubEntry;
  workId?: string;
}) => InTx<Settlement, ServiceError>;
receiveHubPage: (input: {
  memorySpaceId: Space;
  hubEnvironmentId: Env;
  localEnvironmentId: Env;
  expectedSequence: number;
  page: M.MemoryHubPullResult;
  reauthorize: Effect.Effect<void, MemoryAccessError>;
}) => Effect.Effect<readonly Settlement[], ServiceError>;
settleHubAcknowledgement: (input: {
  memorySpaceId: Space;
  hubEnvironmentId: Env;
  localEnvironmentId: Env;
  workId: string;
  receipt: M.MemoryHubReceipt;
  operation: { operationId: OpId; operationDigest: string }; // local immutable reference
  reauthorize: Effect.Effect<void, MemoryAccessError>;
}) => Effect.Effect<Settlement, ServiceError>;
// Quota: read counters/samples/state/retention, no per-request physical page scan.
readStorageStatus: (input: { memorySpaceId: Space; environmentId: Env }) =>
  Effect.Effect<M.MemoryStorageStatus, StorageError>;
// MemoryStore exported pure function; exact algorithm reused on all paths.
resolutionReportId: (space: Space, operation: OpId, resolution: M.MemoryResolutionId) =>
  M.MemoryReportDelivery["reportId"];
```

### 4.1 Transaction owners and idempotency

| Ports                                                             | Transaction owner and effects                                                                                                                                                                       | Idempotent key / CAS                                                                                                                                                                     |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| readHubMember/findHubMemberByCredential and list/recovery reads   | Read only; results never substitute post-lock membership check                                                                                                                                      | Member (space,environment), bounded deterministic order                                                                                                                                  |
| admitHubOperationTx + require/readReceipt/append/lease invalidate | HubService opens store.transact once per operation. Reauthorize first, replay check, domain/quota, payload/receipt, hub sequence and both fences before commit; body-free wake after commit         | (space,operationId), original canonical digest; same ID/digest returns original entry; changed digest error. Local events already present do not skip new hub admission.                 |
| transitionHubLeaseTx                                              | HubService transaction; Store rechecks member/heads/delete and writes lease + identity ledger in one conditional transition                                                                         | (space,memoryId,attemptId,holder,credentialVersion,token); same claim replays same ticket; expiry never restarts attempt deadline                                                        |
| admin Tx ports                                                    | Administration opens separate short Store transactions around secret I/O and settings I/O; no locks held across filesystem writes                                                                   | requestId/requestDigest/expectedVersion, expectedStage, member credential version; activation also invalidates affected leases/fences                                                    |
| settleHubEntryTx                                                  | Caller already owns Store transaction; replica integrity, canonical data, original approval, promotion, flags/report guard/intent terminal settlement; never local quota/scanner/lease re-admission | (space,receipt.operationId,digest); repeated ACK/pull returns same approval. Different approved digest is protocol error.                                                                |
| receiveHubPage                                                    | MemoryService opens store.withReceivedCursor (one transact), validates whole page first, settles all entries and cursor together                                                                    | (space,hub,expectedSequence,throughSequence); order strictly increases but sequence gaps allowed; replays NOOP                                                                           |
| settleHubAcknowledgement                                          | MemoryService opens store.transact, resolves immutable reference, branches sequenced settlement vs null-sequence refusal; ACK never advances cursor                                                 | workId + operationId/digest; validate receipt against stored immutable operation; never synthesize sequence/approval                                                                     |
| intent assignment/bootstrap                                       | Sync opens Store transaction for assignment/progress; existing materializeLocalIntent reuses transaction journal                                                                                    | (environment,intentId) persisted first IDs/space; different retry IDs return stored assignment, never rebind published operations                                                        |
| checkpoint prepare/page                                           | HubService/Compactor opens Store transaction; prepare reads consistent S, bounded durable pages and token pin; pages require current authority                                                      | checkpointId; token bound to space/hub/member/version/S; one handle/member; cursor->page ordinal; initial expiry immutable; published checkpoint lifetime is independent of token expiry |
| checkpoint publish/compact                                        | Compactor opens Store transaction after complete staging; validates all records/pages, protections and pins, publishes S/boundary/F then compacts safe prefix, persists receipt                     | (space,checkpointId,expectedFloor), monotonic F<=S; replay never advances twice; failed publication leaves old checkpoint/floor                                                          |
| purgeHubTransientTx/source ports                                  | HubService per-request transaction; forget calls same purge inside admission/receive transaction, no transcript in events                                                                           | source (space,requestId,requestDigest), responseDigest; first 75s deadline immutable; consumed/expired payload erased                                                                    |
| registry acquire/transition/submission                            | Sync registry opens short Store transactions; no model/network under lock                                                                                                                           | (space,attemptId), version/owner/epoch/unexpired ownership CAS; same submission bytes/digest only; lost ownership returns null without work                                              |
| report reconcile/helper                                           | Settlement/checkpoint transaction creates bounded body-free guard; local report delivery deferred                                                                                                   | SHA-256 UTF-8 of `space:operation:resolution`, existing WP2 algorithm; same reportId for checkpoint/receive/ACK/restart                                                                  |
| readStorageStatus                                                 | Quota assembles coherent counters + cached sample/growth/FTS + hub retention; no new sampling ring                                                                                                  | Same latest maintenance sample; unavailable allocation stays null/unavailable                                                                                                            |

The Tx context has a type-only export; Store.transact is its sole runtime supplier.
reserveHubCheckpointTx updates exact encoded checkpoint and unique published/pinned byte counters
in the admission transaction; replay does not reserve twice. All mutation deltas (including
ledger/refusal/admin/member/lease growth, payload replacement and redaction) use these counters.
Checkpoint prepare/publish moves the existing reservation between staging/published/pinned categories;
cleanup releases unique retained bytes once. Failed transaction rolls back counters with state.
prepareClaimAttemptTx CASes due candidate generation/current heads/forget fence and atomically
persists the entire first MemoryHubClaimInput, including its attemptId and
frozenDefaultModelSelection (provider instance/model/options). It returns the stored claim
and generation on restart; proposedClaim must match space/candidate conflict/current heads
and holder. Existing input wins unchanged over any proposal. With no stored input and no
proposal, or a stale candidate, return null without starting network work; a fresh proposal
must recheck the same CAS. Ticket persistence follows claim, never supplies the first durable
attempt ID or frozen selection. Saved claims remain bounded work metadata, not another queue.
A frozen claim is retired only after its outcome is definitive: the hub refused the claim,
approval reconciliation shows the attempt was not accepted after a definitive generation
failure, or the attempt cap ended with the matching lease released or expired. Retirement is
transitionResolutionTicketTx with retireClaim, a CAS on the expected generation and attemptId
that clears the stored claim and increments the candidate generation in the same transaction.
An uncertain submission or lost response never retires; it replays the stored claim.
acquireSyncWorkTx owns only sync/revert_intent rows using version + digest + expiry CAS;
retrySyncWorkTx updates retry/next_attempt_at and releases matching ownership atomically,
returning false on stale ownership. Neither changes operation ID/digest/payload. Restart can
reacquire expired ownership; ACK/pull terminal settlement cancels retries under the same CAS.
WP2 retryWork remains summary/consolidate/rebuild-only; L4 never writes SQL directly.

settleHubAcknowledgement first reads work + immutable operation by the supplied ID/digest
and validates receipt identity. For positive hubSequence it constructs the valid operation
entry from that stored operation + receipt and calls settleHubEntryTx (or the stored metadata
arm if bodies were purged). For hubSequence=null it requires outcome=rejected and settles
only correlated local refusal/work/intent in this transaction: no MemoryHubEntry construction,
no hub/compact-sequence allocation, no canonical incorporation/receipt promotion/cursor or
success report. Definitive revert refusal terminates its intent; forget refusal records the
existing bounded retry/coverage policy (§7.3), retaining delete knowledge. Repeated refusal
and restart are idempotent; a later actual approval can settle through the sequenced branch.

Public service wrappers never accept an external approvedReplica boolean/context; HTTP input cannot select admission.
L1 must extend current private apply to allow receipt promotion/domain repair without triggering
same-ID early-return. Existing applyReceived/commitAcceptedResolution remain safe wrappers over
the common approved settlement where appropriate. Existing acknowledgeOutbox remains a low-level
work helper; new consumers call the service settlement wrapper, not ACK alone.

### 4.2 Source injection interfaces (L1 definitions; L4 implementation)

```ts
type ValidatedSourceRequest = {
  request: M.MemoryHubSourceReadRequestInput;
  generation: number; // requester eligibility generation, never a user-provided authority
};
type MemorySourceReadAuthority = {
  readSource: (
    input: ValidatedSourceRequest,
    permit: Permit,
  ) => Effect.Effect<M.MemorySourceReadOutcome, ServiceError | M.MemoryHubError>;
};
type MemoryOwnerCommittedReader = {
  readCommitted: (
    input: M.MemorySourceReadRequest,
    reauthorize: Permit,
  ) => Effect.Effect<M.MemorySourceReadOutcome, ServiceError>;
};
// MemoryService constructs evidence-linked locators; WP4 activates the public readSource method.
prepareSourceRead: (input: M.MemoryReadSourceInput, permit: Permit) =>
  Effect.Effect<ValidatedSourceRequest, ServiceError>;
validateSourceOutcome: (
  input: {
    request: ValidatedSourceRequest;
    outcome: M.MemorySourceReadOutcome;
  },
  permit: Permit,
) => Effect.Effect<M.MemorySourceReadOutcome, ServiceError>;
```

These preparation/validation ports read committed memory state and recheck permit/eligibility;
they do not start a network call or write a transcript. Source outcome remains transient.
Owner reader is injected once in server composition using committed thread repository plus
source event watermark validation. WP4 supplies live memory:read + orchestration:read permit and
maps validated available outcome to MemorySourcePage. No later MemoryAccess import in WP3,
no private Worker helper promoted to public reader, no owner lookup by colliding local thread ID.

### 4.3 L1-0 contract commit (WP1-owned prerequisite)

Before L1 consumers, amend `C/memory.ts` and `C/memory.test.ts` in a distinct L1-0 contract
commit; this planner changes no source. Add exported strict `MemoryResolutionApproval`:
`{ resolutionId: MemoryResolutionId, appliedAtUtc: MemoryUtcTimestamp,
revertDeadlineUtc: MemoryUtcTimestamp }`, requiring exactly
`Date.parse(revertDeadlineUtc) - Date.parse(appliedAtUtc) === 30 * 24 * 60 * 60 * 1000`.
Add `resolutionApproval: Schema.optionalKey(MemoryResolutionApproval)` to MemoryHubReceipt.
Receipt filter forbids it on rejected/deleted outcomes; operation-aware MemoryHubEntry,
MemoryCompactReceipt and ACK validation require it for approved resolve and forbid it for
other operation kinds. An approved revert carries no new window. Add required body-free
`operationKind: "upsert" | "forget" | "resolve" | "revert"` to MemoryHubEntry's metadata arm,
and `resolutionId: MemoryResolutionId` required for resolve and forbidden for other kinds.
Its codec independently checks receipt identity and, for approved resolve, mandatory approval
with matching resolutionId; rejected resolve has no approval. Metadata upsert/forget/revert
forbid approval. The operation arm checks kind and result resolutionId against receipt
approval. These checks need no revision body or assertionKind inference. MemoryCompactReceipt
checks operationKind/resolutionId against approval, including checkpoint records using that
schema. Tighten the approved revert reportGuard check to resolvingEnvironmentId ===
originEnvironmentId as for resolve; rejected guards stay null.
validateMemoryCheckpointRecords cross-checks each retained approved resolution's projected
times against its originating compact approval; purged resolutions need only body-free
metadata and receipt. Exact 30 days is an approval-boundary invariant: enforce when the hub
creates resolutionApproval and when a receiver validates it before approval projection
through ACK/pull/checkpoint. Keep MemoryResolution's storage/decode schema unchanged
(`revertDeadlineUtc >= appliedAtUtc`); never add exact-interval validation to aggregate decode.
validateMemoryCheckpointRecords also accepts the two identities WP2 actually produces: an
identity whose create operation is an unknown-ID forget (deleted receipt, tombstone-only
identity), and a rejected compact receipt with no accepted canonical effect, carried as a
body-free operationId record for replay and dedup without identity or fence. Every other
identity/fence requirement stays. This lands as its own contract commit inside L1.
The MemoryHubEntry metadata arm also carries an optional compactReceipt so a device that first
learns of a resolve or revert from a body-free entry can decide report ownership. When present,
the codec requires it to match the receipt (operationId, outcome, operationKind, resolutionId,
resolutionApproval); the hub producer always fills it for resolve and revert entries; ACK, pull
and checkpoint use the same guard and resolutionReportId rule. This is an integrity check, not
replica re-admission (M20).
Do not change MemoryOperation, canonical digest or apply input. Project new approved times
from validated receipt approval, never operation submission timestamps.

Do not preselect 1024 bytes for MEMORY_COMPACT_RECEIPT_MAX_BYTES. L1 measures the real maximum
of the approval-bearing binary encodeCompactReceipt codec, including its version byte,
maximum-width numeric/ordinal fields, null markers and every legal guard/capacity combination.
Use existing resolutionId and the exact 30-day relation to avoid redundant encoding while
preserving lossless approval round trips. Freeze the constant from that measured maximum plus
small explicitly justified headroom, not JSON size or an assumed fourfold increase. The
coordinator obtains this L1 codec measurement before freezing the L1-0 constant; L1 commits
the matching codec/fixtures before consumers. Keep the 128 MiB permanent-metadata global
budget and receipt-count cap unchanged: the count cap is not a guaranteed capacity. Charge
actual per-version encoded bytes, including existing approval-free receipt rows, rather than
retroactively charging every row the new maximum. Versioned decode accepts old approval-free
binary rows and mixed old/new rows for local storage/accounting; an old resolve receipt
without authoritative approval cannot become an approval merely because it decodes.
Fixtures measure and assert the legal maximum equals the derived encoding bound, record
headroom separately and assert maximum + headroom equals the contract cap; include byte
admission equality/+1, old/new decode, exact historical accounting and approval round trips.

Producer chain: L2 reads post-lock Hub Clock once at first approval; L1 append/store persists
approval in receipt/compact ledger plus operationKind/resolutionId in metadata; WP1
push/apply/pull/checkpoint codecs serialize and independently validate them; L1
settlement/checkpoint install populates approved MemoryResolution projection. L1
MemoryDecider uses persisted approval deadline instead of revision.createdAtUtc; L2 compactor
and WP6 history consume those times. Replay returns original approval, including after body
purge; forget releases protection immediately while retaining body-free dedup approval.
Operation-supplied legacy times remain immutable but are never authority. Fixtures reject
missing/mismatched approval, extra fields, non-30-day approval windows and invented windows
on revert/refusal; cover ACK/pull/checkpoint round trips and off-clock submissions.

071 is undeployed (Jun's stated rollout fact). WP2 routes resolve execution only through the
not-yet-implemented WP3 registry, so its normal 071 database cannot contain resolution rows.
No resolution-data migration is needed; 072 still adds the hub tables/recovery fields in §5.1.
Nevertheless inject a legacy resolution with a non-exact-30-day interval valid under the
existing storage schema: aggregate read, local forget and physical purge must succeed across
upgrade. Hub activation/approval paths must not treat this row or an approval-free resolve
receipt as authoritative evidence; refuse activation with unsupported_protocol until a
compatible authoritative checkpoint is available, without blocking local read/delete.
Never invent approval timestamps or mutate operation/digest to repair such data. Since hub
v1 is not activated on this baseline, L1-0 lands before first advertisement; mixed old hub
wire codecs are not claimed compatible with the new approval/metadata contract.

## 5. Hub persistence, admission and authority

### 5.1 Migration and bounded SQL inventory

Add `apps/server/src/persistence/Migrations/072_MemoryHubSync.ts` and its focused test;
register stable `MemoryHubSync` in Migrations.ts and GOAT_MIGRATION_NAMES. Recheck the next
free slot immediately before implementation. Never reuse 070/071 or recreate WP2 cursor,
inbox, payload, receipt, compact ledger, sample or local-intent tables.

| New table / key                                                    | Payload and lifecycle                                                                                                                                                                                                                              |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| memory_hub_members PK(space,environment)                           | credential_digest/version, active/revoked, joined_at; unique credential_digest lookup. Max 128 membership rows including revoked rows; reuse row on rotate/reprovision, no unbounded new revoked identities.                                       |
| memory_hub_operations PK(hub_sequence), UNIQUE(space,operation_id) | origin/memory/operation digest, outcome/failure/capacity safe metadata, payload_ref, committed_at. Monotonic sequence may have rollback gaps; space+sequence B-tree. Detailed tail is finite, compact ledger is authoritative dedup after cleanup. |
| memory_hub_leases PK(space,memory)                                 | highest fencing token and nullable active holder/version/attempt/conflict/heads/timestamps/frozen selection. Clear ownership, never reset/delete highest token; identity ledger owns matching canonical fence.                                     |
| memory_hub_source_reads PK(space,request_id)                       | requester/owner/version, request digest + locator-only JSON, pending/completed/expired, first deadline, response digest + purgeable payload_ref. B-trees on owner/state/deadline and memory. TTL/consumption purge; no permanent transcript log.   |
| memory_hub_retention PK(space)                                     | published checkpoint/S/causalBoundary/F, active token pin metadata and last compaction receipt. Pins/pages use existing private checkpoint staging namespace; typed bounded JSON, no extra public wire shape or duplicate staging table.           |

Persist checkpoint_bytes and published_pinned_bytes in memory_hub_retention; admission computes
exact deterministic encoding deltas for changed records/pages rather than scanning all payloads.
Initialize counters from a consistent state before admission is enabled. Add sync_version and
operation_digest to existing sync/revert_intent work metadata/columns; readEligibleOutbox returns
those CAS fields and due expired ownership is recoverable. Persist the frozen claim input
with candidate generation/attempt metadata in the existing work rows; no second queue or
resolution-data rewrite.
Any extra local recovery/admin/registry columns or private staging discriminators are L1-owned
extensions to existing WP2 tables in this migration. Migration test validates upgrade from
071, restart and ID reconciliation. Secrets stay outside SQL; source payloads live only in
private purgeable memory_payloads namespace with memory/revision dependencies.

Published checkpoint pages remain recoverable after member-token expiry; transient token pins
expire independently. Staging cleanup never deletes the sole published recovery snapshot. New
publication replaces the prior snapshot only after durable completeness; old pages survive
while live handles pin them, within staging admission bounds. New hub admission reserves
`checkpointBytes + delta + publishedPinnedBytes + retained-page delta <= MEMORY_CHECKPOINT_STAGING_MAX_BYTES`
(the existing 128 MiB budget; use the actual WP1 export, not a new limit). checkpointBytes is
actual deterministic encoded pages/envelopes for live payload + valid revert inputs + every
permanent ledger, not live body bytes alone. Shared retained pages count once. Reserve the
next publication while keeping old published/pinned pages; inability refuses only the new
request with capacity_exceeded. Approved replica install and reserved first forget never
re-admit (M20); first-forget metadata/checkpoint reserve is acquired with identity admission.
Reserved forget uses that reserve and releases purged payload/history protection; new excess
suppression still needs its own admission. No approved state relies on later compaction to
become representable. Equality succeeds; combined size +1 refuses atomically.

Private registry/admin recovery rows are bounded by existing work/report/metadata budgets and
active slot limits; terminal detailed recovery/report/admin records compact after 30 days,
keeping only bounded replay guards and referenced current secret names. Expired relay requests
erase locators/outcome/cursor/payload before removing rows. Permanent compact receipts and
fences remain subject to finite admission, never discarded by TTL cleanup.

No new full-text index: WP2's single unicode61 eligible-head index is the only text index.
No hub transcript/history/original/judgment/evidence FTS, no parallel trigram. Use small key
B-trees, bound JSON metadata and include their actual allocation in measurement. All five
hub tables and private staging/payload/admin state count toward M19 logical/global budgets.
Measurement auto-discovery alone is not admission. Charge incremental hub tail bytes/rows,
metadata/member/lease/handle/relay charges under the same transaction, counting shared payload
once. Reuse WP1 dimensions/errors; do not invent wire limits or aggregate replica FTS allocation.

### 5.2 Admission and concurrent frontier

HubService validates batch envelope then admits each operation in its own transaction, so a
semantic rejection does not block siblings. Recheck membership after lock acquisition before
replay lookup. Read authority.now inside the transaction after the SQL lock; reuse that
instant for lease/apply/revert checks and first resolution approval. Same ID/digest returns original receipt/sequence; changed digest is
operation_id_reused. Pre-admission envelope/auth/protocol failure has no sequenced domain receipt.
Admitted semantic refusal has sequenced metadata-only receipt; transient SQL failure has none.
Bound rejection receipt allocations too: reserve their compact metadata before admission; if
even refusal metadata cannot be reserved, return pre-admission capacity refusal with null
sequence and no unbounded tail/receipt allocation. Existing accepted replay needs no new row.
Compact receipts preserve original digest after bodies are purged and detailed tail removed.

Local upsert keeps expected-head CAS. Hub ordinary upsert with valid known common parents may
arrive after a sibling has changed heads: retain both branches, prune only ancestors, quarantine
that memory and enqueue a stable claim candidate. Unknown parent parks/blocks that memory under
bounded admission; cross-memory/cyclic parents are invalid. Unapproved parents below published
boundary return base_compacted for explicit review with bounded original intent retained.
Hub resolve requires exact current claimed heads, all input parents and active lease; revert
requires sole current resolution head, selected original and 30-day deadline. Do not implement
hub concurrency by globally disabling CAS or by using approvedReplica for new submissions.

Only apply-resolution admits a new resolve; ordinary push returns lease_required for new
resolve but returns its original receipt on authorized replay. After acceptance, approved
replica merge never repeats hub CAS/quota/brake/scanner/lease admission. Preserve unrelated
unsent ordinary heads alongside the result; pending/rejected revert is never a DAG head.
Local hub commits use the same outbox/admission path and internal active membership, no self
HTTP. Local events already present must still get one hub admission/sequence and global quota
settlement; avoid double-charging their canonical payload. Before claims, sweep local unledgered
writes and publish initial checkpoint. Pending local commit is not hub acceptance.

### 5.3 Credentials, bearer-only HTTP and settings

Owner settings:write administration provisions a distinct 32-random-byte credential per member.
Join never enrolls an unauthenticated member. Internally generate secret names matching
`[a-z0-9-]+`; only secret references enter settings. No reuse of browser/MCP/agent/dev tokens,
SSH credentials or a shared space-wide secret. ServerSecretStore is file-per-secret with its
existing atomic rename/permissions, not encrypted storage.

Admin requestId/expectedVersion/digest persists body-free recovery intent. Stage secret first,
activate membership/version second, persist settings CAS through dedicated helper, mark ready,
return bytes only in explicit no-store owner response, erase outgoing bytes after acknowledgement.
Cross-filesystem/SQL/settings steps are not one transaction: interrupted step retries its same
request/secret/version, reconciles durable stage and cleans inactive orphans. Failure before
activation retains old credential/settings; failure after activation is explicit recoverable
administration pending, never falsely rolled back. Rotation/revoke invalidate leases and both
fences transactionally. Disabled stops coordinator and preserves data/outbox/cursor; member
disconnect and hub revoke are separate actions. No automatic promotion or new space rebinding.

MemoryHubAuth parses only Authorization bearer, finds bounded digest membership and supplies
principal. Cookies alongside valid bearer neither replace nor broaden it. Every HubService
transaction repeats active membership/space/environment/version authorization; operation origin
must equal authenticated member (provenance can reference other environments). Hub principal
has memory:sync transport authority, never settings administration or transcript grant.

Client preflight reads public descriptor, checks pinned hub identity + independent
memoryHubProtocolVersion=1 BEFORE loading/sending credential. Endpoint obeys WP1 absolute
http(s) origin/no userinfo/query/fragment and loopback-only HTTP rule. LAN/tailnet needs HTTPS
or configured secured tunnel presenting loopback HTTP. Reject all redirects, including same
origin. Relay transport auth is additional; prove it can carry all eleven POST paths.
Unsupported path gives route_unavailable; no SSH, localhost or environment fallback.

Dedicated applyMemoryHubTransition helper takes requestId/expectedVersion under existing admin
lock with repeatable post-lock settings:write permit. No recursive call to public generic updater.
Both updateSettings and updateProviderInstance plus shared applyServerSettingsPatch reject own
memoryHub AND memoryHubVersion keys before normalization/merge, including mixed patches.
Schema rejection remains first wire defense. Runtime rejection maps to declared
ServerSettingsError {settingsPath, operation:"normalize"}, safe reserved-key cause, not an
undeclared MemoryHubError. Reject causes no secret staging/rotation/cancel/settings publication.
Settings mode union is exactly disabled/hub/member; local-hub describes mode="hub", not
a new wire discriminator. Every configure replaces the complete union value, preserving
unrelated settings. Persist memoryHubVersion (old files default 0), never credential bytes.
Settings epoch cancels previous coordinator; late old-epoch response cannot update cursor/status.

## 6. Conflict lease and resolution registry

Claim key is (space,memory,canonical sorted distinct conflict heads). First successful atomic
hub claim wins; this does not establish globally earliest observation. Claim stores attemptId,
current credential version, holder and frozen raw defaultModelSelection including options.
For a new attempt only, null/unavailable default returns typed failure before claim, no
title-generator fallback. Recovery first reads/replays a saved claim without consulting the
current default; a changed or null default cannot prevent recovery of an existing lease.
Post-lock Hub Clock alone controls 120s lease, 30s renewal and fixed 600s attempt cap; member clock only
schedules. Strict now < expiry; renewal min(now+120s, original deadline). New head, forget,
rotation/revoke invalidate ownership and monotonically advance highest token in BOTH hub row
and identity fence in one transaction. Matching release clears ownership only; stale release
cannot clear newer token. Retain tokens after release/expiry/delete/restart.

Apply checks membership, replay ID/digest first, then holder/attempt/token/current heads,
strict expiry/cap/tombstone, trusted generated output/scanner, all claimed parents. Commit
revision/resolution/judgment/original references, receipt/sequence, report guard and clear lease
atomically. Record requested/effective model, provider instance, resolving environment,
judgment and originals; fix approval.appliedAtUtc at this hub instant and its deadline exactly
30 days later (§4.3), retaining revert inputs until that deadline unless forget. Replay reuses
stored approval even if the retry clock differs. Replace the decider revision.createdAtUtc
guard with this authoritative approval deadline; strict now < deadline, equality expires.
L1 also removes the local device-clock expiry rejection in MemoryService.revertResolution
(current MemoryService.ts:608): local staging retains identity/head/original/delete checks
but cannot reject solely on device time. Hub post-lock time decides admission; approved
receive never repeats expiry admission. Validated accepted
result applies immediately; local index/report deferral does not delay canonical application.

MemoryResolutionRegistry is app-scoped ownership INSIDE MemorySyncService, not a second service
or Worker. start recovers durable candidates/tickets and runs immediate syncOnce. Every syncOnce,
even empty push, sweeps candidates after receive. Wakeups are hints; SQL/restart sweep authoritative.
Reload heads/forget_pending/generation and call prepareClaimAttemptTx without a proposal to
recover a saved claim BEFORE current default provider availability checks. Only if there is
no saved attempt and the candidate is still eligible, validate the current default, construct
the full MemoryHubClaimInput with a proposed attemptId/frozen selection, then call the same
CAS port to persist and return the winning claim. Commit before network; reserve a slot,
replay that exact stored claim, persist ticket, CAS ownership and register
runClaimedResolution. Hub success then crash before ticket storage must recover the same
claim and lease even if the default changes to another provider or null; never regenerate
input from current settings or replace the ID. Execution uses the recovered lease's frozen
selection; unavailable execution provider remains a typed failure without fallback.
After a retired attempt, the next sweep finds no stored claim for the new generation, so it
validates the current default and persists a new claim with a new attemptId and the current
frozen selection. A default change therefore affects only attempts started after retirement.
scheduleConflictResolution returns after persistence + registration, never model completion.

At most four reserved/running/finalizing executions/environment, one per memory. Candidate
sweep inspects at most 100; full slots leave durable due candidates. Completion signals another
finite sweep. Generic dueWork/retryWork/claimWork/execute, DrainableWorker and manual repair
must not recover resolve; registry-only ports handle it. Keep Worker summary renewWork per
provider call and expired-owned retryWork unchanged. joint-start fixture proves generic resolve
execution count zero with actual MemoryWorker and SyncService running together.

No SQL lock spans model/network. Registry calls TextGeneration.resolveMemoryConflict directly
with lease frozen selection, checks eligibility immediately before input exposure and output
submission. Parallel renewal belongs to registered execution. Failure before approval cancels
output/generation, best-effort matching release, bounded failure/report intent and retry;
only that memory remains quarantined. Superseded heads/forget/settings epoch cancel registered
execution and prevent late commit. Provider tool policy remains WP2 runner ownership; no adapter
cloud launch/resume edit and no claim of OS isolation.

Persist deterministic resolve operation/revision/submission ID and digest BEFORE apply network.
Unknown response retries identical bytes or pulls approval, even after old lease expiry. Known
approval moves ticket to approved; canonical write failure keeps recoverable approval, never
regenerates or creates another result because local report/FTS/scanner held. Startup reconciles
hub receipt/head/fence and local ownership CAS before deciding whether generation can resume;
uncertain submissions are reconciled before any new attempt. Local ownedUntil is execution CAS,
not hub lease authority. Registration failure stores recoverable ticket, releases best-effort,
returns slot without generation. Finalizer stops renewal/generation, persists state, attempts
bounded release and only outer ensuring returns slot even if cleanup fails. Shutdown closes
registrations, interrupts executions, awaits bounded finalization and retains uncertain state.

claim_busy backs off 30s absent expiry, otherwise no earlier than authoritative lease expiry.
Transient claim retry persists 5s/30s/120s/10min capped backoff. Renewal failure retries no earlier
than known expiry. Generation failure has >=30s floor; 10min cap releases matching lease.
Permanent schema/secret/auth/identity failures stop until relevant policy/settings/input change.
Accepted result arriving by pull may complete/cancel a candidate before its retry.

Report key is exactly WP2 SHA-256(space:operation:resolution), centralized by L1 for resolve and
accepted revert. Each replica retains body-free replay/checkpoint guard. For resolve, the
claim holder/result resolving environment materializes/drains Bot delivery. For accepted revert,
the immutable revert operation origin (the revert submitter, even if different from the original
resolver) owns delivery; reportGuard.resolvingEnvironmentId records that delivery owner. L1
constructs and validates this guard in append/settlement/checkpoint. Original resolver and other
replicas keep only body-free guards; no duplicate success delivery. Failed attempt IDs remain WP2's environment/work/attempt key.
Do not copy another environment's success report; delivery quota/failure cannot block cursor or
restart resolution. Pending revert preserves stable immutable operation as intent; only accepted
compensation enters DAG, refusal settles terminal review without success report/descendants.

## 7. Sync, receive, bootstrap and forget

start waits for migrations/settings/core readiness, recovers admin/outbox/inbox/report/candidates/
tickets, then syncs and listens for committed outbox/settings/candidate signals. Periodic pull
30s; request deadline 15s. Per environment serialize finite syncOnce transport/scheduling,
not generation/deferred drain. Ordered cycle: bootstrap if needed → bounded pull → expired relay
cleanup and bounded collect/respond → one bounded push → bounded pull → candidate sweep.
No model wait, no provider on turn-start path, no self HTTP.

Restore outbox candidates using revised readEligibleOutbox(space,now,limit), then
readWorkOperation(candidate.work.id); use candidate.version/operationId/digest for acquisition.
The old MemoryWork[] return is replaced, not an assertion that baseline exposes CAS versions.
L1 changes readEligibleOutbox selection SQL BEFORE LIMIT: due base forget first, then due
suppression extension, then ordinary sync/revert_intent; within each class ORDER BY
next_attempt_at,id. Base/extension classification uses immutable operation metadata, not a
nullable body after purge. Retain persisted backoff and finite sweeps; failed forget becomes
not-due, allowing unrelated work to advance, and a finite due-forget queue drains before
ordinary work (no infinite producer fairness promise). Receive keeps hub sequence order.
Acquire each selected work with acquireSyncWorkTx before transport; persist uncertainty/429/5xx
backoff with retrySyncWorkTx, keeping identical submission across restart. No summary retryWork.
Respect complete encoded wire count/byte envelopes, retain whole items; no partial fact or
zero-progress oversized-item loop. Each ACK settles individually; persist per-work retry metadata.
Network/5xx/429 uses 1/2/4/8/16/30s delays, bounded Retry-After<=30s. Auth/protocol/identity
blocks until configuration/credential/descriptor changes or explicit reconnect. Unknown outcomes
reuse operation IDs/digests; semantic refusals do not stall unrelated work.

### 7.1 Checkpoint and first hub bootstrap

Initial local-hub configure allocates/stores space once, internal membership and a complete
published checkpoint (empty is valid) with published=1 before intent materialization. A member
join returns pinned identity/space/checkpoint handle at fixed committed S. Join/pull use WP1 snapshotToken/cursor and nextCursor as sole
checkpoint continuation, never inline join operations or another checkpoint DTO. Normal pull
keeps highWatermark fixed across pages, throughSequence is its committed continuation and
hasMore signals remaining bounded tail. Null space discovers
credential-bound space; different published space returns space_mismatch. Never mutate an
immutable operation space/digest. Persist first intent IDs before materialization; replays use
same assignment. Tail pull after S precedes materialize/push; keep old published spaces separate.

Prepare consistent bounded snapshot: current heads, unresolved conflict, still-valid revert
inputs, all permanent tombstones/suppressions/identities/fences, compact receipts/report guards
and causal boundary, not all history. Reuse WP1 validation and combined page count/byte bounds:
<=100 total records, checkpoint/pull envelope <=262144 bytes. Fixed page identity/ordering and S stay stable; forget may only redact payloads and invalidate
metadata, never introduce stale text or renumber records. Fixed pages durable, no SQL lock
held across HTTP. Member token pins needed tail from S for 600s FROM FIRST ISSUE; retry never
extends expiry. One handle/member, <=128/hub, <=128 MiB staging including the next publication reservation
and retained published/pinned pages (§5.1). Expired/replaced token discards
partial staging and rejoins; no partial install. Preparation bounds are hub admission, not
replica quota reapproval. Token is not credential. Authorization/version is checked on pages.

Forget after S immediately scrubs staged payloads/response references; serve safe blocked or
source_invalidated metadata/null revision payloads without forgotten text and send later
canonical tombstone through tail. Pages remain ordinal/continuation coherent and complete.
Stage all replica pages; completeCheckpoint atomically installs canonical state/boundary/
receipts/deferred/cursor=S, preserves local intent/newer tombstone, then marks bootstrap ready.
FTS/export/report readiness is not bootstrap barrier; true canonical durable write is.

### 7.2 M20 canonical settlement and fault boundaries

Normal page validates bound identity/space/config epoch/protocol/codec/ordered sequence/digest
and DAG integrity before writes; canonical payload/receipt/frontier/delete/suppression/minimal
claim marker/deferred/cursor commit together. Metadata-only rejection or purged revision gets
its own receive branch, no fake body. Approved collision with an unapproved local intent
preserves local text for bounded review and incorporates approval; contradictory approved
identity/digest is protocol error. Canonical tombstone discards late payload while preserving
original accepted outcome/digest. ACK and pull share settlement irrespective of order.

| Activation                                                                    | Recovery and observable boundary                                                                                                                     |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Damaged/truncated page, transport failure                                     | No commit/cursor movement; same cursor bounded retry.                                                                                                |
| Unsupported protocol/codec, wrong auth/space/hub/epoch                        | Safe error, no writes/skip; reconnect/config/credential correction.                                                                                  |
| Contradictory approved identity/digest/DAG                                    | Whole page rollback; valid fresh checkpoint recovery, stop repeated unrecoverable retry; local unapproved collision goes to review instead.          |
| SQLITE_BUSY/transient canonical write                                         | Same page retry, no capacity-refused approval.                                                                                                       |
| ENOSPC/corruption/persistent durable failure                                  | Cursor stays; repair then identical retry or complete checkpoint. No progress promise without durable recording.                                     |
| Replica full quota/persisted physical brake/scanner/parent/FTS/report failure | Approval and cursor commit; processing held/deferred independently. Sequential approved upsert then later forget must still traverse ordinary pages. |

Pull proceeds after canonical commit/wakeup without drain wait. Existing WP2 fair drain scans
SQL order (due_at,last_attempt_at,memory_id,kind), caps MEMORY_DEFERRED_SWEEP_MAX_ITEMS/BYTES,
uses persisted capped exponential retry and excludes held rows. Healthy row behind failing/held
rows completes across restart. Coalesce latest generation, recheck tombstone before every write.
Missing-parent wakes on parent/checkpoint/restart; covered boundary is not missing ancestry;
actual unresolved ancestry triggers safe checkpoint recovery, not shared refusal. secret_detected
hold releases ONLY allowed current-generation policy-version rescan at Worker startup/policy
upgrade, no timer or explicit per-item rescan API. Suspected false positive is forgotten and
re-created. Body-free change signals emit only after commit; lost signals recover reset/restart.

### 7.3 Forget and suppression

Forget purges GOAT canonical bodies, held/staged/source payloads, resolution originals/judgment,
local intent and derived caches/FTS; preserves permanent body-free identity/digest/tombstone/
fence/source/content/extraction suppression. Provider original transcript stays; suppress
reimport/re-extraction, including confirmed aliases, not arbitrary paraphrase semantics.
Read fence is immediate; derived cleanup failure records cleanupPending and retries without
failing canonical delete or claiming physical purge complete. No new sync echo from receive.

Base deletion and excess suppression use separate immutable operation IDs/digests/receipts.
forgetExpansion and forgetRetryOf track pending/rejected/satisfied extension; rejected extension
cannot undo base success. Same-ID uncertain retries retain original bytes. New receipt/suppression
allocations obey hub budgets; existing-identity reserved first forget/cascade capacity remains
available. Unknown-ID rejected forget uses bounded body-free pending intent (max 2000), holds
received content with forget_pending, retries on identity/capacity/restart; intent cap/non-preserved
failure explicit. Local unchanged re-forget short-circuits before allocation; raced distinct ID
must get its own correlated result, not somebody else's receipt. Capacity refusal is satisfied
only by approved tombstone coverage; never equate pending/rejected extension with all-device done.

Preserve `115eeed2b`: repeated purge cancels content work but retains forget sync carrying delete
knowledge. forget_pending excludes every model/source/read/export/claim exposure. Preserve WP2
invalid summary cancellation and latest-source work regeneration, and `637b30327` renewWork per
provider call plus owned retryWork backoff on expiry. Late model/ACK/revert/bootstrap/rebuild
cannot resurrect purged payloads. Offline devices learn forget only on reconnect; already sent
provider context and backups are outside recall guarantees.

## 8. Source relay and composition

Eleven POST paths under `/api/memory-hub/v1`: join, push, pull, claim, renew,
apply-resolution, release, source-read/request, source-read/collect, source-read/respond,
source-read/result. Each HTTP handler authenticates bounded header, decodes bounded WP1 input,
calls ONE HubService method, encodes no-store response and maps safe errors. No body logging,
generic HTTP/MCP auth or raw orchestration helper. 401 unauthorized, 403 forbidden, 426
unsupported protocol, 400 invalid schema, 413 envelope too large, 503 hub_disabled; preserve
WP1 semantic error code, no defect/credential/source body leakage.

HubClient provides the same eleven typed calls without principal argument plus preflight;
HubService supplies principal on server side. Disabled constructs service but starts no network.
Source request stamps trusted requester/space/deadline; exact sourceThread.environmentId owns
read, never hostname or request override. requestId/digest retries share initial 75s deadline.
At most 32 live reads/requester, 128/hub, <=64KiB outcome and bounded <=32/64KiB collect.
Clean expired before admission, consumed results early. “Read the original on its device when
needed” means no shared or accumulating original archive; the existing M16 maximum 75-second
purgeable SQL relay buffer remains allowed. No transcript operation/log/checkpoint/
FTS/event/report; private cache payload tied to memory/revision and purged on forget/expiry.

Requester validates evidence-linked locators/watermark/current generation/live compound permit
before submission and after await. Owner collects only own requests after pull/tombstones and
answers each through ownerPermit. In WP3 the production ownerPermit is fail-closed: every
collected request receives the typed denied outcome, so the requester finishes and no original
leaves the owner. WP4 L6 replaces it with the A-lite policy (040 §3): the owner admits only
requester environments on its settings:write allowlist (default deny), the requester has checked
its caller's memory:read and explicit orchestration:read locally, and the hub stamps member,
locator digest and the immutable deadline; allowlist removal or credential revoke withdraws
access. Recheck member/policy/thread/delete before consistent committed
reader and response; fixed watermark, selected completed message IDs, no streaming/uncommitted
or beyond-watermark source. Scan before owner response/hub transient cache and requester return.
Only owner responds, only requester fetches; changed digest/locator/oversize response fails that
read only. Denied remains auth denial; offline/expired/missing owner returns source_unavailable;
suspicious result safely held within bounded TTL or secret_detected. Late/forgotten/revoked
results discarded. Local owner/hub uses same checks without network. No provider CLI, SSH,
HostThreads readOnHost, direct requester-owner connection or colliding local-ID fallback.

L5 injects the owner committed reader and the existing SyncService's authority seam once,
using service method ports to avoid cyclic module imports/layer construction. WP4 activates
MemoryService.readSource and live permit; transports remain thin. Thread shares summary +
ScopedThreadRef/watermark only. Worker private summary reader is not the source interface.

server.ts reuses layerMemoryQuota/layerMemoryService/layerMemoryWorker values and their one
memoization scope. Provide Hub/Client/Auth/Sync/Compactor through same app dependencies,
not per-handler ManagedRuntime. Start after migrations/settings/core readiness; scoped stop
interrupts pull/renew/registry. Keep CloudTaskSource.layer and existing routes. Mount HubHttp
as browser API sibling before static fallback. Descriptor advertises independent hub protocol
only when actual routes are ready; general memory capability remains absent until WP4, import
capability until WP5. Stable environment identity is never regenerated from endpoint.

## 9. M19 retention, storage and enforcement

Compactor is part of first release, not optional follow-up. Trigger earliest of daily interval,
10000 tail rows or 32MiB tail bytes. Detailed log retention is 30 days; tail cap 50000 rows/
64MiB. Replaced payload/resolution retention and revert window are 30 days from replacement/
resolution, not creation; pending accepted/revert/checkpoint inputs protect necessary history.
Bound current live/history bodies and lifetime IDs/compact receipts/import aliases/suppression
using exported MEMORY_* constants, no indefinite detailed JSON as dedup record.

Build complete recoverable checkpoint at S; durable publish S/boundary/F before safe contiguous
prefix cleanup older than retention. F is minimum valid afterSequence; equality valid. Pins and
protected inputs block unsafe deletion. If compaction cannot make space, hub new admission
refuses with capacity details; reserved forget still works. Hub ACK + recoverable checkpoint
suffice, not ACK from every offline member. Cursor<F -> cursor_expired -> checkpoint -> tail
pull -> review unapproved stale local edits (base_compacted), not refuse approved ancestry.
Real compactor must produce floor in CI; injected floors are supplemental. Forget overrides
payload protection and staged snapshots. Crash publication leaves old floor intact.

Quota readStorageStatus composes cached table/logical/allocation samples, counters/growth/FTS,
retention/checkpoint/last compaction/reclaimable/blocked reasons. Reuse WP2 30 completed UTC days
plus current sample, signed 1/7/30-day deltas, actual elapsed time, restart/missing/partial/null
semantics; no duplicate sample ring or remote-member allocation aggregation. dbstat unavailable
is explicit, never zero. Shared DB file/WAL/freelist remains shared. Freelist warning requires
both ratio and minimum bytes; no scan of all DB pages per status request.

Logical global admission, indexed-text hard cap and sampled physical local brake are separate.
Physical brake gates local creation and FTS work, not approved canonical receive, deletion or
other environments' hub admission. No VACUUM/auto_vacuum/max_page_count/file truncate or
memory-owned physical shrink. Derived failure keeps read fence/cleanupPending. Report received,
processing/exposure/index coverage/admission refusal separately; online+deferred valid.
MemorySyncStatus uses state, pendingSync/quarantined/parked, lastSuccessfulSyncAtUtc,
lastHubSequence/failureCode; no phase/failed/disconnected aliases. Received is not indexed,
visible, delivered report or fully physically purged.

| Boundary                          | Tier / executing owner                           | Known bypass and residual limit                                                                                         |
| --------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| New admission/lease/fence         | E6 HubService + Store transaction                | Direct local resolve/push bypass must be denied; host owner can replace code/DB. Replica merge never repeats lease CAS. |
| Membership/admin/source authority | E7 service post-lock/live permit/owner policy    | Cookie/session union, stale snapshots/alternate entry require activation tests; no recall of delivered bytes.           |
| Scanner and eligibility           | E5 scanner + every read/model/export consumer    | Unknown patterns remain possible; holds retain purgeable canonical body. No universal secret detection claim.           |
| Wire registration                 | E3 WP1 codecs/routes + reserved-key schemas      | Runtime generic updater/shared merger must also reject; schema alone is not final enforcement.                          |
| Tool-less generation              | E4/E5 existing WP2 runner policy                 | No E8 OS isolation promise; provider availability/failure remains typed.                                                |
| Retention/quotas                  | E6 counters + checkpoint/pins + E5 sampled brake | Measurement alone does not enforce global charges; actual durable write failure preserves cursor.                       |

Registry bypass inventory for independent review: direct service resolve, generic Worker due/
claim/retry/execute/recovery, DrainableWorker delegate, manual SQL repair, MCP/RPC/agent/scheduled
entry, accepted receive/checkpoint and local accepted-commit. Every new resolution reaches registry
then hub admission; approved incorporation is repair, not another model execution. Client hints
are E2 availability only; enforcement wording follows 000, not UI promises.

## 10. Lanes, file ownership and integration

One WP3 PR; lanes are bounded implementation children, not separate PRs. `S/` and `C/` abbreviations
remain as above. Each matching test belongs to its source owner. No lane edits another lane's
files; interface gaps go to L1/coordinator. MemoryWorker.ts and provider implementations are
read-only in WP3; joint-start test consumes actual Worker unchanged.

| Lane                             | Exclusive NEW / MODIFY files                                                                                                                                                                                                                                                                    | Dependency and risk                                                                                                                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L1 SQL/domain                    | MODIFY S/memory/{MemoryStore,MemoryService,MemoryDecider,MemoryQuotaService}.ts and corresponding four .test.ts; NEW S/persistence/Migrations/072_MemoryHubSync.ts/.test.ts; MODIFY S/persistence/{Migrations,reconcileGoatMigrationIds}.ts and S/persistence/reconcileGoatMigrationIds.test.ts | First; owns all SQL/private codecs/signatures in §4, domain concurrency/settlement/metadata/recovery/producer/purge/global charges. Risks: local CAS leakage, double charging, early replay, split forget and fabricated body. |
| L2 hub/compactor                 | NEW S/memory/{MemoryHubService,MemoryCompactor}.ts and corresponding .test.ts                                                                                                                                                                                                                   | L1 frozen ports; membership/admin orchestration, lease/source/push/pull/checkpoint, real compaction. Risks: post-lock revoke, dual fences, pin/floor publication and permanent-tail duplication.                               |
| L3 auth/HTTP/settings/descriptor | NEW S/memory/{MemoryHubAuth,MemoryHubClient,MemoryHubHttp}.ts and corresponding .test.ts; MODIFY S/{serverSettings,ws}.ts/.test.ts, packages/shared/src/serverSettings.ts/.test.ts, S/environment/ServerEnvironment.ts/.test.ts                                                                 | L1 then L2 interface; bearer-only/preflight/eleven routes/dedicated settings CAS/recovery guards/descriptor. Risks: cookie union, early credential forwarding, recursive settings lock and partial activation.                 |
| L4 sync/registry                 | NEW S/memory/MemorySyncService.ts/.test.ts                                                                                                                                                                                                                                                      | L1–L3; registry internal to this file, finite sync/relay/candidates/frozen generation/ownership/recovery/cancel/status/shutdown. Risks: model wait, early slot return, uncertain approved replay and late epoch response.      |
| L5 integration                   | MODIFY S/server.ts; NEW S/memory/MemoryHubScenarios.test.ts; MODIFY this 030 and 000 WP3 cycle only; structure/{INDEX.md,server.md,manifest.json} only if module boundary changes, subject to coordinator scope                                                                                 | Coordinator after L1–L4; one core instance/startup/source-reader injection/CloudTaskSource and real H/A/B fixtures. Risks: duplicated layers, initial hub readiness, confusing source CI with packaged evidence.               |

For this rewrite ONLY 030 and 000 are writable; the above map describes future authorized
implementation, not permission to touch source/structure now. L1's concrete work list includes the versioned approval binary codec and maximum-size fixture
in MemoryStore.ts/.test.ts; unchanged aggregate resolution decode plus legacy read/forget/purge
fixtures; metadata approval settlement/checkpoint validation; frozen whole-claim persistence;
MemoryService.ts/.test.ts removal of local device-clock revert expiry (current line 608), with
skewed device clocks on both sides of the hub deadline; and MemoryQuotaService.test.ts
readEligibleOutbox consumers (current lines 416–418,478), changing `.id` to `.work.id` for
SyncWorkCandidate[]. L2 produces body-free operationKind/resolutionId metadata and hub-time
approval; L3's existing WP1 codec consumers validate it; L4 replays saved full claims before
current-default checks. These changes stay with the exclusive file owners above.
Contracts remain WP1-owned; §4.3 specifies the prerequisite L1-0 contract commit,
not lane permission to invent competing DTOs. Coordinator owns its integration before L1.

Integration order:

1. Coordinator verifies integrated WP2 `637b30327`/dev `637a98351`, freezes SHA and obtains
   architect reflection then independent A. WP2 D remains incomplete until its review/CI close.
2. L1-0 lands the §4.3 WP1 contract amendment first; L1 then lands interface/private codec/migration and focused fixtures; signatures, error mapping,
   transaction ownership and idempotent keys reviewed before consumer parallelism.
3. L2 and L3 proceed on disjoint files from L1; freeze HubService eleven-method interface before
   L3 consumer implementation. SQL fixes return to L1. No consumer inline SQL.
4. Integrate L2/L3; L4 consumes services and frozen ports without editing their files.
5. L5 composes once, implements real-store scenarios and reviews actual file collection.
6. Collect exact implementation-head PR CI steps/logs and independent review. M19 also needs
   same-SHA actual packaged backend off-host; no runtime CLOSED until required evidence exists.

## 11. Focused acceptance matrix (PR CI only, NOT RUN)

Paths below are exact future test targets; existing files are extended, new files collected by
server test shards. Use real SQLite/service logic and controlled auth/network/provider seams.
Race milestones use Deferred, persisted events, drain and TestClock; no sleep/poll/timeouts as
success evidence, no real provider/network/live state. All new rows are NOT RUN here. Additional rev 11a/11b activation rows below belong to the same
focused files and CI collection, not local execution.

| Owner / focused file                                                         | Activation -> observable assertion                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L1 MemoryQuotaService.test.ts + L2 MemoryCompactor.test.ts                   | Combined live/history/permanent-ledger encoded bytes at equality/+1; old published + new publication + pinned old pages coexist. Reject only new admission atomically; previously approved recovery and reserved forget succeed; rollback/replay never drift counters.                                                                                                   |
| L1 MemoryService.test.ts                                                     | Null-sequence capacity refusal for forget and revert, crash/restart before/after settlement: correlated terminal refusal/retry policy persists, no synthesized sequence, DAG/report approval or cursor movement.                                                                                                                                                         |
| L1 MemoryStore.test.ts + L4 MemorySyncService.test.ts                        | More than 100 ordinary due rows precede base forget + extension; actual HubClient sends base then extension before ordinary content. Fail transmission, restart, honor backoff and show unrelated due rows progress. Revert response lost -> durable retry -> restart sends identical ID/digest/payload.                                                                 |
| L1 MemoryStore.test.ts + L4 MemorySyncService.test.ts                        | Hub claim succeeds then crashes before local ticket storage; change current default P to Q or null, restart and recover identical full claim/attemptId/frozen provider/model/options and same lease before availability checks, register once. Candidate CAS loss never starts network.                                                                                  |
| L1 MemoryStore.test.ts + L4 MemorySyncService.test.ts                        | Same heads: a definitive claim refusal, a not-accepted definitive generation failure, or an attempt-cap end with the lease released retires the frozen claim by generation/attemptId CAS; with the default changed to Q the next attempt stores a new attemptId and Q. Counter-case: a lost response or uncertain submission never retires and replays the stored claim. |
| L2 MemoryHubService.test.ts + L1 MemoryDecider.test.ts                       | Deferred SQL lock wait crosses lease/deadline, then hub Clock read rejects expiry. Skewed/offline createdAtUtc cannot alter exact 30-day approval; replay/ACK/pull/checkpoint preserve times; forget immediately removes protected inputs.                                                                                                                               |
| L1 MemoryStore.test.ts + MemoryService.test.ts + L2 MemoryHubService.test.ts | Inject non-exact-30-day legacy resolution in a 071 DB; upgrade, aggregate read, forget and purge succeed. Hub activation refuses unsupported_protocol and approval cannot use the legacy row; no invented timestamps or changed operation/digest.                                                                                                                        |
| WP1 C/memory.test.ts + L1 MemoryService.test.ts                              | Purged approved resolve metadata missing approval or with mismatched resolutionId rejects independently; metadata upsert/revert carrying approval rejects. ACK/pull/checkpoint validate the same rules without bodies.                                                                                                                                                   |
| L1 MemoryStore.test.ts + MemoryQuotaService.test.ts                          | Measure approval-bearing binary codec maximum including version and worst legal fields, assert maximum equals encoding bound and cap equals maximum plus recorded headroom. Old approval-free/mixed rows decode and retain actual byte charges; approval round trip and cap equality/+1 hold.                                                                            |
| L1 MemoryService.test.ts + L2 MemoryHubService.test.ts                       | Device clock beyond the deadline while hub time is still valid stages revert and hub accepts; device clock before the deadline while hub time is expired stages intent but hub rejects at equality/after. Local staging never device-clock rejects; approved receive never re-admits expiry.                                                                             |
| L1 static type fixtures in focused CI                                        | transact/withReceivedCursor discharge Transaction while preserving unrelated service R; runtime tag stays private.                                                                                                                                                                                                                                                       |
| L5 MemoryHubScenarios.test.ts                                                | A resolves, B reverts: only B delivers reverted report once across ACK/pull/checkpoint/restart; A keeps guard only; pending/rejected revert delivers none.                                                                                                                                                                                                               |

| Lane / focused test files                                                                                                                                              | Activation -> observable assertion                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 S/memory/MemoryDecider.test.ts                                                                                                                                      | Common parent H/A/B sibling pushes -> all admitted/quarantined heads; local stale CAS still revision_changed; resolve exact-head and revert guards still enforced. Cross-memory/cycle and below-boundary unapproved parent refuse.                                                                                                                  |
| L1 S/memory/MemoryStore.test.ts                                                                                                                                        | Upgrade/private codecs; lease + identity fence atomic rollback; member rotation while waiting; hub-local existing event still receives one sequence; metadata rejected/purged/tombstone records no fake body; partial checkpoint/crash no partial install.                                                                                          |
| L1 S/memory/MemoryService.test.ts                                                                                                                                      | ACK→pull, pull→ACK, response loss/restart and duplicate approval -> one compensation/receipt promotion/terminal revert, no echo. Canonical quota full/secret hold/missing parent still moves cursor; contradictory approval rolls page back; unapproved ID collision goes to review.                                                                |
| L1 S/memory/MemoryQuotaService.test.ts                                                                                                                                 | Hub tail/member/lease/relay/retention/staging charged transactionally with canonical payload once; equality/overflow, first-forget reserve, unknown-ID cap and suppression expansion; persisted braked replica accepts approval. Status includes five hub tables/growth/unavailable allocation.                                                     |
| L1 S/persistence/Migrations/072_MemoryHubSync.test.ts; S/persistence/reconcileGoatMigrationIds.test.ts; migration registration assertions in 072_MemoryHubSync.test.ts | 071 upgrade/replay/stable name/slot reconciliation -> five bounded tables, unique space keys and indices; no second local inventory; old rows retained and constraints enforce safe fences.                                                                                                                                                         |
| L2 S/memory/MemoryHubService.test.ts                                                                                                                                   | Race claims/skewed member clocks -> one active token; exactly expiry takeover/600s cap/stale release/head/forget/revoke -> no stale commit. Batch semantic failure commits siblings; replay same digest same sequence, changed digest refuses. Admin secret/SQL/settings interruption -> stable resumable receipt, no partial credential exposure.  |
| L2 S/memory/MemoryCompactor.test.ts                                                                                                                                    | Real TestClock trigger publishes checkpoint/floor then safe-prefix deletion; F equality valid; crash prior publish keeps old floor; token pin/protected revert blocks unsafe cleanup; actual token expiry releases pin; full uncompactable tail refuses new admission but forget proceeds; compact receipts replay after tail removal.              |
| L3 S/memory/MemoryHubAuth.test.ts                                                                                                                                      | Missing/cookie/dev/MCP/invalid bearer -> no writes; valid bearer+foreign cookie -> only member principal; post-lock revoked version denied.                                                                                                                                                                                                         |
| L3 S/memory/MemoryHubClient.test.ts                                                                                                                                    | Wrong identity/no v1/redirect/unsupported route -> zero credential forwarding; loopback/HTTPS endpoints; deadline/retry/size/schema/epoch errors safe and bounded; all eleven codecs.                                                                                                                                                               |
| L3 S/memory/MemoryHubHttp.test.ts                                                                                                                                      | Eleven routes round-trip principal/no-store; disabled 503, auth 401/403, protocol 426, bad schema 400/oversize 413; requester/owner mismatch fails source route only; no logging bodies.                                                                                                                                                            |
| L3 S/serverSettings.test.ts; packages/shared/src/serverSettings.test.ts; S/ws.test.ts                                                                                  | Own memoryHub/version mixed patch in both generic entry points/merger -> atomic denial before side effects, declared ServerSettingsError. Dedicated CAS retry/version conflict, old-file defaults, complete mode replacement, stage failure/recovery, only secret reference. WP4 later tests live dedicated RPC success.                            |
| L3 S/environment/ServerEnvironment.test.ts                                                                                                                             | Actual ready hub routes -> independent protocol advertisement; disabled/unready no false readiness, general memory/import absent, stable identity retained.                                                                                                                                                                                         |
| L4 S/memory/MemorySyncService.test.ts                                                                                                                                  | start alone and syncOnce alone after pulled conflict start real TextGeneration via Deferred, no manual schedule call; candidate/ticket crash/registration failure recover with CAS, claim_busy retry TestClock, five conflicts peak<=4 and fifth after finalizer; real Worker joint-start generic resolve execute=0.                                |
| L4 same file                                                                                                                                                           | Block generation, next SAME-environment sync moves unrelated inbound/outbound/cursor; shutdown interrupts renew/model, matching bounded release, slots cleared/no late output. Settings epoch old response discarded; known approval repairs without generation; stable uncertain submission replay.                                                |
| L4 same file                                                                                                                                                           | First hub published=1 before materialization; partial/expired member bootstrap push barrier; stable assigned IDs; fixed watermark/max ten pages/1000 entries per sync and byte bounds; offline retries survive restart. Deferred healthy row behind failed/held completes within caps and across restart; policy-version-only scanner hold release. |
| L4 same file                                                                                                                                                           | Relay request restart same ID until 75s deadline; consumed/expired cleanup; per-read grant/scanner/owner failure leaves unrelated push/pull moving; body-free foreign change publishes after cursor/checkpoint commit.                                                                                                                              |
| L5 S/memory/MemoryHubScenarios.test.ts                                                                                                                                 | H/A/B real stores fork common parent including hub local write, race automatic claims -> one accepted result with all parents and requested/effective six-provider envelope provenance. Default settings change mid-run leaves frozen model/options; unavailable provider no fallback.                                                              |
| L5 same file                                                                                                                                                           | Third variant invalidates paused resolution; takeover at hub exact 120s rejects old output; renewal failure/600s cap leave quarantine; unrelated memory sync progresses through each case.                                                                                                                                                          |
| L5 same file                                                                                                                                                           | H approves resolve A/B; C unsent descendant of A pulls BEFORE push -> H result present, frontier result+C, cursor/sibling advance; later push forms hub conflict, descendant parent known. Repeat approved revert and forget, no body resurrection.                                                                                                 |
| L5 same file                                                                                                                                                           | Offline pending revert T, H accepts U, C restart/pull/push rejection -> frontier U only, no T descendants/revert report/repeated claim loop; lost accepted ACK repaired once only at revert submitter.                                                                                                                                              |
| L5 same file                                                                                                                                                           | Forget vs offline edit/import/revert/late model/checkpoint/rebuild -> all purged after drain and permanent suppression retained; base+extension refusal/uncertain retry distinct statuses; repeated purge retains forget sync; forget_pending never reaches model/source. Summary renew/retry joint fixture keeps existing WP2 behavior.            |
| L5 same file                                                                                                                                                           | A→H→B→H→A source page, B sole synthetic source/A colliding thread -> B watermark/text only; no A transcript read or transcript operation/checkpoint/FTS. Offline B exact 75s -> unavailable; revoke/forget during read/result -> payload purge and late discard.                                                                                    |
| L5 same file                                                                                                                                                           | Run REAL compactor, offline third member cursor below produced F -> bootstrap+tail+bounded stale intent review. Floor equality, pin/expiry/protected history and post-checkpoint forget/rebuild preserve compact receipts/suppression.                                                                                                              |
| L5 same file + off-host exact-head packaged backend evidence                                                                                                           | Persist local brake, ordinary page approved upsert then later forget -> both original receipts/cursor retained, FTS deferred then purge; SQLite dbstat/sample/unavailable/brake-release/restart/growth behavior observed in source CI AND packaged backend. Build alone never closes requirement 7.                                                 |

Implementation CI collects actual server shard test files and step logs, relevant shared tests
and static target files. A job conclusion without executed test step, cancelled/skipped job or
unrelated toolchain failure is not PASS. Reconcile actual TS diff against lint arguments and
compiler file collection; no copied historical 25-file coverage claim. This Mac runs no bun,
pnpm, vp test, vitest, e2e or whole build; this authoring slice runs no typecheck/lint/install.

## 12. Handoffs, risks and authoring verification

WP4 consumes stable space/bootstrap/sync status, non-wire authority/owner reader, dedicated hub
settings service and body-free change stream; it supplies live permits and public readSource,
RPC/MCP/provider snapshot activation. #171 cloud input/resume requires WP4 adapter review,
not WP3 edit. WP5 consumes established bootstrap/materialization and permanent suppression,
never immutable-space rewrite. WP6 consumes resolve-holder/revert-submitter report guards/delivery, split forget
status, accepted vs local processing, revert within 30 days and dedicated settings CAS.

Remaining implementation risks: dual domain/hub ledger atomicity and hub-local precommits;
partial administration across secret/SQL/settings; consistent staged checkpoint under forget;
registry uncertain submission/ownership recovery; exact checkpoint-delta sizing and compact-receipt
measured binary codec maximum/version compatibility and approval preservation; actual global tail admission vs samples;
packaged SQLite feature support. None needs a new product decision. Repeat reflection must scrutinize
these corrected frozen interfaces before parallel implementation; independent A and CI remain mandatory.

This rewrite changes only 030 and one r2 correction record in the WP3 cycle of 000.
Manual relative-file/anchor review and two-file fmt/check are the authoring verifiers, not
TypeScript or runtime proof. No PR creation, push, live server or provider state access.
Other plans are read-only: coordinator amends these exact current-baseline assumptions in the
owning phase. Signatures below are frozen future consumer seams, not baseline exports.
`Permit` is the repeatable live Effect in §4, mapped to MemoryAccessError/MemoryServiceError.

| Document:line -> consumer port                               | Replacement signature / behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Owning phase                                    |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 040:182 -> MemoryService mutation                            | upsert(M.MemoryUpsertInput, Permit), forget(M.MemoryForgetInput, Permit) -> Effect<Store.StoredReceipt, MemoryServiceError>; revertResolution(M.MemoryRevertResolutionInput, Permit) -> Effect<M.MemoryRevertResult, MemoryServiceError>. Remove applyOperation(input,permit); map live auth denial into typed service errors after lock.                                                                                                                                                                                                                                                                                                                                                                                          | WP4 consumes WP2/L1                             |
| 040:792–799 -> public readSource                             | readSource(input: M.MemoryReadSourceInput, permit: Permit) -> Effect<M.MemorySourcePage, MemoryServiceError>; compose prepareSourceRead -> authority.readSource -> validateSourceOutcome (§4.2). Available maps page; unavailable maps source_unavailable; auth remains denial, no unavailable conversion.                                                                                                                                                                                                                                                                                                                                                                                                                         | WP4 activates; L1 definitions/L4 authority      |
| 040:639 -> MemorySyncService settings/status                 | getHubSettings(input: M.MemoryHubSettingsGetInput, permit: Permit) -> Effect<M.MemoryHubSettingsView, Hub.MemoryHubServiceError>; updateHubSettings(input: M.MemoryHubSettingsUpdateInput, permit: Permit) -> Effect<M.MemoryHubSettingsUpdateResult, Hub.MemoryHubAdministrationError \| MemoryAccessError>; syncStatus(input: M.MemorySyncStatusInput, permit: Permit) -> Effect<M.MemorySyncStatus, Hub.MemoryHubServiceError>. Hub.MemoryHubServiceError = MemoryServiceError \| M.MemoryHubError \| M.MemoryHubUnauthorizedError \| M.MemoryHubForbiddenError; administration adds Secrets.SecretStoreError. settings:write for settings, memory:read for status; dedicated CAS §5.3, storage assembled by readStorageStatus. | L3 settings core/L4 wrappers; WP4 RPC/MCP       |
| 040:206 / 050:23,327 -> MemorySyncService local readiness    | readLocalReadiness() -> Effect<{ memorySpaceId: Space \| null; bootstrap: "unbound" \| "staging" \| "ready" }, Hub.MemoryHubServiceError>; requireBootstrap(space: Space) -> Effect<void, Hub.MemoryHubServiceError>. Read persisted settings/bootstrap together, no network; absent/not ready -> bootstrap_required; bootstrapped offline remains pendingSync.                                                                                                                                                                                                                                                                                                                                                                    | L4 produces; WP4 snapshot/WP5 import consumes   |
| 050:74,472 -> MemoryService.resolveProjectKey                | resolveProjectKey(space: M.MemorySpaceId, project: M.ScopedProjectRef) -> Effect<M.MemoryProjectKey \| null, MemoryServiceError>; use readiness space + captured binding version, null -> scope_unmapped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | WP5 correction; WP2 existing port               |
| 060:810–824 -> MemoryService.forget/revertResolution/history | forget(input, Permit) -> Effect<Store.StoredReceipt, MemoryServiceError>; revertResolution(input, Permit) -> Effect<M.MemoryRevertResult, MemoryServiceError>; history(input: M.MemoryHistoryInput, permit: Permit) -> Effect<M.MemoryHistoryPage, MemoryServiceError>. Split base/extension receipts separately; history.revertResults owns pending/terminal/rejected/accepted status. Null-sequence refusal is terminal local settlement, no fabricated approval; visible compensation uses localAvailability.                                                                                                                                                                                                                   | L1/L4 persist; WP6 presentation                 |
| 060:817 -> reconcileResolutionReportTx / report delivery     | reconcileResolutionReportTx({record: M.MemoryCompactReceipt, localEnvironmentId: Env}) -> InTx<{reportId: M.MemoryReportDelivery["reportId"] \| null; deliverable: boolean}>. Resolve owner = claim holder; accepted revert owner = revert operation origin, not original resolver. Same guard/key on ACK/pull/checkpoint; pending/rejected never success.                                                                                                                                                                                                                                                                                                                                                                         | L1 guard/L4 reconciliation; WP6 report consumer |

## Superseded and folded rules

This table maps 26 prior rule groups to their current normative sections; it is not an audit
narrative. The body above is the sole WP3 implementation plan. Unlisted unchanged requirement
IDs remain governed by 000 M1–M20, not by a restored historical appendix.

| Previous revision item                            | Current rule / section                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| rev 2 competing DTOs / WP1 ownership              | §3–4, §8: existing wire schemas only, private server ports explicitly proposed.                                                                                                                                                                                                                                                                                                                              |
| rev 2 cursor/UTC/checkpoint/metadata fields       | §4–5, §7: UTC wire/integer hub SQL, complete canonical cursor settlement and metadata ingest.                                                                                                                                                                                                                                                                                                                |
| rev 2 administration/identity/readiness           | §5.3, §8: dedicated versioned settings, independent hub advertisement.                                                                                                                                                                                                                                                                                                                                       |
| rev 2 resolver-only report repair                 | §4.1, §6: one existing report-key algorithm, body-free guards and resolver-local delivery.                                                                                                                                                                                                                                                                                                                   |
| rev 3 G3 foreign change publication               | §7.2–7.3: body-free post-commit signals, reset/restart recovery, no second publisher.                                                                                                                                                                                                                                                                                                                        |
| rev 3 G4 source SQL/lifecycle                     | §4, §5.1, §8: transient purgeable bounded relay, permanent ledgers untouched.                                                                                                                                                                                                                                                                                                                                |
| rev 3 G4 four routes/authority/reader             | §4.2, §8: eleven bearer paths, injected committed owner reader + live compound grant.                                                                                                                                                                                                                                                                                                                        |
| rev 3 G4 per-read failure/forget races            | §7.3, §8, §11: 75s cap, late discard; sync continues.                                                                                                                                                                                                                                                                                                                                                        |
| rev 4 B2 automatic claim scheduling               | §6–7, §11: start/syncOnce public activation, durable candidates and recovery.                                                                                                                                                                                                                                                                                                                                |
| rev 4 B2 backoff/epoch/slots                      | §6: bounded persisted retry, app-scope epoch/CAS, four slots through finalizer.                                                                                                                                                                                                                                                                                                                              |
| rev 4 B4 pull-before-push divergence              | §5.2, §7.2, §11: approved ancestry merged, local unsent frontier quarantined.                                                                                                                                                                                                                                                                                                                                |
| rev 4 B5 generic settings rejection               | §5.3, §11: two runtime entry points/shared merge, declared WS error, dedicated internal CAS.                                                                                                                                                                                                                                                                                                                 |
| rev 4 B7 enforcement wording                      | §9 and 000 inventory: E6 admission/E7 grants/E5 exposure, no E8 promise.                                                                                                                                                                                                                                                                                                                                     |
| rev 4 B8 static coverage receipt                  | §10–11: actual diff/collection checked in implementation CI; historical 25-path count replaced.                                                                                                                                                                                                                                                                                                              |
| rev 5 G1 pending revert receipt                   | §4, §6–7, §11: common ACK/pull settlement, rejected intent never DAG/report success.                                                                                                                                                                                                                                                                                                                         |
| rev 5 G2 registration-before-completion           | §6: schedule returns ticket+registration, no model wait, bounded shutdown/finalizer.                                                                                                                                                                                                                                                                                                                         |
| rev 7 M19 checkpoint/floor/tail                   | §5.1, §7.1, §9: first-release real compactor, finite tail, safe publication and cursor equality.                                                                                                                                                                                                                                                                                                             |
| rev 7 M19 token/member/staging/relay caps         | §5.1, §7.1, §8–9: immutable expiry, pin, global bounded admission.                                                                                                                                                                                                                                                                                                                                           |
| rev 7 M19 approved vs unapproved                  | §5.2, §7.2, §9: hub-only admission, replica accounts without reapproval, base_compacted review.                                                                                                                                                                                                                                                                                                              |
| rev 7 N1 registry-only recovery                   | §3–4, §6, §11: new registry CAS/submission ports; Worker pinned-resolve assumption replaced by TextGeneration.                                                                                                                                                                                                                                                                                               |
| rev 7 N1 bypass inventory                         | §9, §11: every direct/generic/manual/transport entry reviewed and joint-start tested.                                                                                                                                                                                                                                                                                                                        |
| rev 7 N2 status/growth                            | §3–4, §9: new assembler replaces nonexistent WP2 readStorageStatus; existing samples/growth/FTS reused.                                                                                                                                                                                                                                                                                                      |
| rev 7 N2 source/packaged evidence                 | §1, §11: exact-head source CI AND same-SHA actual packaged backend off-host; no completion claim.                                                                                                                                                                                                                                                                                                            |
| rev 7 audit cursor-stop + rev 8 M20               | §7.2, §9, §11: normal sequential braked upsert→forget replaces replica capacity refusal/drain barrier.                                                                                                                                                                                                                                                                                                       |
| rev 10 R6 fairness                                | §7.2, §11: SQL order/caps/backoff/restart; healthy row behind failures/holds completes.                                                                                                                                                                                                                                                                                                                      |
| rev 10 R7 hold release                            | §7.2, §11: only policy-version rescan; no per-item explicit rescan API.                                                                                                                                                                                                                                                                                                                                      |
| rev 11a: R1 G-1 checkpoint reservation            | §4–5.1, §7.1, §9, §11: encoded combined state and retained old/new pages reserved atomically.                                                                                                                                                                                                                                                                                                                |
| rev 11a: R1 G-2 authoritative time                | §4, §4.3, §5.2, §6, §11: post-lock clock, immutable receipt approval, L1-0 and decider replacement.                                                                                                                                                                                                                                                                                                          |
| rev 11a: R1 G-3 / A1 #3 forget priority           | §4.1, §7, §11: LIMIT-before selection priority, persisted retry and restart transport proof.                                                                                                                                                                                                                                                                                                                 |
| rev 11a: A1 #1 / #2 ACK and retry                 | §4–4.1, §7, §11: receipt/reference ACK, null-sequence refusal and sync/revert ownership retry.                                                                                                                                                                                                                                                                                                               |
| rev 11a: A1 #4 / #5 Tx and claim                  | §4–4.1, §6, §11: Transaction discharge and pre-claim candidate attempt CAS.                                                                                                                                                                                                                                                                                                                                  |
| rev 11a: A1 #6 / R1 relay clarification           | §6, §8, §12: precise phase handoffs/revert report owner and bounded M16 relay interpretation.                                                                                                                                                                                                                                                                                                                |
| rev 11b: A2 #1 storage compatibility              | §4.3, §5.1, §10–11: unchanged MemoryResolution decode; exact 30 days only at approval boundaries; undeployed 071 needs no resolution migration; synthetic legacy read/forget/purge remains safe.                                                                                                                                                                                                             |
| rev 11b: A2 #2 metadata validation                | §4.3, §10–11: required body-free operationKind and resolve-only resolutionId; independent approval presence/kind/id checks after purge.                                                                                                                                                                                                                                                                      |
| rev 11b: R2 G-4 frozen claim recovery             | §4–4.1, §5.1, §6, §10–11: persist/return full MemoryHubClaimInput; saved claim replay precedes current-default checks; P→Q/null crash fixture.                                                                                                                                                                                                                                                               |
| rev 11b: R2 codec/local revert; A2 quota consumer | §4.3, §6, §10–12: measured versioned binary maximum/headroom, old-row accounting/mixed decode, local device-time guard removal and SyncWorkCandidate.work.id test consumers.                                                                                                                                                                                                                                 |
| rev 11c: A3 #1 claim retirement                   | §4, §5.1, §6, §11: only definitive outcomes retire a frozen claim via transitionResolutionTicketTx retireClaim CAS and bump generation; uncertain submissions replay; retire-then-Q fixture.                                                                                                                                                                                                                 |
| rev 11d: L1 coordinator decisions                 | §4, §4.3: auth errors on source relay and checkpoint page ports; checkpoint validation accepts forget-created identities and refusal-only receipts.                                                                                                                                                                                                                                                          |
| rev 11e: L1 report guard transport                | §4.3: optional compactReceipt on the metadata entry arm, matched against the receipt, used for first-receipt report ownership.                                                                                                                                                                                                                                                                               |
| rev 11f: first hub configure                      | §4: a null-space hub configure allocates a request-stable space and activates the self member and initial publication before the locked settings apply; an authorized CAS retires a conflicting activated configure; successors inherit interrupted bindings; retries validate bindings before retiring anything.                                                                                            |
| rev 11f: committed hub settings                   | §4, §8: hub reauthorization inside SQL transactions reads a committed settings snapshot published at file commit, never the reloading settings cache; the watcher publishes only valid hub projections, so invalid, partial or missing external files keep the last valid hub epoch.                                                                                                                         |
| rev 11f: recovery and staging fences              | §4.1, §5: recovery keeps tickets on the current frontier and sweeps bounded rowid cycles with frozen tails; bootstrap pages and completion are fenced by staging identity, so a discarded stage cannot overwrite a new join.                                                                                                                                                                                 |
| rev 11f: unreleased migrations                    | §10: 071 and 072 are unreleased (origin/dev ends at 070), so they are edited in place until the stack merges; startup refuses incompatible intermediate memory databases before ledger mutation; reset only the sandbox memory development state through an approved procedure.                                                                                                                              |
| rev 11g: source relay in WP3                      | §8: production composition supplies a fail-closed owner source-read permit; an owner denial is answered with the typed denied outcome so the requester finishes. Requester attestation, the owner's delegated read policy and memory.readSource activate in WP4, which also owns the source relay scenario.                                                                                                  |
| rev 11g: hub device and recovery                  | §6, §7.1: the hub machine is also a member; in hub mode the coordinator bootstraps its own replica through the local HubService with the self member. Permanent holds are released only by real observations: a bounded backoff probe calls the hub (never for authorization), and persisted hold classes are rediscovered at start and on epoch change.                                                     |
| rev 11h: WP4 handoff corrections                  | §8, §12: §8 states the shipped fail-closed WP3 ownerPermit and assigns the successful relay (A-lite allowlist, requester grant check, revoke and epoch fence) to WP4 L6. §12 error channels match the shipped MemorySyncService: readiness, status and getHubSettings fail with Hub.MemoryHubServiceError; updateHubSettings with Hub.MemoryHubAdministrationError or MemoryAccessError. No WP3 code change. |
