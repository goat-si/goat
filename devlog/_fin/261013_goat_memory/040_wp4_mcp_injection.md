# 040 — WP4: memory MCP and provider injection (independent audit r2 fix)

Date: 2026-10-15. Status: **READY_FOR_REAUDIT**, not implementation approval or runtime proof.
Independent audit r2 (NO-GO: R2-1 High, R2-2 High, R2-3 Medium) and coordinator decisions
are folded into this executable plan; r2 CLOSED A1/A2/A5/A6/CI and ordinary managed policy stay fixed.
Inputs: `/tmp/goat-wp4-audit-r2.md`, `/tmp/goat-wp4-audit-r1.md`,
`/tmp/goat-wp4-auditfix-r1.md`, `/tmp/goat-wp4-reflection-r1.md`, 000 and actual code at
`3e72b0a26f20446820483b1ceca95f1c7b2e46d2` (including the 030 correction).
This pass changes only 040 and the current WP4 cycle in 000. No source edits, other worktree
changes, tests/builds, push or PR. The explicit two-document commit request overrides the
AGENTS.md default against committing plans. Reflection r1 is predecessor evidence; no fresh
reflection or independent re-audit is claimed by this fix.

## 1. Baseline, outcome and stale check

- Re-anchor input HEAD: `b2a54d9ac5d81bdcba433f368cd32cd256c83d97`, branch
  `goat/memory-wp4-mcp-injection`, clean worktree `goat-wp4-plan`.
  This merges WP3 final `5f12fb1b8` onto WP4 plan `cfa07255f`; WP3 is present.
  #183 green is supplied predecessor evidence, not a fresh CI check in this pass.
- Authority: 000 WP3 B integration 1–3, 030 current §8 and decision rows rev 11f/11g,
  and the actual merged source. Previous WP4 A near-pass remains historical; this re-anchor
  requires independent A on this reflected revision before B. No remote ref movement or push is authorized.
- Scope: only 040 body and the WP4 cycle in 000; 030/050/060 are read-only.
  The explicit plan commit request overrides the general no-plan-commit default.
- Bounded fix; trigger: independent audit r2 NO-GO; goal: executable MCP/injection/source
  plan incorporating the coordinator decisions; non-goals: implementation, tests/builds, push/PR.
  Verifier: source comparison and two-file diff check (not runtime proof). Stop: local commit and
  `/tmp/goat-wp4-auditfix-r2.md`. Outcome: READY_FOR_REAUDIT; unresolved source/contract drift
  escalates to coordinator. Independent re-audit precedes B.
- **Confirmed by Jun, 2026-10-14:** original relay authorization is A-lite; memory WP1–WP6 ship
  together. L6 original relay is mandatory for this WP4 completion; no pending model choice or
  relay-off branch. Base evidence can be reviewed separately but cannot close WP4/full c-5.

Outcome: six providers consume the same environment-owned service, a bounded snapshot at real
prompt start and explicitly granted MCP tools. Nine core memory tools remain; a separate
settings administration toolkit adds the narrow hub-disable tool (§6). Originals are requested
from the owner, through the transient hub relay; they never enter canonical memory or injection.
Forget/revoke fences new selection, pending reads and restoration; already delivered bytes
cannot be recalled and offline replicas learn deletion through WP3.

`S/` = `apps/server/src/`, `C/` = `packages/contracts/src/`. The table covers the prior 040
port/signature/location/ownership/test assumptions; OK means current seam, MISSING means WP4
work absent, STALE means the preceding plan's claim is incompatible with the merged code.

| ID  | Prior assumption                                         | State   | Current evidence and disposition                                                                                                                                                                                                                                      |
| --- | -------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R01 | WP3 absent / rev 11c frozen proposal                     | STALE   | WP3 is merged at the input HEAD; 030 decision rows rev 11f/11g govern, not old base/ref wording.                                                                                                                                                                      |
| R02 | Mutations and StoredReceipt                              | OK      | S/memory/MemoryService.ts:162–176; same service methods; transport maps local receipt, never hub ACK.                                                                                                                                                                 |
| R03 | List/search/read/history service ports                   | OK      | S/memory/MemoryService.ts:177–192; keep live Permit and typed service failures.                                                                                                                                                                                       |
| R04 | Candidates retain list continuation already              | MISSING | S/memory/MemoryService.ts:1100–1123 drops nextCursor; C/memory.ts:1179–1183 lacks it. L1 adds it before consumers.                                                                                                                                                    |
| R05 | Exact revision read and snapshot renderer                | MISSING | S/memory/MemoryService.ts:1124–1165 provides exact-ID reads, but no nextCursor; C/memory.ts:1172 still requires raw text substring. L1 fixes producer/schema and adds renderer/snapshot.                                                                              |
| R06 | No prepare/validate source ports                         | STALE   | S/memory/MemoryService.ts:55–88,1200–1260 implements both. Public readSource remains absent; activation is WP4.                                                                                                                                                       |
| R07 | WP3 supplies activated owner policy/reader               | STALE   | S/memory/MemorySyncRuntimeLive.ts:168–171 denies both. S/memory/MemorySyncService.ts:1350–1375 converts access failure to terminal denied. WP4 L6 owns policy and reader, with A-lite outbound policy revocation (§3.2).                                              |
| R08 | Source request proves caller rights                      | STALE   | C/memory.ts:2247–2269 has scope snapshot and requester environment only; S/memory/MemoryService.ts:1211–1219 creates literal scopes. S/memory/MemoryStore.ts:7306–7345 stamps member environment/deadline, not caller identity.                                       |
| R09 | Sync wrappers are future / all return ServiceError       | STALE   | S/memory/MemorySyncService.ts:87–115 exports wrappers now; Error = Hub.MemoryHubServiceError (:28); update uses AdministrationError or AccessError (:111–112). No guessed casts.                                                                                      |
| R10 | start/syncOnce/schedule are function calls               | STALE   | S/memory/MemorySyncService.ts:90–93 exports Effect values; shutdown is Effect<void>. readLocalReadiness/requireBootstrap are functions (:94–98).                                                                                                                      |
| R11 | Unbound status requires a space                          | STALE   | S/memory/MemorySyncService.ts:1838–1844,1878–1915 returns unbound readiness and null-space storage/status; disabled is not an empty/fabricated success.                                                                                                               |
| R12 | Settings cache is safe within SQL                        | STALE   | S/serverSettings.ts:275–279,1617 provides committed Ref; S/server.ts:515–529 consumes it. Sync wrappers read full settings outside Tx (:197–200,1861–1896), which must not be called inside handler Tx.                                                               |
| R13 | No hub disable path exists                               | STALE   | C/memory.ts:1452–1460 configure + settings.mode=disabled; S/memory/MemoryHubService.ts:382–398 administrator.update exists. Transport/client exposure remains MISSING; no new disable action enum.                                                                    |
| R14 | Composition anchors at server.ts:588–605                 | STALE   | S/server.ts:481–500 service/worker,504–529 hub,619–634 sync/runtime; reuse those layers.                                                                                                                                                                              |
| R15 | Core RPC schemas/guard entries mean routes active        | MISSING | C/rpc.ts:2296–2396 declares schemas; C/clientRpcPermissions.ts:19–28,83–86 guards writes/settings/source, not all reads/status. WP4 activates routes and completes read/status guard tests.                                                                           |
| R16 | MCP uses McpHttpServer/toolkits registration             | OK      | S/mcp/McpHttpServer.ts:868–881 toolkitRegistration remains the owner; memory toolkit absent. Current nine-tool catalog is C/memory.ts:2332–2343.                                                                                                                      |
| R17 | Provider memoryContext and cloud fields coexist          | OK      | packages/provider-core/src/server/ProviderAdapter.ts:419–422; observation-only resume stays distinct. Actual injection/renderer absent, so lifecycle recipes are proposed, not support claims.                                                                        |
| R18 | Bounded output alone bounds index work                   | STALE   | S/memory/MemoryService.ts:840–847 scope-wide COUNT is shared by list/search. Remove list aggregation and supply bounded/counter-backed search coverage; Store substring COUNT/SUM and instr query also need correction (S/memory/MemoryStore.ts:3056–3085); §4/§6/§8. |
| R19 | Source scenario belongs to completed WP3 tests           | STALE   | S/memory/MemoryHubSyncScenarios.test.ts:825–857 proves terminal denial and unrelated progress, not successful original relay. WP4 extends this actual test file with scenario g.                                                                                      |
| R20 | Tests are PR-CI-only and formatter from another worktree | STALE   | This pass runs no tests; tests run in PR CI and macmini-cf focused lanes; light targeted typecheck/lint are allowed locally. Local node_modules absent: skip vp fmt, do not access another worktree.                                                                  |

## 2. Implemented ports and WP4 consumption

`M` = `@goat/contracts`; `Permit` = repeatable SQL-free
`Effect.Effect<void, MemoryService.MemoryAccessError>`. Mutations, binding, changes,
list/search/read/history and context reads retain their public MemoryService signatures.
Exception: L1 changes the internal Store.search array return to a search-page result (§6.2);
MemoryService consumes examined-row continuation instead of deriving it from matching items.
ServiceError = MemoryAccessError | MemoryStorageError | MemoryStoreConflict | MemoryCapacityError.
StoredReceipt is the local store result; preserve forget base/expansion IDs and receipts.

| Owner / existing seam                           | Actual signature / responsibility                                                                                                                                       | WP4 consumption                                                                                                                          |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| MemorySyncService                               | start, syncOnce, scheduleConflictResolution: Effect<void, Hub.MemoryHubServiceError>; shutdown: Effect<void>                                                            | Reuse startup/shutdown; never invoke an Effect as a function or create another worker.                                                   |
| MemorySyncService                               | readLocalReadiness(): Effect<{memorySpaceId: MemorySpaceId                                                                                                              | null; bootstrap: unbound                                                                                                                 | staging                                                                                                                         | ready}, Hub.MemoryHubServiceError>; requireBootstrap(space): Effect<void, Hub.MemoryHubServiceError> | Local snapshot readiness; no network requirement when bootstrapped. |
| MemorySyncService                               | getHubSettings(input, permit): Effect<MemoryHubSettingsView, Hub.MemoryHubServiceError>; syncStatus(input, permit): Effect<MemorySyncStatus, Hub.MemoryHubServiceError> | Thin settings/status RPC; preserve null-space storage, processing, holds and 1/7/30-day growth. Map declared errors to safe wire errors. |
| MemorySyncService                               | updateHubSettings(input, permit): Effect<MemoryHubSettingsUpdateResult, Hub.MemoryHubAdministrationError                                                                | MemoryAccessError>                                                                                                                       | settings:write; administrator performs versioned CAS and configure/disable. Never duplicate its file/SQL workflow in transport. |
| MemorySyncService                               | readSource: MemorySourceReadAuthority["readSource"]                                                                                                                     | Existing relay authority, not public MemoryService.readSource. §3 supplies requester evidence and live owner policy.                     |
| MemoryHubCommittedSettings                      | read: Effect<MemoryHubSettingsView>, backed by Ref                                                                                                                      | SQL-free committed hub projection/epoch for reauthorization, snapshot binding and owner policy. No reload/cache lock inside SQL.         |
| MemoryHubAdminSettings / MemoryHubAdministrator | withLock/read/apply / update(input, AdminPermit)                                                                                                                        | Existing administration owner; call outside transport SQL, use committed view for nested SQL authority.                                  |
| MemoryService                                   | prepareSourceRead(input, permit) → ValidatedSourceRequest; validateSourceOutcome({request,outcome}, permit) → outcome                                                   | Preserve generation/locator/watermark/scanner checks; add public readSource composition without activating a permissive default.         |
| Server composition                              | server.ts:481–634 provides service, hub, runtime and started sync once                                                                                                  | Add access/snapshot/owner reader into the same memoized graph; source dependencies via service ports, no cyclic service acquisition.     |

