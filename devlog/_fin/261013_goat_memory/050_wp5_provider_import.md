# 050 — WP5: read-only provider memory import

A user can explicitly bring supported Codex, Claude and omo memories into GOAT with their
source provenance. GOAT never changes those sources. Re-import observes stable source keys,
content changes and permanent forget suppression; every environment submits the same ordinary
local intents to the configured hub. Imported text is untrusted inference, not instructions.

- Date: 2026-10-15. Status: **P audit-fix r4 / READY_FOR_B handoff**, not implementation or runtime approval. A1–A6, R2-1/R2-2 and F3-1/F3-2 dispositions and acceptance remain closed in this plan; implementation/runtime acceptance: **NOT RUN**.
- Authoring branch: `goat/memory-wp5-provider-import`, worktree `goat-wp5-plan`, input `c0023a846` = WP5 plan `317bb5de1` plus integrated WP4 final `90edc7a40`. WP4 #190 remains an unmerged draft per coordinator; integration here is not release or CI certification.
- Dependency pins: actual source at input `c0023a846`, WP4 final `90edc7a40`, WP3 final `5f12fb1b8` and [030](030_wp3_hub_sync.md) rev 11f/11g. [040](040_wp4_mcp_injection.md) §9/050 handoff is consumed read-only; 030/040/060 are not edited. No moving-head fetch is claimed.
- Authority: [000 decisions](000_plan.md#decisions-main-dispositions-of-m1-m20) M17/M19/M20, [shared names](000_plan.md#shared-names-all-phase-docs-must-use-these), [enforcement limits](000_plan.md#enforcement-inventory), and Jun's final joint WP1–WP6 release decision: extend unreleased hub v1 in place, no v2.

Authoring scope is the coordinator-approved reflection r4 / audit r4 fix on clean input
`b08da4e6e4e150097d935ee07692129b1c3278bc`, not a new product design or implementation cycle. The five
lanes, L1-0 invocation environment, durable factory callbacks, auth identity, lineage budgets,
GOAT-owned Git snapshot and closed audit decisions remain. Only 050 and the WP5 cycle in 000
are edited/committed; no code, dependency install, other worktree mutation, push, PR or merge.
Report: `/tmp/goat-wp5-auditfix-r4.md`. Source inspection is static evidence only.
Run the explicitly authorized main-worktree `vp fmt` and `vp fmt --check` on only these two
absolute document paths; record fresh results with `git diff --check` / post-commit
`git show --check` in the report. These are documentation checks. Tests, vitest,
e2e, builds, typecheck/lint, remote execution and hosted CI are **NOT RUN** in this P task.

## 1. Stale check and evidence boundary

The following statuses compare the inherited 050 assumptions with **current code**, not prior test receipts. OK means the seam/policy remains valid, STALE means this body replaces it, and MISSING means a named WP5 implementation addition (not an unresolved product decision). `S` = apps/server/src; `C` = packages/contracts/src.

| ID / status      | Assumption and re-anchor                                                                                                                                                                                                                                                                                                                                                                                          | Current file:line evidence                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R01 STALE        | WP4 final is now integrated; replace the WP3-only baseline.                                                                                                                                                                                                                                                                                                                                                       | S/server.ts:667–699; S/persistence/Migrations.ts:176–179                                                                                                   |
| R02 OK           | Binding and repeatable permit remain; preserve captured key/version fences.                                                                                                                                                                                                                                                                                                                                       | S/memory/MemoryService.ts:146–160                                                                                                                          |
| R03 OK           | transact discharges Transaction; apply/withAdmission include conflict and capacity.                                                                                                                                                                                                                                                                                                                               | S/memory/MemoryStore.ts:862–866,1286–1292; S/memory/MemoryQuotaService.ts:21–34                                                                            |
| R04 STALE        | Sync Error is the concrete MemoryHubServiceError union, not native Error; no new readiness service.                                                                                                                                                                                                                                                                                                               | S/memory/MemorySyncService.ts:29,97–106,1938–1960; S/memory/MemoryHubService.ts:19–24                                                                      |
| R05 OK           | materializeLocalIntent is initial-only; replacement needs parent-aware preparation.                                                                                                                                                                                                                                                                                                                               | S/memory/MemoryStore.ts:5164–5227; S/memory/MemoryService.ts:510–554                                                                                       |
| R06 OK           | Assignment and ACK/pull settlement already exist; add lineage at these transactions.                                                                                                                                                                                                                                                                                                                              | S/memory/MemoryStore.ts:992–1003; S/memory/MemoryService.ts:96–147,1672,1735                                                                               |
| R07 OK           | 071 receipt/source/key tables exist; service importProvider and durable import codecs remain WP5 additions.                                                                                                                                                                                                                                                                                                       | S/persistence/Migrations/071_Memory.ts:173–201,260–267,322–324; S/memory/MemoryService.ts:73–234                                                           |
| R08 MISSING      | Complete lifetime lineage and its 1,000-record/32-MiB ceilings are still new; provenance is bounded.                                                                                                                                                                                                                                                                                                              | C/memory.ts:361–375; S/memory/MemoryStore.ts:1499; S/persistence/Migrations.ts:176–179                                                                     |
| R09 MISSING      | Import key/content extraction and first-forget reservation union remain WP5.                                                                                                                                                                                                                                                                                                                                      | S/memory/MemoryService.ts:585–620; S/memory/MemoryStore.ts:5292–5328                                                                                       |
| R10 STALE        | Extend 072-derived hub accounting while preserving WP4 073 bounded search counters.                                                                                                                                                                                                                                                                                                                               | S/persistence/Migrations/072_MemoryHubSync.ts:70–139,393–407; S/persistence/Migrations/073_MemorySearchCounters.ts:7–31; S/memory/MemoryStore.ts:8455–8472 |
| R11 MISSING      | Checkpoint has no importLineage; extend complete producer/install/compaction, not bounded provenance reconstruction.                                                                                                                                                                                                                                                                                              | C/memory.ts:2315–2363; S/memory/MemoryStore.ts:7873–8035; S/memory/MemoryCompactor.ts:53–125                                                               |
| R12 OK           | Ordinary hub admission/approved settlement remains authoritative; no import sync exclusion.                                                                                                                                                                                                                                                                                                                       | C/memory.ts:391–431; S/memory/MemoryService.ts:1404–1542,1642; S/memory/MemorySyncService.ts:1144,1564                                                     |
| R13 OK           | Resolver writes execution provenance; preserve independent lifetime lineage through edits/resolve/revert.                                                                                                                                                                                                                                                                                                         | S/memory/MemorySyncService.ts:675–684; S/memory/MemoryService.ts:788                                                                                       |
| R14 STALE        | 073 search counters and 074 task/dispatch ceilings are occupied; use 075_MemoryImportLineage followed by 076_MemoryCheckpointAccounting.                                                                                                                                                                                                                                                                          | S/persistence/Migrations.ts:178–179; S/persistence/Migrations/074_MemoryTaskGrantCeiling.ts:9–14                                                           |
| R15 MISSING      | Register stable MemoryImportLineage after all four existing memory names; extend registry and upgrade expectations.                                                                                                                                                                                                                                                                                               | S/persistence/reconcileGoatMigrationIds.ts:18–21,48–70; S/persistence/Migrations/055_OrchestrationV2.test.ts:16                                            |
| R16 OK / MISSING | Reader is absent; retain non-inheriting process adapter and sealed GOAT-owned Git snapshot, not shared runner edits.                                                                                                                                                                                                                                                                                              | S/vcs/VcsProcess.ts:31,130–139; S/processRunner.ts:279–299                                                                                                 |
| R17 OK / MISSING | Scanner exists; whole-file secret selector/header refusal remains WP5 integration.                                                                                                                                                                                                                                                                                                                                | S/memory/MemorySecretScanner.ts:32–50; C/memory.ts:1823–1844                                                                                               |
| R18 STALE        | Guarded import command is delivered; actual client protocol, server group/handler and capability activation remain WP5 L5.                                                                                                                                                                                                                                                                                        | packages/client-runtime/src/state/memory.ts:245–275,401; packages/client-runtime/src/rpc/protocol.ts:1–13; S/auth/RpcAuthorization.ts:46–48                |
| R19 OK           | Live 16 RPCs = core14 + owner2; staged import is separate. Keep core9 MCP tools, no import tool.                                                                                                                                                                                                                                                                                                                  | C/rpc.ts:2391–2420; S/ws.ts:1397,3358; S/mcp/toolkits/memory/tools.ts:68–205                                                                               |
| R20 STALE        | Preserve Snapshot proxy and SourceReadBinding singleton composition; import does not recreate them.                                                                                                                                                                                                                                                                                                               | S/memory/MemorySnapshotBinding.ts:15–64; S/server.ts:506–529,667–699,948–952                                                                               |
| R21 OK           | Owner reader/policy binding and settings lifecycle already exist; import grants never grant thread relay.                                                                                                                                                                                                                                                                                                         | S/memory/MemoryOwnerSourceReadPolicyBinding.ts:8–25; S/server.ts:677–684; C/settings.ts:1183–1194                                                          |
| R22 MISSING      | Descriptor lacks memory capability. WP5 L5-early explicitly takes over WP4’s small core advertisement gap: advertise protocolVersion=1 for installed core14+owner2=16, importProvider omitted/false, independently of readers. L5-late sets importProvider=true only after import routes/client group/runtime/reader cleanup are ready. Existing hub flag and memoryHubProtocolVersion conditions stay unchanged. | S/environment/ServerEnvironment.ts:270–315; C/environment.ts:101–108,339–340; packages/client-runtime/src/state/memory.ts:254–260                          |

Read-only evidence: repository `goat-si/goat_initiative`, commit
`7541eff2fdb9a6b9923d20e231b8e687ea2e3662`, repository-relative
`research/075_cross_provider_memory_cases.md:31–49,81–117`,
`research/100_omo_memory.md:3–25`, `research/110_omo_memory_layer.md:3–47,49–78`,
`research/120_goat_memory_source_terrain.md:13–43,61–102`. These dated investigations distinguish
provider canonical text from navigation, transcripts and execution state. Their Git-canonical
GOAT proposal, provider-disable option and older test results are not adopted as current GOAT
behavior. WP2 SQLite plus 030 hub admission supersede that storage/sync proposal.

Provider source references in §2 are pinned local **public source repositories**, read via
`git show` without checkout or execution. Claude's corpus is a dated research account; no
fresh Claude implementation or installed layout is claimed. No actual provider memory corpus,
settings, credentials, transcripts or provider Git state was inspected or changed. Earlier
guidance lookups are historical only; this audit-fix reads no provider memory corpus and
relies only on the supplied reports and this tree’s source contracts.

## 2. Provider source and parser decisions

Roots are resolved inside the **selected destination environment**, never the browser,
Electron renderer, mobile device or coordinator machine. Trusted immutable server root slots
can replace defaults for deployment overrides and temporary fixtures. The RPC contains no
absolute path or free-form profile. Do not read provider settings to discover overridden roots.
An unsupported layout is explicit `unsupported_format`, not arbitrary Markdown fallback.

| Provider / parser profile           | Source location and item unit                                                                                                                                                                                                      | Parser decision and exclusions                                                                                                                                                                                                                                                                                                                                                                                           | Evidence / version policy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex / `codex-handbook-v1`         | `<codex-home>/memories/MEMORY.md`, default `~/.codex/memories`; one `# Task Group:` block requiring `scope:`, optional supported `applies_to:` routing metadata. Key `MEMORY.md#task-group:<NFC title>`.                           | Pure UTF-8 Markdown parser tracks fences; duplicate normalized group titles reject the file. Keep guidance/task text; remove scope/routing/evidence-list metadata from assertion text. `memory_summary.md`, `raw_memories.md`, rollout summaries, sessions/JSONL, SQLite, skills, workspace diffs and Git internals are excluded. No links or rollout_path are followed. Missing handbook does not fall back to summary. | Public `https://github.com/openai/codex` repo pin `816fa702ec66a4c81b204701a03371a1ac3511e6`: `codex-rs/memories/write/src/lib.rs:37–41,112–131`; `codex-rs/memories/write/templates/memories/consolidation.md:119–140,179–210,235–273`. The old shortened template path was wrong. Grammar, not an inferred installed app version, selects support.                                                                                                                                                                                                                                      |
| Codex / `codex-ad-hoc-v1`           | Same root, `extensions/ad_hoc/notes/*.md`; one whole nonempty note, `<relativePath>#body`.                                                                                                                                         | Strict UTF-8 Markdown; reject NUL/JSONL transcript envelopes. Exclude all other extensions/resources and instructions.md; no recursive extension scan. Notes may be selected without a handbook.                                                                                                                                                                                                                         | Same public pin, `codex-rs/ext/memories/src/local/ad_hoc_note.rs:12–23,26–39`. Source bytes are never edited.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Claude / `claude-topic-v1`          | Default `~/.claude/projects/<opaque>/memory/*.md`, one explicitly selected immediate memory directory; whole root-level topic, `<relativePath>#body`.                                                                              | YAML frontmatter has scalar name/description/type; type is user/feedback/project/reference; nonempty body. Reject duplicate keys, tags, anchors, unsupported nested data/types. MEMORY.md is navigation only. Exclude agent-memory, CLAUDE.md/rules, episodes, settings, sessions, symlinks and linked outside files. Encoded dirname is not project identity.                                                           | Research `goat-si/goat_initiative@7541eff2fdb9a6b9923d20e231b8e687ea2e3662:research/110_omo_memory_layer.md:28–30`; its historical corpus source is the separate research repository `/Users/jun/Developer/codex` at `339e793ea197b9e6c46bf5c81e7e8e128aba52ec`, repository-relative `010_memory-pipeline/10_cc_memory.md:89–138` (not a file in goat_initiative). AutoMemoryDirectory/remote overrides exist in the account but are not discovered from private settings. Unknown header returns unsupported_format.                                                                     |
| Claude / `claude-topic-metadata-v1` | Same registered source and whole-file key.                                                                                                                                                                                         | Compatibility profile for scalar name/description plus metadata.type. If direct type also appears it must agree. Optional metadata.node_type/originSessionId are ignored; neither is shared or treated as a GOAT identity. All other nested objects reject.                                                                                                                                                              | Prior 050 recorded this shape from a home observation; it is **historical, unverified here**, not public-source confirmation. Keep narrowly isolated synthetic fixtures; no broad YAML fallback or claim of current universal compatibility.                                                                                                                                                                                                                                                                                                                                              |
| omo / `omo-memory-core-beta63`      | Default `~/.omo/memory/agents/<explicitly selected id>/repo`; pin one HEAD commit. Regular Git Markdown blobs under system/, notes/, people/, reference/, projects/. Whole monthly ledger/observation file, `<relativePath>#body`. | Reproduce first-colon scalar frontmatter: required nonempty description, optional string read_only/kind, JSON string-array aliases; tolerate limit/other scalar fields but do not share them. Reject malformed/ambiguous headers. system/persona.md and identity.md are untrusted data only. Exclude runtime, worktrees, locks, skills, transcripts, jobs, untracked/dirty bytes, symlink blobs and gitlinks.            | Public `https://github.com/code-yeongyu/oh-my-openagent` repo pin `ebfa564862e82cfd1a8c3b45daa4993a40dc7cd6`: `packages/memory-core/src/identity/layout.ts:47–78`, `memfs/frontmatter.ts:22–90`, `compile/compile.ts:25–43`, `recall/provider.ts:25–58`, `facts/person-routing.ts:68–70,112–131`. Current reference checkout HEAD `f83f934325d72d15a85d4a797d7f9a3c0798bf9a` is 4.5.12 without memory-core; do not parse its task/session state as this profile. beta.23 tests in the full `goat-si/goat_initiative` research/100 path pinned above are historical, not WP5 verification. |
| Cursor                              | Unsupported.                                                                                                                                                                                                                       | No supported file profile in MemoryImportFormat and no pinned canonical source contract here; do not scrape settings/session caches.                                                                                                                                                                                                                                                                                     | Import scope is separate from WP4 common-memory delivery.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Grok                                | Unsupported.                                                                                                                                                                                                                       | No researched, pinned provider-native durable memory format in these inputs; ACP delivery does not establish a source importer.                                                                                                                                                                                                                                                                                          | Future profile needs owner contract and fixtures.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| OpenCode without omo                | Unsupported.                                                                                                                                                                                                                       | OpenCode sessions/plugin state are not the omo committed memory repository.                                                                                                                                                                                                                                                                                                                                              | omo is a source format, not a new GOAT provider driver.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Antigravity                         | Unsupported.                                                                                                                                                                                                                       | No researched, pinned provider-native memory file contract here; do not infer it from ACP.                                                                                                                                                                                                                                                                                                                               | WP4 delivery remains supported independently.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Other providers/extensions          | Unsupported.                                                                                                                                                                                                                       | MemoryImportFormat accepts only codex/claude/omo; instructions, arbitrary Markdown and conversation archives are outside import.                                                                                                                                                                                                                                                                                         | Adding support requires a new explicit format/profile decision, never a generic fallback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Parser versions are explicit constants; known native app version is not in the current import
DTO and must not be invented in provenance. A profile/parser update re-previews under the same
source ID/item key, preserving suppression and accepted history. Never key identity by version,
mtime or Git HEAD. Ambiguous key migration stops with unsupported_format; a deliberate source
registration migration must transfer old aliases/suppression before enabling a new key. A path
or title rename is a new source key, checked against exact-content suppression; rename plus
paraphrase has no semantic erasure guarantee. Oversized whole-file items reject, never truncate.

## 3. Implemented / WP3-provided / WP4-provided / WP5 adds

`S` = `apps/server/src`, `C` = `packages/contracts/src`, `M` = `@goat/contracts`,
`E<A, X>` = `Effect.Effect<A, X>`, `Permit` = repeatable `E<void, MemoryAccessError>`.
Path:line references below are the **WP4-final `90edc7a40` source integrated at input `c0023a846`**. Every row states current value/error/environment (R); NEW means WP5 work, not a missing WP4 deliverable. Inspecting signatures does not establish runtime PASS. `Store.InTx<A,E>` retains the existing private Transaction tag until transact discharges it (Store:552–556). L1 exports that existing tag/type for its planned cross-file callback annotation; no second transaction owner.

| Port / state                       | Actual shape / anchor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | WP5 action                                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Binding / R=never                  | getProjectBinding(input, permit): E<M.MemoryProjectBinding, MemoryServiceError>; resolveProjectKey(space, project): E<M.MemoryProjectKey \| null, MemoryServiceError>. S/memory/MemoryService.ts:146–160.                                                                                                                                                                                                                                                                                              | Preserve current signatures and captured binding/version.                                                                                                                        |
| Transaction / R discharge          | Store.transact<A,E,R>(effect, options?: {requireOuter:boolean}): Effect<A,E \| MemoryStorageError,Exclude<R,Transaction>> (S/memory/MemoryStore.ts:862–866); apply(decision): E<StoredReceipt,MemoryStorageError \| MemoryStoreConflict \| MemoryCapacityError> (:1286–1292); receipt(space,id): E<StoredReceipt \| undefined,MemoryStorageError> (:1266–1269). Service.upsert(input,permit): E<StoredReceipt,MemoryServiceError> (S/memory/MemoryService.ts:166–169; implementation :510).            | All three ordinary methods have R=never. Extract parent-aware internal seam; one item transaction includes CAS/receipt/intent/quota.                                             |
| Initial intents / R=never or InTx  | putLocalIntent: E<void,MemoryStorageError \| MemoryStoreConflict>; materializeLocalIntent: E<MaterializedIntent,MemoryStorageError \| MemoryStoreConflict>; materializeLocalIntentTx: Store.InTx<MaterializedIntent> (S/memory/MemoryStore.ts:1542–1555). Service.commitLocalIntent: E<MaterializedIntent & {receipt:StoredReceipt},MemoryServiceError> (S/memory/MemoryService.ts:73–79).                                                                                                             | Initial-only empty parents (:5198–5213); preserve identity/epoch fences, no replacement shortcut.                                                                                |
| Assignment / R=never or InTx       | listMaterializableIntents(environment,limit): E<readonly LocalMemoryIntent[],MemoryStorageError>; assignIntentIdentityTx({environmentId,intentId,memorySpaceId,operationId,revisionId}): Store.InTx<AssignedIntent> (S/memory/MemoryStore.ts:992–1003).                                                                                                                                                                                                                                                | Sync retains assignment/bootstrap ownership.                                                                                                                                     |
| Readiness / R=never                | readLocalReadiness(): E<{memorySpaceId:M.MemorySpaceId \| null; bootstrap:"unbound" \| "staging" \| "ready"},Error>; requireBootstrap(space): E<void,Error>; syncStatus(input,permit): E<M.MemorySyncStatus,Error> (S/memory/MemorySyncService.ts:97–106,1938–1960). Error aliases Hub.MemoryHubServiceError (:29), the MemoryServiceError \| HubError \| HubUnauthorizedError \| HubForbiddenError union (S/memory/MemoryHubService.ts:19–24).                                                        | Map known typed hub failures safely; preserve MemoryAccessError identity. Unbound/staging/mismatch rejects; ready offline stays pending.                                         |
| Hub / transaction-aware settlement | admitHubOperationTx({authority,operation,resolutionRequest?}): Store.InTx<M.MemoryHubReceipt,MemoryServiceError \| M.MemoryHubError \| M.MemoryHubUnauthorizedError \| M.MemoryHubForbiddenError>; settleHubEntryTx(input): Store.InTx<Store.Settlement,MemoryServiceError> (S/memory/MemoryService.ts:96–120). receiveHubPage(input): E<readonly Store.Settlement[],MemoryServiceError> (:121–129); settleHubAcknowledgement(input): E<Store.Settlement,MemoryServiceError> (:137–147), both R=never. | Reuse exact authority/reauthorize inputs; union only accepted lineage in hub admission and ACK/pull transactions.                                                                |
| Suppression / quota                | readSuppressions(space,id): E<ReadonlyArray<M.MemorySuppressionRecord>,MemoryStorageError>; firstForgetReservation(operation): E<{bytes:number;keys:number},MemoryStorageError>, R=never (S/memory/MemoryStore.ts:1488–1502). Quota.withAdmission<A,E,R>(input,commit) keeps R and adds StorageError \| CapacityError \| StoreConflict; samples/growth R=never (S/memory/MemoryQuotaService.ts:21–53).                                                                                                 | Extend permanent lineage/reserve and indexed lookups, retain existing FTS/search counters/metrics.                                                                               |
| Checkpoint / InTx and scope        | producer.prepareTx({authority,checkpointId,hubEnvironmentId}): Store.InTx<{checkpointId,checkpointSequence},MemoryHubServiceError> (S/memory/MemoryCompactor.ts:18–30). compact/compactIfNeeded R=never; start R=Scope (same file :32–45). Store.installCheckpointPage/completeCheckpoint return E<void,StorageError \| StoreConflict>, R=never (:1562–1573; implementation :4806,:4897); snapshot producer :7873–8035; bound :8464.                                                                   | Extend same Store producer/install and accounting; no settings reload in SQL, new compactor or extra connection.                                                                 |
| Wire contracts / staged import     | C/memory.ts:1919–1954 actions/results; C/rpc.ts:2395–2419 staged WsMemoryImportRpcGroup and core14/admin2; C/clientRpcPermissions.ts:31,92–95 dual import/source scopes.                                                                                                                                                                                                                                                                                                                               | L1-0 adds lineage checkpoint only; L5 installs import into server AuthorizedWsRpcGroup/ws and actual client protocol group.                                                      |
| WP4 client / live access delivered | packages/client-runtime/src/state/memory.ts:245–275,401 already has guarded destination-pinned importProvider({environmentId,input}), permissionAtom and capability check. S/ws.ts:1380–1396 repeatable SQL-free live memoryPermit; S/memory/MemoryAccess.ts:5–35 read/write/source helper; S/auth/RpcAuthorization.ts:309–333 delegates compound checks to clientRpcRequiredScopes.                                                                                                                   | Reuse command and client dual-scope guards. L5 supplies memoryPermit([memory:write,filesystem:read]) to every import action; write-only helper is insufficient. No new MCP tool. |
| WP4 graph / delivered              | Snapshot.forThread/revalidate/invalidate (S/memory/MemorySnapshot.ts:16–44); proxy late binding (MemorySnapshotBinding.ts:15–64); SourceReadBinding then Sync.start (S/server.ts:506–529,667–699); committed owner policy adapter (MemoryOwnerSourceReadPolicyBinding.ts:8–25).                                                                                                                                                                                                                        | Keep one Store/Service/Sync/Snapshot/Registry. Add invocation-only ImportRuntime after existing layers, preserve core/relay startup on reader failure.                           |
| WP5 public facade / NEW            | MemoryService.importProvider(input,permit): Effect.Effect<M.MemoryImportProviderResult,MemoryServiceError \| M.MemoryImportRpcError \| M.MemoryRpcError,ProviderMemoryImportRuntime> is absent at input HEAD.                                                                                                                                                                                                                                                                                          | L1 owns facade/types/durable callbacks; L4 closes factory over same Service/Sync; L5 provides tag only at handler invocation. Factory run and callbacks R=never.                 |

The WP4 dependency merge/re-pin requested by the old §3 is satisfied at this input. WP5 B still
requires independent audit of this plan and its own exact-head proof; no WP4 CI/release or
runtime readiness is inferred. 040/030/060 remain read-only.

## 4. Bounded read-only flow, identity and settlement

### 4.1 Actions, roots and snapshots

All four actions require memory:write **and** filesystem:read at the destination. Discover
uses input.memorySpaceId and format; preview uses sourceId and returns a server sessionId;
apply supplies space/source/session/batch operationId and 1–32 selectors
`{sourceItemKey, sourceFingerprint, scope, project?}`; status takes space and operationId.
No body preview, caller path, free-form parserVersion or start/cancel job. New wire changes are checkpoint lineage plus hub compatibility fencing specified in §5 L1-0; import action DTOs stay unchanged.
Results obey 64-KiB encoded limit as well as item counts (`C/memory.ts:1919–1954`).

**WP4 A-lite boundary (Jun decision supplied for this reflection).** Import's destination
memory:write AND filesystem:read grant checks authorize provider-file discovery/read/import
only. They do not attest a requester or grant original-thread source relay. WP4 owns requester
caller authorization plus the owning device's allowlist/read policy; a sync credential alone
never authorizes raw source access. Keep its attestation/relay path out of ProviderMemoryImport
and out of import grant synthesis. Imported provenance is evidence of origin, not a relay permit;
provider originals have no GOAT sourceThread and cannot be fetched via memory_read_source.
WP4 final supplies the owner relay and policy binding; consume them without recreating them. WP4 L2 owns the
nine-tool MCP catalog/auth/handlers including memory_read_source, **not an import tool**;
WP4 L4 owns the guarded import client command; WP5 L5 owns only import RPC activation. An MCP
import tool is excluded from current acceptance and requires a separately assigned contract
and auth change; no unowned promise of future exposure is necessary for c-6.

The reader registers an opaque UUID sourceId once per `(space, environment, format, trusted
logical root slot, selected Claude directory/omo agent)`. Persist registration in the source
arm of memory_import_receipts; paths stay server-local. Display labels and item selectors are
scanner-checked, bounded metadata without home paths. Provider settings/CLI are never used to
resolve identity. Changing trusted root requires explicit registration migration preserving
source IDs/suppression, not minting a new ID to bypass forget.

Filesystem reader: reject symlink roots/ancestors/final files, escapes and nonregular files;
open read-only with no-follow and descriptor identity checks, bounded reads, strict UTF-8 and
restat. Detect identity/size/mtime change during read as source_changed. On platforms without a
safe no-follow/ancestor check, fail path_rejected rather than silently follow a link. If Effect
filesystem cannot provide descriptor safety, inject a narrow Node read-only adapter inside
MemoryImportReader only. No provider-side temp file, lock, chmod, mkdir or write capability.

omo reader: use argument vectors and no shell. Existing VcsProcess.run is the reference (`S/vcs/VcsProcess.ts:23–55`), not proof of environment isolation. Every Git invocation uses a reader-owned sanitized environment with
`GIT_OPTIONAL_LOCKS=0`, `GIT_NO_LAZY_FETCH=1`, `GIT_TERMINAL_PROMPT=0`,
`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, and `GIT_ALLOW_PROTOCOL=`;
unset inherited Git config injection, proxy, askpass and credential-related variables.
The current process runner sets extendEnv=true whenever input.env exists (S/processRunner.ts:279–299). A missing key is not removal, and undefined removal is not established by this API. L2 therefore owns a narrow read-only Git process adapter inside MemoryImportReader with **extendEnv=false / complete static safe environment**, an injected absolute Git executable and no shell. It must not enumerate or log the host environment to build its map. Do not modify shared processRunner/VcsProcess or copy credentials. If the platform cannot enforce non-inheritance, refuse typed source_unreadable. Use synthetic sentinel variables/fixture credentials only to assert no inheritance and no helper execution; never dump child environment values into logs or evidence. Reader fixtures own this proof.
**Execution boundary: GOAT-owned snapshot only (R2-2).** Never run Git against the
provider `.git`, even for probes. The reader copies a bounded standalone in-root `.git`
through no-follow descriptors into a private GOAT-owned GIT_DIR. Copy only HEAD,
refs (exclude refs/replace), packed-refs and objects (loose objects plus pack files).
Reject gitfile, any commondir, metadata/ancestor symlink and either
objects/info/alternates or objects/info/http-alternates, even an in-root alternate.
Perform these checks during descriptor-based copy, not a separate path check followed by
unsafe reopen. Do not copy original config, hooks, index, logs, info, worktrees or modules;
objects/info is inspected only for forbidden alternates, never copied. GOAT writes minimal
config with only core.repositoryformatversion=0 and core.bare=true in a `[core]` section,
with no include/includeIf or extensions. Unsupported object format/layout refuses
unsupported_format; no source-config parser or include-detection dependency remains.

The adapter is Node-only (B decision, 2026-10-15): Node has no openat/dir_fd, and a Python or
native helper is not acceptable for a server and desktop app that ship only the Node runtime
(macOS without Command Line Tools turns /usr/bin/python3 into an install prompt; Windows has no
Python). It walks from the trusted root with lstat, opens files with O_NOFOLLOW where the
platform provides it, compares fstat dev/ino/size/mtime with the preceding lstat, keeps full
stamps for enumerated source directories, and re-lstats the file and every ancestor after
reading. The accepted residual risk is a same-user swap-and-restore between two checks: that
attacker already controls the provider files. Platforms without O_NOFOLLOW rely on the lstat
checks plus revalidation. Every copied descriptor is checked before/after
read and the ancestor chain revalidated through copy completion; identity/size/mtime drift,
replacement or disappearance returns source_changed with no candidate bytes. Seal the snapshot
before Git: close all writable handles; only this reader Scope can own it, and Git gets no
provider-root path/working directory. After sealing, provider swaps cannot redirect Git reads.
Every invocation uses `GIT_DIR=<snapshot>` and an empty GOAT-owned cwd, no work tree and no
GIT_WORK_TREE; static environment and arguments contain no provider path. Every invocation
(including capability probes) disables replacements via `--no-replace-objects` or static
`GIT_NO_REPLACE_OBJECTS=1`. Excluding loose replace refs is not enough: packed replace refs
are also ignored by this flag. Tree symlink/gitlink rejection remains separate.

**Snapshot budgets and lifetime (L2 reader; L5 startup binding).** Use
`join(ServerConfig.stateDir, "memory-import", "snapshots")`, never system TMPDIR.
`S/config.ts:134–159` derives stateDir as baseDir/userdata (baseDir/dev for implicit dev),
and derives settingsPath from that same stateDir; `S/serverSettings.ts:1293` consumes it.
L5 passes the configured stateDir explicitly to reader acquisition, with Scope supplied only
at acquisition; returned reader methods and ImportRuntime.run remain R=never. Do not hardcode
home/userdata or inspect live settings/DB to discover this path. Fixtures pass isolated stateDir.
Snapshot root/children are server-owned mode 0700, files 0600; reject symlink ancestors/foreign
entries instead of following them. Cleanup is confined to this dedicated directory and never
traverses symlinks or removes anything in provider roots. No provider-side write, lock or temp.

Freeze private L2 constants: at most **2** live snapshots per server/stateDir; each has at most
**64 MiB (67,108,864 bytes)** total copied/generated file bytes and **4,096** total visited
metadata entries (excluded entries count), with objects separately capped at **60 MiB
(62,914,560 bytes)** / **3,584** visited entries (loose + pack, all scanned objects entries).
Depth <=8 and relative metadata path <=512 UTF-8 bytes; remaining non-object metadata <=4 MiB.
These are separate from source text limits below; no 256-KiB source-blob limit is imposed on
pack files, but declared size is charged before copying and streaming stops at +1 byte.
Reserve a full 64-MiB slot before directory creation under one L2 reader-scoped
admission semaphore; total simultaneous reservation/on-disk bytes <=**128 MiB (134,217,728)**.
No waiting queue or new worker: slot/byte/entry/depth overflow returns existing limit_exceeded
before allocation/read beyond the bound. Count generated config too; no new wire issue enum.
Invalid boundary → path_rejected; observed copy mutation → source_changed; unsupported Git/
read failure → source_unreadable, all value-free. These stricter limits may refuse large repos.

Register cleanup in an interruption-safe acquire/release before the first copied byte.
Success, failure, interruption and Git timeout terminate/wait the owned process, close handles,
then recursively remove only the owned snapshot and release its reservation. A failed removal
must retain its slot/byte charge, mark reader unavailable (source_unreadable), and emit only a
value-free cleanup-stage failure; never ignore failure and admit another leaking snapshot.
Before activating import at server startup, L5 awaits reader cleanup of all previous snapshots
in that stateDir, then initializes empty admission accounting. Cleanup is bounded by the same
2-slot/128-MiB/entry ceilings; unexpected oversized/unsafe residue or deletion failure disables
import until explicit operator repair, without blocking unrelated core services. StateDir must
have one server owner; do not clean an active peer’s snapshots. No background worker/timer,
persistent raw archive or resume-from-snapshot protocol. Crash residue is removed before the
next import; successful finalizer/startup acceptance requires **zero snapshot residue**.
Pass `-c credential.helper= -c core.askPass= -c protocol.allow=never` on every call;
disable transport/credential helper execution through the injected process boundary as well.
Use global `--no-lazy-fetch` when supported. Detect the Git version/capability using this same
restricted environment before repository reads. Only a documented supported version that
honors lazy-fetch prohibition may proceed; an unknown or unsupported version refuses omo
as typed unavailable (`MemoryImportRpcError { issue: "source_unreadable" }`), with no fallback.
Resolve HEAD^{commit} once, bounded `ls-tree -rz --full-tree` on that OID, then size-check/read
regular blobs by object ID with cat-file. Only modes 100644/100755 and approved paths qualify.
Gitlink/120000 rejects; dirty/untracked content is ignored. HEAD moves cannot mix commits.
No fetch, status/index refresh, checkout, hooks, worktree, add/commit or provider process.
Timeout/output truncation/absent objects return a bounded typed issue, never empty success;
never serialize stderr or filesystem causes. Missing promisor blobs must not launch fetch or
transport or modify the object database; §6 checks `.git/objects` as well as refs/index/config.

Filesystem source-walk hard ceilings (Git metadata copy instead uses the separate §4.1
entry/byte ceilings above): 128 discovered roots, 512 visited entries per selected root
(including excluded entries), depth 8 and relative selector <=512 UTF-8 bytes; 256 KiB per
file/blob; 8 MiB aggregate source bytes; 128 preview candidates; title <=256 Unicode code
points. Omo tree output also has an 8-MiB cap independent of approved blobs. Codex's large
handbook can therefore be refused explicitly; never read an unbounded file just to decide it
is too large. Count before retaining; +1 yields limit_exceeded and a narrower-source request,
not a seemingly complete partial enumeration. Request output encoding can reach its cap before
128 items; reject a complete oversized preview rather than silently drop rows. Pure parsers
never perform I/O, SQL, time/randomness, includes, fetches, link traversal or model extraction.

Scan every raw allowlisted file and human-readable header/title/key before returning metadata;
then scan normalized accepted payload. The current scanner only recognizes its configured
patterns and content fields: a detected secret blocks the item/file, but this is not a claim
of complete secret detection. Blocked/suppressed preview rows omit title as required by
`C/memory.ts:1861–1877` only when their selector itself is safe. If sourceItemKey or locator
matches the scanner, reject the entire containing file before emitting any of its rows or
committing any item from it. Return existing `MemoryImportRpcError { issue: "secret_detected" }`
without preview/item-result rows containing that key, locator or original value; no raw value
in logs, receipts, diagnostics or reports. Do not replace the key with a sentinel or treat
omitting title as sufficient. Scan before persisting registration/selection metadata; apply
rechecks the reread file and uses the same error path. Other already committed files retain
bounded batch status without recording the rejected file's values. No rejected raw content
appears in errors/model input.

### 4.2 Sessions, replay and changes

`sourceItemKey` is stable within the parser profile. Receipt identity is
`(memorySpaceId, environmentId, sourceId, sourceItemKey)` as in 071's item index, **not** an
invented SQL key containing format/locator. sourceLocator/format are registered provenance.
`sourceFingerprint = SHA256(parserVersion + canonical allowlisted title/body/metadata)`;
`contentFingerprint = SHA256(NFC(body).replace(CRLF, LF).trim())`. No case-fold/NFKC/semantic
matching. Exact-copy lookup includes space, scope and assertion kind. Live matches also compare
retained canonical bodies; forgotten hash matches suppress conservatively. Hashes are not a
privacy guarantee and are not exposed as searchable text.

Persist a bounded source registration/session envelope in existing registration_json: active
server session ID, source/profile/snapshot digest, creation/expiry, applied item charges and
session counters; no raw bytes. Session ID <=64 bytes as required by apply/receipt; one current
session per source, expiry bounded by MEMORY_DERIVED_CACHE_TTL_MS. Re-preview replaces transient
bytes only, never historical item identity/accepted parent. The same snapshot's source session
must span its 32-item chunks; concurrent callers use CAS. New session/source registrations
still face cumulative metadata/source/live admission, so chunk/session splitting cannot reset
M19. No persistent raw snapshot archive; staged candidate bytes share
MEMORY_CHECKPOINT_STAGING_MAX_BYTES and expire/purge on forget. The transient Git metadata/object
snapshot instead has the separate §4.1 disk reservation and Scope/startup cleanup; it never
survives as a reusable session cache. Prefer re-read to candidate disk caching.

First validate batch `(space, environment, operationId)` and canonical selection digest
including source/session/fingerprints/scopes/projects, **before source I/O**. Same digest returns
stored completed outcomes/IDs; changed digest yields operation_id_reused without reading files.
A partial exact retry processes only unfinished selectors. Stable per-item operation/revision
IDs are assigned/persisted before first submission; uncertain retries preserve identical bytes.
Batch completed_items_json carries a versioned strict envelope of compact selectors/outcomes,
remaining count and session totals; no request body. Item receipt keeps accepted source hash,
accepted content hash history, accepted revision, original scope and separate rejected hash.
Never advance accepted fingerprint/parent for malformed, secret or failed observations.

Detailed batch results expire under MEMORY_IMPORT_BATCH_RETENTION_MS; keep a bounded compact
operation-ID/digest reuse guard charged to existing receipt/permanent-metadata budgets. Retired
batch exact retry/status returns a typed not_found through existing MemoryRpcError, never
reruns import; changed digest still rejects. Source/item/suppression identity remains permanent.
Completed replay and status use the L1 durable callbacks in §5 before any reader call;
partial replay alone may read unfinished selectors after preflight closes its transaction.
Prove the compact codec maximum (MEMORY_COMPACT_RECEIPT_MAX_BYTES), or amend with the owning
contract phase before B; a fabricated expiry issue/action is not acceptable. Status reads only
persisted receipt and internal sync status, no source, no resume. New/pending/hub rejected/local
held are reported by syncStatus; an import item locally created is not proof of hub approval.
WP6 cancel stops future chunk calls; an admitted call may commit, with no rollback promise.

Apply re-reads a coherent snapshot, validates the session/profile/fingerprint and caller scope,
then commits selected items serially in independent transactions. File removal/unsupported
layout returns an issue; it never means GOAT forget. Source_changed leaves prior accepted item
untouched and requires re-preview. Git commit is an observation only; unchanged selected
content at a new HEAD remains noop.

### 4.3 Scope, provenance, suppression and M20

User explicitly selects user/project/thread scope. Project scope requires destination-local
ScopedProjectRef, live getProjectBinding permit, `resolveProjectKey(readinessSpace, project)`,
non-null matching scope key and captured binding.version. Recheck project existence/key/version
under the transaction; drift returns mapping_changed without receipt/head mutation. Current
remote URL, Codex applies_to.cwd, encoded Claude dirname and omo auto-agent cwd hash are hints
only. Thread scope requires a real authorized nondeleted ScopedThreadRef in the destination;
provider UUID/session IDs are never GOAT ThreadId. No binding change migrates old receipts.

Create MemoryPayload evidence `{origin: "import", importSourceId, messageIds: []}` and revision
assertionKind inference. Provenance is `{environmentId, importSource: {sourceId, format,
parserVersion, sourceLocator, sourceItemKey, sourceFingerprint, contentFingerprint,
sourceAliases, acceptedContentFingerprints, commitOid?}}` (`C/memory.ts:340–411`). Actual known
Codex/Claude provider can be recorded; omo uses importSource.format, not a fabricated driver.
Do not guess providerInstanceId/model/appVersion or populate sourceThread/watermark from a
provider transcript. Absolute source paths, raw headers and opaque foreign session values are
not shared. Links in imported text stay data; never execute system/persona or Markdown commands.

Read Sync readiness/bootstrap before SQL. Under the existing Store.transact, reauthorize
both grants after lock, recheck the committed Store binding/bootstrap fence (no Sync callback
or settings reload under lock), verify space/scope/binding, receipt/session CAS, tombstone/pending forget and source/content suppression;
reserve import metadata/session/local queue charges; persist source/item/batch outcomes and
ordinary local intent/outbox atomically. Source/process/network I/O finishes before SQL.
Use existing parent-aware service operation preparation, scanner and decider; do not call
public upsert followed by a separate receipt save. After commit, existing worker/sync owns
submission, hub-only admission, canonical settlement and indexing. No second SQL connection,
ManagedRuntime, generation worker, hub or import network protocol.

| Atomic condition / activation                                                                                       | Required result                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source key, accepted historical content hash, confirmed alias or target tombstone suppressed; pending forget exists | Suppressed metadata-only result (or hold/reject for pending forget), no readable payload, revision resurrection or content outbox. Fresh suppressed alias metadata itself needs bounded local/hub admission.                                                                                                                                                                               |
| Same source receipt mapped to different scope                                                                       | rejected + mapping_changed; keep accepted scope/revision. Explicit re-remember is a separate operation; never clear suppression.                                                                                                                                                                                                                                                           |
| Same source hash and live accepted/pending item                                                                     | noop; no new identity, history, FTS work or session charge. Return current settlement state.                                                                                                                                                                                                                                                                                               |
| New source, exact same live body/scope/assertion, single nonquarantined head                                        | aliased; one memory, bounded provenance-delta revision with that head as parent; full canonical lineage union on approval, bounded new alias admission, both receipts updated after settlement.                                                                                                                                                                                            |
| New source without copy                                                                                             | created local intent with stable memory/operation/revision identity, pendingSync until hub settles.                                                                                                                                                                                                                                                                                        |
| Same source changed                                                                                                 | revised local intent, same MemoryId, revision.parents = last accepted receipt revision, expectedHeads = current heads captured/rechecked under the local transaction; manual/remote divergence follows normal DAG/hub frontier logic, never adopts the newest head as its parent. If the accepted base is compacted, retain the intent for explicit review rather than fabricate ancestry. |
| Rejected raw/input/scanner/capacity                                                                                 | Bounded metadata-only issue, capacity dimension/current/limit/reclaimable where applicable. No accepted parent mutation; pre-admission refusal may allocate no row.                                                                                                                                                                                                                        |
| Hub receives any local import, even originating on hub                                                              | HubService admission through 030 §4 admitHubOperationTx; no import bypass or hub-local precommit called approval. Hub rejection settles the same immutable intent/receipt.                                                                                                                                                                                                                 |
| Replica receives hub-approved alias/upsert/forget                                                                   | 030 canonical settlement transaction persists receipt, union keys and cursor, without local admission/scanner veto. Scanner disagreement/FTS brake defers local exposure/index on canonical refs, no duplicate body queue.                                                                                                                                                                 |

The shared MemoryService hub-admission preparation must also run the indexed import source/
content suppression lookup under HubService's transaction, immediately before the pure decider.
A delayed offline proposal created before another environment's forget must be rejected at the
hub even if its local replica has not received that forget yet. This is an L1 MemoryService
change used by the existing 030 admitHubOperationTx path, not only a check in the coordinator.
approvedReplica settlement preserves the already admitted result without rerunning that check;
local read fences still honor a later tombstone.

**WP3 sync interaction decision (current behavior plus WP5 additions).** Imported GOAT memories are ordinary inference revisions in the shared space: H and member A/B submit through the same local pending path, then hub admission and ACK/pull propagate accepted body and full safe `revision.provenance.importSource`. There is no local-only/provider-format sync exclusion. Provider original files, server-local registration/session/batch receipts and absolute roots do not propagate. Thread/project read authorization still controls exposure; sync acceptance alone does not authorize inference delivery.

Forget propagates delete-wins plus source/content suppression through ordinary forget/expansion operations and checkpoint suppressions. L1 adds complete lifetime lineage to checkpoint before import activation. The source-key tuple is **environmentId + sourceId + sourceItemKey** (C/memory.ts:340–345): another device does not automatically share a local registration UUID. The shared content suppression key includes **scope + assertionKind + exact content fingerprint**. Thus the same original body selected with the same scope/inference on B is suppressed even through a new registration; changed content at the original registered key remains suppressed. A different device's changed/paraphrased file under a new key or different scope is not claimed as semantic erasure. No new registration/root alias may bypass an existing local source tuple; ordinary re-preview/source-change/rename exact-copy tests prove the promised boundary.

Changed imports use the accepted parent; concurrent manual/remote edits produce normal conflict. WP3's first-observer resolver/lease/recovery/revert remains authoritative and produces **execution provenance**, not copied import provenance (SyncService:675–684). Import lineage stays attached to the memory identity independently of current revision provenance, so resolve/manual edit/revert/compaction cannot lose historical source suppression. Imported assertions stay untrusted inference; resolution does not execute provider persona/instructions. An offline proposal created before remote forget is checked against hub suppression before the decider; pending/rejected deltas never become canonical lineage. Approved replicas persist canonical data/cursor and defer only exposure/FTS, even at local capacity.

WP5 owns a permanent, body-free **import lineage ledger**, separate from revision provenance
and origin-local receipts. One record per distinct `(memorySpaceId, memoryId, kind, canonical
key)` stores either accepted `MemorySourceKey` (including aliases) or
`MemoryContentSuppression` (historical content fingerprint with scope/assertion kind).
No title/body/absolute path/raw source or external session ID is stored. The existing
MemoryProvenance arrays each cap at 100 (`C/memory.ts:361–375`); they carry only the bounded
accepted delta on an operation, never the complete lifetime history. Hub approval atomically
unions that delta into lineage; ACK/pull settlement does the same on replicas. Rejected or
pending proposals never become accepted lineage. Generic edits, resolve, receipt expiry and
compaction neither rewrite nor truncate the ledger. Empty import deltas preserve it.

Each memory admits at most **1,000 distinct lineage records total** (aliases plus content
fingerprints). Duplicates do not consume another slot; a proposal exceeding the remaining
slots is rejected atomically as typed capacity_exceeded without advancing its accepted
receipt/parent. §4.4 fixes a 32-MiB global lineage allocation within M19 permanent metadata.
No oldest-entry eviction, lossy latest-provenance reconstruction or dropped hash is allowed.
Checkpoint carries every live and forgotten ledger record via §5's L1-0 contract extension;
WP5 L1 extends the now-merged WP3 producer/consumer and compactor; 030 remains read-only. Publication at fixed S must cover the complete ledger before
history deletion. Bootstrap atomically installs it before exposing memories/materializing intents.

Forget gathers the complete lineage before payload purge and promotes its entire alias/content
union to permanent suppression through WP3's base/fragment pipeline, retaining lineage itself
without a body as evidence against re-import. Store.firstForgetReservation/reservationForRevisions
(:5292–5328) and Quota withAdmission (:116–170) extend their thread-exclusion reserve with this
union; reserve suppression duplication at lineage admission so a full budget cannot prevent
first forget. Origin-local receipts and revision arrays are not the source of truth.
Thread sourceExclusions retain the true thread/watermark/message codec (`C/memory.ts:349–354`);
provider sources use MemorySourceKey. Indexed suppression remains in memory_import_keys with
Store.readSuppressions / suppression codec canonical key encoding. Lineage uses its own per-memory table (§5), avoiding
that table's space-global key collision and tombstone-bound suppression codec.
Permanent lineage/suppression survive restart, checkpoint install and actual compaction.
Local rejected aliases cannot erase either. A registered alias blocks changed source content
as well as exact historical-copy hashes, even while original provider text still exists.

If the union exceeds the tombstone's 100-entry wire cap (`C/memory.ts:440–452`), consume WP3's
base-deletion plus body-free forgetExpansion fragments with distinct immutable IDs/digests and
separate pending/rejected/accepted receipts. Preserve reserved first forget and immediate read
fence; excess metadata admission refusal cannot undo base deletion. Re-import consults retained lineage plus the immediate forget fence during pending expansion,
never only the first fragment or expired local receipts. Approved
replica union is not refused by full local alias/key/work budgets. No semantic forget or source
file deletion claim; source-key and exact-content guarantees are the defined boundary.

### 4.4 M19 budgets and growth measurement

Use exported constants, not parser-specific substitutes (`C/memory.ts:117–128,147`):

| Dimension                             | Ceiling / accounting                                                                                                                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Item body / encoded payload           | 16,384 / 65,536 UTF-8 bytes; oversize whole item rejects.                                                                                                                                             |
| Source snapshot / preview / apply     | 8,388,608 bytes / 128 items / 32 items, plus 64-KiB response framing and reader limits in §4.1.                                                                                                       |
| Session                               | 128 new items / 2,097,152 accepted body bytes across chunks; changed replacement also charges retained history/body growth. NOOP does not charge twice.                                               |
| Import live                           | 10,000 items / 67,108,864 body bytes, alongside general user/project/thread/environment/space/live limits.                                                                                            |
| Cumulative identity / alias / content | 50,000 source items / 100,000 aliases / 100,000 content digests; key <=512 and digest <=64 UTF-8 bytes. Count registrations, rejected identities and suppressed aliases where they allocate metadata. |
| Staging / detailed observations       | Shared checkpoint staging 128 MiB; derived cache TTL 10 minutes; batch details 30 days, compact replay guard retained. No raw files indexed or archived.                                              |

Lineage has a global **33,554,432-byte (32-MiB)** canonical encoded-record sub-budget,
counted together with identities, suppression, compact receipts and reserved first-forget
metadata inside `MEMORY_PERMANENT_METADATA_MAX_BYTES = 134,217,728` (128 MiB), never an extra
pool. Count the complete strict record encoding, not hash length estimates. Per-memory
1,000-record, global lineage byte, aggregate M19 permanent byte, and checkpoint retained-page/
next-publication reservation checks run in the same admission transaction at origin and hub.
Exhaustion refuses only additional imports with typed capacity_exceeded, preserving all
accepted lineage. Ordinary edits retain lineage; approved replica restores the full canonical
union without local re-admission, and reserved forget remains possible. Permanent suppression
copies are charged/reserved separately; lineage is not reclaimed when forgotten.

Extend the existing **072-derived accounting**, not a new full-scan path: 075 installs one INSERT, one UPDATE and one DELETE lineage trigger for global lineage encoded bytes, `_hub_global` hub_metadata, per-space hub_snapshot_bytes/rows/generation and first-forget reserve deltas. Every producer-input mutation invalidates consumed staging credit in the same transaction (072:393–407; Store:8440–8467). Add lineage to Store.usage/logicalBytes/usageForHub/readHubUsageTx inventory and capacity/status codecs, plus actual checkpointBound proof for maximal record encoding/escaping/page overhead. Existing suppression counters must not double-charge restored union or reserved metadata. On equality/+1 test old published/pinned pages plus the next complete checkpoint; a 32-MiB ledger can be refused earlier by aggregate permanent/checkpoint ceilings. 32 MiB is a logical sub-budget, not a physical SQLite/FTS size guarantee. No new corpus index, per-item dbstat scan or raw-file archive; requirement 7 requires same-head off-host growth evidence, not just constants. Migration 076 then replaces the legacy worst-case checkpoint charge with synchronous keyed accounting using the same literal-record encoder as publication, charges private import staging, and shares completed settled noop results while retaining each 30-day replay guard. Reservation conservatively includes every retained body-free revision identity. Publication reads only heads, retained resolution inputs and the existing dependency set; its literal records are a subset of the reserved inventory. This preserves bounded publication reads without cross-memory reservation invalidation; bodies remain governed by retention.

Minimal accounting model: one body-free lineage table, its primary key and at most one
justified lookup index; exactly three delta triggers on that table, combining M19 bytes,
snapshot rows/bytes/generation and reserve updates in each trigger. Reuse memory_quota_counters
for one global lineage-byte sub-counter and memory_identity_ledger for first-forget reserve;
use a bounded primary-key count for the 1,000-record limit. No separate per-memory counter,
worker, scan-per-item dbstat sampler, lineage history ring or additional physical reserve pool.
Duplicate union uses insert-on-conflict-do-nothing: zero row delta means zero counter, generation
or checkpoint-credit mutation. Restore/rollback tests cover the trigger deltas and reserve.

The 1,000 / 32-MiB values are conservative admission ceilings, not measured workload needs or
guaranteed usable capacity. They are upper bounds within existing 128-MiB M19 metadata,
including first-forget reserve; retained/new checkpoint charges also face their existing
separate ceilings. **128 MiB is not a new reserve allocation**. A simpler latest-provenance-only or 100-entry eviction model loses old
keys after resolve/compaction and violates forget. Reusing memory_import_keys as the live ledger
would require changing its tombstone-bound space-global identity; the small separate table
avoids that wider codec change. Retaining bounded body-free lineage plus suppression duplicates
is deliberate for re-import prevention; measure both and refuse new imports early. Requirement 7
is unproven until off-host DB/WAL/FTS growth is measured on the same integrated SHA. A 27.3-GB
recall corpus/index is explicitly outside this design: no provider corpus index or archive.

WP5's Store/Quota lane implements missing import-specific counters and receipt/session
reservations on top of current quota.commit/withAdmission. Local allocations have explicit
admission; hub independently enforces space-global live/history/permanent metadata plus forget
reserve. approvedReplica never reruns those admission checks. Capacity failure returns the
actual dimension, not an empty success or silently truncated batch. CAS prevents simultaneous
imports spending the same remaining quota. Sequential item commits preserve partial outcomes.

Reuse MemoryQuotaService.recordStorageSample/readStorageGrowth and MemoryFtsMaintenance:
measure before/after admitted import and after existing worker drain in CI, with logical live,
history, permanent metadata, FTS indexed/allocated, DB/freelist and WAL metrics where available;
reuse bounded daily samples and 1/7/30-day deltas. No per-item physical SQLite scan or DB-wide
VACUUM/auto_vacuum/max_page_count. FTS warning/brake/resume follows WP2 contracts (96/128/96 MiB),
never canonical admission refusal on replica. Missing dbstat/WAL/baseline stays unavailable,
not zero growth. Repeated noop must show unchanged logical payload/revision/index counts;
changed import shows bounded history, not an additional live identity. Source bytes never
enter FTS/export/report, and forgotten text cannot return through rebuild/held caches.

### Requirement 7 fixed physical-growth workload (A5; future NOT RUN)

L1 owns a deterministic synthetic harness in MemoryImport.test.ts using existing samplers,
maintenance and compactor; coordinator owns same-SHA packaged off-host evidence (M19j).
Run only on **macmini-cf**, isolated synthetic homes/DB/provider repos at exact integrated SHA.
Seed H/A with 16 distinct 4-KiB UTF-8 bodies in one scope, four source-key aliases per body
(64 aliases total). Fix bytes, parser versions and clock seed in the fixture. Settle real hub
ACK/pull and drain existing memory/index/maintenance workers before baseline T0.

1. Run 64 identical import rounds (all 64 aliases; two serial 32-item apply chunks per round) and drain after each; sample at 0/16/32/48/64.
   Noop must add **0** canonical identities, body/revision rows/bytes, lineage or FTS indexed
   rows/bytes; transient/session receipt metadata stays within admitted limits. A completed,
   fully settled noop stores its result once and later identical results share it by
   content-addressed reference; only the per-operation replay guard below may grow.
2. Run 16 changed rounds for the same identities/aliases, replacing each body with another
   deterministic 4-KiB body once per round, in two serial 32-item chunks; settle/drain each round and sample every four.
   Exactly 16 live identities remain, history never exceeds configured admitted ceiling;
   equality/+1 refusal is atomic and reports actual dimension. No second raw corpus copy.
3. Forget all 16, settle/drain, then run 32 rebuild cycles with **no new import**. Each cycle
   advances synthetic clock by `max(configured receipt/history/checkpoint retention horizons)
   - 1 ms`, awaits actual maintenance/compactor completion and index drain, rebuilds the
     existing derived index and drains again. Pin a checkpoint only in the separate reservation
     case; this plateau case has no pins/active readers. Sample every cycle. Search/read/history/
     resolve inputs/rebuild exposure of forgotten bodies is **0** throughout; suppression/lineage
     accounting survives where required. No sleeps or wall-clock polling.

Record SHA, package digest/version, seed, stage/iteration/clock, retention values, drain milestone,
identity/body/revision/lineage/suppression/receipt counts and encoded bytes, quota/admitted
ceilings, FTS indexed rows/bytes and allocated pages/bytes, DB page_size/page_count/freelist_count/
allocated and used bytes, WAL bytes and checkpoint busy/log/checkpointed frames, retained/pinned
checkpoint bytes. Record sample availability explicitly, never missing-as-zero.
Use existing sampling for each phase/bounded sample point, not per-item dbstat scans.

Control WAL with the same explicit PASSIVE checkpoint at each drained sample; require busy=0
and no readers. Compare reusable frames/allocated high-water mark, not file truncation.
For noops after warmup rounds 1–8 (samples 16/32/48/64), and rebuild after warmup
cycles 1–8 (samples 9–32), DB used pages and FTS allocated pages must plateau (max-min ≤ a predeclared 1-MiB allowance converted to pages by recorded page_size);
DB allocated/WAL high-water growth may be bounded by the measured warmup high-water plus the same fixed 1 MiB (WAL frame overhead
recorded separately), not a fresh allowance per cycle. Freeze this allowance before execution;
do not derive a larger bound from a leaking run. Reject a sustained per-cycle rise. Permanent forget metadata
must equal the bounded logical suppression/reserve inventory, no duplicate growth on rebuild.
The one exception to the noop rise rule is the per-operation replay guard that 30-day exact
replay requires for each new operationId (operation ID, request digest, original expiry, result
reference). It is charged to the existing dedup count and metadata caps, expires with the
original 30-day retention and is reported separately as guard count and encoded bytes. Result
bodies, FTS and canonical history still add 0, and the guards stay inside the same fixed 1-MiB
allowance (user decision, 2026-10-15). No pre-allocated receipt arena.
Changed-history used bytes are bounded by admitted canonical/history/metadata bytes plus
recorded index/schema allocation and the same fixed 1-MiB allocator allowance;
retention drains cannot leave an ever-growing uncharged history. No VACUUM/file-shrink criterion.
Unavailable DB/FTS/WAL/retention metrics or nonzero busy leave the corresponding physical claim
**미증명**, regardless of logical quota or CI success.

L1's source command is the existing server focused test runner with direct target
`GOAT_MEMORY_GROWTH=1 vp test run src/memory/MemoryImport.growth.test.ts` from apps/server on macmini-cf; CI runs it in `goat-test-memory-growth` (source proof only).
For packaged proof, coordinator owns a NEW temporary packaged RPC harness outside the repo:
`node /tmp/wp5-growth-<SHA>/run.mjs --manifest /tmp/wp5-growth-<SHA>/manifest.json`
(planned, NOT RUN, file does not exist yet). Before execution it records the actual same-SHA
packaging command/artifact and installed executable invocation in that manifest; runs the same fixed action workload
through the packaged server's real RPC with a synthetic fixture harness, and archives
`wp5-growth-<SHA>/manifest.json`, `samples.csv`, `exposure.json`, `drains.json` and value-free
execution logs outside the repo. The manifest contains exact command, SHA, package digest and
source/packaged workload equivalence. If that harness/invocation is not implemented and run,
M19j packaged evidence remains NOT RUN; a source test receipt cannot substitute for it.

## 5. Disjoint lanes, file ownership and integration order

This is a future implementation map, **not authorization to edit source in this P run**.
`S/` and `C/` use §3 aliases. Every listed file has one WP5 owner; predecessor changes finish
first. No parser edits a shared service/contract and no integration lane rewrites parser files.

| Lane                     | Exact owned files (NEW / MODIFY)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Delivered boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L1 durable import seam   | MODIFY S/memory/MemoryStore.ts, MemoryService.ts, MemoryQuotaService.ts and their three .test.ts files; WP5-owned post-WP4 extensions: S/memory/MemoryCompactor.ts, MemoryCompactor.test.ts, MemoryHubService.ts, MemoryHubService.test.ts, MemorySyncService.ts, MemorySyncService.test.ts; S/persistence/Migrations.ts, S/persistence/reconcileGoatMigrationIds.ts and its .test.ts; MODIFY S/persistence/Migrations/055_OrchestrationV2.test.ts, 070_ProjectionTurnItemRequestIndex.test.ts, 074_MemoryTaskGrantCeiling.test.ts (migration-list/count/renumber expectations); MODIFY (v1 codec/strict-lineage tests, no version change) S/memory/MemoryHubClient.ts and its .test.ts, MemoryHubHttp.ts and its .test.ts; MODIFY MemoryCheckpointBound.ts (only if the measured bound needs amendment); MemoryHubScenarios.test.ts, MemoryHubSyncScenarios.test.ts; NEW S/persistence/Migrations/075_MemoryImportLineage.ts and its .test.ts (confirmed next-free after WP4 074; register stable MemoryImportLineage); NEW S/memory/imports/MemoryImportTypes.ts, S/memory/MemoryImport.test.ts. | Strict private receipt/session codecs, indexed dedup/suppression lookup, CAS and quota reservation; importProvider interface/service delegation; parent-aware intents, settlement metadata and forget extraction/fragments. No reader I/O or second transaction owner.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| L2 read-only reader      | NEW S/memory/imports/MemoryImportReader.ts, MemoryImportReader.test.ts, MemoryImportFixtures.fixture.ts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Trusted root registration references, descriptor/Git snapshots, hard ceilings, read-only fault fixtures. Consumes L1 types/ports; shared synthetic fixture builder is owned here, not modified by parser lanes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| L3 deterministic parsers | NEW S/memory/imports/CodexMemoryImporter.ts, CodexMemoryImporter.test.ts, ClaudeMemoryImporter.ts, ClaudeMemoryImporter.test.ts, OmoMemoryImporter.ts, OmoMemoryImporter.test.ts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Pure supported-profile parsers, routing/evidence exclusions, stable item keys and canonical candidates. No SQL/process/provider configuration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| L4 coordinator           | NEW S/memory/imports/ProviderMemoryImport.ts, ProviderMemoryImport.test.ts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Four action orchestration, raw/title/output scans, profile/session/source-change fences, per-item selection and errors, dependency calls to L1 without direct SQL. L1 owns the new real-store MemoryImport.test.ts and imports this module for integrated cases.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| L5 server activation     | L5-early: MODIFY only S/environment/ServerEnvironment.ts, ServerEnvironment.test.ts. L5-late: MODIFY those same files plus C/rpc.ts, rpc.test.ts; S/ws.ts, ws.test.ts; S/auth/RpcAuthorization.ts, RpcAuthorization.test.ts; S/server.ts, server.memoryComposition.test.ts; NEW S/server.memoryImportGraph.test.ts; MODIFY packages/client-runtime/src/rpc/protocol.ts and packages/client-runtime/src/rpc/protocol.test.ts (actual transport group and its behavior test).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Same L5 owner, two slices, no new lane. Early is one of the first WP5 commits on WP4-final, with or immediately after L1-0: publish capabilities.memory.protocolVersion=1 for installed core16, importProvider omitted/false; preserve existing hub flag/version conditions. No new service/registry/RPC/contract field. Pin that SHA for WP6’s WP4-based work; WP6 does not edit these files. Late installs staged import alongside core14+owner2 in server authorization/ws and actual client protocol; enable importProvider=true only after route/client group/runtime/reader cleanup readiness. Reuse guarded command, thin facade, repeatable dual permit and auth-preserving errors. Reader failure preserves core advertisement/core16/relay. No command rewrite, MCP import tool or UI. |

### Focused test ownership after WP4 (planned, NOT RUN)

All paths below use S/C aliases; bare filenames in an S/memory list have that prefix.
MODIFY means lane-owned writes; regression-only files are read/run without taking source ownership.
Existing imported-module consumers were found by source import search at c0023a846; repeat that
search against the final implementation diff before execution. Commands are future macmini-cf
`vp test run <explicit files>` from the matching package (not run as verifier in this P task).
No repo-wide suite is assigned to a lane; PR CI owns full coverage.

| Lane / order                          | Focused tests and ownership                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1-0 first, same L1 owner             | MODIFY C/memory.test.ts; regression C/rpc.test.ts, clientRpcPermissions.test.ts, environment.test.ts and packages/provider-core/src/server/memoryContext.test.ts. Freeze strict lineage/error/capacity codecs before consumers. L5 owns later rpc.test.ts edits, not concurrent with L1-0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| L1 after L1-0                         | MODIFY S/memory/{MemoryStore,MemoryService,MemoryQuotaService,MemoryCompactor,MemoryHubService,MemorySyncService,MemoryHubClient,MemoryHubHttp,MemoryHubScenarios,MemoryHubSyncScenarios}.test.ts, S/persistence/reconcileGoatMigrationIds.test.ts, S/persistence/Migrations/{055_OrchestrationV2,070_ProjectionTurnItemRequestIndex,074_MemoryTaskGrantCeiling}.test.ts; NEW 075_MemoryImportLineage.test.ts and S/memory/MemoryImport.test.ts. The 074 test keeps two cases apart: the normal 073→074→075 upgrade, whose expected applied lists must account for 075, and the old ceiling-ledger case, which must fail with typed BadState while task/dispatch grants and the ledger stay unchanged; keep both task/dispatch values. Regression consumers: S/memory/{MemoryDecider,MemoryFtsMaintenance,MemoryHubAuth,MemoryWorker,MemorySnapshot,MemoryOwnerSourceReader}.test.ts and S/persistence/Migrations/073_MemorySearchCounters.test.ts. Preserve bounded search/backfill readiness, source relay and reserved forget. Final MemoryImport.test.ts integration cases wait for L4.                                                                                                                                                                                                                                                                                                                                                                             |
| L2 after L1 types freeze              | NEW S/memory/imports/MemoryImportReader.test.ts (includes synthetic snapshot/process/cleanup fixtures). L2 alone owns shared MemoryImportFixtures.fixture.ts; L3/L4 consume it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| L3 after L1 types + L2 fixture freeze | NEW S/memory/imports/{CodexMemoryImporter,ClaudeMemoryImporter,OmoMemoryImporter}.test.ts. Pure parsers; three profiles, no settings/CLI/provider-home calls.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| L4 M3, contract-first                 | NEW S/memory/imports/ProviderMemoryImport.test.ts may start with mock ports once contracts freeze; completion and real Store integration wait for L1/L2/L3. Regression L1-owned S/memory/MemoryImport.test.ts after L4 integration, edited only by L1. Durable restart/replay, F3-1 trusted environmentId and F3-2 retired-after-preflight guard remain mandatory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| L5-early M1 / L5-late M4              | Early MODIFY only S/environment/ServerEnvironment.test.ts with its descriptor source; verify core-enabled/import-disabled through actual client gate in packages/client-runtime/src/state/memory.ts:254–260 and C/environment.ts:339–340. Late MODIFY C/rpc.test.ts, S/ws.test.ts, S/auth/RpcAuthorization.test.ts, S/environment/ServerEnvironment.test.ts, S/server.memoryComposition.test.ts, packages/client-runtime/src/rpc/protocol.test.ts; NEW S/server.memoryImportGraph.test.ts. Regression-only packages/client-runtime/src/{rpc/client,state/memory,state/commandPermissions}.test.ts, C/clientRpcPermissions.test.ts, S/memory/MemoryAccess.test.ts, S/server.memorySnapshotGraph.test.ts, S/server.memorySourceReadGraph.test.ts, S/serverSettings.memoryOwner.test.ts, S/mcp/toolkits/memory/handlers.test.ts, S/mcp/McpSessionRegistry.test.ts, S/orchestration-v2/{ProviderSessionManager,ProviderTurnStartService,ProviderTurnStartService.memory}.test.ts, S/orchestration-v2/Adapters/CodexAdapterV2.test.ts, S/provider/{ProviderInstanceRegistryHydration,ProviderOrchestrationAdapterInfrastructure}.test.ts, S/serverRuntimeStartup.autoPull.test.ts, S/ws.memoryGrantCeiling.test.ts, S/scheduledTasks/ScheduledTaskService.memoryGrantCeiling.test.ts and S/observability/RpcInstrumentation.test.ts. These protect changed graph/proxy/permission consumers, public task ceilings and authorization middleware; no provider adapter rewrite. |

For S/observability/DefectReporter.test.ts, S/orchestration-v2/boundedSnapshotTransport.test.ts
and apps/server/integration/transferBudgetV2.integration.test.ts, include them in L5 regression-only
focused execution if the final diff changes ws server options/subscription exports or transport
behavior; otherwise assign them to PR CI and record that exclusion reason. They directly consume
those existing transport seams; unchanged transport does not require unrelated focused expansion.

L5-early proves core available/import unavailable through the actual client gate (with an enabled,
prepared connection and valid grants), independently of reader readiness. L5-late’s integrated pass
asserts before/after groups (16→17): final protocol.test.ts requires core14+owner2+import1=17,
import present and all existing core/owner methods retained. It also checks live revoke of either import grant
while waiting and after the writer lock, and the existing guarded command through the **actual**
protocol client, not its staged type cast. Run discover/preview/apply/status, capability loss,
reader-cleanup failure with core16/source relay still usable, and singleton Snapshot proxy / owner
policy identity. Import actions can use write+filesystem read without memory:read; do not widen
that grant to source relay. No body/raw import provenance reaches the MCP renderer.
WP4's historical remote receipts (including compose2 retention failures, client dependency gaps
and provider joined c-5 gaps) are not fresh c-6 proof; preserve those as coordinator-owned gates
and inspect exact-head results before claiming closure. This plan assigns no WP4 repair scope.

### L1-0 — WP5-owned contract extension before implementation consumers

L1 owns a separate first contract commit modifying `C/memory.ts` and `C/memory.test.ts`
(the WP1-owned files are extended by WP5 here; no 010/030 plan edits). Add strict
`MemoryImportLineageRecord` union: common `memorySpaceId`, `memoryId`, then
`{ kind: "sourceKey", sourceKey: MemorySourceKey }` or
`{ kind: "content", content: MemoryContentSuppression }`. It has no deleteOperationId:
live lineage is not a suppression record. Add required `importLineage` array to
MemoryHubCheckpointPage, counting these records within the existing 100-record/262,144-byte
page envelope. Extend page codecs, whole-checkpoint validation, identity/scope consistency,
canonical duplicate detection and stable record ordering/pagination across all pages.
Add `MEMORY_IMPORT_LINEAGE_MAX_RECORDS_PER_MEMORY = 1000` and
`MEMORY_IMPORT_LINEAGE_MAX_BYTES = 33554432`, plus `import_lineage_records` and
`import_lineage_bytes` capacity dimensions **appended at the end** of the existing
MemoryCapacityDimension enum (never inserted or reordered), and their strict MemoryCapacityExceeded codecs/tests;
retain existing import DTO/error shape. Unknown kind/missing arm rejects strictly.
All peers need the new checkpoint codec before import activation; no silent empty-default fallback.

**Hub protocol decision — 결정됨: v1 확장 (Jun, 2026-10-14).** WP1–WP6는 함께
merge·출시한다. 미출시 checkpoint codec을 일괄 확장하며 새 hub-v2 상수나 분기는 없다.

| Confirmed premise                       | Decision / safety                                                                                                                                                                                                            | Scope                                                                                                                        |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| WP1–WP6 stack merges and ships together | **결정됨: v1 확장**. Every shipped peer understands required lineage; missing lineage strictly rejects. Intermediate development installs/snapshots undergo isolated upgrade and complete regeneration before participation. | L1 required checkpoint codec/producer/install/validation, Store/Service/Quota/Compactor/tests; L5 publishes actual ready v1. |

전제(스택은 함께 merge·출시)가 깨지면 import 활성화 전에 다시 계획한다.
`MEMORY_PROTOCOL_VERSION` (C/memory.ts:90), operation/storage literals (:504,:1155),
hub common envelope and join literals (:2364,:2367), Client/Sync predicates and HTTP
ready type/value (MemoryHubHttp.ts:192,269) all remain **1**; no new version constant.
Required `importLineage` is added specifically to `MemoryHubCheckpointPage` beside
`suppressions` before `nextCursor` (current C/memory.ts:2315–2363), included in its
mixed-record count/filter and strict encoded-byte bound. Extend producer ordering,
pagination, whole-checkpoint validation, stage/install/complete and receive codecs together.
No optional decoder/empty-default fallback, parallel compatibility shim, digest or canonical-history
rewrite. Regenerate isolated intermediate snapshots from complete canonical history;
incomplete history refuses activation. Compaction/exposure waits for complete lineage publication/install.

Capacity dimensions are stored as ordinal bytes by MemoryStore.ts:392,479: append the two
new values after **all** existing values. L1 freezes binary compact-receipt v1/v2 fixtures
(the binary codec versions, not hub protocol branches), proving unchanged decoded dimension,
current/limit/reclaimable and original bytes/re-encoding, including every pre-existing dimension.
New dimensions round-trip through contracts, Store receipt encoder/decoder, Quota capacity
creation and status/RPC consumers without changing import DTOs.

### L1-0 assembly contract — acyclic invocation environment (A2)

Choose the callback coordinator at the final assembly boundary; no Store readiness rewrite.
The smallest change reuses actual Sync readiness/status and Service binding/commit logic.
Construction DAG (arrows mean requires): `Quota → Store`; `Service → Store/Quota/identity/SQL/resolver`;
`Hub → Service`; `Sync → Service/Hub/Client/committed settings/runtime/ownerReader`;
`ImportRuntime → Service/Sync/Reader/parsers`; `RPC handlers → Service + ImportRuntime`.
WP4 also has `Snapshot → Sync → TextGeneration → Registry → Codex adapter → Snapshot`.
Do not add that cycle as direct Layer requirements: keep MemorySnapshotBinding.provide's
proxy → registry hydration → actual Snapshot → bind → application sequence, and the same
proxy captured by Codex/other adapters. OwnerSourceReadPolicyBinding feeds the existing
MemorySyncRuntime; SourceReadBinding binds Sync.readSource before Sync.start. Neither binding
is an import runtime registry, and import must not capture raw thread-reader authority.
Service creation does **not** acquire ImportRuntime/Sync. Its facade acquires the runtime only
when invoked, via an explicit Effect environment; no lazy global registry or hidden context lookup.

L1 owns these non-wire types in MemoryImportTypes; L4 implements the factory, L5 connects it:

```ts
type SyncError = Hub.MemoryHubServiceError; // actual Sync alias; no native Error
type ImportError = MemoryServiceError | M.MemoryImportRpcError | M.MemoryRpcError;
// Existing MemoryRpcError carries not_found for absent/retired detailed receipts.
type ImportAddress = {
  memorySpaceId: M.MemorySpaceId;
  environmentId: M.EnvironmentId;
};
type ImportSourceAddress = ImportAddress & { sourceId: M.MemoryImportSourceId };
type ImportBatchAddress = ImportAddress & { operationId: M.MemoryOperationId };
type ImportSlot = {
  format: M.MemoryImportFormat;
  rootSlot: string; // immutable trusted server slot ID, never caller path
  selection: string | null; // bounded Claude directory/omo agent; null otherwise
};
type ImportRegistrationLookup = ImportAddress &
  ({ by: "source"; sourceId: M.MemoryImportSourceId } | { by: "slot"; slot: ImportSlot });
type ImportBatchPreflight =
  | { kind: "new" }
  | { kind: "partial"; batch: ImportBatch; receipt: M.MemoryImportReceipt }
  | { kind: "completed"; receipt: M.MemoryImportReceipt }
  | { kind: "retired" };
type ImportPorts = {
  readRegistration: (
    input: ImportRegistrationLookup,
    permit: Permit,
  ) => Effect.Effect<ImportRegistration | undefined, MemoryServiceError, never>;
  saveRegistration: (
    input: ImportAddress & {
      next: ImportRegistration;
      expectedVersion: number | null;
    },
    permit: Permit,
  ) => Effect.Effect<ImportRegistration, MemoryServiceError, never>;
  preflightBatch: (
    input: ImportBatchAddress & { selectionDigest: string },
    permit: Permit,
  ) => Effect.Effect<ImportBatchPreflight, MemoryServiceError | M.MemoryImportRpcError, never>;
  readReceipt: (
    input: ImportBatchAddress,
    permit: Permit,
  ) => Effect.Effect<M.MemoryImportReceipt, MemoryServiceError | M.MemoryRpcError, never>;
  readItem: (
    input: ImportSourceAddress & { sourceItemKey: string },
    permit: Permit,
  ) => Effect.Effect<ImportItem | undefined, MemoryServiceError, never>;
  findMatch: (
    input: ImportAddress & {
      source: M.MemorySourceKey;
      content: M.MemoryContentSuppression;
    },
    permit: Permit,
  ) => Effect.Effect<ImportMatch, MemoryServiceError, never>;
  binding: (
    input: M.MemoryProjectBindingGetInput,
    permit: Permit,
  ) => Effect.Effect<M.MemoryProjectBinding, MemoryServiceError>;
  resolveProjectKey: (
    space: M.MemorySpaceId,
    project: M.ScopedProjectRef,
  ) => Effect.Effect<M.MemoryProjectKey | null, MemoryServiceError>;
  // Internal parent-aware operation preparation; never calls public importProvider.
  commit: (
    input: PreparedImportCommit,
    permit: Permit,
  ) => Effect.Effect<M.MemoryImportItemResult, MemoryServiceError>;
  readiness: () => Effect.Effect<LocalImportReadiness, SyncError>;
  requireBootstrap: (space: M.MemorySpaceId) => Effect.Effect<void, SyncError>;
  syncStatus: (
    input: M.MemorySyncStatusInput,
    permit: Permit,
  ) => Effect.Effect<M.MemorySyncStatus, SyncError>;
};
type ImportPrimitives = {
  uuid: () => string;
  now: () => Effect.Effect<number, never, never>;
  environmentId: M.EnvironmentId; // trusted, immutable; L5 reads ServerEnvironmentIdentity once
};
type ImportRuntimeShape = {
  run: (
    input: M.MemoryImportProviderInput,
    permit: Permit,
  ) => Effect.Effect<M.MemoryImportProviderResult, ImportError>;
};
// Context.Service<ProviderMemoryImportRuntime, ImportRuntimeShape>, owned by L1.
makeProviderMemoryImport: (
  ports: ImportPorts,
  reader: MemoryImportReaderShape,
  parsers: MemoryImportParsers,
  primitives: ImportPrimitives,
) => ImportRuntimeShape;
// Service facade public signature: R is deliberately explicit, not inferred away.
importProvider: (input: M.MemoryImportProviderInput, permit: Permit) =>
  Effect.Effect<M.MemoryImportProviderResult, ImportError, ProviderMemoryImportRuntime>;
```

Binding/syncStatus signatures above are the current service methods, not new instances.
The six durable callbacks are WP5 additions on that same L1 Service, not new services.
`PreparedImportCommit` is L1's bounded candidate + registration/session CAS and
parent-aware intent input, containing no source bytes/reader handle. `LocalImportReadiness`
is exactly the current `{memorySpaceId: M.MemorySpaceId | null; bootstrap: "unbound" | "staging" | "ready"}`.
The L1 facade yields ProviderMemoryImportRuntime then calls run; the factory closes over bound
callbacks, so run has R=never. L5 acquires the existing Service and Sync once after their layers,
binds binding/resolveProjectKey/commit and all six durable callbacks to that same Service
(which closes over the existing Store), and readiness/requireBootstrap/syncStatus to the same Sync,
passes UUID/clock primitives and the trusted environmentId (read once from the existing
ServerEnvironmentIdentity.getEnvironmentId, as server.ts:564–565 already does for the hub),
constructs one runtime and provides its tag to import RPC handlers at their call boundary.
Service's other callers and Sync.start need no import environment. No Layer dependency back-edge,
mutable global registry, second Store/Service/Sync or second managed runtime is permitted.
Known Sync failures map to safe import errors, unknown failures to value-free unavailable;
MemoryAccessError always retains auth identity. Readiness/status/reader calls run outside SQL.
commit internally uses the existing Store transaction journal with requireOuter discharge,
rechecks permit/binding after lock, and invokes only parent-aware intent preparation/commit.
No network I/O or settings reload inside SQL; committed settings and existing Sync own readiness
(WP3 rev 11f settings/SQL deadlock rule). L1-0 freezes this graph/signature before lane consumers.
L5's real layer composition case must run discover/preview/apply/status through this facade,
and preserve existing Sync.start with worker milestones; a mock-coordinator facade test is insufficient.

### L1-0 durable callback semantics (R2-1)

All six signatures above have explicit R=never. Each Service callback runs permit **after
lock** inside `store.transact(..., {requireOuter: true})`, validates the selected server
identity/address, invokes only the narrow Store Tx ports, and discharges Store.Transaction.
Store-only read/write errors stay narrow; Service adds MemoryAccessError without coercing it.
No callback loads settings, invokes Sync/network/Reader, opens another connection or recursively
calls importProvider. preflight completes and releases SQL before any source I/O. SQL-free
committed binding/readiness checks and final item CAS remain as specified in §4.3.

- readRegistration uses the unique `(space, environment, slot)` or sourceId lookup and returns
  the persisted full registration **including active session and version**. saveRegistration
  inserts only at expectedVersion=null/absent, or CAS-updates that version with version+1.
  It preserves sourceId/slot/history and charges the bounded source/session metadata atomically.
  Discover reads a known slot before generating a UUID; concurrent insert loser re-reads the
  winner. Preview reads source, scans metadata outside SQL, then saves the new session/profile/
  snapshot digest with captured version. CAS conflict is MemoryStoreConflict; re-read/re-preview,
  never overwrite another preview or reset accepted charges. Sessions remain durable on restart.
- preflightBatch reads batch/digest guard in the given address before source/session/reader
  work: missing → new; same digest detailed receipt → partial (remaining selectors and frozen
  IDs in ImportBatch) or completed; same digest compact-only guard → retired; **different
  digest, including a retired guard → MemoryImportRpcError operation_id_reused**. It never
  creates a receipt or advances counters. completed returns persisted IDs/outcomes directly;
  retired maps to existing MemoryRpcError not_found without reapplication. Partial returns
  only the stored unfinished selectors for source work. No current source availability is
  needed for status or completed replay; current authorization is still checked.
- readReceipt decodes the persisted MemoryImportReceipt for status, with no Reader/FS/Git
  or resumption. Absent/retired details fail existing MemoryRpcError not_found. Runtime combines
  it with syncStatus outside SQL to produce the existing status DTO; syncStatus is **not** an
  import receipt reader. readItem/findMatch support preview/outcome and precommit preparation
  only when needed; their results are advisory and commit rechecks under lock.

Factory action mapping is closed over its declared arguments only: discover = Reader slots →
readRegistration/saveRegistration; preview = readRegistration → Reader/parsers/scanner → optional
readItem/findMatch → saveRegistration CAS; apply = preflightBatch → completed/retired return or
readRegistration + Reader/parsers + optional item/match → commit; status = readReceipt + syncStatus.
The factory receives explicit primitives as its fourth argument: `ImportPrimitives =
{ uuid: () => string; now: () => Effect.Effect<number, never, never>; environmentId: M.EnvironmentId }`,
bound by L5 to server UUID/clock functions and the trusted local environment identity. Every
action builds its durable ImportAddress from `primitives.environmentId` and the request space,
including user-scope apply/status with no project or thread ref; the wire input never supplies
it, and neither Reader nor client may. Each durable Service callback rechecks that the address
environment equals the Service's own environment identity and fails the existing
MemoryStoreConflict `{code: "not_found"}` otherwise (no cross-environment receipt read).
Scanning/hashing are pure imported functions. No ambient Context, SQL
in Reader, second runtime or in-memory Map for durable state.
The existing explicit facade tag remains the only invocation environment.

Preflight is not a reservation and does not eliminate races: commitImportItemTx re-reads batch
and selection digest guard, registration/session version, unfinished selector and stable IDs
inside the **same final item transaction** as receipt/session/intent/outbox/quota. A concurrent
new batch winner fixes the digest; a loser must atomically fail operation_id_reused before
mutation even if it performed source I/O after a valid earlier preflight. Store represents
that race as existing MemoryStoreConflict `{code: "operation_id_reused"}` (MemoryStore.ts:36–41);
L4 maps only that conflict after rollback to MemoryImportRpcError operation_id_reused. The
final guard has one more branch: if the batch became a compact-only retired guard after a valid
partial preflight (existing retention retirement), the **same digest** fails existing
MemoryStoreConflict `{code: "not_found"}`, rolling back the current item Tx, and L4 maps it to
MemoryRpcError `{code: "not_found"}`; a different digest still fails operation_id_reused. A
retired guard is never treated as missing/new, and no session, receipt, intent, outbox or quota
is recreated. This keeps commit’s accepted MemoryServiceError channel and A1 auth identity
unchanged. Exact competitors return the persisted item result only while a detailed receipt
exists; no duplicate IDs/charges. Item-local Tx auth rollback remains
A1’s contract. No intermediate session/batch save may replace this atomic final CAS.

L1 migration creates `memory_import_lineage(space, memory_id, kind, key, record_json)` with
primary key `(space, memory_id, kind, key)`, strict record codec and encoded byte accounting.
Use the primary-key prefix for bounded per-memory count/forget reads (maximum 1,000 rows);
add at most one `(space, kind, key, memory_id)` lookup index for cross-memory exact matching,
only if the existing receipt/suppression lookup cannot serve that query. No FTS or JSON index.
Do not add a per-memory counter table or separate lineage database. **Migration decision: separate 075_MemoryImportLineage**, registered at the PR #192 integration layer, followed by 076_MemoryCheckpointAccounting. WP4 already registered 073_MemorySearchCounters and 074_MemoryTaskGrantCeiling; 074 covers both scheduled_tasks and remote_dispatches. Keep 071–074 source migrations read-only. 075 isolates permanent lineage/triggers and upgrades already-recorded-074 databases; no reapplication of existing ALTER TABLE statements. Recheck the ordinal before B if the integrated source changes; Registry-derived compatibility checks reject unreleased memory ledgers before any renumbering; they do not migrate old sandbox memory data. L1 registers the stable name `MemoryImportLineage` in `reconcileGoatMigrationIds.ts` (GOAT
migrations are identified by name, and an unregistered name is treated as upstream), with a
regressions that preserve existing rows on a normal restart and on applying 075 to a schema
matching the current registry. Old, unknown, or mismatched `Memory*` ledger entries must be
rejected with the dedicated typed BadState error before any schema, ledger, or body changes.
Do not move unreleased memory ledger entries to accommodate an upstream ordinal collision.
No legacy import lineage is backfilled by startup or migration. Incomplete approved import history refuses activation rather than claiming recovery; a schema matching the current registry may advance normally without renumbering recorded Memory migrations. Validate synthetic 071→072→073→074→075 databases, already-074 databases and upstream ordinal collision; never open an actual user DB. Intermediate unreleased dev DB rebuild is an operator step on an isolated copy, not a migration that erases suppression.
No provider corpus access or suppression deletion is part of migration.

The whole field chain is L1 accepted-operation delta → hub admission ledger transaction →
L1-extended MemoryCompactor/MemoryHubService checkpoint producer at fixed S → strict contracts
page encoder/decoder/validator → MemorySyncService receive and MemoryStore stage/complete
checkpoint transaction → matching/forget/Quota consumers. ACK/pull operations union accepted
deltas without a new operation arm; bounded current provenance remains usable by WP4 injection.
Compactor must preserve ledger while deleting revisions/receipts, include every ledger record
in publication sizing/reservation, and refuse publication if a complete snapshot cannot fit.
L1 owns corresponding producer/consumer/compactor real-SQL tests, including rollback, replay,
partial install and across-page >100 records. Client/HTTP/Sync codec tests exercise required-lineage rejection and complete v1 install;
existing version predicates, ready type/value and envelopes stay 1. H/A/B scenarios use this one protocol. L5 owns descriptor publication/composition (ServerEnvironment:311). C/environment.ts:101–108 already accepts hub versions and memory {protocolVersion,hub?,importProvider?}, so no environment contract file change is assigned. L5 never edits L1 files.

Integration uses four milestones within the same five lanes, not whole-lane serialization:

| Milestone | Handoff and permitted parallel work                                                                                                                                                                                                                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1        | On merged WP3/WP4-final, L1-0 fixes public codecs and L1 freezes private Reader/Parser/Ports/Factory types. L5-early commits core-only advertisement with or immediately after L1-0, as one of the first WP5 commits; pin its exact SHA for WP6 WP4-based work. Public codec commit alone does not freeze private contracts. |
| M2        | L2 first freezes shared fixture shape and required builders, retaining sole fixture ownership. Then L2 reader and L3’s three parsers run in parallel; L1 continues Store/Service/lineage/checkpoint implementation.                                                                                                          |
| M3        | L4 can start mock-port assembly after contract freeze; completion and real Store integration wait for L1/L2/L3 results. L1 alone writes the L4-consuming MemoryImport.test.ts integration cases after L4 integration.                                                                                                        |
| M4        | After routes/client group/runtime/reader cleanup readiness, L5-late activates import → integrated exact-head macmini-cf focused proof → PR CI. Early advertisement and preparatory work do not certify import or c-6.                                                                                                        |

Keep these serial: L1’s shared-file transaction → settlement → checkpoint/accounting edits;
L1-0 verification before L5 takes over C/rpc.test.ts; L4 integration before L1’s real Store
integration tests; final activation before exact-head evidence. No concurrent shared-file edits
or mock/stub success as c-6 proof. WP3/WP4 are integrated baselines, not release claims;
post-WP4 extensions remain WP5 L1-owned. No package/dependency/UI or other plan edit is assigned;
L5 changes only the actual client-runtime protocol group **and its behavior test**, reusing the
WP4 command and guards unchanged. Before B validate codecs, protocol compatibility and complete
permanent-metadata/checkpoint reservations against those merged source hashes.

Planned private additions (L1; fields bound by §4 and encoded only under Store):

```ts
// Proposed non-wire Store ports; all Tx methods require Store.Transaction.
type InTx<A> = Effect.Effect<
  A,
  Store.MemoryStorageError | Store.MemoryStoreConflict | Store.MemoryCapacityError,
  Store.Transaction
>;
readImportRegistrationTx: (input: ImportRegistrationLookup) => InTx<ImportRegistration | undefined>;
writeImportRegistrationTx: (
  input: ImportAddress & { next: ImportRegistration; expectedVersion: number | null },
) => InTx<ImportRegistration>;
readImportBatchTx: (input: ImportBatchAddress) =>
  InTx<ImportBatch | ImportRetiredBatchGuard | undefined>;
readImportReceiptTx: (input: ImportBatchAddress) => InTx<M.MemoryImportReceipt | undefined>; // absent/retired mapped to not_found by Service
readImportItemTx: (input: ImportSourceAddress & { sourceItemKey: string }) =>
  InTx<ImportItem | undefined>;
findImportMatchTx: (
  input: ImportAddress & {
    source: M.MemorySourceKey;
    content: M.MemoryContentSuppression;
  },
) => InTx<ImportMatch>;
commitImportItemTx: (input: {
  registrationVersion: number;
  batch: ImportBatch;
  previous: ImportItem | null;
  next: ImportItem;
  commitIntent: Effect.Effect<void, MemoryServiceError, Store.Transaction>;
}) => Store.InTx<M.MemoryImportItemResult, MemoryServiceError>;
```

ImportRegistration owns source/profile/locator and bounded active session/CAS version;
ImportBatch owns request digest, immutable selected IDs, outcomes/remaining and counters;
ImportRetiredBatchGuard is `{kind: "retired"; selectionDigest: string}` in the same batch row;
ImportBatch is tagged `kind: "detailed"` and exposes selectionDigest for strict preflight;
ImportItem owns stable scope/latest accepted hash/revision versus rejected observations;
the permanent ledger, not this receipt codec, owns lifetime accepted aliases/content hashes;
ImportMatch distinguishes source/content suppression, pending forget and live exact copy.
Their strict codecs live in MemoryImportTypes and are consumed by Store; these are additions,
not WP2 exports. commitImportItemTx runs inside existing transaction journal and charges the
session/receipt allocation before invoking the ordinary local-intent callback. It is not an
approved-replica API. The callback port preserves MemoryAccessError through MemoryServiceError;
plain read/write ports retain their narrow errors. Live access denial rolls back the **whole current
item transaction**, including receipt/session/intent/quota, then reaches the existing auth/RPC
boundary unchanged. Never catch it as storage_failed, rejected item or import issue; earlier
independently committed items remain committed. L1 owns a callback-denial focused case; L4/L5
consume the same typed failure. L1 adds separate canonical-settlement receipt update using 030's existing
transaction, not by recursively invoking local import.

Field chain: sourceId/profile/sessionId are created by destination reader/coordinator, encoded
in the existing source registration and RPC result, decoded by existing strict DTO/private
Store codecs, then consumed by WP6 selectors/L4 apply/L1 CAS. Import aliases/content history
are created as bounded deltas by L1, encoded in existing operation provenance and the permanent
ledger codec, decoded on Store reload/approved ACK/pull and the new checkpoint arm, consumed
by matching/forget/settlement/Quota and checkpoint production. WP4 consumes current provenance,
not the full lineage. The L1-0 chain above names all checkpoint consumers.
Private absolute roots never cross the wire; raw snapshot bytes have no persistent codec;
provider app version has no field. Existing format/action/outcome/issue values stay unchanged;
unknown values reject via contracts, not default parser dispatch. New capability creation →
ServerEnvironment descriptor/events → strict capability DTO → WP4 destination availability/
WP6 consumption is tested by L5. Direct generic upserts cannot fabricate import receipts;
no client flag can select approvedReplica or bypass hub admission.

## 6. Focused acceptance — temporary fixtures, macmini-cf + PR CI, NOT RUN

All scenarios use temporary homes, SQLite databases and synthetic repositories. Override roots
and inject FS/Vcs/auth/clock/fault layers; never fall back to process HOME or installed provider
state. Byte hashes, directory inventories, Git refs/index/config/**objects** and write-call spies before/
after prove fixture sources unchanged, including failure and cancellation paths. No corpus,
settings, credentials, provider network/model call or provider binary is a test dependency.

| Owner / focused file                                                                                                               | Activation scenario → observable requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L2 imports/MemoryImportReader.test.ts                                                                                              | Root/ancestor/file symlink, traversal, Git symlink/gitlink, malformed UTF-8, NUL, missing file/object, file swap during read, Git HEAD move, process timeout/truncation → typed issue/no mixed snapshot, no stderr/path leakage and zero writes. Missing promisor blob and unsupported Git version → typed source_unreadable; fetch/transport/credential helper spies record zero calls, full `.git/objects` inventory unchanged. Every Git call asserts the sanitized lazy-fetch/prompt/network policy. Equality/+1 for roots/visited entries/depth/file/tree/snapshot/preview framing → explicit refusal, bounded reads/allocations.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| L3 imports/CodexMemoryImporter.test.ts                                                                                             | Synthetic fenced heading, duplicate NFC title, supported optional applies_to, ad-hoc note, JSONL in .md, summary/raw/rollout/skills links → only allowed units, stable keys; no linked evidence traversal or inferred scope. Oversize task/file rejects rather than slicing/truncating.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| L3 imports/ClaudeMemoryImporter.test.ts                                                                                            | Four direct types and isolated metadata.type compatibility; disagreement, duplicate YAML keys/tags/anchors/nested fields, index/CLAUDE.md/episodes → deterministic profile/issue. Encoded dirname never assigns project; ignored foreign session values absent from provenance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| L3 imports/OmoMemoryImporter.test.ts                                                                                               | beta63 scalar/quoted headers, aliases JSON, tolerated limit/extra scalars, monthly ledger, persona, dirty/untracked changes, unsupported older checkout → only pinned committed units, instructions remain data, no runtime fallback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| L4 imports/ProviderMemoryImport.test.ts                                                                                            | All actions, no public memory:read requirement on status, changed batch digest before read, expired session, source_changed, raw/header/title secret while normalized text is safe, selected valid item after malformed file → bounded rows/no raw retention, no accepted-parent mutation; status performs no FS/Vcs/apply. Secret-bearing Codex title/sourceItemKey and secret-bearing locator fixtures → entire file refused via value-free MemoryImportRpcError secret_detected, no preview/item-result key, and no value in serialized error/log/receipt/report captures; include safe normalized body and mixed safe/unsafe items in the same file.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| L1 memory/MemoryImport.test.ts + MemoryStore.test.ts                                                                               | Real transactions: unchanged retry/restart no new revision/index work; changed source same ID/receipt parent; manual/remote edit → real conflict; same-scope copy alias, another scope no false alias; rejected observation not accepted hash. Lost response/status/partial retry, compact retired batch, changed operation-ID digest → exact committed IDs or explicit not_found, never reapplication. Deferred-controlled race rollback leaves intent/receipt/session/quota all committed or all absent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| L1 MemoryService.test.ts + memory/MemoryImport.test.ts                                                                             | Two environments same explicit project key, pinned remote/restart, foreign thread/project, binding or permission revocation during source wait/SQL lock → mapping_changed/authorization denial without receipt mutation, no local fallback. Bootstrap unbound/staging/mismatched space → bootstrap_required; bootstrapped offline → pending, later hub settles. Hub environment follows same local submission path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| L1 memory/MemoryImport.test.ts                                                                                                     | Import multiple aliases and changed versions, forget, leave original fixture untouched, restart/re-preview/source content change/exact-copy rename → suppressed with no body exposure. >100 suppression entries → actual WP3 base+fragments and separate receipts; pending/rejected expansion does not resurrect; checkpoint/rebuild/compaction and offline third member retain suppression. An offline proposal built before remote forget is rejected by real hub admission even before local catch-up. **101+ accepted alias/content lineage records → actual MemoryCompactor run deleting old revisions/detailed receipts → new environment bootstrap from produced multi-page checkpoint → forget in that environment → every historical fixture key/body re-import suppressed**. Include generic edit/resolve before compaction; ledger stays complete and body-free. L1 MemoryCompactor/Hub/Sync/Store and contracts tests own each step, not a handcrafted checkpoint substitute. True GOAT thread source exclusion remains intact; provider IDs never become sourceThread. |
| L1 MemoryQuotaService.test.ts + memory/MemoryImport.test.ts                                                                        | Exactly 1,000 lineage records then a distinct 1,001st → typed capacity_exceeded and no accepted-parent/ledger mutation; duplicate at cap is noop. Global lineage 32-MiB and combined M19 128-MiB equality/+1 including suppression reserve and retained/new checkpoint pages → atomic refusal with existing ledger intact, reserved forget succeeds, approved replica restores all records. Equality/+1 and multibyte session/live/source/alias/digest/metadata/history budgets; 32-item chunk split/new session/concurrent reservation; rejected/suppressed new alias → no quota bypass, exact partial receipts. Fill local alias/key/work budgets then receive real hub-approved upsert/alias/forget → full canonical union/receipt/cursor, deferred index only. Scanner disagreement holds approved body without re-admission.                                                                                                                                                                                                                                                   |
| L1 quota/store tests                                                                                                               | Before/after import/drain and repeated noop samples, FTS brake/resume, absent dbstat/WAL/baseline, forget/rebuild → bounded growth and truthful unavailable metrics; no duplicate raw text/history identity/index, forgotten text absent. Use existing maintenance, no new physical sampler per item.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| L5 rpc.test.ts, ws.test.ts, RpcAuthorization.test.ts, ServerEnvironment.test.ts + packages/client-runtime/src/rpc/protocol.test.ts | L5-early: installed core16 with memory.protocolVersion=1 and importProvider omitted/false passes the actual core client gate and denies import (R/state/memory.ts:254–260, C/environment.ts:339–340). L5-late: actual client group core14+owner2+import1=17, import present and existing core/owner methods retained; ready import discover/preview/apply/status round trips and capability. Missing/revoked either grant after wait/lock denies every action; no handler-local bypass, old destination unavailable. Lost WS response status returns persisted partial/completed receipt without source reads. Reader failure preserves core advertisement/core16/relay. Existing hub flag/version conditions are unchanged.                                                                                                                                                                                                                                                                                                                                                        |

### c-6 evidence chain and lane sufficiency

c-6 requires Codex, Claude and omo read-only import **with provenance and unchanged sources**.
Five lanes remain: L1 durable lineage/contracts/integration; L2 reader/source immutability;
L3 the three pure parsers; L4 coordinator; L5 RPC/auth/composition. L1-0 is L1's first commit,
not a sixth lane; L5-early/late are slices of the same L5. Follow M1–M4: public and private
contract freeze → shared fixture freeze → parallel reader/parsers and durable work → real
coordinator/Store integration → final activation/evidence. L1’s shared-file ledger/transaction,
settlement and checkpoint/forget/accounting edits stay serial, as do its final L4-consuming cases. Client/HTTP keep protocol 1 and only consume the required-lineage codec/tests. No sixth protocol lane or three separately owning parser lanes are needed.

| c-6 claim                                            | Required exact-head proof / owner                                                                                                                                                                                                                                                                                                   | Insufficient evidence                                                                           |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| All three provider formats work                      | L3 profile fixtures plus L1 MemoryImport.test.ts: each Codex handbook/ad-hoc, Claude direct/isolated metadata and committed omo fixture through real reader → coordinator → real Store → hub approval/ACK, then authorized read with exact source/profile/key/fingerprint provenance.                                               | Parser-only tests, mocked coordinator success or one provider happy path.                       |
| Provider original unchanged                          | Same integrated three-provider runs capture pre/post byte hashes, directory inventory and reader write-call spies; omo includes refs/index/config/objects and dirty/untracked exclusions. Failure, retry, cancellation, secret refusal and missing promisor object also leave originals intact. L2 builds fixtures; L1 reuses them. | A read-only type name or unchanged GOAT DB alone.                                               |
| Forget and restart cannot re-import accepted history | L1 real resolve/compaction → new-device bootstrap → forget/purge GOAT body, resolution inputs, FTS/derived caches/report payloads → all historical keys and exact same-scope bodies suppressed; provider fixture unchanged. Verify search/read/history/resolve-input/rebuild never exposes forgotten text.                          | Tombstone only; a handcrafted checkpoint; provider file removal.                                |
| Bounded index/storage                                | L1 repeated noop/change/forget/rebuild metrics including DB/WAL/FTS, equality/+1 refusal and rollback. L5 proves dual grants/remote destination/capability.                                                                                                                                                                         | Numeric caps alone, missing measurements treated as zero, CI job conclusion without test steps. |

All rows are future **NOT RUN**. Coordinator captures focused files, collected/executed counts,
exit codes and logs on macmini-cf at integrated SHA and records PR CI separately. c-6 is not
closed by this READY_FOR_B plan handoff. UI/import presentation is WP6; MCP import is not required.

Additional re-anchor acceptance (all NOT RUN):

| Lane / owned tests                             | Activation and observable result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 contracts + HubClient/HubHttp/Sync tests    | Hub/version/ready remain 1, no new hub version constant; required-lineage strict decode and complete install. Missing/duplicate/cross-scope lineage or >100 mixed records rejects; multi-page lineage survives install. Existing binary compact-receipt v1/v2 fixtures retain every old capacity ordinal/decoded value/original byte encoding; appended dimensions round-trip.                                                                                                                                                                                   |
| L1 075 migration + reconcile tests             | Synthetic empty→071→072→073→074→075→076 and already-074→075→076 (current registered schema only); a mismatched memory ordinal is rejected before ledger changes; current-schema rows and suppression survive normal restart. INSERT/UPDATE/DELETE/rollback/restore counters match strict encoded bytes; repeated union/noop does not double-charge.                                                                                                                                                                                                              |
| L1 MemoryHubSyncScenarios / MemoryImport tests | H imports → A/B receive body plus exact safe provenance. B forgets → H/A cannot re-import same-scope body through fresh local registrations; original registered key remains blocked after source changes. An offline pre-forget proposal reaches the hub and is rejected without resurrecting. Provider fixture hashes/objects remain unchanged.                                                                                                                                                                                                                |
| L1 Store/Quota/Compactor/Sync tests            | Changed import concurrent with manual edit → conflict; first observer resolves with execution provenance, takeover/revert retains lifetime lineage. >100 histories, real compaction, new-device bootstrap and forget block all historical keys/hashes. Fill lineage/metadata/retained-page + next-checkpoint bounds at equality/+1, invalidate consumed staging by one lineage mutation, reject atomically; full approved replica still persists union/cursor and reserved forget works.                                                                         |
| L2 reader tests                                | Parent synthetic Git injection/proxy/askpass sentinel → no inheritance, no helper/network/lazy fetch; unsupported isolation/version/missing promisor object → safe refusal, complete source/objects inventory unchanged. No real host environment or credentials inspected.                                                                                                                                                                                                                                                                                      |
| L4 coordinator tests                           | Raw secret header/title/item key/locator with otherwise safe body → whole-file value-free refusal; status/lost response retry performs no source I/O. Either live grant revoked during wait/lock → no receipt/provenance mutation.                                                                                                                                                                                                                                                                                                                               |
| L5 activation tests                            | Early: memory.protocolVersion=1 advertises installed core14+owner2=16; importProvider omitted/false, actual client core gate available and import gate unavailable. Late: only route/client group/runtime/reader cleanup readiness enables importProvider=true and dual-grant RPC round-trip; reader failure keeps core protocol=1/core16/relay. Existing hub flag and conditional memoryHubProtocolVersion stay unchanged (hub version 1 only under existing conditions, disabled hub omits it). No new service/registry/RPC/contract field or MCP import tool. |

Audit r1 / re-audit r2 acceptance additions (NOT RUN):

| Finding / owner                                           | Activation → observable proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 L1 Store/Service + L4/L5 consumers                     | Inject MemoryAccessError from commitIntent after lock and provisional receipt/session/quota allocation. Entire current item Tx rolls back: receipt/session/intent/quota match pre-Tx snapshot; same auth denial reaches real RPC boundary, no import issue/result conversion. Prior independent commits survive.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| A2 / R2-1 L5 server/rpc + L1 real Store integration       | Actual Service→Hub→Sync→ImportRuntime composition uses only factory-declared arguments and executes all four actions plus existing Sync.start. Recreate ImportRuntime over persisted Store, set source-read spy to fail: status and completed exact retry still return identical IDs/outcomes, no reader calls. Different digest (detailed and retired) returns operation_id_reused before any source I/O; partial exact retry reads only unfinished selectors. Discover across runtime restart retains sourceId; concurrent slot insertion returns winner. Preview session/version persists across recreation; concurrent stale CAS fails without replacing winner/counters. Final item CAS races and auth denial preserve atomic receipt/session/outbox/quota. User-scope apply/status (no project/thread ref) succeed through the bound environmentId; two runtimes bound to different trusted environment IDs keep separate receipts for the same space/operationId, and a runtime bound to a mismatched ID is refused by the Service. Deferred barrier: partial preflight completes → existing retention retires the batch → final item commit: same digest reaches real RPC as MemoryRpcError not_found, different digest as operation_id_reused, with zero further change to guard/receipt/session/intent/outbox/quota and no reapplication. One Store/Service/Sync, no extra runtime/acquisition cycle; static facade/factory types verify R=ImportRuntime/R=never; Deferred/worker milestones prove startup. |
| A3 / R2-2 L2 real synthetic Git repositories + L5 startup | gitfile/commondir/alternates/http-alternates/metadata symlink reject during no-follow copy; provider config include/includeIf is never read/copied. At Deferred barrier after copy/seal and immediately before Git, swap original config to external include, objects to external alternate and metadata ancestor to external symlink, separately and combined. Instrument reader opens and actual child filesystem reads: boundary-external read count **0**, only original snapshot result or value-free refusal. An unsupported child read-spy/enforcement platform is NOT VERIFIED, never PASS. Swap descriptors/ancestors during copy → source_changed with no candidates. Loose/packed replace changes cannot affect fixed-OID bytes; all calls disable replacement/lazy fetch/transport. Exact limits/+1 cover object/metadata bytes/entries, depth, 2-slot/128-MiB admission under concurrency; no partial-success truncation. Success/failure/interruption/timeout finalizers wait child then leave **0 owned snapshots** (all drained requests: total 0); synthetic crash residue removed by fresh reader/startup before activation, repeated cycles plateau at 0. Inject cleanup failure/oversized or symlink residue: import unavailable, reservation retained, no new snapshot, unrelated core starts. Assert provider inventory/bytes unchanged by reader (fixture-controlled swaps accounted separately), no raw stderr/path logging.                                                                  |
| A5 L1 + coordinator                                       | Fixed workload in §4 Requirement 7 on macmini-cf and same-SHA packaged off-host execution; raw CSV/JSON plus logs and unavailable fields retained. Source CI alone does not certify packaged growth.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Use Deferred barriers/persisted events and existing MemoryWorker.drain plus WP3 settlement/drain
milestones. If thread orchestration is involved, drain OrchestrationEffectWorkerV2 too. No
sleeps or polling-based success. Measure canonical approval versus local readability separately;
a locally committed item is not a hub approval or physical cleanup proof.

Current CI wiring: `.github/workflows/goat-ci.yml:147–149` runs server package shards;
`apps/server/package.json:24` runs its test suite; `apps/server/vite.config.ts:155–169` uses
nonparallel files and weighted shards, with all new server .test.ts files in scope. Contracts
run at `goat-ci.yml:125–127`. L5 does not edit workflow or claim old r4 static counts apply.
Focused typecheck/lint of changed server/contracts files are allowed on this Mac and in PR CI;
none is needed or run for this docs-only reflection. Tests/e2e/full builds stay off this Mac. Capture exact PR head,
discovered focused files/case counts and actual logs/steps; cancelled/skipped/toolchain failures
are not passing tests. No local bun/pnpm/vp test, vitest, e2e, repo checks, full build,
dependency installation or dev server on this Mac.

## 7. Risks, ownership and re-audit handoff

User decisions required: **none**. Explicit selections (source and per-item scope) are ordinary
future product inputs, not a new design approval request. WP6 owns web/desktop/mobile import
screens, settings/command-palette/keybinding reachability, chunk stop/status presentation and
user guidance. WP4 owns common delivery to all six providers, MCP/core auth and guarded
import command. WP3 owns baseline hub bootstrap/materialization, admission/settlement and canonical
receive; WP5 L1 owns their lineage/checkpoint/compactor extensions after WP3 merge. WP5 owns read-only source import and server import group/handler/capability activation.
WP5 L5-early explicitly takes over WP4’s small core advertisement gap, without broad WP4 repair
scope; L5-late owns import activation after readiness. L5 retains ServerEnvironment.ts/test ownership
through both slices. Pin the early commit SHA for WP6’s WP4-based work; no duplicate WP6 edits.
Local/remote/relay/tunnel calls always use selected environment roots; all environments are
equal writers. No new MCP import tool or provider adapter/UI is needed in this phase.

Implementation risks for reflection: complete source/receipt/session private codecs on the
actual WP2 table inventory; parent-aware intent integration without hub-local precommit;
accepted-vs-pending receipt reconciliation; permanent imported alias/content extraction before
forget purge; compact batch guard framing/retention; filesystem no-follow portability and
large Codex/omo ledger refusal; narrow historically observed Claude metadata profile. Each has
an owner and activation case above. None authorizes an undeclared schema change, corpus read,
source rewrite or semantic-erasure promise. Scanner pattern misses, rename+paraphrase and
privileged direct DB edits remain limits; tested service paths are the enforcement surface,
not a guarantee over arbitrary external writers. Root bypasses/profile changes require
migration retaining suppression, not a downgrade of the read-only claim.

Audit r1 at `5726f6fd0` returned NO-GO; audit-fix r1 folded A1–A6. Independent re-audit r2
at `8004d3ec9` accepted A1/A4/A5/A6 and A2’s acyclic assembly but returned NO-GO for durable
factory ports and Git check/use enforcement. Audit-fix r2 folded R2-1/R2-2 while preserving
accepted decisions. Reflection r4 is ALIGNED and audit r4 is GO-WITH-FIXES; this r4 fix folds
the coordinator-approved G-1/G-2 and A4-1/A4-2 dispositions without reopening closed items.
Reflection r1 is historical input. Snapshot portability/read-spy support, cleanup failure and
large-repo refusal remain implementation risks with the acceptance/owners above.
Coordinator owns the READY_FOR_B handoff against this exact documentation commit and the r4
dispositions; this is not a runtime gate pass. WP4 final 90edc7a40 is pinned here; before B retain
the confirmed joint-release premise and L1-0 codec/accounting/assembly signatures. This 050 is the implementation plan; 000 records its WP5 cycle.

Authoring verification: only 050 and 000's WP5 cycle are written. This tree has no node_modules;
run `./node_modules/.bin/vp fmt <both absolute document paths>` then the same `vp fmt --check`
from `/Users/jun/.goat/worktrees/goat-gaps/goat-78999bf5`, as explicitly authorized. No dependency
installation or other main-worktree edits. Fresh fmt/diff/post-commit show results are recorded
in `/tmp/goat-wp5-auditfix-r4.md`; the prior missing-vite-plus attempt is historical, not current proof.
Tests/vitest/e2e/build,
typecheck/lint, dev server, remote execution and CI are NOT RUN. Future focused implementation
proof belongs on macmini-cf at the exact integrated SHA with synthetic roots/database and
non-login commands. No environment listings, shell settings, live GOAT/provider homes, real DB,
credentials or provider corpus access. No sleep/poll; use Deferred/worker milestones.

### Follow-up requests (read-only predecessor boundaries)

- **040 owner:** preserve guarded importProvider destination/dual grants and WP5-only RPC activation. Core MCP remains WP4's nine catalogued tools; no provider import MCP tool is authorized by this WP5 plan. If a future import MCP tool is wanted, amend 040 and assign its contract/auth/service tests before activation; do not silently add it to L5. Consume safe import provenance for injection/readSource: provider imports have no actual sourceThread, so original provider files are never read via thread source relay. Coordinate the required §5 v1 checkpoint codec extension after WP4 source-relay merge; no simultaneous source-file ownership.
- **030 owner:** no correction to finished WP3 code is requested in this P task. Record later WP5 checkpoint lineage/v1 codec extensions as WP5 scope, rather than claiming existing suppression/provenance already preserves unbounded import history.
- **060 owner:** consume the pinned L5-early SHA for WP4-based work and re-anchor the core capability producer coordinate to WP5 L5-early (reflection r5 G-7); WP6 does not edit ServerEnvironment.ts or its test. Preserve the final WP5 implementation SHA/DTO/ordinal freeze and final stack/release gates; the early handoff does not replace them. Keep import cancel as stopping future chunks, not a new server action; consume guarded destination command and distinguish accepted/pending/suppressed/held. Re-anchor its stale baseline and provenance/forget presentation later; no UI/docs edit is performed here.

Prior consultation/reflection/audit handles in 000 are historical. This bounded planner fix
ends at READY_FOR_B handoff after the coordinator’s r4 dispositions; coordinator owns B approval. It authorizes neither B nor
runtime closure, and does not rerun consultation or tests within this docs-only request.

## Folded revision correspondence

| Previous amendment                                              | Current home                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rev 2 action/receipt ownership                                  | §3 and §4.1–2: implemented DTO/table versus WP5 private helpers, no cancel job, status without source I/O.                                                                                                                                                                                                                                                                                     |
| reflection r1 / rev 3 project binding                           | §3 and §4.3: corrected two-argument resolveProjectKey, live permit/version recheck and real scoped identity.                                                                                                                                                                                                                                                                                   |
| audit r1 / rev 4 B2/B4/B7/B8                                    | §4.3, §5–7: existing decider and hub settlement, limits of claims, current owned-file/CI map instead of historical coverage counts.                                                                                                                                                                                                                                                            |
| M19 / rev 6                                                     | §4.2/4.4 and §6: source session across chunks, permanent suppression/cumulative admission, bounded staging and measured growth.                                                                                                                                                                                                                                                                |
| M20 / rev 8                                                     | §3/4.3–4.4 and §6: every environment submits ordinary intents, hub-only admission, approved replica canonical union with local exposure deferral.                                                                                                                                                                                                                                              |
| P-phase reflection r1 G-1 / audit r1 A#1 on 6d08771c4           | §4.3–4.4, §5 L1-0 and §6: permanent lineage codec/budgets, WP5-owned post-WP4 producer/consumer/compactor extensions, 101+ real compaction/bootstrap/forget and cap refusal.                                                                                                                                                                                                                   |
| P-phase audit r1 A#2 on 6d08771c4                               | §4.1 and §6: mandatory lazy-fetch/prompt/network/credential isolation, unsupported Git refusal and unchanged object inventory fixture.                                                                                                                                                                                                                                                         |
| P-phase reflection r1 G-2 on 6d08771c4                          | §4.1 and §6: secret key/locator rejects whole file with existing value-free typed error and zero unsafe metadata output/logging.                                                                                                                                                                                                                                                               |
| P-phase audit r2 #1 on 9027962ec                                | §4.1, §5 L1 and migration: register the stable GOAT name MemoryImportLineage in reconcileGoatMigrationIds with an upstream-renumbering regression; strip inherited Git variables from the child environment.                                                                                                                                                                                   |
| rev 9 — WP3-final P re-anchor r1 (3cc957768)                    | §1/§3 current exports/errors; §4 hub propagation, identity-aware suppression, resolve-independent lineage and trigger/checkpoint accounting; §5 separate 072 at that historical input (now 075) + reconciliation and release-gated protocol decision (superseded by rev 10 below); §6 macmini-cf acceptance; §7 predecessor follow-up requests.                                                |
| rev 10 — same-architect reflection r1 (bff448153), superseded   | Retained independent lineage migration (now 075), bounded accounting, WP4 A-lite/import/MCP separation, local verification rule and five-lane c-6 matrix. Its unresolved release choice is replaced by Jun’s confirmed joint-release/v1 decision in audit-fix r1.                                                                                                                              |
| audit-fix r1 — A1–A6 on 5726f6fd0                               | §2 full provenance; §4.1 Git boundary; requirement 7 fixed workload; §5 callback error, acyclic assembly and confirmed v1/append-only ordinals; §6 exact acceptance. Jun joint WP1–WP6 release replaces prior protocol choice. READY_FOR_REAUDIT, runtime NOT RUN.                                                                                                                             |
| audit-fix r2 — R2-1/R2-2 on 8004d3ec9                           | §4.1 GOAT-only snapshot execution, bounded stateDir disk lifecycle/startup cleanup; §5 L1-0 durable callback signatures and Tx discharge; §6 restart/CAS/preflight and concurrent-swap/cleanup acceptance. Existing A1/A4/A5/A6, acyclic facade and joint-release v1 retained. READY_FOR_REAUDIT only.                                                                                         |
| audit-fix r4 — reflection G-1/G-2, audit A4-1/A4-2 on b08da4e6e | R22, §5 M1–M4 and §6–7: same-owner L5-early core-only advertisement and pinned WP6 input, L5-late ready import; private/public/fixture milestones with shared-file serial gates; protocol behavior test owned and final group 17; task-ceiling/middleware focused regressions and diff-conditional transport consumers. Prior closed decisions and joint-release v1 retained; runtime NOT RUN. |
