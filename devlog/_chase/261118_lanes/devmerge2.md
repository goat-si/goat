# dev merge 2 into PR #3700

Integration parent `1a77e8e2a58670b35f24ed495a57732043b5916a`. Dev parent `cf2481614584caa6a139000698be912f6099ea2a` (#3756). Two-parent merge `99f19e3b4eac2a806329e4c8015a59ef38260370`.

## Coordinator rulings

1. packages/shared/src/serverSettingsTextGeneration.test.ts (legacy Pi routing): APPROVED to resolve in dev's favour. dev's #3756 is the shipped memory behaviour and is authoritative for memory and review-guide routing: keep dev's expectations (memory and review guides route to extensionModel for [piProvider({})], the unflagged OmO memory fallback, the standalone review-guide fallback) and replace the integration-side toBeNull() expectations at lines ~62-66 with dev's. Production code must produce dev's results. Keep SF3's Cursor behaviour intact: sandbox-refusal capability flags, memory fail-closed on Cursor sandbox refusal, and ordinary-generation fallback still pass their own tests. If any SF3 Cursor test then fails, stop and report it.
2. Migration IDs: APPROVED exactly as your table: dev keeps 158-165; ScheduledTaskFirstBindIntent moves 159 -> 166. Update reconcileGoatMigrationIds (and its tests) so a database that already applied ScheduledTaskFirstBindIntent as 159 (any nightly or dev build of this integration branch) reconciles to 166 without re-running or skipping dev's 159 MemoryThreadLineage; add a focused test for that ledger. Update the expectations that pin the old entry: reconcileGoatMigrationIds.upstream080.test.ts:97 (expect dev's seven migrations 159-165 then [166, "ScheduledTaskFirstBindIntent"]) and the scheduled-task tests asserting the old 159 entry and retry ledger (ScheduledTaskRuns.test.ts ~:107) -> 166. Titles and other assertions unchanged.

## Follow-up coordinator rulings

1. APPROVED: reconcileGoatMigrationIds.test.ts ~:153-159 append [166, "ScheduledTaskFirstBindIntent"] after [165, "MemorySuggestionQuota"]; follows from the approved renumber. Titles and other assertions unchanged.
2. APPROVED as a production fix (no test edit): memory routing prefers known memory-capable routes ahead of dev's unflagged Pi/OmO compatibility fallbacks; the fallbacks still apply when no capable route exists. MemoryWorker.route.test.ts:145 must pass unchanged AND dev's serverSettingsTextGeneration legacy Pi/OmO expectations and the SF3 Cursor checks must all still pass. If they cannot all hold, stop and report the exact conflict.

## Conflicts

| File | Resolution |
| --- | --- |
| `SettingsMemoryRouteScreen.tsx` | Kept dev's editor, move, and suggestion flows and the SF3 configured-model refresh key. |
| `MemoryGenerationHold.ts` | Kept dev's bounded hold registry and atomic probe settlement with SF3's operation-aware resolver. |
| `MemoryHubSyncScenarios.test.ts` | Combined dev's move and source fixtures with SF3's runner fixture. |
| `MemorySyncService.testkit.ts` | Kept dev's runner error fixture and SF3's no-memory capability defaults. |
| `Orchestrator.ts` | Used dev's root dispatch attribution while retaining integration's scheduled selection following. |
| `ThreadLaunchService.ts` | Kept integration's atomic launch, replay and preparation flow. Added dev's person ingress to the shared launch type and persisted atomic first-message schema. |
| `Migrations.ts` | Kept dev's 158–165 and assigned first-bind intent to 166. |
| `reconcileGoatMigrationIds.ts` | Used the same pure ledger plan for startup and preflight. The integration nightly upgrade moves the old row and fills the memory gap together in one transaction. Kept dev's Pen insertion. |
| `reconcileGoatMigrationIds.resume.test.ts` | Set the resumed ledger's terminal ID to 166. |
| `reconcileGoatMigrationIds.test.ts` | Kept dev's nightly assertions and extended both the nightly and pre-Pen tails through 166. |
| `reconcileGoatMigrationIds.upstream080.test.ts` | Covered fresh and 158 ledgers, upgrade from applied first-bind 159, rollback during gap fill, and retry. |
| `reconcileV2PreviewMigration.test.ts` | Combined the memory and first-bind tails in both preview cases. |
| `ws.ts` | Kept dev's memory mutation handlers and ingress stamping alongside integration's project enrichment and VCS status handlers. |
| `agent-surface-audit.md` | Regenerated with `vp run agent-surface:audit`. |
| `packages/contracts/src/memory.ts` | Kept dev's split codecs and legacy decoding with the SF3 opt-in model availability contract. |
| `serverSettingsTextGeneration.test.ts` | Used dev's legacy routing expectations and retained SF3's OpenCode route and operation capability coverage. The resolver prefers known memory routes before allowing unflagged Pi/OmO with an advertised text-generation model. The worker assertions stayed intact. |