The frozen wire/context fields and actual provider turn field remain prerequisites. Candidate
nextCursor and escaped-render invariant are still WP4 contract changes, not existing behavior.
Search coverage/status remain truthfully incomplete when indexing is deferred; approved receive
and canonical receipt/cursor progress never depend on exposure or transport caches.

## 3. Source activation: consume WP3, do not rebuild it

Implemented non-wire signatures (`S/memory/MemoryService.ts:55–88`; server-produced request):

```ts
type ValidatedSourceRequest = {
  request: M.MemoryHubSourceReadRequestInput;
  generation: number;
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
// WP3 MemoryService ports:
prepareSourceRead: (input: M.MemoryReadSourceInput, permit: Permit) =>
  Effect.Effect<ValidatedSourceRequest, ServiceError>;
validateSourceOutcome: (
  input: { request: ValidatedSourceRequest; outcome: M.MemorySourceReadOutcome },
  permit: Permit,
) => Effect.Effect<M.MemorySourceReadOutcome, ServiceError>;
// WP4 public MemoryService method:
readSource: (input: M.MemoryReadSourceInput, permit: Permit) =>
  Effect.Effect<M.MemorySourcePage, ServiceError>;
```

MemoryService.readSource executes prepareSourceRead → authority.readSource → validateSourceOutcome.
It maps typed HubError into the existing safe service error channel at the authority boundary.
Available returns the validated page; denied remains authorization denial. An unavailable outcome
preserves forgotten/source_invalidated/secret_detected when present; offline/expiry/missing owner
maps source_unavailable. Do not turn every outcome into source_unavailable or empty success.
Actual outcome arms are `C/memory.ts:2286–2305`; public readSource returns a page or typed error,
not the relay union. Transport error mapping preserves safe code/capacity/deadline fields and
never exposes raw cause, SQL, path, model output or source body in an error.

WP4 supplies live memory:read **and** orchestration:read before submission and after await.
The prior 040 source assumptions (old lines 96/103/133) are superseded here: 030 §8's required
same-owner authorization/policy is deferred by rev 11g, not implemented authority. Production stays
fail-closed until the following chain and scenario g pass. WP3 already owns bounded relay,
terminal denial, generation validation and retry/TTL; WP4 adds the committed original reader
and delegates authorization through application-owned ports, not the Worker summary reader.

### 3.1 Original relay: confirmed A-lite (D1–D2)

All participating devices belong to the same user (000 M3; no team sharing).
`authorizedScopes` is a literal snapshot, not caller proof (C/memory.ts:2247–2269;
S/memory/MemoryService.ts:1211–1219). Public MemoryReadSourceInput remains unchanged:
no arbitrary host/path/thread, caller-supplied grant or attestation.

**D1:** Jun confirmed A-lite on 2026-10-14. Owner trusts explicitly listed requester environments
of the same user to enforce live memory:read AND explicit orchestration:read locally. Owner cannot
independently verify an unauthorized caller inside a compromised allowed requester. Membership,
hostname or a shared memory space never enrolls an environment. Default-empty owner allowlist
denies; settings:write installs/removes exact environment IDs with expectedVersion CAS.
No reverse requester introspection, subject-binding registry or live decision-reference contract.

**D2 / executable chain:** L1 owns strict internal stamp/policy/revoke contracts. L6 owns the
reader and relay policy flow; L5 owns settings commit/publication and composition. Source policy
read/update RPCs form a settings:write guarded administration group, separate from 14 core RPCs.
Persist allowedRequesterEnvironmentIds, monotonic owner policy epoch and body-free pending
revocation/ack metadata in owner settings; publish immutable committed Ref after settings commit.
No sync join installs a policy. WP6 owns visible allowlist controls and propagation state.

Requester checks authenticated live compound grants before prepare/submission and after await;
provider calls also require live owning run. A server-owned caller-bound request ID prevents two
callers sharing results. Hub authenticates member, stamps requester environment/credential version,
exact locator digest and immutable <=75s deadline. Retry preserves digest/deadline. Carry fields
through C/memory.ts → HubClient/HubHttp/HubService → Store codecs → Sync owner permit/requester
validator; legacy unstamped rows terminate denied/expired. Old scope literals are never proof.

Owner accepts only its authenticated pinned hub channel and checks allowlist, active member stamp,
digest/deadline, locally owned existing nondeleted thread, nonforgotten memory, generation/watermark
and selected completed committed messages at/below that watermark. Scan/bound before response;
recheck policy/epoch and source state before read and response. Local owner=hub uses the same
checks without HTTP or Effect.void fallback. Caller revoke is requester-local; member revoke is
hub-authoritative; neither substitutes for owner-policy propagation below.

### 3.2 Owner revocation reaches pending results (D3; audit A3)

Use the existing outbound `source-read/respond` path: extend its strict internal input to a tagged
union preserving normal response and adding body-free `revoke` with memorySpaceId,
requesterEnvironmentId and ownerPolicyEpoch. Owner identity comes only from authenticated member;
no requestId/body/subject introspection is needed for revoke. HubClient/Http/Service and Sync use
the same port; collect/result continue their existing jobs. No twelfth endpoint is planned.

After owner settings commit and committed Ref publication (outside SQL Tx), L5 signals L6 Sync
to send revoke. Persist a body-free pending entry in the same settings commit so restart/network
failure retries it; key is (space, owner, requester, epoch). Hub's one transaction authenticates
owner, advances the durable pair's revoked-through epoch monotonically, deletes the pair's
existing pending and completed-but-unfetched payloads for that pair, and finalizes all those
requests as terminal typed denied. **Re-registration barrier:** the same owner/requester pair
cannot activate a new enrollment until the matching removal hub ack is persisted on the owner.
Re-registration attempts remain pending (not an effective allowlist entry); L5 commits matching
ack first, then activates a strictly newer owner epoch and publishes its committed Ref. L6 sends
revoke/retries outside SQL/settings locks. Owner/hub restart preserves both barrier and fence.
A duplicate/older revoke cannot touch responses from that later activated epoch. Denied settlement is body-free
relay state/codec metadata; result returns denied even with no payload row, and a late response
cannot change that terminal decision to available.
Hub checks its durable pair fence before purge: a duplicate/older removal returns an idempotent
matching ack without re-sweeping newer-epoch requests. Only a newly advancing revoke closes all
existing pair requests behind the still-closed re-registration barrier.
A bounded per-member pair epoch map is relay authority metadata, never a content archive.
Retain its monotonic fence across restart and until old request deadlines have passed before
pruning a retired member. L1 defines bounds/codecs; L6 returns relay metadata schema/migration
patches to L1 for ordered Store migration/registration, without concurrent file ownership.
Only committed hub ack settles the matching pending epoch; an older ack cannot settle a newer
removal. Expose `revocationPropagation: pending|acknowledged` and pending target/epoch in the
settings view, plus pending re-registration state for WP6. L1 extends the existing respond result
`accepted` Boolean with strict normal/revoke result codecs: a revoke ack identifies matching
space/owner/requester/removal epoch and the durable pair fence committed by that Tx. Owner checks
all identities, exact pending removal epoch and fence coverage before persisting ack. Missing,
mismatched or stale ack cannot settle removal or open the barrier; duplicate matching ack is
idempotent. L1 defines persisted pending/acknowledged removal and pending/active enrollment state
codecs; L5 owns settings persistence/apply, L6 hub fence/result and transport, all v1 in-place.
Until hub ack the status is **철회 전파 중**, not completed revocation.
The local Ref blocks new owner reads immediately; remote pending results can still race before ack.

Normal available responses carry the captured ownerPolicyEpoch, stamped by the authenticated hub
on acceptance. Accept and result both compare it with the pair's revoked-through epoch in SQL:
an epoch at/below the revocation fence is denied, its payload erased. Later re-enrollment increments
policy epoch only after the barrier; old requestId retransmission and old response cannot acquire
the new epoch or revive terminal denied requests, and old revoke cannot revoke newer responses.
Duplicate revoke returns the same effective ack without regressing epoch. Result and revoke
serialize on the existing Store transaction lane. **Release linearization is the hub result Tx**:
revoke ack guarantees revoked-enrollment result admission after revoke Tx is denied and payloads still waiting in
the hub are deleted/terminal denied. A result whose Tx completed before revoke Tx has already
left the hub: it is a pre-revocation released in-flight result even if HTTP/requester exposure
is still pending. It may be delivered after ack; no recall or owner-removal requester cancellation
port is promised or added. Treat it like already-read data within the immutable <=75s deadline;
existing requester-local caller/locator/deadline checks remain independent. Ack/settings/network waits are outside SQL; only
SQL-free committed permits may be rechecked after lock ownership. L6 owns relay Store/Sync edits
only after sequential handoff from L1/L5; L1 owns contracts, L5 settings schema/view and publication.

### 3.3 Bounded SQL relay and outcomes (D4; audit A2 disposition)

030 §8/M16 was decided and reviewed in WP0: **no shared or accumulating original archive;
the existing M16 maximum 75-second purgeable SQL relay buffer remains allowed**. Interview
“share summary + original location; read original on its device when needed” prohibits an original
archive, not all hub disk contact. A2 is therefore not accepted as a blocker. Its SQL INSERT
observation (MemoryStore.ts:7461–7470) is correct; the demanded nonpersistent body was coordinator
wording overreach, not the approved requirement. Keep existing SQL buffer, not a second RAM store.

Guarantees: immutable <=75s first hub deadline; consume deletes payload in the result transaction;
expiry purge on admission/maintenance and before result; forget/revoke also purge. At most 32
live reads/requester, 128/hub, <=64 KiB encoded outcome, <=32/64 KiB collect; live body bound is
at most 128 × 64 KiB (8 MiB), additionally charged to existing hub quota. Retry/restart never
extends expiry. Choose the smaller existing behavior: an unconsumed body may survive hub restart
until its original deadline; expired bodies cannot be served and are purged before service.
This is bounded logical retention, not physical disk/WAL secure erasure or zero persistence.
No body in canonical memory, FTS, checkpoint, log, event, report, provider snapshot or durable
client cache. No payload in safe errors. Immediate freed-page reuse/physical-remanence hardening
is **Low follow-up only**, outside this completion gate.

Denied remains auth denial; offline/timeout is source_unavailable; forgotten/source_invalidated/
secret_detected remain distinct. Relay failures cannot stall unrelated sync/forget.

## 4. Snapshot selection, framing and invalidation

