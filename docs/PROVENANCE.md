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

| crates/goat2-contracts/src/card.rs (EngineDriver kinds, Part 2) | apps/web/src/components/settings/providerDriverMeta.ts (ProviderDriverKind values) | ported to Rust |
| crates/goat2-contracts/src/probe.rs | server.ts (ServerProvider subset, ServerProviderAuth, ServerProviderModel), serverProviderState.ts, model.ts, acpRegistry.ts (AcpRegistryUrlAuthAction) | ported to Rust |
| crates/goat2-contracts/src/decision.rs | decisions.ts, agentSurface/entries/decision.ts | adapted (local only, no requiredProfile) |
| crates/goat2-contracts/src/attention.rs | channelBotAttention.ts | adapted (taskId -> threadId) |

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

## goat2-engine-codex (lane B, 2026-11-28)

Behaviour ported to Rust from GOAT v1 `origin/dev` `916b5ccc1b2b6d4ecd991ab1573172bab8fb1cc4` (read with
`git show origin/dev:<path>`). `A` = `apps/server/src/orchestration-v2/Adapters/`, `P` = `apps/server/src/provider/`.
Each Rust function carries its v1 file:line in a comment; the research map is
`devlog/_plan/261128_goat2-engine-codex/005_v1_port_map.md`.

| GOAT 2 path | v1 source (origin/dev 916b5ccc) | How |
|---|---|---|
| `crates/goat2-engine-codex/src/capabilities.rs`, `tests/fixtures/v1-codex-capabilities.json` | A/CodexCapabilities.ts | ported to Rust, every flag equal (test compares the whole snapshot) |
| `src/transport.rs` request deadlines and liveness | A/CodexRequestDeadline.ts, finiteProviderRequest.ts | ported to Rust (same per-method deadlines; delivery calls never time out into a resend) |
| `src/engine.rs` turn start guard, late turn-start answers, steer outcomes | A/CodexTurnStartGuard.ts:39-219, A/CodexAdapterV2.ts:6597-6640 | ported to Rust (refuse a start onto a native turn GOAT never owned; 10 s stop wait; 5 s turn-list bound; interrupt a late turn only if no newer attempt owns it) |
| `src/engine.rs` process exit, launch arguments, client identity | A/CodexAppServerExit.ts, codexLaunchArgs.ts, P/CodexClientIdentity.ts | ported to Rust (`app-server -c thread_unload_delay_secs=0`, `T3 Code` client identity, open requests close on exit) |
| `src/runtime.rs` runtime mode and model options -> turn/start params | A/CodexTurnStartParams.ts:107-127, P/CodexProvider.ts, codexModelOptions.ts | ported to Rust (approval/sandbox policy per runtime mode, reasoning effort, service tier) |
| `src/attachments.rs` turn and steer input items | A/CodexAdapterV2.ts:2636-2696, packages/provider-core/src/server/attachmentPrompt.ts:154-176, A/CodexTextHelpers.ts:14, packages/shared/src/composerInlineTokens.ts:25-30, packages/contracts/src/chatAttachment.ts:18-23 | ported to Rust (attachment paths named in the text, native images as data URLs, unresolvable image declines before sending, currency-sign skill mentions become `$name`); the host supplies the path resolver |
| `src/items.rs` item/completed -> TurnItem | A/CodexAdapterV2.ts:2932-3251,4301-4844, A/CodexItemProjection.ts, A/CodexWebSearch.ts, P/CodexCommandActions.ts | ported to Rust; GOAT 2 keeps tools as name/summary/locator only (no arguments, prompts, output or diff text; commands, file paths, search queries and patterns kept as one line of at most 200 characters, lists at most 50 entries; fixed decision) |
| `src/approvals.rs` approval and question requests, waiting items, answers | A/CodexAdapterV2.ts:1150-1170,3576-3777,4851-5339, A/CodexApprovalResponses.ts, A/CodexFullAccessApproval.ts, P/CodexMcpElicitation.ts | ported to Rust (prompts, options, session allowance cleared on runtime-mode change, full-access auto-accept with network exclusions, elicitation form encoding) |
| `src/transcript.rs`, `src/bin/fake_codex.rs` | packages/effect-codex-app-server/src/replay.ts | ported to Rust (same `expect_outbound` / `emit_inbound` / `runtime_exit` format, `afterMs`, `cancelled`) |
| `src/engine.rs` GOAT MCP injection (`mcp_servers.goat` url + bearer header in thread config) | packages/provider-core/src/server/goatMcpServers.ts | adapted (token per thread and process generation, owner decision) |