The merged RPC authorization test exceeded the 1,000-line budget by four lines. The checkout-branch assertion moved intact to `RpcAuthorization.vcsBranch.test.ts`.

## Migration IDs

| Migration | Before | After |
| --- | ---: | ---: |
| AuthSessionPenMember | 158 | 158 |
| MemoryThreadLineage | 159 | 159 |
| MemorySaveSuggestions | 160 | 160 |
| MemoryHubFloor | 161 | 161 |
| MemoryScopeVersion | 162 | 162 |
| MemoryCompactMoveReceipts | 163 | 163 |
| MemoryOriginCatchup | 164 | 164 |
| MemorySuggestionQuota | 165 | 165 |
| ScheduledTaskFirstBindIntent | 159 | 166 |

Dev owns 159–165. A legacy integration database records first-bind at 159. Reconciliation moves that receipt to 166 and applies 159–165, including MemoryThreadLineage, in the same transaction. An interrupted transaction leaves the legacy ledger available for retry. Dev's shipped migration files are byte-identical, and the first-bind migration body moved intact. The pre-Pen memory layout still moves its recorded memory prefix from 158–163 to 159–164 and inserts Pen member auth at 158, as in dev.

## Verification and publication

The normal merge fast-forwarded `chase/t3-261114-next3` from the pinned integration parent. Both that ref and `chase/t3-261114-next3-devmerge2` were pushed to the merge above.

- Node 26.12.1 with `GOAT_TEST_TMP_GUARD=fail`. The server batch from `apps/server` ran the complete memory, persistence and text-generation directories, all five `ThreadLaunchService*.test.ts` files, and the ProviderSessionManager, scheduled-task first-bind, registry retirement, settings normalization and authorization suites. It reported 2,336 passed, 16 pre-existing failed, and 3 skipped across 165 files. The unchanged worker routing file passed all nine tests. The pre-Pen reconciliation file passed all 37 tests. The three skips were in the memory import and receive growth suites.
- Contracts, shared, client-runtime and SF3 Cursor suites passed 385 tests across 13 files. Mobile memory settings passed 136 across four files.
- Server, web, mobile, contracts and client-runtime typechecks passed (5/5). `vp run agent-surface:check` passed. The scratch code-budget updater exited 0 with 814 entries above a default limit and no overages. Both parent diffs passed `git diff --check`.
- No merge-introduced failures. The only failed file, `src/textGeneration/GrokTextGeneration.test.ts`, reported 16 failures and 9 passes on an exact source export of integration parent `1a77e8e2a58670b35f24ed495a57732043b5916a`. Ran `GOAT_TEST_TMP_GUARD=fail vp env exec --node 26.12.1 vp test run --reporter=default src/textGeneration/GrokTextGeneration.test.ts` from that export's `apps/server` with frozen-lockfile dependencies. The exact 16 failure names matched the merge. The launcher reported `exec: node: not found` (exit 127), rejection cases had no recorded `session/new` cwd at line 524, and the cleanup fixtures timed out after 120 seconds at line 535.

### Matching Grok failures