NEW `S/memory/MemorySnapshot.ts` is a normal Effect Context.Service with private make/layer,
namespace imports and typed errors. Proposed non-wire methods are
`forThread(threadId: M.ThreadId): E<M.MemoryContextSnapshot|undefined, ServiceError>` and
`revalidate(snapshot: M.MemoryContextSnapshot, execution: { threadId: M.ThreadId; runId: M.RunId }): E<M.MemoryContextSnapshot|undefined, ServiceError>`.
The execution argument is server-captured current execution identity, never snapshot provenance
or caller-supplied wire authority. L1/L3 retain the original selection owner and space/project
binding association in server-owned snapshot/adapter state, outside the unchanged wire snapshot.
Revalidation compares that association with the current active run, owning thread, live read
policy and current space/project binding. Reuse by another thread/run, changed binding, ended
run or lost permission clears the memory entry. No new permission system or wire DTO is added.
It depends on existing MemoryService, Store, WP3 SyncService, server identity and committed thread/
project readers. No SQL or provider/network call in handlers or the pure Orchestrator.

For each real start, use short individual `MemoryStore.transact` reads
(`MemoryStore.ts:426–429`) for readiness/binding and each candidate page, reusing the same SQL
service/journal. Never hold the common transaction lane across multiple pages, rendering or
provider preparation. No network inside a read transaction. Build a repeatable trusted internal
read permit from the §6.1 committed provider policy intersected with owning thread/run policy; this is not an MCP-token requirement and not an
externally selectable bypass flag. Capture the initial space, binding and projection watermark;
each page must match that view, and recheck readiness/binding/watermark at selection completion
and the actual delivery boundary. On drift, discard the selection rather than combine views or
restart an unbounded scan. Real-store fixtures must prove this fence under concurrent mutations.

Select only user scope of the ready space, current explicit/repository project key via
resolveProjectKey, and full current ScopedThreadRef. Missing project mapping excludes only project
memory; no cwd/foreign local-ID inference. Order current-thread, project, user, then memory ID.
Use MemoryListInput with explicit scope, limit <=100 and cursor. L1 changes the existing
`C/memory.ts:1179–1183` contracts type to retain its existing fields plus
`nextCursor: M.MemoryPage["nextCursor"]`; `readContextCandidates` keeps its input/error signature
and copies `MemoryService.list`'s actual nextCursor before filtering candidates. Continuation is
based on the last unfiltered store row (`MemoryService.ts:834–837,854`), including a page whose
eligible items are empty. Never infer cursor or exhaustion from filtered candidate IDs/counts.
`readContextRevisions` shares this result type and returns nextCursor null: it is a bounded exact-ID
read, not pagination. L1 owns both producers and contract tests before consumers compile.

One snapshot selection has explicit aggregate scan ceilings across all three scopes:
**10 pages, 1,000 examined row slots and 640 KiB encoded-page budget**. Conservatively charge
100 row slots and 64 KiB before each page read, including all-excluded or all-oversize pages;
unused page allowance is not reclaimed. These charges bound work without adding scan metadata
or deriving it from eligible item counts. The actual encoded MemoryPage, before candidate
filtering, must obey the existing 64-KiB limit; a required single oversize item follows the
existing payload_too_large policy. Stop at the first scan ceiling, output budget or exhausted
scope; on a scan ceiling return the deterministic partial selection already packed, without
background continuation. Whole eligible items too large for the output are skipped within
these fixed scan ceilings. Output size and scan work are separate invariants/tests.
The scan ceilings only bound work if a page read is itself bounded: L1 removes the scope-wide
eligible/indexed coverage count from list and candidate pages (search reports coverage from transaction-maintained scoped counters, not a scope-wide COUNT), so each page read costs its returned rows plus the watermark.

Include active visible single-head entries only. Tombstone, forget_pending, conflict, scanner,
parent/dependency or grant holds fence exposure. FTS-pending eligible entries may inject: index
coverage is not read eligibility. Empty/unready/error returns no memory, with bounded diagnostics.

NEW `packages/provider-core/src/server/memoryContext.ts` exports pure packing, validation and
text helpers plus a static data-boundary reminder. Preserve the WP1 snapshot fields exactly:
protocolVersion, memorySpaceId, projectionWatermark, items (memoryId/revisionId/scope/provenance/
assertionKind/text), renderedText. Safe public provenance only, no absolute import paths.
Render a fixed data frame with escaped text/locators; count the complete native outer
`<external_goat_memory>` frame, reminder, separators and escaping. Maximum is **6,000 Unicode
code points AND 24 KiB UTF-8**, using `C/memory.ts:90–92`, not UTF-16 string length. Drop whole
items that do not fit; never truncate a fact or load full transcripts/history for injection.

Required WP4 contract correction: `C/memory.ts:1172` checks raw item text occurs in renderedText.
That fails valid escaping of `&`, `<`, `>` and cannot prove correct framing. Remove that raw
substring predicate while retaining uniqueness, typed items and both final-size checks. The
provider-core validator must recompute the deterministic escaped rendering and compare equality;
all six adapter admission paths call it. Keep original item text unchanged. Do not import a
renderer into contracts or weaken excess-property validation. Tests must accept escaped special
characters and reject altered renderedText at actual adapter delivery. This is a proposed WP4
contract change for reflection, not a claim the existing schema accepts escaped output today.

Immediately before Codex restoration is delivered, call `revalidate(snapshot, { threadId, runId })`
with the server-captured current execution. Restoration uses
readContextRevisions(space, selected IDs, permit), compares **exact** original
revision/scope and current eligibility, and repacks survivors only; never add replacements or
new items. IDs are capped at 100; the packer also bounds selected count. Revalidation error or
missing ID may clear the whole memory delivery. Clear snapshot/native cache on detach/stop/thread
replacement, permission change, forget/hold/dependency signal and TTL. Derived caches are current
views under `MEMORY_DERIVED_CACHE_MAX_BYTES` (32 MiB aggregate) and TTL (10 minutes), not archives.
Source has its stricter existing 75-second bound. Cache eviction never rejects approved ingestion.
Codex is a server-owned adapter: acquire MemorySnapshot from its existing Effect layer for
restore revalidation, and provide the same layer instance through runtimeLayer. Do not import
a server service into provider-core or the reusable provider packages. Validate/reselect at the
actual delivery boundary after asynchronous preparation/retry; a previously prepared snapshot
is not authority to resend forgotten bytes. Proposed non-wire turn-input addition, owned by L3:
`refreshMemoryContext?: () => Effect.Effect<MemoryContextSnapshot | undefined, ProviderAdapterTurnStartError>`.
L5 creates this closure from the current thread/run and MemorySnapshot.forThread, maps typed read
failure to an omitted snapshot with safe diagnostics, and puts it only on the in-process turn
input. Each ordinary adapter send calls it after preparation, then validates the returned frame;
fallback/retry sends call it again. Omission clears memory. No function/grant enters wire codecs,
provider payloads, saved commands or events; serialization/deserialization is N/A for this callback.
Only the returned validated text crosses native serialization, through every §5 delivery seam.
Observation-only resume never invokes it to create a prompt. Codex restoration still calls
revalidate with the originally selected snapshot and current server-captured threadId/runId, not refresh, so restoration cannot grow context.
This closes creation → in-process propagation → native serialization → all consumer chains
without importing a server service into a reusable package.

## 5. Provider decisions and lifecycle

These are WP4 implementation decisions, **not current support claims**. MCP availability is
advertised only when the installed memory service and explicit credential grants are present.
Snapshot-only paths must not claim tools. Stored bodies are untrusted data, never developer policy.

| Provider              | Actual delivery seam / evidence at HEAD                                                                                                                                                                                     | WP4 decision, resume and compaction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex                 | `S/orchestration-v2/Adapters/CodexAdapterV2.ts:710–782` builds untrusted additionalContext; :6376–6390 stores it; :1743–1785 restores it; :6746 explicit compact.                                                           | Add reserved goat_memory untrusted entry independently of MCP app entries. Every ordinary/resumed prompt replaces it. Explicit compact installs fresh snapshot/generation before native command. Restoration revalidates current execution ownership/read policy/space and project binding immediately before delivery, rereads exact selected revisions and sends bounded surviving data as user external context, never developer text. Late compaction after binding change or run termination clears goat_memory; a foreign-thread snapshot cannot restore. Dedup by native thread + compaction item + generation; mark success after inject succeeds. Preserve forked notification handling and existing restore timeout. Error clears memory and logs category, without failing an already-running turn. |
| Claude                | `S/orchestration-v2/Adapters/ClaudeAdapterV2.ts:1049–1054` system append; :1071–1094 read-only tools; :8250–8275 persistent query; :8532–8540 and :8788–8791 actual message builders; :8966 compact.                        | Static reminder/tool availability only in system. Put fresh framed snapshot in each real user-message builder, including fallback/retry/resume; preserve attachments, UUID, echo and effort handling. Do not restart query or change queryPolicyKey for memory. Native compact/wake continuation makes no synthetic user turn; next ordinary prompt refreshes. Allow six read tools with full mcp__goat__ prefix, never three writes, on read-only policy.                                                                                                                                                                                                                                                                                                                                                     |
| Cursor                | `packages/provider-cursor/src/server/adapter.ts:2111–2185` resolveUserMessage; :2116 native /compress; :2206 SDK submit; :2443 compact.                                                                                     | Fresh framed text in ordinary text/image message after validating original input; retain runtime/attachment/skill handling. Resumed agents refresh. Preserve exact native /compress early return, then refresh next real prompt. No provider memory/config file writes. MCP attachment independent of snapshot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Grok                  | `packages/provider-grok/src/server/adapter.ts:336` uses shared ACP; `packages/provider-acp/src/server/adapter.ts:6784–6855` prompt parts; :6978 invocation.                                                                 | One separate memory text block on every ordinary ACP prompt; do not place it in first-run/state-change instruction cache. Preserve HTTP/stdio MCP bridge. Resume refreshes; native control/wake paths do not receive synthetic prompts. Test Grok flavor explicitly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Antigravity           | `S/orchestration-v2/Adapters/AntigravityAdapterV2.ts:238` uses same ACP factory.                                                                                                                                            | Same ordinary-turn snapshot rule, separate flavor fixture for profile and MCP restrictions. Actual denied/unavailable MCP is reported truthfully; data injection remains independent. No invented native compact support.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| OpenCode              | v1 `packages/provider-opencode/src/server/adapter.ts:972` external disables MCP; :3281 prompt system. v2 `packages/provider-opencode/src/server/v2/adapter.ts:3374–3433` prepareTurn/instructions; :4031 before submission. | v1 adds independent framed system-list data plus static trust reminder. v2 owns a separate goat_memory instruction key and last-successful value; put fresh value before each ordinary prompt, including resume, and send empty string to clear. Update cache only after successful put; failure prevents this prompt, not sync/pull. Native compaction stays native; next real prompt prepares again. External connections can be snapshot-only; no automatic GOAT credential forwarding.                                                                                                                                                                                                                                                                                                                     |
| oh-my-openagent (omo) | No dedicated adapter or integration symbol found in GOAT provider implementation search.                                                                                                                                    | Conditional compatibility through the chosen OpenCode runtime only. No first-class support claim: plugin behavior/instruction preservation and child-agent MCP inheritance are not proven. Reuse OpenCode delivery if compatible; validate with an optional off-host fixture later. A plugin dropping instructions/tools is explicitly unsupported by WP4; do not add a seventh adapter or provider-specific memory store.                                                                                                                                                                                                                                                                                                                                                                                     |