New in GOAT 2 (no v1 source): `schema/codex-0.167.0/` (generated by `codex app-server generate-json-schema`) and
`scripts/codex-schema-refresh.sh`; hand-written protocol subset (`src/protocol/`) in place of the
`codex-app-server-protocol` crate (owner decision); per-thread process group with `nice 10`, group kill and group RSS
(`src/process.rs`); fail-closed recording redactor and privacy gate; driver-made recordings of codex 0.167.0; host `SessionSpec.instructions` mapped to Codex developer instructions and `SessionSpec.launch` to binary, arguments and environment (goat2-engine-api Part 2 step 1).


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
| apps/desktop/src/shell/shellEnvironmentCapture.ts | packages/shared/src/shellEnvironmentCapture.ts | verbatim, without the Windows PowerShell builder |
| apps/desktop/src/shell/cliPath.ts (+ .test.ts) | packages/shared/src/cliPath.ts (+ .test.ts) | verbatim (incl. LOGIN_SHELL_RETRY_DELAYS_MS), without the provider "PATH not read" note; pure test cases, assert → node:assert |
| apps/desktop/src/shell/DesktopShellEnvironment.ts (discoverWithRetries, LiveShellProbes) | apps/desktop/src/shell/loginShellRetry.ts | adapted: plain promises; a probe counts from spawn until its exit is seen and its process group is empty; a later answer reaches the next host start, and menu "Restart Host…" (HostSupervisor.restart) applies it to the running host, since the GOAT 2 host has no update channel; app quit stops discovery and SIGKILLs live probe groups (LiveShellProbes.stop) |
| apps/desktop/src/shell/shellPath.ts (+ .test.ts) | packages/shared/src/shell.ts (+ shell.test.ts) | excerpt verbatim: listLoginShellCandidates, mergePathValues and their helpers; their test cases |
| apps/desktop/src/shell/DesktopShellEnvironment.ts | apps/desktop/src/shell/DesktopShellEnvironment.ts (installPosixEnvironment, cache), packages/shared/src/shell.ts (readEnvironmentFromLoginShell, readPathFromLaunchctl) | adapted: no Effect; result written into the host's env object (no update channel, a refresh reaches the next host start); v1-only names (release URL, GOAT/T3 telemetry), Linux DBus and Windows probes dropped; the candidate loop stops before another login shell while an earlier probe has not exited (launchctl still runs) |
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

## Provider and bot runtime contracts (lane C)

Source goat v1 `916b5ccc1b2`: `packages/contracts/src/{providerSetup,acpRegistry,server,rpc,channelBotNotes,channelGateway,botProfile}.ts` and `apps/server/src/channels/ChannelSessionFirst.ts`. Provider and bot runtime shapes are adapted to the additive GOAT 2 wire; detailed lifts and deviations are in `crates/goat2-contracts/PROVENANCE.md`.

## goat2-engine-claude (lane P2-A, 2026-11-28)

Source: `goat-si/goat` origin/dev `916b5ccc1b2`. `A/` = `apps/server/src/orchestration-v2/Adapters/`, `D/` = `apps/server/src/provider/Drivers/`. Wire shapes come from the TS Agent SDK v1 runs (`@anthropic-ai/claude-agent-sdk@0.3.276` `sdk.d.ts`/`sdk.mjs`) and lane D's `docs/parity/claude-stream-json.md`.

