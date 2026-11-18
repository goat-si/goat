# 030 · Upstream implementation lanes

- Integration base `2c0e0002a996ec5d46c708919be5a43f579176fa` on `chase/t3-261114-next3` for [PR #3700](https://github.com/goat-si/goat/pull/3700). Upstream range `93cbca3fcbd..8a6342e7613`. This is a design handoff for wp3.
- 94 lanes, 21 waves, 1,025 tracked rows, 213 triage C4 rows. Counts include all 25 pending d1 rows. Wave widths are W1=7, W2=7, W3=7, W4=7, W5=7, W6=6, W7=6, W8=6, W9=6, W10=6, W11=4, W12=6, W13=5, W14=4, W15=2, W16=1, W17=3, W18=1, W19=1, W20=1, W21=1.
- Git refs at generation. Local HEAD `6def29ca359`, origin integration `2c0e0002a99`. All tree, migration and carried comparisons use the requested `2c0e0002a99` pin.
- Scope reconciliation. The request and the unchanged triage header quote the original chunk totals 231 take + 758 adapt = 989. During design the coordinator folded the triage recheck into 001’s table. The current table has 232 take + 768 adapt = 1,000, with 11 promoted rows (#42, #116, #127, #796, #806, #899, #922, #1053, #1084, #1105, #1118) and no dropped original candidates. All original rows are covered and the output follows the updated table. Current triage SHA-256 `3d9d0411878749fdd933836613c4016fd2e94f898ad58308946be71b32057dc9`.
- The 25 decision rows retain the requested pending d1 label. The coordinator ledger now records d1 as answered in favor of the recommendations (decision:3ab3bbec). Follow that ruling at dispatch, including its six skips, and recompute dependencies/footprints after dropping them. The current 27 present and 106 skip rows stay out of implementation tables.
- Waves are file-ownership and merge barriers. A carried dependency in the summary must land, or receive a written deferral and replan, before the overlapping writer starts. Within a wave, use host placement and one heavy job per host. Server-only lanes may use pen-lidge. For Mac lanes use the ranked eligible Macs. Windows/WSL and native-device checks use the designated runtime separately.
- Early waves favor parallelism. Later waves narrow around the actual Issues chain, shared write paths and the required final localization pass. Size is a source estimate from added plus deleted lines, including tests. Generated catalogs, snapshots, lockfiles and the vendored Linear schema/codegen are excluded from size but still count for overlap. An oversized upstream row stays with one owner and uses reviewable steps within the lane. Split additional GOAT adaptations at the first safe commit boundary before exceeding the budget.

## Shared gates

- Follow amendment u1 in 000_plan.md: use the single integration PR. Each lane runs check:changed against a verified ancestor on the integration branch and focused checks on the touched surfaces. Run changed server test files whole with GOAT_TEST_TMP_GUARD=fail, applying standing test-edit ruling IV. Run #3700 server CI on the first batch containing K1 and K4 before landing their dependents; reopen the owning lane on a failure. Coordinator batches integration CI and owns the final fresh review and exact-head full gates.
- Every bold C4 row requires a note and approval before code. Provide older client → new server and new client → older server behavior, explicit capability/downgrade and denial cases, and upgrade/rollback evidence for persisted state. For provider, CLI, launcher and IPC work, identify the corresponding older runtime/peer in the note. A contract marker on any row requires the same check if its adaptation changes a public wire surface.
- Clean upstream takes follow u1’s trust policy, subject to local gates. GOAT-authored fixes and adaptations get focused regression evidence. The coordinator owns P1 client captures on isolated state with Replay where applicable. Record exact commands and NOT RUN at handback.
- Graph method. Begin with the explicit depends-on cells, chunk Notes and migration stages. Normalize six upstream renames by both endpoints, and add GOAT ports and split-path candidates from the triage cells. Use exact same-file removed-line evidence to add likely preimage dependencies, with a minimum two matching nontrivial lines per predecessor/path. Same-file row sequences also supply undirected write conflicts: unrelated hunks may change order between waves, and each lane keeps its rows in upstream order. The hot-file index gives the resulting writer order. Recheck projections at the cut, particularly generated and GOAT-specific glue.
- Graph counts. 3,346 candidate paths, 1,164 shared row paths, 131 same-file preimage pairs before deduplication against declared edges, 1,005 shared lane paths. A shared path can have only one lane writer in each wave.

## Lane summary

| Lane | Title | Wave | Host class | Rows | C4 | Approx. handwritten Δ | Depends on new lanes | Depends on carried lanes | Shared hot files |
|---|---|---:|---|---:|---:|---:|---|---|---|
| [U01](#u01) | Desktop boot, readiness and updates (1/2) | W01 | mac | 17 | 8 | 2,450 | — | K3, K4, K7, K7b, K8, N10, SF2, SF3, TF1 | `apps/server/src/server.ts`, `pnpm-workspace.yaml`, `packages/contracts/src/server.ts`, `packages/contracts/src/ipc.ts` · 43 total |
| [U02](#u02) | Turn launch, resume and handoff recovery (1/2) | W01 | mac | 11 | 2 | 2,339 | — | K1, K12, K4, K6, K6b, K7, K7b, K9, SF2, SF3 | `apps/server/src/orchestration-v2/Orchestrator.ts`, `apps/server/src/orchestration-v2/ProjectionStore.ts`, `packages/contracts/src/orchestrationV2.ts`, `apps/server/src/orchestration-v2/runtimeLayer.test.ts` · 27 total |
| [U03](#u03) | K3 refresh coalescing and first follow-up | W01 | server-only | 2 | 0 | 399 | — | K3, K7 | `apps/server/src/vcs/VcsStatusBroadcaster.ts`, `apps/server/src/vcs/VcsStatusBroadcaster.test.ts` · 2 total |
| [U04](#u04) | Composer pickers and model selection | W01 | mac | 8 | 0 | 1,219 | — | K2, K6b, K8, SF3 | `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/chat/ChatComposer.tsx`, `apps/web/src/components/ChatView.logic.ts`, `apps/web/src/components/CommandPalette.tsx` · 16 total |
| [U05](#u05) | Attachment extraction and transcript ingest | W01 | server-only | 18 | 1 | 1,039 | — | K9 | `apps/server/src/project/AgentSessionScanner.ts`, `apps/server/src/provider/documentTextWorker.ts`, `apps/server/src/project/AgentSessionScanner.test.ts`, `apps/server/src/provider/userInputAttachments.test.ts` · 7 total |
| [U06](#u06) | iOS gallery and Quick Look | W01 | mac | 2 | 0 | 1,687 | — | K12, K7, M3b | `apps/mobile/src/features/threads/ThreadFeed.tsx`, `apps/mobile/src/components/ui/FilePreviewModal.tsx`, `apps/mobile/src/components/ui/FilePreviewSession.tsx`, `apps/mobile/src/features/threads/ThreadMarkdownImage.tsx` · 6 total |
| [U07](#u07) | Web conversation, timeline and accessibility (1/2) | W01 | mac | 2 | 0 | 838 | — | K8 | `apps/web/src/components/ChatMarkdown.browser.test.tsx`, `apps/web/src/markdown-clipboard.ts`, `packages/shared/src/markdownPipeline.ts`, `apps/web/src/components/chat/MessagesTimeline.browser.test.tsx` · 7 total |
| [U08](#u08) | Desktop and server preview control (1/2) | W02 | mac | 15 | 2 | 2,438 | — | K8 | `apps/desktop/src/window/DesktopWindow.ts`, `apps/web/src/reopenClosedView.ts`, `apps/desktop/src/preview/Manager.ts`, `apps/desktop/src/window/DesktopWindow.test.ts` · 15 total |
| [U09](#u09) | Mobile workspace navigation and layout | W02 | mac | 25 | 2 | 1,328 | — | K12, K4, K7, M3b | `apps/mobile/src/features/threads/ThreadFeed.tsx`, `apps/mobile/src/features/threads/ThreadDetailScreen.tsx`, `apps/mobile/vite.config.ts`, `apps/mobile/src/features/threads/thread-list-v2-items.tsx` · 39 total |
| [U10](#u10) | Desktop shell, native IPC and file actions (1/2) | W02 | mac | 9 | 3 | 1,085 | — | K6b, K7, K8 | `apps/web/src/components/chat/ChatComposer.tsx`, `apps/web/src/components/ChatMarkdown.tsx`, `apps/server/src/process/externalLauncher.test.ts`, `apps/web/src/components/chat/MarkdownFileLink.tsx` · 21 total |
| [U11](#u11) | Delegated work, wake ownership and ordering (1/2) | W02 | server-only | 11 | 2 | 2,176 | — | K1, K12, K4, K6, K6b, K7, K7b, K9, SF2 | `apps/server/src/orchestration-v2/Orchestrator.ts`, `apps/server/src/orchestration-v2/ProjectionStore.ts`, `packages/contracts/src/orchestrationV2.ts`, `apps/server/src/orchestration-v2/runtimeLayer.test.ts` · 20 total |
| [U12](#u12) | OpenCode 1.x and 2.x lifecycle (1/3) | W02 | server-only | 15 | 0 | 1,817 | — | K6, K9 | `apps/server/src/orchestration-v2/ProviderSessionManager.ts`, `packages/provider-opencode/src/server/adapter.ts`, `apps/server/src/provider/ProviderRegistry.test.ts`, `packages/provider-opencode/src/server/adapter.test.ts` · 13 total |
| [U13](#u13) | Cursor SDK, interjection and fallback | W02 | server-only | 9 | 2 | 1,151 | — | SF3 | `packages/provider-cursor/src/server/adapter.ts`, `packages/provider-cursor/src/server/adapter.test.ts`, `packages/provider-cursor/src/server/CursorAgentSdk.ts`, `packages/provider-cursor/src/server/CursorAgentSdk.test.ts` · 4 total |
| [U14](#u14) | Desktop boot, readiness and updates (2/2) | W02 | mac | 4 | 2 | 1,212 | U01 | K7b, K8, N10 | `apps/desktop/src/app/DesktopApp.ts`, `apps/server/src/cloud/selfUpdate.ts`, `apps/desktop/src/app/DesktopStartupRecovery.ts`, `apps/server/src/cli/update.ts` · 12 total |
| [U15](#u15) | PR review, diff and deep links (1/2) | W03 | mac | 12 | 2 | 2,404 | — | K1, K2, K4, SF3 | `packages/client-runtime/package.json`, `packages/shared/package.json`, `packages/contracts/src/pullRequest.ts`, `apps/mobile/src/features/pull-requests/PullRequestRouteScreen.tsx` · 51 total |
| [U16](#u16) | Desktop and server preview control (2/2) | W03 | mac | 12 | 3 | 1,362 | U08 | K12, K7b, K8, N10, SF2, SF2b, TF1 | `apps/server/src/server.ts`, `apps/server/src/mcp/McpHttpServer.ts`, `apps/server/src/assets/AssetAccess.ts`, `apps/server/src/assets/AssetAccess.test.ts` · 24 total |
| [U17](#u17) | Claude adapter and startup (1/3) | W03 | server-only | 13 | 1 | 2,427 | U02 | K1, K12, K6, K6b, K7, K9, SF2, SF3, SF4 | `apps/server/src/orchestration-v2/Orchestrator.ts`, `apps/server/src/orchestration-v2/ProjectionStore.ts`, `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`, `apps/server/src/orchestration-v2/ProviderSessionManager.ts` · 18 total |
| [U18](#u18) | Worktree provisioning and clone status | W03 | mac | 14 | 4 | 2,087 | U02 | K2, K3, K4, K6, K6b, K7, K7b, K8, K9, SF3 | `apps/server/src/ws.ts`, `apps/web/src/components/ChatView.tsx`, `apps/server/src/vcs/GitVcsDriverCore.test.ts`, `apps/server/src/vcs/GitVcsDriverCore.ts` · 21 total |
| [U19](#u19) | Composer drafts, queued edits and uploads (1/4) | W03 | mac | 9 | 3 | 1,087 | — | K1, K6, K6b, K7 | `apps/server/src/mcp/OrchestratorMcpService.ts`, `apps/web/src/components/chat/ChatComposer.tsx`, `apps/server/src/mcp/OrchestratorMcpService.test.ts`, `apps/web/src/components/ComposerPromptEditorTiptap.tsx` · 30 total |
| [U20](#u20) | Mobile native input and device tooling | W03 | mac | 11 | 1 | 1,013 | — | — | `apps/mobile/src/features/threads/ThreadComposer.tsx`, `apps/mobile/vite.config.ts`, `packages/contracts/src/settings.test.ts`, `apps/mobile/src/lib/composerImages.ts` · 26 total |
| [U21](#u21) | OpenCode 1.x and 2.x lifecycle (2/3) | W03 | server-only | 2 | 1 | 2,482 | U12 | — | `packages/provider-opencode/src/server/adapter.ts`, `packages/provider-opencode/src/server/adapter.test.ts`, `apps/server/src/orchestration-v2/testkit/fixtures/index.ts` · 3 total |
| [U22](#u22) | Authentication, pairing and peer transport | W04 | mac | 29 | 22 | 2,334 | U16 | K12, K2, K3, K6, K7, K7b, K8, N10, SF2, SF2b | `apps/server/src/server.ts`, `packages/shared/package.json`, `apps/mobile/src/features/threads/ThreadComposer.tsx`, `apps/server/src/orchestration-v2/ProviderSessionManager.ts` · 45 total |
| [U23](#u23) | Git refresh, refs and source-control actions (1/3) | W04 | mac | 20 | 0 | 2,499 | U03, U15 | K1, K2, K3, K4, K6, K7, K7b, K9, SF3 | `apps/server/src/ws.ts`, `docs/user/source-control.md`, `apps/server/src/vcs/GitVcsDriverCore.test.ts`, `apps/server/src/vcs/GitVcsDriverCore.ts` · 34 total |
| [U24](#u24) | SQLite ledger, indexes and projection reads (1/2) | W04 | server-only | 8 | 8 | 1,327 | — | K1, K12, K6, K6b, K7, K7b, K9, N10, SF2, SF4 | `apps/server/src/orchestration-v2/Orchestrator.ts`, `apps/server/src/orchestration-v2/ProjectionStore.ts`, `apps/server/src/orchestration-v2/Orchestrator.control-reads.test.ts`, `apps/server/src/orchestration-v2/ProjectionStore.test.ts` · 8 total |
| [U25](#u25) | Web shell, thread navigation and search (1/2) | W04 | mac | 31 | 0 | 2,473 | — | K12, K2, K3, K4, K6b, K7, K8, SF2 | `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/ChatMarkdown.tsx`, `apps/web/src/components/CommandPalette.tsx`, `apps/web/src/components/Sidebar.tsx` · 53 total |
| [U26](#u26) | Pi extensions, sessions and generation (1/2) | W04 | mac | 15 | 3 | 2,314 | — | K1, K12, K6, K6b, K7, K7b, SF3 | `packages/contracts/src/orchestrationV2.ts`, `apps/mobile/src/lib/threadActivity.ts`, `apps/web/src/components/chat/MessagesTimeline.logic.test.ts`, `apps/web/src/session-logic.ts` · 11 total |
| [U27](#u27) | Codex sessions, models and requests (1/2) | W04 | mac | 20 | 6 | 2,313 | U17 | K6, K9 | `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`, `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts`, `docs/orchestration-v2/orchestrator-mcp-server.md`, `apps/server/src/project/AgentSessionScanner.ts` · 9 total |
| [U28](#u28) | OpenCode 1.x and 2.x lifecycle (3/3) | W04 | server-only | 1 | 0 | 93 | U21 | — | `packages/provider-opencode/src/server/adapter.ts`, `packages/provider-opencode/src/server/adapter.test.ts` · 2 total |
| [U29](#u29) | SSH config and process launching (1/2) | W05 | mac | 14 | 2 | 2,490 | U01, U10, U22 | K12, K3, K4, K7b, K8, N10, SF2 | `apps/server/src/server.ts`, `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`, `pnpm-workspace.yaml`, `apps/server/src/process/externalLauncher.test.ts` · 32 total |
| [U30](#u30) | PR lists, writes and provider scoping (1/3) | W05 | mac | 23 | 1 | 2,478 | U23 | K1, K2, K4, K6, K6b, K7, K9, SF3 | `apps/server/src/orchestration-v2/Orchestrator.ts`, `apps/server/src/orchestration-v2/runtimeLayer.test.ts`, `apps/server/src/vcs/GitVcsDriverCore.test.ts`, `apps/server/src/vcs/GitVcsDriverCore.ts` · 52 total |
| [U31](#u31) | Shared client state, connection and routing | W05 | mac | 24 | 2 | 2,011 | — | K2, K3, K6, K6b, K7, K7b, K8, K9, M3b, T3 | `apps/server/src/ws.ts`, `apps/web/src/components/ChatView.tsx`, `packages/shared/package.json`, `apps/web/src/components/ChatView.logic.ts` · 61 total |
| [U32](#u32) | ACP transports, prompting and replay (1/3) | W05 | mac | 22 | 10 | 2,456 | — | K8, K9 | `packages/provider-acp/src/server/adapter.ts`, `apps/server/src/orchestration-v2/RunExecutionService.ts`, `apps/server/src/orchestration-v2/RunExecutionService.test.ts`, `apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.test.ts` · 18 total |
| [U33](#u33) | Pi extensions, sessions and generation (2/2) | W05 | server-only | 3 | 1 | 785 | U26 | K1, K6, K6b, K7, K7b, SF3 | `packages/contracts/src/orchestrationV2.ts`, `packages/provider-pi/src/server/adapter.ts`, `packages/provider-pi/src/server/adapter.test.ts` · 3 total |
| [U34](#u34) | Dictation and native speech | W05 | mac | 5 | 2 | 2,548 | — | K2, K6b, K8 | `apps/web/src/components/chat/ChatComposer.tsx`, `apps/web/src/composerDraftStore.ts`, `packages/contracts/src/settings.ts`, `packages/contracts/src/ipc.ts` · 22 total |
| [U35](#u35) | Codex sessions, models and requests (2/2) | W05 | server-only | 1 | 0 | 269 | U27 | K9 | `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`, `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts` · 2 total |
| [U36](#u36) | Mobile thread feed, worktree and status (1/2) | W06 | mac | 23 | 1 | 1,223 | U09 | K12, K4, M3b, T3 | `apps/mobile/src/features/threads/ThreadFeed.tsx`, `apps/mobile/src/features/threads/ThreadComposer.tsx`, `apps/mobile/src/features/threads/ThreadDetailScreen.tsx`, `pnpm-workspace.yaml` · 45 total |
| [U37](#u37) | Server runtime, diagnostics and IO | W06 | server-only | 18 | 1 | 1,416 | — | K2, K3, K6, K7, K7b, K8, K9, N10, SF2 | `apps/server/src/server.ts`, `apps/server/src/ws.ts`, `packages/shared/package.json`, `apps/server/src/process/externalLauncher.test.ts` · 22 total |
| [U38](#u38) | PR watch and forge activity | W06 | mac | 12 | 1 | 1,592 | U15 | K1, K12, K2, K4, K6, K6b, K7, K9, SF2 | `apps/server/src/orchestration-v2/Orchestrator.ts`, `apps/server/src/orchestration-v2/ProjectionStore.ts`, `apps/server/src/orchestration-v2/runtimeLayer.test.ts`, `packages/contracts/src/pullRequest.ts` · 22 total |
| [U39](#u39) | Claude adapter and startup (2/3) | W06 | server-only | 19 | 5 | 2,375 | U11, U17 | K12, K6, K7, K7b, N10, SF3 | `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`, `apps/server/src/orchestration-v2/ProviderSessionManager.ts`, `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts`, `packages/contracts/src/server.ts` · 21 total |
| [U40](#u40) | ACP transports, prompting and replay (2/3) | W06 | server-only | 4 | 1 | 557 | U32 | K9 | `packages/provider-acp/src/server/adapter.ts`, `apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.test.ts`, `packages/provider-acp/src/server/mcpOverAcpBridge.ts`, `packages/provider-acp/src/server/mcpOverAcpBridge.test.ts` · 5 total |
| [U41](#u41) | SSH config and process launching (2/2) | W06 | mac | 8 | 2 | 307 | U29 | K8 | `apps/desktop/src/shell/DesktopShellEnvironment.ts`, `packages/shared/src/shell.ts`, `packages/shared/src/shell.test.ts`, `packages/contracts/src/resourceTelemetry.ts` · 12 total |
| [U42](#u42) | Terminal attach, input and platform paths (1/3) | W07 | mac | 15 | 4 | 2,422 | — | K2, K4, K7, SF2, T3 | `packages/shared/package.json`, `apps/web/src/terminal/ghostty/surface.ts`, `apps/web/src/components/ThreadTerminalDrawer.tsx`, `apps/server/src/terminal/Manager.ts` · 17 total |
| [U43](#u43) | Mobile outbox and attachment delivery (1/3) | W07 | mac | 6 | 2 | 944 | U36 | K12, K7, M3b | `apps/mobile/src/features/threads/ThreadFeed.tsx`, `apps/mobile/src/features/threads/ThreadComposer.tsx`, `apps/mobile/src/state/use-composer-drafts.ts`, `apps/mobile/src/state/use-composer-drafts.test.ts` · 24 total |
| [U44](#u44) | Desktop shell, native IPC and file actions (2/2) | W07 | mac | 5 | 0 | 295 | U29 | K8 | `apps/server/src/process/externalLauncher.test.ts`, `apps/server/src/process/externalLauncher.ts`, `apps/web/src/components/chat/McpAppFrame.tsx` · 3 total |
| [U45](#u45) | Git refresh, refs and source-control actions (2/3) | W07 | mac | 20 | 5 | 2,499 | U30 | K3, K4, K7b, K8, N10, SF2, SF3 | `apps/server/src/server.ts`, `apps/server/src/vcs/GitVcsDriverCore.test.ts`, `apps/server/src/vcs/GitVcsDriverCore.ts`, `apps/web/src/components/BranchToolbarBranchSelector.tsx` · 43 total |
| [U46](#u46) | ACP transports, prompting and replay (3/3) | W07 | server-only | 15 | 3 | 2,477 | U32 | K1, K3, K4, K6, K6b, K7, K7b, K9, SF3 | `apps/server/src/orchestration-v2/Orchestrator.ts`, `apps/server/src/ws.ts`, `apps/server/src/orchestration-v2/ProviderSessionManager.ts`, `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts` · 27 total |
| [U47](#u47) | PR lists, writes and provider scoping (2/3) | W07 | mac | 5 | 1 | 1,718 | U30 | K2 | `apps/web/src/components/pullRequest/PullRequestsPage.tsx`, `packages/contracts/src/pullRequest.ts`, `apps/web/src/components/pullRequest/PullRequestListFilters.tsx`, `apps/server/src/pullRequest/PullRequestService.ts` · 21 total |
| [U48](#u48) | Web conversation, timeline and accessibility (2/2) | W08 | mac | 39 | 2 | 2,289 | — | K12, K2, K4, K6, K6b, K7, K8, SF2 | `apps/server/src/orchestration-v2/ProjectionStore.ts`, `apps/web/src/components/ChatView.tsx`, `packages/shared/package.json`, `apps/web/src/components/ChatMarkdown.tsx` · 57 total |
| [U49](#u49) | Mobile outbox and attachment delivery (2/3) | W08 | mac | 1 | 0 | 2,201 | U43 | K7 | `apps/mobile/src/state/use-composer-drafts.test.ts`, `apps/mobile/src/state/use-thread-composer-state.ts`, `apps/mobile/src/lib/composerAttachmentUploadQueue.ts`, `apps/mobile/src/state/threadOutboxDelivery.ts` · 15 total |
| [U50](#u50) | PR lists, writes and provider scoping (3/3) | W08 | mac | 3 | 0 | 1,069 | U30 | K1, K2 | `packages/client-runtime/package.json`, `docs/user/source-control.md`, `apps/web/src/components/pullRequest/PullRequestsPage.tsx`, `apps/web/src/components/pullRequest/PullRequestListFilters.tsx` · 28 total |
| [U51](#u51) | Usage, quota and device coverage (1/2) | W08 | mac | 19 | 4 | 2,440 | — | K1, K6, K6b, K7, K8, K9 | `apps/server/src/orchestration-v2/Orchestrator.ts`, `apps/server/src/orchestration-v2/runtimeLayer.test.ts`, `packages/contracts/src/settings.ts`, `apps/server/src/serverSettings.test.ts` · 20 total |
| [U52](#u52) | Claude adapter and startup (3/3) | W08 | server-only | 7 | 1 | 1,673 | U39 | K1, K12, K4, K6, K6b, K7, K7b | `packages/contracts/src/orchestrationV2.ts`, `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`, `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts`, `apps/server/src/orchestration-v2/ProviderTurnStartService.test.ts` · 12 total |
| [U53](#u53) | Provider host, capabilities and smaller adapters (1/2) | W08 | mac | 7 | 1 | 810 | U05 | K9, SF3 | `packages/provider-acp/src/server/adapter.ts`, `packages/provider-opencode/src/server/adapter.ts`, `apps/server/src/provider/ProviderRegistry.test.ts`, `packages/provider-opencode/src/server/adapter.test.ts` · 19 total |
| [U54](#u54) | Composer drafts, queued edits and uploads (2/4) | W09 | mac | 25 | 1 | 2,449 | U19 | K2, K6b, K7, K8, K9, M3b | `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/chat/ChatComposer.tsx`, `apps/mobile/src/features/threads/ThreadComposer.tsx`, `apps/web/src/components/ChatView.logic.ts` · 65 total |
| [U55](#u55) | Environment themes and appearance | W09 | mac | 11 | 2 | 2,319 | — | K12, K2, K3, K6, K7, K7b, K8, K9, N10, SF2, SF2b | `apps/server/src/server.ts`, `apps/server/src/ws.ts`, `packages/shared/package.json`, `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` · 32 total |
| [U56](#u56) | Settings, device preferences and catalog preflight | W09 | mac | 26 | 1 | 2,459 | U36 | K12, K7, K8, M3b, SF3 | `apps/mobile/src/features/threads/ThreadFeed.tsx`, `apps/web/src/components/ChatMarkdown.tsx`, `docs/user/project-settings.md`, `apps/web/src/contextMenuFallback.ts` · 43 total |
| [U57](#u57) | Mobile outbox delivery fibers | W09 | mac | 1 | 0 | 2,835 | U49 | K7 | `apps/mobile/src/state/use-thread-composer-state.ts`, `apps/mobile/src/lib/composerAttachmentUploadQueue.ts`, `apps/mobile/src/state/threadOutboxDelivery.ts`, `apps/mobile/src/state/composer-attachment-uploads.ts` · 11 total |
| [U58](#u58) | Git refresh, refs and source-control actions (3/3) | W09 | mac | 19 | 3 | 1,625 | U18, U45 | K2, K3, K4, SF3 | `apps/server/src/vcs/GitVcsDriverCore.test.ts`, `apps/server/src/vcs/GitVcsDriverCore.ts`, `apps/web/src/components/GitActionsControl.tsx`, `apps/server/src/git/GitManager.ts` · 39 total |
| [U59](#u59) | Turn launch, resume and handoff recovery (2/2) | W09 | server-only | 5 | 2 | 2,439 | U02, U46 | K1, K12, K4, K6, K6b, K7, K9, N10, SF2 | `apps/server/src/orchestration-v2/Orchestrator.ts`, `apps/server/src/orchestration-v2/ProjectionStore.ts`, `apps/server/src/orchestration-v2/runtimeLayer.test.ts`, `apps/server/src/orchestration-v2/ProviderTurnStartService.test.ts` · 14 total |
| [U60](#u60) | Terminal attach, input and platform paths (2/3) | W10 | mac | 16 | 4 | 2,483 | U37, U42, U44 | K3, K4, K6, K7, K7b, K8, K9, N10, SF2, T3 | `apps/server/src/ws.ts`, `packages/contracts/src/server.ts`, `apps/server/src/process/externalLauncher.test.ts`, `apps/web/src/terminal/ghostty/surface.ts` · 22 total |
| [U61](#u61) | Agent tools, transport and scoped reads (1/2) | W10 | server-only | 15 | 8 | 1,899 | U24 | K1, K12, K2, K6, K6b, K7, K9, SF2 | `apps/server/src/orchestration-v2/Orchestrator.ts`, `apps/server/src/orchestration-v2/ProjectionStore.ts`, `packages/shared/package.json`, `apps/server/src/mcp/OrchestratorMcpService.ts` · 26 total |
| [U62](#u62) | Mobile outbox and attachment delivery (3/3) | W10 | mac | 1 | 0 | 1,945 | U57 | — | `packages/client-runtime/package.json`, `apps/mobile/src/lib/composerAttachmentUploadQueue.ts`, `apps/web/src/lib/attachmentUploadQueue.ts`, `apps/mobile/src/state/composer-attachment-uploads.ts` · 12 total |
| [U63](#u63) | Web shell, thread navigation and search (2/2) | W10 | mac | 6 | 0 | 1,004 | U10, U25, U48 | K3, K7, K8 | `apps/web/src/components/CommandPalette.tsx`, `apps/web/src/components/Sidebar.tsx`, `apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx`, `apps/web/src/components/Sidebar.logic.ts` · 17 total |
| [U64](#u64) | Workspace file lookup and bounded indexes | W10 | mac | 8 | 1 | 1,116 | — | K4, SF2 | `apps/web/src/state/queries.ts`, `apps/web/src/components/CommandPalette.logic.ts`, `packages/client-runtime/src/state/filesystem.ts`, `apps/server/src/workspace/WorkspaceSearchIndex.ts` · 7 total |
| [U65](#u65) | Mobile thread feed, worktree and status (2/2) | W10 | mac | 5 | 0 | 1,396 | U31, U43 | K12, M3b | `apps/mobile/src/features/threads/ThreadFeed.tsx`, `apps/mobile/src/features/threads/ThreadDetailScreen.tsx`, `apps/mobile/src/lib/threadActivity.ts`, `apps/mobile/src/features/threads/floating-working-status.ts` · 15 total |
| [U66](#u66) | Run settlement, queues and persisted effects | W11 | mac | 18 | 6 | 2,046 | U39 | K1, K12, K4, K6, K6b, K7, K7b, K9, SF2 | `apps/server/src/orchestration-v2/Orchestrator.ts`, `apps/server/src/orchestration-v2/ProjectionStore.ts`, `packages/contracts/src/orchestrationV2.ts`, `apps/server/src/orchestration-v2/runtimeLayer.test.ts` · 33 total |
| [U67](#u67) | Terminal attach, input and platform paths (3/3) | W11 | mac | 5 | 3 | 715 | U60 | K3, K4, K6, K7, K7b, K8, K9, SF2, T3 | `apps/server/src/ws.ts`, `packages/contracts/src/settings.ts`, `packages/contracts/src/settings.test.ts`, `apps/web/src/terminal/ghostty/surface.ts` · 22 total |
| [U68](#u68) | Launcher, installation and development tooling | W11 | mac | 31 | 11 | 2,203 | U29, U46, U55 | K1, K12, K2, K4, K6, K6b, K8, N10, TF1, TF1 nits | `docs/user/source-control.md`, `apps/server/src/vcs/GitVcsDriverCore.test.ts`, `apps/server/src/provider/agentContextBudget.json`, `pnpm-workspace.yaml` · 27 total |
| [U69](#u69) | PR review, diff and deep links (2/2) | W11 | mac | 11 | 1 | 1,858 | U38, U47 | K1, K2 | `packages/client-runtime/package.json`, `packages/contracts/src/pullRequest.ts`, `apps/mobile/src/features/pull-requests/PullRequestRouteScreen.tsx`, `apps/web/src/components/pullRequest/PullRequestCodeTab.tsx` · 34 total |
| [U70](#u70) | Issues • GitHub core | W12 | server-only | 1 | 1 | 4,805 | U18, U31, U38, U45, U46, U55, U67 | K1, K2, K3, K4, K6, K7, K7b, K8, K9, N10, SF2 | `apps/server/src/server.ts`, `apps/server/src/ws.ts`, `packages/contracts/src/issue.ts`, `apps/server/src/issue/IssueService.ts` · 23 total |
| [U71](#u71) | Scheduling, firing receipts and task controls | W12 | mac | 10 | 3 | 1,123 | U61 | K1, K12, K4, K6, K7, SF3, SF4 | `apps/server/src/mcp/OrchestratorMcpService.ts`, `apps/server/src/provider/agentContextBudget.json`, `apps/server/src/mcp/OrchestratorMcpService.test.ts`, `apps/mobile/vite.config.ts` · 14 total |
| [U72](#u72) | Composer drafts, queued edits and uploads (3/4) | W12 | mac | 15 | 0 | 2,442 | U25, U43, U54 | K2, K6b, K8 | `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/chat/ChatComposer.tsx`, `apps/mobile/src/features/threads/ThreadComposer.tsx`, `apps/web/src/components/ChatView.logic.ts` · 42 total |
| [U73](#u73) | Workspace paths, link rendering and media | W12 | mac | 20 | 1 | 1,957 | U44, U48 | K12, K4, K7, K8, M3b, SF2, SF2b, TF1 | `apps/mobile/src/features/threads/ThreadFeed.tsx`, `apps/server/src/vcs/GitVcsDriverCore.test.ts`, `apps/server/src/vcs/GitVcsDriverCore.ts`, `apps/web/src/components/ChatMarkdown.tsx` · 36 total |
| [U74](#u74) | Checkpoint integrity and worktree retention (1/2) | W12 | server-only | 3 | 1 | 1,287 | U66 | K1, K12, K4, K6, K6b, K7, K9, SF2 | `apps/server/src/orchestration-v2/Orchestrator.ts`, `apps/server/src/orchestration-v2/ProjectionStore.ts`, `apps/server/src/orchestration-v2/runtimeLayer.test.ts`, `apps/server/src/vcs/GitVcsDriver.ts` · 7 total |
| [U75](#u75) | Catalog check before localization | W12 | mac | 1 | 0 | 96 | U67 | K9, TF1 | `apps/mobile/src/features/settings/SettingsRouteScreen.tsx`, `package.json`, `scripts/i18n-check.ts`, `.github/workflows/ci.yml` · 32 total |
| [U76](#u76) | Web file editor and diff rendering | W13 | mac | 15 | 3 | 2,274 | — | K1, K12, K2, K4, K6, K6b, K7, K7b, K8 | `packages/contracts/src/orchestrationV2.ts`, `pnpm-workspace.yaml`, `packages/contracts/src/pullRequest.ts`, `apps/web/src/components/pullRequest/PullRequestCodeTab.tsx` · 20 total |
| [U77](#u77) | Checkpoint integrity and worktree retention (2/2) | W13 | server-only | 13 | 8 | 2,146 | — | K12, K4, K6, K7, SF2, SF3, SF4 | `apps/server/src/orchestration-v2/ProjectionStore.ts`, `apps/server/src/vcs/GitVcsDriverCore.test.ts`, `apps/server/src/vcs/GitVcsDriverCore.ts`, `apps/server/src/vcs/GitVcsDriver.ts` · 14 total |
| [U78](#u78) | Agent tools, transport and scoped reads (2/2) | W13 | server-only | 12 | 7 | 1,006 | U18, U19, U71 | K1, K12, K4, K6, K7, K9, SF3 | `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`, `apps/server/src/mcp/OrchestratorMcpService.ts`, `apps/server/src/provider/agentContextBudget.json`, `apps/server/src/mcp/OrchestratorMcpService.test.ts` · 16 total |
| [U79](#u79) | Issues • web shell | W13 | mac | 1 | 1 | 3,112 | U04, U50, U56, U62, U63, U69, U70, U72 | K1, K2, K3, K7b, K8, N10 | `packages/client-runtime/package.json`, `docs/user/source-control.md`, `packages/contracts/src/issue.ts`, `apps/web/src/components/CommandPalette.tsx` · 37 total |
| [U80](#u80) | Composer drafts, queued edits and uploads (4/4) | W13 | mac | 3 | 0 | 256 | U72 | — | `apps/mobile/src/state/use-composer-drafts.ts`, `apps/web/src/composer-rich-text-doc.ts`, `apps/web/src/composer-rich-text-doc.test.ts`, `apps/mobile/src/state/threadOutboxDelivery.test.ts` · 6 total |
| [U81](#u81) | Provider host, capabilities and smaller adapters (2/2) | W14 | mac | 19 | 3 | 2,321 | U04 | K1, K12, K2, K6, K6b, K7, K7b, K8, K9, SF2, SF3 | `apps/server/src/orchestration-v2/ProjectionStore.ts`, `apps/web/src/components/ChatView.tsx`, `packages/contracts/src/orchestrationV2.ts`, `apps/web/src/components/chat/ChatComposer.tsx` · 30 total |
| [U82](#u82) | Issues • GitLab, Azure and Forgejo trackers | W14 | server-only | 1 | 1 | 3,790 | U58, U70 | K1, K2 | `docs/user/source-control.md`, `apps/server/src/issue/IssueService.ts`, `packages/source-control-azure-devops/src/shared/definition.ts`, `packages/source-control-forgejo/src/shared/definition.ts` · 20 total |
| [U83](#u83) | Delegated work, wake ownership and ordering (2/2) | W14 | server-only | 4 | 0 | 479 | U66 | K1, K6, K6b, K7, K9 | `apps/server/src/orchestration-v2/Orchestrator.ts`, `apps/server/src/mcp/OrchestratorMcpService.ts`, `apps/server/src/mcp/OrchestratorMcpService.test.ts`, `apps/server/src/orchestration-v2/Orchestrator.control-reads.test.ts` · 7 total |
| [U84](#u84) | Document, archive and HTML previews | W14 | mac | 20 | 3 | 1,209 | U22 | K4, K8, SF2, SF2b, TF1 | `apps/server/src/assets/AssetAccess.ts`, `apps/server/src/assets/AssetAccess.test.ts`, `apps/web/src/components/chat/MarkdownFileLink.tsx`, `apps/web/src/components/files/FilePreviewPanel.tsx` · 23 total |
| [U85](#u85) | Issues • thread links and MCP | W15 | mac | 1 | 1 | 2,059 | U12, U33, U51, U52, U59, U68, U73, U74, U76, U77, U78, U79, U81, U82, U83 | K1, K12, K2, K4, K6, K6b, K7, K7b, K8, K9, N10, SF2 | `apps/server/src/orchestration-v2/Orchestrator.ts`, `apps/server/src/orchestration-v2/ProjectionStore.ts`, `apps/server/src/server.ts`, `apps/web/src/components/ChatView.tsx` · 47 total |
| [U86](#u86) | LegendList measurement backports | W15 | mac | 2 | 0 | 160 | — | K12, K4, M3b | `apps/mobile/src/features/threads/ThreadFeed.tsx`, `pnpm-lock.yaml` · 2 total |
| [U87](#u87) | Issues • Linear adapter and binding | W16 | mac | 1 | 1 | 3,010 | U34, U64, U75, U85 | K1, K2, K3, K4, K6, K7, K7b, K8, K9, M3b, N10, SF2, SF3, SF4, TF1, TF1 nits | `apps/server/src/server.ts`, `apps/server/src/ws.ts`, `packages/client-runtime/package.json`, `docs/user/source-control.md` · 49 total |
| [U88](#u88) | Issues • mobile shell | W17 | mac | 1 | 0 | 4,014 | U20, U65, U87 | K2, M3b | `packages/client-runtime/package.json`, `apps/mobile/src/features/threads/ThreadComposer.tsx`, `apps/mobile/src/features/threads/ThreadDetailScreen.tsx`, `apps/web/src/components/issue/IssuesPage.tsx` · 55 total |
| [U89](#u89) | Usage, quota and device coverage (2/2) | W17 | mac | 3 | 1 | 749 | — | K4 | `apps/server/src/usage/UsageLimitSources.ts`, `apps/server/src/usage/UsageLimitSources.test.ts`, `apps/mobile/src/widgets/subscriptionUsageSnapshot.ts`, `apps/mobile/src/widgets/SubscriptionUsage.android.tsx` · 5 total |
| [U90](#u90) | SQLite ledger, indexes and projection reads (2/2) | W17 | server-only | 1 | 1 | 120 | U87 (Linear edge only if adopted) | K12, K6, N10, SF2, SF4 | `apps/server/src/orchestration-v2/ProjectionStore.ts`, `apps/server/src/persistence/Migrations.ts`, `apps/server/src/persistence/reconcileV2PreviewMigration.test.ts` · 3 total |
| [U91](#u91) | Issues • filters and sorting | W18 | mac | 1 | 1 | 3,009 | U88 | K2, M3b | `packages/contracts/src/issue.ts`, `apps/server/src/issue/IssueService.ts`, `apps/server/src/issue/IssueService.test.ts`, `apps/web/src/components/issue/IssuesPage.tsx` · 61 total |
| [U92](#u92) | Issues • tracker states, settings and follow-up reads (1/2) | W19 | mac | 3 | 1 | 2,465 | U91 | K1, K12, K2, K8, M3b | `packages/client-runtime/package.json`, `docs/user/source-control.md`, `packages/contracts/src/issue.ts`, `apps/server/src/issue/IssueService.ts` · 61 total |
| [U93](#u93) | Issues • tracker states, settings and follow-up reads (2/2) | W20 | mac | 7 | 1 | 798 | U92 | K2, K7b, K8, N10, SF2 | `apps/server/src/server.ts`, `packages/contracts/src/issue.ts`, `apps/server/src/issue/IssueService.ts`, `apps/server/src/issue/IssueService.test.ts` · 40 total |
| [U94](#u94) | Whole-app localization | W21 | mac | 1 | 1 | 67,026 | W1–W20 complete or dispositioned | K12, K2, K3, K4, K6, K6b, K7, K7b, K8, K9, M3b, N10, SF3, T3, TF1 | `apps/web/src/components/ChatView.tsx`, `packages/client-runtime/package.json`, `packages/shared/package.json`, `apps/mobile/src/features/threads/ThreadFeed.tsx` · 490 total |

## Carried branch evidence

Published or local refs were read as Git objects using the pinned integration base and a three-dot diff. For unpublished work, path forecasts use the named commits and files in the records branch. Forecasts must be replaced with the actual landing delta before dispatching a dependent lane. P1 is device/integration proof. K7b, K12 and M3b are included where their recorded work can touch a new writer.

| Carried lane | Branch or forecast | Touches |
|---|---|---|
| K1 | origin/chase/t3-261114-next3-k1-pr-watch at dddbf74933a (46 files changed, 1939 insertions(+), 277 deletions(-)) | PR watch reactor and GitHub event feeds |
| K4 | origin/chase/t3-261114-next3-k4-checkpoints at 41ca8cee395 (66 files changed, 4559 insertions(+), 620 deletions(-)) | Checkpoints, Git/worktree and shared terminal lease, including #829 source |
| K7 | origin/chase/t3-261114-next3-k7-client-protocol at 5205cbb69ec (82 files changed, 4815 insertions(+), 842 deletions(-)) | Socket and subscription recovery, command-id retry and contracts |
| SF3 | origin/chase/t3-261114-next3-sf3-providers at 8115ee46389 (34 files changed, 1522 insertions(+), 188 deletions(-)) | Provider and text-generation fixes, including #183 source |
| T3 | origin/chase/t3-261114-next3-t3 at fb3997a356e (10 files changed, 157 insertions(+), 27 deletions(-)) | Terminal errors through server, web and mobile |
| K2 | No branch tip available; 8/8 named source/port commits available for path forecast | PR links, Code tab and stored drafts |
| K3 | No branch tip available; 4/4 named source/port commits available for path forecast; plan-based path projection | Branch-only subscriptions after K7 |
| K6 | origin/chase/t3-261114-next3-k6 at 2e0d7809989 (31 files changed, 989 insertions(+), 393 deletions(-)); 6/6 named source/port commits available for path forecast | Run queue and persisted events |
| K8 | No branch tip available; 10/10 named source/port commits available for path forecast; plan-based path projection | SSH, keep-awake and desktop shell |
| K9 | chase/t3-261114-next3-k9 at 9d118df1d48 (27 files changed, 697 insertions(+), 238 deletions(-)); 5/5 named source/port commits available for path forecast | Session auth, MCP launch, provider import and Codex forks |
| N10 | origin/chase/t3-261114-next3-n10-service-release at cbd0a4a2d2d (57 files changed, 2917 insertions(+), 729 deletions(-)); 16/16 named source/port commits available for path forecast; plan-based path projection | N10-1 and N10-2 service, runtime update and release |
| SF2 | origin/chase/t3-261114-next3-sf2 at 4fbddd1b25c (12 files changed, 409 insertions(+), 51 deletions(-)); plan-based path projection | GOAT runtime and storage issue set, including per-image authorization |
| SF4 | chase/t3-261114-next3-sf4 at c776171a80c (7 files changed, 283 insertions(+), 21 deletions(-)); plan-based path projection | Schedule first-run binding and proposed migration 158 |
| TF1 | origin/chase/t3-261114-next3-tf1 at 6def29ca359 (20 files changed, 292 insertions(+), 108 deletions(-)) | Dev runner, seeded state, test grouping and goat-ci tooling |
| K7b | No branch tip available; 5/5 named source/port commits available for path forecast; plan-based path projection | Resumable shell and provider-catalog protocol work after K7 |
| K12 | No branch tip available; 1/1 named source/port commits available for path forecast | Deferred Claude/runtime item and timeline port |
| M3b | No branch tip available; plan-based path projection | Deferred M3 mobile navigation and app-switcher follow-up |
| K6b | No branch tip available; 2/2 named source/port commits available for path forecast | Deferred explicit Steer and bound model late binding after K6 |
| SF2b | No branch tip available; plan-based path projection | Project membership before probing unrelated remote assets |
| TF1 nits | No branch tip available; plan-based path projection | Per-batch test list verification and dev-runner help follow-up |

Keep the coordinator’s carried merge order K7 → K4 → K1 when ready together, and T3 after K7 and K4’s terminal changes. The latest coordinator ledger puts K6b after K6 and SF2b after SF2. TF1 is on the local integration head and still tracked at the requested pinned origin base. N10 includes its two service/release pieces. If goat#3579 is cut separately, include its browser-preview and packaging path claim before a conflicting dispatch. K11 device-only verification stays in the integrated pass. Use the source range and path forecast for SF2 pending its actual branch, especially AssetAccess, storage cleanup and workspace indexing. Recheck all carried drift independently of the lane plan.

## Decision and migration gates

- #1001 gates U70, U79, U82, U85, U87, U88, U91, U92, U93. Declining it defers the Issue-only portions of all these rows with a recorded reason. #1005 separately controls the Linear adapter/binding; adapt tracker-neutral downstream changes without Linear if declined. #1009’s tracker-native workflow states gate visibility. Mixed PR/mobile rows #1016, #1024, #1026 and #1075 retain their independent GOAT behavior.
- #39 and #904 govern agent theme writes/CSS and wallpapers respectively. If accepted, use skipped upstream follow-ups as design references for required final limits and background identity. #1036 similarly uses the #1150 manual-run guard as acceptance for the decided behavior. These references create zero standalone skip-row work.
- #1138 follows the preflight #1026 and all accepted behavioral ports. For the flagged oversized rows, stage the work inside their sole owner. Review every >3,000-line row and every C4 and carried overlap separately per audit. A second reviewer will use the seeded 30-row sample from 000_plan.md.

At the integration pin, apps/server/src/persistence/Migrations.ts:269–279 already gives these IDs to GOAT. Follow devlog/_chase/010_fork_delta.md:300 and the ledger reconciler rather than reusing an occupied ID. The coordinator appoints one allocator for the full ordered set, accounting for SF4’s proposed 158 and N10 preflight. The reported upstream numbers are collision labels, not assigned GOAT IDs.

| Upstream ID | Row and owner | Upstream migration | GOAT occupant |
|---:|---|---|---|
| 090–091 | #42 (recheck selects dialog hunk only; no migration) | AuthConnectDevices, AuthConnectDeniedRequests | ServerActivityIndexes, RemoteReports |
| 092 | #397 / U24 | QueuedTurnInputIndexJsonValid | RemoteDispatches |
| 093 | #484 / U24 | ProviderTurnAttemptIndex | ChannelLedger |
| 094 | #526 / U24 | TurnItemMessageOrdinalIndex | RemoteDispatchQuestions |
| 095 | #739 / U24 | TurnItemInlineWorkOutput | ThreadRunResults |
| 096 | #815 / U24 | RepairStaleTitleRegeneration | RemoteReportRelay |
| 097 | #1005 / U87 | IssueTrackerBindings | ProjectionTurnItemRequestIndex |
| 098 | #1033 / U90 | ActiveShellIndexIndexes | Memory |

#374 (U24) edits existing migration 026 with no new ID. #868 (U24) changes the current-schema check and must stay compatible with the reconciliation. #1033 (U90) can proceed after the preceding accepted IDs if #1005 is declined and the ledger owner signs off on the allocation.

## Lane briefs

### U01

**Desktop boot, readiness and updates (1/2)** · W01 · mac · 2,450 estimated handwritten changed lines

- Build on GOAT desktop identity and N10’s approved durable launcher state. Preserve the old-backend HTTP readiness fallback and staged-provider sequencing. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — desktop-identity, ssh-runtime, cli-home, ci.
- Exercise retryable startup errors, failed download and rollback. Cover WSL distro/automount and platform-specific package behavior as applicable.
- **C4 before code** — rows #31, #179, #182, #351, #499, #510, #529, #713. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (4 source paths) — `packages/contracts/src/server.ts`, `packages/contracts/src/ipc.ts`, `packages/contracts/src/environment.ts`, `packages/contracts/src/resourceTelemetry.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K8 (`apps/server/src/server.ts`), N10 (`apps/server/src/server.ts`), K7b (`apps/server/src/server.ts`), SF3 (`packages/provider-cursor/src/server/adapter.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 31 | 88d4d06ea32 | adapt | **C4** | **Contracts.** GOAT starts initial provider probing inline (managedProvider.ts:451) and has additional desktop startup and control hooks. Defer probes to readiness, retain HTTP fallback for old backends, and coordinate WSL startup with 5d589547f0e. |
| 59 | e5835c993a6 | adapt | C3 | GOAT’s archive staging assumes Windows-to-WSL translation succeeds (DesktopWslEnvironment.ts:809–817). Stream the archive into the selected distro when drive mounts are disabled and preserve GOAT runtime names, hash verification and cleanup. |
| 102 | cee16bdd99e | take | C1 | Insert WSL --cd ~ before --exec so the backend starts in Linux home. The GOAT argv regression anchor is DesktopBackendConfiguration.test.ts:254. |
| 179 | 9ff435b060f | adapt | **C4** | Extend GOAT’s backup-space check (serviceLauncher.ts:221) with a launch/restart preflight for the DB/restore target, state and runtime filesystems. Defer restarts while space is low and route log errors through GOAT’s guarded diagnostics, preserving rollback. |
| 182 | 5958d00ede9 | adapt | **C4** | **Contracts.** Stage eligible boot-service runtimes during provider installation and defer restart until installs finish. Capability-gate the staging flag so older servers cannot restart early, retaining GOAT update authorization and drain/confirmation. |
| 351 | c03498e6890 | adapt | **C4** | **Contracts.** DesktopRemoteUpdates.ts:162 rejects an already prepared request, and DesktopAppUpdate.ts:122 always treats the current request ID as the install token. Recover the original token on a matching retained download without extending its lease, and keep the telemetry field optional for mixed versions. |
| 361 | 7c52ef7401c | adapt | C2 | main.ts:3–5 handles only broken pipe on console streams. Extend the scoped stdio handler to known full-disk and quota errors while preserving the real error path for other failures and the existing GOAT startup imports. |
| 499 | 2cc4b4888e7 | adapt | **C4** | GOAT still publishes a checking state during refresh (DesktopUpdates.ts:483) and already has its own prepared-install wait. Retain same-version offers and move download admission behind a running check, together with the later refresh changes in `83f35dac5c2`. |
| 510 | 0b308312d53 | adapt | **C4** | GOAT's Cursor adapter carries interrupted prompts at adapter.ts:310. Port native resume for checkpointed runs and replay dropped prompts, rebasing and reviewing the SDK patch and lockfile for GOAT's auth, attribution, shell and cloud boundaries. |
| 515 | 48a383ca6fe | take | C1 | An offered version at desktopUpdate.logic.ts:104 can be retryable after a failed download. Surface the existing failure tooltip for available status as well as error status. |
| 529 | c1a7ce362b8 | adapt | **C4** | Requires `2cc4b4888e7`. The manual check handles no-update and errors at DesktopApplicationMenu.ts:68–81. Surface the available and downloaded states with GOAT branding and existing gated updater actions. |
| 621 | 32a6a7f70b6 | take | C2 | Desktop bootstrap retries HTTP statuses at auth.ts:302 but drops the wrapped network failure. Include transport errors in the existing bounded retry. |
| 627 | e3c7c082cfe | take | C2 | DesktopLocalEnvironmentAuth.ts:17 gives startup auth 15 seconds while individual requests can consume most of that window. Extend the bounded transient retry to 60 seconds. |
| 684 | 7f575e6328e | take | C1 | ResourceTelemetryDiagnostics.logic.ts:20 traverses Electron's child processes without exempting depth-zero telemetry roots. Preserve the backend root when Electron is collapsed. |
| 713 | ca0ca710457 | adapt | **C4** | **Contracts.** DesktopUpdates.ts:1318 supports switching from a policy-blocked channel, but GOAT has no channelBlockedByPolicy field for ipc.ts:312 to preserve. Expose the equivalent distinction in GOAT's updater state and verify blocked Nightly can still offer Stable. |
| 717 | 5d589547f0e | adapt | C3 | DesktopBackendConfiguration.ts:410 probes the staged CLI by executing it before actual startup. Resolve the WSL runtime environment once and preserve GOAT's mounted-runtime fallback, endpoint reload and Windows readiness semantics. |
| 785 | 3e7f5ecc55c | take | C1 | The recoverable-renderer branch gives up after the attempt ceiling at :846–851. Delay recovery until the budget opens and retain the destroyed-window guard. |

### U02

**Turn launch, resume and handoff recovery (1/2)** · W01 · mac · 2,339 estimated handwritten changed lines

- Preserve checkpoint-before-provider-write, GOAT launch provenance and exact command replay. Capability-gate native Resume if approved. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — orchestrator-goat-modules, delegated-tasks, launch-watch.
- Test older receipts, refused native resume, stop/restart distinctions, provider handoff and unaccepted image replay.
- **C4 before code** — rows #159, #258. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (1 source paths) — `packages/contracts/src/orchestrationV2.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K6 (`apps/server/src/orchestration-v2/Orchestrator.ts`), K1 (`apps/server/src/orchestration-v2/Orchestrator.ts`), K6b (`apps/server/src/orchestration-v2/Orchestrator.ts`), K7 (`apps/server/src/orchestration-v2/Orchestrator.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 34 | 4bab2f3ae71 | adapt | C3 | GOAT captures the baseline synchronously (RunExecutionService.ts:821) and has separate launch/worktree preparation (ThreadLaunchService.ts:1324–1356). Overlap only pre-prompt work and preserve baseline-before-provider-write, GOAT’s Claude helpers, and error precedence with bf9b8b78458 and 4ffa1da7cfe. |
| 159 | 9e19b7f7e1a | decide · pending d1 | **C4** | d1 recommendation — port native-only Resume with explicit unsupported-provider path. **Contracts.** Requires `4bab2f3ae71`. GOAT Resume still submits synthetic text (useComposerResume.ts:141, resume-thread.ts:95). Should Resume become native-only where supported, with an explicit send for unsupported providers and replay only for a request the provider never received? |
| 204 | 0acca1de27f | adapt | C3 | Requires `9e19b7f7e1a`. GOAT already checks manual continuation admission at `apps/server/src/orchestration-v2/Orchestrator.ts:5142` but lacks upstream's unsent-source helper. Port with native Resume and compare the latest accepted attempt to the steering restart before deciding whether to resend the replacement prompt and images. |
| 258 | 719042d9425 | adapt | **C4** | **Contracts.** `apps/server/src/orchestration-v2/ThreadLaunchService.ts:1267` and `apps/server/src/mcp/OrchestratorMcpService.ts:3191` send the first prompt after the create receipt. Atomically create the first run for fresh local launches, preserve replay and reused-thread behavior, strip client-supplied server fields, and retain GOAT provenance and delegation policy. |
| 347 | 2e331341862 | adapt | C2 | The provider switch at Orchestrator.ts:6877–6888 misses inherited portable-fork items and does not treat a detached target ref as requiring full context. Restore inherited history at the full-context boundary for both switch paths, extracting shared logic to stay within GOAT's Orchestrator budget. |
| 359 | 8cbaf750558 | adapt | C3 | TurnItemPositionStore.ts:60 returns any existing ordinal even when an accepted run differs from the original steer target. Reassign an out-of-range position only when it becomes owned by the new run, preserving pending submission order and transaction consistency. |
| 377 | 4d47d0b76ec | adapt | C3 | Orchestrator.ts:5362–5371 can regenerate any first-message title, including the explicit title GOAT's launch tool derives at OrchestratorMcpService.ts:636–638. Distinguish purposeful names from GOAT placeholders and user seeds without breaking fork and side-chat title behavior. |
| 391 | 7d4f2423754 | adapt | C2 | GOAT already covers interrupted and cancelled runs at StoppedEarlierTurn.ts:15–21, but :79 and ProviderTurnStartService.ts:614–621 still match only the active attempt and root. Include superseded attempts and rolled-back runs while preserving restart-continuation adoption and the GOAT notice. |
| 533 | 8be0e6c8ebf | adapt | C2 | ProviderTurnStartService.ts:1154 rebuilds the running run on a restart. Preserve the run's original start time while retaining the new attempt's time. |
| 1029 | c2eb8f3369d | adapt | C3 | Existing GOAT handoff recovery is the prerequisite substitute; prove equivalence for the exact retry cases. The GOAT retry helper carries summaries only (goat/ProviderTurnHandoffRecovery.ts:205). Replay eligible unsent images once, exclude already accepted or covered ones, and include 33892dcc711 so fresh-Claude fallback inherits the same attachments. |
| 1117 | 81fd06998c6 | adapt | C2 | Restart emits a context-handoff record at line 4951, but appends the steering row without reserving a preceding timeline ordinal at line 5016. Project the handoff as a durable turn item immediately before that steer, using GOAT's stable IDs and existing restart path. |

### U03

**K3 refresh coalescing and first follow-up** · W01 · server-only · 399 estimated handwritten changed lines

- Land #94 then #119 together in the first coordinated follow-up batch after K3. Preserve K7 negotiation, raw-cwd refresh sharing, immediate HEAD observation and stale-detail fencing. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — contracts-rpc-leaves, ssh-runtime.
- Run VcsStatusBroadcaster concurrency and branch-only subscriber cases before #237, #365 or #676.
- Refresh against the carried landing delta. Main overlapping claims — K3 (`apps/server/src/vcs/VcsStatusBroadcaster.ts`), K7. The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 94 | 4c473155380 | adapt | C2 | Land as the prerequisite immediately before #119 in the K3 follow-up batch. GOAT’s refreshStatus independently starts a local refresh (VcsStatusBroadcaster.ts:527–531). Share the one subsequent refresh for overlapping callers, keeping raw-cwd policy scope, cancellation, and error delivery. |
| 119 | a3477a5dd93 | adapt | C2 | K3 ruling. This is the first follow-up; #94 supplies the required coalescing preimage in the same batch. Requires `4c473155380`. The detail path publishes via updateCachedLocalStatus (VcsStatusBroadcaster.ts:269). Publish the cheap HEAD observation immediately, fence older results and reconcile detail within GOAT’s refresh lane. |

### U04

**Composer pickers and model selection** · W01 · mac · 1,219 estimated handwritten changed lines

- Keep GOAT composer footer, provider settings and model seed precedence. Distinguish blank query from inactive trigger. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — composer-footer, settings-page.
- Test environment switches, explicit picks, keyboard/pointer, empty results and old settings.
- Refresh against the carried landing delta. Main overlapping claims — K2 (`apps/web/src/components/ChatView.tsx`), K6b (`apps/web/src/components/ChatView.tsx`), K8 (`apps/web/src/components/ChatView.tsx`), SF3 (`apps/web/src/modelSelection.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 112 | ac180919a67 | adapt | C2 | GOAT already persists modelSelectionExplicit (composerDraftStore.ts:227), but ChatView still gives seeds precedence (ChatView.tsx:1260,2597). Apply the existing flag consistently across composer, handoff, links and new drafts. |
| 174 | 820f620e3d6 | adapt | C2 | Requires `ac180919a67`. Reconcile model traits only for the same resolved model and provider instance, including aliases and catalog/custom slugs. Apply this after GOAT’s seed-versus-explicit precedence because the model derivation is split into composerModelState.ts:46. |
| 509 | 0983ab3e732 | adapt | C2 | ModelPickerContent.tsx:457 moves focus after provider selection and ProviderModelPicker.tsx:347 opens on the search input. Keep touch focus on the popup while preserving keyboard search on fine-pointer clients. |
| 770 | cb251b9abc1 | adapt | C2 | ComposerCommandMenuLayer.tsx:50-52 imposes a 96 px minimum even when the viewport clips it, and autocomplete.tsx:195 cannot shrink with the container. Keep suggestion rows scrollable in GOAT's short-window geometry, including when stash is open. |
| 786 | 256dce7f1f6 | adapt | C3 | Title lookup searches only the active environment (web :165, mobile :412). Search the reachable linked environments through the current client queries and preserve GOAT's thread-link format and reachability policy. |
| 799 | 16ff4b45ee8 | adapt | C3 | The shared parser special-cases fully typed /model at :78–114. Keep a complete no-argument command selectable, and reconcile current web/mobile slash-model consumers before removing that trigger kind. |
| 853 | 506a0438a31 | adapt | C3 | modelSelection.ts:276–292 restricts temporary catalog gaps to three drivers. Retain explicit Pi/ACP model and traits without mistaking inherited aliases for real options, and check GOAT's extra live-catalog providers and mobile model flow. |
| 920 | c69f4b780bd | take | C1 | GOAT flattens every model per provider instance (ModelPickerContent.tsx:538–545). Dedupe by instance and slug before assigning shortcuts, preserving separate configured instances. |

### U05

**Attachment extraction and transcript ingest** · W01 · server-only · 1,039 estimated handwritten changed lines

- Keep GOAT’s bounded document worker and project-scoped imports. Certify only exact imported sequences and preserve literal text and Unicode. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — office-archive-split, code-budgets.
- Exercise moved and partial transcripts, malformed formats, XML whitespace, RTF controls and interrupted retries.
- **C4 before code** — rows #316. Bring the two-way compatibility and negative-case note to the coordinator.
- Refresh against the carried landing delta. Main overlapping claims — K9 (`apps/server/src/project/AgentSessionImporter.test.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 164 | 91fa913be9c | adapt | C2 | A retry currently reads no stored messages before recertifying a changed transcript (AgentSessionImporter.ts:268). Require exact role/text sequence equality before writing completion metadata for an existing thread. |
| 171 | 13f89ae0a7f | take | C1 | Completion markers currently match runtime cwd to the project root (AgentSessionImporter.ts:197). Resolve them by projected project ownership so already imported worktree transcripts stop crowding out older sessions. |
| 316 | d109866c631 | adapt | **C4** | Guest uploads store an attachment and return without document extraction (GuestShareService.ts:420–421); rollback at line 375 deletes only the upload. Use the host DocumentText service for guest-owned staged files and remove generated sidecars on rollback, retaining guest scope and limits. |
| 329 | 73fb6cd0092 | take | C1 | The RTF control-word map at documentTextWorker.ts:351 skips joiners and direction marks. Add the four Unicode mappings so plain-text attachments keep their original shaping and direction. |
| 344 | 2854038b61a | adapt | C2 | The XML parser uses boolean mode flags at documentTextWorker.ts:43 and the text walker omits the no-break hyphen at line 108. Add DOCX-aware visible deletion handling and retain U+2011 through ancestor and cell-content checks, reconciling the later DOCX/ODF extractor edits. |
| 350 | 16c66605e68 | take | C1 | Shared strings, inline strings and values are read as ordinary XML text at documentTextWorker.ts:541–545. Decode SpreadsheetML escaped UTF-16 units once, preserving escaped literal _xHHHH_ and leaving formulas unchanged. |
| 360 | 889485c6fa9 | take | C1 | Requires `16c66605e68`. GOAT currently sends raw spreadsheet values through the generic value path (documentTextWorker.ts:545). After the escaped-text commit, format only explicit boolean cells with 0 or 1 as false or true. |
| 393 | baf25580173 | adapt | C2 | Requires `2854038b61a`. GOAT passes an explicit ODF flag at documentTextWorker.ts:447 and has its own XML shape. Collapse paragraph whitespace across spans while preserving explicit ODF spaces, tabs and line breaks. |
| 542 | bc91203bc32 | adapt | C2 | Requires `13f89ae0a7f`. The AlreadyImported branch increments the count at AgentSessionImporter.ts:224–226. Cached and recovered imports should dedupe without incrementing the newly created thread count. |
| 577 | 14a60e85e52 | adapt | C2 | Requires `bc91203bc32`. The scanner at AgentSessionScanner.ts:1591 currently handles a parsed thread without distinguishing a genuinely empty transcript. Exclude empty sessions from failure and count budgets while preserving unreadable rewind history and the byte cap, alongside later `db4221b74b3`. |
| 578 | bbd8bc074a9 | take | C2 | ThreadFind.ts:322 takes a query-keyed snapshot and the loop at :457 rebuilds documents as Find text changes. Cache one bounded rendered snapshot with revision, lineage, cwd and options invalidation. |
| 918 | db4221b74b3 | take | C1 | The scanner counts bookkeeping toward the record limit (AgentSessionScanner.ts:851–853). Cap retained records instead and preserve independent byte budgets and Claude window handling. |
| 1079 | cc8593e06d8 | take | C1 | The truncation marker is appended directly at `documentTextWorker.ts:681`. Drop a stranded high surrogate before adding the marker. |
| 1116 | 3d7b74a7ea3 | adapt | C1 | GOAT selects ODF parsing via a flag (`documentTextWorker.ts:43`, `:447`). Discard ODF-only comments in its close hook and preserve the formula semantics exception plus existing DOCX and EPUB handling. |
| 1118 | e9dc20d063e | adapt | C1 | Adapt the document waiters test in GOAT’s DocumentTextConcurrency.test.ts and prove the second waiter is attached before interrupting the first. The exact leaving/staying cancellation fixture is absent. GOAT's document test at `apps/server/src/provider/userInputAttachments.test.ts:43` uses an extraction barrier for a different scenario. [recheck: adapt, see /tmp/chase1118/triage-recheck.md] |
| 1127 | 7b4478895da | take | C1 | RTF suppresses generic header/footer destinations but misses the first/left/right variants in the control list ending at line 397. Add the six destinations without dropping real body text. |
| 1131 | 959c4c1ecf0 | take | C1 | PPTX extraction walks descendants named sldId at line 565, including extension/custom-show references. Count only presentation slide-list children in relationship order. |
| 1136 | 08f324988ef | adapt | C1 | The extractor handles tab but not ptab at line 107 and has separate compatibility-fallback deduplication at line 71. Normalize positional tabs without outputting both the compatibility choice and fallback tab. |

### U06

**iOS gallery and Quick Look** · W01 · mac · 1,687 estimated handwritten changed lines

- Gate the native gallery on #805 while preserving document Quick Look and existing downloads. Keep the applicable standalone data-URI correction. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — mobile-sheet-header, desktop-identity.
- Test progressive originals, slow opens, paging and dismissal using iOS and an older-server fixture.
- Refresh against the carried landing delta. Main overlapping claims — K7 (`packages/client-runtime/src/mediaSource.ts`), K12 (`apps/mobile/src/features/threads/ThreadFeed.tsx`), M3b (`apps/mobile/src/features/threads/ThreadFeed.tsx`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 504 | d022d3bd8be | adapt | C3 | GOAT presents URL-resolved images through its Quick Look bridge (FilePreviewModal.tsx:78 and FilePreview.ios.tsx:37). Port identifier-scoped close/reopen and slow paging with `295a0a7332a`, which replaces upstream’s Quick Look image-gallery implementation while retaining the completion protocol. |
| 805 | 295a0a7332a | decide · pending d1 | C3 | d1 recommendation — port iOS gallery and retain Quick Look for documents. Requires `d022d3bd8be`. GOAT uses Quick Look for images and documents (docs/internals/mobile-navigation.md:69–73). Should GOAT replace image Quick Look with a dedicated iOS gallery that opens from the thumbnail and loads originals progressively? |

### U07

**Web conversation, timeline and accessibility (1/2)** · W01 · mac · 838 estimated handwritten changed lines

- Preserve GOAT Reply and hidden-tool/delegated grouping, stable streamed identity and existing behavior while #412 is pending. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — reply-to-response, delegated-tasks, composer-footer.
- Check live and paged history, exact whitespace, queue and accessibility outcomes at the screen.
- Refresh against the carried landing delta. Main overlapping claims — K8 (`apps/web/src/components/ChatMarkdown.browser.test.tsx`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 1056 | 0b3ebcf268e | adapt | C3 | Preserve leading spaces in rendered user-authored lines without changing mixed list/code or assistant semantics. Integrate with the shared pipeline and GOAT copy, search, accessibility, and native rendering paths; omit upstream's absent scenarios harness. |
| 1102 | 68108be900a | adapt | C1 | The user preview at line 111 only compacts whitespace. Resolve quote and context-chip text before parsing user Markdown, preserve GOAT reply/citation formats, and retain the capped assistant parse. |

### U08

**Desktop and server preview control (1/2)** · W02 · mac · 2,438 estimated handwritten changed lines

- Use GOAT preview broker, Cua Driver, screen-code and human-input gates. Preserve popup/tab ownership, same-host uploads and metadata-only capture. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — screen-code, cua-driver, cua-human-input, desktop-identity.
- Exercise renderer crash and handoff, slow consumer, stop/teardown, bounded screenshots and denied file or input requests.
- **C4 before code** — rows #105, #369. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (1 source paths) — `packages/contracts/src/previewAutomation.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K8 (`apps/desktop/src/preview/Manager.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 7 | 5df5b44309c | adapt | C2 | GOAT still drives tab operations through the original page (ServerBrowser.ts:2257–2273). Recover a crashed renderer while preserving GOAT tab ownership and control, and isolate the headless service-worker badging workaround in context setup. |
| 27 | 9d8998b436f | take | C1 | GOAT registers/removes the KWin reply object during each call (main.rs:151–152) and connects without the object installed (:368). Patch checks cleanly; install the listener at connection time and retain sender validation. |
| 44 | a37715c1e7e | adapt | C3 | GOAT currently starts reload/navigation directly (Manager.ts:1888–1891, ServerBrowser.ts:2257–2273). Add a bounded pre-navigation recovery probe to both engines, preserving pending JavaScript dialogs and GOAT’s screen-control handoff. |
| 105 | 089318005dc | adapt | **C4** | **Contracts.** The browser page still throws a generic busy error at capture (ServerBrowserPage.ts:497). Report the operation deadline and pending stages through GOAT’s broker while preserving screen-code and frame handling. |
| 124 | 248f5b64ccb | take | C1 | Popups should inherit the opener’s stored emulated color scheme when adopted by the server browser (ServerBrowser.ts:1039). |
| 158 | 651accb1000 | adapt | C3 | New server previews use defaults but the open helper overwrites saved appearance and zoom (openPreviewSession.ts:54). Restore saved values when present and reapply zoom after viewport changes. |
| 202 | 8a45c51d8b2 | adapt | C2 | `apps/desktop/src/preview/Manager.ts:2314` captures directly. Give each still capture a short render lease and bounded paint confirmation through GOAT's owned debugger, and distinguish best-effort captures when paint freshness is unconfirmed. |
| 253 | 68bc28196d0 | adapt | C2 | `apps/desktop/src/window/DesktopWindow.ts:1012` may send main-preload commands to the focused fallback window. Route Settings and main commands to the registered main renderer and preserve splash, quitting, and activation behavior. |
| 263 | 313f601fb23 | adapt | C2 | Requires `5df5b44309c`. `apps/server/src/preview/ServerBrowser.ts:428` reads a title after navigation, but same-document title changes have no watcher. Add a bounded-title, isolated-world observer scoped to the current document and deduplicate reports around GOAT history, crash recovery, and teardown. |
| 271 | 0c6f421f3c1 | take | C2 | `apps/desktop/src/preview/Manager.ts:1233` writes controller state and waits on every input. Publish ownership transitions, keep one idle worker per guest, and preserve recording cursor updates and GOAT's human-input policy. |
| 283 | 45ff3f59679 | adapt | C3 | `apps/desktop/src/preview/Manager.ts:881` acknowledges frames immediately while `apps/desktop/src/preview/CdpRelay.ts:295` fans them out. Pace native ACKs with one outstanding and one latest skipped frame per session, including detach/stop cleanup and GOAT stream ownership. |
| 358 | 6fc2fb192c9 | adapt | C2 | PreviewView.tsx:192–201 reads server navigation even for a locally rendered desktop tab. Project native navigation into the overlay and prefer non-idle native state for desktop-owned rendering, preserving server ownership and initial loading fallback. |
| 369 | 47a8f2ba923 | take | **C4** | ChromiumCookies.ts:183–184 reads metadata and cookie rows immediately, and Sources.ts:347–348 counts rows directly. Probe only the schema first so an empty Chromium jar yields zero without changing key handling or the Firefox path. |
| 406 | 34db335ed56 | take | C2 | Manager.ts:3056 and :3070 use a millisecond-only ID and an overwritable write. Production hunks apply cleanly with a UUID suffix and exclusive creation; adjust the test fixture context. |
| 428 | ed101ef641f | adapt | C3 | Requires `313f601fb23`. The manager deletes the session at Manager.ts:437 and the web client starts unmounting at closePreviewSession.ts:25. Unload while the native guest is still mounted, including pending opens and idle-slot reclamation, and preserve the screen-code hooks. |

### U09

**Mobile workspace navigation and layout** · W02 · mac · 1,328 estimated handwritten changed lines

- Use GOAT stack and native-tab wiring, activated-tab identity, sheet/header model and linked/disabled states. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — mobile-sheet-header, composer-footer, code-budgets.
- Check Duo/fold, both native navigators, back/undo, keyboard and tab-bar safe area on a device.
- **C4 before code** — rows #42, #863. Bring the two-way compatibility and negative-case note to the coordinator.
- Refresh against the carried landing delta. Main overlapping claims — M3b (`apps/mobile/src/features/threads/ThreadFeed.tsx`), K7 (`apps/mobile/src/features/home/useThreadListActions.ts`), K12 (`apps/mobile/src/features/threads/ThreadFeed.tsx`), K4 (`pnpm-lock.yaml`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 23 | 6b47939e606 | adapt | C2 | The project filter maps existing scope order in GOAT (HomeScreen.tsx:772, ThreadNavigationSidebar.tsx:229). Reuse recent-activity scope sorting across both Home entry points and the thread sidebar. |
| 42 | a2edd281df2 | adapt | **C4** | Recheck narrows scope to Android Dialog replacement dismissal and useForkThread settlement. Keep the original C4 label as listed in 001; Connect migrations remain disabled. Optional device approval belongs to the disabled Connect flow (CloudLink.ts:502). If revived, remap upstream auth migrations 090/091 against GOAT-owned IDs beginning at 90 (Migrations.ts:268 onward) and preserve GOAT’s authorization and session-ended handling. [recheck: adapt, see /tmp/chase1118/triage-recheck.md] |
| 121 | 00ec286fef2 | adapt | C2 | GOAT passes SVG data URLs directly to the image loader (ProjectFavicon.tsx:204). Resolve supported light/dark CSS against the app appearance before rendering and preserve GOAT request and cache behavior. |
| 189 | bc1dc2a81ee | adapt | C2 | The thread uses only safe-area insets and ignores the fold after the split column is positioned (ThreadDetailScreen.tsx:1265, reserved-regions.ts:40). Reserve the real occluded region for content and controls without counting it twice. |
| 223 | b28dc0eb1d8 | take | C1 | `apps/mobile/src/features/review/useReviewDiffData.ts:152` includes the changing diff hash in its reuse scope. Keep checkout and base identity stable so unchanged rows can reuse parsed data. |
| 285 | 86ec940ad3e | take | C1 | `apps/mobile/src/features/home/useThreadListActions.ts:179` invalidates the older Undo before archive or delete succeeds. Move invalidation below successful completion so a refusal preserves the prior Undo. |
| 341 | fa4f6441a66 | adapt | C2 | GOAT implements recents in useAppShortcuts.ts:48–123, where persisted and active entries are accepted without checking saved environments. Filter and persist after the catalog becomes ready, and exclude visits from subsequently removed environments. |
| 380 | 9db3cb10916 | adapt | C2 | The native stack marks a disappearing top card as a candidate Back at createV5StackNavigator.ios.tsx:219–235, and the collapsed split projection carries the same assumption (workspace-stack-projection.ts:115–123). Clear that marker for a full-screen cover that reveals no underlying card, keeping real Back and cancelled swipes. |
| 461 | 635ea82cec6 | adapt | C1 | The hide condition still requires !workspacePage at createWorkspaceStackNavigator.ios.tsx:534. Hide the bottom dock for a pushed compact detail even when opened from Usage while preserving GOAT split-view and native dismissal handling. |
| 518 | f5dd9c1ce7f | adapt | C1 | Android touch gets simultaneous list scrolling at thread-swipe-actions.tsx:510, which can close a diagonal row swipe. Keep the simultaneous gesture for iPad trackpad use and verify the Android gesture on GOAT's row. |
| 548 | d93b2250491 | adapt | C2 | The picker passes the group title to the favicon at NewTaskRouteScreen.tsx:519, and pending rows override the project's title at thread-list-v2-items.tsx:195. Use the concrete project for the icon fallback and keep group labels for navigation. |
| 712 | 154c0fd3112 | adapt | C1 | ThreadUndoNotice.tsx:52 ignores the measured bottom bar inset on the folded layout. Use GOAT's bar metric and retain keyboard clearance. |
| 720 | 9de4a2fb5d7 | adapt | C2 | The scrollers at :93 and :74 rely on contentInset plus fixed padding. Use GOAT's bottom obstruction metric as actual scroll-content padding so controls clear the floating tabs. |
| 724 | 278e47dee24 | adapt | C1 | The upstream WorkspaceRootScreen path is absent, while createWorkspaceStackNavigator.ios.tsx:242 owns Duo behavior in GOAT. Reserve the sidebar's own measured tab obstruction so the last row scrolls clear in folded portrait. |
| 753 | 1b14aade4de | take | C1 | checkout-new-task-branch.ts:34 trusts a stale current flag. Refresh checkout state in local mode while retaining the early return for a worktree action. |
| 793 | 073989f022d | adapt | C1 | Requires `bc1dc2a81ee`. GOAT sets the right indicator inset to the bleed at :136–140. Remove the extra horizontal inset so the indicator can reach the screen edge while preserving GOAT's content positioning; check fold invalidation from ab8ff33a16c alongside it. |
| 801 | 64e7e236e2f | adapt | C1 | At :420 compactness depends on a request prop although row height is measured at :486. Keep GOAT's gesture semantics and size the visible actions to the measured row at supported text sizes. |
| 806 | 1d74a172d5d | adapt | C1 | Port inner layout invalidation in showsCompose to GOAT’s native tab bar. The compact-state change already requests a real tab-bar layout in GoatSidebarTabBarView.swift:41–45. [recheck: adapt, see /tmp/chase1118/triage-recheck.md] |
| 862 | d6e574f7db2 | adapt | C2 | Requires `64e7e236e2f`, `f5dd9c1ce7f`. HomeScreen.tsx:844 animates list layout only on its sidebar surface; thread-swipe-actions.tsx:335 shrinks height on the UI thread. Have the list close the gap promptly in both surfaces while preserving undo and GOAT swipe behavior. |
| 863 | f6ef6c1f286 | adapt | **C4** | Adapt the final native-tab behavior against GOAT’s fork and keep About build metadata separate. GOAT mounts content only after activation at WorkspaceNativeTabs.ios.tsx:63–67 on its t3.51 fork pin. Port the final first-visit mount/selection protocol with stable keys and selective prewarming, keeping GOAT tab boundaries; handle the independent About build-number hunk separately. |
| 880 | ab8ff33a16c | adapt | C1 | Requires `073989f022d`. GOAT's native view relayouts on its own trait change and reads that view's bar edge (GoatScrollEdgeBleedView.swift:27,99). Port the invalidation only where the authoritative window traits or safe-area change can arrive later, and keep GOAT's native module identity. |
| 946 | 25c06e571e3 | adapt | C1 | GOAT moved the file but still passes pre-encoded segments to Linking.createURL (workspace-selection-store.ts:156). Build the prefix first and append each encoded segment once so restored agent-started thread IDs survive. |
| 1024 | 0ff1495c053 | adapt | C2 | Keep the GOAT Duo width fix independent of the Issue sidebar. The medium Duo still uses generic column limits (layout.ts:153; createWorkspaceStackNavigator.ios.tsx:374). Keep enough room for the sidebar in GOAT's iOS portrait split and derive width and toolbar bounds from its own layout and rail. |
| 1092 | 705c7f2479d | adapt | C2 | The Git list and manual-pairing form use `contentInset` at lines 271 and 379 respectively. Apply bottom safe-area padding on Android using GOAT sheet tokens and retain GOAT's separate Connect availability policy. |
| 1094 | 3fdd9fc80cc | take | C2 | The hook at line 153 toggles using connected targets alone. Pass known environments so temporarily offline selections survive and the all-known sentinel stays correct. |

### U10

**Desktop shell, native IPC and file actions (1/2)** · W02 · mac · 1,085 estimated handwritten changed lines

- Keep GOAT main-process authority. Under #923 validate device-local paths and originating surface. Preserve file-manager and WSL conversion semantics. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — desktop-identity, peer-links, contracts-rpc-leaves.
- Test unauthorized remote paths, old preload, Finder drag and real Windows Reveal behavior where applicable.
- **C4 before code** — rows #70, #117, #923. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (1 source paths) — `packages/contracts/src/ipc.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K8 (`apps/web/src/components/ChatMarkdown.tsx`), K6b (`apps/web/src/components/chat/ChatComposer.tsx`), K7 (`apps/web/src/components/ChatMarkdown.tsx`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 64 | 37714a8de5e | adapt | C2 | GOAT’s reveal path uses PowerShell even for stock Windows (externalLauncher.ts:548,586). Use the fast direct Explorer path only when the combined replacement-handler checks in 580b526758c establish that it is safe to do so. |
| 67 | 6bc105f04e8 | take | C1 | GOAT searches for the exact Toolbox script name in its platform directories (editor.ts:101,113,155). The patch checks cleanly and adds numeric-suffix discovery. |
| 68 | 580b526758c | adapt | C2 | Requires `37714a8de5e`. GOAT’s normal Windows folder open chooses Explorer (externalLauncher.ts:537–538), and reveal inspects only Directory (:548). Honor shell handlers registered for Directory, Drive or Folder and use matching detection for the fast path in 37714a8de5e. |
| 70 | eea9d15ee27 | adapt | **C4** | **Contracts.** GOAT’s picker already translates a selected folder (ipc/methods/window.ts:241–247), but composer drops only distinguish local from remote (folderDrop.ts:13–23). Resolve paths against the selected WSL backend, preserve remote rejection, and prevent stale async insertion. |
| 82 | 2c61677d59b | adapt | C2 | GOAT’s overlay viewports leave Electron draggable areas intercepting dismiss clicks (command.tsx:40–45, dialog.tsx:86–93, sheet.tsx:41–46). Apply only the drag-region fix to GOAT primitives and preserve it with 2afee520252’s later media dialog changes. |
| 117 | a760a3a9657 | adapt | **C4** | **Contracts.** Electron still receives source-free popup options (ElectronMenu.ts:262). Pass an optional keyboard origin through the bridge and both markdown menus while retaining GOAT’s link permissions. |
| 354 | 2abf7be914c | take | C1 | RightPanelTabs.tsx:824–826 leaves gaps in the overflowing tab scroller inside Electron's draggable region. Make that scroll surface no-drag only when it owns the title bar and overflows. |
| 523 | 1c8143cd09f | take | C1 | probeRemoteEditors at window.ts:341 probes candidates serially while shared shell.ts:540 already supplies the PATH listing cache. Apply bounded concurrency and retain discovery order. |
| 923 | fb89ce1680b | decide · pending d1 | **C4** | d1 recommendation — port local macOS Finder drag. **Contracts.** GOAT's web file chips already resolve host paths (MarkdownFileLink.tsx:73), and this adds desktop IPC. Should local macOS GOAT Desktop support dragging file chips into Finder, with main-process validation of actual device-local paths and authorized surfaces? |

### U11

**Delegated work, wake ownership and ordering (1/2)** · W02 · server-only · 2,176 estimated handwritten changed lines

- Keep GOAT explicit reports, bounded keyed work and restart holds. Monitor progress and terminal wake settlement have different scope. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — delegated-tasks, orchestrator-goat-modules, decision-routing, remote-reports.
- Replay duplicate/late child reports, old unstamped tasks, failed preceding runs and independent busy coordinators.
- **C4 before code** — rows #16, #937. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (1 source paths) — `packages/contracts/src/orchestrationV2.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K6 (`apps/server/src/orchestration-v2/Orchestrator.ts`), K1 (`apps/server/src/orchestration-v2/Orchestrator.ts`), K12 (`apps/server/src/orchestration-v2/ProjectionStore.ts`), K6b (`apps/server/src/orchestration-v2/Orchestrator.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 2 | 931cd3afab3 | adapt | C3 | GOAT still drains the whole wake buffer (ClaudeAdapterV2.ts:9820) and rejects every Monitor notification for follow-up (OrchestratorRunState.ts:30). Distinguish Monitor updates from terminal outcomes, split adjacent wakes, and reconcile with later Monitor changes 52451a7909c and a5c28da6c8b. |
| 16 | aaa3dbabb1f | adapt | **C4** | **Contracts.** GOAT only checks follow-up subagents (RestartBackgroundNote.ts:228–235 and OrchestratorMcpService.ts:1321). Port wake attribution and completion holding with b79d277cdda’s run ownership, so work from an older or unrelated run cannot hold the follow-up. |
| 53 | 2a21f411a3a | adapt | C2 | GOAT still selects related tasks by status alone (ProviderTurnStartService.ts:1276–1277). Route only provider-native descendants through the parent so app-owned delegated items are ingested on their own run. |
| 90 | 9d6da455e20 | adapt | C2 | GOAT excludes every runtime-reconcile event from follow-up synchronization (Orchestrator.ts:13060–13067). Admit held queued runs linked to a delegated task so recovery removes stale parent Working state. |
| 823 | e367ef0da11 | adapt | C2 | The delegated-child terminal hook at :13252 offers every parent wake. Restrict lookup to tasks for that child and offer their owning run IDs while retaining GOAT's wake routing. |
| 825 | 5374e2d19ce | adapt | C2 | The queue at :336–339 awaits handling inline. Keep FIFO within a thread and scoped, bounded processing across threads so that a blocked parent does not hold all continuation wakes. |
| 827 | 5da89cfceba | adapt | C2 | Requires `e367ef0da11`. The terminal reaction at Orchestrator.ts:13076 can wait on a parent lock. Preserve each thread's event order without blocking other threads, implementing the shared runner with ad1b1365999. |
| 837 | ad1b1365999 | adapt | C3 | Requires `5374e2d19ce`, `5da89cfceba`. KeyedLock.ts:56 only exposes locking, and upstream's question and worktree reactor paths are absent. Use scoped, bounded keyed execution in GOAT's reactors, keeping question wake and cancel ordered by coordinator. |
| 901 | c02b98bb3fd | adapt | C3 | A completed Codex run currently drops the stop reason (CodexAdapterV2.ts:5617). Carry it as a warning notice and include it in GOAT's completion-read projections for empty delegated replies without changing the terminal status. |
| 937 | b79d277cdda | adapt | **C4** | **Contracts.** Requires `aaa3dbabb1f`. The reactor tracks whether a provider thread as a whole ceased holding background work (Orchestrator.ts:13040–13045). Attribute tasks to originating runs in both projection paths and wake per task exit for delegated follow-ups, preserving original-task waits and older unstamped payload compatibility. |
| 1049 | 135d7a98012 | adapt | C3 | Provider failure applies a blanket queue hold at Orchestrator.ts:1235–1239. Let eligible buffered provider output wake without a fresh prompt while retaining worktree/capability holds and existing GOAT notification/wake ordering. |

### U12

**OpenCode 1.x and 2.x lifecycle (1/3)** · W02 · server-only · 1,817 estimated handwritten changed lines

- Apply each row to the correct GOAT adapter. Keep child report attribution, question ownership and prompt admission separate from root settlement. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — orchestrator-goat-modules, delegated-tasks.
- Test skipped reports, late background activity, context window, dismissal after root terminal and Stop.
- Apply the shared cross-version gate to any public schema delta. Contract footprint (1 source paths) — `packages/contracts/src/agentSurface/entries/background.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K6 (`apps/server/src/orchestration-v2/ProviderSessionManager.ts`), K9 (`packages/provider-core/src/server/ProviderAdapter.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 3 | b35819caca8 | adapt | C2 | GOAT still links calls with joined (adapter.ts:966,1917–1942). Associate calls with the child run and its completed answer so a later report settles skipped earlier calls, including the answer-boundary follow-up in 1fe416ae404. |
| 21 | eb14ddb7992 | adapt | C2 | GOAT’s 1.x adapter accumulates step usage and finishes the provider turn without a catalog-based context window (adapter.ts:1827,3294). Preserve last-step context and catalog limits through the background-turn refactor e68d4f053bb. |
| 96 | 6d94997008f | adapt | C3 | **Contracts.** GOAT already has the scoped wait tool (handlers.ts:132–135), but OpenCode 2 publishes its roster without an awaited comparison (adapter.ts:838–848). Carry the flag through shell ownership, restoration and ancestor rosters, and use GOAT’s prompt/tool metadata. |
| 97 | aecad62a508 | adapt | C2 | GOAT’s OpenCode 1.x adapter reconciles failed admission using a status query (adapter.ts:1904–1919,3336). Fit the uncertainty and sequencing checks within the GOAT code budget and carry them into e68d4f053bb’s background-wake refactor. |
| 99 | 83d238218d8 | adapt | C2 | GOAT derives completion immediately from the task part (adapter.ts:1210). Hold only 1.x detached launches until child idle, error or interruption, preserving GOAT child routes and the v2 adapter. |
| 234 | 5fa95d99af9 | adapt | C1 | The parser moved to `packages/provider-opencode/src/server/openCodeServerUrl.ts:2` and still inspects an unfinished final line. Match only completed listening lines so a split port cannot trigger an early connection. |
| 235 | 35483c198a7 | adapt | C1 | `packages/provider-opencode/src/server/v2/adapter.ts:1289` emits retry warnings as generic errors while :1758–1759 already distinguish 402 in terminal classification. Share the classifier across retry and terminal events while preserving GOAT's 402 exclusion. |
| 352 | 8bd7f466ccd | adapt | C1 | GOAT moved retention into ProviderModelRetention.ts:34–60, where only installed Codex warning probes retain incomplete inventory. Add the OpenCode warning case there so cached models and related metadata survive a cold empty probe, keeping policies for other drivers. |
| 458 | fb915ca6c01 | adapt | C3 | OpenCode 2 emits only the parent tool item at adapter.ts:637. Recover nested published pages by call input in publish order, using GOAT's HTML tool name and stable IDs to suppress replay duplicates. |
| 617 | 2123168a556 | adapt | C2 | driver.ts:634 currently falls back only when the OpenCode 2 response is absent. Try legacy Go-key usage for unsupported limits and keep GOAT's usage-scope normalization. |
| 802 | 03e05f6235c | adapt | C3 | Ingestor :364–393 dismisses every pending item when the owning turn settles. Carry the adapter's retained child request IDs across both terminal event forms and use GOAT's question/routing tests. |
| 807 | af8faa9cfa9 | take | C2 | Requires `03e05f6235c`. form.reject at adapter.ts:4010 sends no message. Keep background child execution alive on dismissal while preserving the meaning of root cancellation. |
| 943 | 1fe416ae404 | take | C2 | Requires `b35819caca8`. The inbox branch handles delivered steers but lacks the in-turn background report path (v2/adapter.ts:2150–2158). Preserve the preceding answer as final and emit the report visibly, with the new test adapted to GOAT's fixture ordering. |
| 957 | 5adbd28d465 | adapt | C2 | GOAT's bounded driver read sends host cwd to OpenCode 2 (driver.ts:495). Omit location for an external default catalog, preserving local cwd, explicit directory reads, cancellation and GOAT's bound. |
| 986 | 907ff258e07 | adapt | C1 | The goal refresh path currently addresses unreadable updates (adapter.ts:2101,2505). On idle, refresh an apparently held goal once, apply only its current revision and re-evaluate settlement after a confirmed result. |

### U13

**Cursor SDK, interjection and fallback** · W02 · server-only · 1,151 estimated handwritten changed lines

- Keep provider session and bounded logs in GOAT’s SDK adapter. Scope #634 to non-memory operations, and honor #1115’s pending rollback decision.
- Test timeout/refusal at create and send, older runtime, active tools and memory sandbox denial.
- **C4 before code** — rows #634, #1115. Bring the two-way compatibility and negative-case note to the coordinator.
- Refresh against the carried landing delta. Main overlapping claims — SF3 (`packages/provider-cursor/src/server/adapter.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 252 | 34a7c0d85d6 | take | C2 | SDK discovery builds entries without aliases at `packages/provider-cursor/src/server/status.ts:174`; carry nonempty trimmed aliases into each model. |
| 277 | c2b06f9df84 | adapt | C1 | `apps/server/src/provider/EventNdjsonLogger.ts:247` lacks a Cursor-specific transient filter. Drop direct and wrapped streaming deltas from logging only, preserving lifecycle records and GOAT's other provider filters. |
| 300 | 8871c265a2b | adapt | C1 | GOAT moved cursorToolFailed to toolPresentation.ts:18, where a successful SDK shell response falls through to false regardless of exitCode. Mark nonzero exits failed there and keep stdout/stderr presentation. |
| 459 | 77c9e705559 | take | C2 | Cursor's recognized transport diagnostic is passed only as cause at adapter.ts:1980 and appears generic in the fixture at adapter.test.ts:347. The clean patch keeps the recognized diagnostic as the failure message. |
| 462 | 1c01db02b3d | adapt | C2 | The completion path at adapter.ts:1182–1221 backfills a Task child only after the work ends. Route nested text, thinking and tool updates live to the child and fill gaps from stable IDs at completion without duplicating saved steps. |
| 502 | d3217c75f26 | take | C1 | The adapter already exposes compactThread at adapter.ts:2131. Advertise the existing slash command in both Cursor status constructors. |
| 615 | 4c9a87309df | adapt | C2 | Add the tightly scoped SDK-stall classification to GOAT's existing known-rejection handling near CursorSdk.ts:23–29. Keep unrelated aborts on the existing fatal path. |
| 634 | 64a481c2af8 | decide · pending d1 | **C4** | d1 recommendation — port non-memory send-time sandbox fallback. Cursor textGeneration.ts:196–220 falls back only on sandbox setup rejection during create and requires a sandbox for memory. Should GOAT extend the existing non-memory sandbox fallback to send-time rejection while keeping memory generation sandbox-required? |
| 1115 | 13ecf5b22ee | decide · pending d1 | **C4** | d1 recommendation — skip the private checkpoint-head rewrite. Should GOAT enable Cursor Edit from here through a private SDK checkpoint-head rewrite when native rollback is currently disabled (`packages/provider-cursor/src/server/status.ts:29`)? |

### U14

**Desktop boot, readiness and updates (2/2)** · W02 · mac · 1,212 estimated handwritten changed lines

- Build on GOAT desktop identity and N10’s approved durable launcher state. Preserve the old-backend HTTP readiness fallback and staged-provider sequencing. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — desktop-identity, ssh-runtime, cli-home, ci.
- Exercise retryable startup errors, failed download and rollback. Cover WSL distro/automount and platform-specific package behavior as applicable.
- **C4 before code** — rows #838, #969. Bring the two-way compatibility and negative-case note to the coordinator.
- Refresh against the carried landing delta. Main overlapping claims — N10 (`apps/server/src/cloud/selfUpdate.ts`), K8 (`apps/desktop/src/updates/DesktopUpdates.ts`), K7b (`packages/client-runtime/src/state/runtime.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 838 | 83f35dac5c2 | adapt | **C4** | Requires `2cc4b4888e7`. Download uses the cached offer at DesktopUpdates.ts:553–595 and startup recovery pins the original version at DesktopStartupRecovery.ts:149. Refresh the selected channel under the action lock and honor GOAT's paused policy, restart admission and exact-version callers. |
| 928 | acddfae5139 | adapt | C2 | Bootstrap returns early when the local environment is disabled (DesktopApp.ts:203–209), while launcher install currently lives in backend configuration (DesktopBackendConfiguration.ts:859). Refresh the internal GOAT launcher on that early branch and keep user-owned command links untouched. |
| 969 | f68d9704fc9 | adapt | **C4** | GOAT's staged CLI validation only checks --version before repointing the launcher (cli/update.ts:598–649). Reuse the service's staged database/launcher preflight for GOAT runtime switches, preserving installed-runtime reuse, GOAT home selection and rollback behavior. |
| 1107 | 74b1f97ce9e | adapt | C3 | Access and Settings search share a 30-second revalidation policy (`desktopWslState.ts:46`). Give Access a zero-stale mount policy on the same cache, using `packages/client-runtime/src/state/runtimeRevalidation.ts:18`. |

### U15

**PR review, diff and deep links (1/2)** · W03 · mac · 2,404 estimated handwritten changed lines

- Start from K2’s routed anchors and PR Code tab. Keep actual revision/file identity, permission boundaries and forge-specific behavior. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — pr-event-feeds, resizable-width, contracts-rpc-leaves.
- Test force-push and refetch, withheld diff identity, link reveal from all entry points, and mobile navigation.
- **C4 before code** — rows #198, #647. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (1 source paths) — `packages/contracts/src/pullRequest.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K2 (`packages/shared/package.json`), K4 (`apps/server/src/git/GitManager.ts`), K1 (`apps/server/src/orchestration-v2/PullRequestSyncReactor.ts`), SF3 (`apps/server/src/git/GitManager.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 49 | 67699df3d12 | take | C2 | The patch applies cleanly over GOAT’s per-file diff reads (AzureDevOpsPullRequestProvider.ts:232–235). Preserve archive and blob size caps and per-file fallback, then coordinate with 1a12c4afae9 and 3883ed544c3. |
| 91 | 058eea9246f | adapt | C3 | GOAT’s renderer gates reactions at the PR level (PullRequestSummaryTab.tsx:584; usePullRequestPermissions.ts:57). Gate by GitCafe comment kind on both clients and retain permitted reactions and existing counts. |
| 198 | 1159aa29911 | adapt | **C4** | `packages/client-runtime/src/pullRequestMarkdown.ts:168` segments the body before resolving reference definitions. Carry first definitions into media-separated Markdown and preserve task edit offsets, adding the parser dependencies through GOAT's catalog. |
| 292 | c342f3dec2c | adapt | C3 | The web menu offers Watch on any open PR (panel:333), while Orchestrator.ts:2781 refuses settled or archived threads. Share eligibility with mobile (useLinkedPullRequestActions.ts:41) and keep Stop watching available. |
| 310 | 0d585f77107 | take | C2 | The summary counts only failure (pullRequestStatus.ts:92), and the feedback action uses the same narrow condition (PullRequestStatusRows.tsx:125–126). Use one failure-or-cancelled predicate for both. |
| 312 | 49eb9c8adc7 | adapt | C2 | Shared ranking just enumerates groups at projectGrouping.ts:385–393 and both pickers use it. Pass actual pin and archive metadata through GOAT's selectors and apply pickableProjectGroups before ranking. |
| 318 | abac6837e95 | take | C2 | GitLabCli.ts:480–513 reads one small unqualified source-branch page and the provider omits the existing headBranchProbe hook. Fetch enough candidates with bounded output and pagination, then let the existing head-repo match disambiguate same-named fork branches. |
| 322 | 284fb237a52 | take | C1 | The create detector only matches glab mr create at definition.ts:66. Accept the new alias in that same detector so existing link tracking sees the command. |
| 325 | 69525bf8955 | take | C1 | The numeric-only branch at line 673 drops every textual match on a different PR number. Keep the exact-number boost and let other numeric queries use ordinary title/description scoring. |
| 401 | ea05ea5e2af | adapt | C3 | PullRequestSyncReactor.ts:499 backs off only not-found and GitManager.ts:185 only bounds the PR cache. Back off unsupported or unreadable hosts and cap background branch lookups while preserving GOAT forge routing; combine with failure backoff follow-up a10f9e41d37. |
| 417 | 62a51e26a4a | adapt | C3 | K2 owns both pre-range PR deep-link foundations. Wait for its actual receiving head. GOAT's PR code tab has review-comment anchoring at PullRequestCodeTab.tsx:661–662 but no incoming-anchor parser. Port the deep-link foundation with GitLab Rapid Diff and classic hashes, removed-line selection and commit IDs across web and mobile. |
| 647 | f12e8206f56 | adapt | **C4** | **Contracts.** PullRequestService.ts:3125–3134 caches only paged diffs today. Add a capability-gated path read with distinct cache keys, bounded GitHub extraction and GOAT-native web/iOS/Android load and truncation states. |

### U16

**Desktop and server preview control (2/2)** · W03 · mac · 1,362 estimated handwritten changed lines

- Use GOAT preview broker, Cua Driver, screen-code and human-input gates. Preserve popup/tab ownership, same-host uploads and metadata-only capture. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — screen-code, cua-driver, cua-human-input, desktop-identity.
- Exercise renderer crash and handoff, slow consumer, stop/teardown, bounded screenshots and denied file or input requests.
- **C4 before code** — rows #430, #450, #631. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (2 source paths) — `packages/contracts/src/ipc.ts`, `packages/contracts/src/previewAutomation.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K8 (`apps/server/src/server.ts`), SF2 (`apps/server/src/server.ts`), K12 (`apps/server/src/mcp/McpHttpServer.ts`), K7b (`apps/server/src/server.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 430 | ff17cd307fc | adapt | **C4** | **Contracts.** DesktopBrowserHost.ts:277 sends a capture before the webview confirms full-detail drawing. Add a bounded renderer acknowledgment across Electron IPC and preserve GOAT capture, cursor and recording behavior. |
| 450 | 5c85e93f0f2 | adapt | **C4** | **Contracts.** Requires `089318005dc`. ServerBrowser.ts:1957 always takes the image path even for text-only MCP calls. Allow metadata-only agent snapshots with real frame dimensions while keeping PNG for save/image, existing timeout reporting and GOAT screen-code capture. |
| 583 | f00afc6cda5 | adapt | C2 | ServerBrowserPage.ts:792–817 resolves implicit focus through Playwright's utility world. Resolve it in the main world under the existing deadline and preserve GOAT's dispatch gate, pinned targets, range input and single-send rules. |
| 605 | 98f885ac1aa | take | C2 | ServerBrowserContexts.ts:333 uses the default CDP upload path even for the same-host desktop browser. Enable local path upload only on that existing local attach path. |
| 625 | 17db7082c06 | adapt | C2 | PortScanner.ts:780 polls retained ports regardless of foreground state. Gate scheduled work on BackgroundPolicy, preserve explicit scans and update the GOAT scanner layer fixtures. |
| 631 | 3947e223515 | take | **C4** | AssetAccess.ts:99 omits common audio and video types from the preview allowlist. Add those file extensions through the existing preview root and access checks. |
| 1045 | 16a8876dd77 | take | C1 | Favicon discovery reads the whole candidate as a string at ProjectFaviconResolver.ts:216 and searches it with a repeated lookahead. Read a bounded prefix and examine link tags individually, retaining cancellation, path guards and missing-file handling. |
| 1061 | ecde5791c12 | adapt | C2 | Desktop reveal can respond before its shown report reaches DesktopBrowserChannel.ts:179. Wait within the request deadline for the matching tab report, using bounded signaling compatible with GOAT screen preview lifecycle and the existing viewer path. |
| 1081 | d085ee5d155 | adapt | C2 | The decoder imports the eval-dependent entry at worker line 155. Use the CSP build and close the decoded bitmap after PNG conversion, then integrate the fixture with GOAT's desktop CSP test configuration. |
| 1128 | 856c84e4b14 | adapt | C1 | Attach reads the node's current DOM rectangle at line 1344, so detached picks lose their crop. Cache the last connected rectangle, reset stale detached rectangles on scroll, and preserve GOAT's preview coordinate and overlay behavior. |
| 1147 | 044ba3ad67d | adapt | C3 | GOAT's existing CDP identity override stops at the page (`ServerBrowserContexts.ts:97`). Pass the Chrome user agent at browser launch so service workers inherit it, preserving GOAT's browser pin, context setup and page client hint metadata. |
| 1154 | f5f8c8d18ba | take | C2 | The preview action uses the ordinary asset URL runner at line 1024. Its existing refresh option (`apps/web/src/state/use-atom-query-runner.ts:18`) can mint a fresh URL per explicit open without changing other readers. |

### U17

**Claude adapter and startup (1/3)** · W03 · server-only · 2,427 estimated handwritten changed lines

- Use the extracted GOAT query runner, adapter helpers and Bedrock catalog. Preserve Monitor and explicit Stop semantics through startup and retry. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — claude-adapter, delegated-tasks, code-budgets.
- Test missing session, unanswered reply, MCP registration timeout, root failure with child alive, and old bridge payloads.
- **C4 before code** — rows #640. Bring the two-way compatibility and negative-case note to the coordinator.
- Refresh against the carried landing delta. Main overlapping claims — K6 (`apps/server/src/orchestration-v2/Orchestrator.ts`), K12 (`apps/server/src/orchestration-v2/ProjectionStore.ts`), K9 (`apps/server/src/orchestration-v2/Orchestrator.ts`), K1 (`apps/server/src/orchestration-v2/Orchestrator.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 14 | 5f95653f25a | adapt | C1 | GOAT split window resolution into ClaudeCompactSettings.ts:34–72. Honor Claude’s disable flags and autoCompactEnabled alongside its existing launch/file/environment precedence before computing the meter threshold. |
| 107 | bf9b8b78458 | adapt | C3 | Requires `4bab2f3ae71`. The catalog currently sends the slug (ClaudeModelCatalog.ts:446). Route probe-reported Bedrock or Vertex IDs only under matching settings, sharing worktree settings discovery and preserving GOAT query and generation hooks. |
| 165 | 4b99420d8e1 | adapt | C3 | GOAT already closes roster and tool records on release (providerSessionReleasedWork.ts:183–192), while after-drain cleanup only revisits tool calls. Add session-owned runless child settlement using a transactional compare-and-set that protects replacement sessions. |
| 175 | 298c38d7f28 | adapt | C3 | The Claude adapter keeps only prior or explicit effort (ClaudeAdapterV2.ts:4905). Fill missing effort from the child transcript within the provider’s scoped config, and preserve a GOAT delegated task’s model selection for local and host-routed cards. |
| 181 | 487733ba0a0 | adapt | C1 | The current cooldown matcher accepts a generic reset phrase (ClaudeAdapterV2.ts:2146). Read the proxy’s own classified cooldown and use its reset as a fallback to structured limits, preserving GOAT’s usage-limit classification. |
| 192 | 179c032b3f1 | adapt | C2 | Skill discovery already has managed settings lookup (ClaudeSkills.ts:25,546). Add the managed skills source with precedence over user/project definitions and keep GOAT’s existing managed settings lookup for supported Windows installations. |
| 196 | ae49f4d2a79 | adapt | C2 | Requires `bf9b8b78458`. `apps/server/src/claudeModelOptions.ts:43` suppresses thinking for unlisted routes. Use the GOAT catalog resolver so custom gateway IDs including 1m aliases keep the explicit toggle while known unsupported models still suppress it. |
| 284 | 1fcb24518a0 | take | C1 | `apps/server/src/provider/ClaudeProvider.ts:224` recognizes API-key auth for status but :874 omits that source from label derivation. Reuse the check to label API-key sessions correctly. |
| 286 | 66a40c7ca82 | adapt | C3 | `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:7619` records native retries and `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:4378` has GOAT retry tracking. Bound retries from the first notice, preserve user Stop and native session ownership, and coordinate the later Claude no-response watchdog. |
| 313 | be2a2879520 | take | C1 | The Fable 5.2 catalog entry still lists 2.1.290 at model-manifest.json:799–804. Gate it at 2.1.321 using the existing catalog format without replacing unrelated GOAT catalog updates. |
| 321 | 5a15495de4c | adapt | C2 | Requires `179c032b3f1`. discoverClaudeSkills reads installed and synced sources at ClaudeSkills.ts:554–579, with no inline directory discovery. Match Claude's settings-env priority, platform delimiters, and managed locks, checking the ProgramData input before porting. |
| 324 | 7bc474667de | adapt | C2 | Tool result projection currently marks error results failed at ClaudeAdapterV2.ts:5525–5527, and workflow stop at line 10513 has no stop timestamp. Correlate typed denial with the interrupted turn or a recorded Stop so earlier genuine failures stay failed. |
| 640 | 85a81b7a8b0 | adapt | **C4** | Reuse the launch-settings reader at ClaudeLaunchArgs.ts:86 before the controlled settings in ClaudeTextGeneration.ts:265. Preserve hook disabling, GOAT memory isolation and CLI account routing. |

### U18

**Worktree provisioning and clone status** · W03 · mac · 2,087 estimated handwritten changed lines

- Preserve worktree reservation, existing safe branch reuse and explicit base diagnostics across web and MCP launch. Scope any accepted #555 fallback to the intended launch case. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — orchestrator-goat-modules, delegated-tasks, ssh-runtime.
- Exercise stale/unborn clone state, missing named refs, cancellation and reused worktrees across isolated destinations.
- **C4 before code** — rows #261, #558, #989, #1083. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (2 source paths) — `packages/contracts/src/t3ProjectFile.ts`, `packages/contracts/src/goatProjectFile.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K4 (`apps/server/src/vcs/GitVcsDriverCore.ts`), K6b (`apps/web/src/components/ChatView.tsx`), K9 (`apps/server/src/ws.ts`), K2 (`apps/web/src/components/ChatView.tsx`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 4 | bc7fe11002a | adapt | C3 | GOAT can fall back to an unborn status branch (BranchToolbarBranchSelector.tsx:550–552) after the ref list was cached during clone. Invalidate repository and ref caches after clone, accept only listed default/current refs, and pair with d8b80a1097a for external clone/status refresh. |
| 132 | 8b30961465b | take | C1 | Give the explicit fetch preceding worktree creation a five-minute ceiling (GitVcsDriverCore.ts:4609–4614); keep timeout cleanup and ordinary Git command limits. |
| 261 | 77a39e9a37c | adapt | **C4** | GOAT already rolls back add errors at `apps/server/src/vcs/GitVcsDriverCore.ts:4142`, but claim is separate at :4368. Bind cleanup to a uniquely owned registration and make the handoff cancellation-safe while preserving subtree leases, branch reuse, and older Git behavior. |
| 383 | c924d7898fb | adapt | C2 | WorktreePreflight.ts:14–25 already names an unresolved preflight base, but provisioning errors take a generic mapping at ThreadLaunchService.ts:630. Preserve the original requested ref and use that typed error when provisioning reports a missing ref, with the original diagnostic attached. |
| 449 | dfd2187ccb0 | adapt | C3 | Requires `4bab2f3ae71`, `c924d7898fb`. ThreadLaunchService.ts:522 treats omitted startFromOrigin as false and :1325 rebuilds a retry strategy. Apply GOAT's new-worktree setting to omissions, use the persisted accepted strategy on retry, and port branch validation with 4ffa1da7cfe and e5d757f51b3. |
| 539 | df15bd4f7bf | take | C2 | The availability check and rename are separate at GitVcsDriverCore.ts:5092. Serialize them through the existing common-repo write path while preserving exact-name failures and GOAT branch names. |
| 555 | fb749693143 | decide · pending d1 | C3 | d1 recommendation — port scoped missing-base fallback. Requires `c924d7898fb`. Should a saved worktree launch whose base disappeared fall back to the remote default or current HEAD, or keep failing until the base is explicitly corrected? ThreadLaunchService.ts:542 currently uses a resolved remote result when available and otherwise keeps the requested base. |
| 558 | 5c9e5c1e98d | adapt | **C4** | The initial submodule update at GitVcsDriverCore.ts:4423 can leave successful clones empty when one clone fails. Restrict recovery that forces checkout to verified fresh worktrees and cloned paths, and keep GOAT's partial-failure diagnostics and cancellation semantics. |
| 673 | d8b80a1097a | adapt | C3 | Requires `bc7fe11002a`. GitVcsDriverCore.ts:2130 treats the unknown sentinel as a ref and the selector at :550 derives a worktree base from those reads. Decode the sentinel as absent and refresh stale refs through GOAT clone state when the actual branch appears. |
| 819 | 06150a08ec7 | adapt | C2 | ChatView.logic.ts:1373 gates all new worktrees on a base branch. Pass GOAT's scratch-project state through the planner for the No project exception and retain validation for real repos. |
| 869 | e00614e126c | adapt | C2 | Branch generation at :457 is unbounded locally and async script completion at :835 is deferred. Bound naming, keep the temporary branch on timeout and publish script completion when it occurs without changing GOAT interruption handling. |
| 954 | 4ffa1da7cfe | decide · pending d1 | C3 | d1 recommendation — skip and preserve safe existing-branch reuse. Requires `4bab2f3ae71`. GOAT deliberately reuses a safe existing branch (WorktreePreflight.ts:144–175), while upstream refuses an exact local branch name in a new worktree request. Should GOAT keep safe reuse or require an explicit existing-worktree operation when a new worktree request names an existing branch? |
| 989 | 4f781196e12 | decide · pending d1 | **C4** | d1 recommendation — skip and preserve existing sparse-exclude handling. **Contracts.** Should GOAT add a per-ref Git sparse-pattern file alongside worktreeSparseExclude (goatProjectFile.ts:117; GitVcsDriverCore.ts:3958)? If accepted, define precedence and preserve GOAT launch, rollback, and submodule behavior. |
| 1083 | 56e449ff58a | adapt | **C4** | GOAT renames leftover folders for recovery and rolls back failures (`restoreThreadWorkspace.ts:199`), so wholesale removal would lose recovery evidence. For a Windows CWD lock, preserve the top-level directory and move only proven leftovers aside under the existing lease. |

### U19

**Composer drafts, queued edits and uploads (1/4)** · W03 · mac · 1,087 estimated handwritten changed lines

- Keep draft ownership and dispatch classification, GOAT Reply and separate approval/question paths. Preserve destination and idempotency during retry. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — composer-footer, reply-to-response, decision-routing.
- Test queued edits, expired uploads, side-chat and linked routing, and cross-device mutation confirmations under d1 #89.
- **C4 before code** — rows #544, #559, #927. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (1 source paths) — `packages/contracts/src/composerContext.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K1 (`apps/server/src/mcp/OrchestratorMcpService.ts`), K6 (`apps/server/src/mcp/OrchestratorMcpService.ts`), K6b (`apps/web/src/components/chat/ChatComposer.tsx`), K7 (`apps/server/src/mcp/OrchestratorMcpService.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 544 | e49d0584396 | adapt | **C4** | GOAT's current miss handler at OrchestratorMcpService.ts:213 has only a local ID hint. Use GOAT linked-environment authorization for static tool guidance without probing peers or disclosing inaccessible thread identity. |
| 549 | 1cec1043eb5 | take | C3 | composerTrigger.ts:21 leaves emphasis markers unescaped and messageSearchIndex.ts:49 reads indexed visible text. Escape them in labels and unescape those labels for search, with existing index behavior accounted for. |
| 559 | fa6ecb125b6 | adapt | **C4** | Requires `e49d0584396`. The no-steerable-run mapping at OrchestratorMcpService.ts:235 should explain GOAT auto/queue sends. Add any corrected delegated-task ID hint in the same authorization-aware miss handling as the linked-environment guidance. |
| 650 | cc4160c8131 | take | C1 | ComposerStashMenu.tsx:15 clips UTF-16 at a fixed offset. Avoid splitting a surrogate pair and retain the fix with later mention labels in 558790aae54. |
| 843 | 558790aae54 | take | C1 | stashEntrySnippet at :18 strips assistant citation markup but leaves composer context links raw. Render the existing reference label before truncating the preview. |
| 927 | 750e492ed68 | adapt | **C4** | **Contracts.** Web already copies general composer context (ChatComposer.tsx:1366) but lacks a snapshot-specific transfer. Carry optional snapshot source metadata through clipboard import, preserve image-only paste and existing permission checks, and avoid duplication when native files and context are both supplied. |
| 952 | 9b313f2f09d | adapt | C3 | GOAT tests the whole token against a leading hash in both trigger paths (composer-logic.ts:290, composerTrigger.ts:131). Share a parser for a hash after opening punctuation, preserve the replacement range, and keep GOAT context and host-specific PR handling. |
| 984 | 8753e4d36bf | adapt | C3 | Queued Send ignores command failure values on web (:224) and mobile (:239); surface actual resume/promote refusal through existing feedback and suppress user interruptions. |
| 1035 | f79ab79721e | adapt | C3 | Web restores unsent text then clears attachment drafts (questionAttachments.ts:83,186–197); mobile has separate prune and composer flows (use-selected-thread-requests.ts:58,106). Transfer retained assets before clearing and preserve queued/delivered state, dedupe, errors, and buffer/resource ownership. |

### U20

**Mobile native input and device tooling** · W03 · mac · 1,013 estimated handwritten changed lines

- Keep GOAT native IDs and installed module registration. Forward pooled device config and preserve UTF-16 selection and accessible labels. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — mobile-sheet-header, composer-footer, code-budgets.
- Exercise native input/cut/undo, paste, scaling and device provisioning on the applicable platform.
- **C4 before code** — rows #474. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (1 source paths) — `packages/contracts/src/device.ts`.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 26 | a6d91409729 | adapt | C2 | GOAT’s install path forwards the session alone (mobile-native-client.ts:987). Forward the opening gateway config through both install branches and apply the upstream environment handling to the GOAT script. |
| 364 | b81202748b4 | adapt | C2 | GOAT already avoids rebuild for offset-only echoes and compares actual chip offsets (GoatComposerEditorView.swift:659–668,1330–1343). Port the remaining exact UTF-16 check for canonically equivalent source text and account for 50709315214's rendered-chip comparison when porting undo. |
| 390 | 7b1332674b6 | adapt | C2 | The renamed editor uses fixed-font metrics from useScaledTextRole at GoatComposerEditor.ios.tsx:163, while ThreadComposer.tsx:261 uses the same unscaled role. Scale both iOS consumers once and keep Android's sp scaling. |
| 400 | 2c607adf1fc | adapt | C2 | The renamed native editor sets only the placeholder label at GoatComposerEditorView.swift:694–695. Give the actual UITextView the placeholder's VoiceOver name and cover it in GOAT's iOS composer harness. |
| 437 | 88c42f471b0 | adapt | C3 | **Contracts.** GOAT has its own settings editor and EasDeviceHost.ts:59 still shows the old name. Update visible names with 0bdf566607b while retaining the existing eas kind, settings keys, credentials and wire shape. |
| 438 | 35308053127 | take | C2 | easProjectId.ts:53–86 rejects safe same-property config spreads and Expo type-only import references. The clean patch accepts those narrow patterns without executing repo config or guessing between app IDs. |
| 474 | 0bdf566607b | adapt | **C4** | Requires `88c42f471b0`. EasDeviceHost.ts:501–504 rejects launches on the availability preflight. Let Expo's create operation enforce admission while retaining GOAT token, ledger, cleanup and spend limits; regenerate from GOAT's GraphQL operation sources. |
| 742 | bcdd6a59f49 | adapt | C2 | use-composer-command-menu.ts:725 handles built-in actions but selecting /model leaves the action as text. Clear only the active token and open GOAT's existing model settings picker. |
| 759 | 0afd8c0295d | adapt | C2 | GoatComposerEditorView.swift:282 and :376 flatten clipboard images to PNG, and composerImages.ts:665 recognizes only PNG in the owned directory. Preserve the original GIF bytes and filename extension, with ordered mixed paste and bounded cleanup. |
| 775 | 50709315214 | adapt | C2 | Requires `b81202748b4`. GoatComposerEditorView.swift:311 owns Cut and the controlled-document echo near :677 can rebuild native storage and break undo. Compare against rendered chip attachments so native Cut/Undo/Redo retain token metadata and selection. |
| 804 | c5e6b24ff5e | take | C1 | Requires `0afd8c0295d`. GoatComposerEditorView.swift:226 measures only the first text item. Join all textual pasteboard items before the attachment threshold check. |

### U21

**OpenCode 1.x and 2.x lifecycle (2/3)** · W03 · server-only · 2,482 estimated handwritten changed lines

- Apply each row to the correct GOAT adapter. Keep child report attribution, question ownership and prompt admission separate from root settlement. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — orchestrator-goat-modules, delegated-tasks.
- Test skipped reports, late background activity, context window, dismissal after root terminal and Stop.
- **C4 before code** — rows #601. Bring the two-way compatibility and negative-case note to the coordinator.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 418 | e68d4f053bb | adapt | C3 | Requires `83d238218d8`, `aecad62a508`. OpenCode 1.x events only finalize a known active turn at adapter.ts:2426–2471. Admit provider-started root work through the continuation service with bounded buffering and cleanup, retaining GOAT session hooks and coordinating the later background-question fixes 03e05f6235c and af8faa9cfa9. |
| 601 | 166cb008972 | adapt | **C4** | GOAT moved rule construction to permissionRules.ts:68. Add an explicit inherited external-directory allow for full access only. |

### U22

**Authentication, pairing and peer transport** · W04 · mac · 2,334 estimated handwritten changed lines

- Keep GOAT Connect disabled, dedicated MCP auth middleware, peer identity and authoritative validation. Preserve independent frame policy for preview. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — peer-links, mcp-auth-middleware, session-ended-check.
- Exercise older credentials, proof replay, trusted TLS proxy and plain LAN, denied routes and guest versus paired preview.
- **C4 before code** — rows #5, #6, #125, #186, #302, #576, #588, #589, #595, #598, #599, #608, #619, #629, #630, #683, #743, #938, #941, #1044, #1047, #1144. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (6 source paths) — `packages/contracts/src/settings.ts`, `packages/contracts/src/resourceTelemetry.ts`, `packages/contracts/src/assets.ts`, `packages/contracts/src/device.ts`, `packages/contracts/src/auth.ts`, `packages/contracts/src/settingsSecretValue.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K8 (`apps/server/src/server.ts`), SF2 (`apps/server/src/server.ts`), K12 (`apps/server/src/mcp/McpHttpServer.ts`), K3 (`apps/server/src/auth/RpcAuthorization.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 5 | 4ee3b602fc2 | adapt | **C4** | The token exchange calls the replay-consuming verifier before credential exchange (http.ts:384–385). Use side-effect-free proof validation for that exchange and keep atomic replay consumption on authenticated routes that require it. |
| 6 | 94aa3d7736c | take | **C4** | The static/dev HTML response paths still lack frame-denial headers (http.ts:814,849); the patch checks cleanly. Apply only to app HTML so dedicated preview routes retain their embedding policy. |
| 125 | d530d961550 | adapt | **C4** | **Contracts.** The device host captures SDK state during creation (LocalDeviceHost.ts:112,272). Allow the shell patch to carry SDK values and resolve per use while keeping explicitly inherited configuration authoritative. |
| 130 | 7bf7527a0a9 | adapt | C3 | GOAT passes hub screenshot bytes through (DeviceService.ts:724) and native install only checks configured SDK variables (mobile-native-client.ts:159). Reuse complete-PNG extraction at both boundaries and align Android SDK discovery; use GOAT’s device fixtures. |
| 186 | 060ac23d6f8 | adapt | **C4** | **Contracts.** Device install flattens missing npm into command_failed (DeviceService.ts:963), though diagnostics can identify npm_not_found. Add a typed, GOAT-branded recovery reason without exposing npm stderr. |
| 302 | 1e9f93a48e2 | adapt | **C4** | ThreadComposer.tsx:1115 labels an absent grant as denial after connection even during lookup failure or loading. Add an explicit-denial selector for authoritative missing scope or auth rejection, preserving GOAT link and relay error variants and the existing mutation gate. |
| 576 | 39fcae5267a | adapt | **C4** | Cookie issue, legacy renewal and scoped expiry currently omit Secure (auth/http.ts:209, :327 and :343). Apply it for trusted HTTPS ingress using GOAT's proxy handling and keep direct HTTP pairing and existing cookie identities working. |
| 588 | 0bd581b078f | adapt | **C4** | ServerSecretStore.ts:304 treats a zero-byte secret as existing. Serialize repair with a re-read and integrate the existing Windows rename and atomic replacement handling. |
| 589 | f2839735efa | adapt | **C4** | McpOAuth.ts:54 caps registration at five redirect URIs. Raise the cap with a signed-ID size bound and preserve GOAT's registration payload and redirect validation. |
| 595 | 6c0032d655e | adapt | **C4** | McpAuthMiddleware.ts:150 authenticates before enforcing the MCP transport's Origin policy. Enforce it there and exclude the exact MCP route from the generic browser CORS preflight handler. |
| 598 | 3e29748f969 | take | **C4** | The typed registration handler at mcpOAuthHttp.ts:76 lets the router reject invalid metadata before it can return the OAuth error body. Decode at the route and return the typed registration error. |
| 599 | e57041a1dff | take | **C4** | PairingGrantStore.ts:571 only normalizes ungrouped short codes. Strip separators for recognized pairing-code shapes while leaving other credentials exact. |
| 608 | 1b9121ba59b | adapt | **C4** | GuestShareService.ts:559 and :590 resolve and subscribe using the fork itself. Verify the inherited item is actually visible through the authorized fork before subscribing in its owner thread. |
| 619 | 6a510c48947 | take | **C4** | McpOAuth.ts:134 relies on parsed URL.hash, which is empty for a bare fragment delimiter. Reject any raw resource fragment before the existing origin and path validation. |
| 622 | 8bc7a082274 | adapt | C2 | DirectEndpoints.ts:77 filters out explicitly bound tailnet IPv6 along with wildcard-discovered IPv6. Permit the explicit bind while retaining GOAT's listener eligibility rules and using a null-safe address check. |
| 629 | d5726cb88c3 | adapt | **C4** | ProviderSessionManager.ts:291 and :301 compute session device capability without the global hub gate. Apply the gate to global and project paths and preserve GOAT's localhost and per-project capability policy. |
| 630 | fa5fde4bea1 | adapt | **C4** | Auth metadata at utils.ts:167 sees only the socket peer. Accept validated forwarded IP metadata only through the known local Tailscale Serve path and keep direct and proxy-trust behavior explicit. |
| 683 | 528c77fe835 | take | **C4** | hostClassification.ts:121 omits .localdomain from the private suffixes used to suppress favicon requests. Add it so local hostnames stay private. |
| 743 | 178570dcd30 | adapt | **C4** | codexAuthCallback.ts:96 waits directly for browser launch before the callback can settle its listener. Connect cancellation to both desktop callers and race the pending browser launch with callback completion. |
| 808 | 26b63a44f9e | adapt | C2 | Home builds choices from saved connections at HomeRouteScreen.tsx:155–168 and the sidebar does the same at :187. Filter the menu with enabled workspace environments while retaining enabled offline entries and GOAT's offline thread access. |
| 933 | f9db865403e | take | C1 | Address edits currently assign the raw value (ConnectionsNewRouteScreen.tsx:201–202). Reuse the existing pairing URL parser to fill both inputs from a full link and leave a separate code intact on plain address edits. |
| 938 | e65a790ac55 | take | **C4** | **Contracts.** Both signed relative URL results only check length (assets.ts:85–86,125–127). Validate the host-relative signed route shapes at decode time and cover all GOAT asset and upload producers before landing. |
| 941 | b4744496f8a | adapt | **C4** | Requires `3947e223515`. The current preview dependency path passes through the general workspace resolver (AssetAccess.ts:1051). Apply the preview eligibility rule to both requested and canonical targets while preserving GOAT's workspace boundary and ordinary file access. |
| 981 | d7373c44fea | adapt | C2 | The dev script reaches the Serve mutation without a shared ownership check (dev-share.ts:153). Reuse tailscale.ts:509 as in cli/pair.ts:470, preserve the explicit GOAT dev target, and stop on another holder or unreadable status. |
| 1044 | 42a5aade848 | adapt | **C4** | **Contracts.** Port destination binding at the GOAT secret reference/materialization boundary and require provider-management authority wherever request data can select a secret reference. GOAT resolves text-generator secrets in TextGeneratorApi.ts:110 and persists settings secrets in serverSettings.ts:1749; use current device capabilities and preserve redaction. |
| 1047 | d1f7683d7ec | adapt | **C4** | Both routes authenticate during setup (DeviceHubProxy.ts:249; ServerBrowserStream.ts:75). Bind every long-lived transport to SessionStore.awaitInvalidation (:1146), closing owned WS and HTTP streams promptly while preserving GOAT's pairing and mediated preview controls. |
| 1050 | 10784e01f8b | adapt | C3 | GOAT already offers re-pair for confirmed ended cookie sessions (diagnosis.ts:230). Verify which other auth failures explicitly indicate expiry and retain that distinction while adding independent request-root tracing for reliable rejected-request IDs. |
| 1104 | 6ab633f6d6e | take | C1 | A set ANDROID_HOME preempts both SDK_ROOT and platform locations at lines 134 and 151. Select the first real SDK by supported tools, preserving existing fallback diagnostics. |
| 1144 | c48825322df | adapt | **C4** | The helper at line 621 uses the current origin regardless of protocol. Permit only non-loopback HTTP(S) for that fallback, while keeping signed GOAT desktop and hosted pairing paths where they explicitly apply. |

### U23

**Git refresh, refs and source-control actions (1/3)** · W04 · mac · 2,499 estimated handwritten changed lines

- Preserve GOAT Git providers, raw-cwd and selected environment scoping, separate full/light status and fetch/autopull fences. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — pr-event-feeds, contracts-rpc-leaves.
- Check old peer negotiation, mixed subscriber demand, disappearing refs, restricted fetch mappings and external clones.
- Refresh against the carried landing delta. Main overlapping claims — K2 (`docs/user/source-control.md`), K3 (`apps/server/src/ws.ts`), K4 (`apps/server/src/vcs/GitVcsDriverCore.ts`), K1 (`docs/user/source-control.md`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 43 | ca1a0280dac | take | C2 | GOAT passes raw az arguments to the spawner (AzureDevOpsCli.ts:379–388). The cleanly applying patch runs bundled Python in UTF-8 and checks launcher/interpreter pairing; carry it through remote-based CLI scope work in 2dfc4a9c983. |
| 48 | a7fd4326cff | take | C2 | GOAT’s Azure provider goes directly from setup to list operations (AzureDevOpsSourceControlProvider.ts:123–133). The production hunks fit as written; the test needs context adjustment and the SourceControlHost binding is reused by 83ee1f5d486. |
| 56 | 83ee1f5d486 | adapt | C2 | Requires `a7fd4326cff`. GOAT still delegates checkout to az (AzureDevOpsSourceControlProvider.ts:282–295). Fetch and switch explicitly to avoid pulling into the current branch in single-branch clones, preserve existing branch commits, and use the resolved remote work in 2dfc4a9c983. |
| 76 | ddc36529ad7 | take | C2 | The guide already directs subpath servers to tea (source-control.md:70–71), but the CLI’s fallback hint is generic (ForgejoCli.ts:630). The three-file copy fix checks cleanly. |
| 115 | 294e061a202 | take | C1 | The SCP pattern rejects bracketed IPv6 (git.ts:171). Canonicalize the host with the same URL parser as ssh:// while preserving vendor-specific path rules. |
| 131 | 410177c7d6d | adapt | C3 | The GitLab CLI currently posts to the target and passes a source string (GitLabCli.ts:383). POST in the source project with a numeric target ID and preserve GitHub, Bitbucket and GOAT remote selection. |
| 141 | 4d5d5f89d41 | adapt | C3 | git.ts:134 strips the suffix before provider-specific handling. Preserve literal Azure names and audit existing keys and GOAT Bitbucket/GitCafe/Cursor host normalizers before switching the shared callback input. |
| 145 | d0a494fc0bf | adapt | C3 | The tracked branch up-to-date shortcut (GitManager.ts:2908) can skip publishing to an explicit push remote. Honor branch.pushRemote and remote.pushDefault, keep upstream tracking and pass the actual push head into GOAT’s PR provider. |
| 173 | 38b3feeb75d | take | C1 | The current branch must already be in the refs cache to show (GitVcsDriverCore.ts:3834). Insert a newly checked-out real branch while keeping an unborn HEAD out of the list. |
| 193 | 3d3275b067c | adapt | C2 | Upstream setting currently assumes a conventional tracking ref (GitVcsDriverCore.ts:4926). Handle restricted fetch mappings under GOAT’s shared Git config lock, retaining tracking behavior for each source-control host. |
| 210 | e096deebf6f | adapt | C1 | The dialog moved out of GitActionsControl. Its path handler still submits Enter at `apps/web/src/components/PublishRepositoryDialog.tsx:365`, so guard composition and keyCode 229 there. |
| 224 | 243d66a2958 | take | C2 | The status path at `apps/server/src/vcs/GitVcsDriverCore.ts:2040` adds separate staged and unstaged counts, even though :3117 already has an empty-tree fallback for Changes totals. Use one empty-tree comparison for first-commit status as well. |
| 232 | 0e250fa6f6c | adapt | C2 | `apps/server/src/vcs/GitVcsDriverCore.ts:2309` checks operation marker files before resetting the index. Also check the sequencer and resolve exact operation refs for reftable without confusing same-named branches. |
| 237 | a575d45286f | adapt | C3 | Requires `4c473155380`, `a3477a5dd93`. `apps/server/src/ws.ts:3122` currently runs the generic refresh and `apps/web/src/components/BranchToolbarBranchSelector.tsx:340` falls back to stale canonical state. Publish local branch state before the RPC reply and hold the result by environment and checkout while status catches up. |
| 242 | 96ca66f218c | adapt | C1 | `apps/server/src/vcs/GitVcsDriverCore.ts:2909` sends unborn nested repositories into temporary-index staging. Filter repository-directory candidates with a bounded head check while preserving GOAT's staged-deletion option. |
| 248 | e53417b2d49 | adapt | C2 | `apps/server/src/vcs/GitVcsDriverCore.ts:2343` always uses stdin pathspec support. Add the pre-2.25 argv path while retaining top-level literal paths and the operation-safety guard when integrating `0e250fa6f6c`. |
| 294 | 732198d3a96 | adapt | C1 | GOAT already extracted the explanation, but still prioritizes dirty files for disabled Push at GitActionsControl.logic.ts:597–611. Remove that branch so Push reports the actual blockers and keep GOAT's source-control terminology. |
| 304 | 170c1f7e2d3 | adapt | C2 | The dialog only tests dirty state at GitActionsControl.logic.ts:404–409, so dirty Push or Create PR can offer a branch that requires a commit. Pass the action from GitActionsControl.tsx:383 and use GOAT's localized copy. |
| 895 | b0f0c44d228 | adapt | C3 | Requires `62a51e26a4a`. GOAT's Forgejo parser already recognizes /pulls/ and preserves authority (definition.ts:82–85), but the generic parser returns only repository identity (source-control-core/shared/definition.ts:340–352). Carry tab, commit and anchor intent through GOAT's provider registry on the relevant surfaces. |
| 975 | ed80c2fe668 | take | C1 | The select-all and per-file controls at GitActionsControl.tsx:1177,1219 lack names; the patch adds accessible labels and applies in the renamed tree. |

### U24

**SQLite ledger, indexes and projection reads (1/2)** · W04 · server-only · 1,327 estimated handwritten changed lines

- Use the GOAT ledger and preview reconciliation before preflight. Preserve the existing 090–157 GOAT names and allocate any competing SF4 ID centrally. For #374 keep the Node pin and take only JSON subtype handling. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — server-activity, migration-ID section.
- Cover fresh, migrated, preview, stale/displaced and interrupted ledgers. Verify dirty JSON, index predicates and query plans on disposable databases.
- **C4 before code** — rows #374, #397, #436, #484, #526, #739, #815, #868. Bring the two-way compatibility and negative-case note to the coordinator.
- Refresh against the carried landing delta. Main overlapping claims — K12 (`apps/server/src/orchestration-v2/ProjectionStore.ts`), K6 (`apps/server/src/orchestration-v2/Orchestrator.ts`), K9 (`apps/server/src/orchestration-v2/Orchestrator.ts`), N10 (`apps/server/src/persistence/Migrations.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 374 | fc480ea66a7 | decide · pending d1 | **C4** | d1 recommendation — adapt JSON subtype fix only and keep the Node pin. Migration 026 passes aggregate subqueries directly to json_set (lines 11–28,37–54,63–80,93–110) and package.json:80 pins Node 26.12.1. Should GOAT keep that pin and take the JSON subtype fix alone, or coordinate a 26.13.1 bump across dev, CI and release? |
| 397 | e5c636219c7 | adapt | **C4** | Upstream migration 092 collides with RemoteDispatches. Migration 086:11 and ProjectionStore.ts:6640 use the unguarded queued-input index. Guard fresh and existing schemas and both indexed queries together, assigning a free migration ID because GOAT already owns 92 at Migrations.ts:273. |
| 436 | ab2bf940f62 | adapt | **C4** | initializeV2Database.ts:62–66 backs up the old auto-vacuum mode into the initial V2 snapshot. Make the disposable copy compact and incremental in a guarded worker, preserving committed WAL rows and atomic initialization. |
| 484 | 3e176182122 | adapt | **C4** | Upstream migration 093 collides with ChannelLedger. Orchestrator.ts:11451–11452 and :11817 route delegated completion through GOAT's planner. Apply bounded task/run/provider-turn reads without dropping GOAT wake and remote-result state, and use a free index migration ID because Migrations.ts:274 owns 93. |
| 526 | a62bc8156da | adapt | **C4** | Upstream migration 094 collides with RemoteDispatchQuestions. ProjectionStore.ts:3353 uses the message-ID ordinal scan, but migration 94 is RemoteDispatchQuestions in GOAT (Migrations.ts:275). Allocate/reconcile migration IDs and keep the expression and partial WHERE predicate identical to the read. |
| 739 | 4f829644f66 | adapt | **C4** | Upstream migration 095 collides with ThreadRunResults. Requires `a62bc8156da`. ProjectionStore.ts:1091 rescans payload text on thread opens. Precompute the inline-work flag on writes and backfill existing rows with the same GOAT predicate; Migrations.ts:276 already assigns 095 to ThreadRunResults. |
| 815 | f5d86e31e82 | adapt | **C4** | Upstream migration 096 collides with RemoteReportRelay. Migrations.ts:277 already assigns 96 to RemoteReportRelay. Allocate through the chase reconciliation rules and clear only a marker without a matching pending or running job, including on previously migrated databases. |
| 868 | 4da2bc520c3 | adapt | **C4** | Migrations.ts:430 already detects preview and displaced GOAT history, but :436 enters preview reconciliation even when current. Avoid the no-op transaction while retaining GOAT id shifts, unfinished reconciliation and bounded migration behavior. |

### U25

**Web shell, thread navigation and search (1/2)** · W04 · mac · 2,473 estimated handwritten changed lines

- Keep full-page Settings, embedded side chat, scoped thread IDs, offline/link behavior and promotion rules. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — settings-page, thread-link-lookup, legacy-sidebar-shortcuts, link-thread-maximize.
- Exercise deep links, focus and back, stale palette results, rollback visibility and indexed/unindexed search.
- Refresh against the carried landing delta. Main overlapping claims — K8 (`apps/web/src/components/ChatView.tsx`), K4 (`apps/server/src/workspace/WorkspaceSearchIndex.ts`), K2 (`apps/web/src/components/ChatView.tsx`), K3 (`apps/web/src/components/Sidebar.logic.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 61 | 44a8e9541bc | take | C1 | GOAT’s ProviderModelRow is un-memoized (ProviderModelsSection.tsx:458) and the row call already passes the shared handler set (:304–308). Apply the memo wrapper with a trivial import conflict fix. |
| 80 | 56fd98be528 | adapt | C2 | GOAT creates and awaits an extra docking promise on first send (useComposerSend.ts:1007–1023). Batch normal sends, wait only for real view transitions, and preserve GOAT’s launch and answer-clear paths. |
| 177 | df8c1a1fd48 | adapt | C1 | The actual visible names are hidden from accessibility and duplicated offscreen (SidebarDraftBlock.tsx:104, SidebarThreadRow.tsx:941). Make the drawn title the accessible node without changing GOAT rename or row semantics. |
| 180 | 4c2f04d35d3 | adapt | C3 | Queued runs and thread relationships still subscribe to live projections (QueuedRunsControl.tsx:121, ThreadRelationshipsControl.tsx:311). Use quiet structural selectors while preserving live text readers and GOAT lineage and changed-file updates. |
| 185 | 6aa14d3cd53 | adapt | C2 | The short-prefix SQL narrowing uses literal substrings (ThreadSearch.ts:140,183). Add bounded accent/case-aware Latin matching without widening GOAT’s visible-thread or result-limit rules. |
| 211 | 96735d7311d | adapt | C2 | `apps/web/src/components/sidebar/SidebarThreadRow.tsx:1597` selects on click while pointer focus may move to the disappearing result. Preserve focus after invoking drag listeners and derive any size hint from GOAT's rendered row dimensions. |
| 229 | e2f164d6bb7 | adapt | C1 | `apps/web/src/components/chat/ThreadRelationshipsControl.tsx:127` contains overscroll, blocking wheel propagation to the parent. Allow scroll chaining while keeping GOAT's row and scrollbar styles. |
| 278 | 47474723cbb | adapt | C3 | Web already gates many failure badges at `apps/web/src/components/Sidebar.logic.ts:1147` but lacks the start-time fallback, and mobile uses raw status at `apps/mobile/src/features/threads/thread-list-v2-items.tsx:484`. Share visit-aware badge logic while keeping raw errors for detail and filters. |
| 287 | 382312aba8f | adapt | C2 | `apps/web/src/components/AppSidebarLayout.tsx:362` resolves both GOAT sidebar commands using only usage-page state, while :269 already builds focus and panel context for another listener. Use that same context for sidebar dispatch and preserve the Activity shortcut. |
| 289 | f751c8488f7 | adapt | C1 | `apps/web/src/components/chat/DraftHeroHeadline.tsx:103` sorts without the persisted manual order, already applied by `apps/web/src/components/CommandPaletteLookups.ts:59` and line 75. Reuse that ordering with GOAT's project grouping controls. |
| 308 | 48afc47e776 | adapt | C3 | Requires `6aa14d3cd53`. ThreadSearch.ts:245–257 only excludes card-only answers, so it can link to rolled-back runs or cancelled prompts with no reachable row. Match GOAT's projected items and remove stale search-cache reuse when run visibility changes. |
| 317 | f05cd350d25 | adapt | C2 | GOAT still batches every path delta (FileBrowserPanel.tsx:517–518) and scans removed roots for each path (fileTreePathReconciliation.ts:20). Rebuild expensive sibling batches while preserving expansion and live search, and use ancestor membership for removals. |
| 332 | dd5061364bb | adapt | C2 | MarkdownSource passes the completion/cache flag into render at ChatMarkdown.tsx:1566 and markdownRenderer.ts:86–108 caches during rendering. Separate element creation from remembering a completed committed render while retaining GOAT's renderer keys and effect budget. |
| 333 | f968db10d74 | adapt | C2 | A route-presence prop fans out through both sidebar variants (Sidebar.tsx:3076 and LegacySidebar.tsx:3868). Read panel preference at click time through a stable getter, with the appropriate target routing for each variant. |
| 336 | 314f1e2976d | adapt | C2 | Requires `6aa14d3cd53`. The FTS writer folds apostrophes at messageSearchIndex.ts:85, whereas verification scans raw text at ThreadSearch.ts:250–256. Fold verification text with the same expression and retain raw text for displayed snippets. |
| 414 | 37c266d25a8 | adapt | C3 | 229ae283d3a ported FoldedSettingsSection.tsx:95 only. ComposerBanner.tsx:108 and ComputerUsePanel.tsx:314 still have broad sibling selectors, so scope them while preserving GOAT's seams and row dividers. |
| 420 | 42bfd1f3775 | take | C2 | The current patch still fails unclosed math at line 151 without remembering the scanned range. The parser and regression hunks apply cleanly; refresh GOAT's patch hash in the lockfile. |
| 453 | 304dc136482 | adapt | C3 | GOAT already skips lineage subagents in both CommandPalette.logic.ts:407–410 and threadDeletionFallback.ts:10–12. Extend project-open and delete fallback to GOAT's actually folded launch relationships while allowing promoted or top-level threads; check follow-up 81df7333066 for settled archives. |
| 493 | a6d76950644 | adapt | C1 | DiffPanel.tsx:238 includes a revision that the collapse toggle bumps at :594. Keep the scope key stable through collapse and preserve the GOAT scroll and patch-scope behavior. |
| 495 | fe59fa44d0f | adapt | C1 | Suppress both row hover-card branches while editing (SidebarThreadRow.tsx:1042 and :1213) and keep GOAT's row geometry steady when the rename input at :509 replaces the label. |
| 512 | 4dec8cf6416 | adapt | C2 | The chat's shortcut context at ChatView.tsx:2781 omits rightPanelOpen while RightPanelTabs.tsx:548 supplies it only within the panel. Pass the actual state through chat routing and check draft shortcuts with later `da95a047631` and `6d3f6423a34`. |
| 519 | a31fab93a29 | adapt | C2 | The native workspace focus request in useRightPanelActions.ts:200 covers terminal selection, while GOAT mounts its side chat at SideChatSurface.tsx:166. Scope the request to the selected side chat's composer when selecting the tab. |
| 522 | d6c1d177939 | adapt | C1 | The drag start at Sidebar.tsx:1467 chooses the context preview from pointer position alone. Search results should show that preview within the list where reordering is unavailable, using GOAT's sidebar state. |
| 527 | 47f2e91210f | take | C1 | MiddleTruncate immediately fits each mounted head at middle-truncate.tsx:25. Batch measurements before writes in a microtask, with detached-node and glyph-boundary handling. |
| 530 | d23f479a87f | adapt | C2 | Requires `4dec8cf6416`. GOAT's shortcut handler at useChatShortcuts.ts:58 lacks upstream's side-pane marker and allowlist. Scope it to GOAT's embedded chat and let only panel-wide commands reach the main view from there. |
| 545 | 1c86881dd5a | adapt | C2 | DiffFileTree subscribes with an all-folders selector at DiffFileTree.tsx:113. Coalesce model notifications per task so expanding all folders performs one recomputation, with a safe unsubscribe. |
| 557 | def3722faa3 | adapt | C1 | The area cycle identifies a focused element by shared name at workspaceFocus.ts:275. Prefer DOM identity for duplicate main and GOAT side-chat areas while respecting explicit fromArea. |
| 562 | 81df7333066 | adapt | C1 | Requires `304dc136482`. The palette chooses a recent thread at CommandPalette.tsx:806. Apply GOAT's settled and effective-snooze eligibility before ranking within grouped and environment-specific projects. |
| 567 | e8d5c12890a | adapt | C2 | Image search grabs the large general file page at WorkspaceSearchIndex.ts:597 then filters it. Apply the image constraint before paging, checking GOAT exclusions, case handling and fff ranking and fallback behavior. |
| 813 | b732621b519 | adapt | C3 | Web currently checks lineage at CommandPalette.logic.ts:428. Use GOAT's existing sidebar grouping for both palettes so a task nested under a visible parent is omitted, while promoted/orphan/fork threads remain discoverable. |
| 972 | d405bd94ac4 | adapt | C2 | Initialization/reset caps the stored preference to the narrow viewport (AppSidebarLayout.tsx:131,463); retain preferred width and keep the render-time clamp with GOAT's rail subtraction and drag semantics (:453,476). |

### U26

**Pi extensions, sessions and generation (1/2)** · W04 · mac · 2,314 estimated handwritten changed lines

- Keep older Pi supported under #169. Gate per-request thinking on support and preserve the user’s global defaults and session-file ownership. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — orchestrator-goat-modules, code-budgets.
- Replay old turns, extension reload, Stop before settle, context and ambiguous native forks.
- **C4 before code** — rows #113, #169, #581. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (1 source paths) — `packages/contracts/src/orchestrationV2.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K12 (`apps/mobile/src/lib/threadActivity.ts`), K1 (`packages/contracts/src/orchestrationV2.ts`), K6 (`packages/contracts/src/orchestrationV2.ts`), K6b (`packages/contracts/src/orchestrationV2.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 35 | f5ae8088c35 | adapt | C1 | GOAT tracks Pi items without a per-command output cursor (adapter.ts:142–144). Append output deltas and move cursor logic out of the budget-capped adapter. |
| 113 | 33372a25a2d | adapt | **C4** | **Contracts.** Pi drops notifyType (adapter.ts:1297–1305), while GOAT already has optional info/warning severity (orchestrationV2.ts:1468,1695). Use that contract for classification and preserve the existing default for old notices. |
| 144 | bebaf3ec04d | adapt | C2 | GOAT has a Pi CLI --fork path already (adapter.ts:3287). Reuse it when a resumed session header proves the native cwd differs, preserving GOAT’s worktree handoff and native queue behavior. |
| 157 | 75c544a9788 | adapt | C2 | Project async workflow, chain and parallel members with stable per-member IDs from structured events (adapter.ts:1105), deduplicate snapshots and terminate or clear tracked members at settlement. Keep GOAT’s Pi stop/queue behavior. |
| 169 | 89f1acb0f0a | decide · pending d1 | **C4** | d1 recommendation — adapt with the existing Pi minimum. GOAT supports Pi 0.80.5 (status.ts:78), and older Pi may turn a background thinking selection into a global default. Should GOAT raise its minimum to 0.84.3, or keep older releases and apply generation thinking only when supported? |
| 485 | b732f647f22 | adapt | C3 | Requires `bebaf3ec04d`, `75c544a9788`. The existing launch at adapter.ts:276 resumes via switch_session at :2402, reloading extensions. Attach at process startup, skip redundant same-file switches, and preserve handoff cwd, screen-skill gating and early native work; coordinate with 05ccd6bfb5c and 6a6fecbfdae. |
| 570 | b39fc24ff20 | adapt | C2 | Pi passes the refreshed environment at adapter.ts:279 without a thread ID. Use GOAT_THREAD_ID and compatibility behavior matching the GOAT ACP launcher at mcpContext.ts:76–77. |
| 581 | 1e38ebb71b7 | adapt | **C4** | The read-only trust check at mcpExtensionSource.ts:595 recognizes one native tool origin. Admit OmO's exact bracketed builtin path, preserving the source check for extension overrides. |
| 603 | dcd39b4b6e3 | adapt | C2 | Inventory RPCs at status.ts:247–252 are profile-aware in GOAT. Retry a blocked discovery once with project trust disabled when no explicit trust flag was supplied, retaining Pi and OMO profiles and bounded timeouts. |
| 834 | e47a96e88d8 | take | C1 | The completed Pi read tool item at :1080–1093 records output but no preview path. Use the shared image-path check and bounded tool arguments to attach viewedImagePath. |
| 835 | 05ccd6bfb5c | adapt | C2 | Requires `b732f647f22`. The adapter finalizes without adopting the live sessionFile at :2250 and compares only the saved native ID at :2668. Include 6a6fecbfdae so Stop also preserves the handoff, and review historical fork behavior in 2ebe7f8e226. |
| 852 | e5b6c96a46a | adapt | C3 | The fast path at :2485–2511 trusts cached model and thinking values after extensions can change Pi's live state. Recheck only those cached values and preserve GOAT's native inherit and scoped turn semantics. |
| 855 | 35a172883ce | take | C2 | The manual response only fails the run when no compaction started at adapter.ts:2068. Treat a failed response as failed unless the compaction was explicitly cancelled, and update the replay expectation. |
| 879 | 222288b00f9 | adapt | C1 | GOAT's profile-aware health probe still passes server cwd (driver.ts:206). Give it a writable probe directory under the provider status cache and keep profile-aware discovery. |
| 963 | 6a6fecbfdae | adapt | C2 | Requires `05ccd6bfb5c`. GOAT already reads current session state for explicit switching (adapter.ts:2412), but interrupt persistence needs that read when an extension switched files. Refresh native identity before saving the interrupted cursor and keep the same session's entry boundary. |

### U27

**Codex sessions, models and requests (1/2)** · W04 · mac · 2,313 estimated handwritten changed lines

- Preserve custom runtime identity, negotiated replay and request ownership. Constrain #751 to the approved full-access browser/app elicitation policy. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — contracts-rpc-leaves, orchestrator-goat-modules.
- Replay with an older Codex app server, request timeout and unsupported/refused tools, active steer and pinned model changes.
- **C4 before code** — rows #100, #587, #592, #612, #751, #1072. Bring the two-way compatibility and negative-case note to the coordinator.
- Refresh against the carried landing delta. Main overlapping claims — K9 (`apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`), K6 (`docs/orchestration-v2/orchestrator-mcp-server.md`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 71 | be78ee49401 | adapt | C3 | GOAT processes command-item completion at CodexAdapterV2.ts:4746. Let the port-stop service mark an owned command before signaling so a user stop does not produce a spurious provider wake; preserve identity checks and bounded cleanup of marks. |
| 100 | 99071c4953b | adapt | **C4** | IdAllocator.ts:291 already has a stable delegated-task namespace. Set the Codex thread/start source only for IDs issued by that allocator, preserving GOAT launch and computer-use configuration. |
| 176 | f3b43efd9a4 | adapt | C2 | The shared initialize holds a semaphore while requesting the app-server (CodexAdapterV2.ts:1215,1224). Bound initialization and retire the failed client so the next turn can obtain a fresh session. |
| 256 | 3b816cf6c7b | adapt | C1 | `apps/web/src/components/settings/CodexSetupSection.tsx:409` retains an abort check and :638 has a conditional manual field. Show retry-only copy when the field is absent, and keep paste guidance where the callback form is available. |
| 422 | 52074e92585 | take | C2 | CodexAdapterV2.ts:4088 emits an active plan snapshot without marking its work item completed. The clean patch completes each snapshot while leaving the individual plan-step states intact. |
| 466 | 6b9d90f1213 | adapt | C2 | Requires `66a40c7ca82`. CodexFailureClass.ts:78–89 has no terminal transport class, and CodexAdapterV2.ts:5565–5578 may lose transport evidence in a generic completion. Preserve only corroborated connection failures and GOAT's separate 403/429 classifications. |
| 494 | 92605bf9d55 | adapt | C1 | Extend GOAT's title-only leading context pattern at AgentSessionScanner.ts:247 to recognize external_codex_apps_open_page. Keep the transcript intact and preserve GOAT's other recognized preambles. |
| 524 | 252b2c77b37 | adapt | C2 | The request handler at protocol.ts:344 and worker/exit paths around :475 can die before failing pending requests. Return an internal error for handler defects and terminate failed transport workers without treating normal scope shutdown as a defect. |
| 541 | 240fc6975b7 | adapt | C2 | Requires `252b2c77b37`. The reader at protocol.ts:475 already begins an exit-status grace, while the writer can report its pipe error first. Share a bounded exit-status lookup with the writer after `252b2c77b37` and preserve interruption. |
| 569 | 6f06f2675d2 | adapt | C2 | The web search artifact at CodexAdapterV2.ts:3339 derives status from item completion, while turn finish only closes other tool classes at :6269. Terminalize outstanding searches with the turn outcome and keep completed search rows intact. |
| 575 | 4afa6f0983d | adapt | C2 | The adapter uses snapshot-based failureResetAt at CodexAdapterV2.ts:5597. Add a time-zone-aware Codex-text fallback when a proxy omits the structured reset, preserving GOAT's managed caps and validating the timestamp. |
| 587 | 1e60d60519c | adapt | **C4** | CodexAdapterV2.ts:6991–7046 sends MCP Apps list, call and read straight to the native thread. Add one resume on explicit unload with GOAT's current runtime params and retain its MCP and computer-use attachment rules. |
| 592 | 467ec62e08d | adapt | **C4** | Add goat_task_create to the direct-only registration at CodexAdapterV2.ts:807–817 so a blocking delegation avoids Code Mode's intermediate yield. Keep GOAT's memory-tool exclusions and timeouts. |
| 612 | e9d8ac5673c | adapt | **C4** | GOAT appends account route arguments in codexLaunchArgs.ts:47 and at CodexTextGeneration.ts:574. Force both hook flags off for headless generation and strip explicit re-enables while retaining trusted routing arguments. |
| 614 | 46fff7943e9 | take | C2 | The policy snapshots at ProviderSwitchService.ts:138–159 resolve the same workspace differently. Use the thread's worktree first for both so a model-only switch does not restart a shared session. |
| 735 | 8c80003d68b | adapt | C3 | CodexDriver.ts:529 starts a fresh probe for each workspace. Reuse a bounded idle app-server by full launch identity, retaining GOAT's environment-aware timeout and isolating profiles, executables and config homes. |
| 751 | 96290af4e0d | decide · pending d1 | **C4** | d1 recommendation — port narrow full-access elicitation approval. CodexAdapterV2.ts:5267 routes supported elicitations through GOAT's approval flow. Should full-access Codex automatically approve supported browser and app MCP access requests once? |
| 883 | 023620d3a51 | adapt | C1 | The status probe immediately scopes the launched app-server client (CodexProvider.ts:516). Preserve GOAT's effective base URL, make startup work grace bounded, and use process-group checks only where supported. |
| 1072 | ea6d3fc30fb | adapt | **C4** | The generator only enumerates published requests (line 712), and the steer at `CodexAdapterV2.ts:7401` carries text alone. Regenerate the missing experimental method against GOAT's pinned Codex and use the consolidated adapter behavior in 8009cd8c3bc, which replaces this direct steer-only call. |
| 1151 | a1b1a6388c3 | take | C1 | The exec environment at line 490 bypasses GOAT's existing Codex originator wrapper (`CodexProvider.ts:379`). Reuse the wrapper, including GOAT's intentional external T3 Code identity and env override precedence. |

### U28

**OpenCode 1.x and 2.x lifecycle (3/3)** · W04 · server-only · 93 estimated handwritten changed lines

- Apply each row to the correct GOAT adapter. Keep child report attribution, question ownership and prompt admission separate from root settlement. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — orchestrator-goat-modules, delegated-tasks.
- Test skipped reports, late background activity, context window, dismissal after root terminal and Stop.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 951 | 6fa874e98eb | adapt | C2 | Requires `e68d4f053bb`. The legacy adapter wraps an unanswered root abort as a generic interrupt error (adapter.ts:3428–3449); OpenCode 2 already emits the typed timeout (v2/adapter.ts:3867). Keep the specific timeout through the older adapter and preserve completion and child-abort races. |

### U29

**SSH config and process launching (1/2)** · W05 · mac · 2,490 estimated handwritten changed lines

- Retain GOAT SSH supervisor, generation-log lock, GOAT_HOME and literal PATH/Host/Include handling. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — ssh-runtime, cli-home, node-pin.
- Check UTF-8 and quoted paths, Linux and Windows worker lifetime and update during SSH boot.
- **C4 before code** — rows #195, #415. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (1 source paths) — `packages/contracts/src/environment.ts`.
- Refresh against the carried landing delta. Main overlapping claims — N10 (`apps/server/src/server.ts`), K8 (`apps/server/src/server.ts`), K7b (`apps/server/src/server.ts`), SF2 (`apps/server/src/server.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 87 | 388424db268 | adapt | C2 | GOAT uses printenv from the overridden login PATH (shell.ts:192–239). Add a safely quoted fallback lookup within the existing shell timeout, retaining GOAT names and shell-specific syntax. |
| 98 | 033bb5a82eb | adapt | C2 | GOAT tracks the launch byte offset, but failure still prints the shared tail (tunnel.ts:964–965,1013–1015). Isolate diagnostics across retries and Windows spawn while retaining GOAT's replacement and rollback logs. |
| 109 | 1ed6e325595 | take | C1 | Add RemoteCommand=none and RequestTTY=no to the common baseSshArgs (command.ts:198) so a user alias cannot replace GOAT’s command or request a TTY. |
| 128 | 86d49daf82b | adapt | C3 | The editor picker takes the first usable candidate (editor.ts:62). Search for stable Zed on Windows while preserving PATH order, Windows shims and GOAT shell-resolution caching. |
| 195 | 0c306f45203 | adapt | **C4** | Requires `9ff435b060f`. The GOAT launcher coordinates through a generation-log owner lock (`apps/server/src/serviceLauncher.ts:85`) and SSH uses its own replacement supervisor. Keep those ownership rules and add bounded wait/adoption while a boot-service start or update holds the home, including the gap between old and new servers. |
| 244 | 07885556d9e | take | C1 | `packages/shared/src/shell.ts:452` only reads uppercase PATHEXT. Look up Windows aliases case-insensitively and preserve the fallback when unset. |
| 319 | b779d400777 | adapt | C2 | Requires `86d49daf82b`, `6bc105f04e8`. editor.ts:172–179 checks only the first PATH hit and may return the same ambiguous bare command. Port the prerequisite multi-candidate resolver and probe past the OpenZFS daemon, keeping GOAT's editor list and stable Zed preference. |
| 337 | ccf7ead6a4a | adapt | C3 | Requires `86d49daf82b`. POSIX entries are trimmed in shell.ts:114,429,643 and DesktopShellEnvironment.ts:172. Use the shared merger while preserving valid POSIX whitespace and combine with 38f7761148f for literal quotes. |
| 343 | d26375ed8a9 | adapt | C1 | Include wildcard * becomes dot-star at config.ts:94–96, which excludes line separators. Fold this into 100ba49a65c's byte matcher so Include filenames and Host aliases follow the final OpenSSH matching rules. |
| 415 | 7f7a1a447a2 | adapt | **C4** | **Contracts.** scripts/install.sh:292 installs a symlink and cli/update.ts:278 only discovers a link target. Use an absolute exec launcher across install, discovery, update and uninstall, preserving legacy ownership, GOAT home paths and service rollback. |
| 416 | b60abf32e0b | adapt | C3 | server.ts:1292 uses the existing trampoline layer and the Windows worker backend is absent. Integrate the bounded worker spawner and Effect patch with GOAT's error guards and Claude hooks; carry 92595ab1491 and 2becf31b640 with it. |
| 444 | 92595ab1491 | adapt | C2 | Requires `b60abf32e0b`. NonBlockingSpawner.ts:134 falls through to synchronous native spawn when Linux lacks GNU env -C. In the worker rollout, select the worker for that case and preserve the current trampoline where supported. |
| 446 | 4d6ebbdba85 | take | C2 | The hostname fallback is unqualified at ServerEnvironmentLabel.ts:192. The clean patch qualifies the default label only inside WSL, keeping explicit names and optionally including the distro. |
| 537 | dd86dd6d91c | adapt | C2 | SshDeviceHost.ts:197 explains Windows hosts but misses SSH's own connection refusals. Use GOAT's SSH error and redaction rules, preserve host-key verification and map recognized probe failures to actionable diagnostics. |

### U30

**PR lists, writes and provider scoping (1/3)** · W05 · mac · 2,478 estimated handwritten changed lines

- Keep GOAT host identity, authorizing environment and optimistic rollback scoped to the selected account. Keep PR saved views operable before Issues. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — pr-event-feeds, settings-page.
- Test failed writes, stale host state, capability absence and mixed-scope filter persistence.
- **C4 before code** — rows #762. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (1 source paths) — `packages/contracts/src/pullRequest.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K2 (`apps/web/src/components/pullRequest/PullRequestsPage.tsx`), K1 (`apps/server/src/orchestration-v2/Orchestrator.ts`), K4 (`apps/server/src/vcs/GitVcsDriverCore.ts`), K6 (`apps/server/src/orchestration-v2/Orchestrator.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 58 | 1a12c4afae9 | adapt | C3 | Requires `67699df3d12`. GOAT caches authoritative check details only for GitHub (PullRequestService.ts:2910–2915). Add bounded Azure policy evaluation and use the existing check model, preserving draft status, failed-read retry behavior, and other hosts’ check support; coordinate 3883ed544c3. |
| 69 | 34cf030e5e4 | adapt | C2 | GOAT drops the environment ID when it formats the first merged-query error (pullRequests.ts:542–551). Carry the ID into both the empty-result and stale-results error presentations. |
| 92 | 0516493a914 | adapt | C2 | Most hunks are spacing changes covered by the fork’s styling rule. Port the separate accessible status labeling and prevent the elapsed-time ticker from announcing every update (GitActionsControl.tsx:970,1056–1058). |
| 93 | d899bddfa2a | adapt | C1 | GOAT’s Merge Request list reads full REST descriptions with the default output cap (GitLabPullRequestCli.ts:494–499). Set a bounded endpoint-specific limit; keep the package’s existing pagination. |
| 108 | 70be20493b7 | adapt | C3 | The server invalidates viewed state without invalidating the shown revision (PullRequestService.ts:1678), and web ignores equal-object refreshes (filesViewedStore.ts:81). Port completion-based acknowledgement to GOAT’s actual mobile overlay and preserve host scoping. |
| 203 | 92c91aac8f4 | take | C1 | `packages/client-runtime/src/pullRequestQuery.ts:80` and line 87 index ordinary objects with query text. Require own keys so inherited names stay in free text. |
| 221 | 414d9385132 | adapt | C2 | Requires `d0a494fc0bf`. `apps/server/src/vcs/GitVcsDriverCore.ts:2596` can skip publishing based on fetched ancestry alone. Verify a single matching fetch and push URL before skipping, preserving GOAT host routing and push-remote selection. |
| 249 | 64d70f8828e | adapt | C2 | `apps/mobile/src/features/pull-requests/pullRequestList.ts:534` sorts host timestamps lexically. Use instant ordering for GOAT's federated lists, discussions, and activity, keeping equal instants stable and the truncation notice at the end. |
| 273 | c0ee5a1f5f2 | adapt | C2 | Requires `d0a494fc0bf`. `apps/server/src/vcs/GitVcsDriverCore.ts:2135` and line 2508 can treat a deleted tracking target as a live upstream. Separate unborn HEAD, vanished publish branches, and differently named bases while respecting explicit push remotes. |
| 298 | d3d7ad9a61e | adapt | C2 | Mobile chooses only the explicit pick or device history at PullRequestMergeControls.tsx:49–58. Resolve the destination project's merge setting between those two and select the first repository-supported method, keeping GOAT's provider-specific actions. |
| 306 | 554c89320f4 | take | C1 | parsePullRequestQuery emits unbounded free text at pullRequestQuery.ts:119. Cap it at 200 after extracting qualifiers so mobile list requests stay within the existing limit. |
| 405 | 3f92b488dbb | adapt | C3 | The current cross-repo cursor at PullRequestProvider.ts:361 discards identities already delivered at a tied timestamp. Preserve repository-and-number identity across aggregated pages and skip delivered rows before the page limit without changing other forge cursors. |
| 473 | 1d4765ba2a1 | take | C2 | GitLabPullRequestCli.ts:1299 decodes one award page. The production hunks apply cleanly and scan pages until the viewer's own award or an empty page; adjust the test context. |
| 475 | 3883ed544c3 | adapt | C2 | Requires `67699df3d12`. AzureDevOpsPullRequestProvider.ts:165–173 and :359 read the PR to get the same location. Cache the location and allow activity to join a pending detail read, preserving retry and scoping the key to the resolved Azure repository. |
| 511 | 9cd5733f589 | adapt | C2 | The unscoped PR query assigns one owner per repo at pullRequestProjectAssignment.logic.ts:20. Prefer reachable GOAT environments while preserving availability, explicit project scope and host-aware repo identity. |
| 516 | a96bb810497 | adapt | C2 | GOAT extracted the first loop to RightPanelTab.tsx:192 and has a second comparison loop at pullRequestDetail.logic.ts:200. Hoist each immutable comparison target to reuse normalized keys. |
| 532 | 2c5013d153f | take | C2 | At Orchestrator.ts:2922 an unrelated event advancing the projection rejects a branch update even if its expected fields still match. Keep the sequence fence for replacements that rewrite links and keep snapshot field guards for both. |
| 556 | 3ee426272bd | adapt | C1 | GOAT's standalone label at FileViewedToggle.tsx:31 controls both Viewed and Changed. Enlarge the effective hit target within GOAT's row sizing and retain shift-click and propagation behavior. |
| 591 | 2a66bf26e86 | adapt | C2 | handlers.ts:287 drops the caller project before the guide lookup at :601. Pass it as a fallback only for providers that permit checkoutless lookup and preserve GOAT result errors. Follow-up 86a9d9fb71a further clarifies missing-project errors. |
| 657 | 348009de22c | take | C1 | Extend the classifier at changedFileKind.ts:45 to recognize Storybook files, updating consumer filters and counts through the existing shared function. |
| 677 | aace48bfe4a | take | C1 | The module heuristic at pullRequestFileOrder.logic.ts:80 uses base-name matching that loses dotted suffixes. Strip only supported file extensions and resolve bundler queries without deleting package subpath prefixes. |
| 703 | 9f815c94af7 | adapt | C3 | GitManager.ts:1708 probes the general head selector, so a full page can hide the tracked fork's PR. Scope the fallback to its owner on GitHub and audit the other providers' probe implementations and caps. |
| 762 | 86a9d9fb71a | adapt | **C4** | **Contracts.** Requires `2a66bf26e86`. pullRequest.ts:937 has no missing-project reason. Keep public-host reads and include d427894aa1d's later distinction between adding a repository as a project and needing any project on that host. |

### U31

**Shared client state, connection and routing** · W05 · mac · 2,011 estimated handwritten changed lines

- Keep K7 instance/generation guards and GOAT permissions. Keep optional clock calibration out of persisted cache. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — peer-links, thread-link-lookup, contracts-rpc-leaves.
- Exercise older snapshots, lost replies, fresh/resumed reconnect and ranking by destination environment.
- **C4 before code** — rows #24, #491. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (1 source paths) — `packages/contracts/src/server.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K7b (`apps/server/src/ws.ts`), K7 (`apps/server/src/ws.ts`), K6b (`apps/web/src/components/ChatView.tsx`), K3 (`apps/server/src/ws.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 24 | 2d80cb6bc75 | adapt | **C4** | **Contracts.** GOAT reads the client clock for elapsed time (TimelineWorkGroupRows.logic.ts:18–19, floating-working-control.tsx:683). Sample an optional server timestamp once per connection, exclude it from persistent cache and use each environment’s offset for optimistic and observed timers; carry it into 8bbe7fdd1a2 if taken. |
| 78 | bd9ff7eb2a3 | adapt | C2 | GOAT’s shell controller retries expected failures (shell.ts:533–534) but has no automatic retry on a defect. Recover with bounded backoff and keep existing reconnect, persisted-shell and generation behavior. |
| 104 | cf60628ef98 | take | C1 | The view finalizer still applies the steady-state persistence gate (threads.ts:264). Persist an unexpanded running projection once on close. |
| 106 | a81ec88f58f | take | C1 | The shared handoff gate still requires a native ref (threadWorkflows.ts:118), although portable handoff uses saved history. Keep the source provider record requirement. |
| 114 | ca7a9448b88 | adapt | C1 | The attempt loop gates offline on replacement only (supervisor.ts:1239). Allow one explicit retry and preserve GOAT's existing offline ref and primary-target handling so the enabling signal cannot interrupt its own attempt. |
| 120 | 1f55acf13b4 | take | C1 | The cache key excludes projectId (olderSettledThreads.ts:99). Include it so moving an old thread invalidates counts in the affected projects. |
| 122 | efae4e9da1d | adapt | C3 | The tracker suppresses retries as soon as it dispatches (threadVisits.ts:123). Separate accepted and pending visits and use environment generation on both clients without re-marking a deliberate unread. |
| 143 | 306914f0160 | adapt | C2 | Pass the group key to the shared label derivation (projectGrouping.ts:201). Name whole-repository groups from repository identity and preserve folder-level labels on all callers. |
| 293 | 04572419e4a | take | C1 | snoozeWakeLabel rounds elapsed fractions up at threadSettled.ts:355–359. Subtract clock-minute indices so a minute-floored timer reports a one-hour snooze as 1h. |
| 407 | 9888694f803 | adapt | C2 | archivedShellSnapshot at orchestration.ts:179 has no shell-removal refresh. Tie its mounted reads to the destination environment's removal signal and preserve the client-runtime query lifecycle. |
| 456 | 3808e2d77e1 | adapt | C2 | pullRequestMarkdown.ts:207 treats a line of inline triple-backtick code as a fence opener. Detect its matching same-line delimiter and keep subsequent PR media visible using checked captures. |
| 460 | 26bf047d5e6 | take | C2 | projects.ts:139–143 recognizes Scratch only while a workspace root is available. The clean patch also accepts the persisted isScratch marker so disconnected machines do not duplicate No project. |
| 463 | 9ca66225cab | adapt | C3 | promptLinks.ts:195 and PreviewEmptyState.tsx:37 depend on newer URL statics, as do other client paths. Use a constructor-based nullable helper in GOAT's shipped call sites and preserve the existing protocol and origin checks. |
| 467 | 5bd2d0cb82a | take | C2 | host.ts:477 considers query and fragment text as filename segments. The clean patch strips the suffix before selecting the final path segment. |
| 472 | 3a87ca8c6ab | adapt | C2 | itemDetail.ts:128–131 parses and reserializes tool output, silently rounding wide integer values. Keep raw spelling when whole or line-delimited JSON contains an unsafe integer or overflow. |
| 480 | 6c7a87cbcbf | adapt | C3 | McpAppWebView.tsx:470–473 and McpAppFrame.tsx:380 accept teardown completions from old document hosts. Guard close and fullscreen exit by mounted host identity on both clients. |
| 491 | ec844a39951 | adapt | **C4** | The connect span calls the full target annotator at supervisor.ts:716 and relayTracing.ts:99 copies error messages. Minimize exported attributes and causes at the relay boundary while retaining local diagnostics. |
| 610 | e6344bebd8f | take | C1 | Normalize stored MCP app results at host.ts:126 so metadata-only image or audio blocks cannot cause the SDK to reject the entire tool result. |
| 618 | 25a1afe7d5e | take | C1 | threadHistoryMerge.ts:150 prepends the fetched page ahead of older loaded rows. Merge on shared row anchors to preserve timeline order on all clients. |
| 836 | 40dcbc5f6a8 | adapt | C3 | GOAT's server cursor can advance on any non-silent run terminal at ProjectionRunNotification.ts:109–117, and both clients share threadListPriority.ts:90. Suppress notification effects of stopped runs without losing an earlier unseen completion or an explicit Mark unread. |
| 890 | 6f5838f9bcd | take | C3 | The shared helper only adds a slash (projects.ts:213–215) and web duplicates it (CommandPalette.tsx:701). Anchor bare paths under home via the shared helper, keeping absolute and explicitly relative inputs. |
| 967 | 9e32c95576f | adapt | C3 | The current connection lease omits rejected-route history (driver.ts:51), so a successful fallback hides a failed device credential. Carry per-route host refusals and re-pair guidance across both clients while preserving GOAT's session-ended distinction, route generation invalidation and clock-skew handling. |
| 1087 | 9b3b1c79a71 | adapt | C3 | Shared search returns matches, loading and rows (`threadSearch.ts:167`). Report all-environment failure after the visible query settles while preserving retained shell rows and partial results in each entry point. |
| 1129 | 24467d671d1 | take | C1 | The workflow-prefix match at line 324 can backtrack on long slash divider sequences. Make comment termination unambiguous and preserve real workflow-header detection. |

### U32

**ACP transports, prompting and replay (1/3)** · W05 · mac · 2,456 estimated handwritten changed lines

- Retain GOAT ACP/Grok/Copilot paths and exact ownership. Distinguish cancellation, detached sessions and live-process tool errors. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — orchestrator-goat-modules, fork-in-scope.
- Exercise older peers, HTTP/stdio, soft interrupt, late replies and native continuation with replay fixtures.
- **C4 before code** — rows #250, #432, #586, #594, #607, #637, #643, #678, #728, #754. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (1 source paths) — `packages/contracts/src/acpRegistry.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K9 (`packages/provider-acp/src/server/adapter.ts`), K8 (`packages/effect-acp/src/protocol.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 65 | 0aeb9457067 | adapt | C2 | GOAT still sets detached for Windows shim starts (AcpSessionRuntime.ts:1089) despite its existing taskkill fallback (:1256–1259). Keep attached stdio on Windows and retain the Unix owned process-group behavior. |
| 123 | 46b508d119b | take | C2 | **Contracts.** Share the existing 120-character limit (acpRegistry.ts:53) with input and submission. The wire limit remains 120. |
| 140 | 35d01dc291a | take | C2 | Replay copies the full map on each update (adapter.ts:1713). Mutate the private accumulator and materialize snapshots at the read boundary so earlier returned snapshots stay stable. |
| 250 | db0ae7b6e1b | adapt | **C4** | GOAT's extracted reader guards EOF blanks at `packages/effect-acp/src/_internal/strictParser.ts:57` but decodes each completed line at :37. Ignore whitespace-only complete lines without tolerating malformed JSON or losing frame-size accounting. |
| 265 | 0351dbb0920 | adapt | C3 | `packages/provider-acp/src/server/adapter.ts:3978` maps only explicit error to failure today. Map refusal and limit stops for roots and child sessions, close foreground tools, and keep user cancellation and failed-child diagnostics distinct from assistant output. |
| 280 | 1c18c16e931 | adapt | C3 | Requires `0351dbb0920`. `packages/provider-acp/src/server/adapter.ts:2036` emits accumulated child text on every append. Coalesce writes, flush before terminal events and child resets, and preserve GOAT's ACP scope lifetime and indexing exclusions. |
| 326 | ff75365c7d0 | take | C1 | The managed uv lookup still searches the inherited PATH after the managed directory (AcpRegistrySupport.ts:1078–1081). Limit executable resolution to the managed bin directory and retain the normal spawn PATH for the agent. |
| 432 | 632802cd324 | adapt | **C4** | **Contracts.** probe.ts:209 drops per-model reasoning metadata and driver.ts:103–108 merges instance defaults. Preserve absent versus explicit unsupported versus advertised levels in the probe contract and verify Grok and other ACP instances. |
| 486 | 5f29d87c9b2 | adapt | C3 | Signal that the prompt entered the outbound queue before cancel, with bounded waiting if it never enters. Preserve GOAT's distinct cancellation modes at AcpSessionRuntime.ts:1988 and its dispatch permit at :2306. |
| 488 | 910d4590d0d | adapt | C2 | The drain checks tracked background items at RunExecutionService.ts:1226 and only retains a pending-work flag for the root at :1490. Hold the stream for pending owned children and evict moved children from the set. |
| 500 | bbda0c10711 | adapt | C3 | The ACP adapter keys plan reconciliation to the active turn at adapter.ts:3431. Keep identified plans session-scoped with bounded lifetime and preserve their original rows while allowing only the owning active root to adopt updates. |
| 586 | 3f1b132e970 | adapt | **C4** | The GOAT registry flavor at adapter.ts:225 has a different launch and tool-attachment path. Add Command Code transport selection there and preserve current Copilot behavior, provider-session authentication and capability checks. |
| 594 | 9791bce7986 | take | **C4** | The dispatcher at client.ts:929 accepts elicitation without checking initialized client capabilities. Reject unadvertised modes across both negotiated protocol generations. |
| 607 | 1dfc746c8f4 | adapt | **C4** | Apply the Devin filter in the registry flavor at adapter.ts:265 and at all three GOAT option selection sites in the shared adapter. Exclude bypass from plan acceptance while preserving valid native IDs. |
| 637 | ea4e7c1a604 | adapt | **C4** | Select and return ACP option IDs verbatim at permissionOptions.ts:4. Keep this independent of the Devin bypass filter in row 607. |
| 643 | 93cd25a99b2 | take | **C4** | AcpRegistrySupport.ts:1235 rejects any relative path beginning with two dots. Reject the parent segment or an absolute path, while preserving the existing canonical containment gate. |
| 678 | 015eba40839 | adapt | **C4** | The bridge deletes its local session at mcpOverAcpBridge.ts:153 before remote cleanup succeeds. Preserve one retryable session entry for failed disconnects and retain successful, missing and disposed-session behavior. |
| 705 | 781ab0553ca | take | C2 | AcpRegistrySupport.ts:827-835 drains stderr into a large status error. Keep the diagnostic tail while continuing to drain the install subprocess. |
| 728 | b35c9702f94 | adapt | **C4** | elicitationForm.ts:229 drops the optional-text requirement bit. GOAT's userInputDraft.ts:192-195 already treats optional answers specially; preserve omission or explicit empty text according to the ACP form contract and check both clients. |
| 754 | 834eb51301a | adapt | **C4** | AcpSessionRuntime.ts:1597 races the load reply against replay quiet for every agent. Await a real reply by default and preserve the explicit quiet-replay escape hatch for Grok and any verified GOAT ACP flavors that need it. |
| 760 | 4b9cf579ba6 | adapt | C3 | The Copilot configuration near registry adapter.ts:276 does not opt in to continuation and the ACP adapter does not retain the root foreground state. Open a continuation only for an actual idle-to-wake transition and summarize it through GOAT's run lifecycle. |
| 764 | 649d9fc1ab1 | adapt | C3 | Requires `4b9cf579ba6`. adapter.ts:3835 and :4152 can drop child chunks while an unreported Grok task completion is pending. Preserve those chunks and require structured wake evidence for new continuations without regressing Copilot. |

### U33

**Pi extensions, sessions and generation (2/2)** · W05 · server-only · 785 estimated handwritten changed lines

- Keep older Pi supported under #169. Gate per-request thinking on support and preserve the user’s global defaults and session-file ownership. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — orchestrator-goat-modules, code-budgets.
- Replay old turns, extension reload, Stop before settle, context and ambiguous native forks.
- **C4 before code** — rows #1124. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (1 source paths) — `packages/contracts/src/orchestrationV2.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K1 (`packages/contracts/src/orchestrationV2.ts`), K6 (`packages/contracts/src/orchestrationV2.ts`), K6b (`packages/contracts/src/orchestrationV2.ts`), K7 (`packages/contracts/src/orchestrationV2.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 929 | a6f7981abba | adapt | C2 | The select path still projects a generic question (adapter.ts:1405). Recover structured options only when the extension dialog matches its tool arguments, route custom replies through the extension's actual input handshake, and preserve GOAT's web/mobile typed-answer behavior. |
| 1123 | 4ecbe55087a | adapt | C1 | Pi reuses the same stream-item ID for a content slot (`adapter.ts:965`), but finalize at line 987 cannot clear a published block with an empty replacement. Reset incomplete blocks on a new start and preserve the published-state distinction. |
| 1124 | 2ebe7f8e226 | adapt | **C4** | **Contracts.** Requires `05ccd6bfb5c`, `6a6fecbfdae`. Pi forks from the current session file at adapter line 3269 even when the boundary belongs to a previous native session. Record an optional per-turn session ref, resolve the boundary in that session, and bound legacy recovery to verified sibling branches and timestamp matches. |

### U34

**Dictation and native speech** · W05 · mac · 2,548 estimated handwritten changed lines

- Build on GOAT voice controller and recover any required baseline narrowly. Bind #931 recording to the originating draft and fence non-target navigation. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — settings-page, composer-footer, cli-home.
- Test older batch fallback, live model capability, stop/cancel and device restart with foreground switch.
- **C4 before code** — rows #665, #898. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (2 source paths) — `packages/contracts/src/settings.ts`, `packages/contracts/src/ipc.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K8 (`packages/contracts/src/settings.ts`), K2 (`apps/web/src/composerDraftStore.ts`), K6b (`apps/web/src/components/chat/ChatComposer.tsx`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 665 | 16a70050f47 | adapt | **C4** | **Contracts.** GOAT captures media at voiceRecorder.ts:217 and lacks upstream's PCM module. Route a single Linux recovery through its typed desktop bridge and retry the recorder's capture after its own audio utility exits. |
| 714 | 2f30d98fab7 | adapt | C1 | GOAT's live transcript is a two-line clamped paragraph at ComposerVoiceRecorderBar.tsx:137-143. Keep the latest words visible in that existing recorder and coordinate with c24255826be if GOAT takes background dictation. |
| 898 | 4247b5aa1a1 | decide · pending d1 | **C4** | d1 recommendation — port opt-in streaming transcription. **Contracts.** GOAT's current server wrapper exposes batch WAV inference (SpeechInference.ts:26), and its web recorder differs from upstream. Should GOAT add native live transcription to web/desktop with a per-device option to transcribe only after recording stops? |
| 931 | c24255826be | decide · pending d1 | C3 | d1 recommendation — port recording bound to the original draft. Requires `4247b5aa1a1`. GOAT has a different composer voice controller (ChatComposer.tsx:212) and full-page Settings. Should web/desktop dictation continue recording into its original draft after navigation, with a visible Stop and Cancel control? |
| 1099 | bfd37b2b534 | adapt | C3 | GOAT already has benchmarks and static ranking (`speechModelBrowser.ts:30`), with different settings and startup UI. Share the language/CPU/accelerated recommendation policy across the available picker and setup paths, retaining explicit choices and the fallback when benchmarks are absent. |

### U35

**Codex sessions, models and requests (2/2)** · W05 · server-only · 269 estimated handwritten changed lines

- Preserve custom runtime identity, negotiated replay and request ownership. Constrain #751 to the approved full-access browser/app elicitation policy. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — contracts-rpc-leaves, orchestrator-goat-modules.
- Replay with an older Codex app server, request timeout and unsupported/refused tools, active steer and pinned model changes.
- Refresh against the carried landing delta. Main overlapping claims — K9 (`apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 1080 | 8009cd8c3bc | adapt | C3 | Requires `ea6d3fc30fb`. GOAT calls the optional setter at `LiveModelSelection.ts:34`, but Codex lacks it. Implement the shared tier updater for steering and live selection and retain a successfully applied tier across retries without overwriting custom-runtime selection. |

### U36

**Mobile thread feed, worktree and status (1/2)** · W06 · mac · 1,223 estimated handwritten changed lines

- Preserve GOAT feed width, user jump/follow and pending message identity. Coordinate M3b and K12 layout paths. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — mobile-sheet-header, composer-footer, code-budgets.
- Test first layout, switching, visible setup/background work, short and long histories, and both native surfaces.
- **C4 before code** — rows #40. Bring the two-way compatibility and negative-case note to the coordinator.
- Refresh against the carried landing delta. Main overlapping claims — K12 (`apps/mobile/src/features/threads/ThreadFeed.tsx`), M3b (`apps/mobile/src/features/threads/ThreadFeed.tsx`), K4 (`pnpm-lock.yaml`), T3 (`apps/mobile/src/features/terminal/ThreadTerminalRouteScreen.tsx`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 15 | c8db8be3050 | adapt | C3 | GOAT still falls through to Thinking (TimelineWorkGroupRows.tsx:436). Derive the status from the unfiltered active-run tail on both clients, including GOAT’s hidden-tool and delegated-task presentation. |
| 40 | e4f066da213 | adapt | **C4** | The pinned 0dc7ed81 archive and upstream 16db4c75 both record native base 1d00a92abc3. Carry the blockquote fix into the existing GOAT dependency update process (apps/mobile/deps/README.md:3) and check retention of its tiled-code behavior. |
| 167 | 4121b30f78c | adapt | C1 | Give the inline page open action space outside the rendered document, retaining GOAT’s styling and accounting for it in the virtualized height (HtmlRenderWebView.tsx:26,253). |
| 231 | d9973dc3f83 | take | C1 | `apps/mobile/src/features/sharing/incoming-share-model.ts:339` and line 404 still generate colon-separated attachment IDs. Generate compatible IDs for both file and image share ingress. |
| 260 | 9441a7285c5 | adapt | C2 | Reconnect and direct file, review, and terminal retries call retryNow, including `apps/mobile/src/features/connection/useConnectionController.ts:41` and `apps/mobile/src/features/terminal/ThreadTerminalRouteScreen.tsx:347`. Share an explicit-user-action helper that enables a disabled entry and otherwise retries. |
| 274 | 4ce60c162b4 | take | C1 | `apps/mobile/src/state/queries.ts:455` returns previous debounced entries during an environment or worktree change. Hide entries until the checkout matches and keep same-checkout query debounce. |
| 288 | b05c505b9c7 | take | C2 | `apps/mobile/src/features/review/ReviewCommentCard.tsx:255` trims meaningful trailing unified-diff context. Share a helper that removes framing newlines while retaining the final context-line marker and whitespace. |
| 311 | 2eb8829308f | take | C1 | The GOAT Markdown predicate still accepts only md and mdx at filePath.ts:121–122. Extend it to markdown, mdown and mkd, keeping GOAT's current path parsing. |
| 323 | 949dc230749 | adapt | C1 | GOAT forwards style straight onto the Tabler SVG at AppSymbol.tsx:356–364, and thread-list-v2-section.tsx:58 supplies a rotation. Apply transformed styles to a centered native wrapper while preserving the separate iOS symbol implementation. |
| 443 | 854b61bc27e | adapt | C2 | GOAT's existing accessible row label at thread-list-v2-label.ts:10–21 includes worktree and branch but omits visible status and time. Add those cues to the card, slim and menu entry points while keeping GOAT's VoiceOver actions. |
| 490 | dae8d6f7e5a | adapt | C1 | GOAT records keyboard visibility when anchoring at AndroidAnchoredMenu.tsx:109. Close via its existing lifecycle at :85 when an anchor opened above the keyboard outlives it. |
| 525 | fbdfe2e9809 | adapt | C1 | The expanded fallback at thread-work-log.tsx:924 can show raw details alongside the structured question answer rendered at :1156. Extend the existing read/diff-aware render guard for answered items. |
| 540 | eb8b1f5246a | adapt | C3 | The shared card lifetime depends on the current run's startedAt (worktreeSetup.ts:37 and ThreadRouteScreen.tsx:819–829). Use evidence of any prior started run across web and mobile, keeping GOAT's recovery snapshots and coordinating later mobile rows `93f8563a95e`, `e8e7fb7e9a6` and `82afb28794b`. |
| 654 | a9e900f9c06 | adapt | C1 | The queue preview at threadQueueControlPresentation.ts:45 flattens citations but leaves encoded context links. Render shared context labels before citation cleanup and retain attachment-only behavior. |
| 682 | 7ced2ca6ccc | adapt | C2 | ThreadFeed.tsx:1248 formats by locale alone. Read Android's existing GoatNativeControls clock setting as CustomSnoozeSheet.android.tsx:58 does and refresh it on foreground. Carry this through d775f6bff14, which later invalidates cached formatters on time-zone changes. |
| 711 | d738edf401e | adapt | C2 | ThreadDetailScreen.tsx:345 and :577 still own the delayed history-sync pill. Move it to GOAT's route and inspector headers, coordinated with the later floating-status rework in 8bbe7fdd1a2. |
| 718 | 93f8563a95e | adapt | C2 | ThreadDetailScreen.tsx:568 uses a composer pill before a setup snapshot. Keep a feed anchor and an initial setup card through the preparing-to-running transition, coordinated with e8e7fb7e9a6 and 82afb28794b. |
| 794 | 12c495af498 | adapt | C3 | Requires `d738edf401e`. ThreadDetailScreen.tsx:657 reserves status space and ThreadFeed.tsx:381 initially waits for a signed asset. Fold the handoff into 4860a730695's attachment flow and reconcile the status geometry with 8bbe7fdd1a2 and worktree setup with 82afb28794b. |
| 798 | 249b92c0801 | adapt | C1 | At :156 the badge falls back to the task driver even for a remote child without a provider snapshot. Use GOAT's neutral agent glyph for unknown linked targets and actual provider identity when available. |
| 820 | 3a745775179 | adapt | C1 | The Stop action is only rendered in the compact bar at :138 and missing from the expanded header at :167. Expose the same permission-checked action while expanded. |
| 851 | f8c8f30e49b | adapt | C2 | ThreadFeed's load key is also used for GOAT message jumps at :2583. Suppress provisional header and composer positions until the thread is laid out, preserving explicit jump and end-follow behavior and including fecd7138e97 for long lists. |
| 881 | 59df51f6e19 | adapt | C3 | Requires `bc1dc2a81ee`. Keep the feed under a stable width provider and seed its layout from the owning pane's settled geometry. GOAT already reads the settled width but initializes separate measurements (ThreadFeed.tsx:2008–2014); reuse the pane state and scope it to the window. |
| 889 | fecd7138e97 | adapt | C1 | Requires `f8c8f30e49b`. GOAT gates initial jump on a loaded key (ThreadFeed.tsx:2614–2616); a ready callback can precede the true end landing. Use a per-mount landing signal with a bounded reveal fallback, preserving explicit jump and local scroll behavior. |

### U37

**Server runtime, diagnostics and IO** · W06 · server-only · 1,416 estimated handwritten changed lines

- Keep GOAT server process resilience, bounded IO and readiness. Scope authority and fan-out in runtime services. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — fork-in-scope, server-activity, cli-home.
- Test idle versus active processing, limits, rejection and teardown, including the actual host OS for platform-specific rows.
- **C4 before code** — rows #84. Bring the two-way compatibility and negative-case note to the coordinator.
- Refresh against the carried landing delta. Main overlapping claims — K7b (`apps/server/src/server.ts`), K8 (`apps/server/src/server.ts`), K3 (`apps/server/src/ws.ts`), K9 (`apps/server/src/ws.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 30 | 6bce2226dec | take | C1 | GOAT decodes the multipart text directly (guest/http.ts:185–186). The patch applies cleanly and normalizes line endings before schema validation. |
| 62 | 3ea253f80f2 | take | C1 | GOAT always emits after watcher revalidation (keybindings.ts:462–469). The production hunk fits as written with a test import adjustment, and keeps regular writes emitting. |
| 84 | 4a53d80239d | adapt | **C4** | GOAT currently creates the state directory with mode 0700 (config.ts:191) and prepares a separate backup root (serviceLauncher.ts:228–231). Keep that permission, set No_COW only before creating a new btrfs database, and match the backup directory to the source’s storage attributes. |
| 166 | b37c959669c | take | C1 | The VS Code launcher prioritizes parsed position over a confirmed directory (externalLauncher.ts:150). Open an existing colon-number folder in a new window. |
| 222 | 0200dcf2423 | adapt | C2 | `packages/shared/src/nodeSqliteClient.ts:1141` has GOAT-specific worker ownership and routing. Introduce fair, interruptible admission to the first free reader and register permit cleanup before scheduler yield while retaining writer and transaction semantics. |
| 226 | cb6670b01d2 | adapt | C1 | `apps/server/src/project/ManagedProjectFolders.ts:289` converts transient Git probe failures into values before an infinite cache. Cache successful probes, then map a failed probe to the existing unavailable response outside the cache. |
| 301 | 5583b26460d | adapt | C3 | The hub and client independently unwrap any matching JSON envelope (CommandOutputHub.ts:91 and itemDetail.ts:222). Share an item-aware decoder, verify which legacy GOAT Claude rows need the compatibility window, and preserve literal output for other drivers and newer rows. |
| 307 | 043d712294c | take | C1 | The temp prefix uses the destination basename (atomicWrite.ts:39), which can overflow the filesystem component limit. Use a short constant goat-write- prefix in the same directory. |
| 370 | 5d1352d48a8 | adapt | C1 | RpcInstrumentation.ts:410–417 parents calls under the long-lived socket span. Start each call as a linked root trace while preserving GOAT's method aggregation and custom instrumentation attributes. |
| 573 | b9bbfda0871 | adapt | C3 | startupAccess.ts:47 and DirectEndpoints.ts:70 share an interface filter that lacks the Linux container prefixes. Reuse a platform-aware helper for advertised routes and the pair URL while retaining routable GOAT host bridges. |
| 623 | 9bea6f7eb0d | adapt | C2 | agentScope.ts:204 and :419 apply limits through GOAT's systemd launch path. Recalculate memory settings at launch, cache only a successful application and serialize updates without changing shared-scope OOM ownership. |
| 730 | 20450040963 | take | C1 | KeyedCoalescingWorker.ts:74 invokes the processor before installing cause handling and key cleanup. Suspend the call so synchronous defects get the same cleanup as Effect failures. |
| 734 | 3ee4aa62ec0 | take | C1 | imageMime.ts:45 permits space, CR and LF only. Accept the remaining base64 ASCII whitespace required by the decoder without broadening non-whitespace acceptance. |
| 744 | 94edd64e74c | adapt | C2 | ws.ts:3412 has no local-only compression branch, and PairingGrantStore.ts:36 defines the reserved desktop bootstrap subject. Verify native, same-machine WSL and proxy paths before omitting compression for desktop-local connections. |
| 914 | 50717b81677 | adapt | C1 | The relative-read root realpath still fails when cleanup removed the root (WorkspaceFileSystem.ts:335–346); the existing absolute path branch already tolerates ENOENT. Limit the new null path to allowMissing, preserving GOAT's containment and dangling-link rules. |
| 921 | ca432d7ed64 | adapt | C2 | The private-network listener silently closes rejected sockets (server.ts:381–383). Keep the exact gate and add a bounded rejection diagnostic, preserving GOAT's logger and avoiding per-connection log amplification. |
| 1043 | 25da86c29b8 | take | C1 | The periodic sampler calls sample immediately and then sleeps (ProcessGroupMetrics.ts:137,140). Delay the first sample so its producer can publish; the patch applies in the GOAT tree. |
| 1060 | 79aa7a7b5c5 | adapt | C3 | The optional OTLP delegates in Observability.ts:65–73,99–107 lack an attempt-failure metric. Hook logs, traces and metrics with bounded signal/reason labels, preserve local redaction and export retry behavior, and use GOAT metric naming. |

### U38

**PR watch and forge activity** · W06 · mac · 1,592 estimated handwritten changed lines

- Start from K1 and retain GOAT GitHub event feeds, host cursors and per-provider watermark semantics. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — pr-event-feeds, orchestrator-goat-modules.
- Run whole watch tests for quiet/missing PR cadence, stale/partial status, rate limits and duplicate delivery.
- **C4 before code** — rows #487. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (2 source paths) — `packages/contracts/src/pullRequest.ts`, `packages/contracts/src/threadPullRequest.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K2 (`packages/contracts/src/pullRequest.ts`), K1 (`apps/server/src/orchestration-v2/Orchestrator.ts`), K6 (`apps/server/src/orchestration-v2/Orchestrator.ts`), K4 (`apps/server/src/orchestration-v2/ThreadSettlementService.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 45 | 2a468acfed5 | adapt | C3 | Current sweeps group by branch (ThreadPullRequestService.ts:185–189), then repeatedly read idle groups. Add bounded no-PR rescheduling while letting explicit/backfill, shell-close and merge triggers read promptly; coordinate the separate open-PR cadence in a35fd811749. |
| 74 | a35fd811749 | adapt | C2 | The reactor already has quiet intervals (PullRequestSyncReactor.ts:49–50) while settlement reads linked PR summaries separately (ThreadSettlementService.ts:618–632). Share the cadence, preserve immediate merge-triggered settlement, and track this separately from 2a468acfed5’s no-PR branch cache. |
| 363 | 01c84c7c021 | adapt | C2 | PullRequestWatchReactor.ts:527–540 turns activity failure into total failure even with fresh detail. Evaluate successful check/head/conflict data independently and retry remarks without moving their watermark, preserving the GOAT PR event feed and backfill. |
| 423 | 6fae3c93033 | adapt | C3 | Requires `01c84c7c021`. PullRequestWatchReactor.ts:178 always asks for details while a check is in flight. Add GitLab's one-query fingerprint and honor its completeness signal while preserving GOAT GitHub feeds; include f5ca0f9427e for rebase-required wakes. |
| 487 | f5ca0f9427e | adapt | **C4** | **Contracts.** Requires `6fae3c93033`. GitLab's list mapper currently emits mergeability alone (gitLabMergeRequestJson.ts:347). Carry true, false and unknown separately into the sync, persisted watch and wake path, including GOAT's event feed and unchanged-timestamp refresh. |
| 561 | 5b5f1bc18a2 | take | C1 | The wake snippet strips comments at pullRequestWatch.ts:294 but can quote raw HTML. Normalize known presentation tags and entities while retaining code spans and fenced code. |
| 686 | 2d80ca0852d | take | C2 | GitHubPullRequestProvider.ts:572-573 catches all review-thread failures as empty results. Propagate rate-limit and deferred-rate-limit errors while retaining ordinary fallback behavior. |
| 694 | 238678951ac | take | C2 | usePullRequestIntentPrefetch.ts:33 reads detail only. Reuse the same environment-scoped target for activity after sustained intent and preserve request suppression on brief hover. |
| 701 | ab45ce71673 | take | C2 | Requires `2d80ca0852d`. GitHubPullRequestApi.ts:1948 drops the remaining comments/reviews cursors, and GitHubPullRequestProvider.ts:647 reports only thread truncation. Use the existing commentsTruncated field for both sources and include 742a91209e2. |
| 702 | 742a91209e2 | take | C1 | Requires `2d80ca0852d`, `ab45ce71673`. The rate-limit fixture added by 2d80ca0852d needs truncated:false after ab45ce71673 makes the API result field required. Land with those changes. |
| 726 | aaf5b9c68e4 | adapt | C2 | PullRequestRouteScreen.tsx:284 holds filter state per mounted route. Persist optional bot/resolved visibility through GOAT preferences and keep a deep-link override transient. |
| 903 | 02f8a3280b8 | adapt | C2 | GOAT baselines during sweep with the event-feed follow step afterward (PullRequestWatchReactor.ts:806–819). Baseline promptly on persisted watch creation and preserve GOAT's scoped subscriptions, settle window and periodic safety net. |

### U39

**Claude adapter and startup (2/3)** · W06 · server-only · 2,375 estimated handwritten changed lines

- Use the extracted GOAT query runner, adapter helpers and Bedrock catalog. Preserve Monitor and explicit Stop semantics through startup and retry. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — claude-adapter, delegated-tasks, code-budgets.
- Test missing session, unanswered reply, MCP registration timeout, root failure with child alive, and old bridge payloads.
- **C4 before code** — rows #368, #384, #584, #636, #767. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (1 source paths) — `packages/contracts/src/server.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K7b (`packages/contracts/src/server.ts`), K12 (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`), K6 (`apps/server/src/orchestration-v2/ProviderSessionManager.ts`), K7 (`packages/client-runtime/src/state/server.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 368 | f5c2ceb4d16 | adapt | **C4** | Requires `4bab2f3ae71`. GOAT separates its query runner (ClaudeAdapterV2.ts:326) and overlays attachment metadata in the adapter (line 3398 onward). Add the Claude rename_session control with persisted applied-title tracking and plan it together with the native rename and immediate-sync follow-ups 56b9dbc87bd and 6071022cb71. |
| 376 | dbbbe8b0d6e | adapt | C1 | The early query-exit branch reports only the generic detail at ClaudeAdapterV2.ts:9724 despite observing the stream exit at line 9498. Carry the existing typed cause to the failed start and coordinate with 629d5083b7b's recoverable resume failure handling. |
| 382 | 3eadb214e83 | adapt | C1 | Idle handling passes message frames into workflow processing at ClaudeAdapterV2.ts:7200 and has no replayed local-command stdout filter. Ignore that echo only while no GOAT turn owns the frame, retaining real user and background activity. |
| 384 | 56b9dbc87bd | adapt | **C4** | Requires `f5c2ceb4d16`. GOAT's Claude adapter has no session_title_changed handler or applied-title tracking. Confirm a native /rename from its successful result, persist the GOAT title and mark it applied so the next send does not echo the rename back. |
| 465 | fa864bfca72 | adapt | C2 | ProviderSessionManager.ts:262 already exposes pending-wake detection. Add a Claude Stop hook that consults it only for active goals, retaining the existing device SubagentStart hook and GOAT delegation behavior. |
| 520 | 4adb946ae77 | adapt | C1 | GOAT's task-start path spreads cached launch details (ClaudeAdapterV2.ts:6974–6995), but ClaudeBackgroundTasks.ts:58 accepts only command_execution. Keep launch lookup and treat Monitor's explicit command as display detail. |
| 584 | 4aead9e6d99 | take | **C4** | ClaudeAdapterV2.ts:8934–8943 returns decline without showing a card. Return MCP cancel in this branch and keep explicit declines. |
| 633 | bf8fd416a2b | adapt | C2 | Use an explicit value flag for append-system-prompt while retaining generic parser defaults. Apply the same parser options at ClaudeAdapterV2.ts:607 and the split readers at ClaudeLaunchArgs.ts:55 and :94. |
| 635 | 5ee4fd4f25a | take | C2 | ClaudeExecutable.ts:14–65 checks npm shims but lacks the WinGet Links-to-Packages executable lookup. Keep existing npm candidates and native binary preference. |
| 636 | 365a62aa84f | adapt | **C4** | ClaudeApproval.ts:76–85 sends the feedback as bare denial text. Attribute it to the user in the extracted helper and keep interruption metadata intact. |
| 639 | 2c2a286ad0b | adapt | C2 | ClaudeAgentSdkQueryRunner.ts:593 owns the query call in GOAT. Filter only the known synchronous SDK warning there and reconcile the wrapper with the later startup retry 0072f66ec12. |
| 723 | 52451a7909c | adapt | C2 | ClaudeAdapterV2.ts:3841 records a monitor in the roster without registering a wait. Mark a new monitor awaited through GOAT's background task path and preserve stop/terminal wake behavior, including later 3605d52842c. |
| 767 | dcaedc98003 | adapt | **C4** | **Contracts.** ClaudeAdapterV2.ts:9492 publishes init without invalidating a prior workspace scan. After first init, rescan only enrolled instance/CWD pairs with bounded coalescing and an optional revision signal; prevent stale probes from replacing newer results. |
| 790 | 09fc222fed6 | take | C1 | deriveTitle at :250 strips Codex preambles and leaves wake envelopes in imported titles. Unwrap the prompt before deriving the title. |
| 816 | 72ddc3ee32e | adapt | C1 | ClaudeToolFrames.ts:389 strips only the native tools-used note. Also strip the hand-back frame and metadata, keeping a framed report distinct from the literal async acknowledgement. |
| 839 | a7d17cd2f5b | take | C1 | AgentSessionScanner.ts:1131 divides discovery budget evenly even when neighboring homes use almost none. Date Claude folders before scanning and redistribute unused budget without increasing the overall read limit. |
| 874 | 629d5083b7b | adapt | C3 | Requires `dbbbe8b0d6e`. Classify a missing native conversation on resume and invalidate the loaded-thread entry on failed start so the next send can reach the fresh-session path. Preserve GOAT's split Claude runner and existing resume logic (ClaudeAdapterV2.ts:10429). |
| 892 | c8c51af4e3f | adapt | C1 | Requires `487733ba0a0`. GOAT's generic 429 branch accepts a reset anywhere in the result (ClaudeAdapterV2.ts:2142–2148). Select the outer reset for recognized credential cooldown messages with nested last-error text and retain GOAT's separate 503 handling at line 2093. |
| 913 | 943de8fe9d5 | adapt | C2 | Requires `66a40c7ca82`. GOAT tracks retry stalls (ProviderSessionManager.ts:2226) but an outstanding request before a response needs its own bound. Track unanswered requests separately, clear only on the relevant frame, and preserve Stop outcomes and intentional long tool work. |

### U40

**ACP transports, prompting and replay (2/3)** · W06 · server-only · 557 estimated handwritten changed lines

- Retain GOAT ACP/Grok/Copilot paths and exact ownership. Distinguish cancellation, detached sessions and live-process tool errors. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — orchestrator-goat-modules, fork-in-scope.
- Exercise older peers, HTTP/stdio, soft interrupt, late replies and native continuation with replay fixtures.
- **C4 before code** — rows #1126. Bring the two-way compatibility and negative-case note to the coordinator.
- Refresh against the carried landing delta. Main overlapping claims — K9 (`packages/provider-acp/src/server/adapter.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 983 | f6d196463cf | adapt | C3 | Requires `015eba40839`. Response parsing iterates the body directly (mcpResponsePayloads.ts:7,60), and adapter.ts:4974 only cancels other pending requests. Cancel scoped readers and in-flight bridge calls on real Stop, preserve settled soft interrupts, and combine with 48359de5f4e and 1063b42768c. |
| 1042 | 48359de5f4e | adapt | C1 | Requires `f6d196463cf`. JSON consumes response.text() outside the scoped reader (mcpResponsePayloads.ts:65). Give JSON and SSE the same interruption cleanup and fold in 1063b42768c for linear SSE parsing. |
| 1097 | b46edac5c19 | take | C1 | Disconnect has no request deadline and the bounded connection set drains sequentially at line 238. Apply the five-second disconnect limit and parallel teardown within the existing cap. |
| 1126 | 73e62fcecc5 | adapt | **C4** | Copilot attribution at line 65 tracks agents but not call identities. Correlate the provider's execution-start metadata to ACP updates, preserve child routing, and cap/clear unfinished per-session entries as well as removing completed ones. |

### U41

**SSH config and process launching (2/2)** · W06 · mac · 307 estimated handwritten changed lines

- Retain GOAT SSH supervisor, generation-log lock, GOAT_HOME and literal PATH/Host/Include handling. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — ssh-runtime, cli-home, node-pin.
- Check UTF-8 and quoted paths, Linux and Windows worker lifetime and update during SSH boot.
- **C4 before code** — rows #942, #950. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (1 source paths) — `packages/contracts/src/resourceTelemetry.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K8 (`packages/ssh/src/tunnel.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 746 | c8a1b5ff0b4 | take | C1 | config.ts:70 passes the home path as a replacement string, so dollar sequences are interpolated by String.replace. Use a function replacement so Include glob expansion preserves literal home paths. |
| 887 | 12b9845d1c5 | adapt | C1 | GOAT invokes both archive hashers by filename (tunnel.ts:655–658), allowing filename escaping to affect checksum parsing. Hash via stdin and also cover the executable digest at tunnel.ts:675–677 under the same path constraint. |
| 942 | d6a28f4faaf | take | **C4** | Manual onboarding already requests known-address-only when no environment ID is supplied (onboarding.ts:173–174), but SSH registration at line 334 omits it. Apply the same trust policy to unsolicited SSH identities. |
| 950 | ba1193273ad | adapt | **C4** | **Contracts.** GOAT already injects GOAT_RELEASE_BASE_URL from DesktopConfig, but captures it while building the SSH layer (main.ts:173–195). Resolve the mirror at connect time, including late shell discovery, while preserving GOAT's packaged/bundled archive preference and configured fallback. |
| 960 | b50e98e71cb | adapt | C1 | Requires `c8a1b5ff0b4`. GOAT matches decoded names as JavaScript characters (config.ts:93,122). Port the final byte matcher once for Include and Host patterns, and carry byte-order sorting with the related follow-up. |
| 1082 | 100ba49a65c | adapt | C1 | Requires `b50e98e71cb`. Host and Include both use a Unicode string regex (`packages/ssh/src/config.ts:93`, `:122`, `:161`). Apply byte-mode matching with line-separator coverage from b50e98e71cb and carry the ordering fix in 733821285cf. |
| 1090 | 733821285cf | adapt | C1 | Requires `b50e98e71cb`, `100ba49a65c`. Include still uses default UTF-16 sorting at line 142. Sort matches by the same UTF-8 bytes used for the matcher so OpenSSH's first-match configuration order is preserved. |
| 1100 | 38f7761148f | adapt | C2 | GOAT's shared shell still strips wrapping quotes unconditionally (line 399). Preserve literal POSIX entries in the shared shell and the Antigravity installer while retaining Windows trimming and unquoting. |

### U42

**Terminal attach, input and platform paths (1/3)** · W07 · mac · 2,422 estimated handwritten changed lines

- Start from T3 errors and GOAT terminalLeaseOrder. Retain attach generations, resize-before-input, one PTY reply owner and older-peer semantics. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — contracts-rpc-leaves, ssh-runtime.
- Run Manager and terminal client checks. Exercise real Windows/WSL for encodings, shell paths, UNC and delayed PTY events.
- **C4 before code** — rows #103, #267, #395, #507. Bring the two-way compatibility and negative-case note to the coordinator.
- Refresh against the carried landing delta. Main overlapping claims — T3 (`packages/client-runtime/src/state/runtime.test.ts`), K7 (`apps/server/src/terminal/Manager.ts`), K4 (`apps/server/src/terminal/Manager.ts`), K2 (`packages/shared/package.json`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 103 | 96051c630d5 | adapt | **C4** | Legacy default-terminal read and deletion both accept aliases in the modern terminal_ namespace (Manager.ts:979,1420). Gate both case-insensitively and preserve GOAT lease and cleanup ordering. |
| 133 | f315da33395 | adapt | C1 | Improve badge contrast on GOAT’s actual ANSI palette. The hard-coded luminance cutoff at terminalOutput.ts:834 selects foreground on a background-color heuristic. |
| 154 | 83a276dfdd6 | adapt | C2 | The setup wrapper sends raw multi-line text through the shell line editor (ProjectSetupScriptRunner.ts:215). Encode it into bounded POSIX TTY input with explicit completion, preserving GOAT’s Windows and PowerShell paths. |
| 170 | 0fee26d5bf6 | take | C1 | The terminal writes on the first nonzero snapshot (terminal.ts:370). Wait for a running attachment and a successful resize of its current measured grid before sending initial input once. |
| 239 | e72dd5055eb | take | C1 | `packages/client-runtime/src/state/terminal.ts:66` uses the default subscriber-retention window for PTY attach. Expire the attach immediately after the final view leaves. |
| 267 | 3908c4eab3a | adapt | **C4** | `native/libghostty-vt/VERSION:1` and the mobile pin at `apps/mobile/modules/goat-terminal/scripts/build-libghostty-android.sh:10` predate the OSC reply fix in Ghostty `3ff6d08fad56`. Update matching headers and binaries together, verify the changed ABI against GoAT wrappers, and cover web/desktop plus both native mobile builds. |
| 279 | 43a71d9b1ac | adapt | C2 | The existing generation guard at `apps/web/src/components/ThreadTerminalDrawer.tsx:543` does not cover all keystrokes. Exclude closing terminal IDs across drawer and script reuse, reject pre-running input locally, and preserve the server's lease ordering. |
| 381 | e9fbb569224 | adapt | C1 | GOAT's mock uses weak Atom.family instances at ThreadTerminalDrawer.browser.test.tsx:49–61. Use a strongly held atom keyed by environment and thread with per-test reset, without importing the upstream setter or fixture changes that GOAT lacks. |
| 394 | 6ea5af70adb | take | C2 | terminal-links.ts:69–72 rescans the entire candidate for each closing delimiter. The clean patch counts delimiters once per pair. |
| 395 | 2bee33eb193 | adapt | **C4** | terminalOutput.ts:68–100 slices by UTF-16 offsets even when the terminal cursor addresses display cells. Separate buffer-size units from cell widths and carry split surrogates across chunks, reconciling the width dependency and GOAT lockfile. |
| 507 | 6a8f022b451 | adapt | **C4** | GOAT pins beta.18 (apps/server/package.json:71), and its installed WindowsPtyAgent.js:23 and windowsConoutConnection.js:52 still use 1,000 ms. Port the shorter timers and buffered-output guard onto beta.18 while preserving the GOAT watch-worker patch. |
| 551 | 828200fc040 | adapt | C2 | clearLocked waits for history persistence at Manager.ts:2807 under GOAT's terminal lock. Queue immediate persistence without a quiescence wait, retain clear ordering and check read/close durability. |
| 564 | 62ee1039960 | take | C1 | Requires `83a276dfdd6`. The setup output stripper at ProjectSetupScriptRunner.ts:152 only matches a subset of controls. Recognize complete CSI, OSC and escape forms while keeping the setup transcript's text and sentinel behavior. |
| 651 | e0ca4fcecb0 | adapt | C3 | Requires `0fee26d5bf6`, `43a71d9b1ac`. The resize senders at terminal.ts:278 and ThreadTerminalDrawer.tsx:540 need a single retry per still-current writable generation. Preserve mobile initial-input ordering, cancellation and reopened-session handling. |
| 706 | 3fe1dd922de | adapt | C2 | Ghostty surface.ts:998-1005 tracks DOM focus without notifying the PTY. Encode real transitions only in DEC 1004, coordinating with 45dbb4436c0 if its terminal-write changes land. |

### U43

**Mobile outbox and attachment delivery (1/3)** · W07 · mac · 944 estimated handwritten changed lines

- Preserve workspace/revision and command-ID replay, including a lost first response. Track #905 through #906 and #907 to one upload registry. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — mobile-sheet-header, composer-footer, code-budgets.
- Test pending-to-sent attachment continuity, project stamping and deduplication across restart and reconnect.
- **C4 before code** — rows #213, #290. Bring the two-way compatibility and negative-case note to the coordinator.
- Refresh against the carried landing delta. Main overlapping claims — K7 (`apps/mobile/src/state/threadOutboxDelivery.ts`), K12 (`apps/mobile/src/features/threads/ThreadFeed.tsx`), M3b (`apps/mobile/src/features/threads/ThreadFeed.tsx`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 10 | 134ab31276d | adapt | C2 | GOAT treats a visible thread as an existing destination during both live delivery and resumed retry (threadOutboxDelivery.ts:684,780–791). Preserve the original workspace and revision for command-ID replay after a lost launch reply, including if the later worker refactor 07e8bfa70d6 is taken. |
| 213 | 0e5e0bb6527 | adapt | **C4** | `apps/mobile/src/connection/platform.ts:232` puts outbox, drafts, and composer-error cleanup in one fan-out, including GOAT-owned cleanup. Catch and report each failure independently and wait for sibling clears so removal can finish. |
| 228 | b90ffeaf288 | adapt | C2 | `apps/mobile/src/state/use-composer-drafts.ts:1283` caps additions and releases unused resources. Deduplicate before caps, exempt restoration, and bring the byte-aware image fix from `7d9c365e173` in the same port so distinct pasted images are retained. |
| 290 | 0f50b5f66de | adapt | **C4** | Requires `86ec940ad3e`. `apps/mobile/src/features/home/useThreadListActions.ts:211` refreshes archive state after successful deletion but leaves the mobile composer draft. Clear the scoped draft there after the retained permission check and retain it on failure. |
| 893 | 4860a730695 | adapt | C3 | Requires `12c495af498`. GOAT keys posters from the current source (ThreadMarkdownVideo.tsx:22) and renders only normal acknowledged messages during the projection gap (use-thread-composer-state.ts:264). Preserve the first-message attachments and stable media identity; take shared upload/reconnect behavior from the final 905–907 design. |
| 1149 | a93e61a3438 | adapt | C3 | The strip drops document attachments at `composerImages.ts:89`, even when their upload state is failed. Expose existing retry on failed document entries without changing normal chip references or GOAT's strip layout. |

### U44

**Desktop shell, native IPC and file actions (2/2)** · W07 · mac · 295 estimated handwritten changed lines

- Keep GOAT main-process authority. Under #923 validate device-local paths and originating surface. Preserve file-manager and WSL conversion semantics. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — desktop-identity, peer-links, contracts-rpc-leaves.
- Test unauthorized remote paths, old preload, Finder drag and real Windows Reveal behavior where applicable.
- Refresh against the carried landing delta. Main overlapping claims — K8 (`apps/server/src/process/externalLauncher.test.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 506 | 703810f3086 | adapt | C2 | At externalLauncher.ts:675 the launch path hands off an unnormalized input. Expand both host-side cwd and optional projectRoot at that boundary before tests for reveal, project-relative launch and external-home paths. |
| 560 | bdf6c6ec890 | adapt | C2 | The WSL file-manager helper at externalLauncher.ts:367 always builds a UNC form. Use a bounded host-side wslpath lookup for open and reveal, preserving GOAT's UNC fallback and Windows argument handling. |
| 582 | bf3549b7ad1 | take | C2 | Requires `703810f3086`, `bdf6c6ec890`. Linux editor enumeration uses the boot service's process environment at externalLauncher.ts:439–442. Use the discovered desktop session for enumeration and launch, keeping headless rejection and existing WSL behavior. |
| 733 | 64440877793 | take | C1 | main.rs:437 scans the process rows for each external PID. Use indexed per-PID lookup while retaining start-time identity validation against PID reuse. |
| 1108 | 2df750e0c94 | take | C1 | The fullscreen header begins at line 449 without clearance for window controls. Use GOAT's existing native-titlebar height hook only in fullscreen and verify the overlay close control stays reachable. [recheck: take, see /tmp/chase1118/triage-recheck.md] |

### U45

**Git refresh, refs and source-control actions (2/3)** · W07 · mac · 2,499 estimated handwritten changed lines

- Preserve GOAT Git providers, raw-cwd and selected environment scoping, separate full/light status and fetch/autopull fences. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — pr-event-feeds, contracts-rpc-leaves.
- Check old peer negotiation, mixed subscriber demand, disappearing refs, restricted fetch mappings and external clones.
- **C4 before code** — rows #331, #345, #513, #604, #613. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (1 source paths) — `packages/contracts/src/review.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K3 (`apps/server/src/vcs/VcsStatusBroadcaster.ts`), K4 (`apps/server/src/vcs/GitVcsDriverCore.ts`), K7b (`apps/server/src/server.ts`), K8 (`apps/server/src/server.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 327 | d2a94143596 | adapt | C2 | GOAT isolates the guard in commitConflictMarkers.ts:75–104, where raw UTF-8 file reads are compared to Git's filtered line numbers. Read Git's clean-filtered representation with bounded output and fail closed if it cannot be verified. |
| 331 | 76ae36ef8cc | adapt | **C4** | useThreadActions.ts:484–506 excludes selected deletion IDs but still counts the parent's side chats as occupants. Use the same cascade as server deletion and preserve cross-thread occupancy checks, confirmation, and capability behavior. |
| 342 | eec0a372274 | adapt | C3 | The interval reference is scoped to the broadcaster (VcsStatusBroadcaster.ts:150–165 and server.ts:499), while GitVcsDriverCore.ts:1515 separately refreshes upstream. Provide a shared settings-backed policy before the memoized driver is built and apply zero only to automatic fetch. |
| 345 | bef412cff61 | adapt | **C4** | **Contracts.** ReviewDiffFileStat lacks changeType (review.ts:32–37) and the web placeholder guesses from rename information (useReviewFilePatches.ts:120). Extend GOAT's extracted parser and staged, unstaged and committed metadata reads with optional change types, with the old fallback on both clients. |
| 365 | 6e2747921c5 | adapt | C3 | Requires `a575d45286f`, `a3477a5dd93`. The explicit refresh reads local status at VcsStatusBroadcaster.ts:531 and rereads inside the remote refresh at line 545. Compare bounded ref, symbolic HEAD and shallow state around refresh, retaining GOAT fetch/autopull behavior and falling back to a reread when the snapshot is unavailable. |
| 419 | 9ab1d22d8fc | adapt | C2 | GitManager.ts:1989 sanitizes without the generation policy and TextGenerationPresets.ts:6 lacks the instruction. Normalize generated Conventional Commits descriptions only, preserving acronym/brand spelling, explicit messages and other policies. |
| 425 | b9a68e0f57c | adapt | C3 | Requires `294e061a202`, `4d5d5f89d41`. git.ts:161 preserves the encoded spelling and definition.ts:444 compares lowercased strings. Canonicalize each segment for matching and old saved keys while preserving display paths; inspect Bitbucket, GitCafe and Cursor identities for callers using the old spelling. |
| 440 | c041761d89e | adapt | C2 | The branch picker can reuse a stale worktree claim from its refs query at BranchToolbarBranchSelector.tsx:109–136. Confirm the selected ref in that worktree and ignore late results after another selection or navigation. |
| 445 | 1483e970bd6 | adapt | C2 | GitVcsDriverCore.ts:799 and :1231–1251 share a semaphore-queued status fetch with Pull. Let Pull claim only queued work and resolve status waiters, with running writers still serialized. |
| 447 | 2dfc4a9c983 | adapt | C3 | Requires `83ee1f5d486`, `ca1a0280dac`. AzureDevOpsCli.ts:425 still relies on az --detect. Resolve organization/project/repository from the selected remote and preserve explicit remote semantics, URL encoding and GOAT's CLI execution boundaries. |
| 455 | c62c7649f74 | adapt | C3 | path.ts:113 only folds decomposable accents and ManagedProjectFolders.ts:153 separately filters scratch names. Share the Latin fold so đ and Đ survive as d and D, incorporating a16796b956a for ß. |
| 513 | cef95b6db91 | adapt | **C4** | cloneUrl.ts:83 uses raw URI path components. Decode URI paths before the existing per-segment safety checks at :89, keeping SCP paths literal and rejecting malformed escapes. |
| 547 | bee9eb59393 | take | C1 | The userless SCP regex at sourceControl.ts:3 requires a slash-separated second component. Permit a single path component with the existing Windows drive and double-colon exclusions. |
| 552 | 6615615b125 | take | C1 | The origin parser at git.ts:266 uses its own continuation join and can consume a section after a comment. Reuse gitConfigLines from :187, already used by the shared remote reader. |
| 579 | 6152fe3ae82 | adapt | C3 | Requires `414d9385132`. GitManager.ts:1317 and :2313 use the singular config reader for repository identity. Pick the first configured fetch URL across GOAT's host implementations and keep push-remote selection separate when integrating `d0a494fc0bf`. |
| 593 | c6a120a958c | take | C3 | Forgejo definition.ts:41 keys host identity off the remote. Prefer its resolved web host and port so a distinct SSH endpoint still matches the guide's server. |
| 604 | 5a31f1749d4 | adapt | **C4** | GitHub media fetch at gitHubMediaFetch.ts:194 returns the raw plain-text response before any LFS fallback. Add the same-host-family object fallback within GOAT's credential, redirect and media-type gates. |
| 611 | a9386ac8a67 | take | C2 | GitLabCli.ts:545 encodes the entire pasted URL as a project name. Parse the GitLab host and nested project path before the CLI lookup, retaining plain selectors. |
| 613 | 808dae15843 | adapt | **C4** | Recognize an annex worktree only when its admin backlink identifies the same worktree. Use the shared predicate in GOAT's cleanup gates at storageCleanup.ts:350, :386 and :708 and restore the symlink if removal fails. |
| 652 | 3b5bfcec4f3 | take | C1 | gitCafeHosts.ts:14 requires a username in ssh URLs. Accept valid username-less URLs while preserving host and repository validation. |

### U46

**ACP transports, prompting and replay (3/3)** · W07 · server-only · 2,477 estimated handwritten changed lines

- Retain GOAT ACP/Grok/Copilot paths and exact ownership. Distinguish cancellation, detached sessions and live-process tool errors. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — orchestrator-goat-modules, fork-in-scope.
- Exercise older peers, HTTP/stdio, soft interrupt, late replies and native continuation with replay fixtures.
- **C4 before code** — rows #789, #850, #1077. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (1 source paths) — `packages/contracts/src/acpRegistry.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K9 (`apps/server/src/orchestration-v2/Orchestrator.ts`), K6 (`apps/server/src/orchestration-v2/Orchestrator.ts`), K7 (`apps/server/src/orchestration-v2/Orchestrator.ts`), K7b (`apps/server/src/ws.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 721 | 5e0127ca834 | adapt | C3 | probe.ts:470 waits only for commands and driver.ts:655 uses one long success TTL from the start of probing. Observe delayed model advertisements, give provisional lists a short TTL and guard live-versus-probe publication by generation. |
| 788 | c2e54e3ac9c | adapt | C3 | GOAT moved listing/import to its own service and checks only the derived import ID at AcpSessionService.ts:133. Check existing non-deleted owners by instance and native session for both list and import, retaining GOAT's shared MCP/WS entry point. |
| 789 | aee231133ae | adapt | **C4** | **Contracts.** Probe output omits agent version at probe.ts:282 and readiness cache compares an inspected version at driver.ts:635. Carry bounded initialize agentInfo.version for local executables and retain it across readiness refreshes without overriding managed-source versions. |
| 809 | 51cdf232652 | adapt | C3 | RunExecutionService.ts:1207 tracks background work but does not settle all persisted process-bound tools on runtime death. Re-read live projections, distinguish detach and a live-provider write error, and preserve GOAT's own cleanup and remote descendants. |
| 821 | 623047ccfd6 | adapt | C3 | Requires `51cdf232652`. On stream loss at adapter.ts:1398 the adapter cancels input and finalizes without settling open tools. Fold the cleanup into 47f90ee2e94, which also handles a still-live agent's rejected prompt. |
| 849 | e8bfabaa398 | adapt | C3 | Requires `35d01dc291a`. At :4281 whitespace-only chunks are discarded before a message can be assembled. Keep separators and skip only fully blank attachment-free messages, integrating the monitor and session filters from b0a46d28482 and 5dd8cde0831. |
| 850 | 7f1fa0d4477 | adapt | **C4** | Requires `5e0127ca834`. Settings at :61 use string-only custom models even though the editor stores structured names/options. Accept both legacy and structured entries through the enrichment and settings paths. |
| 856 | 47f90ee2e94 | adapt | C3 | Requires `623047ccfd6`. The common foreground cleanup at adapter.ts:6635 is all-or-nothing. End pending calls after an ACP request error, let already running work from a live agent settle, and close all such tools on transport loss. |
| 858 | b0a46d28482 | take | C1 | Requires `e8bfabaa398`. The post-settle and history branches use broad monitor regexes at :505 and :4279. After the whitespace port, match the actual leading envelope and allow quoted or embedded monitor markup to replay as text. |
| 859 | 837a684fd20 | adapt | C2 | Inspection at AcpRegistrySupport.ts:1628 requires a valid disk cache and driver.ts:676 uses it for initial snapshot. Recover via the existing refresh path on missing/corrupt cache without putting registry I/O on instance creation. |
| 860 | d68a2fa6734 | adapt | C2 | GOAT's ACP adapter already has a watchPromptOutcome hook at adapter.ts:7462, but the registry flavor lacks Kimi wiring. Use a bounded cursor over the agent's own session log, attributing only the new prompt's outcome, and include d6672df2738 for the test. |
| 870 | 5dd8cde0831 | adapt | C3 | Requires `834eb51301a`, `e8bfabaa398`, `b0a46d28482`. Root history accepts idle message chunks near :4264 before activation establishes their owner. Track the session being loaded across all activation paths and filter child output by identity, clearing on success, failure or interruption. |
| 959 | 1402a2c9bf3 | take | C1 | The shared curated error mapper has no dedicated ACP auth-required branch (failure.ts:159–167). Use safe sign-in guidance for the reserved response code and preserve generic failure text elsewhere. |
| 979 | ccae953c46c | adapt | C3 | ACP advertises native conversation rollback even though its guide says it starts a fresh session (adapter.ts, AcpProviderCapabilitiesV2; docs/user/providers-acp.md:141). Use the existing ProviderContextBoundaries.ts:191, hand off retained/inherited turns around the rollback, and keep fresh-context and scheduled-side-conversation boundaries. |
| 1077 | bee9c3b796f | adapt | **C4** | The ACP call at `adapter.ts:5796` ignores Devin's explicit metadata opt-in. Permit a nonblank typed value only for opted-in single choices, preserving enum, companion and multi-choice validation on the provider wire. |

### U47

**PR lists, writes and provider scoping (2/3)** · W07 · mac · 1,718 estimated handwritten changed lines

- Keep GOAT host identity, authorizing environment and optimistic rollback scoped to the selected account. Keep PR saved views operable before Issues. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — pr-event-feeds, settings-page.
- Test failed writes, stale host state, capability absence and mixed-scope filter persistence.
- **C4 before code** — rows #876. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (1 source paths) — `packages/contracts/src/pullRequest.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K2 (`apps/web/src/components/pullRequest/PullRequestsPage.tsx`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 666 | d5a50a1d0d1 | adapt | C3 | PullRequestLabelPicker.tsx:33 and :46 and the shared action atoms wait on host replies. Apply one scoped pending-write overlay across readers and retained pages, reconcile writes in order and keep merge outcomes server-driven. |
| 876 | d427894aa1d | adapt | **C4** | **Contracts.** Requires `86a9d9fb71a`. GOAT already routes host-scoped reads through any matching checkout but gives the generic unsupported error when none exists (PullRequestService.ts:730,772). Add a compatible host-level diagnostic for those providers and retain a repository-level diagnostic for providers that require a matching checkout. |
| 878 | cd42e1a4973 | take | C1 | The author option still renders a literal “merges loaded” (PullRequestListFilters.tsx:318); the singular branch applies directly. |
| 896 | 0a842b222d5 | adapt | C1 | GOAT's authored/review buckets key by the environment-scoped entry key (pullRequestList.logic.ts:464). Dedupe by canonical host/repository/number or URL across environments while keeping a deterministic usable route and avoiding collisions on GOAT-only hosts. |
| 970 | 26f70e72fa4 | take | C3 | Each client stores only the latest boolean per reaction (web PullRequestReactions.tsx:52, mobile PullRequestReactions.tsx:48). Tie rollback to the individual mutation identity so an older failure cannot clear the current optimistic choice. |

### U48

**Web conversation, timeline and accessibility (2/2)** · W08 · mac · 2,289 estimated handwritten changed lines

- Preserve GOAT Reply and hidden-tool/delegated grouping, stable streamed identity and existing behavior while #412 is pending. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — reply-to-response, delegated-tasks, composer-footer.
- Check live and paged history, exact whitespace, queue and accessibility outcomes at the screen.
- **C4 before code** — rows #46, #478. Bring the two-way compatibility and negative-case note to the coordinator.
- Refresh against the carried landing delta. Main overlapping claims — K12 (`apps/server/src/orchestration-v2/ProjectionStore.ts`), K8 (`apps/web/src/components/ChatView.tsx`), K2 (`apps/web/src/components/ChatView.tsx`), K6 (`apps/server/src/orchestration-v2/ProjectionStore.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 11 | 48cdefed5ae | take | C1 | GOAT passes authored values directly to Number (ChatMarkdownMedia.tsx:82–85), dropping dimensions with px. The sizing hunk fits as written and the browser test needs only a context adjustment. |
| 19 | 3c1be119b9c | adapt | C1 | GOAT’s chat column (ChatView.tsx:3395–3397) lacks the middle-button guard. Preserve editable targets and native link actions while suppressing Linux primary-selection paste on empty chat space. |
| 46 | dea07a1b12d | adapt | **C4** | GOAT enables file restore on checkpoint readiness alone (ChatOverlayHosts.tsx:203), while the server checks isolation (CheckpointRollbackService.ts:237,282). Match the isolated-workspace rule in the web UI and retain message-only rewind. |
| 63 | 4c7685729f1 | adapt | C2 | GOAT’s injected page script owns image clicks, links and shortcut behavior (htmlRender.ts:420). Keep focus on the associated control without scrolling the iframe and preserve GOAT’s image and keyboard hooks. |
| 129 | b2259d3c6ca | adapt | C1 | ChatView.tsx:1507 already has GOAT’s connecting path. Add persisted preparing, starting and queued phases to the timeline predicate while keeping GOAT’s connection and resumed-run indicators. |
| 147 | c0b140b5bcf | adapt | C3 | Empty changes arrays currently suppress the recorded file name in prompt context (ContextHandoffService.ts:117) and mobile (threadActivity.ts:568). Apply the fallback across handoff, budgeting and both clients. |
| 153 | 2fa77fbf553 | take | C2 | The wheel listener forwards only deltaY (timelineViewport.ts:81). Ignore horizontal-dominant and shift-wheel events so scrolling a table leaves follow intact. |
| 206 | f161a4d2b59 | take | C1 | `packages/shared/src/codexFileCitations.ts:45` escapes Markdown destinations but omits ampersands. Encode them before an entity-like path can be decoded as markup. |
| 227 | 666631e94eb | take | C1 | `apps/web/src/markdown-clipboard.ts:51` pads backtick edges only. Also pad spans with two meaningful space edges so CommonMark preserves them. |
| 240 | cc0a7bb9d85 | adapt | C3 | `packages/shared/src/markdownLinks.ts:378` stops bare destinations at the first close parenthesis, while `apps/web/src/components/ChatMarkdown.tsx:329` keys labels from those destinations. Parse balanced links with a depth bound and use renderer-compatible unescaping for labels and thread find. |
| 245 | acd192fc64a | adapt | C2 | `apps/web/src/components/ThreadNotificationCoordinator.tsx:606` prunes native notifications by environment while the GOAT toast map at :93 is keyed by scoped thread. Close removed-environment toasts through that index and leave active-environment toasts open. |
| 266 | 6cb47acfb8c | adapt | C1 | `apps/web/src/components/chat/ChatHeader.tsx:323` cancels rename on Escape without consuming it. Prevent the default so the window handler leaves find open, preserving the existing IME guard. |
| 272 | c666345bb9a | adapt | C3 | Mobile already uses the better expression at `apps/mobile/src/features/threads/subagent-card-presentation.ts:10`; web's `apps/web/src/components/chat/V2LifecycleRow.tsx:220` still leaks image syntax and URL tails. Share the formatter and retain the mobile module's other presentation helper. |
| 281 | 4954322f02f | adapt | C3 | `apps/web/src/components/ThreadNotificationCoordinator.tsx:517` already filters archived and silent runs but omits snooze. Suppress completions including held ones based on event time, preserve attention notifications, and omit the managed-relay part gated off at `apps/server/src/relay/AgentAwarenessRelay.ts:388`. |
| 335 | bf746695091 | adapt | C1 | serializeAnchor drops mailto destinations at markdown-clipboard.ts:203–212. Keep safe mail links and escape their destination delimiters with 3c77d3d64b8, which updates the same logic for escaped labels. |
| 340 | 1f45f14ae86 | adapt | C3 | Web queue thumbnails are spans (QueuedRunsControl.tsx:414–433), and mobile thumbnails render a bare image (ThreadQueueControl.tsx:698–720). Attach separate accessible preview actions to existing galleries for both pending and persisted items without taking over queue editing. |
| 373 | 3c77d3d64b8 | adapt | C2 | Requires `bf746695091`. Clipboard text bypasses prose escaping at markdown-clipboard.ts:235 and partial selections special-case only pre at line 495. Port the final serializer with the mail-link patch, preserve Windows path literals and code selections, and cover round trips through the composer. |
| 388 | 0cf9423d8b1 | take | C1 | threadFindHighlights.ts:158 spreads all row matches into push, exceeding argument limits for very large rows. Append iteratively to keep every match and the active highlight. |
| 409 | 093c317858f | take | C2 | markdown-clipboard.ts:153–159 reads numbering from the clipped list. The serializer patch applies cleanly and restores the source item number in the cloned selection; move the test into GOAT's fixture context. |
| 412 | 5f80af68052 | decide · pending d1 | C2 | d1 recommendation — skip and retain GOAT whole-span selection. Should double-click restore native word selection for inline code or keep GOAT's explicitly tested whole-span selection at ChatMarkdown.browser.test.tsx:681? |
| 434 | d080e4eb587 | adapt | C2 | ChatCanvas.tsx:72 measures the transient width and threadDetailsCardLayout.ts:33 immediately uses it for fit. Keep the card out when either endpoint is too narrow using GOAT's panel and measurement model. |
| 478 | 1ba934798f8 | take | **C4** | markdownWindowsPaths.ts:16 loses Windows backslashes whenever the authored URL contains an ampersand. The clean patch preserves slashes while decoding entities with a new direct micromark dependency. |
| 501 | 96ffe454cdb | take | C3 | Both scanners classify a line-leading inline triple-backtick span as a fence (assistantStreaming.ts:6 and markdownStreamBlocks.ts:4). Apply the matching CommonMark backtick restriction with trivial pattern-context adjustment. |
| 528 | dd3d4a4e4a2 | adapt | C1 | ShellCommandBlock.tsx:11 gives token words inline-block geometry that paints stray selection areas. Use inline selection behavior while preserving GOAT's wrapping and highlighting. |
| 626 | da95a047631 | adapt | C1 | The preview shortcut guard at chatRouteCommands.ts:78–79 resolves a server thread only. Resolve the draft's environment at event time and run the same capability check. |
| 660 | 25c44fcc336 | adapt | C1 | The project breadcrumb at ChatHeader.tsx:356 hits GOAT's fixed cap even with room. Allocate spare width and preserve both the surrounding controls and narrow-layout truncation. |
| 662 | f7a1bacd276 | adapt | C2 | The position at ThreadRelationshipIcon.tsx:81 depends on each row's badge. Use a stable list-level badge policy for GOAT local, linked and remote task avatars with GOAT's icon layout. |
| 664 | 843893e58c3 | adapt | C2 | MessagesTimeline.tsx:867 tests the prompt row only. Use the turn's span up to the next prompt so the active strip stays selected through long assistant replies. |
| 708 | 4fa5f0e0e64 | adapt | C2 | ChatView.tsx:842-902 knows the parent by lineage, and GOAT owns side chats under components/sideChat. Resolve a side-chat target into its owning conversation and tab across parent, relationship and lifecycle entry points. |
| 795 | 598296e8504 | take | C1 | Copy sends the entire fence text at :185. Remove just the final parser newline, preserving intentional preceding newlines. |
| 822 | 58b6e1c5ba2 | take | C1 | The native disabled button at :898 cannot trigger the explanation. Make the unavailable control focusable with aria-disabled and retain the guarded click path. |
| 871 | dfeaf7b1378 | take | C1 | Cancel is tabbable at AssistantCitationCommentEditor.tsx:108–111. The focused change fits GOAT's voice-aware editor, and dd40cb51ea8 preserves this keyboard behavior when regrouping its buttons. |
| 886 | 1ae5590a329 | take | C2 | The visible count itself is polite-live (ThreadFindBar.tsx:90); derive a separate announcement for settled user search/navigation and keep streaming count refreshes silent. The existing navigation ID supplies the distinction. |
| 909 | 6f5861fa27c | adapt | C3 | The shared classifier rejects all whitespace (markdownLinks.ts:178), and mobile also prefilters spans with its own regex (markdownDocument.ts:339). Permit clearly file-like absolute paths with spaces on both surfaces while keeping command snippets as code. |
| 917 | 959f422d457 | take | C2 | The shared announcer only drops queued messages (announce.ts), and the local hook already has a 7-second cleanup (useLiveRegion.ts:6,33). Clear centralized spoken text on expiry or source cancellation and reuse the existing interval. |
| 919 | 6e650b38490 | take | C2 | Window return uses a focused-element check (ChatView.logic.ts:1114). Include the current DOM selection so autofocus preserves copied or highlighted text while keeping GOAT's other focus exclusions. |
| 940 | 4b758f49ec5 | take | C1 | The citation target currently scrolls but does not take focus (AssistantCitationSource.tsx, observeAssistantCitationSource). Make it programmatically focusable, preserving focus in active editable controls. |
| 990 | ebd007e6aeb | take | C1 | Wrap the View instructions button in the existing popover close primitive so opening the right panel dismisses its trigger content. The conflict is in adjacent test context. |
| 1040 | d6419d92a0e | adapt | C2 | Requires `96ffe454cdb`. Block-by-block streaming can restart GitHub-style slug numbering (markdownFragments.ts:71; markdownStreamBlocks.ts:16). Use a whole-document pass for repeated or ambiguous heading slugs and continue incremental rendering for ordinary blocks. |

### U49

**Mobile outbox and attachment delivery (2/3)** · W08 · mac · 2,201 estimated handwritten changed lines

- Preserve workspace/revision and command-ID replay, including a lost first response. Track #905 through #906 and #907 to one upload registry. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — mobile-sheet-header, composer-footer, code-budgets.
- Test pending-to-sent attachment continuity, project stamping and deduplication across restart and reconnect.
- Refresh against the carried landing delta. Main overlapping claims — K7 (`apps/mobile/src/state/threadOutboxDelivery.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 905 | cfb1f125412 | adapt | C3 | Requires `4860a730695`. The project-selection effect (new-task-flow-provider.tsx:314) and separate send/preupload paths can diverge. Keep the draft's project stamp authoritative and compose durable outbox updates; land shared-upload semantics with the final cross-client registry. |

### U50

**PR lists, writes and provider scoping (3/3)** · W08 · mac · 1,069 estimated handwritten changed lines

- Keep GOAT host identity, authorizing environment and optimistic rollback scoped to the selected account. Keep PR saved views operable before Issues. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — pr-event-feeds, settings-page.
- Test failed writes, stale host state, capability absence and mixed-scope filter persistence.
- Refresh against the carried landing delta. Main overlapping claims — K2 (`docs/user/source-control.md`), K1 (`docs/user/source-control.md`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 1016 | 2d265dc410c | adapt | C3 | PR-only saved views may run ahead of Issues. Leave the Issue-specific reducer hunk for the conditional rollout. Add save, apply, rename and delete for device-local PR filter views. Wire GOAT's existing workspace navigation instead of the absent upstream workspace-tabs-state file and use the final generic shape from bb29ee3e71b if Issues also lands. |
| 1038 | 9bc3fda0ac2 | adapt | C2 | GOAT's normalized Azure PR hardcodes an empty label list in toChangeRequest. Decode list rows and read detail labels separately when available, preserving existing known labels if that ancillary read fails. |
| 1089 | ffc5bbffb03 | take | C1 | The mobile quick action falls through to Commit at line 242 once push-relative ahead count reaches zero. Use the default-branch delta while retaining the existing open-PR and provider terminology branches. |

### U51

**Usage, quota and device coverage (1/2)** · W08 · mac · 2,440 estimated handwritten changed lines

- Preserve provider-specific cache/history identity, resumed accounting and Windows/WSL deduplication. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — cli-home, server-activity.
- Verify old-cache replay and moved/deleted logs. Use chart accessibility checks and Android widget device coverage where applicable.
- **C4 before code** — rows #57, #156, #481, #994. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (4 source paths) — `packages/contracts/src/settings.ts`, `packages/contracts/src/usage.ts`, `packages/contracts/src/providerUsageLimits.ts`, `packages/contracts/src/agentSurface/settingsAccess.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K1 (`apps/server/src/orchestration-v2/Orchestrator.ts`), K6 (`apps/server/src/orchestration-v2/Orchestrator.ts`), K6b (`apps/server/src/orchestration-v2/Orchestrator.ts`), K7 (`apps/server/src/orchestration-v2/Orchestrator.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 1 | 9ced4f1f45b | adapt | C2 | The GOAT timestamp only advances on an explicit rebase (:58–63) and the older-snapshot branch still allows duplicate accounting (:352–366). Date every baseline move, retain pending requests on replay, and invalidate old Codex resume state alongside 47e24f6cc2f’s later cache revision. |
| 57 | 525f5b2f6de | adapt | **C4** | **Contracts.** GOAT fingerprints transcripts by host, path and volume (UsageService.ts:733), splitting the same files seen from Windows and WSL. Port the optional physical-source identity using a GOAT-owned install scope and keep the old fingerprint fallback. |
| 95 | 25c5032b3b1 | adapt | C2 | The remote probe tests only adb (sshDeviceScript.ts:53–56) while local discovery distinguishes SDK tool availability (LocalDeviceHost.ts:140–149). Honor configured SDK roots and give actionable emulator-tool errors while preserving the supported physical-device path. |
| 156 | 4192234c34e | adapt | **C4** | **Contracts.** The anonymous key currently combines only a hub-local source and account (usageLimits.ts:377). Supply a canonical credential-free endpoint for shared hubs and scope local or ambiguous sources by environment. |
| 168 | 02e29ce8fa5 | adapt | C1 | The actual patch pins rates and summary metadata together; it adds no saved-totals fast path. Take the snapshot before constructing GOAT’s aggregator and reuse it in the response (UsageService.ts:558,782). |
| 255 | 616067de84b | adapt | C1 | `apps/web/src/components/settings/AddUsageLimitSourceDialog.tsx:92` has a submit handler but its footer at :145 uses a click-only button. Associate the button with the form so Enter follows the same validation and save path. |
| 282 | cc578d5f9a3 | adapt | C2 | `apps/server/src/orchestration-v2/Orchestrator.ts:3125` treats a settled thread as generic recovery failure and :3224 leaves recovery armed. Return a specific refusal and clear auto-resume and snooze intent in the settle event. |
| 334 | ed0178487d7 | adapt | C2 | Requires `02e29ce8fa5`. UsageService.ts:558–566 captures rates before the file scan, so an unlisted model waits on TTL. Resolve aliases and overrides consistently with aggregation and request a rate-limited refresh, bounding deduplication for arbitrary model names. |
| 452 | fed0f743b9b | take | C2 | The OpenCode 2-only session_message predicate at usage.ts:292 counts assistant rows exclusively. Include compaction rows with the same usage, model and cost extraction; reconcile only the hunk context. |
| 481 | 47e24f6cc2f | adapt | **C4** | Requires `9ced4f1f45b`. Grok usage.ts:139 and :177 key by reused prompt IDs and GOAT's cache is still v15 at usageScanCache.ts:13. Key turns with their recorded time and migrate/reparse cached rows without inflating merged or deleted transcript totals. |
| 496 | 5b818b3e696 | take | C1 | resolveModelAliases at usageAggregation.ts:79 walks shared chains again for each starting model. Memoize the walk and preserve cycle exclusion and terminal aliases, without introducing non-null assertions. |
| 543 | fd985e09854 | take | C1 | The utilization number schema at cliproxyApi.ts:67 rejects an entire account if one window is unmeasured. Accept a null window value and retain the account's usable windows. |
| 606 | d430dff14f5 | adapt | C2 | usageServiceSupport.ts:180 omits the default source when the canonical instance has moved home. Include the default history source without double counting configured homes or shared transcripts. |
| 644 | 0f0c1ca1969 | adapt | C3 | usageAggregation.ts:302 removes the original rate alias on remap without resolving the target provider's canonical pricing key. Wire per-reader target resolution through GOAT's Pi/OMO profiles and Cursor account readers. |
| 783 | 16854a766c3 | take | C2 | UsageProviderChart.tsx:375 exposes a single image label and UsageShareBar.tsx:34 flattens values into a label. Take the semantic table and list together with 51eb2d5437b's Firefox caption fix. |
| 784 | b5d9c71e1c3 | take | C2 | The existing metric and model stats use adjacent spans (UsagePage.tsx:1240 and UsageModelDialog.tsx:94). The definition-list markup fits those same views. |
| 857 | b9f24b627fe | take | C1 | At :93 and :170 the reader can return an empty healthy windows result for a Zen-only workspace. Report unsupported limits while preserving the validated external usage link. |
| 994 | 428d365932a | adapt | **C4** | **Contracts.** Requires `02e29ce8fa5`, `d430dff14f5`. Usage prunes at a fixed 92-day cutoff (UsageService.ts:78,521,761). Keep the default, check the current readable setting at destructive prune time and apply compatible retention to account coverage without widening the visible query window. |
| 1120 | 51eb2d5437b | adapt | C1 | Requires `16854a766c3`. GOAT currently ends the chart without upstream's accessible data table (line 524). If adding the upstream accessibility behavior, put the table and caption inside a visually hidden wrapper to keep Firefox from painting the caption. |

### U52

**Claude adapter and startup (3/3)** · W08 · server-only · 1,673 estimated handwritten changed lines

- Use the extracted GOAT query runner, adapter helpers and Bedrock catalog. Preserve Monitor and explicit Stop semantics through startup and retry. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — claude-adapter, delegated-tasks, code-budgets.
- Test missing session, unanswered reply, MCP registration timeout, root failure with child alive, and old bridge payloads.
- **C4 before code** — rows #1022. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (1 source paths) — `packages/contracts/src/orchestrationV2.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K12 (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`), K1 (`packages/contracts/src/orchestrationV2.ts`), K4 (`apps/server/src/orchestration-v2/ProviderTurnStartService.ts`), K6 (`packages/contracts/src/orchestrationV2.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 953 | 3605d52842c | adapt | C3 | A failed turn goes through background cleanup (ClaudeAdapterV2.ts:5969), and ingestion only sets its root snapshot hold from the flag (RunExecutionService.ts:1490). Retain tasks owned by the same live query and keep the thread-scoped subscription available for their completions. |
| 971 | 3eeec6f3a49 | adapt | C1 | Requires `5f95653f25a`. The event handler still reaches compact handling without processing conversation_reset; reset stream usage and compaction state and publish zero through the GOAT context meter (ClaudeAdapterV2.ts:7524). |
| 1018 | 0072f66ec12 | adapt | C2 | GOAT already retries resumed registration timeouts only (ClaudeAgentSdkQueryRunner.ts:858). Try a fresh ID once after disposing the failed query; preserve GOAT Cua Driver registration and owned descendant cleanup (:661). |
| 1022 | 2904c397ad4 | adapt | **C4** | **Contracts.** The native boundary code only counts terminal later turns (ClaudeAdapterV2.ts:1070) and policy blocks busy sources. Add opt-in only for capable adapters and always use a completed boundary message when a later turn exists, including an active Claude turn. |
| 1088 | ddb14277ec9 | take | C1 | GOAT's `nextClaudeGoal` at line 863 lacks the CLI informational clear signal. Map that specific message to a cleared goal through the existing projection. |
| 1109 | 33892dcc711 | adapt | C2 | Requires `629d5083b7b`. GOAT forces the missed-run list empty after refusal (`ProviderTurnHandoffRecovery.ts:176`) and has a distinct retry-handoff representation. Recover eligible missed images separately from the summary, avoid repeating old text, and honor delivery and attachment budgets. |
| 1119 | b387e3a179d | adapt | C2 | Claude builds the prompt at adapter line 9630 without the app context supplied to Codex. Use bounded per-session delivery state, quoted untrusted user blocks, completion acknowledgments, and invalidation on compact and rewind while preserving slash commands and attachment accounting. |

### U53

**Provider host, capabilities and smaller adapters (1/2)** · W08 · mac · 810 estimated handwritten changed lines

- Use GOAT provider host/text-generation selection and preserve its attachments. Require explicit opt-in for fx profile MCP under #642. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — contracts-rpc-leaves, memory-app-layers.
- Test unsupported capability, profile opt-out, native interjection, queue fallback and selection of the configured runtime.
- **C4 before code** — rows #949. Bring the two-way compatibility and negative-case note to the coordinator.
- Refresh against the carried landing delta. Main overlapping claims — K9 (`packages/provider-acp/src/server/adapter.ts`), SF3 (`packages/provider-cursor/src/server/adapter.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 884 | 5a20d59db38 | adapt | C3 | Desktop reads only the current process value (DesktopShellEnvironment.ts:228), and GOAT has its own coalesced refresh path (ProviderRegistry.ts:447). Merge Process/Machine/User PATH and rebuild only enabled instances missing their binary, keeping GOAT's live sessions and provider environment handling. |
| 949 | b4e47a5a62e | adapt | **C4** | Enforce runtime approval boundaries at each adapter. GOAT moved Cursor's setting sources into agentOptions.ts:95; also preserve the Fx/ACP policy mapping, keep investigation settings controlled, and derive OpenCode slash dispatch from the actual message rather than combined context. |
| 992 | 0058a4abb3a | take | C1 | The PATH fallback at AntigravityInstallation.ts:267 looks for only the packaged command name. Probe agy after it while retaining explicit path priority. |
| 993 | 90a098bb4b5 | take | C1 | Grok updater inherits npm_config_user_agent at driver.ts:106, which can redirect a script install into npm. Clear it and pair with 8eb1a5eb2bf's managed-home preservation. |
| 998 | 2b2d65d1313 | adapt | C2 | Verification emits generic timeout errors (AntigravityInstallation.ts:626; CodexInstallation.ts:748), and Antigravity activation can mask them (:506). Preserve a typed verify-phase error without publishing a failed release. |
| 1012 | 8eb1a5eb2bf | adapt | C1 | Requires `90a098bb4b5`. Use the explicit real binary path to identify a recognized script installation home before running the updater. Keep GOAT's existing environment override and injection behavior at driver.ts:106. |
| 1067 | 5842231421d | adapt | C1 | Requires `2854038b61a`. GOAT uses a different SAX traversal (documentTextWorker.ts:19,43). Exclude drawing position/size and field metadata during DOCX extraction while retaining visible text boxes, field results, positional tabs and other legitimate text. |

### U54

**Composer drafts, queued edits and uploads (2/4)** · W09 · mac · 2,449 estimated handwritten changed lines

- Keep draft ownership and dispatch classification, GOAT Reply and separate approval/question paths. Preserve destination and idempotency during retry. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — composer-footer, reply-to-response, decision-routing.
- Test queued edits, expired uploads, side-chat and linked routing, and cross-device mutation confirmations under d1 #89.
- **C4 before code** — rows #270. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (1 source paths) — `packages/contracts/src/composerContext.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K2 (`apps/web/src/components/ChatView.tsx`), K6b (`apps/web/src/components/ChatView.tsx`), K8 (`apps/web/src/components/ChatView.tsx`), K7 (`apps/web/src/components/Sidebar.tsx`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 22 | 2d689687f57 | take | C3 | GOAT rejects the blank mobile query (queries.ts:436–439) and omits allowEmptyQuery on web (queries.ts:348–349). The patch applies cleanly and preserves null as the inactive trigger. |
| 36 | 2a1caac4386 | adapt | C1 | GOAT’s trigger only changes its visible text (BranchToolbarBranchSelector.tsx:818–830). Give the combobox a dynamic Branch name and suppress duplicate child text from its accessible name. |
| 73 | a4723422e7d | adapt | C2 | GOAT gives the composer wrapper a Message input region in addition to the editor label (ChatView.tsx:730–731, workspaceFocus.ts:12–17). Keep workspace shortcut order while suppressing redundant region announcements for the ordinary composer. |
| 86 | 8656cdb3a93 | adapt | C1 | GOAT truncates the response chip at 64 UTF-16 units (composerContextRecords.ts:208). Guard the split surrogate boundary while keeping GOAT’s response context behavior. |
| 89 | 5ef603df343 | decide · pending d1 | C3 | d1 recommendation — port fewer routine success toasts. Should GOAT remove routine success toasts across web and mobile, and which cross-device actions still need confirmation? GOAT presently confirms copies and other operations (MessageCopyButton.tsx:31; AuthorizedClientsSettings.tsx:195–204) and has separate GOAT-specific flows. |
| 135 | 3fe0fbb69f4 | take | C1 | The reused completed-upload branch restores in-memory state only (attachmentUploadQueue.ts:430–436). Also restore file ownership metadata when a draft returns to that exact environment. |
| 136 | fd0ffd0b0a4 | take | C1 | Merge from raw storage on mutation (promptStashStore.ts:131 currently merges hydrated state). Prefer durably finalized images over stale memory while preserving locally finalized images after a failed storage write. |
| 139 | 5e06246d24b | adapt | C2 | Keeping a recovered edit currently moves prompt and images (queuedMessageEdit.ts:78). Move content and its GOAT context records together into an empty target while retaining destination environment rules and reply links. |
| 152 | 3b18dc2935a | adapt | C2 | ChatView.tsx:2592 scans loaded rows only. Combine pages and the shell’s latest-user marker to match the server’s full-history compaction gate and preserve GOAT’s compaction policy. |
| 207 | fd6d0ea022f | adapt | C1 | `apps/web/src/components/chat/useComposerStash.ts:450` already guards asynchronous context import. Include the separate preparing-image count before creating or clearing a stash. |
| 230 | a6789484838 | take | C1 | `apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx:159` filters editable targets but can still consume digits from popup controls. Add the dialog, menu, select, and combobox guard with the browser regression. |
| 241 | f84ad6f30b6 | adapt | C2 | `apps/web/src/lib/discardComposerDraft.ts:23` clears draft state while compression still has pending tokens. Cancel both key forms so a late result cannot recreate the draft, using GOAT's browser harness. |
| 270 | cebdf399842 | adapt | **C4** | `apps/web/src/components/chat/useQueuedRunEdit.ts:260` clears the draft without releasing staged uploads or blob URLs. Release resources only after checking save, recovery, and newer edit ownership in GOAT's queue flow. |
| 305 | 154c5014a75 | take | C2 | **Contracts.** The builder merely trims the comment at composerContextRecords.ts:289 while composerContext.ts:51 already limits it to 8,000. Export the existing limit and clamp before encoding, leaving the wire schema unchanged. |
| 356 | ec01233fb65 | adapt | C3 | Web inserts after compression at useComposerAttachmentIntake.ts:317–318, and mobile drops the captured range when draft text changes (use-composer-drafts.ts:128–134). Map pending insertions and the live caret through edits, taking 6f8144b5c46's overlapping-paste ordering and retaining GOAT draft ownership and discard checks. |
| 433 | cbdf35f2f0b | take | C1 | ChatComposer.tsx:1136 counts annotation and review context only. The clean patch counts thread and environment attachments so a context-only draft can be sent. |
| 435 | 2dd810d0f60 | adapt | C3 | Use the existing GOAT side-chat dispatch; see Out-of-range prerequisites. ThreadComposer.tsx:318 and the web button use generic busy state despite local side-chat dispatch. Reuse the dispatch classification so a valid side chat shows Send while a draft that redirects an approval still follows the ordinary running-turn path; fold in caef8c3847b. |
| 457 | 62405fce573 | adapt | C2 | useComposerContextImport.ts:363 can reuse the wrong thread record by context ID, and :426 can keep a colliding ID. Resolve the target draft's thread pair by environment and thread ID, mint only on collision and preserve GOAT context kinds. |
| 489 | 2b7fc890ded | take | C1 | The route-scoped draft clear can run after navigation, while useComposerSend.ts:1269 resets the visible prompt and cursor unconditionally. Guard the visible refs with the captured route key and keep the keyed clear independent when integrating later send changes. |
| 508 | 3c8f3f2c3d8 | adapt | C2 | Recall strips context references at composerPromptHistory.ts:102. Restore referenced thread and environment records with the text across history steps, retaining GOAT's scoped drafts and context validation. |
| 514 | 6f8144b5c46 | adapt | C2 | Requires `ec01233fb65`. GOAT inserts prepared references through useComposerAttachmentIntake.ts:228 and :318. Carry paste order through GOAT's editor insertion and route ownership when compressions resolve out of order, using its browser test harness. |
| 521 | 617c6c74f67 | take | C1 | The composer chip is an ordinary draggable link at ThreadContextChip.tsx:32. Disable native drag on that anchor while keeping click and keyboard navigation. |
| 536 | ed6cb97f07d | adapt | C2 | The draft loader at composer-rich-text-doc.ts:811 turns the quote separator into an empty paragraph. Normalize only the structural separator and reveal the restored caret inside the editor without moving page focus or timeline scroll. |
| 672 | ab319a52dd5 | adapt | C2 | CommandPalette.drag.ts:25 drops the title, leaving ChatComposer.tsx:2833 dependent on a cached shell. Carry the known search title through GOAT's drag payload and retain the shell fallback for sidebar drags. |
| 1157 | 9758cf9e13d | take | C1 | Requires `a6789484838`. The question handler checks modifiers but not defaultPrevented at line 153. Respect a digit event already consumed by a focused simulator or other control before taking a choice. |

### U55

**Environment themes and appearance** · W09 · mac · 2,319 estimated handwritten changed lines

- Preserve GOAT theme IDs and settings authority. For #39/#904 enforce CSS scope, signed asset and published background ownership. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — settings-page, brand, goat-copy.
- Exercise reset, import, same-ID saved/published themes, reconnect, live preview and denied asset access.
- **C4 before code** — rows #39, #904. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (4 source paths) — `packages/contracts/src/server.ts`, `packages/contracts/src/settings.ts`, `packages/contracts/src/rpc.ts`, `packages/contracts/src/assets.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K8 (`apps/server/src/server.ts`), K12 (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`), K7b (`apps/server/src/server.ts`), K7 (`apps/server/src/ws.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 39 | 42057b82d09 | decide · pending d1 | **C4** | d1 recommendation — port scoped theme agent writes and vetted CSS. **Contracts.** Should GOAT let agents modify shared theme colors and web/desktop CSS, and should administrators be able to opt out? GOAT currently publishes theme files (environmentTheme.ts:139–163) and has a human editor (ThemeEditorPanel.tsx:401–450); upstream adds agent writes, default settings, and CSS filtering. |
| 81 | 9803d1adb53 | adapt | C3 | GOAT’s prepaint script only finds stored custom themes (index.html:226–232), and the config projection discards an empty theme list (serverConfigProjection.ts:139). Cache published definitions for prepaint and distinguish unreceived from empty while preserving current theme precedence and storage keys. |
| 146 | 000d82dc67b | adapt | C1 | GOAT Settings remains a page whose Escape navigates back (010_fork_delta.md:281). Let Escape exit inspection or close the floating editor first, preserving Escape inside its portaled controls; upstream test follow-up 76748e942bc assumes a modal. |
| 200 | 1535f3f32e7 | adapt | C2 | `apps/desktop/src/window/DesktopWindowAppearance.ts:61` infers overlay availability from platform alone, and GOAT routes appearance through DesktopWindowMaterial. Track creation-time support and gate both appearance paths while preserving material backgrounds. |
| 659 | 58f609f7cce | adapt | C1 | The local formatter at ThemeImportDialog.tsx:34 rounds just below 1 MiB to 1024 KB. Use the shared formatter without changing the actual import limit. |
| 885 | 83e3c4f60da | adapt | C1 | Requires `42057b82d09`. Keep Both builds a renamed theme from selected fields and drops the published CSS (ThemeImportDialog.tsx:329–354). Share copy logic for manual and automatic names, retain CSS and omit collection membership; check later batch-copy fixes 81049d2b922 and 077b206b33b with this port. |
| 904 | 7d32075e375 | decide · pending d1 | **C4** | d1 recommendation — port signed full-size published backgrounds. If approved, incorporate the final collision and preview identity rules in this port. **Contracts.** Requires `42057b82d09`. GOAT already reads published theme metadata (environmentTheme.ts:94) and would need a signed asset for its image. Should GOAT support full-size images for published themes on web/desktop, including agent-managed publication? |
| 958 | b75424062af | adapt | C2 | Conditional on #904; verify against the final retry/preview behavior. Requires `7d32075e375`. GOAT has no wallpaper loader until 904 lands. Include bounded retry after transient failures and online recovery using the intended published background identity, including while live preview changes the visible theme. |
| 977 | 86a028cbd4c | adapt | C3 | Requires `42057b82d09`. The adoption hook drops every empty default (useDefaultTheme.ts:23); accept a dated stock reset through GOAT's appearance mode. The GOAT theme watcher exposes current/stream only (environmentTheme.ts:200), so use existing settings authority and GOAT theme IDs. |
| 1030 | cd9c39fe3c2 | adapt | C1 | parseThemeFile starts from stock colors (themePalette.ts:1309) even when a file has both canvas and accent. Validate both as literals and seed the derived palette before applying explicit overrides. |
| 1041 | d051d9822fc | adapt | C1 | Requires `58f609f7cce`. Cancel currently runs from the dialog action (ThemeImportDialog.tsx:166). Abort the owned import when GOAT's full-page Appearance route unmounts, while preserving the current controller through a development remount and checking the TS lib only if needed. |

### U56

**Settings, device preferences and catalog preflight** · W09 · mac · 2,459 estimated handwritten changed lines

- Keep GOAT full-page Settings and agent/person authority. Under #348 present the device Browser preference correctly at project scope. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — settings-page, contracts-rpc-leaves.
- Verify return path, accessibility, environment changes and optimistic-write failure across applicable settings entry points.
- **C4 before code** — rows #796. Bring the two-way compatibility and negative-case note to the coordinator.
- Refresh against the carried landing delta. Main overlapping claims — K8 (`apps/web/src/components/ChatMarkdown.tsx`), K12 (`apps/mobile/src/features/threads/ThreadFeed.tsx`), K7 (`apps/web/src/components/ChatMarkdown.tsx`), M3b (`apps/mobile/src/features/threads/ThreadFeed.tsx`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 20 | ab9e6a2792c | adapt | C1 | GOAT’s two close helpers push a new navigation entry (mainAppLocation.ts:65–72), even though Settings is a full page. Adapt history-aware return for close, Escape and sidebar navigation, accounting for 2579c3c4dd2’s later Usage history fix. |
| 38 | cbf0f0a83f2 | adapt | C1 | GOAT renders separate App and Runtimes tabs with list rows (UpdateEverythingDialog.tsx:210–219,269–280). Give screen-reader users equivalent machine, update and state semantics within that layout. |
| 77 | 62ba72fa154 | adapt | C2 | GOAT refreshes providers when dismissing the terminal (WelcomeWizard.tsx:889–895). Trigger the relevant instance recheck when the install command finishes in GOAT’s wizard, preserving the terminal scope and lifecycle checks. |
| 79 | 2dd6cddbc3f | take | C1 | GOAT’s mention query allows only ASCII (pullRequestComposerTrigger.ts:21) although it matches display names. The patch checks cleanly and allows Unicode letters, numbers and noninitial combining marks. |
| 85 | 7847ec93866 | adapt | C2 | GOAT precomputes whole override entries before sending concurrently (useScopedSettings.ts:52–62,106–126). Serialize and replan per environment from authoritative state, accounting for delayed echoes and ee4ef06469c’s later optimistic update. |
| 134 | 947c0568948 | adapt | C1 | The fallback measures after the browser can shrink the submenu (contextMenuFallback.ts:390). Measure intrinsic width and open toward the side with room using GOAT menu dimensions. |
| 148 | b4c1bd106d9 | adapt | C3 | Settings recreates an empty-option selection even for the current model (ProjectDefaultsSettings.tsx:206). Retain traits only for the same instance and model, including mixed and fallback selections. |
| 262 | 5fe2f7e4567 | adapt | C2 | `apps/web/src/components/settings/DiagnosticsSettings.tsx:55` chooses units before rounding. Move the formatter out of the budgeted component and switch to seconds when rounded milliseconds reach 1000. |
| 275 | e3305931412 | adapt | C1 | `packages/shared/src/markdownPipeline.ts:482` only splits CJK punctuation from an ASCII-prefix bare URL. Extend the existing rule to the named Arabic punctuation and preserve source positions without splitting explicit links. |
| 299 | 0487654fc8f | adapt | C2 | The diagnostics header and resource table have separate formatters (DiagnosticsSettings.tsx:414 and ResourceTelemetryDiagnostics.tsx:74). Share a formatter that promotes the rounded unit and retain the resource table's ms-to-s conversion. |
| 303 | ee4ef06469c | adapt | C3 | Requires `7847ec93866`. GOAT resolves scope from the raw environment config (SettingsScopeContext.tsx:86–96) and persists each server write separately (useScopedSettings.ts:58–78). Overlay pending patches per environment and settle only the matching save on failure or config echo, retaining permission checks and GOAT settings. |
| 348 | 675fb1d9a71 | decide · pending d1 | C2 | d1 recommendation — port Browser device preferences in project Settings. GOAT currently lets local browser preferences ignore the scope (project-settings.md:8–11), and browser viewport is a regular setting row (IntegrationsSettings.tsx:271–272). Should Browser preferences and default-profile selection become read-only at project and checkout scope while profile management stays available? |
| 353 | 619c652d255 | adapt | C2 | ProviderModelsSection.tsx:200–228 clears the add draft immediately, and ProviderSettingsPanel.tsx:913 discards the persistence result. Keep the draft until confirmed, protect against a late result after cancel, and combine with 756545a917f so successive edits compose. |
| 355 | 81f23426d46 | take | C1 | The Projects list uses all groups and replaces the search at SettingsScopeNotice.tsx:81–94. Reuse the existing settingsScopeAxis.ts:75–101 helpers that filter by environment and preserve it on project selection. |
| 389 | b5e4342a90c | take | C2 | The renderer drops dir at ChatMarkdown.tsx:1422 and MarkdownDetails.tsx:45 physically aligns left. The clean patch passes direction through and uses logical alignment and a mirrored closed chevron. |
| 411 | 756545a917f | adapt | C2 | Requires `619c652d255`. ProviderInstanceCard.tsx:779–782 and :824–827 build full-list writes from stream state, and ProviderModelsSection.tsx:243 closes the draft before acknowledgment. Reconcile pending saves with echoes and retain newer or failed edits in the GOAT settings UI. |
| 421 | fa647599e0a | adapt | C3 | GOAT extracted both card renderers and neither uses direction at CodexArtifactTemplateCard.tsx:18–22 or AssistantMarkdownBlocks.tsx:59–83. Apply shared first-strong direction on the existing cards. |
| 424 | 20ee041354e | adapt | C1 | The virtualized list's wrapper at FontFamilyPicker.tsx:192 cannot shrink through all levels in a short popup. Let the GOAT popup allocate its available height to the scrolling list. |
| 655 | 189290cbf0b | adapt | C2 | FontFamilyPicker.tsx:148 treats synthetic Apple labels as installed family names. Resolve those samples with GOAT's existing font-stack helper so the displayed preview matches selection. |
| 658 | 0fbe8a2e445 | adapt | C1 | SettingsSection at settingsLayout.tsx:232–242 keeps the action and long title on a single flex line and reserves space when actionless. Make both legible at narrow widths with GOAT's spacing and responsive layout. |
| 663 | b8bffc8b350 | adapt | C1 | The status copy at ResourceTelemetryDiagnostics.tsx:998 reports a zero polling interval. Represent the existing idle/on-demand state distinctly from a missing snapshot and active polling. |
| 796 | 2579c3c4dd2 | adapt | **C4** | Adapt only router history-state preservation during pairing cleanup as identified by recheck. GOAT already closes Usage through router.navigate at mainAppLocation.ts:65–71, so it never traverses back into the previous document. Pairing cleanup's history-state preservation is ancillary to upstream's history-based close. [recheck: adapt, see /tmp/chase1118/triage-recheck.md] |
| 911 | 8ca0c88cfd1 | take | C1 | The anchored viewport still exposes its default landmark (toast.tsx:729). Remove its redundant role and label while keeping the main Notifications landmark and anchored toast announcements. |
| 965 | d775f6bff14 | adapt | C3 | Requires `7ced2ca6ccc`. Web caches default-zone formatters (timestampFormat.ts:71–80), and mobile constructs them at module load (messageTimestamp.ts:1–5). Resolve current zone on the platform-appropriate path while preserving explicit zone overrides and Android clock preferences. |
| 973 | 411f0f7d87e | adapt | C1 | The 8% idle and 12% hover thumb tokens at index.css:169–170 need usable contrast on GOAT's dark palettes; derive the values from those palettes. |
| 1015 | d27002bf993 | adapt | C3 | The default merge at keybindings.ts:532 matches the same context only. Add opt-out and reset using GOAT's contextual/default bindings, ensuring a disabled sibling key does not consume the key or disable other contexts. |

### U57

**Mobile outbox delivery fibers** · W09 · mac · 2,835 estimated handwritten changed lines

- Stage scoped worker admission, upload ownership and outbox integration inside #906. Keep the registry and replay IDs stable across its handoff. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — mobile-sheet-header, composer-footer, code-budgets.
- Test independent threads, cancellation ownership, concurrent retries and one accepted delivery/upload.
- Refresh against the carried landing delta. Main overlapping claims — K7 (`apps/mobile/src/state/threadOutboxDelivery.ts`). The summary lists all carried waits.
- Oversized single row. Stage the steps in this lane under the one row owner; keep feature exposure gated through the combined checks.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 906 | 07e8bfa70d6 | adapt | C3 | Requires `4860a730695`, `cfb1f125412`, `134ab31276d`. GOAT schedules against a shared dispatching ID and retry map (threadOutboxDelivery.ts:83–105). Move to one scoped fiber per thread while preserving FIFO per thread, parallel progress across threads, interrupted-send cleanup and launch-receipt recovery. |

### U58

**Git refresh, refs and source-control actions (3/3)** · W09 · mac · 1,625 estimated handwritten changed lines

- Preserve GOAT Git providers, raw-cwd and selected environment scoping, separate full/light status and fetch/autopull fences. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — pr-event-feeds, contracts-rpc-leaves.
- Check old peer negotiation, mixed subscriber demand, disappearing refs, restricted fetch mappings and external clones.
- **C4 before code** — rows #616, #757, #925. Bring the two-way compatibility and negative-case note to the coordinator.
- Refresh against the carried landing delta. Main overlapping claims — K3 (`apps/server/src/vcs/VcsStatusBroadcaster.ts`), K4 (`apps/server/src/vcs/GitVcsDriverCore.ts`), K2 (`packages/source-control-github/src/server/GitHubPullRequestApi.test.ts`), SF3 (`apps/server/src/git/GitManager.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 616 | 9b380396316 | take | **C4** | ForgejoCli.ts:183–205 collects matching login roots without preferring the deepest mount. Rank HTTP matches by mount depth and retain ambiguity checks for ties and SSH. |
| 676 | a5d21a3ce46 | adapt | C3 | Requires `a3477a5dd93`, `6e2747921c5`, `a575d45286f`, `4c473155380`. GitManager.ts:992 always runs the branch totals query. Scope demand to full subscribers and direct readers, keep complete/light cache values distinct and upgrade mid-read when a full consumer joins. |
| 690 | ab2420ffc0f | adapt | C2 | GitVcsDriverCore.ts:2338 resets away unselected conflict stages. Preserve those stages using literal selected pathspecs; check GOAT's staging hooks and temporary-index reconciliation. |
| 696 | 52c62087b35 | adapt | C2 | GitManager.ts:1788 can fail after commit/push succeeded. Separate optional status enrichment from the completed action and suppress suggestions that require a final status when it is unavailable. |
| 757 | 70abb6c002c | adapt | **C4** | AzureDevOpsCli.ts:543 and AzureDevOpsPullRequestCli.ts:689 forward PR free text to a CLI that interprets leading @ as a file reference. Pass leading-@ text literally through stdin or joined file arguments and verify create/update with both fields and WSL. |
| 761 | a16796b956a | take | C2 | Requires `c62c7649f74`. git.ts:27 performs its own Unicode normalization and path.ts's folding lacks sharp s. Share the existing folding helper and retain ß/ẞ as ss/SS in generated names. |
| 831 | 94c0784d7c1 | adapt | C1 | Branch totals rerun numstat at :3115 even after a timeout. Bound a backoff keyed by workspace, HEAD and merge base while preserving GOAT's multi-host base resolution. |
| 845 | 57ec00ddd64 | take | C1 | Current discovery is refreshed from user actions around :550. Reuse the focus/visibility refresh hook without adding periodic probes of GOAT's host CLIs. |
| 915 | 70a7cfe5a20 | take | C1 | The iteration decoder drops entries missing item.path (azureDevOpsPullRequestJson.ts:457–458). Recover deleted paths from the source fields, leave their revision empty for Viewed, and keep rename behavior. |
| 925 | 80b9620454f | adapt | **C4** | Requires `410177c7d6d`. Feed MR description through stdin because confined glab cannot read the server's temp file passed at GitLabCli.ts:651, while preserving project selection and error mapping. Check the FileSystem layer and direct platform-node dependency used by upstream. |
| 944 | 6b134a7add3 | take | C1 | GOAT requests 100 files per page (GitHubPullRequestApi.ts:343,1071). Read 30 and retain pagination so GitHub is less likely to omit file patches. |
| 961 | e9a1e8699e0 | adapt | C1 | The existing fallback handles empty search results and only uses repository listing when it serves the request (GitHubPullRequestApi.ts:1723–1726). Extend that branch to eligible GitHub 5xx responses while retaining error and query semantics for other cases. |
| 988 | f0572cf1b96 | take | C3 | Current clone conversion keeps the raw remote host (cloneUrl.ts:61,65) and the classifier can label Atlassian SSH hosts self-hosted (definition.ts:118). Normalize the Bitbucket Cloud API/web origin and canonical SSH clone host while preserving self-hosted behavior. |
| 1013 | d848e4b2b20 | adapt | C3 | Requires `348009de22c`. Totals selection in GitActionsControl.logic.ts:538–552 carries no category counts. Share the existing classifier and expose the breakdown on the GOAT Changes action when per-file stats match the chosen totals. |
| 1046 | f1cd57bbf95 | take | C1 | The co-author regex at mergeMessage.ts:37 does unnecessary work on long trailers. Use bounded delimiter parsing and preserve specific Copilot/agent matches and human co-authors; the patch applies. |
| 1065 | 758291c1766 | take | C1 | The rev-parse parser can strip a real carriage return (:228) or truncate a bare repository path containing newlines (:272). Remove only the trailing record LF and retain the rest of the path; adapt adjacent test imports as needed. |
| 1091 | c516061259d | take | C1 | The tea API path at line 719 uses the default output cap. Increase it only for API responses and surface an explicit truncation error with the bounded 16 MiB limit. |
| 1112 | 439c96550c6 | take | C1 | The review diff still requests --minimal at line 3198. Rely on regular Git diff and adjust the fixture's expected patch algorithm without changing whitespace options or limits. |
| 1152 | 7c67d196c57 | adapt | C1 | Review uses an independent root lookup or uncached layout discovery at line 3169 despite the cache at line 1376. Reuse stable layout, read branch state fresh when needed, and preserve missing-directory, removed/detached and bare-repo results. |

### U59

**Turn launch, resume and handoff recovery (2/2)** · W09 · server-only · 2,439 estimated handwritten changed lines

- Preserve checkpoint-before-provider-write, GOAT launch provenance and exact command replay. Capability-gate native Resume if approved. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — orchestrator-goat-modules, delegated-tasks, launch-watch.
- Test older receipts, refused native resume, stop/restart distinctions, provider handoff and unaccepted image replay.
- **C4 before code** — rows #464, #668. Bring the two-way compatibility and negative-case note to the coordinator.
- Refresh against the carried landing delta. Main overlapping claims — K6 (`apps/server/src/orchestration-v2/Orchestrator.ts`), K1 (`apps/server/src/orchestration-v2/Orchestrator.ts`), K6b (`apps/server/src/orchestration-v2/Orchestrator.ts`), N10 (`docs/user/updating.md`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 410 | c76ba848ab5 | adapt | C3 | GOAT settles some failures through ProviderTurnStartService.ts:239 but EffectWorker.ts:888 can exhaust a start/restart before a guarded settlement. Preserve attempt identity and race-safe settlement, distinguish irreparable missing state, and keep ownership through recoverable persistence errors. |
| 464 | a68c367e4ff | adapt | **C4** | RestartContinuation.ts:293–296 has a time-window guard. Persist the crash count in continuation intent, retain its supporting record across pruning, and preserve planned-update reset and GOAT's live-turn adoption path. |
| 668 | 34204a39e87 | adapt | **C4** | Requires `a68c367e4ff`. GOAT has separate restart-candidate and recovery paths at ProjectionStore.ts:3769 and ProviderRuntimeRecoveryService.ts:152. Check persisted provider acceptance, keep unsent human prompts held, and use bounded same-run unattended resend with durable outbox ordering and stop fences. |
| 1093 | a99faf5a629 | adapt | C3 | Requires `ccae953c46c`. Capability is off at provider line 210 and child provenance reads the mutable provider thread ref at query line 81. Enable fresh-session rollback only with kept-history replay and source native child history from the original run attempt. |
| 1095 | 0597532f16d | adapt | C2 | GOAT forces explicit restart into a stop-and-queue flow at `Orchestrator.ts:5565`. Give provider-changing steers a wait-for-completion branch for non-restartable providers, preserving Stop precedence and delegated wakes. |

### U60

**Terminal attach, input and platform paths (2/3)** · W10 · mac · 2,483 estimated handwritten changed lines

- Start from T3 errors and GOAT terminalLeaseOrder. Retain attach generations, resize-before-input, one PTY reply owner and older-peer semantics. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — contracts-rpc-leaves, ssh-runtime.
- Run Manager and terminal client checks. Exercise real Windows/WSL for encodings, shell paths, UNC and delayed PTY events.
- **C4 before code** — rows #738, #749, #752, #774. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (3 source paths) — `packages/contracts/src/server.ts`, `packages/contracts/src/terminal.ts`, `packages/contracts/src/editor.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K7 (`apps/server/src/ws.ts`), K7b (`apps/server/src/ws.ts`), K8 (`apps/server/src/process/externalLauncher.test.ts`), T3 (`apps/mobile/src/features/terminal/ThreadTerminalRouteScreen.tsx`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 715 | 0720280c45d | adapt | C1 | Exercise the quoted/space-containing shell cases directly on GOAT’s split resolver. GOAT split shell resolution out of Manager, and shellCandidates.ts:25 still splits on the first space. Keep quoted values and prefer the longest existing unquoted POSIX path while preserving GOAT's Windows and launch-environment handling. |
| 716 | efddcfeb20c | take | C2 | OutputProtocol.ts:175 and :216 wake and drain on every callback. Batch nearby output in the bounded 2 ms window, with immediate lifecycle and buffer-pressure flushes and existing UTF-8 limits. |
| 727 | 2cb2fa13855 | adapt | C1 | terminal-links.ts:45 requires a slash for relative matches. Recognize bare compiler filenames with an explicit location, preserve URL/prose exclusions, and port alongside 304cf149c8c. |
| 738 | e101cae1b9e | adapt | **C4** | **Contracts.** Manager.ts:1881 records error status but attach snapshots at :436 omit the message, and terminalSession.ts:120 resets the error. Carry an optional startup error in snapshots and render it correctly on reconnect, reset and mobile. |
| 747 | 2b83dd0969f | adapt | C2 | Manager.ts:2150-2170 waits only for cleanup of current sessions. Capture and join already-closed terminal kill fibers before the worker scope interrupts their escalation. |
| 749 | 8dba23e4206 | adapt | **C4** | **Contracts.** Requires `43a71d9b1ac`. Web and mobile share a bounded TerminalWriteInput. Queue surrogate-safe writes without losing bracketed-paste ordering or touching a stale attachment, and reconcile the later byte-preserving 45dbb4436c0. |
| 750 | f0a33213547 | adapt | C2 | deriveSubprocessInspectResult at Manager.ts:568 uses child-process shape and can mistake an exec replacement or foreground shell for an idle prompt. Use the terminal root executable and foreground process group where available, preserving GOAT's safe stop defaults. |
| 752 | 46f3ab39f22 | adapt | **C4** | **Contracts.** Requires `2cb2fa13855`. fileLinks.ts:20 treats every non-localhost authority as a UNC share. Match only the selected terminal environment's server hostname, keep the wire field optional, and preserve other authorities and explicit file-URI positions with 304cf149c8c. |
| 755 | d8c7855a884 | adapt | C2 | Requires `3fe1dd922de`. core.ts:628 feeds fractional display geometry into a whole-pixel mouse encoder. Map cell coordinates onto its grid and preserve true pixels for DEC 1016; reuse the mode reader added by 3fe1dd922de. |
| 765 | 7379f1969b0 | adapt | C1 | keyCodes.ts:195 prefers the keypad's physical digit even when the logical key is navigation with NumLock off. Encode known keypad navigation variants and preserve printable digits and ordinary navigation. |
| 769 | be8c4c6d9fd | adapt | C2 | Requires `3908c4eab3a`. core.ts:811 relies on Ghostty row dirtiness, which OSC 10/11 color changes do not set, and surface.ts:1797 keeps viewport padding unchanged. Refresh cached default colors and repaint the surface, alongside GOAT's OSC handling. |
| 774 | 304cf149c8c | adapt | **C4** | **Contracts.** Requires `b37c959669c`, `2cb2fa13855`, `46f3ab39f22`. terminal-links.ts:168 turns a literal URI path into diagnostic text, and externalLauncher.ts:144 parses it again. Preserve the exact decoded path separately from an explicit position, with legacy parsing for old callers and correct remote/editor handling. |
| 776 | 449deb635ec | adapt | C1 | Requires `3fe1dd922de`. GOAT's Ghostty key encoder returns the default modified-F3 bytes unconditionally near core.ts:573. Match the advertised terminfo sequence only in application keypad mode without Kitty keyboard flags, leaving raw and Kitty readers intact. |
| 780 | a3708b51802 | adapt | C3 | Web redraws concealed text at renderer.ts:395 and can draw its decorations at :362. Android guards normal rendering at TerminalCanvasView.kt:230, but its cursor redraw at :334 still needs the guard. |
| 803 | dd7255d3383 | take | C2 | Windows scans decode UTF-8 on the Node side but launch PowerShell without forcing its output encoding (Manager.ts:665 and deviceToolMaintenance.ts:70). Set UTF-8 in each existing command and preserve GOAT's scan options. |
| 812 | b9bc03869e0 | adapt | C3 | Requires `a3708b51802`. The block cursor paints over earlier decorations at renderer.ts:394. Redraw decoration geometry in cursor colors and keep concealed cells hidden on both renderers. |

### U61

**Agent tools, transport and scoped reads (1/2)** · W10 · server-only · 1,899 estimated handwritten changed lines

- Preserve goat_* names, MCP registration context, person settings authority and delegated/remote ancestry in GOAT-owned services. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — mcp-auth-middleware, mcp-names, mcp-registration-context, decision-routing, remote-reports.
- Test advertised schema and validation together, denied linked scope, task status fallback and bounded projection reads.
- **C4 before code** — rows #83, #137, #194, #492, #695, #745, #756, #1142. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (1 source paths) — `packages/contracts/src/orchestratorMcp.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K6 (`apps/server/src/orchestration-v2/Orchestrator.ts`), K1 (`apps/server/src/orchestration-v2/Orchestrator.ts`), K12 (`apps/server/src/orchestration-v2/ProjectionStore.ts`), K7 (`apps/server/src/orchestration-v2/Orchestrator.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 18 | b5379160993 | adapt | C3 | GOAT filters the listing around OrchestratorMcpService.ts:3291–3324 but gets full shells from ThreadManagementService.ts:296. Select and page lightweight entries first, then build page metadata with GOAT’s Bot, snooze, and linked-task inclusion rules; coordinate 35e65e6446c and 980f5d41286. |
| 83 | ea957b5cab3 | adapt | **C4** | GOAT’s current tool returns the relative URL (attachment/handlers.ts:140), and GOAT moved MCP auth to McpAuthMiddleware.ts. Add the optional absolute upload URL for HTTP clients from a trusted ingress origin and retain the relative form for in-process callers. |
| 88 | e1f5b682813 | adapt | C2 | GOAT already uses userFacingDispatchErrorMessage for thread send (OrchestratorMcpService.ts:3611), but delegated completion and thread creation still use generic errors (:2920,3183–3247). Apply the existing safe formatter to the remaining dispatch sites and review GOAT-specific operations. |
| 137 | 2f2730c1134 | adapt | **C4** | **Contracts.** The local path promotes nonqueued work to running (OrchestratorMcpService.ts:1362). Expose starting for real provider startup and map remote status through GOAT's SSH/host delegation, with an older-host fallback. |
| 163 | 43ba62b9fcf | adapt | C2 | The list checks pending background work while the read detail returns just active/latest status (threadListView.ts:214,268). Reuse one status derivation and preserve failed and input/approval state. |
| 194 | 121f0cf014d | adapt | **C4** | **Contracts.** GOAT thread-list rejects values above 100 while thread-read already decodes with a clamp (orchestratorMcp.ts:541,687). Share the decoder so oversized positive requests page normally and zero remains invalid. |
| 254 | 629242b8d3a | adapt | C1 | The default title at `apps/server/src/mcp/OrchestratorMcpService.ts:1857` slices UTF-16 at 80 units. Remove a trailing high surrogate after truncation and preserve an explicit title. |
| 492 | f7b0b3c4d73 | adapt | **C4** | **Contracts.** Requires `121f0cf014d`. Reuse the existing bounded decoder in orchestratorMcp.ts:687 for the three GOAT tools, with their current 50/100/100 ceilings. Check the public MCP schemas and keep the GOAT registration names. |
| 695 | 62d33c126a0 | adapt | **C4** | **Contracts.** GOAT extracts the list and detail projections to threadListView.ts:217 and :252. Return the shell-derived pinned boolean and keep its schema optional for older linked peers; threadStatus.ts:346 already serves a separate status view. |
| 719 | f36c8351d82 | adapt | C3 | threadSort.ts:228 owns fractional keys in the client while MCP pins dispatch separately. Use a shared allocator and the canonical GOAT command path; coordinate with the active-shell index changes in 980f5d41286. |
| 745 | f28c74a7d04 | adapt | **C4** | McpInvocationContext.ts:178 already gives an outside client an execution-time refusal for caller-bound operations. Apply the same rule before discovery through GOAT's registry, preserving independent execution authorization and outside management tools. |
| 756 | def4cd48848 | adapt | **C4** | handlers.ts:129 reports lastRunStatus and tools.ts:238 omits the existing lastRunError. Expose the failure reason through GOAT's schedule.run_now registry tool while preserving scheduled-task access controls. |
| 1000 | c71f98cadf6 | adapt | C3 | Requires `4f829644f66`. The GOAT read path still fetches the runs record set (OrchestratorMcpService.ts:910) and counts the array (threadListView.ts:289). Fetch a bounded newest-run slice and an independent full count, preserving authorization, active runs, linked visibility and shell data. |
| 1054 | 6ef2c05410b | adapt | C3 | The GOAT attachment path collapses several dispatch refusals to unavailable (handlers.ts:226). Reuse safe classified errors for readable targets and keep unauthorized or missing targets indistinguishable. |
| 1142 | 5b6f7c81ce5 | adapt | **C4** | **Contracts.** The delegate input at line 215 uses GOAT's richer OrchestratorMcpDelegateTarget. Decode JSON text with that same shape and retain canonical object encoding, tool visibility, and malformed or forbidden-target rejection. |

### U62

**Mobile outbox and attachment delivery (3/3)** · W10 · mac · 1,945 estimated handwritten changed lines

- Preserve workspace/revision and command-ID replay, including a lost first response. Track #905 through #906 and #907 to one upload registry. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — mobile-sheet-header, composer-footer, code-budgets.
- Test pending-to-sent attachment continuity, project stamping and deduplication across restart and reconnect.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 907 | 1da6b14e922 | adapt | C3 | Requires `cfb1f125412`, `07e8bfa70d6`. GOAT has a web promise queue (attachmentUploadQueue.ts:52) and a separate mobile queue (composerAttachmentUploadQueue.ts:111). Share in-flight work by environment and attachment, preserving persisted-ID verification, bounded concurrency, retry and cancellation on route changes. |

### U63

**Web shell, thread navigation and search (2/2)** · W10 · mac · 1,004 estimated handwritten changed lines

- Keep full-page Settings, embedded side chat, scoped thread IDs, offline/link behavior and promotion rules. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — settings-page, thread-link-lookup, legacy-sidebar-shortcuts, link-thread-maximize.
- Exercise deep links, focus and back, stale palette results, rollback visibility and indexed/unindexed search.
- Refresh against the carried landing delta. Main overlapping claims — K7 (`apps/web/src/components/Sidebar.tsx`), K3 (`apps/web/src/components/Sidebar.logic.ts`), K8 (`apps/web/src/components/CommandPalette.tsx`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 842 | 45dedf29558 | adapt | C3 | Requires `b732621b519`. Sidebar.tsx:938 resolves ancestors in the current environment, while mobile uses the open thread key directly at HomeScreen.tsx:213. Pick the nearest listed ancestor using GOAT's task promotion and scoped cross-environment rules. |
| 866 | 56f41466f55 | adapt | C2 | Sidebar.tsx:969 treats a draft promoted in place like a route transition. Suppress only automatic scroll on in-place promotion and retain real navigation, filter widening and GOAT's legacy sidebar behavior. |
| 897 | 1d1489d0b8e | adapt | C2 | Requires `a760a3a9657`. The fallback already focuses the first action for keyboard input (contextMenuFallback.ts:448), but sidebar handlers drop the input source and synthesize a MouseEvent (sidebarTree.ts:159). Thread source through current and legacy sidebar routes, including draft, group and multiselect. |
| 962 | e514c36f3ce | adapt | C1 | GOAT numbers project rows before filtering (CommandPalette.tsx:894–898). Derive jump numbers from visible filtered rows and keep the root suggestions and key handler in sync. |
| 1125 | 009966d073a | adapt | C1 | GOAT publishes the full set of ranges to painting at line 162. Keep the query and active range intact, bound DOM geometry and highlighting to near-viewport runs, and preserve table order, hidden blocks and scroll/resize behavior. |
| 1148 | 70e4319da82 | adapt | C1 | The measurement starts empty on every remount at line 38. Retain a bounded last-known height per render in its environment, and let remeasurement take over when width or content invalidates the cached value. |

### U64

**Workspace file lookup and bounded indexes** · W10 · mac · 1,116 estimated handwritten changed lines

- Preserve GOAT’s FFF patch and bounded warmup. #829 records K4’s existing port and #1122 follows it. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — code-budgets, cli-home.
- Exercise fallback and native search, Git/non-Git roots, symlink aliases, ignore overrides and a failed watcher.
- **C4 before code** — rows #829. Bring the two-way compatibility and negative-case note to the coordinator.
- Refresh against the carried landing delta. Main overlapping claims — K4 (`apps/server/src/workspace/WorkspaceSearchIndex.ts`), SF2 (`apps/server/src/workspace/WorkspaceSearchIndex.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 150 | e4688f7cb9f | take | C1 | The worktree scan uses newline-separated porcelain (WorkspaceEntries.ts:314). Read NUL-delimited Git worktree records with the older Git fallback and retain nested/prunable filtering. |
| 269 | 081a5d92bf1 | take | C3 | `packages/client-runtime/src/state/filesystem.ts:81` compares raw names, which misses canonically equivalent macOS paths. Prefer exact raw matches, allow a unique NFC-equivalent selection, and retain the actual filesystem spelling. |
| 386 | 752bdaeb708 | adapt | C1 | Requires `081a5d92bf1`. GOAT already has raw and NFC prefix comparison at filesystem.ts:78–82 and the ranking helper in packages/shared/src/searchRanking.ts:88. Add ranked substring/subsequence matches while keeping hidden-folder rules, Unicode handling, and directory order for an empty query. |
| 737 | 32c069eed1d | adapt | C3 | WorkspaceSearchIndex.ts:455 destroys a content finder on first warmup timeout. Combine the finder-lifetime fix with 7e69e880b63, which replaces the server-side warmup/error loop with a bounded Git fallback. |
| 773 | 7e69e880b63 | adapt | C3 | Requires `32c069eed1d`. WorkspaceSearchIndex.ts:455 fails the first slow content scan. Fold in the 7e69e880b63 fallback and 54ad956ff22's later ignore-rule correction so warmup and warm results agree. |
| 829 | 0813f4978e7 | adapt | **C4** | Carried K4 port 0fcf93d99f0. Verify the split watcher fix on the receiving head before #1122; reopen here if the carried port is deferred. The GOAT port 0fcf93d99f0 is on the K4 branch outside both compared refs. Integrate that port, whose split workspaceSymlinkScan.ts:334 handles a synchronous throw from watchAsync. |
| 996 | 55c134a346d | take | C1 | Requires `081a5d92bf1`, `752bdaeb708`. Tab currently computes a common prefix across unrelated fuzzy results (filesystem.ts:95,112). Use real NFC-aware prefix matches first and retain the fuzzy browse list. |
| 1122 | 54ad956ff22 | adapt | C2 | Requires `0813f4978e7`. GOAT's index loads a Git-only exclusion set at lines 443 and 565. Honor nearer explicit .ignore inclusions across files and symlink aliases while preserving GOAT's FFF patch, index bounds and refresh behavior. |

### U65

**Mobile thread feed, worktree and status (2/2)** · W10 · mac · 1,396 estimated handwritten changed lines

- Preserve GOAT feed width, user jump/follow and pending message identity. Coordinate M3b and K12 layout paths. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — mobile-sheet-header, composer-footer, code-budgets.
- Test first layout, switching, visible setup/background work, short and long histories, and both native surfaces.
- Refresh against the carried landing delta. Main overlapping claims — K12 (`apps/mobile/src/features/threads/ThreadFeed.tsx`), M3b (`apps/mobile/src/features/threads/ThreadFeed.tsx`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 908 | 8bbe7fdd1a2 | adapt | C3 | Requires `4860a730695`, `2d80cb6bc75`, `12c495af498`, `d738edf401e`. Move transient status into stable slots so the composer does not shift, retaining GOAT's mobile state presentation and child controls (ThreadDetailScreen.tsx:169–172). Fold the final background/status-line behavior from 747ed9c5b1d into this port; omit its Connect-specific copy. |
| 926 | 747ed9c5b1d | adapt | C3 | Requires `8bbe7fdd1a2`. GOAT still treats background work as a floating status (floating-working-status.ts:15). Build on the stable composer-status placement in 908 and put background work at the feed end with its detail/stop action, using GOAT spacing. |
| 932 | 58e5ba58eca | adapt | C1 | User-body Markdown sets its link color equal to body text (ThreadFeed.tsx:774). Make links discernible with GOAT's existing contrast helper against the user bubble. |
| 934 | e8e7fb7e9a6 | adapt | C3 | Requires `8bbe7fdd1a2`, `93f8563a95e`. GOAT still renders WorktreeWorkingHeader (ThreadFeed.tsx:3116) and its anchor helper clears the existing anchor on follow-up (thread-feed-live-follow.ts:60–66). After the live feed row lands, remove the duplicate setup row and keep the original anchor. |
| 939 | 82afb28794b | adapt | C2 | Requires `e8e7fb7e9a6`, `8bbe7fdd1a2`. The active setup card is mounted inline (ThreadFeed.tsx:3114). Carry setup details across hand-off and expose them from the owning run's fold or summary using GOAT's mobile sheet and header behavior. |

### U66

**Run settlement, queues and persisted effects** · W11 · mac · 2,046 estimated handwritten changed lines

- Keep GOAT’s event and outbox transaction boundary, exact run/receipt ownership and recoverable unreadable effects. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — orchestrator-goat-modules, fork-in-scope, channels.
- Test crash/restart, old payloads, locked SQLite and concurrent admission using durable milestones.
- **C4 before code** — rows #291, #339, #704, #771, #810, #964. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (2 source paths) — `packages/contracts/src/orchestrationV2.ts`, `packages/contracts/src/remoteReports.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K6 (`apps/server/src/orchestration-v2/Orchestrator.ts`), K7 (`apps/server/src/orchestration-v2/Orchestrator.ts`), K1 (`apps/server/src/orchestration-v2/Orchestrator.ts`), K9 (`apps/server/src/orchestration-v2/Orchestrator.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 118 | e80468ba256 | take | C1 | Error construction currently decodes the rejected event again (ProviderEventIngestor.ts:60,821). Keep only its type with the existing cause and thread context. |
| 126 | a8777e4c7a5 | adapt | C2 | Settlement uses automaticMessageIds (Orchestrator.ts:2952), which recognizes notification and delegated-completion markers only (ProjectionMessageLookup.ts:81–89). Cover held ordinary agent and scheduled runs without admitting a held human queue, and audit the helper's archive caller. |
| 187 | 5ba3a84db45 | adapt | C3 | Retry only transient lock errors on owned outbox settlement, with interruption, and release failed RETURNING iterators. GOAT split the SQLite worker source and row batching (sqliteWriterWorkerSource.ts:176). |
| 291 | 997b304dd65 | adapt | **C4** | `apps/server/src/orchestration-v2/Orchestrator.ts:9042` replaces queued attachments without scheduling cleanup. Use a durable dropped-ID effect and recheck current references and live forks before deleting, preserving idempotent retries, stale-edit rejection, and GOAT's channel, guest, and fork ownership. |
| 339 | a4bf7922f57 | adapt | **C4** | **Contracts.** Undo currently emits a bare unsettle (threadUndo.ts:65), which resets the active anchor to now (Orchestrator.ts:3245) and loses manual order. Carry an optional restore anchor and reorder after successful unsettle, keeping omitted-anchor and older-host behavior. |
| 366 | a767d232976 | adapt | C2 | Settings detach probes busy sessions against providerContext.providerThreads at Orchestrator.ts:3094, which can omit a session retained by an earlier hand-off. Read all provider-thread records only for the busy check when live sessions exist. |
| 378 | 0b4e83d7d03 | adapt | C2 | RunFinalizationService.ts:80 awaits display refresh after durable checkpointing, holding the next turn. Supervise the display refresh outside the turn-critical path and keep it bounded, with failure logging and shutdown cleanup. |
| 379 | 4c8cb0445da | take | C1 | QueuedRunOrder.ts:20–30 sorts every automatic completion ahead of prompts, so later completions can starve older messages. Merge the two ordered queues by request time while preserving manual prompt order and GOAT's completion classification. |
| 396 | 74178f47126 | adapt | C2 | GOAT moved the later-run guard to ThreadSettlementAfterRun.ts:35. Exclude a cancelled queued run only when its message was steered into the settling run, retaining genuine subsequent work as a blocker. |
| 546 | 7a72fe301ca | adapt | C3 | GOAT has a central queue drain at Orchestrator.ts:1158 and dispatch-mode admission at :12715. Enforce queue order during the idle window while preserving explicit holds, continuation priority and failed worktree setup, including the later guard in `3209fa9534f`. |
| 580 | 85168744f7d | adapt | C3 | The stalled-run stop path builds item maps from a partial projection at Orchestrator.ts:9753. Read waiting approval and input rows for that exact run so Stop closes both requests and cards while preserving GOAT response-ledger behavior. |
| 645 | 3209fa9534f | take | C2 | Queue resume at Orchestrator.ts:12517 lacks the worktree-setup gate. Reuse the existing predicate before releasing the queue. |
| 704 | 033ae7cba09 | adapt | **C4** | EffectOutbox.ts:680-685 claims before decoding the payload and allocates its cancellation signal too soon. Atomically mark undecodable rows failed and keep scanning, preserving GOAT effect schemas and the existing failure lifecycle. |
| 732 | 570640b1605 | adapt | C2 | ProjectionStore.ts:6942 and ThreadSearch still extract archivedAt from JSON on active-thread reads. Use the indexed archived_at column after confirming GOAT-specific archive, restore and repair paths keep it consistent. |
| 771 | 6071022cb71 | adapt | **C4** | Requires `f5c2ceb4d16`, `033ae7cba09`. Orchestrator.ts:3722 commits metadata; upstream builds on native rename at next turn. Add an ordered best-effort effect for live matching sessions, keep next-turn retry, and land unreadable-effect recovery first. |
| 810 | 19b33eca4c4 | adapt | **C4** | **Contracts.** GOAT's recordRemoteTaskResult.ts:36–54 records status and summary only, while OrchestratorMcpService.ts:1443–1464 can read a local run's executed model. Project observed model from the correlated remote run through the existing report and wait paths, with optional fields for older peers. |
| 924 | e05b087a34b | adapt | C2 | The current store's strict read creates a not-found error (ProjectionStore.ts:2604–2609). Share one underlying lookup and use a nullable read at expected-miss callers, preserving GOAT's projection dependencies and real read errors. |
| 964 | 861211f2158 | adapt | **C4** | Cleanup checks the settlement override twice (ThreadSettlementService.ts:772,778) but lacks the deleted-state guard at both snapshots. Apply the guard before terminal cleanup and again after I/O before running worktree settlement actions. |

### U67

**Terminal attach, input and platform paths (3/3)** · W11 · mac · 715 estimated handwritten changed lines

- Start from T3 errors and GOAT terminalLeaseOrder. Retain attach generations, resize-before-input, one PTY reply owner and older-peer semantics. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — contracts-rpc-leaves, ssh-runtime.
- Run Manager and terminal client checks. Exercise real Windows/WSL for encodings, shell paths, UNC and delayed PTY events.
- **C4 before code** — rows #781, #787, #1020. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (3 source paths) — `packages/contracts/src/settings.ts`, `packages/contracts/src/terminal.ts`, `packages/contracts/src/providerSetup.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K7 (`apps/server/src/ws.ts`), K8 (`packages/contracts/src/settings.ts`), K3 (`apps/server/src/ws.ts`), K4 (`apps/server/src/terminal/Manager.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 781 | 45dbb4436c0 | adapt | **C4** | **Contracts.** Requires `3fe1dd922de`, `8dba23e4206`, `d8c7855a884`. Mouse bytes are decoded as text at ghostty/core.ts:991 and GOAT's locked PTY write takes a string at Manager.ts:2745. Preserve byte identity through workspace and provider-auth terminals with optional wire fields, keeping normal Unicode input on its existing path. |
| 787 | 14f295e0110 | adapt | **C4** | **Contracts.** Requires `45dbb4436c0`. WS write at ws.ts:3143 lacks the viewer identity used by resize, and GOAT serializes writes in Manager.ts:2756. Claim one attached renderer per PTY for marked replies inside that lifecycle and check the native mobile terminal path. |
| 818 | 69f8f59b518 | adapt | C1 | GOAT split shell candidate construction out of Manager.ts (shellCandidates.ts:39). Initialize UTF-8 for PowerShell only and preserve custom shell and fallback behavior. |
| 1014 | 9795f45f23f | adapt | C2 | Requires `0720280c45d`, `69f8f59b518`. Allow an explicit GOAT shell executable before Manager's platform defaults; cover native Windows Git Bash and preserve path spelling and fallback. Clear the override for project setup, whose completion semantics use a separate shell path. |
| 1020 | 48a64a8b68c | adapt | **C4** | **Contracts.** GOAT already has terminal-close confirmation on individual surfaces (useRightPanelSurfaceClose.ts:128). Add a default-on client setting with reset and check direct, grouped, shortcut, and drawer closure, preserving terminal scope and browser-agent confirmations. |

### U68

**Launcher, installation and development tooling** · W11 · mac · 2,203 estimated handwritten changed lines

- Keep GOAT launcher identity, Node pin, seed isolation and goat-ci routing. Coordinate release/service edges with N10 and harness changes with TF1. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — cli-home, ci, node-pin, repo-hygiene.
- Test exact-home install/preflight, stale runtime, rollback, changed-file scoping and platform build logic where relevant.
- **C4 before code** — rows #60, #172, #471, #479, #534, #571, #840, #991, #1053, #1096, #1121. Bring the two-way compatibility and negative-case note to the coordinator.
- Refresh against the carried landing delta. Main overlapping claims — N10 (`apps/server/src/cli/uninstall.ts`), TF1 (`scripts/check-changed.ts`), TF1 nits (`scripts/check-changed.ts`), K8 (`apps/web/src/components/ChatView.logic.test.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 41 | 9a4ec171fc2 | adapt | C2 | GOAT forwards stop signals but has no escalation after forwarding (goat.mjs:208–225). Port bounded shutdown to the renamed launcher and verify child ownership and launchd behavior. |
| 60 | db2cc202642 | adapt | **C4** | GOAT’s setup gates profile work on sandboxBlocked (cli/browser.ts:135), which does not prove the on-disk profile is loaded. Add root reload and keep GOAT’s AppArmor names and unprivileged diagnostic flow. |
| 172 | 8a072ca51d2 | adapt | **C4** | GOAT still carries Alchemy and its Cloudflare runtime (pnpm-workspace.yaml:75,131). Its lock currently resolves the exact unenv peer; pin the release-smoke install resolution using GOAT’s dependency setup and regenerate the lock. |
| 178 | f2764f71b2a | adapt | C1 | Run the runtime check once before workers that need real Electron. Desktop has separate unit and DOM project setups plus an Electron stub (vite.config.ts:199–224), so scope the hook to real runtime consumers. |
| 201 | bb9fde6fcda | adapt | C2 | `scripts/test-cached.ts:94` reads the newest summary by mtime and assumes one exists. Correlate the summary to a validated per-run marker and report an absent summary while preserving the test exit status. |
| 362 | f12527ecf0e | adapt | C2 | GOAT extracts first start into scripts/lib/dev-first-start.ts:42–115, and its executable is goat-resource-monitor (ResourceMonitorBinary.ts:63). Detect the missing binary using GOAT lookup rules and invoke the existing build through kache, retaining the nonfatal telemetry warning and skipping web-only starts. |
| 431 | 7f81aa83867 | adapt | C1 | The corresponding jump-hint fixture at Sidebar.browser.test.tsx:154–156 uses the live minute source. Fix that clock in the existing GOAT render isolation test. |
| 471 | b64eebb991b | adapt | **C4** | GOAT packaging calls desktop-after-pack.ts:17–21 rather than the upstream Linux hook directly. Scan both architectures' packaged ELF version needs, enforce GOAT's build ceiling, and set the deb dependency floor without replacing GOAT packaging hooks. |
| 479 | ca29ff1d72a | adapt | **C4** | GOAT's thread CLI authenticates and opens MCP at thread.ts:206–220 through its own shell-credential path. Apply JSON-mode log isolation to that path so stdout contains only the document while preserving failure diagnostics. |
| 505 | bb33fc3a3fc | adapt | C1 | GOAT extracted the shared template to gitFixture.ts:54–82. Disable fixture-local Git auto-maintenance before the initial commit that can leave a lock racing the copy. |
| 534 | fece8934b57 | take | **C4** | An archived project still matches the undeleted path lookup at cli/project.ts:490. Re-add should restore that project identity with an optional explicitly requested title and preserve active-duplicate refusal. |
| 571 | c910b1bbe95 | adapt | **C4** | Human-readable service commands at service.ts:81 and bootService.ts:433 can omit the selected base dir. Use GOAT host launcher quoting for supported service hints and reuse the helper in the later up/status follow-up `eefba1a8af9`. |
| 590 | 5f6b5a8e60a | adapt | C2 | Use the host invocation resolver at cli/invocation.ts:221 to print the refused server's explicit GOAT home in the pairing command at cli/config.ts:356. |
| 609 | 355adf265cf | adapt | C1 | Add tailnet DNS, certificate and Linux operator prerequisites to the GOAT Tailscale Serve instructions at remote-access.md:182 using the existing CLI and Desktop paths. |
| 641 | 12042ffb293 | adapt | C1 | The guide duplicates result or input shapes at orchestrator-mcp-server.md:304–391. Link GOAT's contracts and align reader instructions with task wakes, host routing and local isolation. |
| 661 | e6666dc5402 | take | C1 | The Bitbucket setup copy at docs/user/source-control.md:94 and the provider form at definition.ts:59 both omit workspace-read scope. Update them together. |
| 674 | 97edb7ad42a | adapt | C2 | GOAT's synchronous input-key builder at check-changed.ts:91 still uses the slow ignored-file pathspec walk. Port the directory-first discovery and preserve generated files, install-state keys and nested-repo behavior. |
| 685 | b1050d34496 | adapt | C2 | The mobile case at queries.test.ts:5 repeats the exact-match ranking proved at packages/shared/src/composerPullRequestMatches.test.ts:24. GOAT's web test already lacks the upstream host/WSL block, so remove only the duplicative mobile coverage. |
| 692 | 294a8418ce8 | take | C1 | After :364 clicks the combobox, the list-capable case sends keys before its popup takes focus. Wait for the popup's focus before driving the keyboard. |
| 697 | da9c848e62f | take | C1 | The streaming fixture near :89 rebuilds timeline props and hides isolated row rerenders behind shared invalidations. Hoist stable callbacks and collections while keeping the changing timeline entries. |
| 791 | 2182097b1df | adapt | C1 | Requires `42057b82d09`. CLI help at :402 promises all connected clients apply the theme and GOAT has no upstream theme MCP toolkit. Clarify which clients consume the primary environment theme in GOAT's existing command. |
| 792 | ed7f069326d | take | C1 | The dual-account test calls freePort twice sequentially at :94–95. Reserve both sockets before release so the two fixture ports are distinct. |
| 832 | ddb7fb3f50c | adapt | C2 | Pair maps Serve refusal to a generic error at :481–489. Use a confirmed operator-denied diagnostic to provide the Unix remedy and preserve target-refused and non-Unix messages. |
| 840 | 399ea10f4ed | adapt | **C4** | The desktop-managed exception at :108–113 admits cross-track targets. Resolve targets for GOAT's Stable and Nightly policy so a Stable host never receives a nightly offer through Update everything. |
| 865 | d6672df2738 | take | C1 | Requires `d68a2fa6734`. The test comes from the Kimi port and does not yet exist in GOAT. Bring the poll-completion signal with it so fake-clock advances happen after each controlled read. |
| 991 | 84d34d40f84 | adapt | **C4** | Thread start builds only instance and model (thread.ts:789,807). Accept repeated model options through the existing selection schema, preserve CLI JSON output, and keep provider-specific validation and redaction. |
| 1051 | 215bd59a985 | adapt | C2 | Requires `7f7a1a447a2`, `37714a8de5e`. GOAT's guard sets exit code on asynchronous error (uninstall.ts:251–258), but the success message is emitted before the shell reports spawn (:261). Await owned spawn/error before unref and success, preserving verbatim quoting and guardChild. |
| 1053 | 786cf6a7368 | adapt | **C4** | Review against #471’s adopted ELF scanner and exclude WEAK requirements in the GOAT Debian build calculation. Requires `b64eebb991b`. GOAT's deb build config is in scripts/build-desktop-artifact.ts:3163 and lacks upstream's ELF requirement scanner. Carry the WEAK-entry exclusion only if the scanner/derived libc floor is adopted. [recheck: adapt, see /tmp/chase1118/triage-recheck.md] |
| 1085 | b91ea5443c2 | take | C1 | The lexer splits all Unicode whitespace at line 44. Restrict separators to ASCII whitespace so nonbreaking spaces in values survive. |
| 1096 | 4d0e2f52d25 | adapt | **C4** | The same remove-and-move publication race exists at lines 285–286. Adapt the owned staging cleanup and deterministic concurrency fixture to GOAT's release identity, and verify competing installs cannot remove a working publication or leave a nested runtime. |
| 1121 | 94dc06e7ac1 | adapt | **C4** | Doctor offers legacy deletion once an old DB is detected (`doctor.ts:92)). Make inspection fail closed and recheck missing project/thread IDs under the deletion lock, accounting for GOAT's legacy home and current database selection. |

### U69

**PR review, diff and deep links (2/2)** · W11 · mac · 1,858 estimated handwritten changed lines

- Start from K2’s routed anchors and PR Code tab. Keep actual revision/file identity, permission boundaries and forge-specific behavior. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — pr-event-feeds, resizable-width, contracts-rpc-leaves.
- Test force-push and refetch, withheld diff identity, link reveal from all entry points, and mobile navigation.
- **C4 before code** — rows #902. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (1 source paths) — `packages/contracts/src/pullRequest.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K2 (`packages/contracts/src/pullRequest.ts`), K1 (`apps/server/src/orchestration-v2/PullRequestSyncReactor.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 875 | 1f698f01d9f | adapt | C3 | Requires `70be20493b7`. GOAT web uses a toggle set and ignores the saved Viewed mark when deriving collapsed state (PullRequestCodeTab.tsx:561); mobile keeps a separate collapsed-id array (PullRequestRouteScreen.tsx:998). Share fold precedence, keep linked files open, and ensure a folded tail still triggers native pagination. |
| 902 | 15271c8d008 | adapt | **C4** | **Contracts.** Requires `d5a50a1d0d1`. Web label toggles write immediately (PullRequestLabelPicker.tsx:48), and mobile has separate pending guards. Stage net picks until close using the existing wire limits, with one-time flush, current permissions and typed/manual entry for hosts without candidate lists. |
| 930 | a10f9e41d37 | take | C1 | Record bounded per-link transient read backoff in the existing sweep dedupe (PullRequestSyncReactor.ts). A manual refresh may read immediately, a recovered read clears backoff, and removing a link drops its retry state. |
| 935 | 4b22bb47d42 | adapt | C3 | GOAT's stack view treats a cached success as fresh (pullRequestStackSnapshot.ts:62), and web Code intent only loads the module (PullRequestDetailPanel.tsx:1516). Paint cached data, require the current host's answer before writes, and prefetch through the same route and permission boundary as a click. |
| 974 | 47c95c28124 | adapt | C3 | Requires `4b22bb47d42`. The guide loads by PR and cursor (useGuideDiffFiles.ts:49), so a rewritten guide can reuse an earlier head's atoms. Partition the cache by head SHA without forwarding the client-only key to the RPC. |
| 995 | 1b8ac6d77ee | adapt | C3 | Requires `f12e8206f56`. The list decoder only flags collapsed/too_large as truncated (gitLabMergeRequestJson.ts:805); retain those paths, attach GitLab totals, and allow a bounded exact-revision per-file read through the existing diff contract. |
| 997 | 44ebe671951 | adapt | C2 | Selection IDs omit diff sides and PR URL scope (PullRequestCodeTab.tsx:683; pullRequestDetail.logic.ts:1076), so distinct citations can overwrite each other. Include start/end side and PR URL and coordinate 1da3f3f3702. |
| 1034 | f98249acad3 | adapt | C2 | Requires `f12e8206f56`. Main and withheld diff model identities include resolvedTheme (PullRequestCodeTab.tsx:406 and withheld branch). Use an appearance-neutral diff identity so changing palette preserves line and draft state. |
| 1066 | 1da3f3f3702 | adapt | C2 | Requires `44ebe671951`, `2d80ca0852d`. GOAT's extracted helpers cap the body at 1,000 characters and isolate single remarks (pullRequestChatContext.ts:48,98–122). Include associated line comments and truncation evidence within the existing context budget, adopting f92c5e8f982's diff-side correction. |
| 1075 | 0c676d95b1e | adapt | C2 | Implement independent PR accessible label now. Issue-specific presentation remains with the conditional Issues rollout. The watched PR row still passes `link.url` as its accessible name at `ThreadDetailsPrRows.tsx:59`. Use GOAT's provider-specific term, number, title and state, together with 42763ff8b12, and leave the absent issue rows with their feature. |
| 1135 | 42763ff8b12 | adapt | C1 | Requires `0c676d95b1e`. The decorative number is a separate visible span at line 492. Hide that duplicate from assistive technology once the row's new accessible name supplies the number, while retaining visible text. |

### U70

**Issues • GitHub core** · W12 · server-only · 4,805 estimated handwritten changed lines

- Gate on #1001. Register GOAT-scoped GitHub issue CRUD through RPC leaves and the authorized provider registry. Stage contracts, service and GitHub GraphQL inside this row. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — contracts-rpc-leaves, mcp-names, mcp-registration-context, settings-page.
- Keep all visibility gated through the final tracker-state schema. Exercise permissions, unsupported hosts, older capability absence and versioned GraphQL fixtures.
- **C4 before code** — rows #1001. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (4 source paths) — `packages/contracts/src/issue.ts`, `packages/contracts/src/rpc.ts`, `packages/contracts/src/clientRpcPermissions.ts`, `packages/contracts/src/index.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K3 (`apps/server/src/ws.ts`), K7b (`apps/server/src/server.ts`), K8 (`apps/server/src/server.ts`), K7 (`apps/server/src/ws.ts`). The summary lists all carried waits.
- Oversized single row. Stage the steps in this lane under the one row owner; keep feature exposure gated through the combined checks.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 1001 | 20501a02213 | decide · pending d1 | **C4** | d1 recommendation — port Issues core and conditional chain. **Contracts.** Should GOAT ship a first-class Issues service with GitHub read/write support? The existing driver has PR operations (packages/source-control-github/src/server/driver.ts:74–80) and no issue API; the upstream base adds scoped CRUD/reactions and templates, with GraphQL generated from schema plus issues.graphql using GOAT's existing generator. |

### U71

**Scheduling, firing receipts and task controls** · W12 · mac · 1,123 estimated handwritten changed lines

- Build on SF4 first-bind intent. Under #1036 use exact eligible due-firing identity and retain thread, history and webhook bookkeeping. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — contracts-rpc-leaves, orchestrator-goat-modules.
- Test reassignment, duplicate firing, paused pre-due manual runs and refusal after restart or rollback.
- **C4 before code** — rows #110, #398, #1036. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (1 source paths) — `packages/contracts/src/orchestratorMcp.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K1 (`apps/server/src/mcp/OrchestratorMcpService.ts`), K4 (`apps/server/src/orchestration-v2/ThreadLaunchService.ts`), K6 (`apps/server/src/mcp/OrchestratorMcpService.ts`), K7 (`apps/server/src/mcp/OrchestratorMcpService.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 110 | fe873f82c1b | adapt | **C4** | The task row goes straight to remove after permission and busy checks (ScheduledTasksSettings.tsx:579–587). Reuse GOAT’s destructive confirmation host at that entry point and preserve cancel and destination permission checks. |
| 209 | ae837398a25 | adapt | C1 | `apps/server/src/telemetry/ProviderDimensions.ts:125` derives binding from the request default. Read the successful GOAT result's boundThreadId from `apps/server/src/mcp/scheduledTaskSummary.ts:21` and record only the boolean. |
| 217 | 250e502bfa1 | adapt | C1 | `apps/mobile/src/features/settings/SettingsScheduledTasksRouteScreen.tsx:439` spreads a captured editor snapshot on each update and :539 submits from render state. Use functional atom updates, guard environment-specific callbacks, and save the current draft with GOAT's picker and task modes. |
| 243 | e26e21c06b0 | adapt | C3 | `apps/web/src/components/settings/ScheduledTasksSettings.tsx:1424` offers a model choice even for a bound thread. Resolve its current model from shell or family reads, lock the GOAT picker only when bound, and keep the new-thread seed available when unbound. |
| 295 | b5df3c1bef5 | adapt | C1 | GOAT still turns a cleared fixed time into 09:00 at line 198. Validate at scheduleDraftErrors:106 and keep the default only when initializing a draft, preserving GOAT's scheduled-task options. |
| 314 | 7b26203b8bd | take | C1 | scheduledTaskPresentation.ts:59–62 chooses a unit before rounding, producing 60 minutes near the boundary. Round minutes first and switch the label to hours once the result reaches 60. |
| 330 | 3ceed620cfc | adapt | C3 | ScheduledTaskService.ts:1100–1104 only falls back to root for Scratch. Reuse GOAT worktree preflight to identify a known non-repo before storing worktree strategy and preserve diagnostics for unreadable repos. |
| 398 | 0035cb55bb1 | adapt | **C4** | **Contracts.** GOAT's scheduled-task list and update use the caller-aware summary at OrchestratorMcpService.ts:1913–1928 and :2017. Add the optional task-ID filter and make list/update omit bearer URLs, retaining the existing authorized creation and GOAT routing. |
| 568 | 4a3be943c91 | adapt | C2 | GOAT already persists refusal details via ScheduledTaskService.ts:785–797 and unwraps causes at scheduledTaskError.ts:19. Keep its durable dispatch evidence and limit rendered messages to known user-facing refusals, with generic output for opaque errors. |
| 1036 | 17c142588b0 | decide · pending d1 | **C4** | d1 recommendation — port successful due-firing expiry with the paused/manual guard. Include the due-time/manual paused guard in the accepted expiry behavior. See #1150 as reference. Requires `4a3be943c91`. Should GOAT remove successful one-time schedules from the task list while retaining the thread and firing record? GOAT uses an attribution ledger (ScheduledTaskService.ts:792–822); if approved, consume only the due firing and preserve paused pre-due manual runs per 281d3e1cbe9. |

### U72

**Composer drafts, queued edits and uploads (3/4)** · W12 · mac · 2,442 estimated handwritten changed lines

- Keep draft ownership and dispatch classification, GOAT Reply and separate approval/question paths. Preserve destination and idempotency during retry. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — composer-footer, reply-to-response, decision-routing.
- Test queued edits, expired uploads, side-chat and linked routing, and cross-device mutation confirmations under d1 #89.
- Refresh against the carried landing delta. Main overlapping claims — K6b (`apps/web/src/components/ChatView.tsx`), K2 (`apps/web/src/components/ChatView.tsx`), K8 (`apps/web/src/components/ChatView.tsx`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 675 | 4117bd42ec3 | adapt | C3 | ChatView.tsx:1389 subscribes to per-keystroke answer state. Move editor subscriptions down to the composer and read the current draft at action time, preserving typed answers, attachments, request scope and submit behavior. |
| 688 | 8e06750a08a | take | C1 | composerImagePersistence.ts:20 and :36 return Map insertion order, which follows asynchronous read completion. Preserve source order with Promise.all results. |
| 736 | f2c944947dd | adapt | C3 | attachmentUploadQueue.ts:418 trusts a ready upload indefinitely. Revalidate and rebuild expired uploads across send, fanout, queued edits and pending answers while checking for intervening edits, using the shared registry if 1da6b14e922 lands. |
| 748 | 7d9c365e173 | adapt | C3 | Requires `b90ffeaf288`. composerDraftStore.ts:736 still uses metadata identity, which collapses distinct equal-length images. Use byte equality where web has files and a conservative identity on mobile while preserving GOAT's pending-question and stash attachment paths. |
| 766 | 8897a6ebe19 | adapt | C3 | Requires `3c8f3f2c3d8`. chatViewSend.ts:223 restores only prompt text on rewind, and composerPromptHistory.ts already rebuilds mention records for history. Share that reconstruction and attach metadata without inserting duplicate chips, preserving GOAT citation/attachment state. |
| 772 | 6d3f6423a34 | adapt | C2 | Requires `382312aba8f`. composer-logic.ts:55-72 resolves Enter with partial hard-coded context. Share GOAT's focused panel context at each composer entry point so inactive panel bindings do not shadow Send. |
| 779 | 0b489dada1f | adapt | C2 | The send-time retarget copies fanout selections at :171, while automatic retarget at :201 and manual switch at :298–330 leave them behind. Share fanout carry across retarget entry points and apply 50b885e0361's destination-default rule in single-model mode. |
| 782 | 0de6ddb8235 | adapt | C3 | Both queued-edit branches can save text that the ordinary composer routes to a side chat (:643 and :487 respectively). Reject /side and /btw before save or steer, keeping annotation and GOAT reply-context handling intact. |
| 846 | 3cf00c3e8b9 | take | C1 | ASCII word checks at :58 and :121–122 can remove underscores inside non-Latin words. Use Unicode word boundaries with support for combining marks and surrogate pairs. |
| 848 | 1b84e72a6dd | adapt | C2 | useComposerSend.ts:643 takes the save-only path and useQueuedRunEdit.ts:424 finishes without asking to steer. After a successful alternate-command save, reuse the existing queued promotion guard and retain GOAT reply context. |
| 872 | 50b885e0361 | adapt | C2 | Requires `0b489dada1f`. DraftHeroHeadline.tsx embeds project-default seeding while routing retargets context at useDraftEnvironmentRouting.ts:185 and manual switch later in the same hook. Seed single-model drafts from the destination when there is no explicit choice, preserving explicit models and separately carrying fanout picks. |
| 894 | caef8c3847b | adapt | C3 | Requires `2dd810d0f60`. GOAT's composer already makes GOAT-specific local-command and context decisions. Match the action presentation to the submission handlers on both clients, including the side-chat exception and the text-only guard for other local commands. |
| 916 | f4d0855a50d | adapt | C2 | A valid PDF currently gets a PDF accent through the chip's ink variant (ContextChip.tsx:8). Use GOAT's own neutral text and PDF icon treatments so valid previews and invalid attachments are visually distinct in both composer and sent messages. |
| 976 | f39ecd3df8f | adapt | C2 | Requires `ed6cb97f07d`. The serializer inserts special spacing only after quotes (composer-rich-text-doc.ts:960,1410). Preserve the horizontal-rule source with an unambiguous blank line, and remap caret offsets across inserted newlines. |
| 1153 | 01cfac429d9 | take | C2 | The paste handler computes bypassAutoAttachment but omits it from the mixed clipboard decision at line 2771. Pass it through and choose meaningful plain text for Paste as Text with both clipboard types. |

### U73

**Workspace paths, link rendering and media** · W12 · mac · 1,957 estimated handwritten changed lines

- Use destination environment and workspace aliases, prioritize explicit paths and bound cwd fallback. Preserve GOAT media permissions. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — office-archive-split, pdf-viewer, ssh-runtime.
- Cover Git Bash/Windows/WSL paths, re-signed videos and stale or inaccessible resources.
- **C4 before code** — rows #268. Bring the two-way compatibility and negative-case note to the coordinator.
- Refresh against the carried landing delta. Main overlapping claims — K8 (`apps/web/src/components/ChatMarkdown.tsx`), K12 (`apps/mobile/src/features/threads/ThreadFeed.tsx`), K4 (`apps/server/src/vcs/GitVcsDriverCore.ts`), K7 (`apps/web/src/components/ChatMarkdown.tsx`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 12 | 36f011dfb79 | adapt | C3 | GOAT’s existing project lookup (ChatMarkdown.tsx:639–688) needs a bounded fallback to literal agent working directories from preceding command items. Keep explicit paths, unique project matches, and destination environment file checks ahead of the fallback. |
| 29 | 7ae21bf1640 | take | C1 | The display helper handles POSIX absolute paths but treats an unrelated Windows drive path as relative (filePathDisplay.ts:43–48). The change and new test apply cleanly. |
| 32 | cf382b0c44e | adapt | C3 | GOAT already has image-side missing-file-access text (ChatMarkdownMedia.tsx:586–589) and shows a generic video failure (mobile MediaVideoPlayer.tsx:258). Carry permission state into both video experiences and GOAT’s actual modal implementations. |
| 54 | 6fe782ca4a5 | adapt | C3 | GOAT expands home before metadata and asset checks but does not translate a Windows drive path on a WSL host (WorkspaceFileSystem.ts:207–211, AssetAccess.ts:555,609–612). Translate with the host’s actual mount mapping before the existing access checks and coordinate path normalization with f52e5c19198 and ecb295516fb. |
| 151 | 28f17868294 | adapt | C1 | A refreshed parent currently overwrites only itself (useDirectoryEntries.ts:50). Invalidate descendants and fence their pending reads, keeping GOAT’s query scopes and refresh scheduling. |
| 155 | a61291e3e2c | take | C1 | Require an explicit file scheme before calling URL (fileLinks.ts:17). Chromium on Windows otherwise sees single-letter schemes as drive paths. |
| 197 | 8cb551a3cec | adapt | C3 | The extra confirmation read in `apps/web/src/components/files/projectFilesQueryState.ts:208` can fail and leave the saved overlay pinned. Retire it on the next successful answer from its canonical query, including an equal answer, while preserving newer drafts and GOAT read reconciliation. |
| 268 | f52e5c19198 | adapt | **C4** | Requires `6fe782ca4a5`. `apps/server/src/assets/AssetAccess.ts:610` and `apps/server/src/workspace/WorkspaceFileSystem.ts:292` recognize only slash-style home paths before host conversion. Recognize backslash-style home prefixes while preserving both existing workspace and asset authorization checks. |
| 276 | e5d4322c10d | adapt | C2 | `apps/server/src/vcs/GitVcsDriverCore.ts:3470` returns raw contents, so ident expansion can disagree with Git hunks. Use Git-confirmed ident normalization for eligible text without overriding other filters. |
| 296 | 60e4be49cfb | adapt | C2 | Parsed Codex citations still encode punctuation without disambiguating relative paths (codexFileCitations.ts:21–22), and fileLinks.ts:104 joins the raw relative path. Integrate the conditional ./ prefix and normalize it on join, retaining the GOAT file-link routing in 867101a41d5 and efd048fc517. |
| 346 | a6765d41d58 | adapt | C2 | AudioPreview.tsx:146 unconditionally animates the loading icon, while the shared spinner already has motion-safe styling (spinner.tsx:7). Use it for audio. The upstream ThreadServersPanel module is absent. |
| 399 | 2afee520252 | adapt | C2 | Requires `1f45f14ae86`. The preview close action at ExpandedImageDialog.tsx:243 can be confused with the native close control. Give it a clearly labeled Back action reachable in narrow windows using GOAT's dialog and titlebar conventions. |
| 600 | 137a8691384 | take | C1 | preview.ts:221 defaults schemeless input to HTTPS before parsing. Reparse recognized loopback hosts as HTTP and retain explicit ports and schemes. |
| 681 | fbfebc85378 | take | C2 | videoThumbnails.ts:26 and :65 cancel active extraction with its reader and generate before the iOS player item is necessarily attached. Finish the bounded extraction under the stable cache key and wait for sourceChange. |
| 700 | 40f63b468f0 | adapt | C3 | NativeAppIconResolver.ts:23 and :187 use 64 px and a size-blind cache key. Upstream AppBundleIcon is absent and GOAT renders FileTagChipContent at MarkdownFileLink.tsx:367, so bring placeholder continuity with the deferred markdown app-bundle path recorded at 10.025_t3_chase_cycle_261114.md:821. |
| 709 | 79e47e90963 | take | C3 | markdownLinks.ts:204 rejects relative extensionless basenames unless they have a position. Share the known basename allowlist with the mobile chip matcher while rejecting similarly named non-files. |
| 741 | 45649628dcb | adapt | C2 | ThreadFeed.tsx:2171 opens inline images without their message's gallery. Pass the context from AssistantMarkdownContent, extracted at 161bb2aeb5e since the named snapshot, while keeping the video path. |
| 777 | d21d8d8b5df | adapt | C1 | Requires `fbfebc85378`. The image first receives its native thumbnail at :37–43. Mount with content fit and wait for layout before setting its source, preserving the focus-aware thumbnail lifecycle. |
| 814 | ac5dd1ff47d | adapt | C3 | ThreadInlineFilePreview.tsx:243 unmounts offscreen players. Retain only the active audio row through virtualization and release on finish, error or leaving the thread. |
| 1063 | ecb295516fb | adapt | C3 | Requires `f52e5c19198`, `bdf6c6ec890`. GOAT does not have upstream's wslDrivePath leaf. Normalize Git Bash drive syntax on native Windows at existing asset and workspace entry points before their allowlist/path boundary, preserving POSIX and WSL behavior. |

### U74

**Checkpoint integrity and worktree retention (1/2)** · W12 · server-only · 1,287 estimated handwritten changed lines

- Preserve K4’s lease and ownership model, retained fork ancestry, old refs and cautious cleanup for mismatched owners. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — orchestrator-goat-modules, cli-home, code-budgets.
- Test restore/capture cancellation, live sibling terminals, submodules and concurrent user work in disposable repositories.
- **C4 before code** — rows #649. Bring the two-way compatibility and negative-case note to the coordinator.
- Refresh against the carried landing delta. Main overlapping claims — K6 (`apps/server/src/orchestration-v2/Orchestrator.ts`), K1 (`apps/server/src/orchestration-v2/Orchestrator.ts`), K6b (`apps/server/src/orchestration-v2/Orchestrator.ts`), K9 (`apps/server/src/orchestration-v2/Orchestrator.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 649 | d2a894a247c | adapt | **C4** | Requires `997b304dd65`. ProjectionStore.ts:5260 only checks one fork hop. Compute the live descendant history ranges before deleting ancestor-owned attachments or HTML, serialize deletion and preserve lock ordering across both normal and side-chat forks. |
| 841 | 39e269a37c1 | adapt | C2 | The temporary checkpoint index stages untracked files through GitVcsDriver.ts:1280–1360. Reuse only verified unchanged blobs in eligible worktrees, retaining correctness for path changes, ignore rules, racy metadata and linked or sparse worktrees. |
| 1017 | 09458669eac | adapt | C1 | The checkpoint path currently looks across reflogs for provenance. Use a small bounded HEAD-reflog proof for local creations, with the global query only for unproven commits so fetched history and ref moves remain distinguishable. |

### U75

**Catalog check before localization** · W12 · mac · 96 estimated handwritten changed lines

- Apply the preflight to GOAT catalog extraction and goat-ci. Include Issue settings strings only if those settings land. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — ci, goat-copy.
- Verify catalog drift, missing parameters and fallback before translating full surfaces.
- Refresh against the carried landing delta. Main overlapping claims — K9 (`.github/workflows/ci.yml`), TF1 (`.github/workflows/goat-ci.yml`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 1026 | b823ddadd9c | adapt | C2 | Gate the translation sweep. Handle terminal and Issues labels only where their owner rows land. Requires `48a64a8b68c`. GOAT has catalogs and GT initialization (mobile I18nProvider.tsx:5,21) but lacks the catalog gate. Validate against GOAT extraction and approved surfaces, wire goat-ci, and coordinate expanded translated coverage in 055b44919ee. |

### U76

**Web file editor and diff rendering** · W13 · mac · 2,274 estimated handwritten changed lines

- Fit GOAT’s Pierre pin, editor ownership and file path rules. Review package, patch and lock decisions together. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — resizable-width, code-budgets.
- Check focus/selection, real whitespace paths, diff folds and editor fallback through normal browser entry points.
- **C4 before code** — rows #162, #454, #966. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (3 source paths) — `packages/contracts/src/orchestrationV2.ts`, `packages/contracts/src/pullRequest.ts`, `packages/contracts/src/review.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K2 (`packages/contracts/src/pullRequest.ts`), K1 (`packages/contracts/src/orchestrationV2.ts`), K12 (`apps/web/src/components/chat/TimelineAssistantRows.tsx`), K4 (`pnpm-lock.yaml`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 50 | a9fd0b2511a | adapt | C2 | GOAT’s copy handler only recognizes a currently mounted range (ReadOnlySourcePreview.tsx:26–34,108). Track offsets against source text so selection survives virtualized scrolling without coupling GOAT to upstream styling. |
| 116 | 5abf38367ba | adapt | C1 | Recheck found the actual remaining lossy decode at the cross-machine project-copy path. Preserve the read-only preview and prevent destructive replacement writes. GOAT detects invalid UTF-8 with a fatal decoder and marks the result unsupported (WorkspaceFileSystem.ts:497–506). The web preview disables editing (FilePreviewPanel.tsx:1529–1545), preventing the lossy save while permitting read-only preview. [recheck: adapt, see /tmp/chase1118/triage-recheck.md] |
| 127 | 9e180e55693 | adapt | C1 | Recheck found that cross-machine project copy omits the format/BOM and legacy write lacks its fallback. Carry format through that flow. Read records the BOM (WorkspaceFileSystem.ts:510–513), the editor carries format into save (useFileSaveCoordinator.ts:137), and atomic write restores it (WorkspaceFileSystem.ts:647–658). The older unformatted write API remains outside this editor path. [recheck: adapt, see /tmp/chase1118/triage-recheck.md] |
| 162 | 953ce60d123 | adapt | **C4** | **Contracts.** Checkpoint schema and store both trim paths (orchestrationV2.ts:1304, diffPanelStore.ts:104). Retain exact file names through contracts and GOAT’s turn and tool selection, reconciling renderer trimming only at lookup. |
| 372 | b96a5110677 | adapt | C2 | Header collapse resolves by filename at DiffPanel.tsx:1074–1083, so repeated blocks can share viewer identity and toggle the wrong block. Add per-occurrence keys and resolve collapse from the clicked block while preserving path-based file navigation on GOAT's split diff surface. |
| 385 | 2137f360e6b | take | C1 | Local storage read/write wraps editor selection directly at editorPreferences.ts:59–63. Keep preferences best-effort so an unavailable storage backend still permits opening the selected or fallback editor. |
| 387 | 1ea5e4b42d6 | adapt | C2 | FilePreviewPanel.tsx:720–721 republishes remapped comments regardless of prompt membership and line 890 renders them all. Filter updates and rendered comments by the current draft but retain hidden annotation positions for failed-send recovery. |
| 451 | 19c9df21612 | adapt | C2 | DiffFilePathCopyButton.tsx:30 copies the raw relative path. Pass the target workspace root into the existing client-runtime formatter so a Mac client copies Windows paths correctly. |
| 454 | ee2cddf357a | adapt | **C4** | GOAT pins beta.3 and its find patch at pnpm-workspace.yaml:63 and :402. Upgrade the dependency and use its collapse-change callback while retaining the slim subpath exports, caret metrics and both diff viewers; review editor focus follow-up 1c7d9454393. |
| 470 | 2b6c14bbf1c | adapt | C2 | diffFileActions.ts:28–36 treats backslashes in POSIX filenames as separators and DiffPanel.tsx:161 resolves roots through GOAT's helper. Preserve literal POSIX names, reject traversal with either separator, and resolve the actual review or worktree root for Open and Reveal. |
| 691 | 9a79883979e | take | C1 | DiffPanel.tsx:552 and :1098 send provider tool diffs through repo-root resolution. Keep recorded provider tool paths workspace-relative or absolute and retain repository roots for git and checkpoint diffs. |
| 817 | 109e9dbdfd1 | take | C1 | Per-path reveal state at :368–389 retains only request bookkeeping. Extend it to restore the viewport after tab remount while a fresh line-reveal request remains authoritative. |
| 882 | 1c7d9454393 | adapt | C3 | Requires `ee2cddf357a`. Clear retained find focus when the editor receives focus. GOAT pins the beta.3 patched editor (pnpm-workspace.yaml:402), so port to the active editor implementation or fold into the beta.4 upgrade. |
| 891 | 83c520c21f8 | adapt | C3 | Requires `ee2cddf357a`, `1c7d9454393`. The upstream search-panel host gets the overlay marker used by the editor's hit testing; adapt the equivalent to GOAT's pinned beta.3 find implementation (pnpm-workspace.yaml:402) or carry both editor fixes with beta.4. |
| 966 | 75683c8f937 | adapt | **C4** | **Contracts.** Requires `ee2cddf357a`. GOAT trims oldPath/newPath in both content-input contracts (pullRequest.ts:726–727, review.ts:60–61). Preserve Git path whitespace end to end and apply the parser correction to GOAT's actual package version. |

### U77

**Checkpoint integrity and worktree retention (2/2)** · W13 · server-only · 2,146 estimated handwritten changed lines

- Preserve K4’s lease and ownership model, retained fork ancestry, old refs and cautious cleanup for mismatched owners. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — orchestrator-goat-modules, cli-home, code-budgets.
- Test restore/capture cancellation, live sibling terminals, submodules and concurrent user work in disposable repositories.
- **C4 before code** — rows #142, #191, #214, #328, #367, #408, #442, #483. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (1 source paths) — `packages/contracts/src/vcs.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K4 (`apps/server/src/vcs/GitVcsDriverCore.ts`), K12 (`apps/server/src/orchestration-v2/ProjectionStore.ts`), K6 (`apps/server/src/orchestration-v2/ProjectionStore.ts`), K7 (`apps/server/src/orchestration-v2/ThreadTitleRegenerationService.test.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 142 | 4652544f33c | adapt | **C4** | **Contracts.** Use private checkpoint objects and publish them before exposing the ref; only clean the private store on interruption. Integrate with GOAT’s checkpoint/restore critical section and error routing (GitVcsDriver.ts:919). |
| 184 | c5f842d4c7d | adapt | C2 | The title path refuses before considering inherited history and uses current rollback state (ThreadTitleRegenerationService.ts:78,160). Reuse the projection’s time-aware fork boundaries, including retained deleted sources, and preserve GOAT title routing. |
| 188 | 0a8aaa3ccb9 | take | C2 | Fork shell counting reads ancestry through the live-only query (ProjectionStore.ts:7156,7397). Admit deleted ancestry for retained history while keeping deleted roots out of normal shell listings. |
| 191 | 071ae4e9514 | adapt | **C4** | Deletion currently clears every override (ProjectService.ts:550). Retain only worktree-cleanup policy for soft-deleted owners and continue clearing provider overrides and settings for fully absent projects. |
| 214 | 19f643856ee | adapt | **C4** | `apps/server/src/vcs/GitVcsDriver.ts:1519` restores into the index before its later reset. Add a cancellation-safe spawn handoff and scoped index cleanup within GOAT's restore and workspace guards. |
| 259 | 566370f2eee | adapt | C1 | `apps/server/src/storageCleanup.ts:685` classifies branchless idle threads as busy. Give them a separate keep reason while retaining GOAT's branch and deletion protections. |
| 328 | 29d517dbac0 | adapt | **C4** | Cleanup uses project.workspaceRoot for removal at storageCleanup.ts:921–929 even if the project moved clones. Resolve the worktree's git-common-dir for removal and keep GOAT's ownership, snapshot and restore protections. |
| 367 | 0cb9328ea00 | decide · pending d1 | **C4** | d1 recommendation — skip branch-identity rewrite and preserve GOAT cleanup ownership. GOAT currently keeps mismatched branches at storageCleanup.ts:712 and :885 and has no WorktreeBranchSync service. May cleanup rewrite a live owner's saved branch to make that checkout eligible on a later sweep, or should it require explicit reconciliation under GOAT's snapshot policy? |
| 408 | f56f27e6c93 | adapt | **C4** | storageCleanup.ts:915–916 cleans untracked files before a forced-removal submodule check can retain the worktree. Keep the ordinary tracked-changes cleanup and defer any destructive action on the force path until the final decision. |
| 439 | 852f53b801a | adapt | C2 | GitVcsDriverCore.ts:1966–1972 omits an untracked override and the separate review paths already handle untracked data differently. Force normal listing when status config hides it and retain all mode and GOAT's review-index safeguards. |
| 442 | 733a20008c7 | adapt | **C4** | GOAT's cleanup sweep at storageCleanup.ts:1180 has no deleted-thread ref reclamation. Use GOAT checkpoint scope and legacy alias rules, keeping live and archived fork ancestry and pending captures while guarding a concurrent fork at EventSink.ts:420–435. |
| 483 | 6e0cbb3ea9f | adapt | **C4** | GitVcsDriver.ts:858 captures the superproject only. Snapshot and restore populated nested submodules only where their checkpoint exists, and align deletion and retention with both checkpoint namespaces at legacyT3Names.ts:205–208. |
| 1078 | 47888ec2269 | take | C1 | The merge-check fetch at line 4916 still uses the normal Git timeout and omits --no-auto-gc. Reuse the existing remote-fetch timeout and leave the cache invalidation wrapper in place. |

### U78

**Agent tools, transport and scoped reads (2/2)** · W13 · server-only · 1,006 estimated handwritten changed lines

- Preserve goat_* names, MCP registration context, person settings authority and delegated/remote ancestry in GOAT-owned services. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — mcp-auth-middleware, mcp-names, mcp-registration-context, decision-routing, remote-reports.
- Test advertised schema and validation together, denied linked scope, task status fallback and bounded projection reads.
- **C4 before code** — rows #426, #554, #596, #646, #729, #947, #1103. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (1 source paths) — `packages/contracts/src/orchestratorMcp.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K9 (`apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`), K1 (`apps/server/src/mcp/OrchestratorMcpService.ts`), K12 (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`), K4 (`apps/server/src/orchestration-v2/ThreadLaunchService.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 426 | 5393882fb80 | adapt | **C4** | **Contracts.** The local wait still defaults to four minutes at orchestratorMcp.ts:235. Return recoverable handles in 30–45 seconds, keep the separate secret-request budget, and verify the contract against SSH remote-task callers rather than porting T3 peer forwarding. |
| 550 | 35b88636d43 | adapt | C2 | The advertised-model refusal at OrchestratorMcpService.ts:952 gives only the rejected slug. Suggest a bounded list from the caller-visible provider, point to the GOAT capability lookup and integrate the later CLI-version branch in `9c1dfbb5aaf`. |
| 554 | 9504f65989d | adapt | **C4** | Requires `f7b0b3c4d73`. GOAT's compactor copies enum verbatim at advertisedJsonSchema.ts:96. Drop incompatible enum metadata only from advertised schemas and preserve validation and string discriminants, including for Antigravity. |
| 596 | 2e9418af79a | adapt | **C4** | Use the shared ceiling check at threadAccess.ts:119 for send and steer, including target and effective limits in the error while keeping GOAT's remote sender authorization. |
| 646 | ffd11ffc95c | adapt | **C4** | handlers.ts:187–192 dispatches deletion even for the built-in project. Use the existing scratch-project identity check before the MCP mutation, including force, and retain the Settings removal path. |
| 670 | 11c425b4b6b | adapt | C2 | latestTerminalResultRun at OrchestratorMcpService.ts:486 can select the cut predecessor before heldForRestart is evaluated at :1342. Resolve continuation lineage first for GOAT task reads, preserving explicit cancels and actionable refusal states. |
| 729 | 4ab3b984112 | take | **C4** | mcpApp.ts:175's frame-src prevents blob-backed MCP embeds from loading. Permit the blob fallback in the existing isolated app frame while retaining sandbox, origin and other directives. |
| 778 | 9c1dfbb5aaf | adapt | C2 | Requires `35b88636d43`. GOAT resolves model failures on its own local and remote target paths (OrchestratorMcpService.ts:1075–1084 and RemoteTaskTargets.ts:312). Carry the minimum and detected CLI version when the live catalog reports an update-required model. |
| 800 | 21fe33c8d7f | adapt | C2 | projectDefaultModelSelection at :685–694 rejects a project without its own value. Read the effective project/environment model for scheduled tasks while preserving GOAT's parent and scheduled-task routing precedence. |
| 947 | 1adc05b8445 | adapt | **C4** | Requires `dfd2187ccb0`. GOAT's first dispatch already installs DispatchModeLimit (OrchestratorMcpService.ts:2991–2999), and accepted launches have a separate receipt path (ThreadLaunchService.ts:1142). Recompute live parent authority on retry and verify stored project/worktree identity before replay. |
| 1103 | e5d757f51b3 | decide · pending d1 | **C4** | d1 recommendation — skip and retain the documented MCP root default. Requires `bc7fe11002a`. Should an external goat_thread_launch with no workspace follow project and environment worktree defaults when the GOAT tool explicitly promises root (`tools.ts:151`, `ThreadLaunchMcpService.ts:595`)? |
| 1110 | de7b5e05f6a | adapt | C2 | The shared miss helper only probes an mcp-prefixed ID (`OrchestratorMcpService.ts:216`), and GOAT parses links differently. Add an authorized same-environment suggestion for supported link forms while preserving the original read denial and leaving remote, deleted and out-of-scope threads undisclosed. |

### U79

**Issues • web shell** · W13 · mac · 3,112 estimated handwritten changed lines

- Use GOAT’s full-page Settings, sidebar and right-panel navigation. Stage the route, shared state and panels inside this row with visibility gated. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — contracts-rpc-leaves, mcp-names, mcp-registration-context, settings-page.
- Verify keyboard/back, selected environment and wrong-scope deep links on the web and desktop wrapper.
- **C4 before code** — rows #1002. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (2 source paths) — `packages/contracts/src/issue.ts`, `packages/contracts/src/environment.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K2 (`docs/user/source-control.md`), K3 (`packages/contracts/src/environment.ts`), K7b (`packages/contracts/src/environment.ts`), K8 (`apps/web/src/components/CommandPalette.tsx`). The summary lists all carried waits.
- Oversized single row. Stage the steps in this lane under the one row owner; keep feature exposure gated through the combined checks.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 1002 | 85dcfa61cab | adapt | **C4** | **Contracts.** Requires `20501a02213`. Conditional on the Issues base: fit a capability-gated list/detail into GOAT's sidebar, right panel and keyboard/close navigation (SidebarChrome.tsx; RightPanelTabs.tsx). Assemble shared atoms and permission-aware writes; reuse GOAT PR primitives where suitable. |

### U80

**Composer drafts, queued edits and uploads (4/4)** · W13 · mac · 256 estimated handwritten changed lines

- Keep draft ownership and dispatch classification, GOAT Reply and separate approval/question paths. Preserve destination and idempotency during retry. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — composer-footer, reply-to-response, decision-routing.
- Test queued edits, expired uploads, side-chat and linked routing, and cross-device mutation confirmations under d1 #89.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 1052 | 134580067f3 | adapt | C2 | Requires `b90ffeaf288`, `ec01233fb65`. Recovery takes an attachment snapshot before its save (recover-failed-thread-draft.ts:16–24). Merge any paste finalized during that save before clearing the source, preserve existing attachments and ordering, and avoid applying new-input limits to already accepted content. |
| 1076 | dd40cb51ea8 | adapt | C1 | The controls are siblings in GOAT's editor (`AssistantCitationCommentEditor.tsx:107`). Keep Save and Cancel together when dictation controls wrap, using GOAT's own spacing and existing keyboard behavior. |
| 1139 | 3e1b7c4e93d | adapt | C1 | The GOAT serializer at line 1408 starts adjacent blocks with one break. Port list/prose separation in both directions while preserving intentional empty paragraphs, selection offsets and special editor nodes. |

### U81

**Provider host, capabilities and smaller adapters (2/2)** · W14 · mac · 2,321 estimated handwritten changed lines

- Use GOAT provider host/text-generation selection and preserve its attachments. Require explicit opt-in for fx profile MCP under #642. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — contracts-rpc-leaves, memory-app-layers.
- Test unsupported capability, profile opt-out, native interjection, queue fallback and selection of the configured runtime.
- **C4 before code** — rows #216, #624, #642. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (2 source paths) — `packages/contracts/src/orchestrationV2.ts`, `packages/contracts/src/modelSelection.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K6 (`apps/server/src/orchestration-v2/ProjectionStore.ts`), K6b (`apps/web/src/components/ChatView.tsx`), K2 (`apps/web/src/components/ChatView.tsx`), K9 (`packages/provider-acp/src/server/adapter.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 17 | 08b8689a856 | adapt | C3 | GOAT inherits interrupt-restart steering (Grok adapter.ts:119–123). Fold the no-cancel capability into f82162f0336’s native interjection implementation, which retains that capability change and supersedes queue-only steering. |
| 138 | d2bdd58eef0 | adapt | C3 | Use npm outdated and list on the actual npm installation/prefix instead of registry latest, which can nominate an un-installable target. The resolver already has a separate pnpm flow at maintenanceResolver.ts:276; preserve driver-specific maintenance. |
| 183 | 6be1bd64722 | take | C1 | Carried SF3 port cf0cd39c34b. Record coverage when reachable; open the adaptation here only if the carried port is deferred. HEAD still slices each chunk (adapter.ts:1378); the earlier port cf0cd39c34b is on an unmerged lane. Land once with that lane if it integrates first, retaining the final 256 Ki-character cap. |
| 216 | f4e65cd843b | take | **C4** | **Contracts.** `packages/contracts/src/modelSelection.ts:37` forwards null into the options field. Normalize it to omission at decode while preserving valid options. |
| 246 | 2b596b86907 | adapt | C3 | **Contracts.** The server already has the placeholder predicate at `apps/server/src/orchestration-v2/projectionReducer.ts:106`, but the client event path at `packages/client-runtime/src/state/orchestrationV2Projection.ts:377` only upserts rows. Follow the active provider thread and constrain live usage and compaction for shared derivation and the web meter callers. |
| 413 | 74f02db077e | adapt | C2 | maintenanceResolver.ts:635 only recognizes a volta-shim basename. Extend bounded wrapper detection to exact Windows Volta stubs with corroborating package-image ownership, preserving GOAT provider-specific maintenance. |
| 538 | 7f6e403a888 | adapt | C3 | The Grok settle predicate checks background task IDs at adapter.ts:2815. Release the parent turn while detached shell output stays on its original row, using bounded ownership and preserving genuine monitor wakes and later completion. |
| 620 | 5de10b91d9d | take | C1 | Add a branch-naming-only instruction at textGenerationPrompts.ts:336 so the generator treats the user's task and attachments as naming input. |
| 624 | d6795eac3c6 | adapt | **C4** | Headless Grok runtime creation at textGeneration.ts:87–96 needs explicit ask mode and a permission handler that cancels. Preserve GOAT's launch environment and event-drain behavior. |
| 642 | 23ba9b35511 | decide · pending d1 | **C4** | d1 recommendation — port with explicit opt-in. GOAT's fx adapter at adapter.ts:209 builds ACP sessions without upstream's profile-MCP opt-in. Should fx sessions automatically load profile MCP servers alongside GOAT-managed attachments? |
| 667 | f0495f74175 | take | C1 | notification.ts:94 gives all reports the same verb from the aggregate outcome. Group individual outcomes while keeping the existing aggregate severity. |
| 680 | 9ec71438cd4 | take | C3 | handoffBudget.ts:128 reserves at least 16k even on tiny windows. Cap work reserve at half the window and retune the cross-provider fixtures. |
| 725 | 2dc5ebd52f2 | adapt | C3 | Requires `820f620e3d6`. useComposerSelection.ts:209 and the mobile model picker overwrite stored options when instance-local memory is empty. Keep effort for the same canonical model and instance without reviving cross-model option leakage. |
| 731 | 96188376948 | take | C1 | AntigravityTextGeneration.ts:90 decodes zero-byte MCP config as JSON. Treat only blank config as absent and keep nonblank parse errors visible. |
| 763 | ff9dca8931f | take | C1 | failure.ts:288-299 can expose the provider's raw oversized-request response and retain its retryable flag. Normalize genuine HTTP 413 failures and suppress same-payload retry. |
| 811 | f82162f0336 | adapt | C3 | Requires `08b8689a856`. Grok currently disables interrupt/restart at adapter.ts:112–124. Add noninterrupting interject with its own acknowledgment semantics, and preserve the shared ACP attachment and custom flavor paths. |
| 833 | 82ce7456de2 | adapt | C3 | GOAT's ProviderModelRetention.ts:34–38 retains missing entries for fx and Muse. Make successful inventories replace stale models and check each additional provider before generalizing upstream's ready-implies-authoritative rule. |
| 847 | f083f26cd5a | take | C1 | sanitizeThreadTitle at :89 strips leading and trailing quote runs independently. Strip only a genuine matching outer wrapper. |
| 873 | 760f9cbe64e | adapt | C2 | Initial and regeneration prompts at :391 and :423 always specify the same word/length limits. Resolve conflicting user instructions explicitly in both prompts and carry the prompt regression assertions; upstream's eval suite path is absent. |

### U82

**Issues • GitLab, Azure and Forgejo trackers** · W14 · server-only · 3,790 estimated handwritten changed lines

- Preserve GOAT host/project identity and make capability gaps explicit for GitCafe, Bitbucket and other hosts. Stage by provider within this row. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — contracts-rpc-leaves, mcp-names, mcp-registration-context, settings-page.
- Test CLI/API mock authorization, Azure project queries, pagination and tracker-native workflow states.
- **C4 before code** — rows #1003. Bring the two-way compatibility and negative-case note to the coordinator.
- Refresh against the carried landing delta. Main overlapping claims — K1 (`docs/user/source-control.md`), K2 (`docs/user/source-control.md`). The summary lists all carried waits.
- Oversized single row. Stage the steps in this lane under the one row owner; keep feature exposure gated through the combined checks.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 1003 | adffb3623fa | adapt | **C4** | Requires `20501a02213`. The existing host drivers have no issue API; upstream adds CLI-backed trackers/decoders and Azure project-level scope. Bring over on Issues approval with native workflow states from 49fad98aecb and explicit capability gaps for GOAT's other providers. |

### U83

**Delegated work, wake ownership and ordering (2/2)** · W14 · server-only · 479 estimated handwritten changed lines

- Keep GOAT explicit reports, bounded keyed work and restart holds. Monitor progress and terminal wake settlement have different scope. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — delegated-tasks, orchestrator-goat-modules, decision-routing, remote-reports.
- Replay duplicate/late child reports, old unstamped tasks, failed preceding runs and independent busy coordinators.
- Refresh against the carried landing delta. Main overlapping claims — K6 (`apps/server/src/orchestration-v2/Orchestrator.ts`), K1 (`apps/server/src/orchestration-v2/Orchestrator.ts`), K7 (`apps/server/src/orchestration-v2/Orchestrator.ts`), K6b (`apps/server/src/orchestration-v2/Orchestrator.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 985 | a5c28da6c8b | take | C3 | Requires `931cd3afab3`, `52451a7909c`. The report selector excludes a run for any Monitor message (subagentProjection.ts:280). Narrow the exclusion to updated notifications and land together with 0df1967cfa6, which replaces that predicate with a shared helper. |
| 1021 | 0df1967cfa6 | adapt | C3 | Requires `a5c28da6c8b`. Reporting only the terminal run (Orchestrator.ts:11753; OrchestratorMcpService.ts:1409) loses prior child output when the last run is blank. Read bounded eligible runs, keep the stop notice and explicit remote/child result precedence, and retain the narrow Monitor exclusion. |
| 1057 | 33542a53be7 | adapt | C1 | Requires `e05b087a34b`. GOAT tries a stored read first at Orchestrator.ts:839 even when the pending batch creates the child (:844). Build from the staged creation event first, while preserving prior-row reads and actual read error reporting. |
| 1064 | 25fada9351c | adapt | C3 | The delegated phase refresh accepts starting but excludes waiting (Orchestrator.ts:13067). Add waiting to the local transition while avoiding a second question wake and preserving GOAT remote reporting and parent-decision routing. |

### U84

**Document, archive and HTML previews** · W14 · mac · 1,209 estimated handwritten changed lines

- Reuse the Office/archive split, PDF.js and scoped GOAT asset/preview ownership. Keep limits and preserve literal formatting. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — office-archive-split, pdf-viewer, resizable-width.
- Exercise malformed archives, links to oversized TAR payloads, document text fixtures and missing media permission.
- **C4 before code** — rows #205, #1019, #1032. Bring the two-way compatibility and negative-case note to the coordinator.
- Refresh against the carried landing delta. Main overlapping claims — K8 (`apps/server/src/assets/AssetAccess.ts`), K4 (`pnpm-lock.yaml`), SF2 (`apps/server/src/assets/AssetAccess.ts`), SF2b (`apps/server/src/assets/AssetAccess.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 75 | 31d9b3bcd60 | adapt | C1 | GOAT moved this component and only passes a revision to URL minting for PDF (WorkspaceBrowserPreview.tsx:32–45). Re-mint HTML URLs after inode-changing edits and advance the frame key on the new URL while preserving PDF.js behavior. |
| 160 | 4574c6013d5 | adapt | C1 | The notebook path joins traceback entries as generic text (extendedDocumentPreview.ts:453). Insert breaks between saved IPython frames and take revised ANSI handling from 0fdc99c8705 and dde53b11f31. |
| 161 | d6244ac5a33 | adapt | C1 | The shared EPUB/ODS text accessor decodes every node (extendedDocumentPreview.ts:115). Keep CDATA literal, decode regular text once and carry the later declaration-handling correction 6ec1d31b1eb. |
| 205 | 6effe74c595 | adapt | **C4** | `apps/web/src/components/files/extendedDocumentPreview.ts:284` renders one element per ODT row or cell. Apply ODF repeat counts under GOAT's output budget and use the existing fixture harness in place of the upstream scenario dependency. |
| 219 | 13a6782a6c4 | adapt | C1 | Add the ODF time-value fallback alongside the date and numeric fallbacks at `apps/web/src/components/files/extendedDocumentPreview.ts:320`. Move the fixture assertion into GOAT's preview tests. |
| 220 | 0fdc99c8705 | adapt | C2 | Requires `4574c6013d5`. `apps/web/src/components/files/extendedDocumentPreview.ts:419` already has a bounded notebook reader with frame handling. Strip terminal styling with the shared helper before checking frame newlines and use the GOAT preview test entry point. |
| 251 | 3d9aeaf7570 | take | C3 | `apps/web/src/components/files/largeText.worker.ts:15` and `packages/shared/src/delimitedPreview.ts:15` only handle comma and tab. Detect a consistent semicolon dialect outside quotes once from a bounded prefix and reuse it throughout the streamed preview. |
| 264 | 10a44f5553a | adapt | C1 | `apps/web/src/components/files/extendedDocumentPreview.ts:563` handles only the nonbreaking-space control symbol. Use the expanded RTF character map for named whitespace, punctuation, and joiners in the existing bounded parser. |
| 297 | 8b633d9a9e5 | adapt | C1 | GOAT uses its own PDF.js text-layer matcher, whose query regex and page matching live at pdf/pdfSearch.ts:35–70. Fold straight and curly quotes in both inputs with a length-preserving substitution so the highlight offsets still point to the original text. |
| 309 | 776698a3e7e | adapt | C1 | extendedDocumentPreview.ts:24 maps drawing but lacks the presentation namespace, and line 264 skips annotations without skipping speaker notes. Register the namespace and suppress presentation:notes in GOAT's split office-preview implementation. |
| 392 | 85e009fbc99 | take | C2 | The TAR reader only copies regular files at binaryPreview.worker.ts:133. The clean patch resolves hard links to earlier archive members, including PAX and GNU names, and shares their bytes. |
| 402 | d38055656e0 | adapt | C2 | Requires `85e009fbc99`. binaryPreview.worker.ts:133 copies regular TAR payloads before enforcing the extraction cap. Store only the byte length above the cap, including when a hard link points at that member. |
| 563 | 8ab40cc88e1 | adapt | C1 | GOAT's PDF.js toolbar supplies the page-count label at PdfToolbar.tsx:105. Use singular at one in both the displayed count and the accessible label as applicable. |
| 565 | 2370e338f73 | take | C2 | BinaryViewer.tsx:212 and :230 and NotebookPreview.tsx:101 append plural labels regardless of count. Keep GOAT formatting and choose singular for one entry, row, column or cell. |
| 566 | dde53b11f31 | adapt | C2 | terminalOutput.ts:893 strips legacy SGR but leaves colon-form parameters in notebook errors. Cover colon-form SGR through GOAT's current preview test surface and preserve shared terminal text behavior. |
| 653 | 7b9af5f2222 | take | C1 | The worker's ignored elements at documentTextWorker.ts:15 omit XHTML head. Suppress that subtree so chapter titles and metadata do not leak into the extracted chapter body. |
| 689 | 71adeef080d | adapt | C2 | MarkdownFileLink.logic.ts:63 forces PDFs to the browser while GOAT ships its own PDF preview. Route PDFs into the existing panel when available and preserve remote/editor fallback. |
| 698 | 3a1dfb7acb6 | adapt | C1 | BrowserDocumentFrame.tsx:136 hard-codes white for local HTML documents in dark mode. Use GOAT's active preview canvas and coordinate with 5b91a5a00e0, which later also prevents white reload flashes. |
| 1019 | 5b91a5a00e0 | adapt | **C4** | Requires `3947e223515`, `3a1dfb7acb6`, `b4744496f8a`. The revision key currently remounts the only frame (BrowserDocumentFrame.tsx:125). Keep the loaded frame until its sandboxed replacement restores scroll, verify message sources, and preserve GOAT PDF rendering and signed asset path checks; coordinate later scroll/history fix 70e4319da82. |
| 1032 | 6ec1d31b1eb | adapt | **C4** | parseXml globally strips/checks declaration-like text (:32–36). Preserve literals in comments, processing instructions and CDATA, still reject actual unsafe declarations and malformed attributes, and keep the chapter title fallback. |

### U85

**Issues • thread links and MCP** · W15 · mac · 2,059 estimated handwritten changed lines

- Keep server-owned provenance and register goat_* tools in the GOAT registry. Preserve existing PR paths and remote authority. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — contracts-rpc-leaves, mcp-names, mcp-registration-context, settings-page.
- Test exact run/thread attribution, authorized links and stale or unsupported destination refusal.
- **C4 before code** — rows #1004. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (2 source paths) — `packages/contracts/src/orchestrationV2.ts`, `packages/contracts/src/issue.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K6 (`apps/server/src/orchestration-v2/Orchestrator.ts`), K1 (`apps/server/src/orchestration-v2/Orchestrator.ts`), K12 (`apps/server/src/orchestration-v2/ProjectionStore.ts`), K7 (`apps/server/src/orchestration-v2/Orchestrator.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 1004 | 0597b9edcdb | adapt | **C4** | **Contracts.** Requires `20501a02213`, `85dcfa61cab`, `adffb3623fa`. Conditional on Issues approval: port issue links, provenance/settlement, and scoped issue tools into GOAT-owned orchestration modules and the agent-surface registry. Preserve GOAT registration-context and remote-authorization behavior (010_fork_delta.md:167,240). |

### U86

**LegendList measurement backports** · W15 · mac · 160 estimated handwritten changed lines

- Review #899 and #922 together on GOAT’s patched 3.3.5 pin. Keep only the still-missing measurement behavior from the two upstream patches.
- Verify finite native dimensions and deferred shrink under a scaled ancestor using the web and mobile package builds.
- Refresh against the carried landing delta. Main overlapping claims — K12 (`apps/mobile/src/features/threads/ThreadFeed.tsx`), K4 (`pnpm-lock.yaml`), M3b (`apps/mobile/src/features/threads/ThreadFeed.tsx`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 899 | 375343aaf35 | adapt | C3 | Backport non-finite measurement handling to GOAT’s current LegendList pin. The exact patch targets upstream LegendList 3.7.2, while GOAT uses 3.3.5 (pnpm-workspace.yaml:400); upstream drops the patch in its 3.7.3 update. Keep the non-finite native-measurement regression with the dependency lane and verify the selected package or backport needs no standalone 3.7.2 patch. [recheck: adapt, see /tmp/chase1118/triage-recheck.md] |
| 922 | 991c62d0d7c | adapt | C3 | Backport the missing deferred-shrink measurement branch for both GOAT package builds. Requires `375343aaf35`. The patch adds layout-box measurements to upstream LegendList 3.7.2 and is dropped in 3.7.3. Bring the scaled-ancestor regression to the GOAT LegendList upgrade/backport lane instead of shipping the old-version patch. [recheck: adapt, see /tmp/chase1118/triage-recheck.md] |

### U87

**Issues • Linear adapter and binding** · W16 · mac · 3,010 estimated handwritten changed lines

- Require #1005 plus the core, web and link prerequisites. Renumber the proposed 097 centrally. Stage tenant-safe adapter, binding, credential boundary and UI within this row. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — contracts-rpc-leaves, mcp-names, mcp-registration-context, settings-page.
- Verify canonical workspace links, existing clients without capabilities, migration and revoked/wrong-tenant credentials. Check the vendored SDL separately and regenerate TypeScript.
- **C4 before code** — rows #1005. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (3 source paths) — `packages/contracts/src/issue.ts`, `packages/contracts/src/rpc.ts`, `packages/contracts/src/clientRpcPermissions.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K3 (`apps/server/src/ws.ts`), K7b (`apps/server/src/server.ts`), K8 (`apps/server/src/server.ts`), K9 (`apps/server/src/ws.ts`). The summary lists all carried waits.
- Oversized single row. Stage the steps in this lane under the one row owner; keep feature exposure gated through the combined checks.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 1005 | 86863beedef | decide · pending d1 | **C4** | d1 recommendation — port Linear after Issues core and renumber its migration. Upstream migration 097 collides with ProjectionTurnItemRequestIndex. **Contracts.** Requires `20501a02213`, `85dcfa61cab`, `0597b9edcdb`. Should GOAT add Linear as a standalone tracker with credentials and per-project binding persistence? Upstream 097 collides with GOAT's ProjectionTurnItemRequestIndex (Migrations.ts:278); regenerate TypeScript from the vendored Linear SDK SDL and LinearApi.graphql using graphqlgen. |

### U88

**Issues • mobile shell** · W17 · mac · 4,014 estimated handwritten changed lines

- Use actual GOAT workspace/stack routes, native module identities and sheet/header model. Keep PR behavior intact and omit Linear binding paths when declined. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — contracts-rpc-leaves, mcp-names, mcp-registration-context, settings-page.
- Exercise cold launch, link navigation, back and capability gating on both native navigators and device idioms.
- Refresh against the carried landing delta. Main overlapping claims — M3b (`apps/mobile/src/features/threads/ThreadDetailScreen.tsx`), K2 (`apps/mobile/src/features/pull-requests/PullRequestRouteScreen.tsx`). The summary lists all carried waits.
- Oversized single row. Stage the steps in this lane under the one row owner; keep feature exposure gated through the combined checks.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 1006 | 6ad58a84857 | adapt | C3 | Requires `85dcfa61cab`, `0597b9edcdb`, `86863beedef`. Conditional on Issues approval: implement capability-gated list/detail/edit and shared state. Upstream couples a composer extraction and native tab/icons with the new surface; fit GOAT rail and sheet ownership, existing mobile/desktop naming, and both native nav implementations. |

### U89

**Usage, quota and device coverage (2/2)** · W17 · mac · 749 estimated handwritten changed lines

- Preserve provider-specific cache/history identity, resumed accounting and Windows/WSL deduplication. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — cli-home, server-activity.
- Verify old-cache replay and moved/deleted logs. Use chart accessibility checks and Android widget device coverage where applicable.
- **C4 before code** — rows #1025. Bring the two-way compatibility and negative-case note to the coordinator.
- Refresh against the carried landing delta. Main overlapping claims — K4 (`pnpm-lock.yaml`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 1025 | e30a27bd207 | adapt | **C4** | The current Android widget slices rows by count (SubscriptionUsage.android.tsx:55–59). Keep responsive window/account selection and distinguish expired readings using GOAT's widget design, existing native resource names, and its actual Expo patch version. |
| 1074 | e9b48b78099 | take | C1 | The usage-home lookup passes bare `makeMuseEnvironment` at line 140. Apply the existing noninstalling provider-probe environment wrapper and its regression assertion. |
| 1137 | 724f5c6bec1 | adapt | C2 | The refresh at line 151 onward replaces each snapshot even on a refused read. Retain the most recent reading only for the same endpoint and account identity, preserving refusal metadata and never reusing pre-redemption data after an attempted refresh. |

### U90

**SQLite ledger, indexes and projection reads (2/2)** · W17 · server-only · 120 estimated handwritten changed lines

- Use the GOAT ledger and preview reconciliation before preflight. Preserve the existing 090–157 GOAT names and allocate any competing SF4 ID centrally. For #374 keep the Node pin and take only JSON subtype handling. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — server-activity, migration-ID section.
- Cover fresh, migrated, preview, stale/displaced and interrupted ledgers. Verify dirty JSON, index predicates and query plans on disposable databases.
- **C4 before code** — rows #1033. Bring the two-way compatibility and negative-case note to the coordinator.
- Refresh against the carried landing delta. Main overlapping claims — K12 (`apps/server/src/orchestration-v2/ProjectionStore.ts`), K6 (`apps/server/src/orchestration-v2/ProjectionStore.ts`), N10 (`apps/server/src/persistence/Migrations.ts`), SF2 (`apps/server/src/orchestration-v2/ProjectionStore.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 1033 | 980f5d41286 | adapt | **C4** | Retarget the older upstream index concept to GOAT’s active shell selector. Upstream migration 098 collides with Memory. Requires `570640b1605`. GOAT reads through selectShellThreadRows (ProjectionStore.ts:7143), and lacks upstream listActiveShellIndex. Port the indexed read to GOAT's selector with matching predicates, including its shell filters and invalid-JSON handling; upstream 098 is GOAT Memory (Migrations.ts:279). |

### U91

**Issues • filters and sorting** · W18 · mac · 3,009 estimated handwritten changed lines

- Keep filters and scope metadata usable on empty or host-narrowed pages. Stage typed inputs, tracker queries and client flows inside this row. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — contracts-rpc-leaves, mcp-names, mcp-registration-context, settings-page.
- Test pagination, label/assignee changes, host switching during a request and older servers without optional metadata.
- **C4 before code** — rows #1007. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (1 source paths) — `packages/contracts/src/issue.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K2 (`apps/mobile/src/native/useOpenPullRequest.ts`), M3b (`apps/mobile/src/Stack.tsx`). The summary lists all carried waits.
- Oversized single row. Stage the steps in this lane under the one row owner; keep feature exposure gated through the combined checks.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 1007 | 60f7e5d9b17 | adapt | **C4** | **Contracts.** Requires `adffb3623fa`, `0597b9edcdb`, `86863beedef`, `6ad58a84857`. Conditional on Issues approval: port typed label, assignee and sort inputs and host-specific pagination through both clients and agent tools. Carry scope metadata fixes b78914e4f3d and 218c18bc028 with it so empty/host-narrowed results keep usable filters. |

### U92

**Issues • tracker states, settings and follow-up reads (1/2)** · W19 · mac · 2,465 estimated handwritten changed lines

- Use tracker-native per-issue states before exposing writes. Keep preference keys distinct from PR views and maintain tracker-neutral improvements if Linear is declined. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — contracts-rpc-leaves, mcp-names, mcp-registration-context, settings-page.
- Test allowed states, scoped metadata, empty lists, canonical links and provider-specific pagination.
- **C4 before code** — rows #1009. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (1 source paths) — `packages/contracts/src/issue.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K2 (`docs/user/source-control.md`), K1 (`docs/user/source-control.md`), K12 (`apps/server/src/provider/agentContextBudget.json`), K8 (`apps/mobile/src/features/settings/SettingsServerControlsRouteScreen.tsx`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 1008 | 652e2f2ab59 | adapt | C3 | Requires `86863beedef`. The GOAT mobile stack already has a source-control route (Stack.tsx:298). Extend its scoped settings and provider capability checks for issues after approval; preserve GOAT's extra hosts and mobile sheet/navigation design. |
| 1009 | 49fad98aecb | adapt | **C4** | Apply final state shape while Issues is gated, before exposing reads/writes to other clients. **Contracts.** Requires `adffb3623fa`, `0597b9edcdb`, `86863beedef`, `6ad58a84857`, `60f7e5d9b17`. If Issues lands, use the final per-issue states contract from the outset. Upstream replaces tracker-wide close reasons with actual workflow names from Linear and Azure and explicit options for GitHub/GitLab/Forgejo; keep write authorization and change-state validation. |
| 1027 | bb29ee3e71b | adapt | C3 | Requires `2d265dc410c`, `60f7e5d9b17`. If Issues lands, share saved-view identity/validation and menu behavior between PR and Issues while keeping their distinct preference keys and decoders. This supersedes the PR-only component/module names from 2d265dc410c. |

### U93

**Issues • tracker states, settings and follow-up reads (2/2)** · W20 · mac · 798 estimated handwritten changed lines

- Use tracker-native per-issue states before exposing writes. Keep preference keys distinct from PR views and maintain tracker-neutral improvements if Linear is declined. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — contracts-rpc-leaves, mcp-names, mcp-registration-context, settings-page.
- Test allowed states, scoped metadata, empty lists, canonical links and provider-specific pagination.
- **C4 before code** — rows #1037. Bring the two-way compatibility and negative-case note to the coordinator. Contract footprint (1 source paths) — `packages/contracts/src/issue.ts`.
- Refresh against the carried landing delta. Main overlapping claims — K2 (`packages/source-control-core/src/server/PullRequestProvider.ts`), K7b (`apps/server/src/server.ts`), K8 (`apps/server/src/server.ts`), N10 (`apps/server/src/server.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 1037 | b78914e4f3d | adapt | **C4** | **Contracts.** Requires `86863beedef`, `60f7e5d9b17`. If Issues lands, make filter scopes come from queried tracker bindings even for an empty result. Keep an optional wire field and entry-derived compatibility for older servers; combine with 218c18bc028. |
| 1039 | 16548ab8a4a | adapt | C2 | Requires `adffb3623fa`, `60f7e5d9b17`, `49fad98aecb`. Conditional on Azure Issues: use workitemsbatch POST to load WIQL IDs and preserve chunking and ordering. Carry the later Azure metadata/account fixes fd7d2aec5e4, 25875c11b22, and 2216ffe0068 in the final tracker. |
| 1048 | d35ec21cdd0 | adapt | C3 | Requires `0597b9edcdb`, `86863beedef`. If Linear ships, resolve canonical links against the authorized workspace binding, including when an issue has moved teams. Include the follow-up single-read fix b8b5affac42 and keep host/auth checks. |
| 1058 | 218c18bc028 | adapt | C3 | Requires `60f7e5d9b17`, `b78914e4f3d`. Conditional on issue filters: return tracker inventory for the selected project independent of host narrowing, constrain fetched/displayed scopes, and keep a selected host recoverable. Carry invalid-host and duplicate-environment follow-ups 983654b3b2f and b4dfd75624f. |
| 1062 | d3c91008059 | adapt | C2 | Requires `adffb3623fa`, `60f7e5d9b17`, `49fad98aecb`. Conditional on GitLab Issues: fetch paginated system notes separately from comments, honoring next-page metadata, page caps, dedupe and follow-up GitLab read fixes in ef577280591. |
| 1084 | 983654b3b2f | adapt | C2 | Recheck found a shipped PR route overlay bug. Preserve the independent PR sanitizer even if Issue normalizer support is deferred. Requires `85dcfa61cab`. The Issues route and its search normalizer are absent from both refs. If added, normalize own keys to undefined so malformed host and selection values cannot survive the router's parent-search overlay. [recheck: adapt, see /tmp/chase1118/triage-recheck.md] |
| 1105 | a774d7f473e | adapt | C3 | Recheck found an independent Enterprise identity refiner. Apply the C4 credential/host gate despite the C3 table label and preserve ambient-credential refusal. Gate only Issue-linked behavior on #1001. Requires `20501a02213`, `85dcfa61cab`. GOAT has PR-link resolution and lightweight GitHub issue-subject enrichment (`GitHubSourceControlProvider.ts:907)), while both refs lack the IssueService and client issue resolver. If issue tracking lands, use project/authority and authenticated provider evidence to claim custom Enterprise hosts without globally assuming /issues URLs are GitHub. [recheck: adapt, see /tmp/chase1118/triage-recheck.md] |

### U94

**Whole-app localization** · W21 · mac · 67,026 estimated handwritten changed lines

- Start with the accepted extraction preflight. Stage web, mobile and desktop GOAT source in this one row, then regenerate with GOAT copy, module names, GT configuration and lint namespace. Fork-delta entries in `devlog/_chase/010_fork_delta.md` — goat-copy, brand, desktop-identity, settings-page, ci.
- Review placeholders, key stability, plural/locale fallback and accessible labels. Cover representative web, desktop, iOS and Android paths on the final receiving head.
- **C4 before code** — rows #1138. Bring the two-way compatibility and negative-case note to the coordinator.
- Refresh against the carried landing delta. Main overlapping claims — K2 (`apps/web/src/components/ChatView.tsx`), K8 (`apps/web/src/components/ChatView.tsx`), K7 (`apps/web/src/components/ChatMarkdown.tsx`), K7b (`packages/client-runtime/src/state/server.ts`). The summary lists all carried waits.

| n | sha | verdict | class | note |
|---:|---|---|---|---|
| 1138 | 055b44919ee | decide · pending d1 | **C4** | d1 recommendation — port staged whole-app localization last. Large single-row exception. Break implementation and review into surface commits within this lane. Requires `b823ddadd9c`. Upstream wraps source copy and generates hashed locale catalogs with desktop tooling and lint checks, extending infrastructure that GOAT already uses on a small scale (`apps/web/package.json:11`, `apps/mobile/src/i18n/translations/en.json:1`). Should GOAT adopt full-surface localization in staged ports using GOAT copy and regenerate catalogs from GOAT source? |

## Out-of-range prerequisites

Git evidence at 2c0e0002a99: each named SHA below resolves and is an ancestor of 93cbca3fcbd. None of the exact upstream objects is a GOAT integration ancestor. History was checked using git log with SHA trailers, subjects and named paths, then the relevant GOAT entry points were inspected. The difference between exact credit and functional coverage matters for the owner decision. Rows with present/skip verdicts have no new implementation owner.

| Consumer | Pre-range SHA | Owner | Disposition at the pin |
|---|---|---|---|
| #417 | b3fdf2b10fb, 3a0bcba00a2 | K2 → U15 | PR review/comment anchor and GitLab file/line link foundations. K2’s record §1–2 names these two ports and the conflict surfaces. Verify the actual K2 landing and old-schema behavior before the new follow-up. |
| #435 | 0f28f6f6a00 | U54 | Exact upstream port absent. GOAT already has side-chat dispatch and #3005 plus the M3 /side answer path (acbfc2063d1, c2951f29802). Adapt the Send/busy classification to GOAT instead of reopening the older upstream patch. |
| #1029 | 07242abff3c | U02 | GOAT already supplies a partial substitute in apps/server/src/orchestration-v2/goat/ProviderTurnHandoffRecovery.ts:205. Recover only unsent image eligibility and carry the retry tests through the Claude fallback. |
| #1033 | 8bf4822f5eb | U90 | Upstream listActiveShellIndex absent. GOAT selectShellThreadRows at apps/server/src/orchestration-v2/ProjectionStore.ts:7143 is the active boundary. Preserve its scope and add index predicates there. |
| #403 (skip) | b8dce832149 | — | Upstream transcription post-processing baseline absent; GOAT batch/local wrapper differs. Keep this row skipped. #898 assesses live transcription independently. |
| #477 (skip) | 35c1210331a | — | Guest history paging baseline absent from the GOAT event contract. No implementation row. |
| #982 (skip) | b3fdf2b10fb | — | K2 owns the PR anchor foundation. The skipped ConversationCard styling has no new lane action. |
| #987 (present) | 6dad2adc720 | — | CLI has equivalent command resolution and regular-file/executable checks in DesktopCliCommand and cli/invocation. |
| #999 (skip) | 76d0fff5fd0 | — | K4 owns the symlink baseline (GOAT 7055191b69d); this upstream IgnorePatterns-specific row stays skipped. |
| #1023 (skip) | ae142932d07 | — | Upstream scenario harness absent; GOAT retains its own browser/mobile fixtures. |
| #1055 (skip) | 587deab7d31 | — | K8 owns a decision and port for keep-awake. This WSL helper follow-up stays skipped. |

K7b’s separately recorded pre-range prerequisites stay with K7b — dc3fdc6a3e descriptor/socket-open, 9557ab46c5 cached-shell resume with GOAT instance guard, and 2917f28465’s deferred on-demand provider catalog half. K7b follows K7 and supplies its own two-way behavior and authorization evidence. No new-range row is assigned to a carried lane.

## Shared hot-file index

Each path is listed once with its lane writer order. Paths are rename-normalized. A few upstream-only paths remain as conservative conflict reservations until their GOAT mapping is confirmed. Shared generated paths still serialize their writers, even when excluded from the size estimate.

| File | Ordered writers |
|---|---|
| `.github/workflows/ci.yml` | U75 (W12), U87 (W16) |
| `.github/workflows/goat-ci.yml` | U75 (W12), U87 (W16) |
| `apps/desktop/src/app/CodexAuthCallback.test.ts` | U22 (W04), U68 (W11) |
| `apps/desktop/src/app/DesktopApp.test.ts` | U01 (W01), U14 (W02) |
| `apps/desktop/src/app/DesktopApp.ts` | U01 (W01), U14 (W02), U94 (W21) |
| `apps/desktop/src/app/DesktopStartupRecovery.ts` | U01 (W01), U14 (W02), U94 (W21) |
| `apps/desktop/src/backend/DesktopBackendConfiguration.test.ts` | U01 (W01), U51 (W08) |
| `apps/desktop/src/backend/DesktopBackendConfiguration.ts` | U01 (W01), U51 (W08) |
| `apps/desktop/src/backend/DesktopBackendPool.ts` | U01 (W01), U94 (W21) |
| `apps/desktop/src/ipc/DesktopIpcHandlers.ts` | U10 (W02), U34 (W05) |
| `apps/desktop/src/ipc/channels.ts` | U10 (W02), U16 (W03), U34 (W05) |
| `apps/desktop/src/ipc/methods/window.ts` | U10 (W02), U34 (W05), U94 (W21) |
| `apps/desktop/src/main.ts` | U01 (W01), U41 (W06) |
| `apps/desktop/src/preload.ts` | U10 (W02), U16 (W03), U34 (W05) |
| `apps/desktop/src/preview/DesktopBrowserHost.test.ts` | U08 (W02), U16 (W03) |
| `apps/desktop/src/preview/DesktopBrowserHost.ts` | U08 (W02), U16 (W03) |
| `apps/desktop/src/preview/Manager.test.ts` | U08 (W02), U16 (W03) |
| `apps/desktop/src/preview/Manager.ts` | U08 (W02), U16 (W03), U94 (W21) |
| `apps/desktop/src/shell/DesktopShellEnvironment.test.ts` | U22 (W04), U29 (W05) |
| `apps/desktop/src/shell/DesktopShellEnvironment.ts` | U22 (W04), U29 (W05), U41 (W06), U53 (W08) |
| `apps/desktop/src/updates/DesktopRemoteUpdates.test.ts` | U01 (W01), U14 (W02) |
| `apps/desktop/src/updates/DesktopUpdates.test.ts` | U01 (W01), U14 (W02) |
| `apps/desktop/src/updates/DesktopUpdates.ts` | U01 (W01), U14 (W02) |
| `apps/desktop/src/window/DesktopApplicationMenu.ts` | U01 (W01), U94 (W21) |
| `apps/desktop/src/window/DesktopWindow.test.ts` | U01 (W01), U08 (W02), U55 (W09) |
| `apps/desktop/src/window/DesktopWindow.ts` | U01 (W01), U08 (W02), U55 (W09), U94 (W21) |
| `apps/desktop/src/wsl/DesktopWslEnvironment.test.ts` | U01 (W01), U10 (W02) |
| `apps/desktop/src/wsl/DesktopWslEnvironment.ts` | U01 (W01), U10 (W02) |
| `apps/mobile/deps/react-native-screens-5.0.0-t3.57.tgz` | U09 (W02), U36 (W06) |
| `apps/mobile/deps/react-native-screens-5.0.0-t3.58.tgz` | U09 (W02), U36 (W06) |
| `apps/mobile/modules/goat-native-controls/ios/GoatScrollEdgeBleedView.swift` | U06 (W01), U09 (W02) |
| `apps/mobile/modules/goat-native-controls/ios/GoatSidebarTabBarView.swift` | U06 (W01), U09 (W02) |
| `apps/mobile/modules/t3-native-controls/ios/T3SidebarTabBarView.swift` | U09 (W02), U88 (W17) |
| `apps/mobile/package.json` | U09 (W02), U36 (W06), U94 (W21) |
| `apps/mobile/src/Stack.tsx` | U87 (W16), U88 (W17), U91 (W18), U92 (W19), U94 (W21) |
| `apps/mobile/src/components/ComposerAttachmentStrip.tsx` | U36 (W06), U43 (W07), U94 (W21) |
| `apps/mobile/src/components/ComposerEditor.tsx` | U43 (W07), U94 (W21) |
| `apps/mobile/src/components/MediaVideoPlayer.tsx` | U73 (W12), U94 (W21) |
| `apps/mobile/src/components/ProjectFavicon.tsx` | U09 (W02), U94 (W21) |
| `apps/mobile/src/components/ui/AppSymbol.android.tsx` | U36 (W06), U65 (W10), U88 (W17) |
| `apps/mobile/src/components/ui/AppSymbol.tsx` | U36 (W06), U88 (W17) |
| `apps/mobile/src/components/ui/Dialog.android.tsx` | U09 (W02), U94 (W21) |
| `apps/mobile/src/components/ui/FilePreviewModal.tsx` | U06 (W01), U94 (W21) |
| `apps/mobile/src/components/ui/FilePreviewSession.tsx` | U06 (W01), U94 (W21) |
| `apps/mobile/src/components/ui/VideoPreviewModal.android.tsx` | U73 (W12), U94 (W21) |
| `apps/mobile/src/connection/platform.ts` | U43 (W07), U94 (W21) |
| `apps/mobile/src/features/cloud/ConnectOnboardingRouteScreen.tsx` | U09 (W02), U94 (W21) |
| `apps/mobile/src/features/connection/ConnectionsNewRouteScreen.tsx` | U09 (W02), U22 (W04), U94 (W21) |
| `apps/mobile/src/features/connection/useConnectionController.ts` | U36 (W06), U94 (W21) |
| `apps/mobile/src/features/diagnostics/SettingsDiagnosticsRouteScreen.tsx` | U09 (W02), U94 (W21) |
| `apps/mobile/src/features/diffs/nativeReviewDiffSource.ts` | U15 (W03), U30 (W05) |
| `apps/mobile/src/features/diffs/nativeReviewDiffSurface.test.tsx` | U15 (W03), U69 (W11) |
| `apps/mobile/src/features/diffs/nativeReviewDiffSurface.ts` | U15 (W03), U94 (W21) |
| `apps/mobile/src/features/files/WorkspaceFilePreviewError.tsx` | U36 (W06), U94 (W21) |
| `apps/mobile/src/features/files/ZipArchiveView.tsx` | U54 (W09), U94 (W21) |
| `apps/mobile/src/features/home/HomeRouteScreen.tsx` | U09 (W02), U22 (W04), U94 (W21) |
| `apps/mobile/src/features/home/HomeScreen.tsx` | U09 (W02), U31 (W05), U63 (W10), U94 (W21) |
| `apps/mobile/src/features/home/ThreadUndoNotice.tsx` | U09 (W02), U94 (W21) |
| `apps/mobile/src/features/home/home-list-filter-menu.ts` | U22 (W04), U94 (W21) |
| `apps/mobile/src/features/home/thread-swipe-actions.tsx` | U09 (W02), U94 (W21) |
| `apps/mobile/src/features/home/useThreadListActions.test.ts` | U09 (W02), U43 (W07) |
| `apps/mobile/src/features/home/useThreadListActions.ts` | U09 (W02), U43 (W07), U66 (W11), U94 (W21) |
| `apps/mobile/src/features/issues/IssueAssigneesScreen.tsx` | U88 (W17), U91 (W18), U94 (W21) |
| `apps/mobile/src/features/issues/IssueCandidatesSheet.tsx` | U88 (W17), U91 (W18), U94 (W21) |
| `apps/mobile/src/features/issues/IssueCommentComposer.tsx` | U88 (W17), U94 (W21) |
| `apps/mobile/src/features/issues/IssueEditScreen.tsx` | U88 (W17), U91 (W18), U94 (W21) |
| `apps/mobile/src/features/issues/IssueFilterSearchScreen.tsx` | U88 (W17), U91 (W18), U94 (W21) |
| `apps/mobile/src/features/issues/IssueLabelsScreen.tsx` | U88 (W17), U91 (W18), U94 (W21) |
| `apps/mobile/src/features/issues/IssueListRow.tsx` | U88 (W17), U94 (W21) |
| `apps/mobile/src/features/issues/IssueRouteScreen.tsx` | U88 (W17), U91 (W18), U92 (W19), U94 (W21) |
| `apps/mobile/src/features/issues/IssuesScreen.tsx` | U88 (W17), U91 (W18), U92 (W19), U94 (W21) |
| `apps/mobile/src/features/issues/issueListFilters.test.ts` | U88 (W17), U91 (W18) |
| `apps/mobile/src/features/issues/issueListFilters.ts` | U88 (W17), U91 (W18) |
| `apps/mobile/src/features/issues/issuePresentation.tsx` | U88 (W17), U92 (W19), U94 (W21) |
| `apps/mobile/src/features/issues/issueSavedViews.ts` | U88 (W17), U92 (W19) |
| `apps/mobile/src/features/keyboard/CommandPalette.tsx` | U25 (W04), U31 (W05), U94 (W21) |
| `apps/mobile/src/features/layout/WorkspaceEmptyDetail.tsx` | U88 (W17), U94 (W21) |
| `apps/mobile/src/features/layout/createWorkspaceStackNavigator.ios.tsx` | U09 (W02), U88 (W17), U94 (W21) |
| `apps/mobile/src/features/layout/workspace/ListSearchToolbar.android.tsx` | U88 (W17), U94 (W21) |
| `apps/mobile/src/features/layout/workspace/SavedViewsMenu.tsx` | U50 (W08), U92 (W19), U94 (W21) |
| `apps/mobile/src/features/layout/workspace/SharedSlotTitle.tsx` | U88 (W17), U94 (W21) |
| `apps/mobile/src/features/layout/workspace/WorkspaceNativeTabs.ios.tsx` | U09 (W02), U88 (W17), U94 (W21) |
| `apps/mobile/src/features/layout/workspace/WorkspaceRootScreen.android.tsx` | U88 (W17), U94 (W21) |
| `apps/mobile/src/features/layout/workspace/WorkspaceRootScreen.tsx` | U09 (W02), U88 (W17), U94 (W21) |
| `apps/mobile/src/features/layout/workspace/WorkspaceSectionToolbar.tsx` | U88 (W17), U94 (W21) |
| `apps/mobile/src/features/layout/workspace/WorkspaceToolbar.tsx` | U88 (W17), U94 (W21) |
| `apps/mobile/src/features/layout/workspace/navigation-tab-order.ts` | U88 (W17), U94 (W21) |
| `apps/mobile/src/features/layout/workspace/navigation-tabs.ts` | U88 (W17), U94 (W21) |
| `apps/mobile/src/features/layout/workspace/useWorkspaceCompose.ts` | U88 (W17), U94 (W21) |
| `apps/mobile/src/features/layout/workspace/workspace-selection-store.ts` | U09 (W02), U88 (W17) |
| `apps/mobile/src/features/layout/workspace/workspace-tab-navigation.test.ts` | U09 (W02), U88 (W17) |
| `apps/mobile/src/features/layout/workspace/workspace-tab-navigation.ts` | U09 (W02), U88 (W17) |
| `apps/mobile/src/features/layout/workspace/workspace-tabs-state.test.ts` | U50 (W08), U88 (W17) |
| `apps/mobile/src/features/layout/workspace/workspace-tabs-state.ts` | U50 (W08), U88 (W17) |
| `apps/mobile/src/features/pull-requests/PullRequestDescription.tsx` | U88 (W17), U94 (W21) |
| `apps/mobile/src/features/pull-requests/PullRequestDiscussionScreen.tsx` | U30 (W05), U94 (W21) |
| `apps/mobile/src/features/pull-requests/PullRequestLabelsScreen.tsx` | U69 (W11), U94 (W21) |
| `apps/mobile/src/features/pull-requests/PullRequestListFilters.tsx` | U15 (W03), U50 (W08), U94 (W21) |
| `apps/mobile/src/features/pull-requests/PullRequestListRow.tsx` | U88 (W17), U94 (W21) |
| `apps/mobile/src/features/pull-requests/PullRequestMergeControls.tsx` | U30 (W05), U94 (W21) |
| `apps/mobile/src/features/pull-requests/PullRequestReactions.tsx` | U15 (W03), U47 (W07), U88 (W17), U94 (W21) |
| `apps/mobile/src/features/pull-requests/PullRequestReviewersScreen.tsx` | U69 (W11), U94 (W21) |
| `apps/mobile/src/features/pull-requests/PullRequestRouteScreen.tsx` | U15 (W03), U30 (W05), U38 (W06), U69 (W11), U88 (W17), U94 (W21) |
| `apps/mobile/src/features/pull-requests/PullRequestStatusRows.tsx` | U15 (W03), U94 (W21) |
| `apps/mobile/src/features/pull-requests/PullRequestTimeline.tsx` | U30 (W05), U94 (W21) |
| `apps/mobile/src/features/pull-requests/PullRequestsScreen.tsx` | U50 (W08), U92 (W19), U94 (W21) |
| `apps/mobile/src/features/pull-requests/pullRequestActions.ts` | U30 (W05), U94 (W21) |
| `apps/mobile/src/features/pull-requests/pullRequestDiffPages.ts` | U15 (W03), U94 (W21) |
| `apps/mobile/src/features/pull-requests/pullRequestList.ts` | U30 (W05), U94 (W21) |
| `apps/mobile/src/features/pull-requests/pullRequestSavedViews.ts` | U50 (W08), U92 (W19) |
| `apps/mobile/src/features/pull-requests/pullRequestStatus.ts` | U15 (W03), U94 (W21) |
| `apps/mobile/src/features/pull-requests/usePullRequestDiff.ts` | U15 (W03), U94 (W21) |
| `apps/mobile/src/features/pull-requests/usePullRequestFilesViewed.ts` | U30 (W05), U94 (W21) |
| `apps/mobile/src/features/pull-requests/usePullRequestList.ts` | U47 (W07), U94 (W21) |
| `apps/mobile/src/features/pull-requests/usePullRequestListControls.ts` | U50 (W08), U92 (W19) |
| `apps/mobile/src/features/review/ReviewCommentCard.tsx` | U36 (W06), U94 (W21) |
| `apps/mobile/src/features/review/ReviewSheet.tsx` | U36 (W06), U94 (W21) |
| `apps/mobile/src/features/review/nativeReviewDiffAdapter.ts` | U15 (W03), U36 (W06), U94 (W21) |
| `apps/mobile/src/features/review/reviewModel.ts` | U15 (W03), U94 (W21) |
| `apps/mobile/src/features/review/useReviewDiffData.ts` | U09 (W02), U45 (W07), U94 (W21) |
| `apps/mobile/src/features/settings/EnvironmentRoutesSection.tsx` | U31 (W05), U94 (W21) |
| `apps/mobile/src/features/settings/SettingsAboutRouteScreen.tsx` | U09 (W02), U94 (W21) |
| `apps/mobile/src/features/settings/SettingsClientStorageRouteScreen.tsx` | U09 (W02), U94 (W21) |
| `apps/mobile/src/features/settings/SettingsLanguageRouteScreen.tsx` | U75 (W12), U94 (W21) |
| `apps/mobile/src/features/settings/SettingsNotificationsRouteScreen.tsx` | U54 (W09), U94 (W21) |
| `apps/mobile/src/features/settings/SettingsProjectOverviewRouteScreen.tsx` | U31 (W05), U94 (W21) |
| `apps/mobile/src/features/settings/SettingsRouteScreen.tsx` | U31 (W05), U75 (W12), U87 (W16), U94 (W21) |
| `apps/mobile/src/features/settings/SettingsScheduledTasksRouteScreen.tsx` | U71 (W12), U94 (W21) |
| `apps/mobile/src/features/settings/SettingsServerControlsRouteScreen.tsx` | U92 (W19), U94 (W21) |
| `apps/mobile/src/features/settings/SettingsSourceControlDetailRouteScreens.tsx` | U92 (W19), U94 (W21) |
| `apps/mobile/src/features/settings/VoiceModelSection.tsx` | U34 (W05), U94 (W21) |
| `apps/mobile/src/features/settings/components/IssueTrackerSection.tsx` | U92 (W19), U94 (W21) |
| `apps/mobile/src/features/settings/components/SettingsProviderRow.tsx` | U92 (W19), U94 (W21) |
| `apps/mobile/src/features/settings/components/SourceControlProvidersSection.tsx` | U92 (W19), U94 (W21) |
| `apps/mobile/src/features/settings/components/SourceControlSignInSection.tsx` | U92 (W19), U94 (W21) |
| `apps/mobile/src/features/settings/scheduled-task-editor.tsx` | U71 (W12), U94 (W21) |
| `apps/mobile/src/features/settings/scheduledTaskPresentation.ts` | U71 (W12), U94 (W21) |
| `apps/mobile/src/features/settings/settings-environment-filter.tsx` | U09 (W02), U94 (W21) |
| `apps/mobile/src/features/sharing/incoming-share-model.ts` | U36 (W06), U94 (W21) |
| `apps/mobile/src/features/shortcuts/appShortcuts.ts` | U09 (W02), U94 (W21) |
| `apps/mobile/src/features/shortcuts/appShortcutsRuntime.ts` | U09 (W02), U94 (W21) |
| `apps/mobile/src/features/terminal/ThreadTerminalRouteScreen.tsx` | U36 (W06), U60 (W10), U94 (W21) |
| `apps/mobile/src/features/threads/HtmlRenderWebView.tsx` | U36 (W06), U94 (W21) |
| `apps/mobile/src/features/threads/McpAppWebView.tsx` | U31 (W05), U94 (W21) |
| `apps/mobile/src/features/threads/NewTaskDraftScreen.tsx` | U49 (W08), U94 (W21) |
| `apps/mobile/src/features/threads/NewTaskRouteScreen.tsx` | U09 (W02), U94 (W21) |
| `apps/mobile/src/features/threads/PendingUserInputCard.tsx` | U36 (W06), U94 (W21) |
| `apps/mobile/src/features/threads/QuestionAttachments.tsx` | U43 (W07), U94 (W21) |
| `apps/mobile/src/features/threads/SubagentRow.tsx` | U36 (W06), U48 (W08), U94 (W21) |
| `apps/mobile/src/features/threads/ThreadComposer.tsx` | U20 (W03), U22 (W04), U36 (W06), U43 (W07), U54 (W09), U72 (W12), U88 (W17), U94 (W21) |
| `apps/mobile/src/features/threads/ThreadDetailScreen.tsx` | U09 (W02), U31 (W05), U36 (W06), U54 (W09), U65 (W10), U88 (W17), U94 (W21) |
| `apps/mobile/src/features/threads/ThreadDetailScreenProps.ts` | U36 (W06), U65 (W10) |
| `apps/mobile/src/features/threads/ThreadFeed.tsx` | U06 (W01), U09 (W02), U36 (W06), U43 (W07), U56 (W09), U65 (W10), U73 (W12), U86 (W15), U94 (W21) |
| `apps/mobile/src/features/threads/ThreadInlineFilePreview.tsx` | U73 (W12), U94 (W21) |
| `apps/mobile/src/features/threads/ThreadMarkdownImage.tsx` | U06 (W01), U94 (W21) |
| `apps/mobile/src/features/threads/ThreadMarkdownVideo.tsx` | U43 (W07), U73 (W12), U94 (W21) |
| `apps/mobile/src/features/threads/ThreadNavigationSidebar.ts` | U09 (W02), U22 (W04) |
| `apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx` | U09 (W02), U22 (W04), U31 (W05), U63 (W10), U94 (W21) |
| `apps/mobile/src/features/threads/ThreadQueueControl.tsx` | U19 (W03), U48 (W08), U94 (W21) |
| `apps/mobile/src/features/threads/ThreadRouteScreen.tsx` | U36 (W06), U65 (W10), U94 (W21) |
| `apps/mobile/src/features/threads/ThreadSettingsSheet.tsx` | U81 (W14), U94 (W21) |
| `apps/mobile/src/features/threads/checkout-new-task-branch.ts` | U09 (W02), U94 (W21) |
| `apps/mobile/src/features/threads/floating-working-control.tsx` | U31 (W05), U36 (W06), U65 (W10), U94 (W21) |
| `apps/mobile/src/features/threads/floating-working-status.ts` | U31 (W05), U36 (W06), U65 (W10), U94 (W21) |
| `apps/mobile/src/features/threads/git/GitOverviewSheet.tsx` | U09 (W02), U94 (W21) |
| `apps/mobile/src/features/threads/messageTimestamp.test.ts` | U36 (W06), U56 (W09) |
| `apps/mobile/src/features/threads/messageTimestamp.ts` | U36 (W06), U56 (W09) |
| `apps/mobile/src/features/threads/new-task-flow-provider.tsx` | U49 (W08), U94 (W21) |
| `apps/mobile/src/features/threads/pending-thread-feed.test.ts` | U43 (W07), U65 (W10) |
| `apps/mobile/src/features/threads/pending-thread-feed.ts` | U43 (W07), U65 (W10), U94 (W21) |
| `apps/mobile/src/features/threads/subagent-card-presentation.ts` | U48 (W08), U94 (W21) |
| `apps/mobile/src/features/threads/thread-inspector-preview.tsx` | U36 (W06), U94 (W21) |
| `apps/mobile/src/features/threads/thread-list-v2-items.tsx` | U09 (W02), U25 (W04), U31 (W05), U36 (W06), U94 (W21) |
| `apps/mobile/src/features/threads/thread-work-log.tsx` | U36 (W06), U94 (W21) |
| `apps/mobile/src/features/threads/threadAgentsPresentation.ts` | U48 (W08), U94 (W21) |
| `apps/mobile/src/features/threads/threadContentPresentation.ts` | U36 (W06), U94 (W21) |
| `apps/mobile/src/features/threads/threadListV2.test.ts` | U25 (W04), U31 (W05), U36 (W06) |
| `apps/mobile/src/features/threads/threadListV2.ts` | U25 (W04), U31 (W05), U36 (W06), U94 (W21) |
| `apps/mobile/src/features/threads/threadQueueControlPresentation.ts` | U36 (W06), U94 (W21) |
| `apps/mobile/src/features/threads/use-composer-command-menu.ts` | U04 (W01), U20 (W03), U94 (W21) |
| `apps/mobile/src/features/threads/useLinkedPullRequestActions.ts` | U15 (W03), U94 (W21) |
| `apps/mobile/src/features/threads/worktree-setup-card.tsx` | U36 (W06), U65 (W10), U94 (W21) |
| `apps/mobile/src/i18n/I18nProvider.tsx` | U75 (W12), U94 (W21) |
| `apps/mobile/src/i18n/intl-polyfills.ts` | U75 (W12), U94 (W21) |
| `apps/mobile/src/i18n/messages.ts` | U75 (W12), U94 (W21) |
| `apps/mobile/src/i18n/translations/de.json` | U75 (W12), U94 (W21) |
| `apps/mobile/src/i18n/translations/en.json` | U75 (W12), U94 (W21) |
| `apps/mobile/src/i18n/translations/es.json` | U75 (W12), U94 (W21) |
| `apps/mobile/src/i18n/translations/fr.json` | U75 (W12), U94 (W21) |
| `apps/mobile/src/i18n/translations/ja.json` | U75 (W12), U94 (W21) |
| `apps/mobile/src/i18n/translations/ko.json` | U75 (W12), U94 (W21) |
| `apps/mobile/src/i18n/translations/pt-BR.json` | U75 (W12), U94 (W21) |
| `apps/mobile/src/i18n/translations/ru.json` | U75 (W12), U94 (W21) |
| `apps/mobile/src/i18n/translations/sv.json` | U75 (W12), U94 (W21) |
| `apps/mobile/src/i18n/translations/zh.json` | U75 (W12), U94 (W21) |
| `apps/mobile/src/lib/attachmentUpload.test.ts` | U49 (W08), U62 (W10) |
| `apps/mobile/src/lib/attachmentUpload.ts` | U49 (W08), U62 (W10), U94 (W21) |
| `apps/mobile/src/lib/composerAttachmentUploadQueue.test.ts` | U49 (W08), U62 (W10) |
| `apps/mobile/src/lib/composerAttachmentUploadQueue.ts` | U43 (W07), U49 (W08), U57 (W09), U62 (W10), U94 (W21) |
| `apps/mobile/src/lib/composerContext.ts` | U72 (W12), U94 (W21) |
| `apps/mobile/src/lib/composerContextClipboard.ts` | U19 (W03), U94 (W21) |
| `apps/mobile/src/lib/composerImages.test.ts` | U20 (W03), U43 (W07) |
| `apps/mobile/src/lib/composerImages.ts` | U20 (W03), U43 (W07), U94 (W21) |
| `apps/mobile/src/lib/filePreview.test.ts` | U36 (W06), U73 (W12) |
| `apps/mobile/src/lib/markdownInlineFileLinks.test.ts` | U48 (W08), U73 (W12) |
| `apps/mobile/src/lib/modelOptions.ts` | U81 (W14), U94 (W21) |
| `apps/mobile/src/lib/storage.test.ts` | U50 (W08), U92 (W19) |
| `apps/mobile/src/lib/threadActivity.test.ts` | U26 (W04), U65 (W10) |
| `apps/mobile/src/lib/threadActivity.ts` | U26 (W04), U36 (W06), U48 (W08), U65 (W10), U94 (W21) |
| `apps/mobile/src/lib/time.ts` | U30 (W05), U94 (W21) |
| `apps/mobile/src/native/T3ComposerEditor.ios.tsx` | U20 (W03), U94 (W21) |
| `apps/mobile/src/native/useOpenPullRequest.ts` | U88 (W17), U91 (W18) |
| `apps/mobile/src/persistence/mobile-preferences.ts` | U38 (W06), U50 (W08), U88 (W17), U92 (W19) |
| `apps/mobile/src/state/composer-attachment-upload-states.ts` | U43 (W07), U57 (W09) |
| `apps/mobile/src/state/composer-attachment-uploads.test.ts` | U43 (W07), U49 (W08), U57 (W09), U62 (W10) |
| `apps/mobile/src/state/composer-attachment-uploads.ts` | U43 (W07), U49 (W08), U57 (W09), U62 (W10) |
| `apps/mobile/src/state/edit-pending-thread-message.ts` | U57 (W09), U94 (W21) |
| `apps/mobile/src/state/entities.ts` | U25 (W04), U94 (W21) |
| `apps/mobile/src/state/issues.ts` | U88 (W17), U91 (W18) |
| `apps/mobile/src/state/preferences.ts` | U38 (W06), U50 (W08) |
| `apps/mobile/src/state/pull-requests.ts` | U30 (W05), U47 (W07) |
| `apps/mobile/src/state/queries.filesystem.test.ts` | U54 (W09), U94 (W21) |
| `apps/mobile/src/state/queries.ts` | U31 (W05), U36 (W06), U54 (W09), U94 (W21) |
| `apps/mobile/src/state/query.ts` | U88 (W17), U94 (W21) |
| `apps/mobile/src/state/recover-failed-thread-draft.ts` | U43 (W07), U80 (W13) |
| `apps/mobile/src/state/thread-outbox-model.ts` | U49 (W08), U62 (W10), U94 (W21) |
| `apps/mobile/src/state/thread-outbox.ts` | U49 (W08), U57 (W09) |
| `apps/mobile/src/state/thread-task-permissions.test.ts` | U19 (W03), U57 (W09), U94 (W21) |
| `apps/mobile/src/state/threadOutboxDelivery.permissions.test.ts` | U43 (W07), U49 (W08), U57 (W09), U62 (W10) |
| `apps/mobile/src/state/threadOutboxDelivery.test.ts` | U49 (W08), U57 (W09), U80 (W13) |
| `apps/mobile/src/state/threadOutboxDelivery.ts` | U43 (W07), U49 (W08), U57 (W09), U94 (W21) |
| `apps/mobile/src/state/use-composer-attachment-actions.ts` | U43 (W07), U94 (W21) |
| `apps/mobile/src/state/use-composer-drafts.test.ts` | U36 (W06), U43 (W07), U49 (W08), U54 (W09), U72 (W12) |
| `apps/mobile/src/state/use-composer-drafts.ts` | U43 (W07), U54 (W09), U72 (W12), U80 (W13), U94 (W21) |
| `apps/mobile/src/state/use-remote-environment-registry.ts` | U36 (W06), U94 (W21) |
| `apps/mobile/src/state/use-selected-thread-requests.ts` | U19 (W03), U94 (W21) |
| `apps/mobile/src/state/use-thread-composer-state.ts` | U43 (W07), U49 (W08), U57 (W09), U72 (W12), U94 (W21) |
| `apps/mobile/src/widgets/SubscriptionUsage.android.tsx` | U89 (W17), U94 (W21) |
| `apps/mobile/src/widgets/subscriptionUsageSnapshot.ts` | U89 (W17), U94 (W21) |
| `apps/mobile/vite.config.ts` | U09 (W02), U20 (W03), U36 (W06), U71 (W12), U94 (W21) |
| `apps/server/package.json` | U01 (W01), U87 (W16) |
| `apps/server/scripts/acp-mock-agent.ts` | U32 (W05), U46 (W07) |
| `apps/server/src/assets/AssetAccess.test.ts` | U16 (W03), U22 (W04), U55 (W09), U73 (W12), U84 (W14) |
| `apps/server/src/assets/AssetAccess.ts` | U16 (W03), U22 (W04), U55 (W09), U73 (W12), U84 (W14) |
| `apps/server/src/auth/RpcAuthorization.test.ts` | U22 (W04), U70 (W12) |
| `apps/server/src/auth/RpcAuthorization.ts` | U22 (W04), U70 (W12), U87 (W16) |
| `apps/server/src/cli/invocation.ts` | U29 (W05), U68 (W11) |
| `apps/server/src/cli/pair.ts` | U37 (W06), U68 (W11) |
| `apps/server/src/cli/uninstall.test.ts` | U29 (W05), U68 (W11) |
| `apps/server/src/cli/uninstall.ts` | U29 (W05), U68 (W11) |
| `apps/server/src/cli/update.test.ts` | U14 (W02), U29 (W05) |
| `apps/server/src/cli/update.ts` | U14 (W02), U29 (W05) |
| `apps/server/src/cloud/pinnedRuntime.ts` | U29 (W05), U60 (W10) |
| `apps/server/src/cloud/selfUpdate.test.ts` | U01 (W01), U29 (W05) |
| `apps/server/src/cloud/selfUpdate.ts` | U01 (W01), U14 (W02), U29 (W05) |
| `apps/server/src/device/DeviceHubProxy.ts` | U20 (W03), U22 (W04) |
| `apps/server/src/device/DeviceService.test.ts` | U20 (W03), U22 (W04), U29 (W05) |
| `apps/server/src/device/DeviceService.ts` | U20 (W03), U22 (W04), U29 (W05) |
| `apps/server/src/device/LocalDeviceHost.ts` | U22 (W04), U51 (W08) |
| `apps/server/src/environment/DirectEndpoints.test.ts` | U22 (W04), U37 (W06) |
| `apps/server/src/environment/DirectEndpoints.ts` | U22 (W04), U37 (W06) |
| `apps/server/src/environment/ServerEnvironment.ts` | U01 (W01), U79 (W13) |
| `apps/server/src/git/GitManager.test.ts` | U23 (W04), U30 (W05), U45 (W07), U58 (W09) |
| `apps/server/src/git/GitManager.ts` | U15 (W03), U23 (W04), U30 (W05), U45 (W07), U58 (W09) |
| `apps/server/src/git/GitWorkflowService.ts` | U18 (W03), U45 (W07), U58 (W09) |
| `apps/server/src/guest/GuestShareService.test.ts` | U05 (W01), U22 (W04) |
| `apps/server/src/guest/GuestShareService.ts` | U05 (W01), U22 (W04) |
| `apps/server/src/http.test.ts` | U22 (W04), U84 (W14) |
| `apps/server/src/http.ts` | U22 (W04), U84 (W14) |
| `apps/server/src/issue/IssueService.test.ts` | U70 (W12), U85 (W15), U87 (W16), U91 (W18), U92 (W19), U93 (W20) |
| `apps/server/src/issue/IssueService.ts` | U70 (W12), U82 (W14), U85 (W15), U87 (W16), U91 (W18), U92 (W19), U93 (W20) |
| `apps/server/src/issue/IssueTrackerConnections.ts` | U70 (W12), U85 (W15), U87 (W16), U91 (W18), U92 (W19) |
| `apps/server/src/issue/IssueTrackerHostLive.ts` | U70 (W12), U85 (W15), U87 (W16), U91 (W18), U92 (W19) |
| `apps/server/src/issue/IssueTrackerRegistry.ts` | U70 (W12), U85 (W15), U87 (W16), U91 (W18), U92 (W19) |
| `apps/server/src/keybindings.test.ts` | U37 (W06), U56 (W09) |
| `apps/server/src/keybindings.ts` | U37 (W06), U56 (W09) |
| `apps/server/src/mcp/McpAuthMiddleware.ts` | U22 (W04), U61 (W10) |
| `apps/server/src/mcp/McpDeviceToolkit.test.ts` | U20 (W03), U22 (W04) |
| `apps/server/src/mcp/McpHttpServer.test.ts` | U16 (W03), U22 (W04), U61 (W10) |
| `apps/server/src/mcp/McpHttpServer.ts` | U16 (W03), U22 (W04), U55 (W09), U61 (W10), U85 (W15) |
| `apps/server/src/mcp/McpInvocationContext.ts` | U61 (W10), U85 (W15) |
| `apps/server/src/mcp/OrchestratorMcpService.test.ts` | U02 (W01), U19 (W03), U61 (W10), U71 (W12), U78 (W13), U83 (W14) |
| `apps/server/src/mcp/OrchestratorMcpService.ts` | U02 (W01), U11 (W02), U19 (W03), U61 (W10), U66 (W11), U71 (W12), U78 (W13), U83 (W14) |
| `apps/server/src/mcp/threadAccess.test.ts` | U19 (W03), U78 (W13) |
| `apps/server/src/mcp/threadAccess.ts` | U19 (W03), U61 (W10), U78 (W13) |
| `apps/server/src/mcp/toolkits/core.test.ts` | U61 (W10), U85 (W15) |
| `apps/server/src/mcp/toolkits/device/handlers.ts` | U20 (W03), U22 (W04) |
| `apps/server/src/mcp/toolkits/device/tools.ts` | U20 (W03), U61 (W10) |
| `apps/server/src/mcp/toolkits/issues/handlers.test.ts` | U85 (W15), U91 (W18), U92 (W19) |
| `apps/server/src/mcp/toolkits/issues/handlers.ts` | U85 (W15), U91 (W18), U92 (W19) |
| `apps/server/src/mcp/toolkits/issues/tools.ts` | U85 (W15), U91 (W18), U92 (W19) |
| `apps/server/src/mcp/toolkits/orchestrator/handlers.ts` | U12 (W02), U78 (W13) |
| `apps/server/src/mcp/toolkits/orchestrator/tools.ts` | U12 (W02), U61 (W10), U71 (W12), U78 (W13) |
| `apps/server/src/mcp/toolkits/preview/tools.ts` | U16 (W03), U61 (W10) |
| `apps/server/src/mcp/toolkits/project/handlers.test.ts` | U18 (W03), U78 (W13), U85 (W15) |
| `apps/server/src/mcp/toolkits/project/handlers.ts` | U18 (W03), U78 (W13) |
| `apps/server/src/mcp/toolkits/project/tools.ts` | U61 (W10), U78 (W13) |
| `apps/server/src/mcp/toolkits/pullRequests/handlers.test.ts` | U19 (W03), U30 (W05), U85 (W15) |
| `apps/server/src/mcp/toolkits/pullRequests/handlers.ts` | U19 (W03), U30 (W05) |
| `apps/server/src/mcp/toolkits/theme/handlers.test.ts` | U55 (W09), U85 (W15) |
| `apps/server/src/mcp/toolkits/theme/tools.ts` | U55 (W09), U68 (W11) |
| `apps/server/src/observability/RpcInstrumentation.ts` | U37 (W06), U70 (W12), U87 (W16) |
| `apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.test.ts` | U32 (W05), U40 (W06), U46 (W07), U81 (W14) |
| `apps/server/src/orchestration-v2/Adapters/AcpRegistryAdapterV2.test.ts` | U32 (W05), U40 (W06) |
| `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts` | U02 (W01), U11 (W02), U17 (W03), U39 (W06), U52 (W08), U55 (W09) |
| `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` | U02 (W01), U11 (W02), U17 (W03), U29 (W05), U39 (W06), U52 (W08), U55 (W09), U66 (W11), U78 (W13) |
| `apps/server/src/orchestration-v2/Adapters/ClaudeAgentSdkQueryRunner.test.ts` | U39 (W06), U52 (W08) |
| `apps/server/src/orchestration-v2/Adapters/ClaudeAgentSdkQueryRunner.ts` | U39 (W06), U52 (W08) |
| `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts` | U02 (W01), U11 (W02), U17 (W03), U27 (W04), U35 (W05), U46 (W07) |
| `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts` | U02 (W01), U11 (W02), U17 (W03), U27 (W04), U35 (W05), U78 (W13) |
| `apps/server/src/orchestration-v2/Adapters/FxAdapterV2.test.ts` | U53 (W08), U81 (W14) |
| `apps/server/src/orchestration-v2/Adapters/OpenCode2AdapterV2.test.ts` | U02 (W01), U12 (W02) |
| `apps/server/src/orchestration-v2/ClaudeAutomaticDelivery.integration.test.ts` | U39 (W06), U66 (W11) |
| `apps/server/src/orchestration-v2/CommandPolicy.test.ts` | U52 (W08), U81 (W14) |
| `apps/server/src/orchestration-v2/CommandPolicy.ts` | U46 (W07), U52 (W08), U59 (W09) |
| `apps/server/src/orchestration-v2/ContextHandoffBudget.test.ts` | U48 (W08), U81 (W14) |
| `apps/server/src/orchestration-v2/DelegatedCompletionDelivery.test.ts` | U11 (W02), U83 (W14) |
| `apps/server/src/orchestration-v2/EffectOutbox.ts` | U59 (W09), U66 (W11) |
| `apps/server/src/orchestration-v2/EffectWorker.test.ts` | U59 (W09), U66 (W11) |
| `apps/server/src/orchestration-v2/EffectWorker.ts` | U59 (W09), U66 (W11) |
| `apps/server/src/orchestration-v2/EventSink.ts` | U17 (W03), U77 (W13) |
| `apps/server/src/orchestration-v2/FoundationPersistence.test.ts` | U59 (W09), U66 (W11) |
| `apps/server/src/orchestration-v2/Orchestrator.control-reads.test.ts` | U11 (W02), U17 (W03), U24 (W04), U66 (W11), U83 (W14) |
| `apps/server/src/orchestration-v2/Orchestrator.ts` | U02 (W01), U11 (W02), U17 (W03), U24 (W04), U30 (W05), U38 (W06), U46 (W07), U51 (W08), U59 (W09), U61 (W10), U66 (W11), U74 (W12), U83 (W14), U85 (W15) |
| `apps/server/src/orchestration-v2/ProjectionStore.test.ts` | U24 (W04), U61 (W10), U66 (W11), U77 (W13) |
| `apps/server/src/orchestration-v2/ProjectionStore.ts` | U02 (W01), U11 (W02), U17 (W03), U24 (W04), U38 (W06), U48 (W08), U59 (W09), U61 (W10), U66 (W11), U74 (W12), U77 (W13), U81 (W14), U85 (W15), U90 (W17) |
| `apps/server/src/orchestration-v2/ProviderEventIngestor.test.ts` | U12 (W02), U66 (W11) |
| `apps/server/src/orchestration-v2/ProviderEventIngestor.ts` | U12 (W02), U66 (W11) |
| `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts` | U59 (W09), U66 (W11) |
| `apps/server/src/orchestration-v2/ProviderSessionManager.test.ts` | U17 (W03), U22 (W04), U39 (W06), U46 (W07), U85 (W15) |
| `apps/server/src/orchestration-v2/ProviderSessionManager.ts` | U12 (W02), U17 (W03), U22 (W04), U39 (W06), U46 (W07), U85 (W15) |
| `apps/server/src/orchestration-v2/ProviderTurnControlService.test.ts` | U24 (W04), U61 (W10), U66 (W11) |
| `apps/server/src/orchestration-v2/ProviderTurnStartService.test.ts` | U02 (W01), U11 (W02), U18 (W03), U46 (W07), U52 (W08), U59 (W09) |
| `apps/server/src/orchestration-v2/ProviderTurnStartService.ts` | U02 (W01), U11 (W02), U46 (W07), U52 (W08), U59 (W09) |
| `apps/server/src/orchestration-v2/PullRequestSyncReactor.test.ts` | U15 (W03), U38 (W06), U69 (W11) |
| `apps/server/src/orchestration-v2/PullRequestSyncReactor.ts` | U11 (W02), U15 (W03), U38 (W06), U69 (W11) |
| `apps/server/src/orchestration-v2/RunExecutionService.test.ts` | U02 (W01), U11 (W02), U32 (W05), U46 (W07), U52 (W08) |
| `apps/server/src/orchestration-v2/RunExecutionService.ts` | U02 (W01), U11 (W02), U32 (W05), U46 (W07), U52 (W08) |
| `apps/server/src/orchestration-v2/SubagentProjection.test.ts` | U11 (W02), U83 (W14) |
| `apps/server/src/orchestration-v2/ThreadLaunchService.test.ts` | U02 (W01), U18 (W03), U71 (W12) |
| `apps/server/src/orchestration-v2/ThreadLaunchService.ts` | U02 (W01), U18 (W03), U71 (W12), U78 (W13) |
| `apps/server/src/orchestration-v2/ThreadManagementService.test.ts` | U02 (W01), U66 (W11) |
| `apps/server/src/orchestration-v2/ThreadManagementService.ts` | U02 (W01), U61 (W10), U66 (W11), U77 (W13) |
| `apps/server/src/orchestration-v2/ThreadSearch.test.ts` | U19 (W03), U25 (W04), U66 (W11) |
| `apps/server/src/orchestration-v2/ThreadSearch.ts` | U25 (W04), U66 (W11) |
| `apps/server/src/orchestration-v2/ThreadSettlementService.test.ts` | U38 (W06), U66 (W11) |
| `apps/server/src/orchestration-v2/ThreadSettlementService.ts` | U38 (W06), U66 (W11), U85 (W15) |
| `apps/server/src/orchestration-v2/ThreadTitleRegenerationService.test.ts` | U02 (W01), U77 (W13) |
| `apps/server/src/orchestration-v2/WorktreeBranchSync.ts` | U11 (W02), U77 (W13) |
| `apps/server/src/orchestration-v2/WorktreePreflight.ts` | U18 (W03), U71 (W12) |
| `apps/server/src/orchestration-v2/goat/RemoteDelegatedTasks.ts` | U17 (W03), U61 (W10) |
| `apps/server/src/orchestration-v2/messageSearchIndex.ts` | U19 (W03), U25 (W04), U32 (W05) |
| `apps/server/src/orchestration-v2/runtimeLayer.test.ts` | U02 (W01), U11 (W02), U30 (W05), U38 (W06), U51 (W08), U59 (W09), U66 (W11), U74 (W12), U85 (W15) |
| `apps/server/src/orchestration-v2/testkit/ProviderSwitch.integration.test.ts` | U02 (W01), U46 (W07), U52 (W08), U59 (W09), U66 (W11), U81 (W14) |
| `apps/server/src/orchestration-v2/testkit/fixtures/claude_background_monitor_wake/output.ts` | U11 (W02), U39 (W06) |
| `apps/server/src/orchestration-v2/testkit/fixtures/index.ts` | U21 (W03), U81 (W14) |
| `apps/server/src/peer/PeerForwarding.test.ts` | U61 (W10), U78 (W13) |
| `apps/server/src/peer/RemoteDelegation.test.ts` | U61 (W10), U66 (W11) |
| `apps/server/src/peer/RemoteDelegation.ts` | U61 (W10), U66 (W11) |
| `apps/server/src/persistence/Migrations.ts` | U24 (W04), U87 (W16), U90 (W17) |
| `apps/server/src/persistence/reconcileV2PreviewMigration.test.ts` | U24 (W04), U87 (W16), U90 (W17) |
| `apps/server/src/preview/PortScanner.test.ts` | U16 (W03), U27 (W04) |
| `apps/server/src/preview/PortScanner.ts` | U16 (W03), U27 (W04) |
| `apps/server/src/preview/ServerBrowser.test.ts` | U08 (W02), U16 (W03) |
| `apps/server/src/preview/ServerBrowser.ts` | U08 (W02), U16 (W03) |
| `apps/server/src/preview/ServerBrowserContexts.ts` | U08 (W02), U16 (W03) |
| `apps/server/src/preview/ServerBrowserPage.test.ts` | U08 (W02), U16 (W03) |
| `apps/server/src/preview/ServerBrowserPage.ts` | U08 (W02), U16 (W03) |
| `apps/server/src/process/externalLauncher.test.ts` | U10 (W02), U29 (W05), U37 (W06), U44 (W07), U60 (W10) |
| `apps/server/src/process/externalLauncher.ts` | U10 (W02), U37 (W06), U44 (W07), U60 (W10) |
| `apps/server/src/process/windowsVerbatimSpawn.ts` | U10 (W02), U68 (W11) |
| `apps/server/src/project/AgentSessionImporter.test.ts` | U05 (W01), U74 (W12) |
| `apps/server/src/project/AgentSessionScanner.test.ts` | U05 (W01), U27 (W04), U39 (W06) |
| `apps/server/src/project/AgentSessionScanner.ts` | U05 (W01), U27 (W04), U39 (W06) |
| `apps/server/src/project/ManagedProjectFolders.test.ts` | U37 (W06), U45 (W07) |
| `apps/server/src/project/ManagedProjectFolders.ts` | U37 (W06), U45 (W07) |
| `apps/server/src/project/ProjectService.ts` | U74 (W12), U77 (W13) |
| `apps/server/src/project/ProjectSetupScriptRunner.test.ts` | U42 (W07), U67 (W11) |
| `apps/server/src/project/ProjectSetupScriptRunner.ts` | U42 (W07), U67 (W11) |
| `apps/server/src/project/RepositoryIdentityResolver.test.ts` | U23 (W04), U58 (W09) |
| `apps/server/src/project/RepositoryIdentityResolver.ts` | U23 (W04), U45 (W07), U58 (W09) |
| `apps/server/src/provider/AgentContextBudget.test.ts` | U55 (W09), U85 (W15) |
| `apps/server/src/provider/AntigravityInstallation.test.ts` | U41 (W06), U53 (W08) |
| `apps/server/src/provider/AntigravityInstallation.ts` | U41 (W06), U53 (W08) |
| `apps/server/src/provider/ClaudeProvider.ts` | U17 (W03), U29 (W05) |
| `apps/server/src/provider/Drivers/ClaudeDriver.ts` | U17 (W03), U39 (W06) |
| `apps/server/src/provider/Drivers/ClaudeMaintenance.test.ts` | U01 (W01), U81 (W14) |
| `apps/server/src/provider/Drivers/CodexDriver.test.ts` | U27 (W04), U81 (W14) |
| `apps/server/src/provider/ProviderModelRetention.ts` | U12 (W02), U81 (W14) |
| `apps/server/src/provider/ProviderRegistry.test.ts` | U12 (W02), U17 (W03), U39 (W06), U53 (W08), U81 (W14) |
| `apps/server/src/provider/ProviderRegistry.ts` | U12 (W02), U39 (W06), U53 (W08), U81 (W14) |
| `apps/server/src/provider/agentContextBudget.json` | U55 (W09), U61 (W10), U68 (W11), U71 (W12), U78 (W13), U85 (W15), U92 (W19) |
| `apps/server/src/provider/documentTextWorker.ts` | U05 (W01), U53 (W08), U84 (W14) |
| `apps/server/src/provider/model-manifest.json` | U17 (W03), U26 (W04) |
| `apps/server/src/provider/userInputAttachments.test.ts` | U05 (W01), U53 (W08), U84 (W14) |
| `apps/server/src/pullRequest/PullRequestService.test.ts` | U15 (W03), U30 (W05), U38 (W06), U47 (W07) |
| `apps/server/src/pullRequest/PullRequestService.ts` | U15 (W03), U30 (W05), U38 (W06), U47 (W07) |
| `apps/server/src/relay/AgentAwarenessRelay.test.ts` | U48 (W08), U61 (W10) |
| `apps/server/src/relay/AgentAwarenessRelay.ts` | U48 (W08), U85 (W15) |
| `apps/server/src/server.ts` | U01 (W01), U16 (W03), U22 (W04), U29 (W05), U37 (W06), U45 (W07), U55 (W09), U70 (W12), U85 (W15), U87 (W16), U93 (W20) |
| `apps/server/src/serverSettings.test.ts` | U20 (W03), U22 (W04), U51 (W08) |
| `apps/server/src/serverSettings.ts` | U22 (W04), U51 (W08) |
| `apps/server/src/serviceLauncher.test.ts` | U01 (W01), U29 (W05) |
| `apps/server/src/serviceLauncher.ts` | U01 (W01), U29 (W05), U37 (W06) |
| `apps/server/src/settingsSecrets.ts` | U20 (W03), U22 (W04) |
| `apps/server/src/storageCleanup.test.ts` | U45 (W07), U77 (W13) |
| `apps/server/src/storageCleanup.ts` | U45 (W07), U77 (W13) |
| `apps/server/src/terminal/Manager.test.ts` | U42 (W07), U60 (W10), U67 (W11) |
| `apps/server/src/terminal/Manager.ts` | U42 (W07), U60 (W10), U67 (W11) |
| `apps/server/src/terminal/shellCandidates.ts` | U60 (W10), U67 (W11) |
| `apps/server/src/textGeneration/ClaudeTextGeneration.test.ts` | U17 (W03), U53 (W08), U81 (W14) |
| `apps/server/src/textGeneration/ClaudeTextGeneration.ts` | U17 (W03), U53 (W08) |
| `apps/server/src/usage/UsageLimitSources.test.ts` | U51 (W08), U89 (W17) |
| `apps/server/src/usage/UsageLimitSources.ts` | U51 (W08), U89 (W17) |
| `apps/server/src/vcs/GitVcsDriver.test.ts` | U74 (W12), U77 (W13) |
| `apps/server/src/vcs/GitVcsDriver.ts` | U18 (W03), U23 (W04), U45 (W07), U74 (W12), U77 (W13) |
| `apps/server/src/vcs/GitVcsDriverCore.test.ts` | U18 (W03), U23 (W04), U30 (W05), U45 (W07), U58 (W09), U68 (W11), U73 (W12), U77 (W13) |
| `apps/server/src/vcs/GitVcsDriverCore.ts` | U18 (W03), U23 (W04), U30 (W05), U45 (W07), U58 (W09), U73 (W12), U77 (W13) |
| `apps/server/src/vcs/VcsStatusBroadcaster.test.ts` | U03 (W01), U23 (W04), U45 (W07), U58 (W09) |
| `apps/server/src/vcs/VcsStatusBroadcaster.ts` | U03 (W01), U23 (W04), U45 (W07), U58 (W09) |
| `apps/server/src/workspace/WorkspaceFileSystem.test.ts` | U37 (W06), U73 (W12), U76 (W13) |
| `apps/server/src/workspace/WorkspaceFileSystem.ts` | U37 (W06), U73 (W12), U76 (W13) |
| `apps/server/src/workspace/WorkspaceSearchIndex.test.ts` | U25 (W04), U64 (W10) |
| `apps/server/src/workspace/WorkspaceSearchIndex.ts` | U25 (W04), U64 (W10) |
| `apps/server/src/ws.test.ts` | U37 (W06), U46 (W07), U70 (W12), U87 (W16) |
| `apps/server/src/ws.ts` | U18 (W03), U23 (W04), U31 (W05), U37 (W06), U46 (W07), U55 (W09), U60 (W10), U67 (W11), U70 (W12), U87 (W16) |
| `apps/web/src/appInit.tsx` | U55 (W09), U94 (W21) |
| `apps/web/src/authBootstrap.test.ts` | U01 (W01), U56 (W09) |
| `apps/web/src/components/AddProjectToMachineDialog.tsx` | U72 (W12), U94 (W21) |
| `apps/web/src/components/AppRouteModal.tsx` | U34 (W05), U94 (W21) |
| `apps/web/src/components/AppSidebarLayout.tsx` | U25 (W04), U94 (W21) |
| `apps/web/src/components/BranchToolbar.logic.test.ts` | U18 (W03), U23 (W04), U45 (W07) |
| `apps/web/src/components/BranchToolbar.logic.ts` | U18 (W03), U23 (W04), U45 (W07), U94 (W21) |
| `apps/web/src/components/BranchToolbar.tsx` | U54 (W09), U94 (W21) |
| `apps/web/src/components/BranchToolbarBranchSelector.tsx` | U18 (W03), U23 (W04), U45 (W07), U54 (W09), U85 (W15), U94 (W21) |
| `apps/web/src/components/ChatMarkdown.browser.test.tsx` | U07 (W01), U25 (W04), U48 (W08), U73 (W12) |
| `apps/web/src/components/ChatMarkdown.tsx` | U10 (W02), U25 (W04), U48 (W08), U56 (W09), U73 (W12), U85 (W15), U94 (W21) |
| `apps/web/src/components/ChatView.browser.test.tsx` | U25 (W04), U72 (W12) |
| `apps/web/src/components/ChatView.logic.test.ts` | U18 (W03), U48 (W08), U54 (W09), U68 (W11), U72 (W12) |
| `apps/web/src/components/ChatView.logic.ts` | U04 (W01), U18 (W03), U31 (W05), U48 (W08), U54 (W09), U72 (W12), U94 (W21) |
| `apps/web/src/components/ChatView.tsx` | U04 (W01), U18 (W03), U25 (W04), U31 (W05), U48 (W08), U54 (W09), U72 (W12), U81 (W14), U85 (W15), U94 (W21) |
| `apps/web/src/components/CommandPalette.browser.test.tsx` | U25 (W04), U54 (W09), U63 (W10) |
| `apps/web/src/components/CommandPalette.logic.test.ts` | U25 (W04), U64 (W10) |
| `apps/web/src/components/CommandPalette.logic.ts` | U25 (W04), U64 (W10), U87 (W16), U94 (W21) |
| `apps/web/src/components/CommandPalette.tsx` | U04 (W01), U25 (W04), U31 (W05), U63 (W10), U79 (W13), U87 (W16), U94 (W21) |
| `apps/web/src/components/CommandPaletteThreadItems.tsx` | U25 (W04), U31 (W05), U94 (W21) |
| `apps/web/src/components/ComposerPromptEditorTiptap.input.browser.test.tsx` | U19 (W03), U54 (W09) |
| `apps/web/src/components/ComposerPromptEditorTiptap.tsx` | U10 (W02), U19 (W03), U54 (W09), U72 (W12), U94 (W21) |
| `apps/web/src/components/DiffFilePathCopyButton.browser.test.tsx` | U54 (W09), U76 (W13) |
| `apps/web/src/components/DiffFilePathCopyButton.tsx` | U54 (W09), U76 (W13), U94 (W21) |
| `apps/web/src/components/DiffPanel.tsx` | U25 (W04), U45 (W07), U76 (W13), U94 (W21) |
| `apps/web/src/components/GitActionsControl.logic.test.ts` | U23 (W04), U58 (W09) |
| `apps/web/src/components/GitActionsControl.logic.ts` | U23 (W04), U58 (W09), U94 (W21) |
| `apps/web/src/components/GitActionsControl.tsx` | U18 (W03), U23 (W04), U30 (W05), U58 (W09), U87 (W16), U94 (W21) |
| `apps/web/src/components/KeybindingsUpdateToast.tsx` | U54 (W09), U94 (W21) |
| `apps/web/src/components/LegacySidebar.tsx` | U25 (W04), U63 (W10) |
| `apps/web/src/components/ReopenClosedViewShortcut.tsx` | U79 (W13), U94 (W21) |
| `apps/web/src/components/RightPanelTabs.tsx` | U10 (W02), U30 (W05), U79 (W13), U94 (W21) |
| `apps/web/src/components/SavedViewsMenu.browser.test.tsx` | U50 (W08), U92 (W19) |
| `apps/web/src/components/SavedViewsMenu.tsx` | U50 (W08), U92 (W19), U94 (W21) |
| `apps/web/src/components/Sidebar.browser.test.tsx` | U63 (W10), U68 (W11) |
| `apps/web/src/components/Sidebar.logic.test.ts` | U25 (W04), U31 (W05), U63 (W10) |
| `apps/web/src/components/Sidebar.logic.ts` | U25 (W04), U31 (W05), U63 (W10), U94 (W21) |
| `apps/web/src/components/Sidebar.tsx` | U25 (W04), U31 (W05), U54 (W09), U63 (W10), U94 (W21) |
| `apps/web/src/components/ThreadContextChip.tsx` | U54 (W09), U94 (W21) |
| `apps/web/src/components/ThreadNotificationCoordinator.tsx` | U48 (W08), U94 (W21) |
| `apps/web/src/components/ThreadTerminalDrawer.browser.test.tsx` | U42 (W07), U60 (W10), U67 (W11) |
| `apps/web/src/components/ThreadTerminalDrawer.tsx` | U42 (W07), U60 (W10), U67 (W11), U94 (W21) |
| `apps/web/src/components/chat/AssistantCitationCommentEditor.tsx` | U48 (W08), U80 (W13), U94 (W21) |
| `apps/web/src/components/chat/AssistantCitationSource.tsx` | U48 (W08), U94 (W21) |
| `apps/web/src/components/chat/ChatComposer.tsx` | U04 (W01), U10 (W02), U19 (W03), U34 (W05), U54 (W09), U72 (W12), U81 (W14), U94 (W21) |
| `apps/web/src/components/chat/ChatHeader.tsx` | U48 (W08), U94 (W21) |
| `apps/web/src/components/chat/ChatMarkdownMedia.tsx` | U48 (W08), U73 (W12), U94 (W21) |
| `apps/web/src/components/chat/ChatOverlayHosts.tsx` | U48 (W08), U94 (W21) |
| `apps/web/src/components/chat/ComposerAttachmentStrip.tsx` | U19 (W03), U94 (W21) |
| `apps/web/src/components/chat/ComposerBanner.tsx` | U25 (W04), U94 (W21) |
| `apps/web/src/components/chat/ComposerBannerStack.tsx` | U30 (W05), U94 (W21) |
| `apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx` | U54 (W09), U94 (W21) |
| `apps/web/src/components/chat/ComposerSpeechButton.tsx` | U34 (W05), U94 (W21) |
| `apps/web/src/components/chat/ComposerStashMenu.tsx` | U19 (W03), U94 (W21) |
| `apps/web/src/components/chat/DraftHeroHeadline.tsx` | U25 (W04), U72 (W12), U94 (W21) |
| `apps/web/src/components/chat/ExpandedImageDialog.tsx` | U19 (W03), U73 (W12), U94 (W21) |
| `apps/web/src/components/chat/ExpandedImagePreview.tsx` | U19 (W03), U94 (W21) |
| `apps/web/src/components/chat/GlobalVoiceInputIndicator.tsx` | U34 (W05), U94 (W21) |
| `apps/web/src/components/chat/HtmlRenderFrame.tsx` | U63 (W10), U94 (W21) |
| `apps/web/src/components/chat/MarkdownCodeBlock.tsx` | U48 (W08), U94 (W21) |
| `apps/web/src/components/chat/MarkdownDetails.tsx` | U56 (W09), U94 (W21) |
| `apps/web/src/components/chat/MarkdownFileLink.logic.ts` | U84 (W14), U94 (W21) |
| `apps/web/src/components/chat/MarkdownFileLink.tsx` | U10 (W02), U54 (W09), U73 (W12), U84 (W14), U94 (W21) |
| `apps/web/src/components/chat/McpAppFrame.tsx` | U31 (W05), U44 (W07), U94 (W21) |
| `apps/web/src/components/chat/MessageCopyButton.tsx` | U54 (W09), U94 (W21) |
| `apps/web/src/components/chat/MessagesTimeline.browser.test.tsx` | U07 (W01), U48 (W08), U65 (W10) |
| `apps/web/src/components/chat/MessagesTimeline.logic.test.ts` | U26 (W04), U36 (W06), U48 (W08), U65 (W10) |
| `apps/web/src/components/chat/MessagesTimeline.logic.ts` | U36 (W06), U48 (W08), U94 (W21) |
| `apps/web/src/components/chat/MessagesTimeline.tsx` | U48 (W08), U94 (W21) |
| `apps/web/src/components/chat/ModelPickerContent.tsx` | U04 (W01), U94 (W21) |
| `apps/web/src/components/chat/ProviderModelPicker.tsx` | U04 (W01), U94 (W21) |
| `apps/web/src/components/chat/QueuedRunsControl.browser.test.tsx` | U19 (W03), U25 (W04), U48 (W08), U73 (W12) |
| `apps/web/src/components/chat/QueuedRunsControl.tsx` | U19 (W03), U25 (W04), U48 (W08), U94 (W21) |
| `apps/web/src/components/chat/RightPanelSurfaceContent.tsx` | U85 (W15), U94 (W21) |
| `apps/web/src/components/chat/SideChatPane.tsx` | U25 (W04), U94 (W21) |
| `apps/web/src/components/chat/SkillInlineText.tsx` | U48 (W08), U94 (W21) |
| `apps/web/src/components/chat/SnapShotAttachmentDetails.tsx` | U19 (W03), U94 (W21) |
| `apps/web/src/components/chat/ThreadDetailsIssueRows.tsx` | U69 (W11), U85 (W15), U94 (W21) |
| `apps/web/src/components/chat/ThreadDetailsPrRow.tsx` | U30 (W05), U69 (W11), U94 (W21) |
| `apps/web/src/components/chat/ThreadDetailsPrRows.tsx` | U69 (W11), U94 (W21) |
| `apps/web/src/components/chat/ThreadFindBar.tsx` | U48 (W08), U94 (W21) |
| `apps/web/src/components/chat/ThreadRelationshipIcon.tsx` | U48 (W08), U94 (W21) |
| `apps/web/src/components/chat/ThreadRelationshipsControl.browser.test.tsx` | U25 (W04), U48 (W08) |
| `apps/web/src/components/chat/ThreadRelationshipsControl.tsx` | U25 (W04), U48 (W08), U94 (W21) |
| `apps/web/src/components/chat/ThreadServersPanel.tsx` | U73 (W12), U94 (W21) |
| `apps/web/src/components/chat/TimelineAssistantRows.tsx` | U25 (W04), U73 (W12), U76 (W13), U94 (W21) |
| `apps/web/src/components/chat/TimelineUserMessageRow.tsx` | U19 (W03), U55 (W09), U72 (W12), U94 (W21) |
| `apps/web/src/components/chat/TimelineWorkEntryRow.logic.ts` | U26 (W04), U94 (W21) |
| `apps/web/src/components/chat/TimelineWorkGroupRows.logic.ts` | U31 (W05), U94 (W21) |
| `apps/web/src/components/chat/TimelineWorkGroupRows.tsx` | U31 (W05), U36 (W06), U94 (W21) |
| `apps/web/src/components/chat/TraitsPicker.tsx` | U04 (W01), U94 (W21) |
| `apps/web/src/components/chat/UserMessageContextChips.tsx` | U10 (W02), U94 (W21) |
| `apps/web/src/components/chat/V2LifecycleRow.tsx` | U48 (W08), U94 (W21) |
| `apps/web/src/components/chat/chatViewSend.ts` | U72 (W12), U94 (W21) |
| `apps/web/src/components/chat/composerAttachmentFiles.ts` | U72 (W12), U94 (W21) |
| `apps/web/src/components/chat/composerCommandKey.ts` | U54 (W09), U72 (W12) |
| `apps/web/src/components/chat/composerPromptHistory.ts` | U54 (W09), U72 (W12) |
| `apps/web/src/components/chat/composerSend.logic.ts` | U72 (W12), U94 (W21) |
| `apps/web/src/components/chat/copySnapshot.ts` | U19 (W03), U94 (W21) |
| `apps/web/src/components/chat/queuedMessageEdit.ts` | U54 (W09), U94 (W21) |
| `apps/web/src/components/chat/threadFindHighlights.browser.test.tsx` | U48 (W08), U63 (W10) |
| `apps/web/src/components/chat/threadFindHighlights.ts` | U48 (W08), U63 (W10) |
| `apps/web/src/components/chat/useChatTerminalActions.ts` | U42 (W07), U94 (W21) |
| `apps/web/src/components/chat/useComposerAttachmentIntake.ts` | U54 (W09), U72 (W12), U94 (W21) |
| `apps/web/src/components/chat/useComposerContextImport.browser.test.tsx` | U19 (W03), U54 (W09) |
| `apps/web/src/components/chat/useComposerContextImport.ts` | U19 (W03), U54 (W09), U72 (W12), U94 (W21) |
| `apps/web/src/components/chat/useComposerMenuItems.ts` | U04 (W01), U54 (W09), U94 (W21) |
| `apps/web/src/components/chat/useComposerResume.ts` | U02 (W01), U94 (W21) |
| `apps/web/src/components/chat/useComposerSelection.ts` | U04 (W01), U81 (W14), U94 (W21) |
| `apps/web/src/components/chat/useComposerSend.ts` | U18 (W03), U25 (W04), U54 (W09), U72 (W12), U94 (W21) |
| `apps/web/src/components/chat/useComposerStash.ts` | U54 (W09), U72 (W12), U94 (W21) |
| `apps/web/src/components/chat/useDraftEnvironmentRouting.browser.test.tsx` | U31 (W05), U72 (W12) |
| `apps/web/src/components/chat/useDraftEnvironmentRouting.ts` | U72 (W12), U94 (W21) |
| `apps/web/src/components/chat/useMultipleModelSend.ts` | U72 (W12), U94 (W21) |
| `apps/web/src/components/chat/usePendingThreadRequests.ts` | U72 (W12), U94 (W21) |
| `apps/web/src/components/chat/useQueuedRunEdit.browser.test.tsx` | U54 (W09), U72 (W12) |
| `apps/web/src/components/chat/useQueuedRunEdit.ts` | U54 (W09), U72 (W12), U94 (W21) |
| `apps/web/src/components/chat/useRightPanelActions.ts` | U25 (W04), U54 (W09), U94 (W21) |
| `apps/web/src/components/chat/useThreadLifecycle.tsx` | U48 (W08), U94 (W21) |
| `apps/web/src/components/desktop/SnapShotCoordinator.tsx` | U72 (W12), U94 (W21) |
| `apps/web/src/components/desktopUpdate.logic.ts` | U01 (W01), U94 (W21) |
| `apps/web/src/components/device/DeviceSetup.tsx` | U20 (W03), U94 (W21) |
| `apps/web/src/components/device/DeviceWorkspace.tsx` | U20 (W03), U94 (W21) |
| `apps/web/src/components/diffs/DiffFileTree.tsx` | U25 (W04), U94 (W21) |
| `apps/web/src/components/files/AttachmentFilePreview.browser.test.tsx` | U73 (W12), U84 (W14), U94 (W21) |
| `apps/web/src/components/files/AudioPreview.tsx` | U73 (W12), U94 (W21) |
| `apps/web/src/components/files/BinaryViewer.tsx` | U84 (W14), U94 (W21) |
| `apps/web/src/components/files/BrowserDocumentFrame.browser.test.tsx` | U48 (W08), U84 (W14) |
| `apps/web/src/components/files/FileBrowserPanel.tsx` | U25 (W04), U54 (W09), U94 (W21) |
| `apps/web/src/components/files/FilePreviewPanel.browser.test.tsx` | U16 (W03), U76 (W13) |
| `apps/web/src/components/files/FilePreviewPanel.test.ts` | U76 (W13), U84 (W14), U94 (W21) |
| `apps/web/src/components/files/FilePreviewPanel.tsx` | U16 (W03), U76 (W13), U84 (W14), U94 (W21) |
| `apps/web/src/components/files/NotebookPreview.tsx` | U84 (W14), U94 (W21) |
| `apps/web/src/components/files/PdfViewer.tsx` | U84 (W14), U94 (W21) |
| `apps/web/src/components/files/binaryPreview.worker.test.ts` | U84 (W14), U94 (W21) |
| `apps/web/src/components/files/binaryPreview.worker.ts` | U84 (W14), U94 (W21) |
| `apps/web/src/components/files/extendedDocumentPreview.ts` | U84 (W14), U94 (W21) |
| `apps/web/src/components/files/fileCommentAnnotations.ts` | U76 (W13), U94 (W21) |
| `apps/web/src/components/files/imageDecode.worker.ts` | U16 (W03), U94 (W21) |
| `apps/web/src/components/files/largeText.worker.ts` | U84 (W14), U94 (W21) |
| `apps/web/src/components/files/projectFilesQueryState.ts` | U73 (W12), U94 (W21) |
| `apps/web/src/components/files/useDirectoryEntries.ts` | U73 (W12), U94 (W21) |
| `apps/web/src/components/issue/IssueCommentComposer.tsx` | U79 (W13), U94 (W21) |
| `apps/web/src/components/issue/IssueDetailGhost.tsx` | U79 (W13), U94 (W21) |
| `apps/web/src/components/issue/IssueDetailPanel.tsx` | U79 (W13), U85 (W15), U88 (W17), U91 (W18), U92 (W19), U94 (W21) |
| `apps/web/src/components/issue/IssueListFilterPickers.tsx` | U79 (W13), U91 (W18), U94 (W21) |
| `apps/web/src/components/issue/IssueRow.tsx` | U79 (W13), U88 (W17) |
| `apps/web/src/components/issue/IssuesPage.tsx` | U79 (W13), U88 (W17), U91 (W18), U92 (W19), U93 (W20), U94 (W21) |
| `apps/web/src/components/issue/issueListPreferences.ts` | U79 (W13), U91 (W18), U92 (W19), U93 (W20) |
| `apps/web/src/components/issue/issuePresentation.tsx` | U79 (W13), U87 (W16), U88 (W17), U92 (W19) |
| `apps/web/src/components/issue/issueSavedViews.test.ts` | U79 (W13), U92 (W19) |
| `apps/web/src/components/issue/issueSavedViews.ts` | U79 (W13), U92 (W19), U94 (W21) |
| `apps/web/src/components/issue/issuesSearch.logic.test.ts` | U79 (W13), U91 (W18), U93 (W20) |
| `apps/web/src/components/issue/issuesSearch.logic.ts` | U79 (W13), U91 (W18), U93 (W20) |
| `apps/web/src/components/media/MediaActions.tsx` | U54 (W09), U94 (W21) |
| `apps/web/src/components/media/MediaVideoPlayer.tsx` | U54 (W09), U73 (W12), U94 (W21) |
| `apps/web/src/components/media/OpenMediaLink.tsx` | U54 (W09), U94 (W21) |
| `apps/web/src/components/media/mediaContent.ts` | U54 (W09), U94 (W21) |
| `apps/web/src/components/onboarding/WelcomePage.tsx` | U56 (W09), U94 (W21) |
| `apps/web/src/components/preview/PreviewEmptyState.tsx` | U31 (W05), U94 (W21) |
| `apps/web/src/components/preview/PreviewView.tsx` | U08 (W02), U72 (W12), U94 (W21) |
| `apps/web/src/components/promptLinks/copyPromptLink.ts` | U04 (W01), U54 (W09), U94 (W21) |
| `apps/web/src/components/pullRequest/ChangeBreakdownGrid.tsx` | U58 (W09), U94 (W21) |
| `apps/web/src/components/pullRequest/PullRequestChangeBreakdownStat.tsx` | U58 (W09), U94 (W21) |
| `apps/web/src/components/pullRequest/PullRequestCodeTab.tsx` | U15 (W03), U30 (W05), U69 (W11), U76 (W13), U94 (W21) |
| `apps/web/src/components/pullRequest/PullRequestDetailLayout.tsx` | U69 (W11), U94 (W21) |
| `apps/web/src/components/pullRequest/PullRequestDetailPanel.tsx` | U47 (W07), U54 (W09), U69 (W11), U94 (W21) |
| `apps/web/src/components/pullRequest/PullRequestGhosts.tsx` | U79 (W13), U94 (W21) |
| `apps/web/src/components/pullRequest/PullRequestGuideTab.tsx` | U87 (W16), U94 (W21) |
| `apps/web/src/components/pullRequest/PullRequestLabelPicker.tsx` | U47 (W07), U69 (W11), U94 (W21) |
| `apps/web/src/components/pullRequest/PullRequestListFilters.tsx` | U47 (W07), U50 (W08), U79 (W13), U91 (W18), U94 (W21) |
| `apps/web/src/components/pullRequest/PullRequestReactions.tsx` | U47 (W07), U79 (W13), U94 (W21) |
| `apps/web/src/components/pullRequest/PullRequestReviewerPicker.tsx` | U69 (W11), U94 (W21) |
| `apps/web/src/components/pullRequest/PullRequestRow.tsx` | U69 (W11), U94 (W21) |
| `apps/web/src/components/pullRequest/PullRequestStackMenu.tsx` | U69 (W11), U94 (W21) |
| `apps/web/src/components/pullRequest/PullRequestSummaryTab.tsx` | U15 (W03), U79 (W13), U94 (W21) |
| `apps/web/src/components/pullRequest/PullRequestTimelineTab.tsx` | U15 (W03), U94 (W21) |
| `apps/web/src/components/pullRequest/PullRequestTitleEditor.tsx` | U47 (W07), U94 (W21) |
| `apps/web/src/components/pullRequest/PullRequestsColumn.tsx` | U50 (W08), U94 (W21) |
| `apps/web/src/components/pullRequest/PullRequestsPage.tsx` | U30 (W05), U47 (W07), U50 (W08), U54 (W09), U79 (W13), U92 (W19), U94 (W21) |
| `apps/web/src/components/pullRequest/ThreadPullRequestsPanel.tsx` | U15 (W03), U69 (W11), U94 (W21) |
| `apps/web/src/components/pullRequest/filesViewedStore.ts` | U30 (W05), U94 (W21) |
| `apps/web/src/components/pullRequest/guide/GuideExcerpt.tsx` | U69 (W11), U94 (W21) |
| `apps/web/src/components/pullRequest/guide/useGuideDiffFiles.ts` | U69 (W11), U94 (W21) |
| `apps/web/src/components/pullRequest/guide/useReviewGuideWriter.ts` | U87 (W16), U94 (W21) |
| `apps/web/src/components/pullRequest/pullRequestDetail.logic.ts` | U30 (W05), U69 (W11), U94 (W21) |
| `apps/web/src/components/pullRequest/pullRequestList.logic.test.ts` | U15 (W03), U47 (W07) |
| `apps/web/src/components/pullRequest/pullRequestList.logic.ts` | U15 (W03), U47 (W07), U94 (W21) |
| `apps/web/src/components/pullRequest/pullRequestListPreferences.ts` | U50 (W08), U93 (W20) |
| `apps/web/src/components/pullRequest/pullRequestSavedViews.test.ts` | U50 (W08), U92 (W19) |
| `apps/web/src/components/pullRequest/pullRequestSavedViews.ts` | U50 (W08), U92 (W19), U94 (W21) |
| `apps/web/src/components/pullRequest/pullRequestStackSnapshot.ts` | U69 (W11), U94 (W21) |
| `apps/web/src/components/pullRequest/usePullRequestDetail.ts` | U47 (W07), U69 (W11) |
| `apps/web/src/components/pullRequest/usePullRequestListView.ts` | U30 (W05), U93 (W20) |
| `apps/web/src/components/settings/AboutVersionTitle.tsx` | U54 (W09), U94 (W21) |
| `apps/web/src/components/settings/AcpRegistrySearchStep.tsx` | U32 (W05), U94 (W21) |
| `apps/web/src/components/settings/AcpSessionManagementSection.tsx` | U54 (W09), U94 (W21) |
| `apps/web/src/components/settings/AddUsageLimitSourceDialog.tsx` | U51 (W08), U94 (W21) |
| `apps/web/src/components/settings/AdvancedSettings.tsx` | U25 (W04), U94 (W21) |
| `apps/web/src/components/settings/AuthorizedClientsSettings.tsx` | U22 (W04), U54 (W09), U94 (W21) |
| `apps/web/src/components/settings/CodexSetupSection.tsx` | U27 (W04), U94 (W21) |
| `apps/web/src/components/settings/ConnectionDiagnosisDetails.tsx` | U54 (W09), U94 (W21) |
| `apps/web/src/components/settings/ConnectionsSettings.logic.ts` | U22 (W04), U94 (W21) |
| `apps/web/src/components/settings/ConnectionsSettings.tsx` | U14 (W02), U94 (W21) |
| `apps/web/src/components/settings/CustomModelEditor.tsx` | U56 (W09), U94 (W21) |
| `apps/web/src/components/settings/DeviceSourcesSettings.tsx` | U20 (W03), U94 (W21) |
| `apps/web/src/components/settings/DiagnosticsSettings.tsx` | U56 (W09), U94 (W21) |
| `apps/web/src/components/settings/EasDeviceHostEditor.tsx` | U20 (W03), U94 (W21) |
| `apps/web/src/components/settings/EnvironmentRoutesList.tsx` | U31 (W05), U94 (W21) |
| `apps/web/src/components/settings/FontFamilyPicker.tsx` | U56 (W09), U94 (W21) |
| `apps/web/src/components/settings/IntegrationsSettings.browser.test.tsx` | U31 (W05), U56 (W09) |
| `apps/web/src/components/settings/IntegrationsSettings.tsx` | U56 (W09), U94 (W21) |
| `apps/web/src/components/settings/IssueTrackerSettings.tsx` | U87 (W16), U91 (W18), U94 (W21) |
| `apps/web/src/components/settings/KeybindingsSettings.logic.ts` | U56 (W09), U94 (W21) |
| `apps/web/src/components/settings/KeybindingsSettings.tsx` | U56 (W09), U94 (W21) |
| `apps/web/src/components/settings/MicrophoneTest.tsx` | U34 (W05), U94 (W21) |
| `apps/web/src/components/settings/ProjectDefaultsSettings.tsx` | U56 (W09), U94 (W21) |
| `apps/web/src/components/settings/ProviderAuthTerminal.tsx` | U67 (W11), U94 (W21) |
| `apps/web/src/components/settings/ProviderInstanceCard.tsx` | U56 (W09), U94 (W21) |
| `apps/web/src/components/settings/ProviderModelsSection.tsx` | U25 (W04), U56 (W09), U94 (W21) |
| `apps/web/src/components/settings/ProviderSettingsPanel.tsx` | U56 (W09), U94 (W21) |
| `apps/web/src/components/settings/ResourceTelemetryDiagnostics.logic.test.ts` | U01 (W01), U56 (W09) |
| `apps/web/src/components/settings/ResourceTelemetryDiagnostics.logic.ts` | U01 (W01), U56 (W09), U94 (W21) |
| `apps/web/src/components/settings/ResourceTelemetryDiagnostics.tsx` | U56 (W09), U94 (W21) |
| `apps/web/src/components/settings/SavedEnvironmentRows.tsx` | U54 (W09), U94 (W21) |
| `apps/web/src/components/settings/ScheduledTasksSettings.tsx` | U71 (W12), U94 (W21) |
| `apps/web/src/components/settings/SettingsFontPreviews.tsx` | U67 (W11), U94 (W21) |
| `apps/web/src/components/settings/SettingsPanels.tsx` | U56 (W09), U67 (W11), U94 (W21) |
| `apps/web/src/components/settings/SettingsScopeContext.tsx` | U56 (W09), U94 (W21) |
| `apps/web/src/components/settings/SettingsScopeNotice.tsx` | U56 (W09), U94 (W21) |
| `apps/web/src/components/settings/SourceControlSettings.tsx` | U58 (W09), U87 (W16), U94 (W21) |
| `apps/web/src/components/settings/SourceControlWritingSettings.tsx` | U56 (W09), U94 (W21) |
| `apps/web/src/components/settings/SpeechModelComparison.tsx` | U34 (W05), U94 (W21) |
| `apps/web/src/components/settings/TextGeneratorsSettings.tsx` | U56 (W09), U94 (W21) |
| `apps/web/src/components/settings/ThemeCssEditor.tsx` | U55 (W09), U94 (W21) |
| `apps/web/src/components/settings/ThemeEditorHost.tsx` | U54 (W09), U94 (W21) |
| `apps/web/src/components/settings/ThemeEditorPanel.tsx` | U55 (W09), U94 (W21) |
| `apps/web/src/components/settings/ThemeImportDialog.tsx` | U55 (W09), U94 (W21) |
| `apps/web/src/components/settings/VoiceSettingsPanel.tsx` | U34 (W05), U56 (W09), U94 (W21) |
| `apps/web/src/components/settings/easDeviceHostsSettings.logic.ts` | U20 (W03), U94 (W21) |
| `apps/web/src/components/settings/scheduledTasksSettings.logic.ts` | U71 (W12), U94 (W21) |
| `apps/web/src/components/settings/scopedSettings.ts` | U56 (W09), U94 (W21) |
| `apps/web/src/components/settings/settingsLayout.tsx` | U56 (W09), U94 (W21) |
| `apps/web/src/components/settings/settingsSearch.ts` | U34 (W05), U67 (W11), U87 (W16), U94 (W21) |
| `apps/web/src/components/settings/useScopedSettings.ts` | U56 (W09), U94 (W21) |
| `apps/web/src/components/sidebar/SidebarChrome.tsx` | U79 (W13), U94 (W21) |
| `apps/web/src/components/sidebar/SidebarDraftBlock.tsx` | U25 (W04), U63 (W10), U94 (W21) |
| `apps/web/src/components/sidebar/SidebarProjectFolderHeader.tsx` | U63 (W10), U94 (W21) |
| `apps/web/src/components/sidebar/SidebarThreadRow.tsx` | U25 (W04), U31 (W05), U63 (W10), U94 (W21) |
| `apps/web/src/components/sidebar/UpdateEverythingDialog.tsx` | U56 (W09), U94 (W21) |
| `apps/web/src/components/sidebar/mainAppLocation.ts` | U56 (W09), U79 (W13) |
| `apps/web/src/components/sidebar/updateEverything.logic.test.ts` | U01 (W01), U68 (W11), U94 (W21) |
| `apps/web/src/components/sidebar/updateEverything.logic.ts` | U01 (W01), U68 (W11), U94 (W21) |
| `apps/web/src/components/sidebar/useUpdateEverything.ts` | U01 (W01), U94 (W21) |
| `apps/web/src/components/ui/anchoredCopyToast.ts` | U54 (W09), U94 (W21) |
| `apps/web/src/components/ui/dialog.tsx` | U10 (W02), U73 (W12), U94 (W21) |
| `apps/web/src/components/ui/sheet.tsx` | U10 (W02), U94 (W21) |
| `apps/web/src/components/ui/toast.tsx` | U56 (W09), U94 (W21) |
| `apps/web/src/components/usage/UsageModelDialog.tsx` | U51 (W08), U94 (W21) |
| `apps/web/src/components/usage/UsagePage.tsx` | U51 (W08), U94 (W21) |
| `apps/web/src/components/usage/UsageProviderChart.tsx` | U51 (W08), U94 (W21) |
| `apps/web/src/components/usage/UsageShareBar.tsx` | U51 (W08), U94 (W21) |
| `apps/web/src/composer-logic.ts` | U19 (W03), U72 (W12) |
| `apps/web/src/composer-rich-text-doc.test.ts` | U54 (W09), U72 (W12), U80 (W13) |
| `apps/web/src/composer-rich-text-doc.ts` | U54 (W09), U72 (W12), U80 (W13) |
| `apps/web/src/composerDraftStore.test.ts` | U04 (W01), U72 (W12) |
| `apps/web/src/composerDraftStore.ts` | U04 (W01), U34 (W05), U54 (W09), U72 (W12), U81 (W14) |
| `apps/web/src/contextMenuFallback.ts` | U56 (W09), U63 (W10), U94 (W21) |
| `apps/web/src/editorPreferences.test.ts` | U60 (W10), U76 (W13) |
| `apps/web/src/editorPreferences.ts` | U60 (W10), U76 (W13), U94 (W21) |
| `apps/web/src/environments/primary/auth.ts` | U01 (W01), U56 (W09), U94 (W21) |
| `apps/web/src/hooks/useRightPanelSurfaceClose.browser.test.tsx` | U08 (W02), U67 (W11) |
| `apps/web/src/hooks/useRightPanelSurfaceClose.ts` | U67 (W11), U94 (W21) |
| `apps/web/src/hooks/useThreadActionMenu.ts` | U54 (W09), U94 (W21) |
| `apps/web/src/hooks/useThreadActions.permissions.test.ts` | U25 (W04), U45 (W07) |
| `apps/web/src/hooks/useThreadActions.ts` | U25 (W04), U45 (W07), U66 (W11), U94 (W21) |
| `apps/web/src/i18n/initializeI18n.ts` | U75 (W12), U94 (W21) |
| `apps/web/src/i18n/messages.ts` | U75 (W12), U94 (W21) |
| `apps/web/src/i18n/runtime.ts` | U75 (W12), U94 (W21) |
| `apps/web/src/i18n/translations/de.json` | U75 (W12), U94 (W21) |
| `apps/web/src/i18n/translations/en.json` | U75 (W12), U94 (W21) |
| `apps/web/src/i18n/translations/es.json` | U75 (W12), U94 (W21) |
| `apps/web/src/i18n/translations/fr.json` | U75 (W12), U94 (W21) |
| `apps/web/src/i18n/translations/ja.json` | U75 (W12), U94 (W21) |
| `apps/web/src/i18n/translations/ko.json` | U75 (W12), U94 (W21) |
| `apps/web/src/i18n/translations/pt-BR.json` | U75 (W12), U94 (W21) |
| `apps/web/src/i18n/translations/ru.json` | U75 (W12), U94 (W21) |
| `apps/web/src/i18n/translations/sv.json` | U75 (W12), U94 (W21) |
| `apps/web/src/i18n/translations/zh.json` | U75 (W12), U94 (W21) |
| `apps/web/src/index.css` | U07 (W01), U56 (W09) |
| `apps/web/src/lib/addProjectToMachine.ts` | U76 (W13), U94 (W21) |
| `apps/web/src/lib/attachmentUploadQueue.test.ts` | U54 (W09), U72 (W12) |
| `apps/web/src/lib/attachmentUploadQueue.ts` | U54 (W09), U62 (W10), U72 (W12), U94 (W21) |
| `apps/web/src/lib/composerContextRecords.ts` | U54 (W09), U94 (W21) |
| `apps/web/src/lib/copyThreadReference.ts` | U54 (W09), U94 (W21) |
| `apps/web/src/lib/diffRendering.ts` | U76 (W13), U94 (W21) |
| `apps/web/src/lib/discardComposerDraft.ts` | U54 (W09), U94 (W21) |
| `apps/web/src/lib/openPullRequestLink.ts` | U69 (W11), U94 (W21) |
| `apps/web/src/lib/terminalCloseConfirm.ts` | U67 (W11), U94 (W21) |
| `apps/web/src/lib/workspaceFocus.ts` | U25 (W04), U54 (W09) |
| `apps/web/src/localApi.ts` | U10 (W02), U94 (W21) |
| `apps/web/src/markdown-clipboard.ts` | U07 (W01), U48 (W08), U94 (W21) |
| `apps/web/src/modelSelection.test.ts` | U04 (W01), U81 (W14) |
| `apps/web/src/reopenClosedView.ts` | U08 (W02), U79 (W13), U93 (W20) |
| `apps/web/src/reviewCommentContext.ts` | U69 (W11), U94 (W21) |
| `apps/web/src/rightPanelStore.ts` | U79 (W13), U94 (W21) |
| `apps/web/src/routes/_chat.issues.tsx` | U79 (W13), U91 (W18) |
| `apps/web/src/routes/_chat.settings.tsx` | U55 (W09), U94 (W21) |
| `apps/web/src/session-logic.ts` | U26 (W04), U48 (W08), U94 (W21) |
| `apps/web/src/shortcuts/chatRouteCommands.ts` | U48 (W08), U94 (W21) |
| `apps/web/src/speech/browserPcmCapture.ts` | U34 (W05), U94 (W21) |
| `apps/web/src/speech/browserVoiceInput.ts` | U34 (W05), U94 (W21) |
| `apps/web/src/speech/useEnvironmentSpeechInput.ts` | U34 (W05), U94 (W21) |
| `apps/web/src/speech/voiceInputSession.ts` | U34 (W05), U94 (W21) |
| `apps/web/src/state/desktopWslState.ts` | U14 (W02), U94 (W21) |
| `apps/web/src/state/device.ts` | U20 (W03), U94 (W21) |
| `apps/web/src/state/entities.ts` | U25 (W04), U73 (W12), U94 (W21) |
| `apps/web/src/state/environments.ts` | U72 (W12), U79 (W13) |
| `apps/web/src/state/issues.ts` | U79 (W13), U88 (W17), U91 (W18) |
| `apps/web/src/state/pullRequests.test.ts` | U30 (W05), U47 (W07) |
| `apps/web/src/state/pullRequests.ts` | U30 (W05), U47 (W07) |
| `apps/web/src/state/queries.ts` | U31 (W05), U54 (W09), U64 (W10), U94 (W21) |
| `apps/web/src/state/usePullRequestStack.ts` | U69 (W11), U94 (W21) |
| `apps/web/src/terminal-links.test.ts` | U42 (W07), U60 (W10) |
| `apps/web/src/terminal-links.ts` | U42 (W07), U60 (W10) |
| `apps/web/src/terminal/ghostty/core.test.ts` | U42 (W07), U60 (W10), U67 (W11) |
| `apps/web/src/terminal/ghostty/core.ts` | U42 (W07), U60 (W10), U67 (W11) |
| `apps/web/src/terminal/ghostty/surface.test.ts` | U42 (W07), U67 (W11) |
| `apps/web/src/terminal/ghostty/surface.ts` | U42 (W07), U60 (W10), U67 (W11), U94 (W21) |
| `apps/web/src/themePalette.ts` | U55 (W09), U94 (W21) |
| `apps/web/src/timestampFormat.ts` | U56 (W09), U94 (W21) |
| `apps/web/src/useNativeFileDrag.ts` | U10 (W02), U94 (W21) |
| `apps/web/test/appScenarios.renders.tsx` | U25 (W04), U72 (W12) |
| `apps/web/test/fakeEnvironment.ts` | U25 (W04), U31 (W05) |
| `docs/internals/server-updates.md` | U01 (W01), U59 (W09) |
| `docs/operations/observability.md` | U29 (W05), U37 (W06) |
| `docs/orchestration-v2/orchestrator-mcp-server.md` | U18 (W03), U27 (W04), U61 (W10), U68 (W11) |
| `docs/user/devices.md` | U20 (W03), U51 (W08) |
| `docs/user/install.md` | U29 (W05), U68 (W11) |
| `docs/user/keybindings.md` | U25 (W04), U56 (W09) |
| `docs/user/project-settings.md` | U18 (W03), U56 (W09), U87 (W16) |
| `docs/user/remote-access.md` | U31 (W05), U68 (W11) |
| `docs/user/source-control.md` | U23 (W04), U50 (W08), U68 (W11), U79 (W13), U82 (W14), U85 (W15), U87 (W16), U92 (W19) |
| `docs/user/thread-sidebar.md` | U02 (W01), U39 (W06) |
| `docs/user/updating.md` | U39 (W06), U59 (W09) |
| `evals/mcp-tool-use/cases/themes.ndjson` | U55 (W09), U68 (W11) |
| `evals/mcp-tool-use/run.ts` | U22 (W04), U55 (W09) |
| `package.json` | U24 (W04), U75 (W12), U94 (W21) |
| `packages/client-runtime/package.json` | U15 (W03), U50 (W08), U62 (W10), U69 (W11), U79 (W13), U85 (W15), U87 (W16), U88 (W17), U92 (W19), U94 (W21) |
| `packages/client-runtime/src/connection/diagnosis.ts` | U22 (W04), U94 (W21) |
| `packages/client-runtime/src/connection/driver.ts` | U31 (W05), U94 (W21) |
| `packages/client-runtime/src/connection/errors.ts` | U31 (W05), U94 (W21) |
| `packages/client-runtime/src/connection/model.ts` | U31 (W05), U94 (W21) |
| `packages/client-runtime/src/connection/onboarding.ts` | U41 (W06), U94 (W21) |
| `packages/client-runtime/src/connection/presentation.ts` | U31 (W05), U94 (W21) |
| `packages/client-runtime/src/connection/supervisor.ts` | U31 (W05), U94 (W21) |
| `packages/client-runtime/src/device/screenshot.ts` | U22 (W04), U94 (W21) |
| `packages/client-runtime/src/device/stream.ts` | U20 (W03), U94 (W21) |
| `packages/client-runtime/src/issueLinks.test.ts` | U85 (W15), U91 (W18), U93 (W20) |
| `packages/client-runtime/src/issueLinks.ts` | U85 (W15), U91 (W18), U93 (W20) |
| `packages/client-runtime/src/issueList.test.ts` | U91 (W18), U93 (W20) |
| `packages/client-runtime/src/issueList.ts` | U88 (W17), U91 (W18), U93 (W20) |
| `packages/client-runtime/src/issuePresentation.test.ts` | U91 (W18), U92 (W19) |
| `packages/client-runtime/src/issuePresentation.ts` | U88 (W17), U91 (W18), U92 (W19), U94 (W21) |
| `packages/client-runtime/src/issueSelection.test.ts` | U79 (W13), U91 (W18) |
| `packages/client-runtime/src/issueSelection.ts` | U79 (W13), U91 (W18) |
| `packages/client-runtime/src/operations/commands.ts` | U66 (W11), U85 (W15), U94 (W21) |
| `packages/client-runtime/src/operations/projects.ts` | U31 (W05), U94 (W21) |
| `packages/client-runtime/src/pullRequestMarkdown.test.ts` | U15 (W03), U31 (W05) |
| `packages/client-runtime/src/pullRequestMarkdown.ts` | U15 (W03), U31 (W05) |
| `packages/client-runtime/src/pullRequestReactions.test.ts` | U15 (W03), U47 (W07) |
| `packages/client-runtime/src/pullRequestReactions.ts` | U15 (W03), U47 (W07), U94 (W21) |
| `packages/client-runtime/src/pullRequestSavedViews.ts` | U50 (W08), U92 (W19) |
| `packages/client-runtime/src/rpc/session.test.ts` | U31 (W05), U55 (W09) |
| `packages/client-runtime/src/rpc/session.ts` | U31 (W05), U94 (W21) |
| `packages/client-runtime/src/savedViews.ts` | U92 (W19), U94 (W21) |
| `packages/client-runtime/src/state/attachmentUploads.ts` | U62 (W10), U94 (W21) |
| `packages/client-runtime/src/state/attachments.ts` | U62 (W10), U94 (W21) |
| `packages/client-runtime/src/state/composerDispatch.ts` | U54 (W09), U72 (W12) |
| `packages/client-runtime/src/state/device.ts` | U20 (W03), U94 (W21) |
| `packages/client-runtime/src/state/filesystem.ts` | U64 (W10), U94 (W21) |
| `packages/client-runtime/src/state/gitActions.ts` | U50 (W08), U94 (W21) |
| `packages/client-runtime/src/state/issueTrackers.ts` | U87 (W16), U94 (W21) |
| `packages/client-runtime/src/state/issues.test.ts` | U79 (W13), U88 (W17) |
| `packages/client-runtime/src/state/issues.ts` | U79 (W13), U88 (W17), U91 (W18) |
| `packages/client-runtime/src/state/models.ts` | U85 (W15), U94 (W21) |
| `packages/client-runtime/src/state/olderSettledThreads.ts` | U25 (W04), U31 (W05) |
| `packages/client-runtime/src/state/orchestration.ts` | U25 (W04), U31 (W05), U94 (W21) |
| `packages/client-runtime/src/state/orchestrationV2Projection.ts` | U81 (W14), U85 (W15) |
| `packages/client-runtime/src/state/presentation.ts` | U31 (W05), U79 (W13), U94 (W21) |
| `packages/client-runtime/src/state/projectCommands.ts` | U73 (W12), U94 (W21) |
| `packages/client-runtime/src/state/projectGrouping.test.ts` | U15 (W03), U31 (W05) |
| `packages/client-runtime/src/state/projectGrouping.ts` | U15 (W03), U31 (W05), U94 (W21) |
| `packages/client-runtime/src/state/pullRequests.test.ts` | U47 (W07), U69 (W11) |
| `packages/client-runtime/src/state/pullRequests.ts` | U30 (W05), U47 (W07), U69 (W11), U94 (W21) |
| `packages/client-runtime/src/state/runtime.test.ts` | U31 (W05), U42 (W07) |
| `packages/client-runtime/src/state/runtime.ts` | U14 (W02), U94 (W21) |
| `packages/client-runtime/src/state/server.ts` | U01 (W01), U31 (W05), U39 (W06), U94 (W21) |
| `packages/client-runtime/src/state/shell.ts` | U31 (W05), U94 (W21) |
| `packages/client-runtime/src/state/subagentDisplay.ts` | U48 (W08), U94 (W21) |
| `packages/client-runtime/src/state/subagentRuntime.ts` | U31 (W05), U36 (W06), U94 (W21) |
| `packages/client-runtime/src/state/threadCommands.ts` | U66 (W11), U85 (W15) |
| `packages/client-runtime/src/state/threadSettled.ts` | U25 (W04), U31 (W05), U94 (W21) |
| `packages/client-runtime/src/state/threadShell.ts` | U63 (W10), U94 (W21) |
| `packages/client-runtime/src/state/threadSnoozed.test.ts` | U25 (W04), U31 (W05) |
| `packages/client-runtime/src/state/threadWorkflows.ts` | U31 (W05), U94 (W21) |
| `packages/client-runtime/src/state/threads.ts` | U31 (W05), U94 (W21) |
| `packages/client-runtime/src/t3ToolSummary.ts` | U55 (W09), U85 (W15), U94 (W21) |
| `packages/client-runtime/src/userMessage.ts` | U65 (W10), U94 (W21) |
| `packages/client-runtime/src/work-log/itemDetail.ts` | U31 (W05), U37 (W06) |
| `packages/client-runtime/src/work-log/presentation.ts` | U55 (W09), U94 (W21) |
| `packages/client-runtime/src/work-log/turnItemEntry.ts` | U26 (W04), U48 (W08) |
| `packages/contracts/src/acpRegistry.ts` | U32 (W05), U46 (W07) |
| `packages/contracts/src/assets.ts` | U22 (W04), U55 (W09) |
| `packages/contracts/src/clientRpcPermissions.ts` | U70 (W12), U87 (W16) |
| `packages/contracts/src/composerContext.ts` | U19 (W03), U54 (W09) |
| `packages/contracts/src/device.ts` | U20 (W03), U22 (W04) |
| `packages/contracts/src/environment.ts` | U01 (W01), U29 (W05), U79 (W13) |
| `packages/contracts/src/ipc.ts` | U01 (W01), U10 (W02), U16 (W03), U34 (W05) |
| `packages/contracts/src/issue.ts` | U70 (W12), U79 (W13), U85 (W15), U87 (W16), U91 (W18), U92 (W19), U93 (W20) |
| `packages/contracts/src/orchestrationV2.ts` | U02 (W01), U11 (W02), U26 (W04), U33 (W05), U52 (W08), U66 (W11), U76 (W13), U81 (W14), U85 (W15) |
| `packages/contracts/src/orchestratorMcp.ts` | U61 (W10), U71 (W12), U78 (W13) |
| `packages/contracts/src/previewAutomation.ts` | U08 (W02), U16 (W03) |
| `packages/contracts/src/pullRequest.ts` | U15 (W03), U30 (W05), U38 (W06), U47 (W07), U69 (W11), U76 (W13) |
| `packages/contracts/src/resourceTelemetry.ts` | U01 (W01), U22 (W04), U41 (W06) |
| `packages/contracts/src/review.ts` | U45 (W07), U76 (W13) |
| `packages/contracts/src/rpc.ts` | U55 (W09), U70 (W12), U87 (W16) |
| `packages/contracts/src/server.ts` | U01 (W01), U31 (W05), U39 (W06), U55 (W09), U60 (W10) |
| `packages/contracts/src/settings.test.ts` | U20 (W03), U34 (W05), U55 (W09), U67 (W11) |
| `packages/contracts/src/settings.ts` | U22 (W04), U34 (W05), U51 (W08), U55 (W09), U67 (W11) |
| `packages/contracts/src/terminal.ts` | U60 (W10), U67 (W11) |
| `packages/issue-tracker-linear/schema/linear.graphql.ts` | U87 (W16), U91 (W18) |
| `packages/issue-tracker-linear/src/server/LinearApi.graphql` | U87 (W16), U91 (W18), U92 (W19), U93 (W20) |
| `packages/issue-tracker-linear/src/server/LinearApi.graphql.ts` | U87 (W16), U91 (W18), U92 (W19), U93 (W20) |
| `packages/issue-tracker-linear/src/server/LinearApi.ts` | U87 (W16), U91 (W18), U93 (W20) |
| `packages/issue-tracker-linear/src/server/LinearIssueTracker.test.ts` | U87 (W16), U91 (W18), U92 (W19), U93 (W20) |
| `packages/issue-tracker-linear/src/server/LinearIssueTracker.ts` | U87 (W16), U91 (W18), U92 (W19), U93 (W20) |
| `packages/issue-tracker-linear/src/server/driver.ts` | U87 (W16), U93 (W20) |
| `packages/provider-acp-registry/src/server/AcpRegistrySupport.test.ts` | U32 (W05), U46 (W07) |
| `packages/provider-acp-registry/src/server/AcpRegistrySupport.ts` | U32 (W05), U46 (W07) |
| `packages/provider-acp-registry/src/server/adapter.ts` | U32 (W05), U46 (W07) |
| `packages/provider-acp-registry/src/server/driver.test.ts` | U32 (W05), U46 (W07) |
| `packages/provider-acp-registry/src/server/driver.ts` | U32 (W05), U46 (W07) |
| `packages/provider-acp-registry/src/server/kimiAcp.test.ts` | U46 (W07), U68 (W11) |
| `packages/provider-acp-registry/src/server/probe.ts` | U32 (W05), U46 (W07) |
| `packages/provider-acp/src/server/adapter.ts` | U32 (W05), U40 (W06), U46 (W07), U53 (W08), U81 (W14) |
| `packages/provider-acp/src/server/elicitationForm.ts` | U32 (W05), U46 (W07) |
| `packages/provider-acp/src/server/mcpOverAcpBridge.test.ts` | U32 (W05), U40 (W06) |
| `packages/provider-acp/src/server/mcpOverAcpBridge.ts` | U32 (W05), U40 (W06) |
| `packages/provider-core/src/server/ProviderAdapter.ts` | U02 (W01), U12 (W02), U46 (W07), U66 (W11) |
| `packages/provider-core/src/server/driver.ts` | U39 (W06), U51 (W08) |
| `packages/provider-core/src/server/failure.test.ts` | U46 (W07), U81 (W14) |
| `packages/provider-core/src/server/failure.ts` | U17 (W03), U39 (W06), U46 (W07), U81 (W14) |
| `packages/provider-core/src/server/handoffBudget.ts` | U48 (W08), U81 (W14) |
| `packages/provider-core/src/server/subagentProjection.ts` | U11 (W02), U83 (W14) |
| `packages/provider-cursor/src/server/CursorAgentSdk.test.ts` | U01 (W01), U13 (W02) |
| `packages/provider-cursor/src/server/CursorAgentSdk.ts` | U01 (W01), U13 (W02) |
| `packages/provider-cursor/src/server/adapter.test.ts` | U01 (W01), U13 (W02), U53 (W08), U81 (W14) |
| `packages/provider-cursor/src/server/adapter.ts` | U01 (W01), U13 (W02), U53 (W08), U81 (W14) |
| `packages/provider-fx/src/server/acpSupport.ts` | U53 (W08), U81 (W14) |
| `packages/provider-fx/src/server/adapter.ts` | U53 (W08), U81 (W14) |
| `packages/provider-opencode/src/server/adapter.test.ts` | U02 (W01), U12 (W02), U21 (W03), U28 (W04), U53 (W08) |
| `packages/provider-opencode/src/server/adapter.ts` | U02 (W01), U12 (W02), U21 (W03), U28 (W04), U53 (W08) |
| `packages/provider-opencode/src/server/v2/adapter.ts` | U02 (W01), U12 (W02) |
| `packages/provider-pi/src/server/adapter.test.ts` | U26 (W04), U33 (W05) |
| `packages/provider-pi/src/server/adapter.ts` | U26 (W04), U33 (W05) |
| `packages/provider-pi/src/server/driver.ts` | U26 (W04), U51 (W08) |
| `packages/shared/package.json` | U15 (W03), U22 (W04), U31 (W05), U37 (W06), U42 (W07), U48 (W08), U55 (W09), U61 (W10), U94 (W21) |
| `packages/shared/src/changedFileKind.ts` | U30 (W05), U58 (W09) |
| `packages/shared/src/cliArgs.test.ts` | U39 (W06), U68 (W11) |
| `packages/shared/src/cliArgs.ts` | U39 (W06), U68 (W11) |
| `packages/shared/src/cloneUrl.test.ts` | U45 (W07), U58 (W09) |
| `packages/shared/src/cloneUrl.ts` | U45 (W07), U58 (W09) |
| `packages/shared/src/codexFileCitations.test.ts` | U48 (W08), U73 (W12) |
| `packages/shared/src/codexFileCitations.ts` | U48 (W08), U73 (W12) |
| `packages/shared/src/codexMarkdownDirectives.test.ts` | U48 (W08), U73 (W12) |
| `packages/shared/src/composerTrigger.test.ts` | U04 (W01), U19 (W03) |
| `packages/shared/src/composerTrigger.ts` | U04 (W01), U19 (W03) |
| `packages/shared/src/editor.ts` | U10 (W02), U29 (W05) |
| `packages/shared/src/fileLinks.test.ts` | U60 (W10), U73 (W12) |
| `packages/shared/src/fileLinks.ts` | U60 (W10), U73 (W12) |
| `packages/shared/src/git.test.ts` | U23 (W04), U45 (W07), U58 (W09) |
| `packages/shared/src/git.ts` | U23 (W04), U45 (W07), U58 (W09) |
| `packages/shared/src/htmlRender.ts` | U48 (W08), U84 (W14) |
| `packages/shared/src/markdownLinks.test.ts` | U48 (W08), U73 (W12) |
| `packages/shared/src/markdownLinks.ts` | U48 (W08), U73 (W12) |
| `packages/shared/src/markdownPipeline.test.ts` | U07 (W01), U56 (W09) |
| `packages/shared/src/markdownPipeline.ts` | U07 (W01), U48 (W08), U56 (W09) |
| `packages/shared/src/nodeSqliteClient.test.ts` | U37 (W06), U66 (W11) |
| `packages/shared/src/nodeSqliteClient.ts` | U37 (W06), U66 (W11) |
| `packages/shared/src/path.test.ts` | U45 (W07), U58 (W09) |
| `packages/shared/src/path.ts` | U45 (W07), U58 (W09) |
| `packages/shared/src/promptLinks.ts` | U31 (W05), U94 (W21) |
| `packages/shared/src/pullRequestAnchor.test.ts` | U15 (W03), U23 (W04) |
| `packages/shared/src/pullRequestAnchor.ts` | U15 (W03), U23 (W04) |
| `packages/shared/src/shell.test.ts` | U29 (W05), U41 (W06), U53 (W08) |
| `packages/shared/src/shell.ts` | U29 (W05), U41 (W06), U53 (W08) |
| `packages/shared/src/speech.ts` | U34 (W05), U94 (W21) |
| `packages/shared/src/t3McpToolPresentation.ts` | U55 (W09), U85 (W15) |
| `packages/shared/src/terminalOutput.ts` | U42 (W07), U84 (W14) |
| `packages/shared/src/threadFindText.test.ts` | U07 (W01), U48 (W08) |
| `packages/shared/src/threadLinks.ts` | U78 (W13), U94 (W21) |
| `packages/shared/src/usageLimits.test.ts` | U51 (W08), U94 (W21) |
| `packages/shared/src/usageLimits.ts` | U51 (W08), U94 (W21) |
| `packages/source-control-azure-devops/src/server/AzureDevOpsCli.test.ts` | U23 (W04), U45 (W07), U58 (W09) |
| `packages/source-control-azure-devops/src/server/AzureDevOpsCli.ts` | U23 (W04), U45 (W07), U58 (W09) |
| `packages/source-control-azure-devops/src/server/AzureDevOpsIssueTracker.test.ts` | U82 (W14), U91 (W18), U92 (W19), U93 (W20) |
| `packages/source-control-azure-devops/src/server/AzureDevOpsIssueTracker.ts` | U82 (W14), U91 (W18), U92 (W19), U93 (W20) |
| `packages/source-control-azure-devops/src/server/AzureDevOpsPullRequestCli.test.ts` | U15 (W03), U30 (W05), U50 (W08), U58 (W09) |
| `packages/source-control-azure-devops/src/server/AzureDevOpsPullRequestCli.ts` | U15 (W03), U30 (W05), U45 (W07), U50 (W08), U58 (W09) |
| `packages/source-control-azure-devops/src/server/AzureDevOpsPullRequestProvider.test.ts` | U15 (W03), U30 (W05), U50 (W08) |
| `packages/source-control-azure-devops/src/server/AzureDevOpsPullRequestProvider.ts` | U15 (W03), U30 (W05), U50 (W08) |
| `packages/source-control-azure-devops/src/server/AzureDevOpsSourceControlProvider.test.ts` | U23 (W04), U45 (W07) |
| `packages/source-control-azure-devops/src/server/AzureDevOpsSourceControlProvider.ts` | U23 (W04), U45 (W07) |
| `packages/source-control-azure-devops/src/server/azureDevOpsIssueJson.ts` | U82 (W14), U91 (W18), U92 (W19), U93 (W20) |
| `packages/source-control-azure-devops/src/server/azureDevOpsPullRequestJson.test.ts` | U30 (W05), U50 (W08), U58 (W09) |
| `packages/source-control-azure-devops/src/server/azureDevOpsPullRequestJson.ts` | U30 (W05), U50 (W08), U58 (W09) |
| `packages/source-control-azure-devops/src/shared/definition.test.ts` | U23 (W04), U45 (W07), U82 (W14), U91 (W18) |
| `packages/source-control-azure-devops/src/shared/definition.ts` | U23 (W04), U45 (W07), U82 (W14), U85 (W15), U91 (W18) |
| `packages/source-control-bitbucket/src/server/BitbucketApi.ts` | U45 (W07), U87 (W16) |
| `packages/source-control-bitbucket/src/shared/definition.ts` | U31 (W05), U58 (W09), U68 (W11) |
| `packages/source-control-core/package.json` | U70 (W12), U87 (W16) |
| `packages/source-control-core/src/server/IssueTracker.ts` | U70 (W12), U87 (W16), U91 (W18), U92 (W19), U93 (W20) |
| `packages/source-control-core/src/server/IssueTrackerHost.ts` | U87 (W16), U93 (W20) |
| `packages/source-control-core/src/server/PullRequestProvider.ts` | U15 (W03), U30 (W05), U38 (W06), U93 (W20) |
| `packages/source-control-core/src/server/SourceControlProvider.ts` | U30 (W05), U93 (W20) |
| `packages/source-control-core/src/server/diffFileRevisions.test.ts` | U15 (W03), U93 (W20) |
| `packages/source-control-core/src/server/diffFileRevisions.ts` | U15 (W03), U93 (W20) |
| `packages/source-control-core/src/server/driver.ts` | U70 (W12), U93 (W20) |
| `packages/source-control-core/src/server/mergeMessage.test.ts` | U58 (W09), U93 (W20) |
| `packages/source-control-core/src/server/mergeMessage.ts` | U58 (W09), U93 (W20) |
| `packages/source-control-core/src/server/pullRequestChecks.ts` | U30 (W05), U93 (W20) |
| `packages/source-control-core/src/shared/definition.ts` | U23 (W04), U45 (W07), U70 (W12), U85 (W15), U93 (W20) |
| `packages/source-control-forgejo/src/server/ForgejoCli.ts` | U23 (W04), U58 (W09), U82 (W14) |
| `packages/source-control-forgejo/src/server/ForgejoIssueTracker.test.ts` | U82 (W14), U91 (W18), U92 (W19) |
| `packages/source-control-forgejo/src/server/ForgejoIssueTracker.ts` | U82 (W14), U91 (W18), U92 (W19) |
| `packages/source-control-forgejo/src/server/ForgejoSourceControlProvider.test.ts` | U58 (W09), U82 (W14) |
| `packages/source-control-forgejo/src/server/ForgejoSourceControlProvider.ts` | U23 (W04), U82 (W14) |
| `packages/source-control-forgejo/src/server/forgejoIssueJson.ts` | U82 (W14), U91 (W18), U92 (W19) |
| `packages/source-control-forgejo/src/shared/definition.test.ts` | U45 (W07), U82 (W14) |
| `packages/source-control-forgejo/src/shared/definition.ts` | U23 (W04), U45 (W07), U82 (W14), U85 (W15) |
| `packages/source-control-github/src/server/GitHubIssueTracker.test.ts` | U70 (W12), U91 (W18), U92 (W19) |
| `packages/source-control-github/src/server/GitHubIssueTracker.ts` | U70 (W12), U91 (W18), U92 (W19) |
| `packages/source-control-github/src/server/GitHubPullRequestApi.test.ts` | U15 (W03), U30 (W05), U38 (W06), U58 (W09) |
| `packages/source-control-github/src/server/GitHubPullRequestApi.ts` | U15 (W03), U30 (W05), U38 (W06), U58 (W09) |
| `packages/source-control-github/src/server/GitHubPullRequestProvider.ts` | U15 (W03), U38 (W06), U87 (W16) |
| `packages/source-control-github/src/server/GitHubSourceControlProvider.test.ts` | U30 (W05), U45 (W07), U87 (W16), U93 (W20) |
| `packages/source-control-github/src/server/GitHubSourceControlProvider.ts` | U30 (W05), U45 (W07), U87 (W16), U93 (W20) |
| `packages/source-control-github/src/server/gitHubIssueJson.ts` | U70 (W12), U91 (W18), U92 (W19) |
| `packages/source-control-github/src/server/gitHubPullRequestJson.ts` | U30 (W05), U38 (W06), U70 (W12) |
| `packages/source-control-github/src/shared/definition.ts` | U85 (W15), U93 (W20) |
| `packages/source-control-gitlab/src/server/GitLabCli.test.ts` | U15 (W03), U23 (W04), U45 (W07), U58 (W09) |
| `packages/source-control-gitlab/src/server/GitLabCli.ts` | U15 (W03), U23 (W04), U45 (W07), U58 (W09), U77 (W13) |
| `packages/source-control-gitlab/src/server/GitLabIssueTracker.test.ts` | U82 (W14), U91 (W18), U92 (W19), U93 (W20) |
| `packages/source-control-gitlab/src/server/GitLabIssueTracker.ts` | U82 (W14), U91 (W18), U92 (W19), U93 (W20) |
| `packages/source-control-gitlab/src/server/GitLabPullRequestCli.test.ts` | U30 (W05), U69 (W11) |
| `packages/source-control-gitlab/src/server/GitLabPullRequestCli.ts` | U30 (W05), U38 (W06), U69 (W11) |
| `packages/source-control-gitlab/src/server/GitLabPullRequestProvider.ts` | U38 (W06), U69 (W11) |
| `packages/source-control-gitlab/src/server/GitLabSourceControlProvider.test.ts` | U15 (W03), U23 (W04), U58 (W09) |
| `packages/source-control-gitlab/src/server/gitLabIssueJson.ts` | U82 (W14), U91 (W18), U92 (W19) |
| `packages/source-control-gitlab/src/server/gitLabMergeRequestJson.test.ts` | U30 (W05), U38 (W06), U69 (W11) |
| `packages/source-control-gitlab/src/server/gitLabMergeRequestJson.ts` | U30 (W05), U38 (W06), U69 (W11) |
| `packages/source-control-gitlab/src/shared/definition.test.ts` | U15 (W03), U82 (W14) |
| `packages/source-control-gitlab/src/shared/definition.ts` | U15 (W03), U82 (W14), U85 (W15) |
| `packages/ssh/src/config.test.ts` | U29 (W05), U41 (W06) |
| `packages/ssh/src/config.ts` | U29 (W05), U41 (W06) |
| `packages/ssh/src/tunnel.test.ts` | U29 (W05), U41 (W06) |
| `packages/ssh/src/tunnel.ts` | U29 (W05), U41 (W06) |
| `pnpm-lock.yaml` | U01 (W01), U09 (W02), U15 (W03), U25 (W04), U29 (W05), U36 (W06), U42 (W07), U48 (W08), U58 (W09), U64 (W10), U68 (W11), U70 (W12), U76 (W13), U84 (W14), U86 (W15), U87 (W16), U89 (W17), U94 (W21) |
| `pnpm-workspace.yaml` | U01 (W01), U29 (W05), U36 (W06), U48 (W08), U68 (W11), U76 (W13) |
| `scripts/check-changed.ts` | U68 (W11), U87 (W16) |
| `scripts/i18n-check.ts` | U75 (W12), U94 (W21) |
| `scripts/install.sh` | U29 (W05), U68 (W11) |
| `scripts/install.test.ts` | U29 (W05), U68 (W11) |
| `scripts/mobile-native-client.ts` | U20 (W03), U22 (W04) |
| `scripts/scenarios/removed-environment-closes-its-toasts.e2e.ts` | U48 (W08), U72 (W12) |
| `scripts/scenarios/start-app.ts` | U48 (W08), U60 (W10) |
| `scripts/scenarios/t3.ts` | U37 (W06), U84 (W14) |
| `vite.config.ts` | U88 (W17), U94 (W21) |

## Verification

**CHECK PASS** — SHA-set parity against current 001_triage.md. 232 take + 768 adapt = 1,000, plus all 25 tracked d1 = 1,025, with 0 missing, 0 extra and 0 duplicate SHAs. No current present/skip SHA has an implementation row. The original 989 and all 25 decision rows are covered once. Rows are ascending inside all 94 lanes.
**GRAPH CHECK PASS** — no intra-wave shared paths across 21 waves; every modeled cross-lane prerequisite in an earlier wave; #1138 is the last and sole row in its wave. Git rev-list proves exact triage set parity for all 1,158 source commits.

Independent coverage check used against the written file from the integration worktree:

```python
from collections import Counter
from pathlib import Path
import re

triage = Path("devlog/_plan/261118_chase_catchup/001_triage.md").read_text()
plan = Path("/tmp/chase1118/030_lanes.md").read_text()
source = re.findall(r"^\| (\d+) \| ([0-9a-f]{11}) \| [^|]+\| (take|adapt|decide|present|skip) \|", triage, re.M)
target = re.findall(r"^\| (\d+) \| ([0-9a-f]{11}) \| (take|adapt|decide · pending d1) \|", plan, re.M)
wanted = Counter((int(n), h, v) for n, h, v in source if v in {"take", "adapt", "decide"})
actual = Counter((int(n), h, v.split(" · ")[0]) for n, h, v in target)
assert wanted == actual and len({h for _, h, _ in target}) == 1025
assert Counter(v for _, _, v in target) == {"take": 232, "adapt": 768, "decide · pending d1": 25}
for block in re.split(r"^### U\d+\s*$", plan, flags=re.M)[1:]:
    rows = [int(n) for n in re.findall(r"^\| (\d+) \| [0-9a-f]{11} \|", block, re.M)]
    assert rows and rows == sorted(set(rows))
print(f"PASS {len(actual)} included, 0 missing, 0 extra, 0 duplicate")
```

NOT RUN: implementation, cherry-pick/merge rehearsal, local test or build suites, CI, P1 or Windows/native runtime checks, independent gpt-6.2-sol sample/C4 audit. Final footprints for unpublished carried lanes remain to be checked at dispatch.