Common insertion point is now `S/orchestration-v2/RunExecutionService.ts:1516–1525,1547–1667`,
not the old :1406 path. Add snapshot to the in-process turn input while retaining appContext,
pending reports, cloudLaunchSource and cloudSource. Ordinary starts use :1700; explicit compact
uses :1690. #171 reattach at :1668–1686 removes message/launch checkout and calls resumeTurn to
**observe** an existing cloud task. Do not launch, resend saved user text, or create a memory
prompt during observation-only attach. An optional memoryContext field is not proof the remote
harness consumes it; a provider lacking an actual cloud prompt seam is observation-only here.
A later real follow-up start refreshes via the normal adapter path. Remote cloud tool access
requires an authenticated reachable MCP route; never bake a localhost origin into a bundle.

Immediate means every new local selection/restore and still-pending output is fenced by committed
deletes. Previously delivered context can remain inside the provider. No timer-based compaction
restore, context growth, model reranking or synthetic wake turn merely to refresh memory.

## 6. MCP, RPC, authorization and clients

`S/mcp/OrchestratorMcpService.ts:1073–1181` owns orchestration caller policy; it is not the memory
store. Registration is `S/mcp/McpHttpServer.ts:868,1019–1036` via toolkitRegistration and merged
layers, not a guessed McpServer.ts. Add `toolkits/memory/tools.ts` and `handlers.ts`, using
Tool.make requirements, McpInvocationContext, domain services and McpToolAccess.toLayer.
A handler decodes, calls ONE service method and maps typed errors. No SQL, relay workflow or
provider start in a handler. `McpToolAccess.reads` is not authorization (`:136–138`);
`writesWithCapability` retains read-only ceiling/live-caller checks plus explicit memory grants.

| MCP name (exact WP1 catalog) | Service method                 | Required live grants                                | Declaration / annotation                          |
| ---------------------------- | ------------------------------ | --------------------------------------------------- | ------------------------------------------------- |
| memory_search                | MemoryService.search           | memory:read                                         | reads; readonly                                   |
| memory_list                  | MemoryService.list             | memory:read                                         | reads; readonly                                   |
| memory_read                  | MemoryService.read             | memory:read                                         | reads; readonly                                   |
| memory_history               | MemoryService.history          | memory:read                                         | reads; readonly                                   |
| memory_sync_status           | MemorySyncService.syncStatus   | memory:read                                         | reads; readonly                                   |
| memory_upsert                | MemoryService.upsert           | memory:write                                        | writesWithCapability; mutating                    |
| memory_forget                | MemoryService.forget           | memory:write                                        | writesWithCapability; destructive                 |
| memory_revert_resolution     | MemoryService.revertResolution | memory:write                                        | writesWithCapability; destructive                 |
| memory_read_source           | MemoryService.readSource       | memory:read + orchestration:read + WP4 owner policy | reads; readonly, no SSH host-reaching declaration |

MCP inputs/results use WP1 schemas/catalog (`C/memory.ts:2332–2343`). Pagination defaults to 20,
max 100 with 64-KiB encoded pages; whole items/cursors only. Oversize required single content
returns payload_too_large, not a partial fact. No arbitrary-path import tool, raw resolve/receive port or authority flag. WP5 owns import activation.

A separate administration toolkit exposes `memory_hub_disable` only, with settings:write and
mutating/destructive annotations. Input is requestId + expectedVersion; NEW MemorySyncService.disableHub(input, permit)
(L5-owned, typed administration errors and safe non-credential result) is the one service
method called by the MCP handler. It
builds the existing update input `{ action: "configure", settings: { mode: "disabled" } }`.
Add its schema/catalog separately from the exact nine core tools; no credential installation,
provisioning or secret-returning administration MCP tool. RPC exposes get/updateHubSettings
unchanged, including configure-disabled; both require settings:write. syncStatus RPC/MCP requires
memory:read, including unbound/disabled status. CLIENT_GUARDED_RPC_SCOPES keeps existing settings
entries and adds list/search/read/history/changes/syncStatus read guards; source keeps compound
read grants. Behavior tests assert destination/live revoke for every addition. Server remains
authoritative; MCP metadata and client permissionAtom are availability only.

**Requirement 7:** list/search use indexed keyset pages, default 20/max 100, <=64 KiB encoded
response, no auto-drain or full-history expansion. List/candidates read watermark without scope
aggregation. Search coverage uses exact transaction-maintained scoped eligible/indexed counters;
L1 owns Store/counter migration and service consumption as one foundation slice. Preserve the existing MEMORY_SUBSTRING_MAX_ITEMS/MAX_UTF8_BYTES refusal policy, but read
its scope item/byte totals from maintained counters rather than current Store COUNT/SUM.
Substring search must not run an
unbounded instr scan: bound examined candidates to 1,000 per request with continuation based on
examined keyset rows, permit short/empty pages with nextCursor, and never report exhausted from
filtered results. FTS uses indexed keyset-window queries with <=1,000 candidate rows before matching and
materializing payloads; do not treat final LIMIT after a broad match/sort as proof of bounded
work. Continuation tracks examined rows for both modes, with at most 100 returned items. No new duplicate content index. Counter initialization/recovery also uses bounded keyset
batches with durable continuation; never a one-shot whole-scope COUNT/SUM during migration or
read. Until counters are ready, report coverage incomplete/unavailable and refuse unsafe substring
search rather than claim zero/exact totals. Update item/byte/eligible/indexed counters in the
same transaction as every write/receive/hold/forget/reindex transition, and verify rollback.
Real-store large-scope fixtures inspect query plans/counter updates and count examined work,
not elapsed sleeps or result length alone; compare MCP and RPC cursor semantics.

**Transport lock rule (rev 11f):** no handler opens SQL around a service call. Hub settings
authority reads use MemoryHubCommittedSettings.read (Ref, SQL-free); settings cache reload,
MemoryHubAdminSettings.withLock/file transition, network validation and token exchange must
never be awaited inside SQL Tx. L5 changes hub-only getHubSettings/authority projections to the committed Ref; full settings
remain allowed outside Tx only when actual non-hub configuration (for example model selection)
is needed. Existing Sync wrappers may read full settings outside Tx;
transport cannot move them inside one. Admin commands call the existing administrator workflow
outside SQL and preserve interruption-safe CAS. Invalid external settings retain last valid
committed epoch; diagnostics/UI presentation stay WP6.

Core RPC definitions already exist in `C/rpc.ts:2302–2396`: activate all **14** core methods,
including binding get/update, changes and hub settings. Import group stays separate for WP5.
Use exact MemoryService methods from §2 and WP3 wrappers, not new handler workflows.
`CLIENT_GUARDED_RPC_SCOPES` already contains memory writes, binding get/update (memory:write),
hub settings get/update (settings:write) and readSource in `C/clientRpcPermissions.ts:19–28`;
its helper at :78–96 adds orchestration:read for readSource and filesystem:read for import.
Extend behavior tests if a guard changes; do not describe existing entries as missing. Server
RpcAuthorization adds authoritative core method coverage and compound live checks. MemoryChanges,
ordinary reads and status require memory:read, regardless of UI availability.

NEW request-scoped `S/memory/MemoryAccess.ts` adapts authenticated live checks into Permit.
Missing grantedScopes/reauthorize denies memory (`S/mcp/McpInvocationContext.ts:60–64`). Recheck
mutations after SQL lock ownership immediately before decision/commit; no network or token
exchange in the transaction. Reads/source/stream recheck after waits and before exposing bytes.
Map denial to MemoryAccessError/safe transport auth error, without laundering it as availability.
Internal approved receive/registry paths remain unforgeable and outside public transport.

Complete the two credential producer chains, not just invocation types:

1. OAuth: existing AuthMcpApprovalDecisionRequest.memoryScopes (`C/auth.ts:621,627`) → browser
   consent / pairing proof → PendingCode stored selection → exchange → SessionStore scope codec →
   authenticated client → McpHttpServer context grantedScopes + repeatable reauthorize. Current
   `S/auth/McpOAuth.ts:454,540` and `EnvironmentAuth.ts:91,1325,1367` still derive from access;
   WP4 must preserve explicit selected union instead. One-click approver must cover the entire
   union (`mcpOAuthHttp.ts:130`). L4 owns the actual consent producer `apps/web/src/components/auth/ConnectAgentSurface.tsx` and its behavior test. `mcpOAuthHtml.ts` renders an error page and has no consent-producer assignment. Both browser-session and pairing-code proof arms send the explicitly selected memoryScopes (default empty); selection changes update payload and callback dependencies. The one-click predicate checks the entire access + memory scope union before choosing a proof arm. Carry selection through the existing decision schema, not a parallel API. Extend SessionStore with a token-free active-scope read using current revocation/expiry predicates for live checks. A selected memory:write grant never elevates runtimeModeCeiling. Read-only clients/sessions cannot use it: keep the existing write ceiling, with no independent memory-only write execution path. Non-read-only + explicit memory:write permits memory writes; thread-operate-free write issuance is outside this WP4 scope. Legacy codes/sessions get no new grants. No exchange escalation.
2. Provider: `ProviderSessionManager.ts:474–533` prepare/reuse → McpCredentialRequest
   (`McpSessionRegistry.ts:15–25`) → issued token registry → resolve/context → live permit.
   Consume the §6.1 policy producer; add stored grantedScopes and internal readCurrentPolicy callback. Issuance checks current
   thread/provider and installed policy before reuse, rotates on policy change, and invocation
   rechecks live caller/run/deletion. Thread read is independently granted orchestration:read,
   never inferred from memory:read. Preparing before activeRunId commits must not deadlock start;
   require active-run ownership at invocation. Do not put a callback or grants into agent input.

### 6.1 Managed provider policy producer (audit A4–A5)

Jun's confirmed requirement makes all GOAT-managed providers use the same memory through MCP and
start injection. Explicit installed default policy: memory:read + memory:write; read-only sandbox
or read-only thread/session gets read only. Existing read-only client ceiling still denies
memory_upsert/forget/revert even if a stored memory:write grant exists. No handler bypass,
ceiling elevation or independent memory-only write path. memory:read never implies
orchestration:read: issue that explicit grant only when existing orchestration thread-read policy
allows it; source needs both plus owner enrollment. runtimeMode/capability strings never create
grants; read-only state only narrows this installed policy.

L1 adds environment `enableAgentMemoryAccess` (Boolean, default on) beside existing agent-access
settings in C/settings.ts, including persisted settings decode/default, update schema and tests.
No new project override: environment setting is the upper bound, intersected with thread/session
read-only and existing orchestration-read policy. Off removes memory grants and start injection.
Schedule/delegation uses the persisted creation-time memory grant ceiling below. External OAuth
still uses explicitly selected scopes (default empty); owner allowlist is a separate policy.

L5 extends S/serverSettings.ts management via existing settings:write update path, persistence
and committed immutable policy Ref/version publication after commit. Snapshot and L2 callbacks
read that SQL-free projection plus committed thread/session policy, never getSettings/admin lock
in SQL. Absent/unready producer fails closed; a normally decoded missing setting means approved
default on, not missing authorization. Invalid external file retains last valid committed view.
On change publish new policy epoch, revoke/reissue existing provider credentials outside SQL;
live resolve denies stale policy immediately while adapter attachment is refreshed. L5 signals
L2's rotation hook, not a second registry. Availability cannot retain an old write/read claim.