| GOAT 2 path | Source | How |
|---|---|---|
| `crates/goat2-engine-claude/src/capabilities.rs`, `tests/fixtures/v1-claude-capabilities.json` | A/ClaudeAdapterV2.ts:436-531 `ClaudeProviderCapabilitiesV2` | ported to Rust, every flag equal; JSON evaluated from the v1 literal, test compares both ways |
| `src/launch.rs` argv | SDK `ProcessTransport.initialize` + A/ClaudeAdapterV2.ts:575-760 `makeClaudeQueryOptions`, :778-830 `claudeMcpQueryOverrides` | ported: stream-json flags, adaptive thinking + summarized display, effort, model, `--permission-prompt-tool stdio`, `--resume=`/`--session-id=`, `--allowedTools mcp__goat__*`, `--tools default`, permission mode, `--include-partial-messages`, `--add-dir`, `--settings` |
| `src/launch.rs` permission mode | A/ClaudeAdapterV2.ts:1338-1384 `permissionModeForClaudeRuntimePolicy` | ported for runtimeMode only (GOAT 2 has no approval/sandbox/interaction policy) |
| `src/launch.rs` launch-arg folds | A/ClaudeAdapterV2.ts:606-621,674-679; A/ClaudeLaunchArgs.ts:56-131 | ported: `--permission-mode`, `--dangerously-skip-permissions`, `--append-system-prompt(-file)` (v1 error texts verbatim), `--settings`, `--add-dir`, `--thinking-display` |
| `src/launch.rs` environment | D/ClaudeHome.ts:49-89 `CLAUDE_HOST_SESSION_VARIABLES`, `mergeClaudeProcessEnvironment` (`CLAUDE_CODE_ENTRYPOINT=t3-code` verbatim); A/claudeMcpProxyBypass.ts; A/ClaudeAdapterV2.ts:533-556 (`MCP_CONNECTION_NONBLOCKING=0` on resume) | ported |
| `src/launch.rs` `CompiledModel` | apps/server/src/claudeModelOptions.ts:31-79 `compileClaudeModelSelection` | adapted: model id as written, `effort`/`thinking`/`fastMode` options; no catalog alias resolution |
| `src/engine.rs` boot | A/ClaudeAgentSdkQueryRunner.ts:75-76 (5 min boot, 90 s MCP), :500-540 (MCP servers sent with `mcp_set_servers` on stdin, never argv or env); A/ClaudeAdapterV2.ts:719-735 (appended system prompt; the SDK sends it as initialize `appendSystemPrompt`) | ported. The lane brief named `--mcp-config`; v1 keeps the bearer out of argv and the owner confirmed following v1 |
| `src/engine.rs` MCP server config | A/ClaudeAdapterV2.ts:778-830 (`goat` http server, `Authorization` header, 65 min `timeout`) | ported |
| `src/engine.rs` turns and steering | A/ClaudeUserMessage.ts; A/ClaudeTurnCursor.ts (synthetic `turn:` ids); A/ClaudeAdapterV2.ts:9899-10061 (steer = `priority:"next"` user frame with uuid, echo = acceptance); A/ClaudePromptFrames.ts:32-84; A/ClaudeSteerLifecycle.ts (hold a result while a steer is queued, drop refused/cancelled/discarded steers) | ported |
| `src/engine.rs` interrupt | A/ClaudeAdapterV2.ts:9755-9815 (active turn only), `CLAUDE_STOP_CONFIRM_TIMEOUT_MS` (10 s) | ported; a turn the CLI does not settle is settled as interrupted after the deadline |
| `src/engine.rs` `can_use_tool` | A/ClaudeAdapterV2.ts:8241-8520 (AskUserQuestion, ExitPlanMode denial text, removal check, approval prompt choice, no-active-turn and computer-use denials); A/ClaudeApproval.ts (presentation, `permissionResultFromDecision`, session grants, removal denial text) | ported; v1 never offers `acceptAlways` to Claude, GOAT 2 reads it as accept-for-session |
| `src/engine.rs` result status and failure text | A/ClaudeResultFailure.ts:13-212 | ported (`terminalResultError` texts verbatim, 429/529 texts); no usage-limit reset-time parsing |
| `src/engine.rs` sign-in message | D/ClaudeHome.ts:131-140 `claudeSignedOutMessage` | verbatim text |
| `src/items.rs` | A/ClaudeToolFrames.ts:72-503 (classification, command/file/summary/web search, subagent report cleanup, async launch ack); A/ClaudeAdapterV2.ts:1917-2016 (questions, answers, todo steps), :2166-2175 (plan) | ported; tool output stays out of items (`outputOmitted`), as in the Codex driver |
| `src/probe.rs`, `data/model-manifest.claudeAgent.json` | apps/server/src/provider/ClaudeProvider.ts:861-885 (messages); apps/server/src/provider/model-manifest.json `providers.claudeAgent` | manifest verbatim; probe adapted to `claude --version` / `claude auth status` instead of an SDK query |
| `src/process.rs` | GOAT 2 `crates/goat2-engine-codex/src/process.rs` (lane B, branch `goat2_engine_codex` c297ed6) | copied verbatim (drivers may not depend on each other) |
| `src/bin/fake_claude.rs` | A/ClaudeAdapterV2.testkit.ts:488-890 `makeReplayQueryRunner` (strict cursor, uuid replacement) | adapted to the wire: translates v1 SDK-level transcript frames to stream-json |
| `tests/fixtures/v1/*.ndjson` | apps/server/src/orchestration-v2/testkit/fixtures/{simple,multi_turn,multi_turn_restart,queued_turn,claude_idle_resume,subagent,tool_call_restricted_granular,tool_call_denied_write,message_steering,turn_interrupt,claude_result_is_error}/claude_transcript.ndjson | verbatim |
| `tests/fixtures/wire/auth_failure_2_1_332.ndjson` | real `claude` 2.1.332 stdout, logged-out home, 2026-11-28 | captured; init lists trimmed, home path anonymised |

New in GOAT 2: the other `tests/fixtures/wire/*` (hand-written from 2.1.332 frame shapes seen in the capture: `command_lifecycle`, `set_model`/`set_permission_mode`/`mcp_set_servers` responses), `src/protocol.rs` framing, `src/util.rs`.
