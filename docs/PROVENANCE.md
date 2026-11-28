# Provenance

All lifted code comes from `goat-si/goat` at origin/dev `437f5b9d38daac712b48ece6965b056be2345277` (2026-11-28), read with
`git show origin/dev:<path>`. GOAT is MIT, forked from T3 Code; see `LICENSE` / `NOTICE`.

| GOAT 2 path | Source path (goat origin/dev) | How |
|---|---|---|
| LICENSE | LICENSE | verbatim |
| NOTICE | NOTICE | verbatim |
| .gitignore | .gitignore | verbatim |
| tsconfig.base.json | tsconfig.base.json | compilerOptions verbatim; @effect/language-service plugin removed |
| packages/contracts/src/baseSchemas.ts | packages/contracts/src/baseSchemas.ts | verbatim |
| packages/contracts/src/secretReference.ts | packages/contracts/src/secretReference.ts | verbatim |
| packages/contracts/src/providerInstance.ts | packages/contracts/src/providerInstance.ts | verbatim |
| packages/contracts/src/model.ts | packages/contracts/src/model.ts | verbatim |
| packages/contracts/src/modelSelection.ts | packages/contracts/src/modelSelection.ts | verbatim |
| packages/contracts/src/botProfile.ts | packages/contracts/src/botProfile.ts | verbatim |
| packages/contracts/src/serverProviderState.ts | packages/contracts/src/serverProviderState.ts | verbatim |
| packages/contracts/src/runtimeMode.ts | packages/contracts/src/providerPolicy.ts | excerpt: RuntimeMode, ProviderInteractionMode |
| packages/contracts/src/providerSession.ts | packages/contracts/src/provider.ts | excerpt: ProviderSessionStatus, ProviderSession |
| packages/contracts/src/serverProvider.ts | packages/contracts/src/server.ts | trimmed excerpt: ServerProviderAuth, ServerProvider (dropped fields listed in file header) |
| packages/provider-icons/src/Icons.tsx | apps/web/src/components/Icons.tsx | excerpt: OpenAI, ClaudeAI, ANTIGRAVITY_ICON_DATA_URL, AntigravityIcon verbatim; `cn` replaced |
| packages/provider-icons/src/providerIconDefs.ts | packages/provider-core/src/client.ts | ProviderIcon, ProviderIconGradient interfaces |
| packages/provider-icons/src/providerIconDefs.ts | packages/provider-{pi,opencode,grok,muse,cursor}/src/client.ts | each `icon` object verbatim |
| packages/provider-icons/src/assets/* | same sources as above | extracted files (svg/png) for design tools |

New in GOAT 2 (no source): packages/runtime-stamp, packages/provider-icons/src/ProviderGlyph.tsx
(mapping modeled on apps/web/src/components/chat/ProviderInstanceIcon.tsx),
packages/provider-icons/src/ProviderChip.tsx, apps/web/src/bot-home/*,
docs/PRD.md, README.md, package/workspace manifests (modeled on goat's
package.json / pnpm-workspace.yaml / catalog).

## Bot face and motion (2026-11-28)

| File | Source | License |
|---|---|---|
| `packages/bot-face/src/facePose.ts` (`facePose` idle/think/work, `blendPose`) | NousResearch/hermes-agent `apps/desktop/src/plugins/hermes-bots/avatar.tsx` (`facePose`, `settlePose`), main as of 2026-11-28 | MIT |
| `packages/bot-face/src/motionTokens.ts` (`EASE_OUT`, `ENTRANCE_SECONDS`) | CopilotKit/OpenBot `app/src/lib/motion.ts` | MIT |
| `docs/DESIGN.md` structure and rules | hermes-agent `apps/desktop/DESIGN.md`; OpenBot `docs/app-guidelines.md`; openmuse `docs/EXPERIENCE.md` | MIT (ideas, paraphrased) |

## goat2-contracts (lane C, 2026-11-28)

Ported to Rust from goat-si/goat `origin/dev` 916b5ccc1b2b6d4ecd991ab1573172bab8fb1cc4 (`packages/contracts/src/`); field
names and literals kept. Full table: `crates/goat2-contracts/PROVENANCE.md`. Generated TypeScript and JSON Schema in
`packages/contracts-rs/` come from these Rust types.

| GOAT 2 path | Source path (goat origin/dev 916b5ccc) | How |
|---|---|---|
| crates/goat2-contracts/src/turn_item.rs | orchestrationV2.ts (TurnItem union, base fields, status, ProviderRef, CommandAction, ProviderFailure/Retry), providerPolicy.ts, chatAttachment.ts, assistantMessagePhase.ts, orchestrationV2Attribution.ts | ported to Rust, 15-variant subset |
| crates/goat2-contracts/src/capabilities.rs | providerCapabilityParts.ts, orchestrationV2.ts capability structs, memory.ts | ported to Rust, same fields and defaults |
| crates/goat2-contracts/src/model.rs | modelSelection.ts, model.ts, providerPolicy.ts (RuntimeMode) | ported to Rust (wire shape) |
| crates/goat2-contracts/src/card.rs (EngineConfig, latestAnswerExcerpt, archivedAt) | orchestrationV2.ts OrchestrationV2AppThread | adapted (reduced card) |
| crates/goat2-contracts/src/log.rs (RunOutcome completed, RequestOutcome approval literals, DecisionOption) | orchestrationV2RunStatus.ts, providerPolicy.ts ProviderApprovalDecision, decisions.ts | ported to Rust |
| crates/goat2-contracts/src/subscribe.rs (AgentSurfaceErrorCode, CommandError) | agentSurface/envelope.ts | ported to Rust |
| crates/goat2-contracts/src/bot.rs (BotProfile, BotRole) | botProfile.ts | adapted (face instead of avatar) |

New in GOAT 2 (no source): goat2-contracts events, Fold, CardFile, subscribe frames and cursors, command frames, limits,
codegen and tests (design: goat2-design prd-src/part1, goat2 structure/).
## goat2-thread-store (lane A, 2026-11-28)

Behaviour ported from GOAT v1 `origin/dev` `916b5ccc1b2b6d4ecd991ab1573172bab8fb1cc4` (read with
`git show origin/dev:<path>`). The store is new Rust code (v1 keeps events in SQLite, GOAT 2 keeps
one folder per thread), so these are rule ports, not code lifts.

| GOAT 2 | v1 source | What carried over |
|---|---|---|
| `crates/goat2-thread-store/src/store.rs` `read_locked` / `lines_after` | `apps/server/src/orchestration-v2/ThreadStream.ts:18`, `:20`, `:100-117` (`decideThreadResume`) | Replay when the cursor is at most 128 events and 1 MiB behind; past the head or over either limit, send one current snapshot instead |
| same, `initial_view` | `apps/server/src/ws.ts:582-590` (`snapshotThenLive`) | No cursor: snapshot first, then live from the snapshot's sequence |
| `subscribe_thread` / `subscribe_cards` | `apps/server/src/ws.ts:592` ("subscribe before reading persisted events", dedupe by sequence) | Live channel registered under the same lock as appends, so no line falls between replay and live |
| `line.rs` `Parsed::Skip`, fold skip | `apps/server/src/ws.ts:499-500` (`skipUnknownEventTypes: true`) | Unknown event types are skipped on replay; later events still apply |
| `read_page` byte budget | `apps/server/src/orchestration-v2/threadHistoryPaging.ts:16-21` (`maxEncodedBytes: 1_048_576`) | Every history page also stops at 1 MiB of encoded lines |
| startup settlement (`Store::open`) | `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:370`, `:389-391` | Requests a dead run was waiting on are closed (v1: `expired`, GOAT 2: `request.resolved` `cancelled`) and the run ends with a restart cause; GOAT 2 splits the run outcome into `interrupted` / `unknown` (owner decision 2026-11-28) |
| `unknown` runs never auto-resent | `apps/server/src/scheduledTasks/ScheduledTaskRuns.ts:338`, `apps/server/src/fleet/admission/PlacementAttempts.ts:321` | A dispatch without recorded acceptance is `unknown` and waits for a person (rerun only on request) |

New in GOAT 2 (no v1 source): per-thread `goat.jsonl` / `card.json` / `blobs/` layout, dirty-mark index
protocol, tail repair, `cards.sqlite` rebuild from folders.
Research for the write path (Aside, 2026-11-28): Linux fsync(2) <https://man7.org/linux/man-pages/man2/fsync.2.html>,
Apple fsync(2), Rust std `library/std/src/sys/fs/unix.rs` (F_FULLFSYNC), LWN <https://lwn.net/Articles/457667/>,
SQLite <https://www.sqlite.org/atomiccommit.html>, <https://www.sqlite.org/pragma.html#pragma_synchronous>,
<https://www.sqlite.org/wal.html>.

## apps/desktop and scripts/build-dev-app.sh (lane G, 2026-11-28)

Source: goat origin/dev `916b5ccc1b2b6d4ecd991ab1573172bab8fb1cc4`, read with `git show origin/dev:<path>`.

| GOAT 2 path | Source path (goat origin/dev) | How |
|---|---|---|
| apps/desktop/src/backend/DesktopBackendRecoveryPolicy.ts | apps/desktop/src/backend/DesktopBackendRecoveryPolicy.ts | verbatim |
| apps/desktop/src/backend/DesktopBackendRecoveryPolicy.test.ts | same path (.test.ts) | cases verbatim; vite-plus `expect` rewritten as node:assert |
| apps/desktop/src/window/rendererNavigation.ts | apps/desktop/src/window/rendererNavigation.ts | verbatim |
| apps/desktop/src/window/DesktopWindowBounds.ts (+ .test.ts) | apps/desktop/src/window/DesktopWindowBounds.ts (+ .test.ts) | verbatim; test assert → node:assert |
| apps/desktop/src/window/mainWindowPlacement.ts (+ .test.ts) | apps/desktop/src/window/mainWindowPlacement.ts (+ .test.ts) | verbatim; test assert → node:assert |
| apps/desktop/src/window/DesktopWindowAppearance.ts | apps/desktop/src/window/DesktopWindowAppearance.ts; `syncMacosWindowButtons` from window/DesktopWindow.ts | adapted: top bar 40 (GOAT 2 decision, v1 52); Effect-based `syncWindowAppearance` / material helpers dropped |
| apps/desktop/src/settings/DesktopAppSettings.ts | apps/desktop/src/settings/DesktopAppSettings.ts | excerpt: MIN/DEFAULT main window size, bounds rule; saved in its own window-state.json |
| apps/desktop/src/window/DesktopApplicationMenu.ts | apps/desktop/src/window/DesktopApplicationMenu.ts | adapted: same template/labels/accelerators; updates, Settings, Paste as Text, browser claim dropped; "Server recovery..." → "Start Host" |
| apps/desktop/src/electron/ElectronProtocol.ts | apps/desktop/src/electron/ElectronProtocol.ts | adapted: scheme helpers, privileges, CSP and asset handler without Effect; schemes goat2 / goat2-dev; legacy T3 schemes, origin migration, Clerk, dev proxy dropped; static content-type table instead of effect Mime; Google Fonts allowed in CSP |
| apps/desktop/src/main.ts (window options, ready-to-show reveal, bounds persistence, zoom ±0.5, zoom-changed, swipe, render-process-gone recovery, development load retry with isRetryableDevelopmentRendererLoadFailure, will-navigate guard, safe external URLs) | apps/desktop/src/window/DesktopWindow.ts, electron/ElectronShell.ts (parseSafeExternalUrl) | adapted: plain Electron instead of Effect services (timers instead of fibers). Deliberate fix: the error page's did-finish-load right after did-fail-load no longer cancels the scheduled retry (v1 code cancels it; seen at runtime on Electron 44) |
| apps/desktop/src/main.ts (single-instance lock, second-instance / open-url queues, app-origin links load in the main window) | apps/desktop/src/app/DesktopClerk.ts | adapted: no Clerk, provider-auth handoff, prompt/pairing/web links (no consumers in GOAT 2 yet) |
| apps/desktop/src/main.ts (About panel, runtime name without parentheses, 12-char commit) | apps/desktop/src/app/DesktopAppIdentity.ts | adapted |
| apps/desktop/scripts/sign-macos-ad-hoc.ts | scripts/sign-macos-ad-hoc.ts | adapted: runs @electron/osx-sign (2.7.0, v1's version) directly instead of as an electron-builder hook |
| apps/desktop/resources/entitlements.mac.plist | scripts/build-desktop-artifact.ts `renderMacEntitlements()` (no passkeys) | verbatim output |
| scripts/build-dev-app.sh (Info.plist: NSAutoFill…OneTimeCode, usage descriptions, CFBundleURLTypes) | scripts/build-desktop-artifact.ts (mac.extendInfo, mac.protocols), scripts/lib/mac-command-usage-descriptions.ts | adapted: "GOAT" → "GOAT 2"; web-browser document types, http/https handlers and screen-capture text dropped |

Not lifted, with reason: electron-builder packaging (scripts/build-desktop-artifact.ts, 4,590 lines, DMG/zip/updates/notarization;
the Dev app is an ad-hoc local install and the lane brief asks for a small script), auto-updates, tray, in-app browser/preview,
computer use, WSL/SSH, Clerk; v1 renderer-titled windows (deliberate difference: the Dev title carries the build and host state);
v1's on-disk recovery record (the GOAT 2 host record lives in memory; quitting ends the work).

New in GOAT 2 (no source): apps/desktop/src/hostSupervisor.ts (+ tests, fake host), preload.cts (`window.goat2Host`),
host start/quit/title logic in main.ts, scripts/build-dev-app.sh assembly (renamed Electron.app, bundle ids, build stamp,
install, checks).

## GOAT v1 UI in thread mode (source goat origin/dev 916b5ccc1b2)

Thread mode (T0 1N65-1, T1 1NEM-1, T4 1OXX-1) is drawn from Paper boards the design owner rebuilt from a
code-derived spec of these v1 files: `components/Sidebar.tsx` (Activity view: Priority / Threads / Working),
`components/sidebar/SidebarThreadRow.tsx`, `chat/ChatHeader.tsx` (breadcrumb), `chat/MessagesTimeline.tsx`
(user bubble, assistant text), `chat/TimelineWorkGroupRows.tsx` (WorkingTimelineRow "Working for <timer>"),
`chat/WorkLog.tsx` (work rows: Explored / Edited +n −n / Ran / Failed / Running shimmer), `chat/TurnFoldLabel.tsx`
("Worked for {duration}", "You stopped after {duration}"), `chat/ChatComposer.tsx` + `ComposerSurface.tsx`
(composer card, + / Full access / model / effort / stop), `chat/QueuedRunsControl.tsx` + `ComposerBanner.tsx`
(Queued header, rows with grip / Edit / Steer / Delete), Solar Linear icons, `-apple-system` font.
`scripts/paper-parts.py` turns those boards into `apps/web/src/paper/parts.tsx`; `apps/web/src/threads/ThreadMode.tsx`
maps GOAT 2 data (cards, log lines, queue, commands) onto them. Dropped from v1 here: markdown rendering,
attachments, virtualized lists, thread menus, pinning, PR/machine metadata (machines Planned).

## goat2-host MCP (lane E)

The sources below were read at GOAT v1 `916b5ccc1b2b6d4ecd991ab1573172bab8fb1cc4`.
Each registry entry keeps the GOAT 2 input schema and its implemented authority and replay rules.

| GOAT 2 entry or literal | GOAT v1 source | Treatment |
|---|---|---|
| `surface.describe` | `packages/contracts/src/agentSurface/surfaceEntries.ts:57` | trimmed: guide for the local 11-path surface; summary verbatim; description trimmed for supported path-list behavior |
| `surface.call` | `packages/contracts/src/agentSurface/surfaceEntries.ts:75`, `entries/surface.ts:6` | trimmed: guide to implemented dispatch; summary, description, effect and idempotency reason verbatim |
| `thread.start` | `packages/contracts/src/agentSurface/entries/task.ts:5` | trimmed: local Codex only, depth one, four children, GOAT 2 arguments and process-local key reservation; GOAT 2 name and write effect retained |
| `thread.send` | `packages/contracts/src/agentSurface/entries/thread.ts:236` | trimmed: own children, GOAT 2 text/modes and local key reservation and write effect; summary and annotations verbatim |
| `thread.read` | `packages/contracts/src/agentSurface/entries/thread.ts:171` | trimmed: own children and sequence pagination; summary and annotations verbatim |
| `thread.list` | `packages/contracts/src/agentSurface/entries/thread.ts:132` | trimmed: own children and includeFinished only; summary and annotations verbatim |
| `thread.wait` | `packages/contracts/src/agentSurface/entries/thread.ts:290` | trimmed: own children, completion and 60-second limit; summary and annotations verbatim |
| `thread.stop` | `packages/contracts/src/agentSurface/entries/thread.ts:353` | trimmed: closest v1 `thread.interrupt`, own child and threadId only; GOAT 2 name retained; summary and annotations verbatim |
| `thread.report_result` | `packages/contracts/src/agentSurface/entries/thread.ts:681` | trimmed: worker only, outcome and summary only; example for blocked result and annotations verbatim |
| `user.send` | `packages/contracts/src/agentSurface/entries/channel.ts:85` | trimmed: no equivalent `send_to_user` registry entry found; GOAT 2 once-per-run notification is distinct from v1 channel ingress |
| `request.ask` | `packages/contracts/src/agentSurface/entries/decision.ts:39` | trimmed: closest v1 `decision.request`; GOAT 2 question/approval/decision kinds, summary/detail, optional options, GOAT 2 name and thread.read reconciliation |
| `thread_not_found` | `packages/contracts/src/agentSurface/envelope.ts:116` | verbatim: not_found, not retryable |
| `thread_not_sendable` | `packages/contracts/src/agentSurface/envelope.ts:121` | verbatim: conflict, not retryable |
| `invalid_params` | `packages/contracts/src/agentSurface/envelope.ts:156` | verbatim: invalid_request, not retryable |
| `idempotency_mismatch` | `packages/contracts/src/agentSurface/envelope.ts:263` | verbatim: conflict, not retryable; replaces idempotency_conflict |
| `outcome_unknown` | `packages/contracts/src/agentSurface/envelope.ts:265` | verbatim: unknown_outcome, not retryable; replaces reservation_lost |
| `child_budget` | `packages/contracts/src/agentSurface/envelope.ts:133` | trimmed: GOAT 2 PRD fixes child_budget; v1 equivalent is capacity_exceeded, resource_exhausted, retryable |
| `depth_limit` | `packages/contracts/src/agentSurface/envelope.ts:109` | trimmed: GOAT 2-specific refusal; no matching declared v1 failure class identified |
| `not_your_child` | `packages/contracts/src/agentSurface/envelope.ts:109` | trimmed: GOAT 2-specific refusal; no matching declared v1 failure class identified |
| `no_active_run` | `packages/contracts/src/agentSurface/envelope.ts:109` | trimmed: GOAT 2-specific refusal; no matching declared v1 failure class identified |
| `stale_process_generation` | `packages/contracts/src/agentSurface/envelope.ts:109` | trimmed: GOAT 2-specific refusal; no matching declared v1 failure class identified |
| `stale_host_generation` | `packages/contracts/src/agentSurface/envelope.ts:109` | trimmed: GOAT 2-specific refusal; no matching declared v1 failure class identified |
| `already_sent` | `packages/contracts/src/agentSurface/envelope.ts:109` | trimmed: GOAT 2-specific refusal; no matching declared v1 failure class identified |
| `not_a_worker` | `packages/contracts/src/agentSurface/envelope.ts:109` | trimmed: GOAT 2-specific refusal; no matching declared v1 failure class identified |
| `payload_too_large` | `packages/contracts/src/agentSurface/envelope.ts:109` | trimmed: GOAT 2-specific refusal; no matching declared v1 failure class identified |

V1's description budget is 400 characters (`packages/contracts/src/agentSurface/descriptionBudget.ts:2`).

## goat2-host core (lane E, 2026-11-28)

Behaviour ported from goat-si/goat `origin/dev` 916b5ccc1b2b6d4ecd991ab1573172bab8fb1cc4, re-written in Rust (no code copied;
the v1 sources are TypeScript/Effect). New logic only where a GOAT 2 decision differs (PRD Part 1, `docs/lanes/PART1.md`).

| GOAT 2 path | v1 source (916b5ccc) | How |
|---|---|---|
| crates/goat2-host/src/core/actor.rs (steer_now: declined steer stays queued, same inputId, next turn) | apps/server/src/orchestration-v2/EffectWorker.ts:310-360, SteeringDeclined.integration.test.ts:217-263 | ported behaviour |
| crates/goat2-host/src/core/actor.rs (turn start / steer refused for an unowned native turn fails closed) | apps/server/src/orchestration-v2/Adapters/CodexTurnStartGuard.ts:39,113-172 | ported behaviour; recorded as `input.delivered refused` |
| crates/goat2-host/src/core/actor.rs (Stop: interrupt, hold the queue, stop wait-mode children, async keep running; next send or resume releases) | packages/contracts/src/orchestrationV2.ts:3231-3242 (run.interrupt holdQueue), apps/server/src/orchestration-v2/ChildNeedsStop.ts:5-50 | ported behaviour (pre-running children counted as v1 ChildNeedsStop.ts:10) |
| crates/goat2-host/src/core/mcp_ops.rs (thread.start mode async/wait, wait releases on completion/timeout, child keeps running) | packages/contracts/src/agentSurface/entries (task.create guide), apps/server/src/orchestration-v2/Orchestrator.ts:10255 | ported behaviour, trimmed to GOAT 2 args |
| crates/goat2-host/src/core/mcp_ops.rs (caller is server-issued, never from arguments) | apps/server/src/mcp/McpInvocationContext.ts (McpThreadCaller) | ported rule; caller = (thread, active run, process generation) |
| crates/goat2-host/src/api/envelope.rs | packages/contracts/src/agentSurface/envelope.ts (AgentSurfaceResult, AgentSurfaceError) | three shapes ported; codes from goat2-contracts AgentSurfaceErrorCode |
| crates/goat2-host/src/api/commands.rs (Reason -> code) | packages/contracts/src/agentSurface/envelope.ts FAILURE_CLASSES | literal classes ported where v1 has them |
| crates/goat2-host/src/core/commands.rs DEFAULT_RUNTIME_MODE, DEFAULT_CODEX_MODEL | packages/contracts/src/providerPolicy.ts:32, packages/contracts/src/model.ts:126,143 | verbatim values |
| crates/goat2-host/src/core/actor.rs (RequestOpened item into the timeline) | apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:3576-3777 | ported shape (through goat2-engine-api) |

New in GOAT 2 (no v1 source; PRD Part 1 runtime.md/mcp.md decisions): scheduler caps 4 runs / 2 starts with
priority aging and parked waits (core/sched.rs), 4 children per parent and depth 1 (atomic reservation), child wake
coalescing and record-before-wake (core/actor.rs), restart wake with `interrupted_by_restart` (core/settle.rs),
per-(thread, process generation) MCP tokens, stall recorder (stall.rs), engine group memory policy, host launch contract
(server.rs).

## apps/web/src/v1: GOAT v1 lift (lanes F and P2-M, 2026-11-29)

Source: goat-si/goat `origin/dev` 916b5ccc1b2. Layout: v1 `apps/web/src/<X>` -> `apps/web/src/v1/<X>`, v1 `packages/<pkg>/src/<Y>` -> `apps/web/src/v1/packages/<pkg>/src/<Y>`.
Every lifted file is **verbatim** (byte-identical, imports included). The exact file list is `scripts/v1-lift.d/*.txt` (base.txt and providers.txt P2-M, timeline.txt and contracts.txt lane F) plus the pure modules `scripts/v1-lift.py` lifts transitively (AUTO_LIFT); `python3 scripts/v1-lift.py --check` fails if any lifted file differs from v1. Imports that leave the lift set resolve to the bridges below through `src/v1/aliases.json` (generated) or one-line re-export files at the mirrored path.

Lifted: 708 files.

| GOAT 2 path (under apps/web/src/v1/) | v1 path @916b5ccc | files | How |
|---|---|---|---|
| *.ts (top level) | apps/web/src/*.ts | 18 | verbatim |
| appearance/ | apps/web/src/appearance/ | 1 | verbatim |
| assets/fonts/ | apps/web/src/assets/fonts/ | 1 | verbatim |
| browser/ | apps/web/src/browser/ | 1 | verbatim |
| components/ | apps/web/src/components/ | 7 | verbatim |
| components/chat/ | apps/web/src/components/chat/ | 49 | verbatim |
| components/pullRequest/ | apps/web/src/components/pullRequest/ | 1 | verbatim |
| components/settings/ | apps/web/src/components/settings/ | 39 | verbatim |
| components/solar/ | apps/web/src/components/solar/ | 4 | verbatim |
| components/ui/ | apps/web/src/components/ui/ | 33 | verbatim |
| desktop/ | apps/web/src/desktop/ | 1 | verbatim |
| hooks/ | apps/web/src/hooks/ | 5 | verbatim |
| lib/ | apps/web/src/lib/ | 11 | verbatim |
| notes/ | apps/web/src/notes/ | 1 | verbatim |
| packages/client-runtime/src/ (files) | packages/client-runtime/src/ | 17 | verbatim |
| packages/client-runtime/src/environment/ | packages/client-runtime/src/environment/ | 3 | verbatim |
| packages/client-runtime/src/errors/ | packages/client-runtime/src/errors/ | 6 | verbatim |
| packages/client-runtime/src/goatBot/ | packages/client-runtime/src/goatBot/ | 8 | verbatim |
| packages/client-runtime/src/state/ | packages/client-runtime/src/state/ | 9 | verbatim |
| packages/client-runtime/src/work-log/ | packages/client-runtime/src/work-log/ | 12 | verbatim |
| packages/contracts/src/ (files) | packages/contracts/src/ | 301 | verbatim |
| packages/contracts/src/agentSurface/ | packages/contracts/src/agentSurface/ | 69 | verbatim |
| packages/contracts/src/fixtures/ | packages/contracts/src/fixtures/ | 1 | verbatim |
| packages/contracts/src/test-snapshots/ | packages/contracts/src/test-snapshots/ | 1 | verbatim |
| packages/contracts/src/testing/ | packages/contracts/src/testing/ | 2 | verbatim |
| packages/provider-acp-registry/src/ (files) | packages/provider-acp-registry/src/ | 3 | verbatim |
| packages/provider-claude-cloud/src/ (files) | packages/provider-claude-cloud/src/ | 1 | verbatim |
| packages/provider-core/src/ (files) | packages/provider-core/src/ | 1 | verbatim |
| packages/provider-cursor/src/ (files) | packages/provider-cursor/src/ | 2 | verbatim |
| packages/provider-devin-cloud/src/ (files) | packages/provider-devin-cloud/src/ | 2 | verbatim |
| packages/provider-fx/src/ (files) | packages/provider-fx/src/ | 2 | verbatim |
| packages/provider-grok/src/ (files) | packages/provider-grok/src/ | 2 | verbatim |
| packages/provider-muse/src/ (files) | packages/provider-muse/src/ | 2 | verbatim |
| packages/provider-opencode/src/ (files) | packages/provider-opencode/src/ | 2 | verbatim |
| packages/provider-pi/src/ (files) | packages/provider-pi/src/ | 4 | verbatim |
| packages/shared/src/ (files) | packages/shared/src/ | 64 | verbatim |
| packages/source-control-azure-devops/src/shared/ | packages/source-control-azure-devops/src/shared/ | 2 | verbatim |
| packages/source-control-bitbucket/src/shared/ | packages/source-control-bitbucket/src/shared/ | 2 | verbatim |
| packages/source-control-core/src/shared/ | packages/source-control-core/src/shared/ | 2 | verbatim |
| packages/source-control-cursor-origin/src/shared/ | packages/source-control-cursor-origin/src/shared/ | 2 | verbatim |
| packages/source-control-definitions/src/ (files) | packages/source-control-definitions/src/ | 1 | verbatim |
| packages/source-control-forgejo/src/shared/ | packages/source-control-forgejo/src/shared/ | 2 | verbatim |
| packages/source-control-gitcafe/src/shared/ | packages/source-control-gitcafe/src/shared/ | 2 | verbatim |
| packages/source-control-github/src/shared/ | packages/source-control-github/src/shared/ | 4 | verbatim |
| packages/source-control-gitlab/src/shared/ | packages/source-control-gitlab/src/shared/ | 3 | verbatim |
| state/ | apps/web/src/state/ | 2 | verbatim |

### Bridges (seam modules, apps/web/src/v1/seam/)

Each seam file's header states the v1 path it replaces and why; the summary is that header.

| Seam file | Replaces (v1 @916b5ccc) | Why |
|---|---|---|
| V1Boundary.tsx | - | The [data-v1] boundary every lifted v1 surface renders inside: v1 tokens, base text and preflight apply only here (postcss.config.js). Portals without a container go to the matching [data-v1-portal] root (seam/base-ui). |
| composerDraftStore.ts | apps/web/src/composerDraftStore.ts | Seam for v1 apps/web/src/composerDraftStore.ts (goat 916b5ccc1b2), shared by lanes F and P2-M. v1's 4,000-line draft store is not carried: GOAT 2 keeps drafts in its own composer. DraftId keeps v1's schema (composerDraftStore.ts:138). The lifted TraitsPicker is always given onModelOptionsChange in GOAT 2, so it never writes options into a draft. |
| composerHandleContext.ts | apps/web/src/composerHandleContext.ts | Seam for v1 apps/web/src/composerHandleContext.ts (goat 916b5ccc1b2). v1 hands menus the chat composer's handle so a closing menu can refocus the editor; GOAT 2's composer is not the v1 ChatComposer, so there is no handle and menus keep their own focus return (v1 composerEventScope.ts:20-21 handles a null handle). |
| localApi.ts | apps/web/src/localApi.ts | Seam for v1 apps/web/src/localApi.ts (goat 916b5ccc1b2): the browser branch of v1 createBrowserLocalApi (localApi.ts:15-40). GOAT 2 (Dev) opens links in the system browser through the Electron window-open handler. |
| npm-aliases.json | npm specifiers | Hand-written map of npm modules answered by the seam (@tanstack/react-router); merged into the alias map by vite-plugin-v1.ts and tsconfig.v1.paths.json. |
| v1-entry.css | - | Entry for the v1 CSS (devlog 070 audit-3 residual): the copied v1 index.css stays byte-identical; Tailwind's source |
| base-ui/combobox.parts.ts | @base-ui/react/combobox | Bridge (docs/PROVENANCE.md): @base-ui/react/combobox parts with Portal mounted into the v1 portal root. The real package is imported by its file path so the alias map (which points @base-ui/react/combobox here) cannot recurse. |
| base-ui/combobox.ts | @base-ui/react/combobox | Bridge (docs/PROVENANCE.md): stands in for @base-ui/react/combobox inside src/v1; same exports, Combobox.Portal wrapped. |
| base-ui/context-menu.parts.ts | @base-ui/react/context-menu | Bridge (docs/PROVENANCE.md): @base-ui/react/context-menu parts with Portal mounted into the v1 portal root. The real package is imported by its file path so the alias map (which points @base-ui/react/context-menu here) cannot recurse. |
| base-ui/context-menu.ts | @base-ui/react/context-menu | Bridge (docs/PROVENANCE.md): stands in for @base-ui/react/context-menu inside src/v1; same exports, ContextMenu.Portal wrapped. |
| base-ui/dialog.parts.ts | @base-ui/react/dialog | Bridge (docs/PROVENANCE.md): @base-ui/react/dialog parts with Portal mounted into the v1 portal root. The real package is imported by its file path so the alias map (which points @base-ui/react/dialog here) cannot recurse. |
| base-ui/dialog.ts | @base-ui/react/dialog | Bridge (docs/PROVENANCE.md): stands in for @base-ui/react/dialog inside src/v1; same exports, Dialog.Portal wrapped. |
| base-ui/menu.parts.ts | @base-ui/react/menu | Bridge (docs/PROVENANCE.md): @base-ui/react/menu parts with Portal mounted into the v1 portal root. The real package is imported by its file path so the alias map (which points @base-ui/react/menu here) cannot recurse. |
| base-ui/menu.ts | @base-ui/react/menu | Bridge (docs/PROVENANCE.md): stands in for @base-ui/react/menu inside src/v1; same exports, Menu.Portal wrapped. |
| base-ui/popover.parts.ts | @base-ui/react/popover | Bridge (docs/PROVENANCE.md): @base-ui/react/popover parts with Portal mounted into the v1 portal root. The real package is imported by its file path so the alias map (which points @base-ui/react/popover here) cannot recurse. |
| base-ui/popover.ts | @base-ui/react/popover | Bridge (docs/PROVENANCE.md): stands in for @base-ui/react/popover inside src/v1; same exports, Popover.Portal wrapped. |
| base-ui/portalRoot.ts | - | Bridge (docs/PROVENANCE.md): lifted v1 ui primitives portal their popups to <body>; GOAT 2 scopes v1 CSS to [data-v1], so a portal without an explicit container mounts into one [data-v1][data-v1-portal] root instead. |
| base-ui/select.parts.ts | @base-ui/react/select | Bridge (docs/PROVENANCE.md): @base-ui/react/select parts with Portal mounted into the v1 portal root. The real package is imported by its file path so the alias map (which points @base-ui/react/select here) cannot recurse. |
| base-ui/select.ts | @base-ui/react/select | Bridge (docs/PROVENANCE.md): stands in for @base-ui/react/select inside src/v1; same exports, Select.Portal wrapped. |
| base-ui/toast.parts.ts | @base-ui/react/toast | Bridge (docs/PROVENANCE.md): @base-ui/react/toast parts with Portal mounted into the v1 portal root. The real package is imported by its file path so the alias map (which points @base-ui/react/toast here) cannot recurse. |
| base-ui/toast.ts | @base-ui/react/toast | Bridge (docs/PROVENANCE.md): stands in for @base-ui/react/toast inside src/v1; same exports, Toast.Portal wrapped. |
| base-ui/tooltip.parts.ts | @base-ui/react/tooltip | Bridge (docs/PROVENANCE.md): @base-ui/react/tooltip parts with Portal mounted into the v1 portal root. The real package is imported by its file path so the alias map (which points @base-ui/react/tooltip here) cannot recurse. |
| base-ui/tooltip.ts | @base-ui/react/tooltip | Bridge (docs/PROVENANCE.md): stands in for @base-ui/react/tooltip inside src/v1; same exports, Tooltip.Portal wrapped. |
| components/ProviderUpdatesAction.tsx | apps/web/src/components/ProviderUpdatesAction.tsx | Seam for v1 apps/web/src/components/ProviderUpdatesAction.tsx (goat 916b5ccc1b2): GOAT 2 has no provider self-update in Part 2, so the action is not shown. |
| components/ThreadTerminalDrawer.tsx | apps/web/src/components/ThreadTerminalDrawer.tsx | Seam for v1 apps/web/src/components/ThreadTerminalDrawer.tsx (goat 916b5ccc1b2): only terminalThemeFromApp, used by the terminal sign-in surface, which GOAT 2 does not have (seam terminal/ghostty/surface.ts). |
| components/chat/ChatGptSharingControl.tsx | apps/web/src/components/chat/ChatGptSharingControl.tsx | Seam for v1 apps/web/src/components/chat/ChatGptSharingControl.tsx (goat 916b5ccc1b2): ChatGPT subscription sharing is a v1 OpenCodex feature GOAT 2 does not have. |
| components/settings/AcpSessionManagementSection.tsx | apps/web/src/components/settings/AcpSessionManagementSection.tsx | Seam for v1 apps/web/src/components/settings/AcpSessionManagementSection.tsx (goat 916b5ccc1b2): importing native ACP sessions is not in GOAT 2 Part 2. |
| components/settings/ChatGptConnectionButton.tsx | apps/web/src/components/settings/ChatGptConnectionButton.tsx | Seam for v1 apps/web/src/components/settings/ChatGptConnectionButton.tsx (goat 916b5ccc1b2): ChatGPT connection is a v1 OpenCodex feature GOAT 2 does not have. |
| components/settings/CodexSetupSection.tsx | apps/web/src/components/settings/CodexSetupSection.tsx | Seam for v1 apps/web/src/components/settings/CodexSetupSection.tsx (goat 916b5ccc1b2): v1 shows these only for managed Codex accounts (OpenCodex Home, setupMode "managed"); GOAT 2 Codex uses the signed-in codex CLI (setupMode "existing"), so they render nothing. Props are v1's (CodexSetupSection.types.ts). |
| components/settings/ProviderCodexHomeRouteSection.tsx | apps/web/src/components/settings/ProviderCodexHomeRouteSection.tsx | Seam for v1 apps/web/src/components/settings/ProviderCodexHomeRouteSection.tsx (goat 916b5ccc1b2): OpenCodex Home routing is a v1-only service, so the section is not shown. Callback props keep v1's types (:8-20). |
| components/settings/ProviderHostMatrix.commands.ts | apps/web/src/components/settings/ProviderHostMatrix.commands.ts | Seam for v1 apps/web/src/components/settings/ProviderHostMatrix.commands.ts (goat 916b5ccc1b2): GOAT 2 has one host, so the sync command is never permitted (its permission atom is false and v1 hides the action) and refuses with that reason if run. |
| components/settings/ProviderHostSyncDialog.tsx | apps/web/src/components/settings/ProviderHostSyncDialog.tsx | Seam for v1 apps/web/src/components/settings/ProviderHostSyncDialog.tsx (goat 916b5ccc1b2): GOAT 2 has one host; there is nothing to sync providers to. |
| components/settings/SecretReferencePicker.tsx | apps/web/src/components/settings/SecretReferencePicker.tsx | Seam for v1 apps/web/src/components/settings/SecretReferencePicker.tsx (goat 916b5ccc1b2): v1 secret references are behind GOAT_FEATURE_SECRETS (off), and GOAT 2 has no secret store, so the picker is not shown. Props are v1's (:25-35). |
| components/settings/SecretsSettings.tsx | apps/web/src/components/settings/SecretsSettings.tsx | Seam for v1 apps/web/src/components/settings/SecretsSettings.tsx (goat 916b5ccc1b2): v1 secrets are behind GOAT_FEATURE_SECRETS (off), and GOAT 2 has no secret store. |
| components/settings/SettingInheritance.tsx | apps/web/src/components/settings/SettingInheritance.tsx | Seam for v1 apps/web/src/components/settings/SettingInheritance.tsx (goat 916b5ccc1b2): project overrides do not exist in GOAT 2 (one environment, no project settings), so nothing is inherited or overridden. |
| components/settings/SettingsPageLead.tsx | apps/web/src/components/settings/SettingsPageLead.tsx | Seam for v1 apps/web/src/components/settings/SettingsPageLead.tsx (goat 916b5ccc1b2). v1 picks the lead from the router path; GOAT 2 has one settings page here, so the providers lead is fixed. Markup and the first sentence of the text are v1's (settingsNav.ts:67-72); the OpenCodex Home sentence and Hub link are v1-only and dropped. |
| components/settings/SettingsScopeContext.tsx | apps/web/src/components/settings/SettingsScopeContext.tsx | Seam for v1 apps/web/src/components/settings/SettingsScopeContext.tsx (goat 916b5ccc1b2): GOAT 2 renders settings for its one environment without v1's scope picker, so no scope provider is mounted and useOptionalSettingsScope() is null, the case v1's settingsLayout already handles. The value type keeps the fields v1 readers use. |
| components/settings/SettingsScopeSentence.tsx | apps/web/src/components/settings/SettingsScopeSentence.tsx | Seam for v1 apps/web/src/components/settings/SettingsScopeSentence.tsx (goat 916b5ccc1b2): GOAT 2 has one environment and no project scopes, so there is no scope to describe. |
| components/settings/TextGeneratorAndUsageSettings.tsx | apps/web/src/components/settings/TextGeneratorAndUsageSettings.tsx | Seam for v1 apps/web/src/components/settings/TextGeneratorAndUsageSettings.tsx (goat 916b5ccc1b2): usage limits are outside Part 2 (PRD part2/providers, usage row). |
| components/settings/scopedSettings.ts | apps/web/src/components/settings/scopedSettings.ts | Seam for v1 apps/web/src/components/settings/scopedSettings.ts (goat 916b5ccc1b2): GOAT 2 has no project-scoped settings, so no key is project scoped, nothing is mixed and every value comes from the environment. Types keep v1's shapes (scopedSettings.ts:33-43, 84-91, 166, 382-385). |
| components/settings/settingsSearch.ts | apps/web/src/components/settings/settingsSearch.ts | Seam for v1 apps/web/src/components/settings/settingsSearch.ts (goat 916b5ccc1b2): v1's settings search registry (1,397 lines across every settings page) is not carried; the provider page's rows keep v1's anchor ids and titles. |
| components/settings/useScopedSettings.ts | apps/web/src/components/settings/useScopedSettings.ts | Seam for v1 apps/web/src/components/settings/useScopedSettings.ts (goat 916b5ccc1b2): with no project overrides (seam scopedSettings.ts) there is nothing to clear. |
| components/settings/useTranslatedSearchableSetting.ts | apps/web/src/components/settings/useTranslatedSearchableSetting.ts | Seam for v1 apps/web/src/components/settings/useTranslatedSearchableSetting.ts (goat 916b5ccc1b2): GOAT 2 is English first (owner rule), so titles are returned as registered. |
| connection/desktopLocal.ts | apps/web/src/connection/desktopLocal.ts | Seam for v1 apps/web/src/connection/desktopLocal.ts (goat 916b5ccc1b2): GOAT 2's one environment is its own local host, never a v1 desktop-local backend or WSL distro. |
| environments/primary/target.ts | apps/web/src/environments/primary/target.ts | Seam for v1 apps/web/src/environments/primary/target.ts (goat 916b5ccc1b2): GOAT 2 (Dev) always talks to the host its desktop shell started, which v1 calls a desktop-managed primary target. |
| fixture/V1Fixture.tsx | - | ?v1fixture: checks the v1 CSS scoping and portal root (e2e/v1fixture.spec.ts). A v1 Button, text-work-log text, an open Popover and an open Tooltip inside the boundary; identical plain elements outside it keep browser defaults. |
| goat2/environment.ts | - | GOAT 2 runs one local host per app (docs/lanes/PART1.md fixed decisions), so the lifted v1 screens see exactly one environment: this machine, whose owner holds every scope. |
| goat2/globals.d.ts | apps/web/src/vite-env.d.ts | v1 apps/web/src/vite-env.d.ts (goat 916b5ccc1b2) global declarations the lifted files compile against. GOAT 2's shell never sets window.desktopBridge (the lifted env.ts then reports isElectron = false), so these paths stay inert. |
| goat2/providerPort.ts | - | GOAT 2 seam: the one place provider data enters the lifted v1 provider screens (P2-M). The lifted v1 code reads providers through v1 atoms (state/server.ts serverEnvironment.*) and calls v1 WS methods. The GOAT 2 app installs a ProviderPort that answers those methods from the GOAT 2 host (or the fake host scene) and pushes provider entries; this file turns entries into v1 ServerProvider values (decoded with the lifte |
| goat2/surfaces.ts | - | @v1/surfaces: every lifted v1 surface GOAT 2 mounts, typed against surfaces.types.ts (see there). Also the typecheck entry of tsconfig.v1.json, so the v1 provider screens are checked even before a GOAT 2 frame mounts them. |
| goat2/surfaces.types.ts | - | The typed boundary between GOAT 2 code and the lifted v1 tree (@v1/surfaces). GOAT 2's tsconfig resolves @v1/surfaces to this file, so its typecheck never walks v1 internals (v1 needs its own compiler options); vite resolves it to surfaces.ts, and tsconfig.v1.json checks that surfaces.ts implements exactly these declarations. Declarations only, valid under both compiler setups. |
| hooks/useSettings.ts | apps/web/src/hooks/useSettings.ts | Seam for v1 apps/web/src/hooks/useSettings.ts (goat 916b5ccc1b2): the settings hooks the lifted provider screens use. Server settings live behind the GOAT 2 provider port (server.updateSettings); client settings stay in this browser (localStorage), as v1's browser client does. v1's multi-environment shared-settings sync, project overrides and legacy migrations are not carried: GOAT 2 has one environment. |
| hooks/useThreadRouteTarget.ts | apps/web/src/hooks/useThreadRouteTarget.ts | Seam for v1 apps/web/src/hooks/useThreadRouteTarget.ts (goat 916b5ccc1b2): GOAT 2 does not use v1's router, so toasts never scope themselves to a v1 thread route. The type is v1's (threadRoutes.ts:8-20). |
| npm/tanstack-react-router.ts | @tanstack/react-router | Seam for the npm module @tanstack/react-router, which lifted v1 files import (settingsLayout, ModelPickerProviderNotices). GOAT 2 has its own navigation (apps/web/src/ui-state), so this module answers v1's two hooks: useLocation reads the location the GOAT 2 frame sets, and useNavigate hands v1 paths to the GOAT 2 frame (setGoat2Navigator). |
| packages/client-runtime/src/connection/index.ts | packages/client-runtime/src/connection | Seam for v1 packages/client-runtime/src/connection (goat 916b5ccc1b2). v1's connection catalog (SSH, relay, hub proxy routes, credential profiles) is not carried: GOAT 2 has one local host, which v1 calls the primary target, with no profile and no extra routes. Type shapes follow v1 model.ts/catalog.ts; connectionStatusTitle keeps v1's phase wording (presentation.ts:17-24). |
| packages/client-runtime/src/environment/index.ts | @goat/client-runtime/environment | Bridge for v1 @goat/client-runtime/environment (packages/client-runtime/src/environment/index.ts, docs/PROVENANCE.md). Re-exports the three pure, byte-identical lifted modules. v1's descriptor.ts (environment descriptor fetch over the v1 HTTP RPC client) is left out: GOAT 2 has one local host and no v1 environment HTTP API. |
| packages/client-runtime/src/state/runtime.ts | packages/client-runtime/src/state/runtime.ts | Seam for v1 packages/client-runtime/src/state/runtime.ts (goat 916b5ccc1b2): only the atom-command surface the lifted provider screens use. Bodies are copied from v1 (runtime.ts:136-156, 199-207, 352-383, 469-496). v1's RPC runtime, connection registry and schedulers are not carried: GOAT 2 commands run through seam/goat2/providerPort.ts. |
| state/entities.ts | apps/web/src/state/entities.ts | Seam for v1 apps/web/src/state/entities.ts (goat 916b5ccc1b2), shared by lanes F and P2-M. The provider screens read projects (ACP custom-model editor) and thread shells (which threads a provider change would stop). GOAT 2 has no v1 projects, and P2-M does not wire thread shells: both lists are empty. |
| state/environments.ts | apps/web/src/state/environments.ts | Seam for v1 apps/web/src/state/environments.ts (goat 916b5ccc1b2): the one GOAT 2 environment, the local host this app's desktop shell started (v1's primary target), connected once the host has sent its provider list. |
| state/server.ts | apps/web/src/state/server.ts | Seam for v1 apps/web/src/state/server.ts + packages/client-runtime/src/state/server.ts (goat 916b5ccc1b2): the serverEnvironment members the lifted provider screens use, answered by the GOAT 2 provider port. Each command keeps v1's label, input shape ({environmentId, input}) and result schema; results are decoded with the lifted v1 schemas. |
| state/session.ts | apps/web/src/state/session.ts | Seam for v1 apps/web/src/state/session.ts (goat 916b5ccc1b2): session grants for the one GOAT 2 environment. |
| terminal/ghostty/surface.ts | apps/web/src/terminal/ghostty/surface.ts | Seam for v1 apps/web/src/terminal/ghostty/surface.ts (goat 916b5ccc1b2). GOAT 2 has no in-app terminal in Part 2, so a terminal sign-in cannot be shown; creating the surface fails and v1's ProviderAuthTerminal says so ("Could not load the sign-in terminal. Cancel and retry sign-in."). |

### Build wiring for the lifted tree (P2-M for lanes F and P2-M; devlog 070 Revision A2 and audit-3 residuals)

| GOAT 2 path | v1 source @916b5ccc | How / why |
|---|---|---|
| apps/web/vite-plugin-v1.ts | - (new) | Resolves imports from src/v1 through src/v1/aliases.json + seam/npm-aliases.json, so lifted files stay byte-identical; only importers under src/v1 are aliased (GOAT 2 keeps the real @base-ui/react). Also resolves @v1/surfaces for GOAT 2 code. |
| apps/web/tsconfig.v1.paths.json (generated by scripts/v1-lift.py) | - | The same alias map as TypeScript paths; no second hand-kept copy. |
| apps/web/tsconfig.v1.json, tsconfig.v1-all.json | v1 apps/web/tsconfig.json (compiler options) | v1 code needs v1's options (no verbatimModuleSyntax/erasableSyntaxOnly); tsconfig.v1.json typechecks what @v1/surfaces reaches and is part of `pnpm typecheck`; v1-all is the whole tree, not a gate yet. |
| apps/web/src/v1/seam/goat2/surfaces.ts + surfaces.types.ts | - (new) | @v1/surfaces: the only way GOAT 2 code reaches v1. GOAT 2's tsconfig sees the declarations; tsconfig.v1.json checks the implementation against them. |
| apps/web/postcss.config.js + apps/web/v1-css-scope.js | - (new) | @tailwindcss/postcss (source detection limited to src/v1), then postcss-prefix-selector on src/v1 CSS only: :root/:host -> [data-v1]; html/body -> [data-v1-body] (v1 page rules: height 100%, overflow hidden, position relative, 100svh, grain; opt-in for a full-page v1 surface); every other top-level rule -> :where([data-v1]) <sel>. Class rules are scoped too because v1 uses @theme inline (utilities carry literal values, e.g. text-work-log 0.78125rem, and would style GOAT 2 elements); :where() adds no specificity, so v1's cascade is unchanged. .dark variants never activate. |
| apps/web/src/v1/seam/v1-entry.css | apps/web/src/index.css (imported unchanged) | @import of the byte-identical index.css + @source for src/v1; plus v1's body typography (font-family var(--font-sans), color var(--foreground)) on every [data-v1], since body maps to the opt-in [data-v1-body]; and pointer-events back for portal descendants (zero specificity, v1's pointer-events-none still wins). |
| apps/web/src/v1/seam/V1Boundary.tsx | - (new) | The [data-v1] element a v1 surface renders inside; imports v1-entry.css. |
| apps/web/src/v1/seam/base-ui/portalRoot.ts + base-ui/<part>.ts, <part>.parts.ts (combobox, context-menu, dialog, menu, popover, select, toast, tooltip) | @base-ui/react/<part> (npm, v1 lock version) | v1 portals go to <body>; GOAT 2 scopes v1 CSS, so a Portal without a container (tooltip passes container={undefined}) mounts into one [data-v1][data-v1-portal] root under <body>: fixed, viewport-sized like body (shrink-to-fit popups keep their width), pointer-events none on the root itself. The real package is imported by file path (no alias recursion); named namespaces and Portal.Props/State types kept. Only parts that render a Portal are wrapped (scripts/v1-lift.py detects them). |
| apps/web/src/main.tsx (v1-entry.css import, ?v1fixture) | - | v1 CSS loads with the app, so the 7 bot-home pixel baselines (maxDiffPixels 0) prove it leaks nothing; ?v1fixture mounts seam/fixture/V1Fixture.tsx for e2e/v1fixture.spec.ts (tokens inside, browser defaults outside, both popups painted inside the portal root). |
| apps/web/e2e/baseline.spec.ts-snapshots/*.png | - | Recaptured on mac-studio from clean goat2_ui 6f79579 (the origin-Mac captures differ by font rasterization before any change). |

Global names (audit-3 residual): v1's @keyframes (fleet-*, goat-arrive, goat-mobile-*, goat-onboarding-signal, live-activity-focus*, live-tool-shine, preview-loading-progress, scroll-edge-fade, settings-search-target-pulse, sidebar-drag-label-reveal, status-ping, status-pulse, Tailwind's spin) and the Pretendard @font-face stay global. Checked against GOAT 2 CSS and inline styles (apps/web/src outside v1, packages/*): GOAT 2 defines and uses only goat2-spin and goat2-chip-spin and never names Pretendard, so nothing collides.