Chain and ownership: L1 settings contract creation → L5 settings serialization/decode/committed
producer → L2 ProviderSessionManager prepare/reuse + McpCredentialRequest + registry stored
explicit grants/live resolver → L3 packages/provider-core/src/server/mcpSession.ts typed
availability config and every §5 native attachment/instruction consumer. Internal policy callback
serialization is N/A (process-local); grant availability propagates through adapter configuration,
never an agent prompt input authority field. The §6.1.1 ceiling is plain server-owned persisted
task metadata, not serialization of this policy callback or a credential. L3 owns mcpSession.ts/tests and each native MCP
configuration builder to derive read/write/source availability from actual issued grants.
L1 snapshot consumes the same producer without requiring an MCP token. Preparing before
activeRunId exists may issue a thread-bound credential; actual toolkit invocation still demands
current live owning run/provider/thread and rechecks epoch/deletion.

### 6.1.1 Persisted task memory grant ceiling (R2-1)

L1 defines **one server-owned persisted ceiling field per scheduled/delegated task**, with
semantics `none | read | read_write`; exact field name/schema follows existing contracts style.
It is derived from the creating caller's effective memory grant, not client task input, thread
runtimeMode/interactionMode or a parent thread ID. MCP uses McpInvocationContext grantedScopes
and live reauthorization (external OAuth explicit/default-empty; managed provider its own live
grant); client RPC uses the authenticated session scopes. Missing memory grant captures none.
Creation/admission checks run against live caller authority before persistence; no token value
or creator credential association is stored. Update RPC/MCP recaptures from the modifying caller,
including enabling/editing operations, so modification is the path to lower or restore a ceiling.

Ports: OrchestratorMcpService schedule/update and local/remote delegate producers →
ScheduledTaskService upsert/persisted DTO or delegated-task command/event/projection and durable
RemoteDispatchCoordinator record → scheduled launch AND bound sendToThread, local child launch
or SshRemoteDispatch wire/destination admission → RunExecutionService turn preparation →
ProviderSessionManager prepare input → McpCredentialRequest/registry issue/reuse/live resolver
AND snapshot admission. An existing bound thread's broader credential/snapshot cannot bypass
the task ceiling; per-task turn admission carries it to rotation/reuse and live policy checks.
Destination RPC/MCP must not trust a public caller-supplied ceiling: trusted server dispatch carries
it and destination intersects its authenticated dispatch authority. L1 covers scheduledTask DTO,
delegation/launch/turn payloads, codecs and restart projections; L5 owns producer/persistence/
dispatch transport, L2 consumes prepared input through registry. ThreadLaunchService,
ThreadManagementService and event-sourced command/Decider/Projector/effect ports carry this same
field, not another policy store. Absence in legacy rows/older-host requests decodes to none;
unsupported older destinations cannot silently drop it and launch with default grants: fail closed.

Remote issuance (re-audit r3 N3-1). The destination's authenticated dispatch authority is the
MCP client session that SshRemoteDispatch.sessionFor issues through `packages/ssh/src/tunnel.ts`
(RemoteMcpClientSessionOptions → buildRemoteMcpSessionScript → the existing generic
`auth session issue --scope`, which `S/cli/auth.ts:177–200` already supports). L5 adds to those
options the memory scope union for the server-captured ceiling (none adds nothing, read adds
memory:read, read_write adds memory:read and memory:write) and adds the captured ceiling to the
sessionFor cache key independently of runtimeMode, so sessions issued for different ceilings are
never reused across them. The destination computes authenticated scopes ∩ forwarded ceiling ∩
installed policy ∩ read-only; forwarded metadata can only lower the grant and never restores a
scope the session lacks. No new CLI, endpoint or dispatch registry. A none ceiling adds no
memory scope, so its issuance is unchanged; a read or read_write ceiling, or any dispatch to a
destination that advertises memory, requires the destination to accept the explicit scope and
the ceiling field, otherwise dispatch fails closed with a typed error and no retry or fallback
that drops them.

Issued memory grant = **current destination environment policy ∩ captured ceiling ∩ read-only
reduction**. Environment memory off always wins. Live resolver and snapshot consume only this
result, including destination policy changes after launch; independent orchestration:read stays
independent and cannot manufacture memory rights. Direct ordinary user starts retain §6.1 defaults.
Creator credential revocation/rotation after creation does **not** change an already stored
scheduled-task ceiling. This narrows the old parent-revocation promise: existing scheduled tasks
already store runtimeMode without revalidating creator credentials at firing; the smallest model
matches that lifetime. Controls are environment memory off and task update/delete. Delegation
captures the parent's live grant at dispatch, then uses the same persisted ceiling semantics.

Acceptance (L5 + L2): create bound/unbound tasks through real external OAuth callers and managed
provider sessions with no memory scopes/read-only memory grants; persist → restart → fire →
provider issue → actual MCP write attempt (denied) → snapshot (none/read as appropriate).
Include read_write positive, creator revoke/rotate before firing (stored ceiling unchanged),
local/remote delegation, legacy absent field=none, older-host missing/unsupported field, environment
off, destination policy change, bound-thread credential reuse and update recapture by a different
caller (lower/restore). RPC caller scope capture must also be observed. registry.issue fixture
scopes alone cannot close this chain. Tests run only macmini-cf focused + PR CI.

Remote issuance acceptance (N3-1, L5 with `packages/ssh` fixtures): on the same host and
runtimeMode dispatch none → read_write → read and the reverse order; cached sessions are reused
only within one ceiling; a caller without memory scopes cannot raise a forged forwarded ceiling;
an older destination rejecting the scope or field fails closed. Observe the final destination
credential through the real toolkit call and snapshot. The existing goat-ci ssh package step
(`.github/workflows/goat-ci.yml:112`) runs these tests; no new runner.

Same-conversation grant transitions (N3-2, L2/L3/L5): on one persistent native conversation per
credential-reusing provider (Codex long-lived session, Claude persistent query), run ordinary
read_write → bound task none/read → ordinary, then a task update back to read_write. Observe tool
denial and re-allow, snapshot omission and recovery, the credential actually presented, and that
Claude keeps its persistent query and background work. Credential refresh stays inside the
existing adapter ports; no per-prompt restart or synthetic memory turn.

### 6.2 Search page port and cursor semantics (audit A6)

L1 changes internal Store.search to return `{ items, examinedAfterMemoryId, exhausted }` rather
than ReadonlyArray<MemoryItem> (MemoryStore.ts:1332–1339). Store creates this page in bounded SQL;
MemoryService.search maps examined continuation into MemoryPage.nextCursor; existing strict
MemoryPage serialization/decoder carries it; L2 MCP and L5 RPC pass the same page without
recomputing cursor from matches. List retains its existing row cursor and public signatures.
Search cursor is opaque/versioned and binds normalized query digest, mode, memorySpaceId and
scope key (bounded canonical string within existing input/page wire fields, not MemoryId);
L1 splits the current shared page cursor decode: search uses its versioned codec, list still
uses MemoryId. No raw query/body in cursor;
wrong kind/query/mode/scope or malformed cursor returns safe validation error, never silently
restarts. Old search cursors without this binding are rejected; list cursors remain compatible.
Cursor schema/decode and every MCP/RPC consumer are L1→L2/L5 owned; no body in cursor.

For FTS and substring, first materialize an indexed memory-ID keyset window <=1,000 candidates
in the requested scope, before FTS MATCH/instr, sort or payload read. Inspect actual query plan
so optimizer cannot flatten the bound into a broad scan; final result LIMIT is not the bound.
Walk ordered window until output limit/64-KiB page bound or window end. Continuation is the last
actually examined candidate, not end of a preloaded window if output filled early, so remaining
matches are not skipped. Empty window of matches can still have non-null continuation. Exhausted
means keyset tail was proven reached (a short final window, or a later empty window), never
items.length < limit. Bounded counter/backfill readiness and final drift/grant fences still apply.

NEW shared `packages/client-runtime/src/state/memory.ts` uses createEnvironmentRpcCommand for
mutations/binding/settings and permissionAtom for UI availability. Raw clients remain in rpc/.
Expose guarded `importProvider({ environmentId, input })` through the same factory, using the
existing compound guard in `C/clientRpcPermissions.ts:23,84`: memory:write AND filesystem:read.
Its permissionAtom and execution check use the destination environment; unsupported destinations
return unavailable without local fallback. Behavior tests cover both grants, either missing grant,
revocation, selected destination and missing capability. WP5 alone activates the server import
group/handler and import capability; this factory does not activate a server route.
Use existing EnvironmentRegistry/followStreamInEnvironment subscription lifecycle; add memoryChanges
subscription tag in rpc/client.ts. Export `createMemoryEnvironmentAtoms(runtime)` from the new state module, using the existing state/runtime.ts helpers; web/mobile instantiate it against their existing connectionAtomRuntime, with desktop reusing web. One stream per connected memory-capable environment while
consumers exist. Initial reset/reconnect clears bodies before refetch; downgrade, disconnect,
backpressure or auth failure disables body exposure until a new reset. Forget/hold/dependency
signals bump generation, cancel pending reads and evict search/list/read/history/source/snippets
and edits derived from affected memory. Late output checks generation, grant, TTL and tombstone;
a later watermark cannot resurrect a deleted ID. Unrelated new drafts survive. No localStorage,
IndexedDB or native persistence for bodies. A write-only caller does not acquire a read stream.

Web (hosted/local), desktop and mobile consume this same runtime factory; WP6 owns visible memory
screens/Settings/palette/keybinding wiring and reverse controls. The OAuth consent producer
and its behavior tests are a WP4 L4 exception, moved from WP6 ownership (handoff in §9). Test selected environment routing
for local, remote/relay and tunnel; unavailable/old destinations return capability unavailable,
never route to client-local state. Do not set VITE_HTTP_URL/VITE_WS_URL. Capability advertisement
starts only when actual core routes and producers are ready; import and hub protocol remain
independent. Scheduled/delegated agents use the same services and admission policy.

## 7. Disjoint implementation lanes and integration

This is a future file-ownership map; it grants no source-writing authority in this P pass.
One WP4 change/PR when later requested; bounded lanes are not separate top-level work streams.
Each listed source owns its adjacent tests, unless a test is explicitly assigned below. New files
are marked NEW; existing files MODIFY. WP3 final is integrated. Treat its existing modules as this map’s exclusive owners;
interface gaps return to the coordinator. Tests run in PR CI and macmini-cf focused lanes.
On this Mac no bun/pnpm/vp test, vitest, e2e or full build; light targeted typecheck/lint are allowed.
No repo-wide checks. This docs-only reflection runs only document checks. No shell-profile sourcing or sensitive data reads.

Six lanes are file-responsibility slices inside one WP4, not six projects/PRs. L1–L5 form the
MCP/injection base; L6 is a mandatory original-relay lane, independently reviewable before final WP4 closure. Keep all six
provider decisions: dropping one loses c-5. Keep the small OAuth consent producer in L4:
without it real external users cannot grant memory scopes, so MCP tests alone prove no usable
path. Full memory screens, policy UI, disable/re-enable UI and diagnostics remain WP6. Guarded
import command may exist but cannot activate import capability before WP5. No extra UI redesign,
signed assertions or second index/runtime is included.