- `uses ACP with disabled tool capabilities and forwards the requested model id`
- `extracts the JSON object when Grok wraps it in conversational text`
- `resolveMemoryConflict returns result with runner-owned effective model`
- `generateMemorySummary returns result with runner-owned effective model`
- `resolveMemoryConflict rejects tool and discards apparent success`
- `resolveMemoryConflict rejects permission and discards apparent success`
- `resolveMemoryConflict rejects authority and discards apparent success`
- `resolveMemoryConflict rejects model and discards apparent success`
- `generateMemorySummary rejects tool and discards apparent success`
- `generateMemorySummary rejects permission and discards apparent success`
- `generateMemorySummary rejects authority and discards apparent success`
- `generateMemorySummary rejects model and discards apparent success`
- `resolveMemoryConflict times out and cleans up ACP and its workspace (ignoreCancel=false)`
- `resolveMemoryConflict times out and cleans up ACP and its workspace (ignoreCancel=true)`
- `generateMemorySummary times out and cleans up ACP and its workspace (ignoreCancel=false)`
- `generateMemorySummary times out and cleans up ACP and its workspace (ignoreCancel=true)`

NOT RUN: `vp run check:changed`, live-client QA, independent review, PR CI.

## CI follow-up for run 44466526585

Fix-forward head `1cddb69df8b7f3477ee609fbaf7f1a33317909c3` fast-forwarded both integration refs from `99f19e3b4eac2a806329e4c8015a59ef38260370`.

### Coordinator rulings
```text
3. Behaviour: under my standing ruling, dev #3756 is authoritative for memory and review-guide routing (Pi/OmO compatibility fallbacks). These integration-side expectations contradict it and are APPROVED to align with dev (Rule 3, record verbatim; titles may stay, assertions change to dev's behaviour, and keep any assertion that still holds):
   - apps/web/src/components/settings/SourceControlWritingSettings.browser.test.tsx "shows the eligible guide route and excludes Pi from the guide picker"
   - apps/server/src/pullRequest/PullRequestReviewGuideService.test.ts "guide generation agrees with Settings for explicit Pi ..." (both variants): Settings and generation must still AGREE; update the expected route to dev's.
   - apps/server/src/provider/providerMemoryCapabilities.test.ts "pi with {} refuses both memory operations" and "omo with {} ...": align with dev's capability declaration.
   BUT first check each against dev's own tests on origin/dev: if dev has an equivalent test with a different expectation, mirror dev exactly. If any of these reveals that Settings shows one route while generation dispatches another, fix production code so they agree (that is a real bug), do not paper over it.
4. apps/server/src/mcp/agentSurface.test.ts "gives every entry a unique path...": registry length 309 -> 310 because dev added one tool; APPROVED (exact count only). Confirm the new tool's listing tier is correct and the agent-surface audit is regenerated.
```

1. Both shared route resolvers require a caller-supplied timestamp. Production callers already use Effect clocks or the browser settings clock. The tests use fixture time or `Clock.currentTimeMillis`.
2. Made `isReviewGuideDriver` private to the shared resolver module and removed its re-export. The standalone-generator fallback still uses it.
3. Compared the guide picker, review-guide service, and provider wrapper cases against dev `cf2481614584caa6a139000698be912f6099ea2a`. Dev's shared routing tests accept a usable legacy Pi selection and OmO's legacy fallback. The three integration-only cases had no direct equivalent on dev. The browser now expects Pi and still verifies the Codex option. Both service cases assert the same Pi selection in Settings and generation dispatch. Pi's provider runner rejects read-only investigation through dev's `withoutInvestigation` path. The wrapper cases accept legacy snapshots for Pi and OmO while checking the current wrappers' explicit false flags and operation refusal.
4. Updated the registry assertion from 309 to 310. `memory.suggestions` appears as read-only `goat_memory_suggestions` in the full listing and is discoverable through `goat_describe`. The regenerated audit reports 309 discoverable entries because one registry entry is prompt-only.

Guarded Node 26.12.1 runs passed 182 server tests in 11 files, 54 shared settings tests in four files, and seven Chromium tests in one file. The five requested package typechecks and the shared-package typecheck passed uncached. `vp run knip:check`, `vp run agent-surface:check`, scratch code-budget measurement, and `git diff --check` passed.

NOT RUN: full CI on the follow-up head, live-client QA, and independent review.
