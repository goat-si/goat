# 010 — WP1: memory contracts and compatibility (rev 12)

Enforcement limits and claim wording: [000 Enforcement inventory](000_plan.md#enforcement-inventory). Audit r1 rev 4 amendments supersede incompatible rev 2/3 recipes.

## Purpose and inputs

Define the memory protocol before any environment persists, syncs, imports, or injects memory.
This is an implementation PRD, not an implementation record. Citation baseline refreshed on
2026-10-14 after `git fetch origin dev`: `origin/dev` and remote `refs/heads/dev` both
`b5f9d53cbc29eddf7bad5518bb7d46c4f97173f5`. All current source citations below use this SHA.
The authoring branch is `goat/memory-wp1-contracts`, HEAD
`fea6178b36d11e0a446323344a2db67fb76c5d03` (WP0 plans); source evidence is read with
`git show origin/dev:<path>` / `git grep … origin/dev`, not assumed from this older checkout.
The previous citation baseline was `1e2418fafb625604de1eb89250a10d971bcfd0fe`.
No checkout, merge or rebase is performed by this stale-check lane.

Consumes [000_plan.md](000_plan.md), especially its decision dispositions, Shared names and
work-phase map, and [001_architect_proposal.md](001_architect_proposal.md), M1–M18. WP0 names
win over proposal shorthand (`MemoryProjectKey`, not `ProjectKey`). WP0's M10 amendment wins
over the proposal's initial provider restrictions: all six providers must support resolution
and summary at first release. Optional methods in this intermediate PR are an assembly seam,
not a release exemption. No preceding runtime implementation is assumed. This document is the single owner of all memory wire contracts; consumer documents name these schemas instead of defining alternatives.

The result is one contracts PR with executable schemas, explicit payload boundaries, method
shapes, permission declarations, provider input types, and focused tests. It must typecheck
against today's providers and clients without advertising a working feature. SQLite ownership,
atomic commits and post-commit work follow `docs/internals/overview.md:53–71`; transports call
services rather than implement workflows (`docs/internals/effect-services.md:11–22,95–103`).

Acceptance: every Shared name below has a schema or exported type; ordinary RPC cannot forge
hub resolution authority; legacy descriptors, sessions, settings and persisted provider
capabilities still decode; omitted memory grants deny; payload-bearing wire encoders are
allowlists; focused tests are written and pass on the exact PR head in goat-ci. Local checks
are targeted typecheck/lint only. WP1 neither starts a server nor activates memory tools.

## File change map for the implementation PR

Original phase-author deliverable was this Markdown file; rev 2 reconciles the seven allowed plans. The following map describes
future WP1 implementation changes, not files edited while writing the plan.

| Action | Exact path                                                          | Reason                                                                                                                                                                                                                                                       |
| ------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| NEW    | `packages/contracts/src/memory.ts`                                  | Eight ids (including transient source request id), schemas, payload/metadata separation, RPC/MCP/hub shapes, generation inputs/results and execution envelopes, import/admin/report schemas, protocol constants, pure validation and explicit wire encoders. |
| NEW    | `packages/contracts/src/memory.test.ts`                             | Round-trip, rejection, byte/character limits, metadata-only deletion, DAG structural checks and endpoint shapes.                                                                                                                                             |
| MODIFY | `packages/contracts/src/index.ts`                                   | Export `./memory.ts` from the root; preserve existing subpath exports and use `@goat/contracts` imports, not an undeclared `@goat/contracts/memory`; root export is the existing public convention at `index.ts:1–9,34–35`.                                  |
| MODIFY | `packages/contracts/src/auth.ts`                                    | Three scopes and standard client read/write grants; leave legacy parents frozen and sync out of client/admin default grants.                                                                                                                                 |
| MODIFY | `packages/contracts/src/auth.test.ts`                               | Permission compatibility and default grant assertions.                                                                                                                                                                                                       |
| MODIFY | `packages/contracts/src/environment.ts`                             | Optional memory protocol advertisement in `ExecutionEnvironmentCapabilities`.                                                                                                                                                                                |
| MODIFY | `packages/contracts/src/environment.test.ts`                        | Absent/unsupported version behavior and old descriptor decode.                                                                                                                                                                                               |
| MODIFY | `packages/contracts/src/orchestrationV2.ts`                         | Optional independent memory capabilities in provider capabilities, preserving replay.                                                                                                                                                                        |
| MODIFY | `packages/contracts/src/orchestrationV2.test.ts`                    | Decode pre-memory capability events and independent delivery flags.                                                                                                                                                                                          |
| MODIFY | `packages/contracts/src/settings.ts`                                | Environment-owned `memoryHub` in `ServerSettings`; generic ServerSettingsPatch rejects it; dedicated MemoryHubSettingsUpdateInput owns administration.                                                                                                       |
| MODIFY | `packages/contracts/src/settings.test.ts`                           | Disabled default, whole-setting replacement, invalid endpoint/credential shape, settings scope.                                                                                                                                                              |
| MODIFY | `packages/contracts/src/channelCommon.ts`                           | Optional MemoryReportReference on ChannelMessageMeta; old messages decode unchanged.                                                                                                                                                                         |
| MODIFY | `packages/contracts/src/channelCommon.test.ts`                      | Report reference round-trip and omission/invalid-id rejection.                                                                                                                                                                                               |
| MODIFY | `packages/contracts/src/rpc.ts`                                     | Fifteen `WS_METHODS` entries and separate exported `WsMemoryRpcGroup`, with authorization middleware; defer merging into live `WsRpcGroup`.                                                                                                                  |
| MODIFY | `packages/contracts/src/rpc.test.ts`                                | Fifteen payload/result/error contracts; existing live group unchanged at WP1.                                                                                                                                                                                |
| MODIFY | `packages/contracts/src/clientRpcPermissions.ts`                    | Memory mutation guards, including import's extra filesystem-read scope.                                                                                                                                                                                      |
| NEW    | `packages/contracts/src/clientRpcPermissions.test.ts`               | Required scopes for each new mutation and import's two-scope branch.                                                                                                                                                                                         |
| MODIFY | `packages/provider-core/src/server/ProviderAdapter.ts`              | Optional `memoryContext: MemoryContextSnapshot` on turn input, separate from `appContext`.                                                                                                                                                                   |
| MODIFY | `packages/provider-core/src/server/textGeneration.ts`               | Optional typed `resolveMemoryConflict` and `generateMemorySummary` methods and re-exported input/result types.                                                                                                                                               |
| NEW    | `packages/provider-core/src/server/textGenerationContracts.test.ts` | Validate generation input/result schemas imported from contracts, preserving requested selection and refusing forged outputs.                                                                                                                                |
| MODIFY | `apps/server/src/mcp/McpInvocationContext.ts`                       | Add `memory` capability and optional authenticated grants carrier, whose absence means no memory access.                                                                                                                                                     |
| MODIFY | `apps/server/src/mcp/McpInvocationContext.test.ts`                  | Neutral missing-capability error and capability/grant independence.                                                                                                                                                                                          |
| MODIFY | `packages/provider-opencode/src/server/textGeneration.ts`           | Widen OpenCodeTextGenerationOperation with both optional method names in the same commit as the core interface; generation bodies remain WP2.                                                                                                                |
| MODIFY | `packages/provider-opencode/src/server/textGeneration.test.ts`      | Decode all existing and new error operation literals, and preserve old operations.                                                                                                                                                                           |
| MODIFY | `.github/workflows/goat-ci.yml`                                     | Add a provider-core test step under existing `matrix.task == 'test'`; that package currently has no explicit goat-ci test lane.                                                                                                                              |

DELETE: N/A, additive protocol. `baseSchemas.ts` is read but unchanged: its private
`makeEntityId` checks only trimmed nonempty strings (`baseSchemas.ts:307–319`); memory-specific
UUID validation belongs in `memory.ts`. `packages/contracts/package.json` is unchanged:
root imports resolve to `src/index.ts` (`package.json:9–13`); no new subpath is needed.
`textGenerationOperations.ts` is read but unchanged in WP1: `Operation = keyof
ProviderTextGeneration` expands immediately with optional keys (`textGenerationOperations.ts:32`), so WP1 also widens OpenCode’s closed error operation enum and checks every consumer below, including Pi and Muse. Neither has a closed operation enum to widen.
Prompt building and `fromRunner` bodies belong to [WP2](020_wp2_store_service.md).

## Schema implementation recipe

All schema and type names in Shared names are exported from `memory.ts`. Use namespace
imports from Effect subpaths; infer every runtime type as `typeof X.Type`. The snippets are
body skeletons to expand with the field tables and filters below, not instructions to leave
TODOs. No `Schema.Unknown` inside memory payloads, operations, errors or model results.

```ts
import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  EventId,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ScopedThreadRef } from "./environment.ts";
import { ProviderOptionSelection } from "./model.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const MEMORY_PROTOCOL_VERSION = 1;
export const MEMORY_CONTEXT_MAX_CHARS = 6_000;
export const MEMORY_CONTEXT_MAX_UTF8_BYTES = 24 * 1024;
export const MEMORY_CONTEXT_OUTER_FRAME = "<external_goat_memory></external_goat_memory>";
export const MEMORY_PAGE_MAX_ITEMS = 100;
export const MEMORY_PAGE_MAX_UTF8_BYTES = 64 * 1024;
export const MEMORY_PAYLOAD_MAX_UTF8_BYTES = 64 * 1024;
export const MEMORY_LEASE_MS = 120_000;
export const MEMORY_LEASE_RENEW_MS = 30_000;
export const MEMORY_RESOLUTION_ATTEMPT_MAX_MS = 600_000;

const uuid = Schema.String.check(
  Schema.makeFilter(
    (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s),
    { expected: "a lowercase UUID" },
  ),
);
export const MemoryId = uuid.pipe(Schema.brand("MemoryId"));
export type MemoryId = typeof MemoryId.Type;
// Repeat the same declaration/type pair for MemorySpaceId, MemoryRevisionId,
// MemoryOperationId, MemoryConflictId, MemoryResolutionId, MemoryImportSourceId.
// EnvironmentId / thread ids stay their existing brands; do not revalidate them as UUIDs.

export const MemoryProjectKey = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("repository"), groupingKey: TrimmedNonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("explicit"), sharedProjectId: TrimmedNonEmptyString }),
]);
export const MemoryScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user") }),
  Schema.Struct({ kind: Schema.Literal("project"), projectKey: MemoryProjectKey }),
  Schema.Struct({
    kind: Schema.Literal("thread"),
    thread: ScopedThreadRef,
    projectKey: Schema.optionalKey(MemoryProjectKey),
  }),
]);
export const MemoryAssertionKind = Schema.Literals(["fact", "inference"]);

export const MemoryProviderCapabilities = Schema.Struct({
  snapshot: Schema.Boolean,
  mcp: Schema.Boolean,
  resolveMemoryConflict: Schema.Boolean,
  generateMemorySummary: Schema.Boolean,
});
```

Use a canonical UTC timestamp schema in this module: `Schema.String.check(Schema.makeFilter(
s => Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s,
{ expected: "a canonical UTC timestamp" }))`. Existing `IsoDateTime` is just `Schema.String`
(`baseSchemas.ts:47`); do not imply it validates timestamps. Hub deadlines use these timestamps
for transport and the hub clock for decisions. UTC creation times never decide edit precedence.

Use a `Schema.makeFilter` for unique arrays and cross-field checks. A sorted head set means
lexicographic ids, no duplicates; parents are unique but need not be sorted. Reject self-parent
and mismatched ids at decode, encode and `.make`, not just transport decode. These are structural
checks; ancestry, source existence, authorization, secret detection and lease validity require
stateful services in later phases. Every memory struct enforces `onExcessProperty: "error"` inside its Effect 4 declaration,
including default decode, encode, `.make`, and RPC-derived JSON codecs. An annotation
cannot override Effect 4 parse options. Callers must not have to supply strict options. Known malformed records fail;
do not use `ForwardCompatibleArray` to silently drop mutation or sync operations. Its dropping
behavior (`baseSchemas.ts:128–156`) is appropriate for permission advertisement, not a durable log.

### Strict memory model selection (rev 12)

`MemoryModelSelection` is the sole model selection schema in memory provenance, resolution,
lease/claim (`frozenDefaultModelSelection`), generation input (`modelSelection`) and trusted
execution (`requestedModelSelection`), including their nested operation/checkpoint forms.
Do not import `ModelSelection` or `ProviderOptionSelections` into these codecs: both accept
legacy input and the latter silently drops invalid legacy option values.

```ts
// Non-transforming: rejects leading/trailing whitespace instead of trimming it.
// TrimmedNonEmptyString, ProviderInstanceId and ProviderOptionSelection all trim on
// decode/encode (baseSchemas.ts:7-27, model.ts:46-52, providerInstance.ts:53-55), so the
// memory boundary does not reuse them.
const MemoryCanonicalString = Schema.String.pipe(
  Schema.check(Schema.makeFilter((s: string) => s.length > 0 && s === s.trim())),
);
const MemoryOptionSelection = Schema.Struct({
  id: MemoryCanonicalString,
  value: Schema.Union([MemoryCanonicalString, Schema.Boolean]),
});
export const MemoryModelSelection = Schema.Struct({
  instanceId: MemoryCanonicalString.pipe(Schema.brand("ProviderInstanceId")),
  model: MemoryCanonicalString,
  options: Schema.optionalKey(Schema.Array(MemoryOptionSelection)),
});
export type MemoryModelSelection = typeof MemoryModelSelection.Type;
```

Add filters: <=100 options, unique option ids, and canonical nonempty strings (already trimmed,
not silently rewritten). Each option is exactly `{id:string,value:string|boolean}`; numeric,
null, object/array values, empty ids/values, duplicate ids and unknown nested keys fail.
Enforce strict parsing within each memory schema boundary, recursively including this
schema and option structs, even when default decoders or RPC-derived JSON codecs are used. No fallback, legacy union or coercion at decode/encode/`.make`.
Preserve option order, ids and values, including false, empty-array versus omitted options,
and the requested model alias; effective model resolution cannot overwrite requested selection.

WP2 explicitly converts settings `defaultModelSelection` to `MemoryModelSelection` before
pinning generation or claiming a lease; the runner converts the validated canonical value to
its existing provider input type without re-normalizing options. Validate raw persisted option
values before the permissive settings decoder can discard them. Valid legacy `{provider,model}`
and legacy option objects remain readable in existing settings/storage through existing codecs;
the memory boundary accepts their explicit server conversion only when every original option
has a valid string/boolean value and the provider maps to one configured instance. Ambiguous
routing, discarded/rewritten values or unconvertible options yield typed `MemoryRpcError`
`code:'invalid_output'` (safe message; no raw option data), no lease/generation dispatch.
Already-normalized settings cannot prove preservation of discarded raw values: reload/validate
raw source or fail the conversion, never treat the normalized empty options as proof of validity.
WP1 does not alter the existing stored-data decoder or migrate legacy settings/rows.

Commit 1 fixtures in `memory.test.ts`: `rejects legacy and malformed memory model options`
(object `{effort:123}`, numeric/null/object array values, provider-only input, unknown keys,
duplicate ids and noncanonical strings such as `{id:" effort ",value:" max "}` or a padded
instanceId/model, each rejected by decode, encode and `.make` without being trimmed); `preserves canonical memory model options round-trip`
(string plus true/false values, omitted/empty options and aliases). Commit 2 embeds these cases
in claim/lease, generation, resolution and provenance checkpoint round-trips. WP2 owns conversion
behavior fixtures proving invalid raw settings fail before execution and valid legacy conversion
preserves every option; these are planned tests, not results from this documentation lane.

### Complete field inventory

An unmarked field below is required. `?` means `Schema.optionalKey`; `| null` means
`Schema.NullOr`. Define every named helper schema below in the same file, with inferred types.
Arrays are ordinary `Schema.Array` plus the specified filters. Strings are trimmed/nonempty
unless explicitly stated otherwise. Additive helper names do not replace Shared names.

| Schema                    | Fields and constraints                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MemorySourceWatermark`   | `fromEventId: EventId`, `toEventId: EventId`, `throughSequence: NonNegativeInt`; sequence is the owning environment's committed thread watermark, not a hub cursor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `MemoryEvidence`          | `origin: 'user'                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 'thread'                                                                                                                        | 'import'                                                                                                                                                                                                                                                                    | 'model'`, `sourceThread?: ScopedThreadRef`, `watermark?: MemorySourceWatermark`, `messageIds: MessageId[]`, `importSourceId?: MemoryImportSourceId`; thread origin requires thread+watermark, import origin requires source id. No transcript excerpt here. |
| `MemoryProvenance`        | `environmentId: EnvironmentId`, `providerInstanceId?: ProviderInstanceId`, `provider?: ProviderDriverKind`, `requestedModelSelection?: MemoryModelSelection`, `effectiveModel?: string`, `sourceThread?: ScopedThreadRef`, `sourceWatermark?: MemorySourceWatermark`, `importSource?: MemoryImportSourceMetadata`; model output requires requested/effective model and instance, thread source requires watermark. Fingerprint is opaque, not credential or filesystem path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `MemoryPayload`           | `text: string`, `evidence: MemoryEvidence[]`, `derivedFromMemoryRevisions: MemoryRevisionId[]`; nonblank text bounded by MEMORY_BODY_MAX_UTF8_BYTES, serialized UTF-8 payload bounded separately by MEMORY_PAYLOAD_MAX_UTF8_BYTES; `fact` needs at least one non-model evidence record. `inference` may have model evidence only, but never upgrades to fact by default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `MemoryRevision`          | `memorySpaceId`, `memoryId`, `revisionId`, `operationId`, `parents: MemoryRevisionId[]`, `scope: MemoryScope`, `payloadRef: MemoryRevisionId`, `assertionKind`, `provenance`, `createdAtUtc`; payloadRef equals revisionId. Contains no text, evidence excerpts or judgment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `MemoryTombstone`         | `memorySpaceId`, `memoryId`, `deleteOperationId: MemoryOperationId`, `deletingEnvironmentId: EnvironmentId`, `deletedAtUtc`, `suppressedSourceKeys: MemorySourceKey[]`, `suppressedContent: MemoryContentSuppression[]`, `sourceExclusions: MemorySourceExclusion[]`; no body or fingerprint-dependent suppression. Keys suppress changed versions of the same source too. The three arrays are bounded fragments; receivers retain their permanent union.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `MemoryConflict`          | `conflictId`, `memorySpaceId`, `memoryId`, `heads: MemoryRevisionId[]`, `status: 'quarantined'                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 'resolving'                                                                                                                     | 'failed'                                                                                                                                                                                                                                                                    | 'resolved'`, `failureCode?: MemoryFailureCode`; at least two unique sorted heads, failureCode required iff failed. No variant bodies.                                                                                                                       |
| `MemoryResolution`        | `resolutionId`, `memorySpaceId`, `memoryId`, `inputRevisionIds: MemoryRevisionId[]`, `inputPayloadRefs: MemoryRevisionId[]`, `judgmentRef: MemoryResolutionId`, `requestedModelSelection: MemoryModelSelection`, `effectiveProvider: ProviderDriverKind`, `effectiveModel: string`, `resolvingEnvironmentId: EnvironmentId`, `fencingToken: PositiveInt`, `resultRevisionId`, `appliedAtUtc`, `revertsResolutionId?: MemoryResolutionId`; at least two input ids, refs align by index, judgmentRef equals resolutionId. Judgment text stored separately and purged on forget.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `MemoryResolutionPayload` | `resolutionId`, `judgment: string`; concise decision explanation, never chain of thought, tools or raw variants. At most 64 KiB encoded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `MemoryItem`              | Union: active `{ status:'active', memorySpaceId, memoryId, scope, revision:MemoryRevision, payload:MemoryPayload, pendingSync:boolean, localAvailability:MemoryLocalAvailability }`; quarantined `{ status:'quarantined', memorySpaceId, memoryId, scope, conflict:MemoryConflict, pendingSync:boolean, localAvailability }`; forgotten `{ status:'forgotten', memorySpaceId, memoryId, tombstone:MemoryTombstone, pendingSync:boolean, localAvailability }`; blocked `{ status:'blocked', memorySpaceId, memoryId, scope, failureCode:MemoryFailureCode, pendingSync:boolean, localAvailability }`. Matching nested ids; no payload in quarantined/forgotten/blocked arms. Blocked permits scanner_pending, secret_detected, source_invalidated, missing_parent or forget_pending (a durable local forget intent targets this memory and the reserved forget is not yet accepted; the arm stays body-free until the tombstone lands); scanner_pending means the replica-local scan of an approved revision has not finished yet (never a hub rejection or a secret finding) and clears automatically when the first scan allows it, while secret_detected clears only after a scanner-policy change triggers a rescan (no per-item explicit rescan). It is a local exposure view, not evidence that approved canonical payload is absent or that hub admission failed. No fabricated shared conflict from scanner hold. |
| `MemoryContextSnapshot`   | `protocolVersion: 1`, `memorySpaceId`, `projectionWatermark: NonNegativeInt`, `items: { memoryId, revisionId, scope, provenance, assertionKind, text: string }[]`, `renderedText: string`; ids unique; text contains complete selected items. Cap the delivered block by Unicode code points AND UTF-8 bytes, including wrapper/locators and `MEMORY_CONTEXT_OUTER_FRAME`; the schema reserves that outer-frame cost even when the adapter uses no outer frame. No grants, secrets, local paths, or quarantined/forgotten items.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `MemorySyncStatus`        | `memorySpaceId:MemorySpaceId\|null`, `state:'disabled'\|'bootstrapping'\|'online'\|'offline'\|'error'`, `pendingSync`, `quarantined`, `parked`:NonNegativeInt, `lastSuccessfulSyncAtUtc:timestamp\|null`, `lastHubSequence:NonNegativeInt`, `failureCode?:MemoryFailureCode`, `storage:MemoryStorageStatus`, `processing:MemoryProcessingStatus`. lastHubSequence equals processing.lastReceivedHubSequence. online can coexist with deferred > 0, unindexed content, scanner hold and report backlog; neither state nor received implies visible/indexed/fully purged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `MemoryHubSettings`       | Union: `{ mode: 'disabled' }`; `{ mode: 'hub', memorySpaceId: MemorySpaceId                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | null }`; `{ mode: 'member', hubEnvironmentId: EnvironmentId, endpoint: string, secretName: string, memorySpaceId: MemorySpaceId | null }`. null means not joined. Secret names are internally generated `[a-z0-9-]+`handles. Endpoint is HTTP(S) origin only, no userinfo/path except`/`, query or fragment; HTTP allowed only on loopback. Secret name references `ServerSecretStore`, never a secret value. |
| `MemoryFailureCode`       | `unavailable`, `source_unavailable`, `not_found`, `forgotten`, `revision_changed`, `operation_id_reused`, `missing_parent`, `conflict_changed`, `lease_expired`, `fenced`, `claim_busy`, `invalid_output`, `generation_failed`, `secret_detected`, `bootstrap_required`, `space_mismatch`, `unsupported_protocol`, `invalid_cursor`, `cursor_expired`, `hub_disabled`, `identity_mismatch`, `route_unavailable`, `lease_required`, `attempt_expired`, `unsupported_operation`, `payload_too_large`, `generation_input_too_large`, `storage_failed`, `source_invalidated`, `capacity_exceeded`, `base_compacted`, `revert_expired`, `scanner_pending`, `forget_pending`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

`MemoryRpcError` is a `Schema.TaggedError` with `{ code: MemoryFailureCode,
memoryId?: MemoryId, operationId?: MemoryOperationId }` and a fixed category-based message.
It has no `detail`, raw cause string, text, paths or endpoint credential. Service errors can
retain `cause: Schema.Defect()` internally; transport schemas cannot serialize that defect.
Authorization remains `EnvironmentAuthorizationError`, not a duplicate memory permission enum. Hub HTTP uses `MemoryHubUnauthorizedError` (401) and `MemoryHubForbiddenError` (403), with fixed messages and no raw cause on wire; these tags do not become MemoryFailureCode values. `MemoryHubError` carries the same safe domain code/optional ids as MemoryRpcError. `MemoryCapabilityError` carries only `requiredCapability: "memory"`; existing MCP capability_denied and EnvironmentRpcUnavailableError remain their existing transport tags.
This follows error hygiene in `docs/internals/effect-services.md:107–128`. Existing
`TextGenerationError` takes `operation: Schema.String` (`git.ts:402–412`), so no enum widening
or git contract change is necessary; the operation strings use the exact Shared names.

### Shared suppression, binding and generation metadata

WP1 owns these schemas; SQL codecs are defined only in WP2. No private source root crosses the wire.

| Schema                                 | Required fields and constraints                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MemorySourceKey`                      | `environmentId`, `sourceId: MemoryImportSourceId`, `sourceItemKey: string` (<=512 UTF-8 bytes). Identity is independent of source fingerprint/parser version.                                                                                                                                                                                                                                                                      |
| `MemoryContentSuppression`             | `scope: MemoryScope`, `assertionKind: MemoryAssertionKind`, `contentFingerprint: string` (lowercase SHA256). Exact-copy matching is space + scope + assertion; no semantic or cross-scope match.                                                                                                                                                                                                                                   |
| `MemorySourceExclusion`                | `sourceThread: ScopedThreadRef`, `sourceWatermark: MemorySourceWatermark`, `messageIds: MessageId[]`; nonempty selected committed message IDs, owner checked against watermark. Prevents re-extraction of forgotten source passages without deleting transcripts.                                                                                                                                                                  |
| `MemoryImportSourceMetadata`           | `sourceId`, `format: MemoryImportFormat`, `parserVersion: string`, `sourceLocator: string` (opaque owner-local selector), `sourceItemKey`, `sourceFingerprint: string`, `contentFingerprint: string`, `sourceAliases: MemorySourceKey[]`, `acceptedContentFingerprints: string[]`; optional `commitOid: string`. Never absolute paths or provider settings. Optional importSource preserves old records without import provenance. |
| `MemoryGenerationExecution`            | `requestedModelSelection: MemoryModelSelection`, `effectiveProvider: ProviderDriverKind`, `effectiveModel: string`, `providerInstanceId: ProviderInstanceId`, `environmentId: EnvironmentId`. Runner stamps this after actual alias/instance resolution using its bound instance/environment context; instance must equal requestedModelSelection.instanceId. Requested options remain intact. Model JSON cannot supply execution. |
| `ResolveMemoryConflictExecutionResult` | `{ result: ResolveMemoryConflictResult, execution: MemoryGenerationExecution }`; validated model result plus trusted runner metadata.                                                                                                                                                                                                                                                                                              |
| `GenerateMemorySummaryExecutionResult` | `{ result: GenerateMemorySummaryResult, execution: MemoryGenerationExecution }`; same separation.                                                                                                                                                                                                                                                                                                                                  |

`sourceExclusions`, source aliases and accepted content fingerprints are immutable safe metadata
in operation/revision provenance or tombstone fragments, retained through purge and bootstrap.
Fragments bound the combined suppression records to 100; total operation remains <=256 KiB.
Repeated forget preserves the first deletion identity/time and unions all three suppression sets.
A permanent logical union is stored as unique key rows and exported as bounded fragments. Only local alias/key creation and hubAdmission reserve M19 metadata; approvedReplica unions every approved forget fragment without local capacity rejection.
No new operation kind is added. Unknown arrays/fields still fail strict decode.

`MemorySpaceBinding` is an internal server contract, not an RPC result: `{ memorySpaceId:
MemorySpaceId | null, hubEnvironmentId: EnvironmentId | null, bootstrapReady: boolean }`.
WP2 defines its port and starts unbound; WP3 installs/updates it atomically with the cursor.
A standalone disabled environment cannot fabricate a hub-issued space. Private local drafts
remain outside public MemoryItem/query/operation serialization until WP3 materializes them.
No source-home import occurs while unbound or before initial bootstrap.

### Operation union and payload separation

Use an envelope with `{ protocolVersion: 1, operationId, memorySpaceId,
originEnvironmentId, memoryId, expectedHeads: MemoryRevisionId[] }`. Add these disjoint arms:

```ts
// Build each arm with Schema.Struct({ ...envelopeFields, ...armFields }),
// then Schema.Union([...]).check(Schema.makeFilter(validOperation, ...)).
type OperationArms =
  | { kind: "upsert"; revision: MemoryRevision; payload: MemoryPayload }
  | { kind: "forget"; tombstone: MemoryTombstone }
  | {
      kind: "resolve";
      revision: MemoryRevision;
      payload: MemoryPayload;
      resolution: MemoryResolution;
      resolutionPayload: MemoryResolutionPayload;
      conflictId: MemoryConflictId;
      fencingToken: number;
    }
  | {
      kind: "revert";
      revision: MemoryRevision;
      payload: MemoryPayload;
      revertsResolutionId: MemoryResolutionId;
      restoredRevisionId: MemoryRevisionId;
    };
```

Export the real `MemoryOperation` schema/type, not the schematic `OperationArms` type.
`validOperation` verifies immutable envelope integrity: nested space/memory/operation ids, unique
parents, no self-parent, supported protocol/codec, payload bounds and assertion/evidence shape.
Stateful admission checks below apply to localIntent/hubAdmission only; approvedReplica does not
repeat parent-presence, current-head CAS, lease expiry or local scanner/quota admission. Genuine
approved identity/digest/DAG contradictions fail the page as protocol errors; missing parents defer.

- upsert: empty expectedHeads and parents for creation; otherwise parents equal expectedHeads
  as sets. Ordinary edits cannot claim resolution metadata or fencing authority.
- forget: nested space/memory ids match. Initial deletion requires deleteOperationId and
  deletingEnvironmentId to match the envelope (stateful WP2 check). A suppression extension
  uses a fresh envelope operationId/origin and the retained original deletion audit fields;
  Local client forget never supplies these audit fields; WP2 stamps/checks them against its
  original deletion. Authenticated received fragments may arrive before the first forget;
  preserve their original audit metadata and union suppression without demanding the
  earlier envelope already exist. A later first envelope must not overwrite deletion knowledge. Accept
  any structurally valid expectedHeads; the service ignores stale heads so forget always wins.
- resolve: at least two expectedHeads; revision parents and resolution inputRevisionIds equal
  that set, resultRevisionId equals revision id, resolvingEnvironmentId equals origin, and
  both fencing tokens match. Only hub/server APIs consume this arm, never client upsert.
- revert: exactly one expected head and matching revision parents. At localIntent/hubAdmission,
  require the current resolution result and a retained original input. For approvedReplica, preserve
  attested compensation/ancestry even when local heads differ or the lease has since expired.
  New revision and operation ids are mandatory; revert erases neither resolution nor tombstone.

Canonical events persist the envelope and revision/resolution metadata ONLY. `payload` and
`resolutionPayload` are transaction inputs stored in purgeable `memory_payloads`, not embedded
in `memory_events`, immutable receipts, report messages or logs. Operations are transient
transport envelopes; outbox bodies must also be purgeable on forget. History returns metadata
and separately loaded, optional payload; missing purged payload is an expected state.

Add `encodeMemoryOperation(operation): string` and `decodeMemoryOperation(json): MemoryOperation`:
construct an explicit object per kind with the above fields, recursively pick nested fields,
then `Schema.encodeSync(Schema.fromJsonString(MemoryOperation))` / strict decode. Do not serialize
an arbitrary service object or rely on TypeScript to remove fields. Structural filters must
also run for encode/make. Reuse this encoder for hub transmission; it is not the event encoder.
Add `encodeMemoryEventMetadata(operation): string`: pick envelope+revision/resolution/tombstone
metadata and never reference payload fields. Schema tests inject an extra credential-shaped
property and prove it is absent or refused, without real secrets.

## RPC and MCP boundary

Current `Rpc.make` declares payload/success/error (`rpc.ts:875–885`) and groups receive
`RpcScopeAuthorization` (`rpc.ts:2046–2054,2256`). Add `WsMemoryCoreRpcGroup` (fourteen methods including a stream, excluding importProvider),
`WsMemoryImportRpcGroup` (importProvider only), and `WsMemoryRpcGroup` (their union), using the
same middleware. WP1 declares all fifteen but merges neither into the live group. Keep `WsRpcGroup = WsCoreRpcGroup.merge(WsChannelRpcGroup)` unchanged in WP1
(`rpc.ts:2277`). The server derives exhaustive `WsRpcMethod` from that live group
(`apps/server/src/auth/RpcAuthorization.ts:42,232`); merging early would require missing
handlers and scopes. [WP4](040_wp4_mcp_injection.md) registers the core group; WP5 registers import as described below.
Do not ship dummy success handlers or expose undefined methods to users.

Add the camel-case keys below to `WS_METHODS`. Each RPC error is
`Schema.Union([MemoryRpcError, EnvironmentAuthorizationError])`; import additionally includes
`MemoryImportRpcError` defined below. Every request has
`memorySpaceId`, except syncStatus (empty input works before binding) and hubSettings get/update. Binding get/update and changes carry memorySpaceId; binding targets ScopedProjectRef. Read payloads never use caller-supplied
provenance; mutation provenance is derived by the service from authenticated context.

| Key / wire method                                       | Request fields beyond space                                                                                    | Success                         | Required grants at destination                                                                        |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `memorySearch` / `memory.search`                        | `query: string`, `scope?: MemoryScope`, `limit: int 1..100`, `cursor?: string`                                 | `MemoryPage`                    | `memory:read`                                                                                         |
| `memoryList` / `memory.list`                            | `scope?: MemoryScope`, `includeQuarantined: boolean`, `limit: int 1..100`, `cursor?: string`                   | `MemoryPage`                    | `memory:read`                                                                                         |
| `memoryRead` / `memory.read`                            | `memoryId`                                                                                                     | `MemoryItem`                    | `memory:read`                                                                                         |
| `memoryHistory` / `memory.history`                      | `memoryId`, `limit: int 1..100`, `cursor?: string`                                                             | `MemoryHistoryPage`             | `memory:read`                                                                                         |
| `memorySyncStatus` / `memory.syncStatus`                | none                                                                                                           | `MemorySyncStatus`              | `memory:read`                                                                                         |
| `memoryUpsert` / `memory.upsert`                        | `operationId`, `memoryId`, `expectedHeads`, `scope`, `assertionKind`, `payload`                                | `MemoryMutationReceipt`         | `memory:write`                                                                                        |
| `memoryForget` / `memory.forget`                        | `operationId`, `memoryId`, `expectedHeads`                                                                     | `MemoryMutationReceipt`         | `memory:write`                                                                                        |
| `memoryRevertResolution` / `memory.revertResolution`    | `operationId`, `memoryId`, `resolutionId`, `restoredRevisionId`, `expectedHeads` (one)                         | `MemoryRevertResult`            | `memory:write`                                                                                        |
| `memoryReadSource` / `memory.readSource`                | `memoryId`, `sourceThread: ScopedThreadRef`, `messageIds: MessageId[]`, `limit: int 1..100`, `cursor?: string` | `MemorySourcePage`              | `memory:read` plus explicit orchestration:read and source-owner delegated-read policy; hub relay only |
| `memoryImportProvider` / `memory.importProvider`        | `MemoryImportProviderInput` action union below                                                                 | `MemoryImportProviderResult`    | `memory:write` AND `filesystem:read`                                                                  |
| `memoryHubSettingsGet` / `memory.hubSettings.get`       | none                                                                                                           | `MemoryHubSettingsView`         | `settings:write` (contains credential handle/configuration)                                           |
| `memoryHubSettingsUpdate` / `memory.hubSettings.update` | `MemoryHubSettingsUpdateInput` action union below                                                              | `MemoryHubSettingsUpdateResult` | `settings:write`                                                                                      |

Define `MemoryXInput` for each row (Search/List/Read/History/SyncStatus/Upsert/Forget/
RevertResolution/ReadSource/HubSettingsGet). Import and update use the named action unions,
MemoryImportProviderInput and MemoryHubSettingsUpdateInput, rather than generated aliases. Get has
`Schema.Struct({})`. SyncStatus also has `Schema.Struct({})`. Inputs are shared by RPC and corresponding MCP tools. Strict schemas
for upsert cannot accept `kind: 'resolve'`, revision provenance, originEnvironmentId,
hubSequence, tombstone contents, secretName or arbitrary filesystem paths.

Define result schemas exactly as follows:

- `MemoryPage`: `items:MemoryItem[]`, `projectionWatermark`, `nextCursor:string|null`,
  `indexCoverage:MemoryIndexCoverage` (required for search, absent on list); <=100 items/64 KiB.
  Search includes eligible indexed active items and reports coverage for the same scope/watermark,
  even with zero results. List/read may expose eligible unindexed active items; management list
  includes metadata-only quarantined/forgotten/blocked arms. includeQuarantined includes blocked.
  Cursor binds space/scope/watermark; clients cannot interpret an incomplete index as no memories.
- `MemoryHistoryPage`: `memoryId`, `revisions: { revision: MemoryRevision,
  payload: MemoryPayload | null }[]`, `resolutions: { resolution: MemoryResolution,
  payload: MemoryResolutionPayload | null }[]`, `tombstone: MemoryTombstone | null`,
  `reports: MemoryReportDelivery[]`, `revertResults: MemoryRevertResult[]`, `nextCursor: string | null`; combined records <=100 and serialized page <=64 KiB. Revert results are local request state, not revisions; reconnect/history refetch recovers pending or terminal status.
- `MemoryMutationReceipt`: `operationId`, `memoryId`, `outcome: 'accepted' | 'noop' |
  'conflicted' | 'deleted'`, `revisionId: MemoryRevisionId | null`, `pendingSync: boolean`.
  No payload; accepted means committed intent, not generation or remote convergence. Revert uses
  the separate result below; local pending intent must never appear as an accepted mutation.
- `MemoryRevertStatus`: `pending | accepted | revision_changed | forgotten | revert_expired`.
  `MemoryRevertResult` is a strict tagged union with `status`, `operationId`, `memoryId`,
  `resolutionId` on every arm. `pending` has no receipt or revision ID; `accepted` alone has
  `receipt:MemoryMutationReceipt` with a non-null hub-approved compensation revision ID and
  `pendingSync:false`, plus `localAvailability:MemoryLocalAvailability`; acceptance never promises
  body readiness. `revision_changed`, `forgotten`, `revert_expired` have no success receipt/revision.
  Offline returns pending. Hub stale rejection ends intent; tombstone returns forgotten.
  Pre-admission scanner/permission failures retain typed errors. After approval, scanner/brake/
  report failure is local deferral, not rejected compensation. Transport uncertainty stays pending.
  Same operationId/digest replays stored outcome; no regeneration or resubmission of accepted work.
  RPC and MCP revert share this schema. History revertResults are body-free; history revision/
  resolution payloads follow localAvailability redaction and contain no staged proposal.
- `MemorySourcePage`: `sourceThread`, `watermark: MemorySourceWatermark`,
  `messages: { messageId: MessageId, text: string }[]`, `nextCursor: string | null`;
  <=100 and <=64 KiB. This is an owner-produced bounded RPC page, transiently relayed by the hub; never a memory operation, checkpoint or provenance body.
- Import results and `MemoryImportReceipt` are defined in the import section below, not a
  background-job count receipt. All RPC/MCP management results, including read and import,
  are <=64 KiB serialized. A legal payload whose enclosing result exceeds this envelope yields
  payload_too_large; paging never silently truncates a fact. Search/list default limit is 20.

Publish `MEMORY_MCP_TOOLS` with exactly these nine Shared tool strings:

```ts
export const MEMORY_MCP_TOOLS = [
  "memory_search",
  "memory_list",
  "memory_read",
  "memory_history",
  "memory_sync_status",
  "memory_upsert",
  "memory_forget",
  "memory_revert_resolution",
  "memory_read_source",
] as const;
```

Search/list/read/history/
sync_status/read_source use the corresponding input/success schemas; upsert/forget/
revert_resolution use their mutation schemas. No import, settings, join, lease or resolution
apply tool. `memory` capability is necessary for all nine, but is not an authorization grant.
Toolkit definitions/registration belong only to [WP4](040_wp4_mcp_injection.md).

### Registration order and shared runtime owner

WP4 merges only the fourteen-method WsMemoryCoreRpcGroup with matching handlers/scope entries and the nine tools.
It creates `createMemoryEnvironmentAtoms` including a guarded import command factory, but the
factory rejects unsupported import locally before RPC; no import handler stub is registered.
WP5 merges WsMemoryImportRpcGroup, installs its one thin handler and RPC_REQUIRED_SCOPES entry,
and flips importProvider only after the parser/service is ready. An older destination returns
EnvironmentRpcUnavailableError; an explicitly unsupported internal import port returns
unsupported_operation. WP1 still owns all input/result/guard declarations before either phase.
WP6 only instantiates the WP4 factory; it does not create commands or wire contracts.

### Auth, settings, capability and turn-input diffs

```diff
--- packages/contracts/src/auth.ts (auth.ts:108–128,216–236)
+++ packages/contracts/src/auth.ts
+export const AuthMemoryReadScope = "memory:read" as const;
+export const AuthMemoryWriteScope = "memory:write" as const;
+export const AuthMemorySyncScope = "memory:sync" as const;
 export const AuthEnvironmentScope = Schema.Literals([
+  AuthMemoryReadScope, AuthMemoryWriteScope, AuthMemorySyncScope,
   // existing scopes unchanged
 ]);
 export const AuthStandardClientScopes = [
+  AuthMemoryReadScope, AuthMemoryWriteScope,
   // existing scopes unchanged
 ];
 // NO memory entries in legacyScopes or legacyParents; sync is not a client default.
--- packages/contracts/src/environment.ts (environment.ts:100)
+++ packages/contracts/src/environment.ts
 export const ExecutionEnvironmentCapabilities = Schema.Struct({
+  memoryHubProtocolVersion: Schema.optionalKey(Schema.Int),
+  memory: Schema.optionalKey(Schema.Struct({ protocolVersion: Schema.Int,
+    hub: Schema.optionalKey(Schema.Boolean), importProvider: Schema.optionalKey(Schema.Boolean) })),
   // existing fields unchanged
 });
--- packages/contracts/src/orchestrationV2.ts (orchestrationV2.ts:366–383)
+++ packages/contracts/src/orchestrationV2.ts
 export const OrchestrationV2ProviderCapabilities = Schema.Struct({
+  memory: Schema.optionalKey(MemoryProviderCapabilities),
   // existing fields unchanged
 });
--- packages/contracts/src/settings.ts (settings.ts:1176,1571)
+++ packages/contracts/src/settings.ts
 export const ServerSettings = Schema.Struct({
+  memoryHubVersion: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
+  memoryHub: MemoryHubSettings.pipe(
+    Schema.withDecodingDefault(Effect.succeed({ mode: "disabled" as const }))),
   // existing fields unchanged
 });
 export const ServerSettingsPatch = Schema.Struct({
+  // Add neither memoryHub nor memoryHubVersion; reject both on raw generic patches.
   // existing fields unchanged
 });
--- packages/provider-core/src/server/ProviderAdapter.ts (ProviderAdapter.ts:405–425)
+++ packages/provider-core/src/server/ProviderAdapter.ts
 export interface ProviderAdapterV2TurnInput {
+  readonly memoryContext?: MemoryContextSnapshot;
   readonly appContext?: ReadonlyArray<{ readonly key: string; readonly text: string }>;
 }
--- apps/server/src/mcp/McpInvocationContext.ts (McpInvocationContext.ts:14–21,55–63)
+++ apps/server/src/mcp/McpInvocationContext.ts
 const ALL_MCP_CAPABILITIES = [
+  "memory",
   // existing capabilities unchanged
 ] as const;
 export interface McpInvocationScope {
+  readonly grantedScopes?: ReadonlyArray<AuthEnvironmentScope>;
+  readonly reauthorize?: (required: ReadonlyArray<AuthEnvironmentScope>) =>
+    Effect.Effect<void, EnvironmentAuthorizationError>;
   // existing fields unchanged; omitted grants/reauthorize deny memory access
 }
```

Import the new types/schemas in each file. `memory.ts` imports existing scope refs from
`environment.ts`, so keep environment's memory advertisement inline: no reverse import from
`environment.ts` into `memory.ts`. Provider capabilities may import `MemoryProviderCapabilities`
from memory without importing orchestration back into memory. No protocol version bump for
orchestration: optional fields preserve old events. A future unknown memory protocol version
must still decode the enclosing descriptor; client enables only `protocolVersion === 1`.
The integer advertisements intentionally permit future versions, unlike operation version.
WP3 publishes memoryHubProtocolVersion only for ready hub HTTP routes, independent of
capabilities.memory (client RPC/snapshot readiness, published WP4). Hub preflight checks pinned
environment identity and memoryHubProtocolVersion===1 before sending credentials. WP5 alone
sets memory.importProvider=true; absent optional booleans mean false.

`authScopeResponse` emits new scopes only in `permissions`, keeping its frozen legacy `scopes`
(`auth.ts:140–160`). `sessionGrantsScope` respects explicit empty permissions and has no memory
legacy parent (`auth.ts:164–202`). New pairings can receive read/write through the standard
array; existing stored grants are not upgraded automatically. `AuthGrantScope` derives from
the enum (`auth.ts:133–138`), so sync becomes a recognized explicit grant, but only WP3's
server-principal credentials may actually authorize hub HTTP. Being in an admin UI grant
list must never make an ordinary browser/MCP token a hub principal.

Settings authorization already treats every non-provider field as settings
(`settings.ts:1757–1773`). Reserve both `memoryHub` and `memoryHubVersion` on raw generic
patch input before Struct excess-field stripping; neither field is a generic patch member.
Whole `memoryHub` replacement makes disabled mode clear the stale
endpoint/handle on wire. Do not include it in `ProjectSettingsOverrides`
(`settings.ts:1057–1087`) or local `ClientSettingsSchema` (`settings.ts:323`). Generic settings
persistence must not be used to bypass WP3 join/bootstrap/secret rotation: activation is owned
by WP3's settings service path. No endpoint or machine is hardcoded to juns-macbook-pro.

Guard-map body additions, using the exact new WS_METHODS keys:

```ts
// CLIENT_GUARDED_RPC_SCOPES, clientRpcPermissions.ts:15–61
[WS_METHODS.memoryUpsert]: AuthMemoryWriteScope,
[WS_METHODS.memoryForget]: AuthMemoryWriteScope,
[WS_METHODS.memoryRevertResolution]: AuthMemoryWriteScope,
[WS_METHODS.memoryImportProvider]: AuthMemoryWriteScope,
[WS_METHODS.memoryHubSettingsUpdate]: AuthSettingsWriteScope,
[WS_METHODS.memoryHubSettingsGet]: AuthSettingsWriteScope,
// Include readSource in guarded membership for compound permission availability.
[WS_METHODS.memoryReadSource]: AuthMemoryReadScope,
// clientRpcRequiredScopes, before generic return at clientRpcPermissions.ts:77
if (method === WS_METHODS.memoryImportProvider)
  return [AuthMemoryWriteScope, AuthFilesystemReadScope];
if (method === WS_METHODS.memoryReadSource)
  return [AuthMemoryReadScope, AuthOrchestrationReadScope];
```

Search/list/history/readSource limits decode with default 20, range 1..100; schema output
contains the concrete limit.
Source read checks memory:read and an explicit orchestration:read grant at requester admission; the source owner rechecks its same-owner delegated-read policy and authenticated relay attestation. memory:sync alone is not transcript authority (rev 3 relay contract below).
Queries are authorized at the server; UI query gates are WP4. MCP permissions are not supplied
by tool arguments. WP1 only extends the invocation type; [WP4](040_wp4_mcp_injection.md) threads
real grants through issuers, OAuth and revocation-aware service checks. An absent grants carrier
never infers memory access from `full-access`, `orchestration:operate` or capability membership.

## Hub HTTP shapes (contract only)

`MEMORY_HUB_PATHS` owns the eleven POST paths under `/api/memory-hub/v1/`: join, push, pull,
claim, renew, apply-resolution, release, source-read/request, source-read/collect, source-read/respond, source-read/result. All requests carry protocolVersion:1. All counters
are safe integers; sequence/credentialVersion/fencingToken are positive where allocated.
`MemoryHubPrincipal` is a server-only authenticated value `{environmentId,memorySpaceId,
credentialVersion,scopes: readonly ["memory:sync"]}`; it is never accepted from body JSON.
Every route validates member identity/space again inside its write transaction. WP3 implements
HTTP/credentials; browser/MCP settings authority does not confer hub principal authority.

| Input / result schema                           | Required fields beyond protocolVersion / result                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MemoryHubJoinInput` / `MemoryHubJoinResult`    | Input environmentId, memorySpaceId:null or bound id. Result protocolVersion:1, hubEnvironmentId, memorySpaceId, checkpointSequence:NonNegativeInt, snapshotToken:string. Join creates a fixed checkpoint; it does not return operation/tombstone pages.                                                                                                                                   |
| `MemoryHubPushInput` / `MemoryHubPushResult`    | Input memorySpaceId, environmentId, operations:MemoryOperation[]; result receipts:MemoryHubReceipt[]. Upsert/forget/revert only; an already-accepted resolve retry can replay its receipt, a new resolve yields lease_required.                                                                                                                                                           |
| `MemoryHubPullInput` / `MemoryHubPullResult`    | Input memorySpaceId, environmentId, afterSequence:NonNegativeInt, limit:1..100, optional highWatermark:NonNegativeInt, snapshotToken:string, cursor:string. Result highWatermark, throughSequence, hasMore:boolean, entries:MemoryHubEntry[], checkpoint?:MemoryHubCheckpointPage.                                                                                                        |
| `MemoryHubClaimInput`                           | memorySpaceId, memoryId, conflictId, conflictHeadSet:MemoryRevisionId[] (sorted, distinct >=2), holderEnvironmentId, attemptId:MemoryOperationId, frozenDefaultModelSelection:MemoryModelSelection; returns MemoryResolutionLease.                                                                                                                                                        |
| `MemoryHubRenewInput` / `MemoryHubReleaseInput` | memorySpaceId, memoryId, conflictId, holderEnvironmentId, attemptId, fencingToken:PositiveInt; renew returns MemoryResolutionLease; MemoryHubReleaseResult is {released:boolean}.                                                                                                                                                                                                         |
| `MemoryHubApplyResolutionInput`                 | memorySpaceId, holderEnvironmentId, attemptId, operation:MemoryOperation resolve arm only; returns MemoryHubReceipt.                                                                                                                                                                                                                                                                      |
| `MemoryResolutionLease`                         | memorySpaceId, memoryId, conflictId, conflictHeadSet, holderEnvironmentId, attemptId, frozenDefaultModelSelection:MemoryModelSelection, fencingToken:PositiveInt, claimedAtHubTime, expiresAtHubTime, attemptDeadlineHubTime. All three times are canonical UTC timestamp strings on wire, SQL/clock use integer milliseconds.                                                            |
| `MemoryHubReceipt`                              | operationId, memoryId, operationDigest (canonical digest), outcome:accepted/conflicted/deleted/rejected, hubSequence:PositiveInt                                                                                                                                                                                                                                                          | null, failureCode?:MemoryFailureCode. Hub creates outcome/digest once; replica preserves both. Rejected requires code; null sequence is pre-admission request rejection. Durable hub rejection has a sequence and metadata-only entry. Local hold never creates a rejected hub receipt. Duplicate returns original receipt. |
| `MemoryHubEntry`                                | operation {kind:'operation',hubSequence:PositiveInt,receipt:MemoryHubReceipt,operation:MemoryOperation}; metadata {kind:'metadata',hubSequence:PositiveInt,receipt:MemoryHubReceipt,memoryId,revision?:MemoryRevision,tombstone?:MemoryTombstone}. Receipt ids/sequence/digest match envelope. Metadata is hub rejection or purged content, never replica rescanning of an approved body. |
| `MemoryHubCheckpointPage`                       | Exact required fields and schemas are defined in [Permanent checkpoint wire records](#permanent-checkpoint-wire-records-rev-12) below; no opaque ledger objects or downstream wire definitions.                                                                                                                                                                                           |

### Permanent checkpoint wire records (rev 12)

WP1 exports the following strict `Schema.Struct` / discriminated `Schema.Union` schemas and
inferred types in `memory.ts`. Unmarked fields are required; nullable fields must be present.
`timestamp` is the canonical UTC schema above, `digest` is exactly 64 lowercase SHA256 hex
characters, counters are safe integers. No bodies, settings, SQL reserve counters or local
report delivery state enter permanent ledgers. A body-free stable report guard is retained even
when original resolution detail is later reclaimed.

| Schema                        | Exact fields / identifier                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MemoryCompactReceipt`        | `memorySpaceId:MemorySpaceId`, `originEnvironmentId:EnvironmentId`, `operationKind:'upsert'                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 'forget'                                                                                                                                                                                                                                          | 'resolve' | 'revert'`, `receipt:MemoryHubReceipt`, `revisionId:MemoryRevisionId | null`, `resolutionId:MemoryResolutionId | null`, `revertsResolutionId:MemoryResolutionId | null`, `attemptId:MemoryOperationId | null`, `fencingToken:PositiveInt | null`, `reportGuard:MemoryCheckpointReportGuard | null`. Key `(memorySpaceId,receipt.operationId)`; receipt digest uses `digest`, receipt.hubSequence is positive (pre-admission null-sequence rejection is not checkpoint state). |
| `MemoryCheckpointReportGuard` | `reportId:digest`, `resolvingEnvironmentId:EnvironmentId`, `resolutionId:MemoryResolutionId`, `outcome:'resolved'                                                                                                                                                                                                                                                                                                                                                                                                                              | 'reverted'`. Stable reportId is SHA256 of canonical `[memorySpaceId,resolvingEnvironmentId,resolutionId,receipt.operationId,outcome]`; this is the same reportId used by resolver-local repair/delivery (not a new wire delivery state).          |
| `MemoryIdentityRecord`        | `memorySpaceId:MemorySpaceId`, `memoryId:MemoryId`, `scope:MemoryScope`, `creatingEnvironmentId:EnvironmentId`, `createOperationId:MemoryOperationId`, `createdAtUtc:timestamp`. Key `(memorySpaceId,memoryId)`; immutable first-creation identity survives forget, no growing alias array.                                                                                                                                                                                                                                                    |
| `MemoryFenceRecord`           | `memorySpaceId:MemorySpaceId`, `memoryId:MemoryId`, `highestFencingToken:NonNegativeInt`, `activeLease:MemoryResolutionLease                                                                                                                                                                                                                                                                                                                                                                                                                   | null`. Key `(memorySpaceId,memoryId)`; zero means no token allocated. Maximum never decreases or disappears on release/expiry/forget. Live lease retains pinned selection/holder/attempt/heads/deadlines; no active lease for a deleted identity. |
| `MemorySuppressionRecord`     | Union of common `{memorySpaceId:MemorySpaceId,memoryId:MemoryId,deleteOperationId:MemoryOperationId}` plus `{kind:'sourceKey',sourceKey:MemorySourceKey}`, `{kind:'content',content:MemoryContentSuppression}`, or `{kind:'sourceExclusion',exclusion:MemorySourceExclusion}`. Each exclusion row has exactly one messageId; expand/union selected messages by watermark. Key is common space/id + kind + canonical source key / scope+assertion+fingerprint / scoped thread+watermark+messageId respectively. No arbitrary string id or body. |

`MemoryHubCheckpointPage` has exactly these required fields:

```ts
// Each name below denotes its WP1 schema, not a SQL or downstream codec.
{
  memorySpaceId: MemorySpaceId,
  checkpointSequence: NonNegativeInt,
  retentionFloor: NonNegativeInt,
  causalBoundary: MemoryCausalBoundary,
  pageOrdinal: NonNegativeInt, // zero based, consecutive for one snapshotToken
  items: MemoryItem[],
  revisions: { revision: MemoryRevision, payload: MemoryPayload | null }[],
  tombstones: MemoryTombstone[],
  conflicts: MemoryConflict[],
  resolutions: { resolution: MemoryResolution, payload: MemoryResolutionPayload | null }[],
  compactReceipts: MemoryCompactReceipt[],
  identities: MemoryIdentityRecord[],
  fences: MemoryFenceRecord[],
  suppressions: MemorySuppressionRecord[],
  nextCursor: string | null,
  bootstrapComplete: boolean,
}
```

All arrays are required even when empty; use `Schema.Array` of the named schema, never
`Unknown`, record bags or optional ledger arrays. Tombstones here carry canonical first-delete
space/id/operation/environment/time with all three suppression arrays empty; the complete
permanent union is streamed through `suppressions`, not a single ever-growing tombstone JSON.
Operation/pull tombstone fragments retain their existing arrays; checkpoint install reconstructs
the same union from rows. Revisions/resolutions retain only checkpoint-required ancestry and
valid revert inputs. Null payload is canonical purge, not a replica scanner hold; approved
body-bearing revisions remain present even if the hub's local display is held. A post-S forget
redacts staged bodies using blocked/source_invalidated metadata as specified by WP3, without
rewriting the original receipt or first-creation identity.

WP1 filters validate each page; the exported pure `validateMemoryCheckpointRecords(pages)`
validates the complete staged snapshot before WP3 installs it (state/SQL work remains WP2/WP3):

- All page space/S/floor/boundary values agree; boundary.checkpointSequence equals S and
  `0 <= retentionFloor <= S`. Ordinals start at zero with no gaps; `bootstrapComplete` iff
  nextCursor is null, only the last page is complete. Tokens/cursors are bounded opaque strings
  (<=1,024 code points); authenticated token/member binding remains WP3.
- Build unique-key Maps once for the whole snapshot and reject duplicates before link checks;
  all ledger lookups use these indexes rather than repeated linear scans. Rejected resolve attempts
  can share a resolution id, but only one accepted/conflicted receipt owns a resolution id.
  Unique keys across ALL pages for identities, receipts, fences, suppression rows and canonical
  item/revision/conflict/resolution/tombstone ids. No overwrite/last-row-wins merging. Each
  referenced memoryId has exactly one identity and fence. Item/revision scope equals its identity;
  create operation/environment/time remain the original values, including after forget.
- Compact receipts retain the original operation digest, outcome, failureCode and sequence,
  never recomputed from purged payload or changed by replica hold. Sequence <= S; rejected iff
  failureCode is present. Non-rejected upsert/resolve/revert requires revisionId; forget and
  rejected operations have null revisionId. Resolve requires resolutionId/attemptId/fencingToken;
  other arms have null attemptId/fencingToken, and null resolutionId except revert, which uses
  the original target resolutionId and equal revertsResolutionId. Non-revert has null
  revertsResolutionId. Rejected resolve/revert retains these request identities for retry guards.
- reportGuard is required (non-null) exactly for accepted/conflicted resolve or revert receipts;
  it is null for other kinds/outcomes. Resolve guard resolutionId equals receipt resolutionId
  and resolver equals originEnvironmentId; revert guard identifies the original resolver and
  target resolution, not the environment requesting revert. Its reportId must match the formula
  above. WP1 checks digest format and structural identity links only; WP2 computes and verifies
  that formula with Node crypto before WP3 installs the snapshot. No SHA-256 implementation
  belongs in contracts. Original resolver identity is copied before resolution-detail compaction; install can
  reconstruct the same repair marker without retaining a judgment or delivery pointer.
- Retained revision operationId/space/id/revisionId and retained resolution result/input refs
  match their receipt/identity. A retained resolution matches its accepted/conflicted resolve
  receipt memoryId, origin/resolving environment, result operation/revision and fencing token.
  Its result parents match its inputs, and retained input revisions/payload refs belong to the
  same memory. Every retained creation/revision/deletion operation has its
  original compact receipt. Deleted identities have one first-delete tombstone whose receipt
  is outcome deleted; all suppression rows match that deleteOperationId. Empty suppression
  sets remain valid. First deletion is permanent; later extension receipts cannot replace it.
- Fence maximum covers every retained resolve token and active lease token. An active lease's
  space/id matches, token equals maximum, heads match the retained unresolved conflict, and
  claimedAt <= expiresAt <= attemptDeadline with the existing 120s/600s bounds. Expired leases
  may be absent but maximum stays. Receivers restore maxima before reopening claim/apply;
  checkpoint maximum is merged with a newer local maximum, never reset to zero.
- Required parents/originals are retained or covered by causalBoundary; incomplete linkage
  cannot invent an identity or silently discard an approved receipt. Determining historical
  boundary coverage is WP2/WP3 stateful validation. Accepted resolve/revert receipt identities
  and their permanent reportGuard reconstruct the same resolver-local stable report repair
  key; delivery threads/state and failed local generation attempts are local, not shared wire.

The sum of lengths of ALL nine record arrays above (items, revisions, tombstones, conflicts,
resolutions, compactReceipts, identities, fences, suppressions) is <=100 per page, and the whole
UTF-8 encoded page including envelope/arrays/cursors is <=256 KiB. Count nested revision/payload
pairs as one record; their payload/judgment caps remain 64 KiB each. No record splits except
suppression expansion described above; page producers stop before either bound and never emit
an empty non-final page. Equality is accepted, +1 rejected; do not separately allow 100 rows
in each array. The entire checkpoint can span more than 100 records: permanent unions have no
100-total truncation or page-count ceiling. Staging and SQL accounting use existing space quotas;
approvedReplica install cannot refuse an approved union under local admission quotas. The 256-B
`MEMORY_COMPACT_RECEIPT_MAX_BYTES` is the compact SQL binary row budget, not JSON wire size;
WP2 maps these exact fields losslessly (including original receipt and retry/report identities),
never truncates to fit. Overall permanent metadata/lifetime-id/receipt limits remain M19 limits.

Commit 2 `memory.test.ts` fixtures: `round-trips permanent checkpoint ledger records after purge`,
`preserves original digest outcome and report retry identities`, `restores deletion suppression
and released lease fencing across pages`, `rejects mismatched duplicate or missing checkpoint
ledger identities`, `enforces combined checkpoint record and UTF8 bounds at equality and overflow`,
`rejects incomplete ordinals and boundary mismatches`. Include 101 suppression rows on multiple
pages and a released lease with nonzero maximum; prove generation→wire encode→decode preserves
exact records. WP2 SQL round-trip and WP3 staged atomic install/restart fixtures consume these
WP1 schemas; runtime production/installation is not implemented or tested by this lane.

Checkpoint pull requires snapshotToken, afterSequence=checkpointSequence and optional cursor;
normal pull forbids cursor/snapshotToken/checkpoint result, uses a frozen highWatermark ceiling.
Checkpoint entries are empty; throughSequence stays at checkpointSequence, hasMore is the inverse
of bootstrapComplete. Token binds hub/member/space/S and expires after 600s (cursor_expired).
Stage every page with ordinal/completeness validation; atomically install canonical state, boundary,
original receipts, deferred markers and cursor once. FTS/export completion is not a bootstrap barrier.
Canonical delete fence is installed before opening the barrier; pull newer tombstones before
materializing/sending local intent. There is one pagination pair: cursor / nextCursor.

Push: <=100 operations and 1 MiB. Pull/checkpoint: <=100 combined records and 256 KiB.
Payload/judgment individually <=64 KiB; total operation <=256 KiB. Metadata strings <=1,024
code points, provenance/evidence/ref/head arrays <=100; source key additionally <=512 UTF-8 bytes.
A page producer stops at whole records and advances only through covered records. Suppression
fragments are <=100 combined records per forget; logical retained sets never expire. Test 101
keys across two forgets, including replay and checkpoint, without dropping deletion knowledge.

Lease expiry = min(hub now +120s, claim time +600s); renew every 30s, never extend the attempt
cap. Member clocks schedule only. Exact heads/token/member/tombstone checks and accepted-result
replay are WP3 behavior, not schema implementation. WP2 declares a server-only optional
MemoryResolutionAuthority port with applyResolution/release; WP3 supplies it via application
composition, so WP2 never imports MemorySyncService. Absence yields unavailable, no local resolve.

## Text generation contracts and provider seam

Existing provider inputs carry `ModelSelection` (`textGeneration.ts:64–86`); memory inputs
use the strict `MemoryModelSelection` above and the explicit server conversion boundary.
Do not flatten selection to a model string or decode it through the legacy codec. Define these
runtime schemas in `memory.ts`:

```ts
export const ResolveMemoryConflictInput = Schema.Struct({
  cwd: TrimmedNonEmptyString, // disposable scratch directory, never source checkout
  memorySpaceId: MemorySpaceId,
  memoryId: MemoryId,
  conflictId: MemoryConflictId,
  heads: Schema.Array(Schema.Struct({ revision: MemoryRevision, payload: MemoryPayload })),
  modelSelection: MemoryModelSelection,
});
export const ResolveMemoryConflictResult = Schema.Struct({
  text: TrimmedNonEmptyString,
  assertionKind: MemoryAssertionKind,
  evidence: Schema.Array(MemoryEvidence),
  judgment: TrimmedNonEmptyString,
});
export const GenerateMemorySummaryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  sourceThread: ScopedThreadRef,
  sourceWatermark: MemorySourceWatermark,
  messages: Schema.Array(
    Schema.Struct({ messageId: MessageId, text: Schema.String, completed: Schema.Boolean }),
  ),
  modelSelection: MemoryModelSelection,
});
export const GenerateMemorySummaryResult = Schema.Struct({
  text: TrimmedNonEmptyString,
  assertionKind: MemoryAssertionKind,
  evidence: Schema.Array(MemoryEvidence),
});
```

Add filters: resolution heads >=2, unique, same space/id/scope; input total <=256 KiB;
summary input <=256 KiB; output text+evidence+judgment <=64 KiB; assertion evidence rule;
result evidence cites only source ids/messages/watermarks in its input. The last relational
check belongs to pure `validateMemoryGenerationResult(input, result): boolean`, called by WP2
before scanner and commit. Models never choose ids, parents, fencing tokens, watermarks,
provider provenance or operation kinds. The worker stamps those from pinned input.

```diff
--- packages/provider-core/src/server/textGeneration.ts (textGeneration.ts:129–168)
+++ packages/provider-core/src/server/textGeneration.ts
+// Import and re-export inferred types from @goat/contracts.
 export interface ProviderTextGeneration {
+  readonly resolveMemoryConflict?: (
+    input: ResolveMemoryConflictInput,
+  ) => Effect.Effect<ResolveMemoryConflictExecutionResult, TextGenerationError>;
+  readonly generateMemorySummary?: (
+    input: GenerateMemorySummaryInput,
+  ) => Effect.Effect<GenerateMemorySummaryExecutionResult, TextGenerationError>;
   // existing operations unchanged
 }
```

Optional preserves returned factory object compatibility only; it does not preserve closed enums accepting `keyof ProviderTextGeneration`. WP1 widens the OpenCode enum in the same commit as the interface before declaring independent completion. Optional is deliberate during WP1: required additions would break today's `fromRunner` return
(`textGenerationOperations.ts:224–231`), server TextGeneration factory
(`apps/server/src/textGeneration/TextGeneration.ts:63–95`) and Muse's independently assembled
provider implementation (`packages/provider-muse/src/server/textGeneration.ts:299–354`).
[WP2](020_wp2_store_service.md) owns concrete shared bodies, dispatch and all six-provider
wiring; it can retain an optional type for other extensible providers but must prove required
six-provider availability. An omitted method yields typed generation failure and quarantine;
no alternate provider/default selection fallback. Shared `Request` already uses no tools unless
`investigate` is present (`textGenerationOperations.ts:35–49`), and `decodeJsonReply` validates
output (`textGenerationOperations.ts:79–95`). WP2 must omit investigate for both operations.

Provider goals: Codex additionalContext+compaction restoration; Claude system append+per-turn;
Cursor message block; Grok/Antigravity ACP text block; OpenCode v1 system/v2 instruction entry.
MCP and snapshot flags are independent; OpenCode external server has snapshot only. Nothing
sets these new capability flags true in WP1. Provider adapters and all delivery tests belong
to [WP4](040_wp4_mcp_injection.md), generation implementation to [WP2](020_wp2_store_service.md).

## Import RPC contract (WP1 owner; WP5 producer)

All actions use `MemoryImportProviderInput` with memorySpaceId and destination dual grants
(memory:write AND filesystem:read), including status/discover/preview. No arbitrary path input.
`MemoryImportFormat` = codex/claude/omo. `MemoryImportOutcome` = created/revised/noop/aliased/
suppressed/rejected/conflicted. `MemoryImportIssue` = unsupported_format/source_missing/
source_unreadable/invalid_utf8/path_rejected/limit_exceeded/source_changed/scope_unmapped/
mapping_changed/bootstrap_required/secret_detected/storage_failed/operation_id_reused/capacity_exceeded.
MemoryImportRpcError is a safe TaggedError with `{issue:MemoryImportIssue,operationId?:MemoryOperationId}`
and fixed message, used for whole-request source/profile/read failures. Shared domain failures
(e.g. not_found on status) use MemoryRpcError; per-item failures use issue rows.
Permission failures are EnvironmentAuthorizationError, not an item permission_denied alias.

| Action   | Input fields beyond memorySpaceId                                                                                                                                                                            | Matching MemoryImportProviderResult arm                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| discover | format:MemoryImportFormat                                                                                                                                                                                    | {action:'discover',sources:MemoryImportSource[]}                                                                   |
| preview  | sourceId:MemoryImportSourceId                                                                                                                                                                                | {action:'preview',sourceId,sessionId:string,items:MemoryImportPreviewItem[]}                                       |
| apply    | sourceId, sessionId:string, operationId:MemoryOperationId (stable batch retry key), items:{sourceItemKey,sourceFingerprint,scope:MemoryScope,project?:ScopedProjectRef}[] (1..MEMORY_IMPORT_APPLY_MAX_ITEMS) | {action:'apply',receipt:MemoryImportReceipt,syncStatus:MemorySyncStatus}                                           |
| status   | operationId:MemoryOperationId                                                                                                                                                                                | {action:'status',receipt:MemoryImportReceipt,syncStatus:MemorySyncStatus}; not_found when no admitted batch exists |

MemoryImportSource = {sourceId,format,parserVersion,profile:string,label:string}; <=128 sources.
MemoryImportPreviewItem = {sourceItemKey,sourceFingerprint?:string,byteCount:NonNegativeInt,
mappingRequired:boolean,title?:string,priorOutcome?:MemoryImportOutcome,issue?:MemoryImportIssue,
memoryId?:MemoryId,revisionId?:MemoryRevisionId}; <=128 items, title only scanner-approved,
<=256 code points, no body/local paths. Suppressed/secret-rejected rows omit title. Unsupported
records can omit fingerprint if no candidate could be parsed; apply always requires it.
MemoryImportItemResult = {sourceItemKey,outcome:MemoryImportOutcome,issue?:MemoryImportIssue,capacity?:MemoryCapacityExceeded,
memoryId:MemoryId|null,revisionId:MemoryRevisionId|null}; rejected requires issue.
MemoryImportReceipt = {operationId,sourceId,sessionId:string,sessionNewItems:NonNegativeInt,sessionBodyBytes:NonNegativeInt,state:'partial'|'completed',
items:MemoryImportItemResult[],remaining:NonNegativeInt}; <=32 rows, remaining=0 iff completed.
Exact retries resume incomplete items, return stored outcomes; changed selection rejects ID reuse.
Status reads only metadata receipts and never restarts parsing or commits an item.

Project-scoped apply selectors require project:ScopedProjectRef belonging to the destination; scope.projectKey must match its persisted binding. User selectors forbid project; thread selectors resolve their project from the owned thread (an optional project must match). This additive locator is encoded in request digest and rechecked at item commit, never shared as provenance.

Apply is synchronous, sequential, bounded; the batch has no durable generation/job enum.
WP6 local progress states (preview/running/stopped/completed/failed) are presentation only.
Cancel stops scheduling further 32-item calls. An already admitted call can finish; status/retry
or re-preview exposes durable partial results after disconnect. No start/cancel action, no async
job promise and no new RPC name. Each committed item has a separate operation ID; the batch key
never labels several memory operations. Parser limits (512 files,256 KiB/blob,8 MiB snapshot)
are WP5 private reader limits; RPC metadata result is still <=64 KiB and never truncates facts.

## Hub administration RPC contract (WP1 owner; WP3 producer)

MemoryHubSettingsView = {settings:MemoryHubSettings,version:NonNegativeInt}; version is
ServerSettings.memoryHubVersion (default 0, not accepted in ServerSettingsPatch), stored locally
and increased by WP3 only on a committed configuration change. Get input is empty. Every update
has requestId:MemoryOperationId and expectedVersion:NonNegativeInt plus this action union:

| action                 | Required extra fields                                        | Service use                                                                               |
| ---------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| configure              | settings:MemoryHubSettings (whole replacement)               | connect/disconnect by member/disabled; null hub space allocated and persisted once by WP3 |
| provisionMember        | environmentId:EnvironmentId                                  | hub-only owner provisions a bound member                                                  |
| rotateMemberCredential | environmentId                                                | hub-only owner rotates its credential and invalidates old leases                          |
| revokeMember           | environmentId                                                | hub-only owner revokes membership                                                         |
| installCredential      | hubEnvironmentId, endpoint, memorySpaceId, credential:string | member stages secret, commits generated secretName/config only on success                 |
| acknowledgeCredential  | credentialRequestId:MemoryOperationId                        | hub removes recoverable outgoing bytes after owner receipt                                |

MemoryHubCredentialResult = {requestId,environmentId,memorySpaceId,credentialVersion:PositiveInt,
credential:string}; fixed encoding of 32 random bytes, ephemeral explicit no-store response only.
MemoryHubSettingsUpdateResult = {view:MemoryHubSettingsView,credential:MemoryHubCredentialResult|null}.
Only provision/rotate return credential bytes; install input is the sole secret-bearing request,
never stored as operation JSON, settings, receipt, report, logs or browser persistence. Exact retry
uses body-free administration receipt; conflicting digest rejects operation_id_reused. Version
mismatch is revision_changed. Bound administration payload <=64 KiB, reject extraneous fields.
All actions/get require settings:write at destination with live post-lock recheck. Sync principal
cannot administer; no MCP tool. Generic settings memoryHub patches are rejected; only dedicated RPC reaches the guarded
transition with requestId/expectedVersion. Contracts/settings schemas land WP1; WP3 owns
dedicated whole-replacement persistence and secret recovery, with no generic delegation.

## Reports, history and channel reference (WP1 owner)

MemoryReportReference = {memorySpaceId,environmentId,memoryId,resolutionId?:MemoryResolutionId}.
Add optional `memory:MemoryReportReference` to ChannelMessageMeta in channelCommon.ts and its
round-trip/old-omission tests in WP1; no new ChannelMessageKind/task/provider turn.
MemoryReportDelivery = {reportId:string,operationId:MemoryOperationId,
outcome:'resolved'|'failed'|'reverted',resolvingEnvironmentId:EnvironmentId,
resolutionId:MemoryResolutionId|null,state:'pending'|'delivered'|'failed',
failureCode?:MemoryFailureCode,reportThread:ScopedThreadRef|null,sequence:NonNegativeInt|null}.
Delivered requires thread+sequence; pending/failed have no pointer; failed requires safe code.
History reports are resolver-local metadata, bounded with other history records (<=100/64 KiB).
Foreign history returns an empty report list and resolution.resolvingEnvironmentId for explicit
routing. No transcript/body/judgment enters bot metadata or report rows. IDs are stable per
resolver + resolution/attempt/revert operation + outcome; accepted resolve/revert uses the
MemoryCheckpointReportGuard SHA256 formula so checkpoint repair yields the identical reportId; the report recordKey uses reportId.
On accepted revert, only the original resolver records a stable body-free report repair marker
with canonical receive, using revertsResolutionId and retained resolution metadata, also in catch-up.
Delivery/report quota is deferred and cannot roll back receive or cursor. WP2 pendingReports/
claimReport/acknowledgeReport/failReport and WP6 delivery drain repair idempotently; no shared report table.

## Settled phase implementation ports (non-wire)

WP2 owns `readContextCandidates({thread:ScopedThreadRef})` and `readContextRevisions(snapshot)`:
one consistent committed read, resolved user/project/thread scopes, active revisions only,
returns memorySpaceId/projectionWatermark/snapshot item fields; refilter exact selected revisions,
never newer replacements. WP4 owns rendering `MemorySnapshot.forThread/revalidate` and adapters.
WP1 exports type-only `MemoryContextCandidate = MemoryContextSnapshot["items"][number]` and
`MemoryContextCandidates = Pick<MemoryContextSnapshot,"memorySpaceId"|"projectionWatermark"|"items">`.
WP2 candidate ports and WP4 renderer consume these derived types; no WP2 dependency on a later
provider renderer or second candidate wire schema. Context snapshot schemas stay WP1.
WP2 defines repeatable permit + foreign apply/checkpoint/materialization/outbox methods; details
and SQL are in 020. WP3 implements getHubSettings/updateHubSettings/syncStatus against WP1
schemas and repeats permit after transaction ownership. `MemoryAccess` is a WP4 request adapter
for the earlier permit, never a WP2/WP3 import dependency. WP3 supplies MemorySourceReadAuthority through composition; WP4 activates MemoryService.readSource using existing committed thread readers and this relay port, not handler-side workflow. Every phase's
request tables below are assigned work against this settled contract, not open schema proposals.

### M20 local availability and progress contracts (rev 8)

These schemas are replica-local query/status views, never shared admission fields. Hub outcome
and operationDigest remain original authority data. Schema unknown enum/field values fail strict
decode; they cannot silently become visible/ready. Descriptor protocol compatibility is explicit.

| Schema / field          | Normative shape and meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MemoryDeferredReason    | Allowlist `forget_pending` (WP2 rev 13: local pending-forget exposure hold; WP1 follow-up codec change required), `scanner_pending`, `secret_detected`, `missing_parent`, `conflicted`, `dependency_invalidated`, `fts_braked`, `index_budget`, `index_unavailable`, `cleanup_failed`, `report_backlog`, `report_failed`. Only safe IDs/categories; no body, match string, path or raw cause.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| MemoryDeferredStatus    | `{ kind:'index'\|'scanner'\|'parent'\|'projection'\|'cleanup'\|'report', state:'pending'\|'held'\|'ready', reason:MemoryDeferredReason\|null, revisionId:MemoryRevisionId\|null, generation:NonNegativeInt, sinceAtUtc:timestamp\|null }`; one coalesced bounded entry per kind per item. reason required when held; pending/held sinceAtUtc is non-null; ready has null reason/time. SQL-only retry attempt/due and payload refs do not serialize.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| MemoryLocalAvailability | `{ exposure:'visible'\|'held'\|'forgotten', reasons:MemoryDeferredReason[], deferred:MemoryDeferredStatus[], cleanupPending:boolean }`; deduplicated bounded reasons, <=6 deferred entries. Active arm requires exposure=visible; blocked/quarantined arms require held and forgotten arm requires forgotten. Visible requires scanner allowed, linked/boundary-covered ancestry, active nonconflicted latest revision and no invalidated dependency; index ready not required. Held/forgotten views carry no body/original/judgment/source. cleanupPending is physical derived purge not yet complete, independent of received/hub outcome. Exposure held never by itself cancels conflict resolution: resolution inputs are unusable only while a reason in {scanner_pending, secret_detected, missing_parent, dependency_invalidated, forget_pending} applies to an input head (forget_pending: a durable local forget intent targets this memory, so no input reaches a model before the reserved forget is accepted); a quarantined item whose reasons are only conflicted and index/report reasons keeps its claim candidate, and the resolution registry reads the canonical variant payloads. |
| MemoryIndexCoverage     | `{ status:'available'\|'partial'\|'unavailable', eligibleItems:NonNegativeInt, indexedItems:NonNegativeInt, unindexedItems:NonNegativeInt, projectionWatermark:NonNegativeInt }`; same space/filter/watermark as query, eligible=indexed+unindexed; unavailable has indexed=0/unindexed=eligible and no search result body. Held/forgotten/conflicted items are not eligible. Partial means eligible items missing current-generation index; complete empty scope is available with all zeros. Search always returns coverage, including empty result; never silently fallback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| MemoryProcessingStatus  | `{ lastReceivedHubSequence:NonNegativeInt, receiveLag:NonNegativeInt\|null, deferred:NonNegativeInt, oldestDeferredAtUtc:timestamp\|null, unindexedItems:NonNegativeInt, scannerHeldItems:NonNegativeInt, scannerPendingItems:NonNegativeInt, missingParentItems:NonNegativeInt, pendingCleanupItems:NonNegativeInt, reportBacklog:NonNegativeInt, reportFailed:NonNegativeInt, hubAdmissionFailures:NonNegativeInt, indexCoverage:MemoryIndexCoverage }`. receiveLag uses last authenticated observed high-watermark minus received (unknown=null); deferred counts unique pending/held item-kind pairs; oldest timestamp null iff none. Item counters overlap. Admission failure counts local submissions refused by hub, not replica holds. scannerHeldItems counts secret_detected holds only; scannerPendingItems counts revisions waiting for their automatic first scan. Scope for status coverage is whole bound space.                                                                                                                                                                                                                                                                       |

Every MemoryItem arm and accepted MemoryRevertResult carries localAvailability. MemoryHistoryPage
also carries localAvailability and redacts all revision/resolution payloads while held/forgotten.
MemoryPage search adds indexCoverage; MemorySyncStatus adds processing. MemoryMutationReceipt
continues to describe local committed intent; accepted revert's approved receipt does not promise
availability. A body-bearing checkpoint is canonical export, not a replica-filtered management
view: approved payload comes through revisions/resolutions even when hub-local view is held.
Scanner initially pending is an exposure hold; receive does not wait for scan, and no default
visible state may expose unchecked content. Initial scanner_pending is cleared by the automatic
first scan, which the receive commit schedules and restart recovers; an allowed result at the current
revision/generation releases it. Only a secret_detected hold has no automatic release: a policy
change must produce allowed at the current revision/generation (there is no per-item explicit rescan
entry point; a false positive is cleared by forgetting and re-creating the memory). Forget cancels
both first.

| Whole field chain                                                                                                                                                                                               | Creation / serialization                                                                                                                                                                                                                                    | Decode / every consumer                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| localAvailability.exposure/reasons/deferred/cleanupPending; all kind/state/reason enums, revision/generation/time                                                                                               | WP2 receive seeds safe pending flags, scanner/parent/projection/index/cleanup/report drain updates SQL columns/typed metadata; explicit MemoryItem/History/Revert query codec. Shared operation serialization N/A: local state cannot select hub admission. | WP1 memory.ts strict schemas + memory.test.ts fixtures → WP2 row/query decoder/eligibility, WP3 ACK/pull/status, WP4 snapshots/compaction/read/history/source and RPC/MCP, client-runtime caches/commands, WP6 web/desktop/mobile/history/report/palette/keybindings. Every body consumer rechecks exposure, tombstone and generation. |
| indexCoverage.status/eligibleItems/indexedItems/unindexedItems/projectionWatermark                                                                                                                              | WP2 counts eligible/latest-generation indexed rows under same committed scope/watermark; MemoryPage search and processing codec                                                                                                                             | WP1 decode → WP2 search, WP3 status → WP4 RPC/MCP/runtime → WP6 results/storage; incomplete empty result must reveal coverage. Provider delivery does not depend on FTS coverage.                                                                                                                                                      |
| processing.lastReceivedHubSequence/receiveLag/deferred/oldestDeferredAtUtc/unindexedItems/scannerHeldItems/missingParentItems/pendingCleanupItems/reportBacklog/reportFailed/hubAdmissionFailures/indexCoverage | WP2 SQL cursor/flags/repair, hub-refused local outcomes and WP3 authenticated watermark → explicit MemoryProcessingStatus via syncStatus                                                                                                                    | WP1 strict decode/null consistency → WP3 scheduling/status, WP4 transport/MCP/runtime, WP6 all clients. Never derive received from index/report completion; lastHubSequence mirrors received. Source relay transient failures do not increment admission failures.                                                                     |
| original operationDigest/outcome/sequence                                                                                                                                                                       | Hub admission → MemoryHubReceipt + operation-entry receipt/checkpoint compact-receipt codec; WP3 auth decoder → WP2 canonical ledger                                                                                                                        | WP2 replay/ACK/page atomicity and approved identity collision checks; WP3 recovery/pull/checkpoint; WP4 safe status/history; WP6 acceptance label. Local hold never rewrites these fields.                                                                                                                                             |
| internal MemoryAdmissionContext                                                                                                                                                                                 | Authenticated WP3 or trusted local/hub service creates mode; WP2 function parameter/SQL audit metadata only                                                                                                                                                 | WP2 every apply/install/ACK/accepted commit/quota entry; WP3 authenticated ports. Public input/JSON creation N/A and forbidden; RPC/MCP/model never supply mode.                                                                                                                                                                       |

Future memory.test.ts codec cases round-trip held/visible-unindexed/forgotten+cleanupPending,
accepted compensation+hold, all reasons/deferred kinds and processing counters; reject unknowns,
duplicate/oversized entries, inconsistent coverage/null oldest time, body on held views and
forged mode on public input. Hub-approved suspicious payload round-trips canonical checkpoint
without being downgraded by hub-local display state. These are NOT RUN implementation obligations.

## Field lifecycle: producer → codec → decoder → consumers

This inventory covers every new field and enum family, including temporary seams. "Future"
means there is no live producer/consumer in WP1; a schema test constructs fixtures today.
No field is presumed active merely because it typechecks.

| Fields / enum values                                                                                                                                       | Producer and serialization                                                                                                                                        | Decode and every destination                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Eight branded ids; protocolVersion                                                                                                                         | Future service UUID allocator, hub space issuer, conflict registry; lowercase UUID fixtures in WP1; operation/RPC/hub JSON                                        | memory strict schemas; future store/decider, sync/hub, MCP/RPC, client-runtime and three clients. Operation protocol rejects !=1, descriptor negotiates independently.                                                       |
| scope.kind user/project/thread; projectKey.kind repository/explicit, groupingKey/sharedProjectId, thread refs                                              | Future WP2 persisted binding resolver uses explicit id first, otherwise its pinned `repositoryGroupingKeyOf` (`environment.ts:307–309`); service → operation JSON | MemoryScope; future projections, hub sync, source routing, search/snapshot filters, import mapping and client scope selector. Never local cwd/ProjectId as shared identity.                                                  |
| assertionKind fact/inference; text/evidence/derivedFromMemoryRevisions                                                                                     | Future user mutation, importer or summary worker; payload encoder only                                                                                            | MemoryPayload plus revision relational checks; future purgeable SQL payloads, FTS, active RPC views, snapshot and resolver; derived refs invalidate summaries after forget.                                                  |
| evidence.origin user/thread/import/model and all evidence source fields                                                                                    | Future authenticated user/import/committed-thread input or validated model result; explicit evidence codec                                                        | MemoryEvidence; future worker verification, provenance display/source routing, assertion filter. No transcript text in memory operations/checkpoints; only bounded transient source relay carries a page.                    |
| provenance environment/instance/provider/requested/effective/sourceThread/sourceWatermark/importSource; format codex/claude/omo, sourceItemKey/fingerprint | Future authenticated context, owner worker and importer receipt; explicit metadata encode                                                                         | MemoryProvenance; future store, hub, history, snapshot locators, settings reports and suppression receipt matching. Native paths remain environment-local.                                                                   |
| revision parents/payloadRef/createdAtUtc and nested ids                                                                                                    | Service/hub approved revision → explicit operation/checkpoint metadata codec → WP2 canonical row decode                                                           | DAG store preserves approved payload/ref; missing-parent/boundary linkage is deferred; history, frontier, resolver and snapshot eligibility recheck local state. Timestamp diagnostic only.                                  |
| operation kind upsert/forget/resolve/revert; expectedHeads; refs/payload/authority                                                                         | Local intent or hub approval → explicit operation codec; authenticated WP3 internally constructs approvedReplica                                                  | Hub admits; replica verifies integrity and commits canonical+original receipt+deferred+cursor. RPC/MCP cannot select admission mode or submit resolve.                                                                       |
| tombstone delete identity/time/suppressedSourceKeys                                                                                                        | Forget/import decider → bounded fragments → WP2/WP3 codec                                                                                                         | Approved union bypasses local key quota; purge invalidates every deferred generation, import/snapshot/cache/read.                                                                                                            |
| conflict/resolution refs/model/fence/time/revertsResolutionId; judgment                                                                                    | Hub result → metadata and separate purgeable canonical payload → WP2 schema                                                                                       | Preserve accepted ancestry; scanner hold redacts originals/judgment/model inputs; stable report repair marker drains separately.                                                                                             |
| item status active/quarantined/forgotten/blocked; payload; pendingSync; localAvailability                                                                  | WP2 canonical state plus replica-local flags → explicit MemoryItem query JSON (not shared operation)                                                              | RPC/MCP/client-runtime and web/desktop/mobile distinguish accepted content from local visibility; held views have no body. Unindexed eligible items can list/read/inject.                                                    |
| snapshot items, renderedText, projectionWatermark                                                                                                          | Future WP4 committed projection snapshot; in-process ProviderAdapterV2TurnInput (no network codec on this interface)                                              | MemoryContextSnapshot validation before turn dispatch; all six adapters and Codex compaction restore. IPC persistence N/A: not added to orchestration events or appContext.                                                  |
| sync status state/counters/last success/sequence/failure                                                                                                   | Future sync service; RPC/MCP JSON                                                                                                                                 | MemorySyncStatus; future client-runtime, web/desktop/mobile status, tools and bot report links. Never conflate online with converged.                                                                                        |
| settings mode/endpoint/secretName/space                                                                                                                    | Future settings command/service; ServerSettings and dedicated RPC codecs                                                                                          | memoryHub in ServerSettings only, dedicated admin input; future WP3 startup/secret store/join/bootstrap, WP6 settings. Secret bytes N/A: handled only by ServerSecretStore/transport.                                        |
| permissions memory:read/write/sync                                                                                                                         | New standard pairing arrays generate read/write; `authScopeResponse` → permissions; stored SessionStore scopes (`SessionStore.ts:446,715`)                        | AuthEnvironmentScope/forward-compatible permissions; sessionGrantsScope, future RPC_REQUIRED_SCOPES, client guards, MCP authenticated context/service checks, server-principal hub checks. Legacy scope output stays frozen. |
| invocation grantedScopes/reauthorize; capability memory                                                                                                    | WP1 optional type/reauthorize port only; future registry (`McpSessionRegistry.ts:131–146`) and OAuth auth context issuer                                          | In-process McpInvocationScope, requireMcpCapability and future explicit/revocation-aware grant checks. No serialization of ReadonlySet; token/claims encoding is owned by issuers. Absence denies.                           |
| environment memory.protocolVersion; provider snapshot/mcp/generation flags                                                                                 | WP1 schemas only; future descriptor/capability producer                                                                                                           | environment descriptor (`environment.ts:259–272`) and provider event (`orchestrationV2.ts:894`); future client runtime gating and adapter/worker eligibility. Missing/unsupported => disabled, external OpenCode mcp false.  |
| RPC/MCP names; cursor/limits/pages/receipts and all result fields                                                                                          | WP1 Rpc.make declarations/fixtures; future service results, explicit schema JSON                                                                                  | WsMemoryRpcGroup and tool input/output schemas; future WP4 handlers/shared commands/queries and WP6 surfaces. Cursor validates scope/space/watermark at service.                                                             |
| hub sequences/highWatermark/throughSequence/hasMore/bootstrapComplete/lease clock and attempt fields                                                       | Future hub atomic receipt/lease/join code; HTTP shape encoders                                                                                                    | hub schemas; future MemorySyncService bootstrap/paging/outbox, holder renew/apply/release and receiver transactions. No UI/MCP lease authority.                                                                              |
| generation messages/completed/heads/modelSelection/results                                                                                                 | Future owner worker/resolution holder; shared prompt encoder then structured model JSON                                                                           | input/result schema plus validateMemoryGenerationResult; future six runners, worker scanner/commit, provenance stamping. No tools or silent fallback.                                                                        |
| MemoryFailureCode / receipt outcomes                                                                                                                       | Schema filters and future domain/service branches; safe tagged RPC errors and hub receipts                                                                        | RPC/MCP/HTTP decoders, worker status, sync retries and UI messages. Internal defects/raw model output N/A on public wire.                                                                                                    |

## Branches, activating scenarios and observable evidence

"Schema" evidence is WP1 focused CI. Stateful rows are contractual obligations linked to their
owner, not behavior claimed by WP1. No sleeps, wall-clock polling or real provider state.

| Branch / threshold                                                          | Activation scenario                                                                                    | Observable evidence and owner                                                                                                                                                                      |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invalid id/time/known shape, duplicate/self parent, mismatched envelope ids | blank/uppercase/non-UUID memory id; invalid UTC; same parent twice; revision id is its parent          | Schema reject on decode/encode/make; memory.test.ts.                                                                                                                                               |
| Unknown operation/scope/assertion/version                                   | operation kind typo, unknown scope or protocol 2                                                       | Strict schema error; no silent skip/downgrade; memory.test.ts.                                                                                                                                     |
| Future descriptor/missing capability                                        | server omits memory or advertises v2; provider omits memory                                            | Descriptor/event still decodes, helper `supportsMemoryProtocol(capabilities)` returns false unless version=1; old provider has no supported memory paths.                                          |
| Unsupported scopes/empty grants/read-only capability caller                 | old session has orchestration parent only; permissions=[]; capability memory without read/write        | sessionGrantsScope false, future MCP denial before service; auth and invocation tests today, WP4 authorization tests later.                                                                        |
| Import dual grants / source routing grants                                  | memory write without filesystem read; foreign thread source unavailable or ungranted                   | clientRpcRequiredScopes returns both; future destination denies; readSource returns authorization error or source_unavailable with no local environment fallback (WP4/WP5).                        |
| Invalid member settings / disabled default                                  | credential embedded URL, public plain HTTP, no secret name; old settings {}                            | Decode reject for member; old settings disabled; dedicated setting scope is settings:write; settings tests.                                                                                        |
| Fact vs inference / forged model evidence                                   | fact with only model evidence; generated citation absent from input                                    | Schema/pure validator rejects; worker cannot silently assert fact; WP1 generation contract tests, WP2 commits nothing.                                                                             |
| Snapshot char/byte limit and whole-item dropping                            | 6,001 code points, >24 KiB, wrapper pushes total over bound                                            | full renderedText rejects; WP4 selector drops whole items and records selected revision IDs. Boundary equality passes.                                                                             |
| Mutation/query/hub total limits                                             | 101 results; 64-KiB page exceeded; >1-MiB push; >256-KiB operation                                     | bounded schema error on request, producer stops at whole item on page; limit constants visible in CI fixtures; paging producers WP2/WP3.                                                           |
| Secret scan failure by admission mode                                       | Local/import/model/hub input has fixture secret; separate hub-allowed/replica-blocked approved fixture | Pre-admission stores metadata only; approvedReplica preserves canonical body/outcome/cursor and local scanner hold, excluding FTS/read/history/injection/model/export. WP2/WP3 actual stores.      |
| Missing parents / boundary / unrelated edits                                | Approved descendant arrives before parent then unrelated B; checkpoint covers ancestry                 | Canonical payload/receipt durable, cursor advances; only A eligibility held; parent links once, covered ancestry is not endless parking. base_compacted review applies to unapproved local intent. |
| Operation retry / id reuse                                                  | identical retry; same operationId with changed body                                                    | exact prior receipt or operation_id_reused; never second revision/sequence; WP2/WP3 transaction tests.                                                                                             |
| Offline or bootstrap not installed                                          | hub unavailable; new member has local outbox before tombstones                                         | committed local writes pendingSync; no lease resolution; no outbox upload before bootstrapComplete; WP3 stored cursor/outbox evidence.                                                             |
| First claim / expiry / renew / attempt cap / fencing                        | competing holders; 120-s expiry; renew each 30s; cumulative 600s; stale token                          | one claim wins, claim_busy/lease_expired/fenced; renew never extends attempt deadline; WP3 virtual clock plus transaction receipts.                                                                |
| Third head / forget while resolving                                         | extra edit or tombstone after model request but before apply                                           | conflict_changed or forgotten; no result projection; stale completion discarded; WP3 Deferred-controlled runner and persisted events.                                                              |
| Revert selection/current head changed                                       | choose one of >=2 originals; edit occurred after result                                                | restore selected input as compensating revision only if expected result is still current; revision_changed otherwise; WP2 receipt/revision assertions.                                             |
| Forget vs edit/revert/reimport                                              | old offline edit or changed native source after delete                                                 | same id remains forgotten; original bodies/judgment/derived payload purged, receipt keys suppress re-import; WP2/WP3/WP5. New explicit remember uses new id.                                       |
| Missing generator/invalid output/provider unavailable                       | optional seam absent; runner fails; invalid output/evidence                                            | typed generation failure, no alternate provider, only this memory stays quarantined; WP2. Full six-provider release requirement remains.                                                           |
| Source summary completion/watermark                                         | failed/cancelled turn has unfinished model text; completed event replay                                | only committed user facts/completed results, one watermark receipt; owner thread ref retained; WP2 worker drain/event evidence.                                                                    |

## Focused tests to write

Test names below are implementation requirements. Fixtures are synthetic ids and text. Schema
round-trips use `Schema.fromJsonString`, matching `orchestrationV2.test.ts:2162–2164`; decode,
encode and make reject the same invalid values. Effect tests await the Effect result; none
needs a server, timer, filesystem home or provider. Stateful tests listed in the branch table
are written in their owning phase and await committed events, Deferred or worker drain.

| Exact file                                                          | Case names and assertions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/contracts/src/memory.test.ts`                             | `round-trips all eight memory ids and rejects malformed UUIDs`; `round-trips user project and thread scopes`; `rejects malformed scope discriminants and missing locators`; `round-trips fact and inference provenance with source watermarks`; `rejects fact without non-model evidence`; `round-trips each operation arm`; `rejects mismatched ids self parents and duplicate heads`; `rejects resolve authority in client upsert`; `rejects unsupported protocol and unknown fields`; `encodes events without memory or judgment bodies`; `encodes tombstones without recoverable content`; `keeps purged history payload nullable`; `requires selected original and one expected head for revert`; `accepts stale structurally valid forget heads`; `enforces snapshot Unicode and UTF8 limits including wrappers`; `enforces page batch and payload limits at equality and overflow`; `round-trips eleven hub requests and receipts`; `round-trips metadata-only checkpoint pages and rejects mixed normal paging`; `uses UTC lease timestamps and safe integer fences`; `unions bounded tombstone fragments preserving original deletion audit`; `round-trips all import actions outcomes and partial receipts`; `rejects start cancel paths bodies missing import fingerprints and project selectors without ScopedProjectRef`; `round-trips hub admin actions without leaking credential to settings`; `round-trips report reference and delivery pointers`; `includes outer-frame cost in snapshot equality`; `preserves resolve push envelopes admission errors and accepted replay receipts`; `requires failure code on rejected receipts`; `round-trips pinned model options and lease timestamps`; `rejects body-bearing quarantined forgotten and blocked items`; `validates model evidence against input without letting output choose ids`; each name proves the corresponding codec/filter/output invariant above; stateful push rejection and replay lookup are verified in WP3. Source request versus operation brands are checked by compiler-only fixtures, not runtime equality. |
| `packages/contracts/src/auth.test.ts`                               | `recognizes memory scopes without legacy parent expansion`; `denies memory to unauthenticated and explicit empty grants`; `keeps memory out of legacy scope response`; `includes read and write but excludes sync in default client and administrative grants`; `does not upgrade stored old grants`; assert exact arrays/helper results.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/contracts/src/environment.test.ts`                        | `decodes descriptor without memory advertisement`; `decodes future memory protocol but disables support`; `enables only protocol one`; add pure `supportsMemoryProtocol` in environment.ts with body `return capabilities.memory?.protocolVersion === 1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/contracts/src/orchestrationV2.test.ts`                    | `replays provider capabilities without memory`; `keeps snapshot MCP and generation capabilities independent`; all four provider flags round-trip without defaulting missing to true.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/contracts/src/settings.test.ts`                           | `defaults old settings to disabled memory hub`; `round-trips hub and member without secret bytes`; `rejects credentials query and nonloopback plain HTTP in hub endpoint`; `replaces memory hub configuration as one dedicated admin field`; `rejects reserved memoryHub in generic settings patch`; project/client settings schemas never consume the field.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/contracts/src/rpc.test.ts`                                | `declares fifteen memory methods with typed inputs and authorization middleware`; `keeps memory out of live group until handlers exist`; `rejects upsert provenance and arbitrary import paths`; `bounds source and history output`; inspect RpcGroup metadata and validate schemas, not transport callback wiring.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/contracts/src/clientRpcPermissions.test.ts`               | `guards all three memory mutations`; `requires memory write and filesystem read for provider import`; `guards hub settings update with settings write`; `leaves existing compound guards unchanged`; call clientRpcRequiredScopes and compare complete arrays.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/provider-core/src/server/textGenerationContracts.test.ts` | `round-trips resolve inputs with complete model options`; `rejects head scope mismatch`; `rejects resolution output with forged source evidence`; `rejects summary output with unknown message ids`; `separates model result from runner execution metadata`; `does not accept model chosen revision ids`; run schema/pure validator on real contract values.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `apps/server/src/mcp/McpInvocationContext.test.ts`                  | `reports missing memory capability with neutral error`; `accepts memory capability without granting write permission`; `leaves omitted permissions denied`; use requireMcpCapability plus sessionGrantsScope directly; no claim of end-to-end service authorization.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

No test asserts feature activation in WP1. Permission execution, revocation while awaiting a
lock, lease races and delete-wins need the real WP2/WP3/WP4 service path. No static component
render tests or sleep-based waits are prescribed.

## Verification and exact command coverage

Jun forbids tests and full builds on juns-macbook-pro. Do not run `bun/pnpm/vp test`, Vitest,
e2e, `vp check`, recursive typecheck, repository lint, or a dev server here. Typecheck/lint can
be run after the future implementation, from this worktree root, without running any tests:

```sh
vp exec tsc --noEmit -p packages/contracts/tsconfig.json
vp exec tsc --noEmit -p packages/provider-core/tsconfig.json
vp exec tsc --noEmit -p packages/provider-opencode/tsconfig.json
vp exec tsc --noEmit -p packages/provider-muse/tsconfig.json
vp exec tsc --noEmit -p packages/provider-cursor/tsconfig.json
vp exec tsc --noEmit -p packages/provider-grok/tsconfig.json
vp exec tsc --noEmit -p packages/provider-pi/tsconfig.json
vp exec tsc --noEmit -p packages/provider-acp-registry/tsconfig.json
vp exec tsc --noEmit -p apps/server/tsconfig.json
vp lint packages/contracts/src/channelCommon.ts packages/contracts/src/channelCommon.test.ts packages/contracts/src/memory.ts packages/contracts/src/memory.test.ts packages/contracts/src/index.ts packages/contracts/src/auth.ts packages/contracts/src/auth.test.ts packages/contracts/src/environment.ts packages/contracts/src/environment.test.ts packages/contracts/src/orchestrationV2.ts packages/contracts/src/orchestrationV2.test.ts packages/contracts/src/settings.ts packages/contracts/src/settings.test.ts packages/contracts/src/rpc.ts packages/contracts/src/rpc.test.ts packages/contracts/src/clientRpcPermissions.ts packages/contracts/src/clientRpcPermissions.test.ts packages/provider-core/src/server/ProviderAdapter.ts packages/provider-core/src/server/textGeneration.ts packages/provider-core/src/server/textGenerationContracts.test.ts apps/server/src/mcp/McpInvocationContext.ts apps/server/src/mcp/McpInvocationContext.test.ts packages/provider-opencode/src/server/textGeneration.ts packages/provider-opencode/src/server/textGeneration.test.ts
```

| Command               | Why it reads the actual change                                                                                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| contracts tsc         | `-p packages/contracts/tsconfig.json`; include `src` at `tsconfig.json:4`, including new memory and focused test files. It checks code/types, not this Markdown.                                                                                                                                                          |
| provider-core tsc     | explicit config; include `src` at `packages/provider-core/tsconfig.json:6`; reaches turn input, generation interface and test imports.                                                                                                                                                                                    |
| provider consumer tsc | Explicit `-p packages/provider-{opencode,muse,cursor,grok,pi,acp-registry}/tsconfig.json` (run individually as above); each config includes `src`. OpenCode v1/v2 share one package. Server's `src` includes Codex/Claude/Antigravity runners. These are read-only compile consumers except the OpenCode enum/test delta. |
| server tsc            | explicit config; include `src` at `apps/server/tsconfig.json:7`; reaches invocation context and its tests, plus dependent compile seams. Package-wide server typecheck is the targeted package, not recursive repository typecheck.                                                                                       |
| targeted lint         | every changed TS path is a positional argument; root lint config `vite.config.ts:109–125` excludes vendored/generated/native files, not these paths. No unscoped lint invocation.                                                                                                                                         |

The package scripts use `tsc-rs --noEmit` (`packages/contracts/package.json:32`,
`packages/provider-core/package.json:188`, `apps/server/package.json:23`); explicit tsc `-p`
is permitted by WP0 and avoids root `typecheck`, which is recursive. YAML/Markdown are not
covered by these TypeScript commands; inspect their diff and use goat-ci to validate the
workflow. This docs-only authoring run needs no package typecheck or lint: those would inspect
unchanged source and give no evidence about this plan. The commands above are future implementation verifiers, NOT RUN in rev 11; the target implementation must first be based on the recorded dev SHA and have its actual diff/config collection checked.

Tests run in PR CI (goat-ci), not this Mac. Existing coverage: contracts step
`.github/workflows/goat-ci.yml:108–110`, server shards `:130–132`; package scripts select
contracts/provider-core through `--config ../../vite.config.ts --dir .`
(`packages/contracts/package.json:33`, `packages/provider-core/package.json:189`). The root
config has no provider-core exclusion (`vite.config.ts:59–78`). Add this step in the future
WP1 PR because the current `test` task runs only ssh/web (`goat-ci.yml:98–102`):

```yaml
- name: Test provider core
  if: matrix.task == 'test'
  run: |
    vp run --filter @goat/provider-core test
    vp test run --config vite.config.ts packages/provider-opencode/src/server/textGeneration.test.ts
```

This is CI-only command text, never a local instruction. Matrix already contains `test`
(`goat-ci.yml:29–39`) and that task already installs its prerequisites (`:85–86`). No new
runner or whole-repository suite is requested. Exact-head goat-ci success must include the
new provider-core step, contracts tests and relevant server shard; cancelled/skipped runs
are not proof. Record typecheck/lint command and exit code, then CI run URL/head and focused
case results in the eventual PR handoff. Do not claim tests passed from a static check.

## PR title and body brief

Title: `feat(contracts): define cross-environment memory protocol`

Body: GOAT has no shared memory boundary between environments, clients and provider runtimes.
Add typed memory operations with purgeable payloads, hub and source locators, permission scopes,
RPC/MCP shapes and bounded provider context/generation inputs. Keep protocol advertisement and
live handler registration off until the service phases exist. Preserve old settings, grants,
descriptors and persisted provider capabilities. Include targeted static results and exact-head
goat-ci contract/provider-core/server results; end with `Model: gpt-6.1-sol. Harness: Codex in GOAT.`
No UI files change, so screenshots are N/A for WP1. This document author does not create a PR,
commit or push; the title/body are the requested future implementation specification.

## WP1 commit plan

One implementation PR on the recorded latest-dev source, consuming WP0's decisions; these are
small dependency-ordered commits inside that PR, not separate PRs. Each commit includes its
focused schema tests. No commits are made by this documentation lane.

| Order / proposed title                                               | Exact change slice                                                                                                                                                                                                                                                                                                                                                     | Reviewable completion and later verifier                                                                                                                                                                                                                |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — `feat(contracts): define memory identities and canonical codecs` | NEW `packages/contracts/src/memory.ts` / `memory.test.ts`; root export in `index.ts`. Define ids, constants (including rev 10 sweep limits), payload/metadata, DAG, suppression, strict MemoryModelSelection and its rejection/preservation fixtures, bounded operation/event encoders and pure relational checks. Define every helper referenced here in this commit. | Root-import fixtures, strict decode/encode/make and UTF-8 equality/+1; metadata never carries bodies. Contracts tsc + scoped lint; tests in CI.                                                                                                         |
| 2 — `feat(contracts): define memory sync and local status views`     | Extend only `memory.ts` / `memory.test.ts`: hub/lease/checkpoint/source-relay, exact permanent ledger schemas and validateMemoryCheckpointRecords with multi-page/purge/limit fixtures, availability/deferred/coverage, storage/growth/capacity, revert, binding, import/admin/report and snapshot/generation schemas; derived candidate types.                        | M19/M20 codec fixtures preserve original receipts and distinguish accepted from locally visible. No SQL, compactor, quota admission or local runtime closure. Contracts static checks + CI.                                                             |
| 3 — `feat(contracts): add memory scopes and settings compatibility`  | `auth.ts` / `auth.test.ts`, `settings.ts` / `settings.test.ts`, `environment.ts` / `environment.test.ts`, `orchestrationV2.ts` / `orchestrationV2.test.ts`, `channelCommon.ts` / `channelCommon.test.ts`.                                                                                                                                                              | Old decisions/settings/events decode; absent consent denies; no legacy parent or sync default; both generic reserved keys fail before stripping. No capability producer enabled. Contracts/server static checks + CI.                                   |
| 4 — `feat(contracts): declare staged memory RPC and client guards`   | `rpc.ts` / `rpc.test.ts`, `clientRpcPermissions.ts` / NEW `clientRpcPermissions.test.ts`. Declare 14 core + 1 import, middleware, guard map, both compound-scope branches.                                                                                                                                                                                             | Live WsRpcGroup unchanged; exact tags/results/error arms, stream flag and guard membership checked. No server handler/scope-map activation. Contracts/server static checks + CI.                                                                        |
| 5 — `feat(provider-core): add compatible memory generation seams`    | `ProviderAdapter.ts`, core `textGeneration.ts` / NEW `textGenerationContracts.test.ts`; OpenCode `textGeneration.ts` / `textGeneration.test.ts`; server `McpInvocationContext.ts` / its test.                                                                                                                                                                          | Core optional keys and OpenCode enum land together. All old factories compile, model output cannot forge execution metadata, absent capability/grants remain disabled. All nine targeted package configs in the verification section; scoped lint + CI. |
| 6 — `test(ci): run memory provider contract compatibility`           | `.github/workflows/goat-ci.yml` adds the existing-test-task provider-core and focused OpenCode commands in the verification section.                                                                                                                                                                                                                                   | Exact final-head contracts, provider-core, OpenCode and applicable server CI cases execute. YAML review + hosted result, not a local test run.                                                                                                          |

Commits 1–2 may grow the same new module in two coherent pieces; do not import a helper from
commit 2 in commit 1. Specifically, commit 1 defines MemoryModelSelection, MemoryLocalAvailability
(and its deferred helpers used by MemoryItem), MemoryImportSourceMetadata/MemoryImportFormat,
MemorySourceKey/MemoryContentSuppression/MemorySourceExclusion and every safe failure literal used
by its operations. Split their definitions out of commit 2 views; operation validators in commit 1
do not call checkpoint/generation/view validators introduced in commit 2. Commit 2 adds hub receipt,
lease, ledger/page and cross-page helpers together, consuming only commit 1 definitions.
Commits 3–5 consume the complete wire definitions. An implementation
finding that requires a live tool/route, required runner method or a source edit outside this map
returns to P; do not conceal it with a dummy success implementation. Before final A/C, repeat
consumer searches on the actual head and verify every mapped TS path is collected by its config.

## Boundaries and assigned phase handoffs

- [WP2 store/service](020_wp2_store_service.md): consume metadata-only event encoding and
  purgeable operation bodies/judgment; implement stateful guards, scanner and both generation
  operations with all six providers. Stamp provenance/source watermarks server-side. Validate
  summary/resolution evidence and never copy whole operation JSON into immutable events.
  Scope is immutable for an existing memoryId; a scope move creates a new id. Union suppression
  fragments on repeated forget, and preserve all original input refs for explicit revert.
- [WP3 hub sync](030_wp3_hub_sync.md): consume eleven HTTP schemas, principal-only memory:sync,
  per-item receipts, fixed high-watermark bootstrap, durable parent parking and lease fields.
  Join installs tombstones before sending outbox; attempts cannot exceed 600s. Ensure settings
  mutation cannot bypass secret management or bootstrap. No actual hub selection/run here.
- [WP4 MCP/RPC/injection](040_wp4_mcp_injection.md): merge WsMemoryCoreRpcGroup with its fourteen complete
  thin handlers and exhaustive RPC_REQUIRED_SCOPES; WP5 installs the import group. Add import's extra filesystem
  read check and source-owner grants. Carry authenticated permissions into registry/OAuth
  contexts, recheck revoked grants at commit, use writesWithCapability plus explicit scope
  checks. Build declarations through `McpToolAccess.toLayer` and register through
  `McpHttpServer.toolkitRegistration`; do not call raw Effect toolkit registration or borrow
  `removesCheckouts` for memory operations. Read declarations still require explicit memory
  authorization in the handler/service. Produce and advertise separate snapshot/MCP/generation capabilities only with runtime
  evidence; implement all six deliveries and bounded snapshot consistency/compaction purge.
- [WP5 imports](050_wp5_provider_import.md): accept format+scope, never arbitrary paths; receipts
  use stable sourceId/sourceItemKey independent of changing fingerprint, so deletion suppression
  survives edits and cannot be bypassed by assigning a new memory id on import.
- [WP6 clients/reports](060_wp6_clients_reports.md): query/command through client-runtime,
  destination permissionAtom guards and protocol-version gating; no environment fallback.
  Revert must select an original revision explicitly for conflicts with more than two variants.
  Reports carry ids/status/links rather than text or judgment. Source pages remain owner-routed.

Out of scope: migrations, SQL service implementations, route/tool registration, workers,
provider prompts/delivery, provider-native import, client UI, real databases/credentials,
server execution, docs/user or structure updates. Contracts are schemas and small derived
helpers, not an authorization or sync engine. No changes to Aside, provider memory settings
or live `~/.goat`, `~/.t3`, `~/.codex`, `~/.claude`, `~/.omo` state.

Tombstones do not expire; re-remember is a new id. Unknown source/space does not fall back to
another environment. Scope is a shared identity, not a local project record. Assertions never
become facts because a model merged them. Turning a capability on does not grant access.
Optional methods and unmerged RPC groups must be removed as release gaps before WP6 acceptance.

## Authoring evidence

Source reads and baseline git inspection only. No tests, builds, typechecks, lint, server,
commit or push executed for this docs-only task. Only `010_wp1_contracts.md` is authored by this
lane. Relative phase links deliberately name the WP0 target documents; a link to a document
not yet created is a dependency reference, not evidence of its implementation.

Management read/history views of a forgotten item serialize its deletion audit with empty
suppression arrays; retained full unions are used only by the sync/checkpoint fragment producer.
This prevents an unbounded logical tombstone from violating the 64-KiB management envelope.
A forget after checkpoint S purges staged canonical body-bearing rows and encodes safe
source_invalidated metadata plus null revision payloads. Tail pull delivers the newer tombstone
before local push; replica scanner/FTS/staging quota cannot reject complete approved installation.
Derived cleanup may remain cleanupPending behind an immediate read fence; no stale staged body survives.

## Cross-phase contract reconciliation (rev 2)

Consolidated blocked/suppression/generation, checkpoint/admin/import/report wire contracts, safe errors, capability advertisements, grants and full wrapper budget. Defined core/import registration order and earlier internal ports; no runtime implemented.

## Reflection r1 fixes (rev 3)

G1–G4 add producers to existing decisions; they do not change M1–M18. WP1 is the sole
wire owner. The definitions below extend the inventory, RPC table, guards and lifecycle above.

### File change map and contract diffs

| Action              | Exact path                                            | Diff to implement                                                                                                                                        |
| ------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MODIFY (NEW in WP1) | `packages/contracts/src/memory.ts`                    | Add binding, change stream and transient source relay schemas/constants below; extend MEMORY_HUB_PATHS to eleven paths.                                  |
| MODIFY              | `packages/contracts/src/auth.ts`                      | Add AuthMcpMemoryScope; extend both approving decision arms and approval details, preserving absent-field decoding.                                      |
| MODIFY              | `packages/contracts/src/rpc.ts`                       | Add memoryProjectBindingGet/Update and memoryChanges keys; declare fourteen core RPCs, with stream:true only on memory.changes.                          |
| MODIFY              | `packages/contracts/src/clientRpcPermissions.ts`      | Guard binding get/update with memory:write; readSource requires memory:read AND orchestration:read at requester; changes requires memory:read on server. |
| MODIFY (NEW in WP1) | `packages/contracts/src/memory.test.ts`               | Binding/change/relay round trips and rejection cases below.                                                                                              |
| MODIFY              | `packages/contracts/src/auth.test.ts`                 | Consent omission, both arms and exact grant set cases below.                                                                                             |
| MODIFY              | `packages/contracts/src/rpc.test.ts`                  | Fourteen core methods and staged import contract cases below.                                                                                            |
| MODIFY (NEW in WP1) | `packages/contracts/src/clientRpcPermissions.test.ts` | Binding and source compound grant cases below.                                                                                                           |

Import ScopedProjectRef alongside ScopedThreadRef. Declare MemorySourceReadRequestId with the
same UUID brand pair as the seven durable ids; it identifies a transient request, never a revision
or operation. Add it to the repeated brand recipe and the all-id round-trip fixture.

```diff
--- packages/contracts/src/auth.ts (live auth.ts:575–615)
+++ packages/contracts/src/auth.ts
+export const AuthMcpMemoryScope = Schema.Literals(["memory:read", "memory:write"]);
+export type AuthMcpMemoryScope = typeof AuthMcpMemoryScope.Type;
 // AuthMcpApprovalDetails
+oneClickMemoryScopes: Schema.optionalKey(Schema.Array(AuthMcpMemoryScope)),
 // EACH pairing-code/browser-session arm of AuthMcpApprovalDecision
+memoryScopes: Schema.optionalKey(Schema.Array(AuthMcpMemoryScope)),
 // Reject duplicate selections; deny arm has no memoryScopes.
 // Absent means [], never infer from access. No memory:sync or unknown scope.
```

oneClickMemoryScopes lists only grants the live approving browser holds; it is not a grant to
the agent. Decision memoryScopes is explicit consent, independent of access and CSRF/code proof.
WP4 normalizes omission to [] once, carries the normalized selection into PendingCode and session
issuance, and verifies the complete resulting scope set on both approval paths.

| Schema / RPC                                                   | Exact fields and constraints / result / grant                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MemoryProjectBinding                                           | memorySpaceId, project:ScopedProjectRef, projectKey:MemoryProjectKey                                                                                                                                                                                                                                                           | null, repositoryKey:MemoryProjectKey repository arm | null, version:NonNegativeInt. projectKey is the persisted effective key, repositoryKey the pinned fallback. Null effective key permits an unmapped local project.                           |
| MemoryProjectBindingGetInput / memory.projectBinding.get       | memorySpaceId, project:ScopedProjectRef → MemoryProjectBinding; memory:write (sensitive settings read).                                                                                                                                                                                                                        |
| MemoryProjectBindingUpdateInput / memory.projectBinding.update | memorySpaceId, project, requestId:MemoryOperationId, expectedVersion:NonNegativeInt, action:'setExplicit' with sharedProjectId (trimmed, <=512 UTF-8 bytes) OR action:'useRepository' without id → MemoryProjectBindingUpdateResult {binding:MemoryProjectBinding,requestId}; memory:write. No arbitrary repository key input. |
| MemoryChangesInput / memory.changes                            | memorySpaceId → stream of MemoryChangeSignal; memory:read, stream:true, no MCP tool.                                                                                                                                                                                                                                           |
| MemoryChangeSignal                                             | Union reset {kind:'reset',memorySpaceId,projectionWatermark:NonNegativeInt}; item {kind:'upsert'                                                                                                                                                                                                                               | 'forget'                                            | 'invalidate',memorySpaceId,memoryId,projectionWatermark:NonNegativeInt}. No payload, revision body, original, draft, source page or cause. Watermark is environment-local, not hubSequence. |

Binding updates are environment-local settings commands, not MemoryOperation arms. Foreign
ScopedProjectRef is denied; absence reads as version 0. useRepository removes the explicit key,
restores the pinned repositoryKey (or null), and does not rewrite existing memory scopes. All three
new RPCs use MemoryRpcError|EnvironmentAuthorizationError. Binding updates use requestId/digest
replay, expectedVersion, and WP2 atomic persistence; no hub broadcast of local ProjectIds.

```ts
// rpc.ts: add to the same authorization-middleware core group; unary bindings use Rpc.make.
Rpc.make(WS_METHODS.memoryChanges, {
  payload: MemoryChangesInput, success: MemoryChangeSignal,
  error: Schema.Union([MemoryRpcError, EnvironmentAuthorizationError]), stream: true,
});
// clientRpcPermissions.ts
[WS_METHODS.memoryProjectBindingGet]: AuthMemoryWriteScope,
[WS_METHODS.memoryProjectBindingUpdate]: AuthMemoryWriteScope,
// clientRpcRequiredScopes special branch:
// memoryReadSource => [AuthMemoryReadScope, AuthOrchestrationReadScope]
```

### G4 bounded source relay contracts

MEMORY_SOURCE_READ_TIMEOUT_MS=75_000; MEMORY_SOURCE_READ_POLL_MS=1_000. Reuse the canonical
UTC codec, page item/byte limits and WP1 safe errors. Four POST paths extend MEMORY_HUB_PATHS
under /api/memory-hub/v1/source-read/. Every input carries protocolVersion:1 and memorySpaceId;
MemoryHubAuth derives sender identity, not a caller-provided principal. Every result is no-store.

| Schema                                   | Additional fields / result                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MemorySourceReadRequest                  | requestId:MemorySourceReadRequestId, requesterEnvironmentId, memoryId, sourceThread:ScopedThreadRef, sourceWatermark:MemorySourceWatermark, messageIds:MessageId[] (unique 1..100), limit:1..100, cursor?:string, authorizedScopes:readonly ['memory:read','orchestration:read'], expiresAtHubTime:canonical UTC. Hub stamps requester and expiry; requester server stamps the grant attestation after live checks. |
| MemoryHubSourceReadRequestInput / Result | Input requestId plus memoryId/sourceThread/sourceWatermark/messageIds/limit/cursor/authorizedScopes above; result {request:MemorySourceReadRequest}. POST request.                                                                                                                                                                                                                                                  |
| MemoryHubSourceReadCollectInput / Result | Input limit:1..32; result {requests:MemorySourceReadRequest[]} bounded to 64 KiB, only requests for authenticated ownerEnvironmentId===sourceThread.environmentId. POST collect.                                                                                                                                                                                                                                    |
| MemorySourceReadOutcome                  | Union {kind:'available',page:MemorySourcePage}; {kind:'unavailable',code:'source_unavailable'                                                                                                                                                                                                                                                                                                                       | 'forgotten' | 'source_invalidated' | 'secret_detected'}; {kind:'denied',requiredPermission:'orchestration:read'}. Bound entire outcome to 64 KiB, whole messages, no raw cause. Available page's thread/watermark must equal request; messages subset of request locators. |
| MemoryHubSourceReadRespondInput / Result | Input requestId, outcome:MemorySourceReadOutcome; result {accepted:boolean}. POST respond. Only authenticated source owner responds; mismatched thread/message ids fail before payload storage.                                                                                                                                                                                                                     |
| MemoryHubSourceReadResultInput / Result  | Input requestId; result union {state:'pending',expiresAtHubTime}; {state:'completed',outcome:MemorySourceReadOutcome}; {state:'expired',code:'source_unavailable'}. POST result; only authenticated requester consumes.                                                                                                                                                                                             |

authorizedScopes is a **trusted requesting server's attestation**, never memory.readSource tool
input. Hub verifies active same-owner provisioned membership/space for requester and owner, and
binds attestation to request digest. Owner explicitly verifies both attested scopes and its current
same-owner delegated transcript-read policy before its committed read; memory:sync authenticates
transport only. A policy denial returns denied, mapped by WP4 to EnvironmentAuthorizationError.
No client token is forwarded/stored. Provisioning must verify the same owner; cross-owner relay
is unsupported. The concrete owner policy is: current locally configured memory space/hub identity matches the request, requester is an active provisioned member authenticated by that hub, both explicit scope attestations exist, and the referenced owner-local thread is readable and not deleted. Hub provisioning by the local settings:write owner is the trust producer, not self-enrollment; any failed predicate denies. Recheck current policy at read and response admission; no extra connection registry is presumed.

Only evidence-linked committed message IDs up to the retained watermark are eligible. Neither
memory:read alone nor an arbitrary ScopedThreadRef grants transcript access. Request/response is
transient hub relay traffic; never append it to memory_hub_operations, snapshots, FTS, reports or
sync checkpoints. WP3 owns bounded retention and forget purge; provider originals remain unchanged.

### Generation → serialization → deserialization → consumer chains

| Gap | Complete chain                                                                                                                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | WP6 picker → binding input RPC JSON → strict input decode/live memory:write → WP2 binding SQL codec → MemoryProjectBinding result decode → shared command, candidate resolver, snapshot and WP5 import resolver. Two environments deliberately set the same explicit id for their distinct local projects.                                         |
| G2  | ConnectAgentSurface selection → AuthMcpApprovalDecisionRequest JSON → decision decode → WP4 browser/code full-set proof → PendingCode.memoryScopes → exchange → issueMcpClientSession → SessionStore scopes codec → authenticated grantedScopes/reauthorize → capability plus all nine tools. Old decisions/codes/sessions yield no memory grants. |
| G3  | WP2 committed local/received/checkpoint projection → allowlisted MemoryChangeSignal → WP4 streaming RPC JSON → stream decoder → environment-keyed runtime eviction/generation fence → web, desktop and mobile drafts/details/original/source caches.                                                                                               |
| G4  | readSource live permit + validated evidence → injected relay port → four strict hub HTTP codecs/SQL request and purgeable outcome → owner sync collection/thread read/response → requester outcome decoder/live permit/tombstone recheck → existing MemorySourcePage RPC/tool output or typed source_unavailable.                                  |

### Activation and CI cases to write

| Exact file                                          | Case / observable result                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| packages/contracts/src/memory.test.ts               | `round trips binding actions and rejects foreign-shaped keys and extra fields`; `round trips body free reset forget and invalidation signals`; `rejects signal bodies and wrong watermarks`; `round trips all four relay requests outcomes and expired result`; `rejects wrong page thread message ids oversized outcome and noncanonical deadline`; `source request id is not an operation id`. Fixtures encode/decode/make at boundary equality and overflow. |
| packages/contracts/src/auth.test.ts                 | `old approval omission grants no memory`; `both approval arms round trip explicit read write selection`; `rejects sync duplicate and unknown memory grants`; `one click advertised scopes grant nothing by themselves`.                                                                                                                                                                                                                                         |
| packages/contracts/src/rpc.test.ts                  | `declares fourteen core methods and one staged import`; `memory changes is a typed authorized stream`; `binding commands have exact input result and errors`.                                                                                                                                                                                                                                                                                                   |
| packages/contracts/src/clientRpcPermissions.test.ts | `binding get and update require memory write`; `source read needs explicit thread read`; `memory write never implies source read`.                                                                                                                                                                                                                                                                                                                              |

Activation: no remote+no explicit id means unmapped; setExplicit joins two local projects to the
same project scope; restart and remote edits retain the pinned key; useRepository reverses only
future selection. OAuth omitted/read/read+write selections remain independent of access. A remote
forget evicts an open client; stream reconnect resets all body state. Source owner sync produces a
real cross-environment page; offline owner or 75-second deadline returns source_unavailable, with
summary still readable. WP2–WP6 own stateful tests; these schemas alone prove no runtime behavior.

## Audit r1 fixes (rev 4)

### B1 — independent WP1 compatibility

Read-only source search `rg -n 'keyof ProviderTextGeneration' packages apps` finds exactly
`packages/provider-core/src/server/textGenerationOperations.ts:32` and
`packages/provider-muse/src/server/textGeneration.ts:73` on citation baseline b5f9d53cb. Follow the exported
Operation/Request/Runner consumers: Codex, Claude, Antigravity, Cursor, Grok, OpenCode v1/v2,
Pi and Muse (complete source inventory in the rev 11 stale check). OpenCode v1's error schemas alone constrain this operation to six literals; Muse's
operation parameter flows to TextGenerationError's string field, with no exhaustive switch or
closed operation schema. No Muse source change is needed; its package typecheck is a WP1 gate.
Core Runner/fromRunner retain their old behavior until WP2. Search again at each phase P.

```diff
// packages/provider-opencode/src/server/textGeneration.ts:13-20 — WP1, not WP2
 const OpenCodeTextGenerationOperation = Schema.Literals([
   // all six existing literals retained
+  "resolveMemoryConflict",
+  "generateMemorySummary",
 ]);
```

WP1 CI adds `OpenCode error contexts round-trip both memory operation names` to the existing
textGeneration.test.ts; decode/encode each exported error class's operation field, retain all
old literals and reject unknown names. WP1 typechecks contracts/core/server/OpenCode/Muse/Cursor/Grok/Pi/ACP Registry;
optional object compatibility alone is not an independent completion criterion.

### B5/B6 — owning contracts

ServerSettings retains memoryHub and memoryHubVersion; ServerSettingsPatch never accepts
memoryHub or memoryHubVersion. Add an explicit reserved-key check on raw generic patches before Struct decoding so unknown-key stripping
cannot turn a forbidden patch into success. `server.updateSettings` rejects raw input during schema decode before mutation;
typed runtime rejection uses its existing ServerSettingsError with operation="normalize". Dedicated memory.hubSettings.update retains
requestId/expectedVersion and MemoryHubSettingsUpdateResult; this contract is never reconstructed
from a generic patch. settings.test.ts covers raw JSON containing either reserved key alone and alongside
another valid setting (all fail atomically); do not place this check only on an already-stripped Struct.

MemoryGenerationExecution adds required providerInstanceId and environmentId as specified in
the field table. Both execution result codecs serialize result and execution separately;
model output codecs reject an execution field. WP2 owns the internal MemoryRunner/bound context
and consumers, not a wire generation-context field. memory.test.ts verifies environment/instance
round-trip and instance equality; textGenerationContracts.test.ts rejects forged model metadata.

B7/B8: see [Enforcement inventory](000_plan.md#enforcement-inventory). The static coverage receipt
below includes the OpenCode delta and Muse read-only compile consumer; CI execution is still required.

### B8 — mechanical static-input coverage receipt

Final NEW/MODIFY map (including rev 2/3/4 additions): **24 TS/TSX paths**.
Compared path equality/explicit-directory ancestry against every `vp lint` argument and
package ownership against explicit `-p` / exact package-filter typecheck commands: **0 uncovered
lint targets, 0 uncovered typecheck targets** after declared generated-file exclusions.
Typecheck owners: `apps/server/tsconfig.json`, `packages/contracts/tsconfig.json`, `packages/provider-core/tsconfig.json`, `packages/provider-muse/tsconfig.json`, `packages/provider-opencode/tsconfig.json`; rev 11 also checks read-only Cursor/Grok/Pi/ACP Registry consumers with their explicit package configs.
This is path/config reconciliation, not successful compiler/linter execution. Workflow YAML,
package manifests and prose are outside TS lint; review their diffs and validate in CI. At phase P
repeat with the actual diff, compiler file collection and lint ignores; an exit 0 without target
collection is insufficient. Authoring uses Python text checks only; no installation/check runner.

## Reflection r3 fixes (rev 5)

G1 adds `MemoryRevertStatus` / `MemoryRevertResult` to the sole wire owner and changes
`memory.revertResolution` / `memory_revert_resolution` results from MemoryMutationReceipt.
History includes bounded local revertResults for reconnect/status recovery; no new status RPC.
The existing revert operation is a submission envelope until hub admission, not a local revision.

Planned contracts CI: round-trip all result arms with accepted plus localAvailability held/index
pending; reject pending/rejected arms carrying approved receipt/revision. Require approved revision
on accepted, not body readiness. Round-trip bounded history results and RPC/MCP parity.
No tests/typecheck/lint were run for this document revision.

## Requirement 7 / M19 (rev 7)

### Single owner of constants and units

Export the following constants from packages/contracts/src/memory.ts in WP1. Values below
are pre-approval defaults. Other phases import/reference names, never define copies. Bytes
are UTF-8 encoded logical bytes unless explicitly allocated SQLite pages; durations use ms.
Existing MEMORY_PAYLOAD_MAX_UTF8_BYTES and MEMORY_SOURCE_READ_TIMEOUT_MS remain unchanged.
Per-dimension and aggregate limits govern localIntent/hubAdmission, including protected/held
payload accounting; IDs never become reusable. ApprovedReplica accounts actual usage without
capacity rejection; excess limits future local creation, not durable receipt/cursor ingestion.
Approved deferred flags/references belong to canonical rows, not MEMORY_WORK_MAX_PENDING_ITEMS
(10,000) or the 32-MiB unapproved-work payload budget; bounded scans fetch work without copying bodies.

| Constant                                      | Default    | Dimension / application                                                                                                                                                                               |
| --------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MEMORY_BODY_MAX_UTF8_BYTES                    | 16 KiB     | payload.text, independent of encoded payload cap                                                                                                                                                      |
| MEMORY_USER_MAX_ITEMS                         | 2,000      | user live items per space                                                                                                                                                                             |
| MEMORY_PROJECT_MAX_ITEMS                      | 2,000      | live items per project                                                                                                                                                                                |
| MEMORY_THREAD_MAX_SUMMARIES                   | 1          | stable summary identity per thread                                                                                                                                                                    |
| MEMORY_THREAD_MAX_EXPLICIT_ITEMS              | 100        | explicit memories per thread                                                                                                                                                                          |
| MEMORY_SPACE_MAX_LIVE_ITEMS                   | 20,000     | space live/quarantined/blocked                                                                                                                                                                        |
| MEMORY_ENVIRONMENT_MAX_LIVE_ITEMS             | 20,000     | total across bound spaces in one environment                                                                                                                                                          |
| MEMORY_LIVE_MAX_PAYLOAD_BYTES                 | 128 MiB    | total retained live payloads per space and environment                                                                                                                                                |
| MEMORY_SUBSTRING_MAX_ITEMS                    | 2,000      | scope-filtered explicit substring candidates                                                                                                                                                          |
| MEMORY_SUBSTRING_MAX_UTF8_BYTES               | 8 MiB      | substring candidate text, fail before partial scan                                                                                                                                                    |
| MEMORY_TRIGRAM_EXPERIMENT_MAX_BODY_BYTES      | 32 MiB     | future replacement experiment only, not initial admission                                                                                                                                             |
| MEMORY_TRIGRAM_EXPERIMENT_MAX_ITEMS           | 5,000      | future replacement experiment only                                                                                                                                                                    |
| MEMORY_TRIGRAM_EXPERIMENT_MAX_ALLOCATED_BYTES | 64 MiB     | future replacement experiment only                                                                                                                                                                    |
| MEMORY_IMPORT_SNAPSHOT_MAX_UTF8_BYTES         | 8 MiB      | transient reader snapshot                                                                                                                                                                             |
| MEMORY_IMPORT_PREVIEW_MAX_ITEMS               | 128        | preview                                                                                                                                                                                               |
| MEMORY_IMPORT_APPLY_MAX_ITEMS                 | 32         | one apply call                                                                                                                                                                                        |
| MEMORY_IMPORT_SESSION_MAX_NEW_ITEMS           | 128        | entire import session                                                                                                                                                                                 |
| MEMORY_IMPORT_SESSION_MAX_BODY_BYTES          | 2 MiB      | entire import session admitted text                                                                                                                                                                   |
| MEMORY_IMPORT_MAX_LIVE_ITEMS                  | 10,000     | cumulative imported live items per space/environment                                                                                                                                                  |
| MEMORY_IMPORT_MAX_LIVE_BODY_BYTES             | 64 MiB     | cumulative imported live text                                                                                                                                                                         |
| MEMORY_IMPORT_MAX_SOURCE_ITEMS                | 50,000     | lifetime source-item identities per space                                                                                                                                                             |
| MEMORY_IMPORT_MAX_ALIASES                     | 100,000    | lifetime unique aliases per space                                                                                                                                                                     |
| MEMORY_IMPORT_MAX_CONTENT_DIGESTS             | 100,000    | lifetime accepted content digests per space                                                                                                                                                           |
| MEMORY_IMPORT_KEY_MAX_UTF8_BYTES              | 512        | source-item/alias key                                                                                                                                                                                 |
| MEMORY_IMPORT_DIGEST_MAX_UTF8_BYTES           | 64         | canonical digest                                                                                                                                                                                      |
| MEMORY_REVERT_WINDOW_MS                       | 30 days    | from resolution appliedAtUtc                                                                                                                                                                          |
| MEMORY_REPLACED_PAYLOAD_RETENTION_MS          | 30 days    | from replacement, not revision creation                                                                                                                                                               |
| MEMORY_RESOLUTION_PAYLOAD_RETENTION_MS        | 30 days    | originals/judgment from resolution acceptance                                                                                                                                                         |
| MEMORY_HISTORY_MAX_PAYLOAD_BYTES              | 128 MiB    | retained superseded/resolution payloads                                                                                                                                                               |
| MEMORY_CHECKPOINT_INTERVAL_MS                 | 1 day      | operational checkpoint cadence                                                                                                                                                                        |
| MEMORY_CHECKPOINT_TRIGGER_TAIL_ROWS           | 10,000     | earlier row/byte/time trigger                                                                                                                                                                         |
| MEMORY_CHECKPOINT_TRIGGER_TAIL_BYTES          | 32 MiB     | checkpoint trigger                                                                                                                                                                                    |
| MEMORY_LOG_RETENTION_MS                       | 30 days    | safe prefix eligibility age                                                                                                                                                                           |
| MEMORY_LOG_MAX_TAIL_ROWS                      | 50,000     | hard uncompressed tail admission                                                                                                                                                                      |
| MEMORY_LOG_MAX_TAIL_BYTES                     | 64 MiB     | hard uncompressed tail bytes                                                                                                                                                                          |
| MEMORY_CANONICAL_STAGING_MAX_BYTES            | 512 MiB    | canonical + retained + staging logical aggregate                                                                                                                                                      |
| MEMORY_FTS_INDEXED_TEXT_MAX_BYTES             | 128 MiB    | active indexed payload.text UTF-8 bytes per space/environment; transactional hard cap                                                                                                                 |
| MEMORY_FTS_ALLOCATED_WARNING_BYTES            | 96 MiB     | sampled committed FTS/shadow/index allocation schedules maintenance                                                                                                                                   |
| MEMORY_FTS_ALLOCATED_BRAKE_BYTES              | 128 MiB    | sampled physical allocation persists local-creation/index brake; approved receive exempt, not a hard physical cap                                                                                     |
| MEMORY_FTS_ALLOCATED_RESUME_BYTES             | 96 MiB     | clear only after maintenance and fresh allocation strictly below this value                                                                                                                           |
| MEMORY_STORAGE_SAMPLE_MAX_DAYS                | 30         | completed UTC daily rows plus one fixed current sample outside the ring                                                                                                                               |
| MEMORY_STORAGE_SAMPLE_MAX_UTF8_BYTES          | 16 KiB     | canonical encoded sample row including metric IDs/timestamps                                                                                                                                          |
| MEMORY_STORAGE_SAMPLE_MAX_TABLES              | 64         | fixed allowlisted memory table/index groups; no silent truncation                                                                                                                                     |
| MEMORY_PERMANENT_METADATA_MAX_BYTES           | 128 MiB    | all permanent ledgers aggregate                                                                                                                                                                       |
| MEMORY_MAX_LIFETIME_IDS                       | 50,000     | MemoryId identities per space including forgotten IDs                                                                                                                                                 |
| MEMORY_IDENTITY_CORE_MAX_BYTES                | 1 KiB      | fixed core identity + initial forget reserve; extra keys separately charged                                                                                                                           |
| MEMORY_DEDUP_MAX_RECEIPTS                     | 250,000    | permanent compact operation receipts per space                                                                                                                                                        |
| MEMORY_COMPACT_RECEIPT_MAX_BYTES              | 256 B      | canonical compact binary row encoding, no detailed JSON                                                                                                                                               |
| MEMORY_IMPORT_BATCH_RETENTION_MS              | 30 days    | completed batch detail                                                                                                                                                                                |
| MEMORY_REPORT_DETAIL_RETENTION_MS             | 30 days    | from deliveredAtUtc                                                                                                                                                                                   |
| MEMORY_SOURCE_READ_MAX_PER_ENVIRONMENT        | 32         | concurrent relay requests                                                                                                                                                                             |
| MEMORY_SOURCE_READ_MAX_PER_HUB                | 128        | aggregate concurrent relay requests                                                                                                                                                                   |
| MEMORY_SOURCE_READ_OUTCOME_MAX_BYTES          | 64 KiB     | encoded relay outcome                                                                                                                                                                                 |
| MEMORY_REPORT_MAX_PENDING_ITEMS               | 2,000      | pending/failed retained report rows                                                                                                                                                                   |
| MEMORY_REPORT_MAX_PENDING_BYTES               | 2 MiB      | payload-free report metadata                                                                                                                                                                          |
| MEMORY_REPORT_MAX_AUTOMATIC_ATTEMPTS          | 10         | stop automatic retry; retain manual retry state                                                                                                                                                       |
| MEMORY_PENDING_FORGET_INTENTS_MAX             | 2,000      | body-free durable pending forget intents per environment across spaces; separately reserved metadata; equality persists, +1 explicitly fails preservation (WP2 rev 13; WP1 export follow-up required) |
| MEMORY_WORK_MAX_PENDING_ITEMS                 | 10,000     | runnable/pending jobs + outbox + parked inputs                                                                                                                                                        |
| MEMORY_WORK_MAX_PAYLOAD_BYTES                 | 32 MiB     | aggregate outbox/job/parked input payload                                                                                                                                                             |
| MEMORY_HUB_MAX_MEMBERS                        | 128        | lifetime member slots; no silent member eviction                                                                                                                                                      |
| MEMORY_CHECKPOINT_MAX_HANDLES_PER_MEMBER      | 1          | replacement explicitly expires old handle                                                                                                                                                             |
| MEMORY_CHECKPOINT_MAX_HANDLES_PER_HUB         | 128        | hub aggregate handles                                                                                                                                                                                 |
| MEMORY_CHECKPOINT_TOKEN_TTL_MS                | 10 minutes | first issuance, retries do not extend                                                                                                                                                                 |
| MEMORY_CAUSAL_BOUNDARY_ID_MAX_UTF8_BYTES      | 64 B       | opaque boundary identifier                                                                                                                                                                            |
| MEMORY_CHECKPOINT_STAGING_MAX_BYTES           | 128 MiB    | hub/environment staging total, not per handle                                                                                                                                                         |
| MEMORY_DERIVED_CACHE_MAX_BYTES                | 32 MiB     | environment snapshot/source caches within staging aggregate                                                                                                                                           |
| MEMORY_DERIVED_CACHE_TTL_MS                   | 10 minutes | replacement/expiry, no archived snapshot files                                                                                                                                                        |
| MEMORY_FTS_MERGE_TRIGGER_CHANGES              | 1,000      | earlier change/time trigger                                                                                                                                                                           |
| MEMORY_FTS_MERGE_INTERVAL_MS                  | 1 day      | schedule bounded merge                                                                                                                                                                                |
| MEMORY_FTS_MERGE_MAX_PAGES                    | 64         | approximate per-step FTS page work                                                                                                                                                                    |
| MEMORY_FTS_OPTIMIZE_INTERVAL_MS               | 7 days     | full optimize equivalent split into bounded merges; also after large purge                                                                                                                            |
| MEMORY_RESOLUTION_MAX_ACTIVE                  | 4          | WP3 registry reserved/running/finalizing executions                                                                                                                                                   |
| MEMORY_QUOTA_WARNING_RATIO                    | 0.80       | warning dimension                                                                                                                                                                                     |
| MEMORY_QUOTA_CRITICAL_RATIO                   | 0.90       | critical warning dimension                                                                                                                                                                            |
| MEMORY_QUOTA_REJECT_RATIO                     | 1.00       | new admission denied if next reservation exceeds limit                                                                                                                                                |
| MEMORY_FREELIST_WARNING_RATIO                 | 0.20       | warning only together with byte threshold                                                                                                                                                             |
| MEMORY_FREELIST_WARNING_MIN_BYTES             | 64 MiB     | shared DB freelist warning threshold                                                                                                                                                                  |

Indexed text is a subset of MEMORY_LIVE_MAX_PAYLOAD_BYTES, which includes encoded live
payloads including blocked/quarantined records; both caps apply independently.
MEMORY_FTS_MAX_ALLOCATED_BYTES is retired: no physical transaction rollback quota remains.
FTS5 deletion may temporarily allocate pages; the sampled brake is not a physical ceiling.

Member/handle and derived cache caps above complete M19's previously unspecified dimensions
as design defaults. A future trigram replacement experiment requires a separate activation
decision and the MEMORY_TRIGRAM_EXPERIMENT_* budgets; it replaces unicode61, never adds a
parallel index. These experiment ceilings authorize no implementation in the initial release.

### Safe errors, status and causal contracts

`MemoryCapacityDimension` is an allowlisted enum naming the quota table dimensions (body,
live counts/bytes, history, import session/live/identity/alias/digest, permanent metadata,
receipt, log tail, work, report, relay, member, checkpoint, cache, fts_indexed_text and fts_admission_brake). For the brake dimension, current/limit
are last available allocation and MEMORY_FTS_ALLOCATED_BRAKE_BYTES; reclaimable is zero
when unknown, not a promise of recoverable pages. Export
`MemoryCapacityExceeded` = `{ code:'capacity_exceeded', dimension, current:NonNegativeInt,
limit:PositiveInt, reclaimable:NonNegativeInt }`; current/limit/reclaimable use the same unit
for that dimension. Add `capacity?: MemoryCapacityExceeded` to MemoryRpcError/MemoryHubError,
rejected MemoryHubReceipt and MemoryImportItemResult/MemoryImportRpcError; required iff code
(or import issue) is capacity_exceeded. MemoryImportIssue remains its literal union.
Expose no raw payload/cause/path. Only hubAdmission produces sequenced rejection; pre-admission
refusal allocates no permanent rejection row. Replica quota/scanner/FTS/report failure never
changes approved outcome; canonical write failure is storage_failed with unchanged cursor.

`base_compacted` distinguishes an older causal parent from an ordinary missing_parent.
`revert_expired` is a terminal safe revert status/error; add `revertDeadlineUtc` to resolution
views/history and MemoryRevertResult. Hub acceptance checks its clock against the original
deadline; retrying an already accepted operation returns its receipt after the deadline.
Pending intents do not extend the deadline; accepted in-flight work pins required inputs until
its outcome is settled. Original pending edit text is preserved for explicit post-bootstrap
review; no automatic reparent to current head.

`MemoryStorageQuota` = `{ dimension, current, limit, reclaimable, reserved, warning:
'normal'|'warning'|'critical'|'full', blockedReasons:string[] }`, with allowlisted safe reasons.
`MemoryStorageTableUsage` = `{ table, rowCount, logicalBytes, allocatedBytes:NonNegativeInt|null,
allocationStatus:'available'|'unavailable' }`, table allowlisted; null means unavailable.
`MemoryCompactionStatus` = `{ lastRunAtUtc:timestamp|null, removedRows, reclaimedLogicalBytes,
reclaimableLogicalBytes, blockedReasons }`.
`MemoryStorageStatus` = `{ quotas:MemoryStorageQuota[], tables:MemoryStorageTableUsage[],
measuredAtUtc:timestamp|null, dbFileBytes:NonNegativeInt|null, walBytes:NonNegativeInt|null,
freelistBytes:NonNegativeInt|null, freelistRatio:number|null, retentionFloor:NonNegativeInt,
checkpointSequence:NonNegativeInt, compaction:MemoryCompactionStatus, ftsAdmission:MemoryFtsAdmissionStatus,
growth:MemoryStorageGrowth, warnings:string[] }`.
Logical counters are transaction-current; page/WAL/file samples have measuredAtUtc, not a
page scan on every status request. Unavailable metrics must remain explicit. dbFileBytes,
walBytes and freelist belong to the shared DB; never attribute freelist to memory tables.

`MemoryFtsAdmissionStatus` = `{ state:'open'|'braked', changedAtUtc:timestamp|null,
lastMeasuredAtUtc:timestamp|null, allocatedBytes:NonNegativeInt|null,
measurementStatus:'available'|'unavailable' }`. Unavailable measurement never clears a
persisted brake and does not invent a new allocation-based brake; logical caps still apply.

`MemoryStorageSample` = `{ measuredAtUtc:timestamp, utcDay:string,
status:'available'|'partial'|'unavailable', memoryLogicalBytes:NonNegativeInt|null,
memoryAllocatedBytes:NonNegativeInt|null, ftsAllocatedBytes:NonNegativeInt|null,
dbFileBytes:NonNegativeInt|null, walBytes:NonNegativeInt|null,
freelistBytes:NonNegativeInt|null, tables:MemoryStorageTableUsage[] }`; day is a validated
UTC date. Metric/table IDs, arrays and encoded rows obey the sample caps. Memory allocation
counts each memory table/index/FTS shadow page once; null unless the complete allowlisted
memory inventory was measured. Partial table measurements remain inspectable.
`MemoryStorageDelta` = `{ days:1|7|30, metric:'memoryLogicalBytes'|'memoryAllocatedBytes'|
'ftsAllocatedBytes'|'dbFileBytes'|'walBytes'|'freelistBytes',
status:'available'|'unavailable', baselineAtUtc:timestamp|null, currentAtUtc:timestamp|null,
elapsedMs:NonNegativeInt|null, deltaBytes:integer|null,
reason:'missing_baseline'|'metric_unavailable'|'clock_discontinuity'|null }`. Negative deltas
are valid; available iff both comparable endpoints exist, delta = current - baseline.
`MemoryStorageGrowth` = `{ current:MemoryStorageSample|null, deltas:MemoryStorageDelta[] }`;
exactly one delta per six metrics per three windows, no unbounded wire sample history.
WP2 owns UTC baseline selection/restart semantics; WP3 forwards decoded fields.

`MemorySearchInput` adds `mode:'fts'|'substring'` (default fts) with the same scope filters;
substring mode has no implicit fallback or partial-success result.
Import sessionId is an opaque server-issued bounded token bound to sourceId/snapshot digest,
environment and space; use MEMORY_CAUSAL_BOUNDARY_ID_MAX_UTF8_BYTES for token length. Preview
issues one persisted session; apply includes it in request digest and enforces aggregate
session counters. Expiry uses MEMORY_DERIVED_CACHE_TTL_MS without resetting accepted counters;
new sessions still consume cumulative space quotas. Completed detailed items may expire,
but compact per-item outcomes plus batch guard reconstruct the original receipt on retry.

`MemoryCausalBoundary` = `{ checkpointSequence:NonNegativeInt, boundaryId:string }`, an opaque
checkpoint identifier bounded by MEMORY_CAUSAL_BOUNDARY_ID_MAX_UTF8_BYTES, not an unbounded revision-id list. Join/checkpoint result
includes `causalBoundary` and `retentionFloor`; checkpoint pages include compact receipts,
identity/tombstone/suppression/fence records and only the ancestry needed for current heads,
unresolved conflicts and still-valid revert inputs. WP1 defines the exact wire schemas and
combined page limits in Permanent checkpoint wire records above; WP2 maps SQL rows and WP3
produces/installs those schemas without defining another wire codec. Permanent unions stream as pages. Completion installs canonical state, boundary, original
receipts, deferred flags and cursor atomically; derived projections/FTS/export drain separately.
Pending edit/MemoryUpsertInput carries observed baseBoundary (nullable before first checkpoint).
Only unapproved local intent with known compacted parent requires base_compacted review. Approved
ancestry covered by checkpoint boundary is valid; actually absent parent is a local linkage hold,
not admission cancellation. Unknown UUID alone is not evidence of compacted ancestry.
All extra ledger records count toward existing combined checkpoint page row/byte limits.
`retentionFloor=F` permits normal tail reads from afterSequence >= F; cursor < F returns
cursor_expired. Publish completed checkpoint before advancing floor. A live token pins its
required tail until MEMORY_CHECKPOINT_TOKEN_TTL_MS; explicit early expiry forces new join,
never partial install. This floor contract is operational, not test-only.

### WP1 proof required in implementation CI

Contract tests round-trip capacity details, braked/open state, signed growth deltas, partial
measurements and unavailable reasons; reject oversized sample rows/arrays and inconsistent
status/null endpoints. Also round-trip storage unavailability, boundary/floor, deadline
and new error arms; independent body/encoded limits use UTF-8 multibyte equality/+1. Every
quota constant has equality/+1 admission fixtures split by localIntent/hubAdmission/approvedReplica;
WP2/WP3 prove local/hub reservation rollback, approved receive despite full local budgets, deferred
index and actual compactor activation. Codecs alone are not enforcement. All new cases NOT RUN here.

## Audit r3 fixes (rev 7)

R1/R2: indexed-text hard quota replaces physical rollback; warning/brake/resume thresholds
belong to maintenance. R3: MemoryStorageSample/MemoryStorageGrowth/MemoryStorageDelta and
MemoryFtsAdmissionStatus extend MemoryStorageStatus. All new constants are owned here;
no runtime closure or physical FTS/file ceiling is claimed.

## M20 replan (rev 8)

Directly replaced receive validation/metadata/checkpoint/quota/scanner/revert expectations. Defines replica-local availability/deferred/coverage/cleanupPending/progress with complete producer→codec→decoder→consumer chains; original hub receipt/digest immutable. Contract and activation fixtures are future NOT RUN obligations.

Docs-only amendment; no source edits, installation, tests, builds, server/user-data writes, commit
or push. All newly specified runtime/CI cases are NOT RUN; no runtime CLOSED or requirement 7
completion is claimed.

## Reflection r7 fixes (rev 9)

- G1: a conflict-only exposure hold no longer cancels claim/resolve. Cancellation is limited to resolved, forgotten or changed heads and to holds that make an input head unusable (scanner_pending, secret_detected, missing_parent, dependency_invalidated).
- G2: `scanner_pending` is a MemoryFailureCode and an allowed blocked-arm code meaning "replica-local scan not finished"; it clears on the first allowing scan, unlike secret_detected.
- CI (PR CI only): (a) two-head conflict with clean scanner and linked parents, received through normal pull, is claimed and auto-resolved while the item reports exposure held with reason conflicted; (b) the same conflict with one head in scanner_pending or missing_parent keeps the candidate unscheduled and starts generation once the hold clears; (c) a single-head approved revision read while its scan is stopped with a Deferred returns the body-free blocked arm with failureCode scanner_pending and becomes active after the scan allows it.

- Reflection r8 G3 (rev 9a): the no-automatic-release rule now applies only to secret_detected. Initial scanner_pending is released by the automatic first scan that the receive commit schedules and restart recovers; CI case (c) above also restarts between receive and scan and expects the item to become active without a rescan request.

## Audit r5 fixes (rev 10)

- R6: new constants MEMORY_DEFERRED_SWEEP_MAX_ITEMS = 256 and MEMORY_DEFERRED_SWEEP_MAX_BYTES = 8 MiB (defined here once; consumed by WP2 deferred drain and WP3 fairness CI). Backoff min(2^attempt * 5 s, 1 h) is a WP2 algorithm detail, not a wire contract.
- R7: no explicit rescan RPC/MCP method is added. secret_detected holds are released only by a policy-version rescan scheduled by MemoryWorker; the Shared names list gains no new method.

## WP1 P stale check (rev 11)

### Baseline and citation receipt

2026-10-14, juns-macbook-pro. `git fetch origin dev` exited 0; `git rev-parse origin/dev`
and `git ls-remote origin refs/heads/dev` both returned
`b5f9d53cbc29eddf7bad5518bb7d46c4f97173f5`. Authoring HEAD is
`fea6178b36d11e0a446323344a2db67fb76c5d03`, branch `goat/memory-wp1-contracts`.
WP0 D direction, Shared names and Enforcement inventory remain authoritative; 000 is unchanged.
This lane refreshes the existing audited design, not a new architect proposal or independent A.
Rev 11 still needs the owning cycle's reflection/A against these deltas before B.

Checked all **60 explicit source path:line occurrences** in rev 10 against old and new git
blobs, plus context-inherited goat-ci line fragments. Basename references resolve to the exact
file in the surrounding change map (textGeneration.ts means provider-core unless qualified;
package.json/tsconfig.json mean contracts unless qualified). Compared cited content and named
symbols, not merely whether a line exists. **One existing citation changes; 59 retain their
line anchors. No cited path or symbol was renamed, moved to another file, or deleted.**

| Cited owner / reason                                                         | rev 10 anchor at 1e2418faf | rev 11 anchor at b5f9d53cb | Disposition                                                                                                                                                                                             |
| ---------------------------------------------------------------------------- | -------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider capability event field, `packages/contracts/src/orchestrationV2.ts` | `880` (`capabilities`)     | `894` (`capabilities`)     | `/side` adds SideChatOf and sideChatOf earlier in the file. The capability schema itself remains at 366–383; keep its additive optional memory field and replay defaults. Field-chain citation updated. |

Stable citation families checked: overview/effect-services; contracts index/package/baseSchemas;
strict orchestratorMcp test decoder; git error; RPC groups/middleware and RpcAuthorization;
auth scopes/defaults/legacy/consent; environment advertisements/descriptors/grouping;
settings/defaults/patch/scope; client guards; model selection; provider-core turn/generation/
operations/factory; server TextGeneration; Muse alias/factory; SessionStore/McpSessionRegistry;
orchestration schema/test; all cited tsconfigs, manifests, vite lint/test config and goat-ci.
No old line number is asserted as a new insertion site merely because the file is unchanged.

### Structural deltas and independent-PR decision

**WP1 remains a self-contained additive contracts PR, conditional on the static and hosted
verification below.** No runtime feature readiness or compiler success is claimed here.

| Area / latest source evidence                                                                                                                                             | Before → after / ownership decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public contracts export: `packages/contracts/src/index.ts:1–9,34–35`; `packages/contracts/package.json:9–29`                                                              | Existing root + settings/relay/legacyT3Names/adoptLegacyEnv subpaths → add root memory export only. No memory subpath exists; use root imports. Keep memory → environment scope imports one-way; environment memory advertisement stays inline, auth memory grants use literals, and memory does not import orchestration/settings back.                                                                                                                                                                                                                                                                                    |
| MCP composition: `apps/server/src/mcp/McpHttpServer.ts:867–880,921–936,1019–1045`                                                                                         | Nominal toolkit registration plus newly composed thread-search/worktree-inventory services → WP1 adds no toolkit/service registration. WP4 registers a memory toolkit through the existing application composition, without dropping those services or creating a feature runtime.                                                                                                                                                                                                                                                                                                                                          |
| Tool access: `apps/server/src/mcp/McpToolAccess.ts:136–137,181–182,297–317,341–375`                                                                                       | reads/writesWithCapability/toLayer and new removesCheckouts → memory read/write declarations stay on their corresponding paths with live explicit scopes. removesCheckouts is checkout deletion policy, not memory-forget authorization. reads alone does not grant memory access. All registration remains WP4.                                                                                                                                                                                                                                                                                                            |
| Claude runner: `apps/server/src/textGeneration/ClaudeTextGeneration.ts:43–59,207–225`; core `textGenerationOperations.ts:35–49,68–76`                                     | Investigation uses tools/allowlist/denylist; absent investigate uses empty tools + strict MCP → WP1 introduces only optional signatures. WP2 memory requests omit investigate and separately prove isolation/no-tool behavior; never copy investigation allowlists into memory generation. These existing policies are present at the new SHA; not all were introduced after the old citation baseline.                                                                                                                                                                                                                     |
| Orchestration: `packages/contracts/src/orchestrationV2.ts:366–383,894`                                                                                                    | New side-chat contracts shift event field by 14 lines → memory capabilities remain optional, no orchestration protocol bump or turn/event memoryContext persistence. Preserve side-chat fields, runtimePolicy decoding default and all live thread contracts.                                                                                                                                                                                                                                                                                                                                                               |
| Client permissions: `packages/contracts/src/clientRpcPermissions.ts:15–79`                                                                                                | Existing map plus ssh/worktree compound branch → append the 9 guarded memory entries (upsert/forget/revert/import/settings get+update/binding get+update/readSource); import requires write+filesystem read, readSource requires memory read+orchestration read before generic return. Include readSource in guarded membership so typed raw-request exclusion tracks this protected method (`packages/client-runtime/src/rpc/client.ts:445–454`); runtime authorization resolves compound scopes at `client.ts:169,186–189`. Read queries/change stream remain server-authorized; no early RPC_REQUIRED_SCOPES activation. |
| Auth vocabulary: `packages/contracts/src/auth.ts:109–236,575–615`; `apps/server/src/cli/authScopes.ts:4–5`                                                                | Granular enum and derived AuthGrantScope → add read/write/sync, standard adds read/write, administrative inherits read/write but never sync. Legacy sets/parents stay frozen. CLI derives literals, so sync is explicitly requestable but never proves a server principal; WP3 hub verifies principal independently. MCP consent accepts only optional explicit read/write on both approve arms. Old issued grants are not upgraded.                                                                                                                                                                                        |
| Scope consumers: `apps/server/src/auth/SessionStore.ts:446,715`; `apps/server/src/auth/EnvironmentAuth.ts:1078,1184`; `apps/server/src/auth/PairingGrantStore.ts:441,476` | Stored schema + default arrays and issuance → future new default grants gain read/write by shared arrays; existing rows retain grants. No exhaustive scope switch or separate default list needs WP1 widening. OAuth grant propagation/reauthorize remains WP4; do not infer grants from client access or capability.                                                                                                                                                                                                                                                                                                       |
| Settings: `packages/contracts/src/settings.ts:323,1057–1087,1176,1571,1757–1773`; settings public subpath `package.json:14–17`                                            | Server-only default-disabled memoryHub + version; project/client settings unchanged. Reject both reserved keys before generic Struct stripping, including alongside valid settings. Dedicated administration owns whole replacement/version/credential transition in WP3; no generic persistence or live settings writes in WP1.                                                                                                                                                                                                                                                                                            |

The definitive NEW/MODIFY source map remains **24 TS paths plus one workflow**; the rev 3
memory.ts row is clarified as NEW within WP1. Added compile commands inspect existing consumers,
not extra source modifications. The before/after recipes, lifecycle event anchor, RPC guards,
settings rejection recipe and verification section above incorporate these dispositions.

### Complete keyof / operation consumer inventory

`git grep -n 'keyof ProviderTextGeneration' origin/dev -- packages apps` returns exactly core
operations and Muse. Following Operation/Request/Runner imports and all six existing operation
literals finds the following complete generation paths; Pi was omitted in the earlier narrative.
The broader interface-name search also covers driver factories/selectors and the unrelated legacy
text-generation capability predicate below. No new required provider implementation is added in WP1 and no six-provider release exemption
is inferred for WP2/WP4. Pi/Muse are additional compile consumers, not new WP1 delivery promises.

| Consumer / current anchor                                                                                                                                                    | Operation chain and WP1 disposition                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/provider-core/src/server/textGenerationOperations.ts:32–49,61–95,224–231`                                                                                          | Optional interface key → Operation alias → Request.operation → Runner/error/string decoder. Return object still has old methods; no exhaustive operation dispatch. Read-only in WP1.                                                                                                                                         |
| `apps/server/src/textGeneration/CodexTextGeneration.ts:171,222,402`                                                                                                          | Operation argument/Request → CLI runner → shared factory; string error field. No enum edit.                                                                                                                                                                                                                                  |
| `apps/server/src/textGeneration/ClaudeTextGeneration.ts:106,132,320`                                                                                                         | Operation/Request → CLI runner and existing title/channel conditionals → factory. No exhaustive closed enum; memory methods not invoked in WP1.                                                                                                                                                                              |
| `apps/server/src/textGeneration/AntigravityTextGeneration.ts:107,309–311`                                                                                                    | Request → ACP runner → withoutInvestigation/fromRunner. No enum edit.                                                                                                                                                                                                                                                        |
| `packages/provider-cursor/src/server/textGeneration.ts:64,87,201–203`                                                                                                        | Operation/Runner → SDK/error → factory. No enum edit; explicit package compile added.                                                                                                                                                                                                                                        |
| `packages/provider-grok/src/server/textGeneration.ts:33,132–134`                                                                                                             | Runner → ACP/error → factory. No enum edit; explicit package compile added.                                                                                                                                                                                                                                                  |
| `packages/provider-opencode/src/server/textGeneration.ts:13–24,162,325–327`                                                                                                  | Request.operation → shared context for all exported OpenCode errors uses a closed six-literal schema. Add both memory names atomically with core interface; each exported error's encode/decode keeps old names and rejects unknown names. This is the only closed operation enum.                                           |
| `packages/provider-opencode/src/server/v2/textGeneration.ts:42,188,204–206`                                                                                                  | Request/Runner → v2 request/error mapping → shared factory; no second operation enum. Same OpenCode package compile reaches v1/v2.                                                                                                                                                                                           |
| `packages/provider-pi/src/server/textGeneration.ts:30,122–124`                                                                                                               | Runner → Pi/error → shared factory. No enum edit; explicit package compile added.                                                                                                                                                                                                                                            |
| `packages/provider-muse/src/server/textGeneration.ts:73,299–354`                                                                                                             | Independent keyof alias → runMuseJson operation → TextGenerationError.operation (Schema.String); independent old-method factory remains valid with optional additions. No Muse enum exists to widen; read-only compile gate retained.                                                                                        |
| `packages/provider-core/src/server/driver.ts:44,106`; `packages/provider-opencode/src/server/driver.ts:147–180`; `packages/provider-acp-registry/src/server/driver.ts:73–88` | Other interface consumers: driver property, OpenCode runtime selector's old-method object, ACP unsupported factory. Optional methods preserve compilation. WP2 must explicitly wire the OpenCode selector as well as v1/v2 runners; ACP Registry gets no new runtime support promise. Its explicit package compile is added. |
| `packages/contracts/src/server.ts:343–344`; `packages/shared/src/serverSettings.ts:159,183`; `packages/provider-core/package.json:158–160`                                   | Capability predicate/default model selection and public operations subpath export, not keyof operation dispatch. Keep unchanged; memory eligibility must use independent memory flags/method availability in later phases, not supportsTextGeneration alone.                                                                 |
| `apps/server/src/textGeneration/TextGeneration.ts:29,63–95`; `packages/contracts/src/git.ts:402–412`                                                                         | ProviderTextGeneration service/factory and shared string error. No live dispatch/body addition or git contract change. Server compile checks its callers.                                                                                                                                                                    |

For both memory names: creation in WP1 is schema/test fixtures and optional method type only;
Operation/Request are in-process (serialization N/A in WP1), model input/result JSON uses the
strict memory codecs, and WP2 alone adds prompt construction/runner calls/execution stamping.
Closed OpenCode error serialization/deserialization must accept the two names now even though
no runtime call exists yet. MCP scope carrier is in-process too: WP1 optional fields → test
fixture/requireMcpCapability; WP4 registry/OAuth issuer → stored scopes decoder → live reauthorize
and memory service. Missing fields never create a grant. Snapshot turn input remains in-process,
not an orchestration event or appContext overload.

### Verification receipt and remaining obligations

Executed only git reads/fetch and Python text/blob comparisons (exit 0), including source-path
existence, citation mapping and file-map/lint/config consistency. All 24 mapped TS paths occur
in the scoped lint command; 4 NEW TS paths are intentionally absent on dev and 20 MODIFY TS
paths exist. All nine explicit package tsconfigs exist and include src. Latest dev and remote
SHA matched at receipt time. `git diff --check` is the final document whitespace check.

No installation, source edits, tests, full builds, typecheck, lint, server, user-data writes,
commit or push. CI-only test commands remain text for the implementation PR. The added
Cursor/Grok/Pi/ACP Registry targeted typechecks are NOT RUN, like the five existing package checks; no
successful compiler/linter collection or exact-head hosted CI result is inferred.

Remaining: owning-cycle reflection/A of rev 11; implement against the recorded latest dev
(not the WP0 branch's older source); repeat stale check if dev moves; run the nine targeted
package checks and actual-diff lint after implementation; execute the declared contract/core/
OpenCode/server CI cases on the final implementation SHA. Runner capacity or CI failures from
WP0 are historical, not refreshed infrastructure evidence. There is no identified structural
blocker to an independent WP1 PR; runtime enforcement/activation and M19/M20 guarantees remain
WP2–WP6 obligations.

## WP1 audit r1 fixes (rev 12)

All three accepted findings and architect G1 are folded into the owning sections:

1. Strict `MemoryModelSelection` replaces every memory model selection use; raw-settings server
   conversion fails typed before dispatch rather than losing requested options. Existing legacy
   storage codecs remain compatible. Schema/rejection/preservation fixtures belong to commit 1;
   nested lease/generation/checkpoint fixtures to commit 2; runtime conversion to WP2.
2. WP1 now owns exact `MemoryCompactReceipt`, `MemoryIdentityRecord`, `MemoryFenceRecord`,
   `MemorySuppressionRecord`, `MemoryCheckpointReportGuard` and `MemoryHubCheckpointPage`, with complete-snapshot identity,
   original receipt, suppression and fence checks and combined page count/byte limits. Commit 2
   owns these codecs/helpers/fixtures; WP2 owns SQL mapping and WP3 production/staged installation.
   The commit 1→2 split above moves shared dependencies before their first reference.
3. Corrected `McpToolAccess.ts:341–375`. WP2/WP3 handoffs reference WP1's wire definitions.

This is a document-only disposition, not an implementation or runtime pass. Audit r1's nine
existing-source typechecks and lint were reported green by that audit; they do not prove the
six future commits or new schemas. This lane runs text consistency and `git diff --check` only;
no source edit, installation, test, build, commit or push. Remaining: independent rev 12 review
and future implementation/fixture execution, especially lossless raw-settings conversion and
atomic checkpoint restore. No accepted finding is intentionally deferred as an undefined wire shape.

## WP1 audit r2 fix (rev 12a)

- The strict selection example no longer reuses trimming schemas. `MemoryCanonicalString` rejects leading/trailing whitespace instead of rewriting it, and instanceId, model, option id and string option value all use it; the ProviderInstanceId brand is applied on top so server code can pass the value to existing provider APIs after validation. The fixture names the padded-option and padded-id cases for decode, encode and `.make`. The exact Effect filter API is confirmed against the vendored Effect version during commit 1; the requirement is "reject, never trim".

- WP2 reflection r3 (rev 13a): `forget_pending` joins the input-unusable reasons, so a memory under a pending forget intent never reaches resolve or summary model input before the reserved forget is accepted.

- WP2 audit r3 (rev 13b): `forget_pending` is a MemoryFailureCode and an allowed blocked-arm code, so a clean single-head upsert received under a pending forget intent serializes as a body-free blocked item on read/list, both right after receive and after restart. These contract additions ship as WP2 commit L1-0 (see 020 lane plan), not as a WP1 PR follow-up.