| Lane                                  | File owner (adjacent focused tests included)                                                                                                                                                                                                                                                                                                                                     | Output / predecessor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L1 contracts / domain / bounded Store | MODIFY C/{memory,rpc,clientRpcPermissions,settings}.ts and tests; S/memory/{MemoryService,MemoryStore}.ts and tests; NEW MemorySnapshot.ts, MemoryAccess.ts and tests; NEW packages/provider-core/src/server/memoryContext.ts and test; MODIFY provider-core/package.json; Store counter migration/registration only if required                                                 | First contracts/access/renderer; then Store counters/keyset ports + domain consumption. Candidate nextCursor, internal search-page/cursor chain, S13, bounded snapshots/restore, all core guards, provider settings default/decode/update, strict owner-policy/epoch/revoke stamp DTOs. Public source method keeps denying authority until L6 proof. No hub runtime changes.                                                                                                                                                               |
| L2 auth / MCP                         | MODIFY S/auth/{McpOAuth,EnvironmentAuth,SessionStore,mcpOAuthHttp}.ts; S/mcp/{McpInvocationContext,McpSessionRegistry,McpHttpServer}.ts; S/orchestration-v2/ProviderSessionManager.ts; NEW mcp/toolkits/memory/{tools,handlers}.ts and memoryAdministration/{tools,handlers}.ts, tests                                                                                           | Consume L1 contracts and L5 committed provider policy; produce explicit OAuth/provider grants, live permits, nine core tools + narrow disable registration. No Store/relay edits.                                                                                                                                                                                                                                                                                                                                                          |
| L3 provider delivery                  | MODIFY S/orchestration-v2/Adapters/{CodexAdapterV2,ClaudeAdapterV2,AntigravityAdapterV2}.ts; S/provider/CodexDeveloperInstructions.ts; packages/provider-core/src/server/{ProviderAdapter,mcpSession}.ts and tests; packages/provider-{cursor,acp,grok}/src/server/adapter.ts; provider-opencode/src/server/{adapter,v2/adapter}.ts and tests incl NEW v2/adapter.memory.test.ts | L1 renderer + L5 policy → L2 grants/rotation/live resolver → L3 truthful native config availability → all six §5 delivery/lifecycle paths, both ACP flavors, OpenCode v1/v2; preserve cloud observation-only attach.                                                                                                                                                                                                                                                                                                                       |
| L4 shared client / OAuth consent only | NEW packages/client-runtime/src/state/memory.ts and tests; MODIFY rpc/client.ts/tests and package.json export; NEW apps/{web,mobile}/src/state/memory.ts wrappers; MODIFY apps/web/src/components/auth/ConnectAgentSurface.tsx and NEW behavior test                                                                                                                             | L1 contracts → guarded destination commands, body-free stream/reset and late-result fences; both OAuth proof arms/explicit scopes/full-union one-click. No full memory screens or server auth edits.                                                                                                                                                                                                                                                                                                                                       |
| L5 coordinator / settings integration | MODIFY S/{ws,server,serverSettings}.ts; S/auth/RpcAuthorization.ts; S/orchestration-v2/{RunExecutionService,runtimeLayer}.ts; S/environment/ServerEnvironment.ts; S/memory/MemorySyncService.ts and tests; MODIFY .github/workflows/goat-ci.yml; owning 040/000 records                                                                                                          | After L1 contracts, first produce committed provider policy/rotation hook for L2; later consume L1–L4 → 14 core RPCs, disableHub wrapper, committed settings projections, one graph and actual turn insertion. Own provider and owner policy settings CAS/publication/propagation view and single L6 composition. Only coordinator runs integrated client verification; mandatory CI provider fixture collection change; record exact focused file list/counts/steps at final SHA.                                                         |
| L6 mandatory source relay             | MODIFY S/memory/{MemorySyncRuntimeLive,MemoryHubService,MemoryHubClient,MemoryHubHttp}.ts and tests; MemoryHubSyncScenarios.test.ts; NEW MemoryOwnerSourceReader.ts/test                                                                                                                                                                                                         | Consume frozen L1 contracts/L2 permits/L5 policy, D2–D4 confirmed A-lite. Owner allowlist/reader, owner epoch/revoke respond union, hub pair fence/denied settlement and authenticated stamps/codecs; scenario g/restart/idempotent revocation. After L1/L5 base lands, explicit sequential handoff of ONLY source-relay sections/tests of MemoryStore.ts and MemorySyncService.ts; no concurrent ownership. Return shared settings/composition patches to L5, contracts/public method patches to L1. No search/counter/disable ownership. |

R2 ownership additions below are part of the same lane map (MODIFY with adjacent focused tests);
they do not create new lanes or parallel ownership of the existing L2/L5/L6 files.

| Lane                               | Additional actual file ownership / ports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Sequential handoff                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1                                 | C/{scheduledTask,orchestrationV2,orchestrationDispatch,rpc,memory}.ts: one ceiling field through persisted scheduled/delegated DTO, command/event/turn/launch payload and legacy-none codecs; normal/revoke respond ack/result and removal/enrollment state codecs. Required storage migrations/registration for ceiling/fence metadata returned by L5/L6 are L1-owned.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Freeze before L5 producer/L2 consumer; later schema corrections return to L1. Exact migration file/ordinal selected against integrated source, no guessed WP5 ordinal.                                                                                                                                                                                                              |
| L5                                 | S/mcp/OrchestratorMcpService.ts schedule/update/local/remote delegation producers and destination launch admission; S/scheduledTasks/ScheduledTaskService.ts DTO storage/restart/upsert-update/enabling/launch/bound send; S/remoteReports/RemoteDispatchCoordinator.ts durable record and S/sshRemote/SshRemoteDispatch.ts wire forwarding/sessionFor ceiling cache key/older-host fail closed; packages/ssh/src/tunnel.ts RemoteMcpClientSessionOptions memory scope union and tunnel.mcpSession.test.ts (N3-1); S/orchestration-v2/{ThreadLaunchService,ThreadManagementService,Orchestrator,EventSink,ProjectionStore,EffectWorker,ThreadCommandExecutor,RunExecutionService}.ts ceiling command→event→projection→effect→turn preparation; S/ws.ts authenticated RPC scope capture; S/{serverSettings,server}.ts ack persistence/barrier activation/publication/composition. | L5 early slice implements ceiling capture/carry with committed policy before L2 issuance. L2 alone edits ProviderSessionManager/registry; L5 supplies typed prepare input and returns any consumer patch to L2. L1 owns contract/migration patches. L5 base settings/Sync lands before L6 takes only relay sections; L6 returns matching ack persistence/application patches to L5. |
| L2                                 | Existing S/orchestration-v2/ProviderSessionManager.ts and S/mcp/{McpInvocationContext,McpSessionRegistry}.ts consume task prepare ceiling, intersect destination policy/read-only, reuse/rotation/live resolver and expose same effective result to snapshot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | After L1 contracts + L5 early producer; no concurrent L5 edits in these files.                                                                                                                                                                                                                                                                                                      |
| L5 remote admission / bound intake | S/mcp/ThreadLaunchMcpService.ts and S/mcp/toolkits/project/{tools,handlers}.ts carry authenticated remote delegation ceiling through the existing goat_thread_launch parameters/admission; S/orchestration-v2/ThreadMessageIntake.ts carries bound scheduled turn metadata. The same L1 ceiling codec is reused, never a caller-chosen grant.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Same L5 early slice; remote field omission/unsupported tool schema fails closed, no launch retry that drops ceiling. Consumer changes in ProviderSessionManager return to L2.                                                                                                                                                                                                       |
| L6                                 | Existing S/memory/{MemoryHubClient,MemoryHubHttp,MemoryHubService,MemorySyncRuntimeLive}.ts and sequentially handed-off MemoryStore.ts/MemorySyncService.ts: revoke Tx all pre-barrier pair requests terminal denied, durable fence, strict matching ack transport/retry, old requestId/response/duplicate rejection, result Tx release boundary.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Only after L1/L5 base. L5 applies ack/barrier settings patches after L6 transport/fence; L1 applies migration/codec returns. WP6 consumes pending enrollment and bounded revocation promise.                                                                                                                                                                                        |

Order: pin WP3 → L1 contracts/access/renderer/settings/search-page/ceiling/ack port → L5 committed provider
policy and task ceiling producer/carry (early slice) → L2 issuance/reuse/live resolver → L3 availability/native delivery.
L1 Store/domain and L4 consent/client can run after frozen contracts; neither waits on final L5
composition. Then L5 base integration consumes L1–L4 → L6 mandatory relay with named sequential
Store/Sync handoff → L1/L5 consume final relay ports/settings/wiring → independent review and
focused exact-head verification. L5 early producer and final integration are slices of one owner,
not a cyclic dependency. Shared Store/Sync edits are sequential; return contract/settings patches
to L1/L5, no concurrent edits. WP5 takes shared files only after final WP4/L6 handoff; its active
planning worktree is untouched. No duplicate Store/Worker/runtime. Base-only evidence does not
close WP4/M16/full c-5. WP1–WP6 ship together (Jun 2026-10-14); no PR/push authorized here.

L5 early runs as three internal stages (re-audit r3 N3-3), all inside the existing L5 owner and DAG:
(1) after frozen L1 codecs, SQL-free policy and caller capture/input ports; (2) ceiling
persistence and carry plus remote issuance (N3-1); (3) wiring after L2/L3 integrate. Each file
changes only where the field would otherwise be lost; where EventSink/ProjectionStore already
preserve payload codecs, a fixture confirms it instead of a new column or store. No extra lane,
PR or registry, and L5 early does not need toolkit success before L2.

## 8. Focused acceptance and evidence plan

Automated implementation tests run in **PR CI and macmini-cf focused lanes — NOT RUN in this pass**. L5 also owes the
pre-approved test-t3-app real-screen pass on an authorized verification host, outside this
docs-only pass and without prohibited local test/build commands. These are requested observable cases,
not verified commands or evidence of compilation. Do not execute bun, pnpm, vp test, vitest, e2e,
repo-wide checks or a full build on this Mac. The macmini-cf runner must collect the actual changed test paths and
inspect steps/logs at the final SHA; job conclusion without execution is insufficient.

| Owner / focused test targets                          | Activation → observable proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L1 MemorySnapshot / provider-core memoryContext       | Page watermark and final readiness/binding fences → three scopes never mix committed views; concurrent change discards selection without unbounded retry; explicit/repository/unmapped project and foreign scoped IDs → only correct space entries, one watermark. Real-store first page entirely excluded, next page eligible → list nextCursor reaches the eligible row without repetition; exact-ID revision reads return null continuation. Pagination beyond 100 → deterministic selection. All excluded/all output-oversize items hit the 10-page/1,000-slot/640-KiB scan ceilings independently of output size; pre-filter encoded pages obey 64 KiB. Short page reads release the common transaction lane so forget/approved receive can commit between pages. Escaped special characters, emoji/combining text, exact cap/+1 → both framed budgets hold, whole facts only, altered frame rejected. Forget/conflict/hold/forget_pending between selection and restore → no stale body; FTS pending remains eligible. Candidate and list pages run no scope-wide coverage aggregate: a scope far larger than one page costs only the page reads, and a forget committed between pages proceeds. |
| L1 MemoryService / MemoryAccess                       | L6-required real-store source seam: local owner and A/H/B relay succeed with no direct owner connection; offline/expiry → source_unavailable; denied → auth denial; forgotten/source_invalidated/secret_detected preserved. Deferred gates then revoke/forget before response or lock acquisition → no bytes/commit/outbox. Scanner/watermark/message selection enforced.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| L2 auth / ProviderSessionManager / McpSessionRegistry | Actual settings input/default-on/off→committed policy→prepare→issue→adapter→real toolkit read/write/thread-grant path; read-only memory_upsert denied even with stored write grant, non-read-only explicit write allowed; off→no snapshot/tool rights; on→new credential; pending rotation never uses old grant; schedule/delegation cannot exceed parent policy; reuse rotates on policy change; preparation before activeRunId succeeds, inactive/deleted caller invocation fails. OAuth browser and pairing proof→code→exchange→authenticated tool; unselected/legacy/access-only/reused/expired/escalated code cannot mint memory grants; approver union checked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| L2 toolkit / McpHttpServer                            | List exact nine core tools plus separately gated administration disable tool; readonly calls denied without explicit grants, writes denied on read-only ceiling; revoke during service transaction wait prevents mutation. Tool result is strict JSON with no undefined optional fields; safe capacity/deadline/code retained.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| L3 each provider adapter                              | Actual captured native payload contains bounded data on first and second ordinary prompt/resume/retry. Both ACP flavors covered. Claude query not restarted; native compact/compress unchanged; no synthetic wake. Codex restore Deferred + foreign-thread snapshot reuse, binding change followed by late compaction, run termination, permission loss, delete/revision change/duplicate completion → cleared memory or surviving exact items only, retry after failed inject. OpenCode v2 failed put → no prompt, successful empty put after forget → stale value cleared, cache updated only on success. External OpenCode snapshot succeeds without falsely advertising MCP.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| L4 client-runtime / rpc / clientRpcPermissions        | Selected remote/tunnel destination used; unavailable old environment never falls back locally. Real reset/forget/hold/dependency stream evicts affected bodies and derived edits; late response cannot resurrect; unrelated drafts/environment intact. Disconnect/downgrade/reset handshake fences exposure; write-only never subscribes. importProvider({ environmentId, input }) and permissionAtom require both memory:write and filesystem:read; either missing/revoked grant denies, unsupported destination is unavailable, selected destination is retained. ConnectAgentSurface behavior tests capture both proof-arm payloads through the existing schema, default empty scopes, changed selection and full-union one-click acceptance/rejection.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| L5 ws / RpcAuthorization / RunExecutionService        | All 14 core methods reach services (source success requires L6; until its proof source remains denied) with repeatable permits; binding change and useRepository reversal; settings CAS wrappers preserve semantics, configure-disabled reaches administrator, unbound status preserves counters/processing; settings:write for get/update/disable, memory:read for status. Deferred settings reload with concurrent SQL reauthorization completes without lock cycle. Revocation while update waits prevents commit. Ordinary start and explicit compact get snapshot; cloud reattach calls observation-only resume without launching or sending memory/user message. One Store/Worker/runtime and ready capability gate. L5 runs test-t3-app against the actual OAuth consent screen (both proof paths/selection changes), attaches before/after screenshots to the UI PR and satisfies goat-screenshot-gate; formatter/unit evidence alone cannot close this UI acceptance.                                                                                                                                                                                                                         |
| L5 integrated M19/M20                                 | Local new mutation at capacity → safe capacity_exceeded; forget still uses deletion path; authenticated approved receive under local brake/scan/index/parent holds still persists receipt/cursor with deferred state. Search/status expose incomplete coverage and 1/7/30-day signed growth with partial/unavailable endpoints. Source/cache/provider preparation failure cannot stall sync. No new index/archive or unbounded snapshot cache.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### 8.1 Source relay scenario g and denial/revocation (L6)

Extend actual `MemoryHubSyncScenarios.test.ts` plus Access/OwnerReader/HubClient/HTTP/Store
focused files. WP3's terminal-denial fixture (`:825–857`) is a baseline, not success evidence.

- **g / confirmed A-lite:** B owns a stopped thread with completed evidence messages; requester
  A has only summary/ScopedThreadRef/watermark. A's authenticated MCP/RPC caller has live
  memory:read + explicit orchestration:read. B administrator explicitly enrolls A's environment;
  empty allowlist denies. A cannot connect directly to B. Real prepare→local compound permit→
  H request/stamp→B collect/policy/read/respond→H result→A validate returns exact selected
  original bytes through the watermark, within bounds. Repeat owner=hub/local path with the
  same policy; no original bytes in canonical/FTS/events/snapshots/report/cache archives.
- Missing caller grant, inactive/deleted run/session, sync-only member with no owner enrollment,
  unlisted environment, forged stamp/wrong owner/digest/credential version, expired deadline,
  legacy unstamped row, deleted/forgotten thread or invalid watermark/selection → denied or
  precise source-invalidated outcome, no transcript read. Two callers cannot share results;
  stable retry keeps deadline/digest. A-lite negative tests prove local grant enforcement;
  they do NOT claim owner-independent caller verification against a malicious allowed member.
- Deferred before read/response/hub accept/result: remove A from B's committed allowlist,
  revoke member credential/caller grant, disable hub, forget/invalidate or end run; resume →
  denied at each corresponding authoritative boundary. Requester-local caller/locator checks
  still fence requester return; owner removal does not cancel a result already released by its
  hub result Tx. Owner-local removal is immediate for reads/response; hub pending result removal
  completes at matching revoke ack (§3.2). Never assert remote completion from Ref publication alone.
  Removal during owner read must fail its post-read permit; no pending request forever and
  unrelated sync/forget progresses. Caller revoke is enforced locally in A-lite, not asserted
  by an owner subject verifier. TestClock TTL/retry/restart cannot extend authorization.
- Release boundary fixture 1: accept B's available response at H, hold **before result Tx
  admission** with Deferred, remove/Ref/revoke Tx/matching ack, then resume result → typed denied,
  payload absent. Fixture 2: allow result Tx to complete, hold **after commit but before HTTP
  encode/send or requester exposure**, then remove/revoke/ack and resume → delivered (assuming
  requester-local checks/deadline remain valid), explicitly pre-revocation released in-flight.
  No requester owner-removal cancellation port and no recall assertion.
- Barrier fixture: removal commit → Deferred delays outbound revoke → attempt re-registration
  (pending remains, no new active enrollment/read/response) → old revoke arrives → hub Tx closes
  all pair pending/completed-but-unfetched requests and advances fence → exact matching ack
  persisted on owner → new epoch activates → new request succeeds. Before ack assert pending,
  never complete. Old requestId replay/old response cannot revive a denied request at new epoch;
  duplicate old revoke cannot delete a new response. Old ack cannot settle a later removal.
  Restart owner/hub before send, after hub commit/before owner ack persistence and after activation;
  fail network/retry same revoke → durable monotonic fence, idempotent ack and unchanged barrier.
  All interleavings use Deferred/persisted milestones, no sleeps/network/admin lock in SQL.
- Actual SQL relay fixture: deadline fixed <=75s on retry/restart; unconsumed body may survive
  restart only within original deadline; consumption/expiry/forget/revoke deletes logical row.
  Verify 32/environment, 128/hub, 64-KiB outcome/collect caps, quota/8-MiB live body bound and
  absence from canonical/FTS/checkpoints/log/events/reports/injection. No zero-SQL-INSERT claim.
- Offline owner/timeout stays source_unavailable; scanner/generation drift stays distinct.
  Use synthetic identities and fixture messages only, no real credentials/user databases.
  L6 must pass original-read success before WP4 completion; no optional relay-off acceptance.

Base L1 tests scoped counters under write/forget/approved receive/reindex/rollback, large-scope
list/search examined-row limits, FTS/substring first 1,000 examined rows no match→non-null cursor→later match; 100 returned items with more matches in window→no skipped match; short final window→null, incompatible query/mode/scope cursor→validation error; actual FTS/window query plan and identical MCP/RPC page semantics (§6.2).
L2/L5 prove MCP and RPC same cursor/error semantics. L2 tests disable handler→one L5-owned
settings wrapper with settings:write; L4 tests guarded configure-disabled/status; L5 tests
committed Ref CAS/reload-lock interleaving and one composition. L6 has no counter prerequisite
beyond consuming the already-verified base Store; no success fallback owner permit.

### 8.2 c-5 acceptance crosswalk and surfaces (reflection r1)

c-5 = “MCP tools and provider-start injection pass according to each provider decision.”
Unit renderer tests or toolkit catalog enumeration alone cannot close it. L5 records final
SHA, collected file names, executed counts and test steps/logs from PR CI/macmini-cf; tests here
are NOT RUN. L1/L2/L4 evidence supplies prerequisites; L3/L5 must join them at real adapter sends.

| Provider/path           | L3 captured native payload + lifecycle proof                                                                              | L2/L5 actual MCP path proof                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Codex                   | First/second ordinary start, resume, explicit compact and exact-revision restore; revoke/forget/binding/run change clears | Issued provider credential→registered toolkit→read/write call subject to policy; readSource compound grant + L6 g                  |
| Claude                  | Both real message builders/fallback/retry, persistent query unchanged; native compact produces no synthetic user turn     | Full prefixed six read tools in readonly policy, three writes denied; explicit scope revoke denies through actual handler          |
| Cursor                  | Text/image ordinary/resume payload preserves runtime/attachments; native /compress bypass then next prompt refresh        | Adapter-configured MCP route uses issued live scopes; missing/revoked scope denies, availability claim matches attachment          |
| Grok                    | Shared ACP ordinary prompt separate memory block, resume refresh; flavor fixture preserves native control flow            | Grok HTTP/stdio bridge fixture→authenticated tool invocation, explicit grant/deny; no inference from shared ACP success            |
| Antigravity             | Separate ACP flavor ordinary/resume fixture; no invented compaction support                                               | Profile/runtime restrictions→actual granted/denied MCP call; unavailable tools are not advertised                                  |
| OpenCode v1/v2          | v1 framed system entry; v2 successful put/clear and failed-put no prompt; retry refresh                                   | Managed route actual tool invocation; external snapshot-only mode has no forwarded credential/tool claim                           |
| Cloud observation / omo | Observation attach sends no user/memory prompt; omo conditional only via compatible OpenCode fixture                      | Reachable authenticated cloud route required for tool claim; unsupported cloud/omo inheritance explicitly unproven, no new adapter |

L1 packer/admission proves 6,000 code points AND 24 KiB with escaped framing and bounded scans;
L2 proves nine core tool results/denials, explicit OAuth/provider grant chains and JSON-safe errors;
L4 proves default-empty selection in BOTH consent proof arms and destination command/stream
invalidation. These are necessary but do not substitute for the per-provider joined paths above.
L5 verifies actual start→snapshot callback→adapter payload and issued credential→MCP service
invocation for each supported provider route, including the real creation→persistence→restart→
firing→issuance→write denial/snapshot task ceiling chain and local/remote delegation (§6.1.1).
L6 alone closes original-read success/denial/revoke; without it c-5 is base-only, full gate OPEN.

| Surface / entry                  | Required evidence / owner                                                                                                                                                                                                                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web local + hosted, desktop      | L4 shared runtime/destination behavior; L5 one real OAuth consent pass plus desktop shell smoke (same web screen, no new IPC). Capture before/after images for any later UI PR; satisfy goat-screenshot-gate.                                                                                               |
| Mobile                           | L4 wrapper imports/shared command behavior for selected remote environment; L5 verifies remote reset/forget body eviction in native client via test-t3-mobile on authorized off-host fixture if exposed UI changes. No mobile consent screen invented; browser-based OAuth consent uses existing web entry. |
| Settings / palette / keybindings | WP4 introduces no memory management screens or new shortcuts: visible entries remain WP6. New service/guard commands are shared, so WP6 must wire every applicable entry and reverse action.                                                                                                                |
| Local / remote relay / tunnel    | Synthetic selected-environment fixtures ensure no localhost fallback; off-host client integration records remote/tunnel reset/revoke/forget results. A-lite uses outbound member→hub only; revoke ack/retry tested for remote/tunnel.                                                                       |
| Reverse / reconnection           | Forget/revert, useRepository, disable/re-enable, allowlist add/remove and reconnect discard pending output/caches; services/RPC in WP4, visible controls in WP6.                                                                                                                                            |

Use TestClock/Deferred and real service/store fixtures; event-sourced milestones use worker drain
or persisted event, never sleeps/polling. Light targeted package typechecks/lint may run locally; tests and exact focused collection
run in PR CI and macmini-cf. Inspect executed steps/logs at the exact head; separate their receipts. Server tests belong to existing goat-ci shards; shared runtime
cases belong to test-client-runtime. L5 must change .github/workflows/goat-ci.yml:115–119
to include the new cursor/acp/opencode adapter and OpenCode v2 memory fixtures, as well as any
new Grok flavor fixture not otherwise executed. Existing provider-core/contracts/client-runtime/web
steps (:113–131) remain distinct; root Vite collectability does not imply CI execution. Record
each exact focused file, collected/executed test counts and actual step/log at final SHA. Do not invent a new parallel runner or claim a broad glob covers new
files without checking collection. Every actual changed file must have an owner/CI collection
entry before B closes. M19 packaged/off-host evidence remains separate from source CI.

## 9. Risks, surfaces and reflection handoff

- WP3 final is the implemented dependency. Recheck the pinned signatures at B integration.
  The mandatory source authorization/owner-reader activation and base bounded search counters remain WP4 work. A mismatch requires owner repair,
  not transport-side SQL or a guessed fallback.
- Snapshot page/final watermark fences, conservative scan ceilings and transaction-lane release
  need real-store proof; no cross-page transaction is permitted. Recheck local
  readiness/binding and exact revision filtering at the admission/restore boundary. No paid
  model, source relay or network authentication inside SQL.
- Schema/renderer amendment S13 and provider-specific instruction semantics need reflection.
  OpenCode v2 clearing failure must fail preparation; Codex replay must not resurrect deletion.
- Explicit provider/OAuth grants require full producer-to-consumer proof. Existing capability or
  full-access selection does not confer memory/thread rights. UI guards are availability hints;
  service live permits are the authoritative path. Alternate raw handler entry is a bypass to
  test, not a claim of unbypassable enforcement (E7; 000 enforcement inventory).
- Web local/hosted, desktop and mobile share client state; visible entry points and reverse
  actions remain WP6. Providers: six decisions in §5. Agents: nine core service-backed tools and settings-gated disable,
  including scheduled/delegated callers. Contracts: S13, candidate nextCursor, internal source stamp/legacy codec and owner allowlist admin schemas; public readSource input stays unchanged and execution identity stays internal.
  Reverse states: forget/revert, binding useRepository and settings disable/revoke clear exposure.
  Connection modes: local, remote/relay and tunnel preserve destination and owner authority.
- omo remains conditional OpenCode compatibility; no native integration or plugin inheritance
  proof. Cloud observation-only attach cannot retrofit memory into an already-running remote task.
- **Confirmed scope:** A-lite and WP1–WP6 joint release (Jun 2026-10-14); mandatory L6.
  Independent re-audit of this fix remains next; no passing CI/runtime claim.

### Cross-phase handoff ownership — accepted follow-ups, not edits in this pass

| Recipient | Disposition / required WP4-facing reconciliation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 030       | ACCEPT scope/ownership correction: §8 prose must match rev 11g fail-closed ownerPermit/reader, with successful original relay in WP4 L6. Preserve rev 11f committed Ref/last-valid epoch and rev 11g terminal-denial evidence; correct §12 wrapper error unions to actual Sync signatures. No WP3 code rework or new c-4 success claim.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 050       | ACCEPT dependency re-anchor only when WP4 head exists; consume live Permit and guarded importProvider command. WP5 retains import group/handler/capability and later ownership of MemoryService/Store after WP4 handoff. REJECT source attestation as import authority; filesystem:read remains separate. No WP5 implementation pulled into WP4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 060       | ACCEPT transfer of ONLY ConnectAgentSurface and behavior tests to WP4 L4 (both proof arms, selection/full-union one-click); L5 owns real-screen evidence/screenshots. WP6 retains all memory screens, visible disable/re-enable, owner allowlist add/remove and pending/acknowledged revocation state, memory-access on/off, last-valid settings diagnostics, unbound status/reconciliation UI. Show re-registration as pending until matching removal ack is persisted on owner, then active at newer epoch. User docs/status say “철회는 이후 요청과 허브에 남은 결과에 적용”; pre-revocation result-Tx release may still arrive, with no recall promise. Explain stored task ceiling survives creator credential rotation/revocation; environment memory off or task update/delete controls it. It consumes WP4 public readSource and typed deny/offline/forgotten, never builds a second relay/reader or requester cancellation port. |

These are coordinator reconciliation items before the respective implementation B, not permission
to edit 030/050/060 now. The prior report's all-macmini-only static-check rule is rejected;
000's original Jun localtests rule and the corrected §7–8 apply.

Authoring verification: input HEAD/branch, clean status and current source ports were inspected.
Only the two authorized documents change. node_modules is absent in this worktree, so vp fmt
is skipped per the task; no formatter from another worktree and no dependency install. Fresh
git diff --check and the local commit are recorded in `/tmp/goat-wp4-auditfix-r2.md`.
Tests/builds/typechecks/lint/UI verification are NOT RUN; runtime success is not claimed.

## Folded revision correspondence

| Prior material                                                       | Current home                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| rev 2 cross-phase contracts and rev 3 producer/consumer/source fixes | §2–3, §6–7                                                                                                                                                                                                                                                                                                                                                                                 |
| rev 4 live provider/thread authorization and static-input coverage   | §6–8; actual CI collection replaces obsolete 60-file command receipt                                                                                                                                                                                                                                                                                                                       |
| reflection r1 G-1 / audit r1 A#2                                     | §2, §4, L1 ownership and §8: preserved list nextCursor, candidate contract and real-store excluded-page continuation                                                                                                                                                                                                                                                                       |
| reflection r1 G-2/G-3                                                | §4–5, §8–9: execution-aware restore, explicit scan ceilings, short page transactions and drift fences                                                                                                                                                                                                                                                                                      |
| audit r1 A#1/A#3                                                     | §6–9: L4 actual consent producer and guarded import command; L5 UI proof; WP5/WP6 handoff                                                                                                                                                                                                                                                                                                  |
| prior snapshot/provider recipes                                      | §4–5 with current ports, cloud semantics and S13 correction                                                                                                                                                                                                                                                                                                                                |
| rev 7 requirement 7 / M19 and audit fixes; rev 8 M20                 | §3–4, §6, §8–9; approved receive remains independent of local exposure                                                                                                                                                                                                                                                                                                                     |
| re-anchor/reflection r1 history                                      | Prior alternative model/optional relay discussion is superseded by Jun's 2026-10-14 A-lite decision and required L6. Source seam, provider lifecycle, consent ownership and local static-check rules retained.                                                                                                                                                                             |
| audit-fix A1                                                         | §1/§3.1/§7–9/000 current cycle: A-lite confirmed; mandatory L6; WP1–WP6 joint release; alternative executable paths removed.                                                                                                                                                                                                                                                               |
| audit-fix A2 — nonblocker                                            | §3.3: 030 §8/M16 WP0-approved bounded purgeable SQL buffer is allowed; nonpersistent-original wording was coordinator overreach. Logical <=75s retention/consume/expiry bounds, not disk noncontact or secure erasure. Low hardening follow-up only.                                                                                                                                       |
| audit-fix A3                                                         | §3.2/§8.1: respond union revoke, durable pending settings→Ref→outbound→same-Tx hub pair fence/delete/denied→ack; epoch-stamped responses, retry/restart and accepted-before-delivery test.                                                                                                                                                                                                 |
| audit-fix A4                                                         | §6.1/§7/§8: approved managed default read/write narrowed by read-only, independent orchestration-read, settings:write memory on/off; L1→L5 producer→L2→L3 config; parent ceiling and rotation/revoke proof.                                                                                                                                                                                |
| audit-fix A5                                                         | §6/§6.1/§8: keep read-only ceiling even with write grant; non-read-only writes require explicit memory grant; independent memory-only write/thread-operate-free path out of scope.                                                                                                                                                                                                         |
| audit-fix A6                                                         | §2/§6.2/§7/§8: internal search-page examined continuation, full Store→Service→MemoryPage→MCP/RPC chain, cursor query/mode/scope binding and SQL window before match/final LIMIT.                                                                                                                                                                                                           |
| audit-fix CI collection                                              | §7/§8.2: L5 must modify goat-ci provider execution list; exact files/counts/executed steps at final SHA, no root-glob assumption.                                                                                                                                                                                                                                                          |
| audit-fix R2-1 — coordinator lifetime narrowing                      | §6.1.1/§7/§8.2: one server-owned persisted memory ceiling captured from effective caller grant; create/update→storage→launch/remote→prepare→issue/live resolver/snapshot. Legacy absent=none. Creator revoke/rotation after creation does not mutate saved ceiling, matching existing runtimeMode lifetime; environment off and update/delete control it. Delegation captures at dispatch. |
| audit-fix R2-2 — coordinator barrier                                 | §3.2/§7/§8.1/060 handoff: re-registration pending until exact matching removal hub ack persisted on owner; revoke Tx terminal-denies all old pair pending/completed-but-unfetched rows and advances durable fence before new epoch activation. Strict ack/result/state codecs, old ID/response/revoke/ack and restart acceptance.                                                          |
| audit-fix R2-3 — coordinator release boundary                        | §3.2/§8.1/060 handoff: hub result Tx is release linearization; revoke blocks subsequent result admission and deletes hub-waiting payloads, but pre-revoke released in-flight result may arrive after ack. Two Deferred fixtures prove denied-before-Tx vs delivered-after-Tx; no requester cancellation port.                                                                              |

No superseded appendix remains an alternate instruction source. This document is the current WP4
consumer plan; WP1/WP2 implementation and merged WP3 service ownership remain authoritative for their ports.
