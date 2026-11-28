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

## goat2-engine-acp (lane P2-B), from goat-si/goat origin/dev `916b5ccc1b2`

| GOAT 2 path | Source path (goat origin/dev 916b5ccc1b2) | How |
|---|---|---|
| crates/goat2-engine-acp/src/capabilities.rs | packages/provider-acp/src/server/capabilities.ts:15-147,208-223 | ported-to-Rust (capability literal verbatim values, negotiatedCapabilities, ACP_PROMPT_ACTIVITY_UPDATES) |
| crates/goat2-engine-acp/src/normalize.rs | packages/effect-acp/src/_internal/normalizeV1SessionUpdate.ts | ported-to-Rust |
| crates/goat2-engine-acp/src/policy.rs | packages/provider-acp/src/server/clientPolicy.ts, permissionOptions.ts | ported-to-Rust (approval/sandbox policy branches reduced to v1's undefined cases) |
| crates/goat2-engine-acp/src/elicitation.rs | packages/provider-acp/src/server/elicitationForm.ts | ported-to-Rust |
| crates/goat2-engine-acp/src/items.rs | packages/provider-acp/src/server/runtimeModel.ts:800-1010 (tool state, kind to item type), toolProjection.ts, noticeProjection.ts, unfinishedStop.ts, assistantSegments.ts | adapted (finished items only, GOAT 2 TurnItem) |
| crates/goat2-engine-acp/src/flavor.rs | packages/provider-acp/src/server/adapterFlavor.ts, AcpSessionRuntime.ts:131-200 | adapted (hooks with a GOAT 2 consumer) |
| crates/goat2-engine-acp/src/engine.rs | packages/provider-acp/src/server/AcpSessionRuntime.ts (initialize :995-1009, auth :1505-1555, new/load/resume :1557-1613, cancel :117-120), adapter.ts (prompt settle :6850-6925, steer :7788), promptSteering.ts, acpAppContext.ts, packages/effect-acp/src/client.ts + rpc.ts (elicitation methods incl. legacy nested response) | adapted, on Zed agent-client-protocol 5.6.1 |
| crates/goat2-engine-acp/src/process.rs | lane B crates/goat2-engine-codex/src/process.rs (GOAT 2); v1 packages/provider-acp/src/server/posixProcessTree.ts | adapted (stderr line hook added) |
| crates/goat2-engine-acp/src/bin/acp_mock_agent.rs | apps/server/scripts/acp-mock-agent.ts, acpMockPrompt.ts, acpMockNotices.ts, acpMockGrokScenarios.ts, acp-mock-prompt-crash.ts, acp-mock-load-replay.ts | ported-to-Rust (scenario subset, v1 env names; GOAT 2 additions marked) |
| crates/goat2-acp-mcp-bridge/src/lib.rs | apps/server/src/mcp/AcpMcpStdioBridge.ts@916b5ccc1b2 (14-285, 419-563); apps/server/src/mcp/AcpMcpLineReader.ts@916b5ccc1b2 (1-42); packages/shared/src/mcpResponsePayloads.ts@916b5ccc1b2 (1-117); packages/shared/src/closedPipe.ts@916b5ccc1b2 (1-4); packages/provider-acp/src/server/mcpOverAcpBridge.ts@916b5ccc1b2 (1-300) | ported-to-Rust |
| crates/goat2-acp-mcp-bridge/src/main.rs | apps/server/src/mcp/AcpMcpStdioBridge.ts@916b5ccc1b2 (566-590); apps/server/src/cli/acpMcpBridge.ts@916b5ccc1b2 (1-14) | ported-to-Rust |
| crates/goat2-acp-mcp-bridge/tests/bridge.rs | apps/server/src/mcp/AcpMcpStdioBridge.ts@916b5ccc1b2 (419-590) | adapted |
| crates/goat2-engine-acp/src/agents/grok.rs (PromptFailed for rate_limit/error) | packages/provider-grok/src/server/xaiAcpExtension.ts:1283-1301; packages/provider-grok/src/server/adapter.ts:434-446 | ported-to-Rust |
| crates/goat2-engine-acp/src/agents/xai_requests.rs | packages/provider-grok/src/server/xaiAcpExtension.ts:880-1235 (ask_user_question / exit_plan_mode schemas, extraction, answer normalization, captured response) | ported-to-Rust |
| crates/goat2-engine-acp/src/agents/grok.rs (ext_request_action) | packages/provider-grok/src/server/adapter.ts:171-230 | ported-to-Rust |
| crates/goat2-engine-acp/src/flavor.rs (ExtRequest), engine.rs (on_ext_question, Pending::ExtQuestion, CapturePlan) | packages/provider-acp/src/server/AcpSessionRuntime.ts handleExtRequest; adapterFlavor.ts requestUserInput / captureProposedPlan | ported-to-Rust |
| crates/goat2-engine-acp/src/mcp.rs (mcp_servers_for) | packages/provider-acp/src/server/AcpSessionRuntime.ts:1475-1494 (sessionMcpServers) | ported-to-Rust |
| crates/goat2-engine-acp/src/mcp.rs (server lists, name, env names) | packages/provider-acp/src/server/mcpContext.ts:39-75; apps/server/src/mcp/AcpMcpStdioBridge.ts:570-579 | ported-to-Rust |
| crates/goat2-engine-acp/src/flavor.rs (prefers_http_mcp) | packages/provider-acp/src/server/adapterFlavor.ts:126 (preferHttpMcp) | ported-to-Rust |
| crates/goat2-engine-acp/src/mcp_over_acp.rs | packages/provider-acp/src/server/mcpOverAcpBridge.ts (connect/message/notification/disconnect/dispose, limits, errors) | ported-to-Rust |
| crates/goat2-engine-acp (final review engine fixes: permission option choice, tracked auto-accept paths, stderr tail, stdout frame limit, setup sign-in links, carryover replies, preamble, advertised auth methods, integer answers, line counts, parallel MCP dispose) | permissionOptions.ts, autoAcceptEdits.ts, stderr.ts, strictParser.ts, probe.ts, adapter.ts:2298-2333, acpAppContext.ts, AcpSessionRuntime.ts:835,1514-1527, elicitationForm.ts, mcpOverAcpBridge.ts | ported-to-Rust / adapted (rows per finding in crates/goat2-engine-acp/provenance/final-review-engine.md) |
| crates/goat2-engine-acp/src/mcp.rs (acp branch) | packages/provider-acp/src/server/AcpSessionRuntime.ts:1487-1493; mcpContext.ts:61 | ported-to-Rust |
| crates/goat2-engine-acp/src/probe.rs (open_probe, AcpProbeSession, AcpProbeFailure, timing constants) | packages/provider-acp-registry/src/server/probe.ts:72-77, 389-546 | ported-to-Rust |
| crates/goat2-engine-acp/src/engine.rs (for_probe, wait_for_advertisements, available_commands, delete_session) | packages/provider-acp-registry/src/server/probe.ts:410-516; packages/provider-acp/src/server/AcpSessionRuntime.ts:1902-1915 | ported-to-Rust |
| crates/goat2-engine-acp/src/registry/mod.rs (RegistryAgentFlavor) | `packages/provider-acp-registry/src/server/adapter.ts` (183-188 authMethodId/customModels, 206-349 per-agent flavor, 270 Copilot routing, 243 Kimi watch, 274-282 Copilot capabilities, 299-305 forms, 309-316 Claude, 323-349 Devin/Copilot); `packages/provider-acp/src/server/adapter.ts` (5985-6018 model writes, `alwaysSetModel`) | ported-to-Rust |
| crates/goat2-engine-acp/src/registry/agents/mod.rs | `packages/provider-acp-registry/src/server/adapter.ts` (213-267 agent detection); `mcpTransport.ts` (1-27); `settings.ts` (13-25 `isMiniMaxCode`) | ported-to-Rust |
| crates/goat2-engine-acp/src/registry/agents/devin.rs | `packages/provider-acp-registry/src/server/devinAcp.ts` (1-63); `adapter.ts` (323-333 client capability `_meta`) | ported-to-Rust |
| crates/goat2-engine-acp/src/registry/agents/copilot.rs | `packages/provider-acp-registry/src/server/copilotAcp.ts` (1-326, whole file); `copilotAcp.test.ts` (cases) | ported-to-Rust |
| crates/goat2-engine-acp/src/registry/agents/claude.rs | `packages/provider-acp-registry/src/server/claudeAcp.ts` (1-119); `sessionEnvironmentKey.ts` (7-22); `packages/effect-acp/src/_internal/normalizeV2Client.ts` (221-231 `raw` is the update) | ported-to-Rust |
| crates/goat2-engine-acp/src/registry/agents/droid.rs | `packages/provider-acp-registry/src/server/droidAcp.ts` (1-84) | ported-to-Rust |
| crates/goat2-engine-acp/src/registry/agents/omp.rs | `packages/provider-acp-registry/src/server/ompAcp.ts` (1-66) | ported-to-Rust |
| crates/goat2-engine-acp/src/registry/agents/opencode.rs | `packages/provider-acp-registry/src/server/opencodeAcp.ts` (1-136); `opencodeAcp.test.ts` (cases) | ported-to-Rust |
| crates/goat2-engine-acp/src/registry/agents/forms.rs | `droidAcp.ts` (66-77), `opencodeAcp.ts` (40-47) attachment suffix; `packages/contracts/src/baseSchemas.ts` (14-29 `TrimmedNonEmptyString` as `Schema.is` sees it) | ported-to-Rust |
| crates/goat2-engine-acp/src/registry/agents/kimi.rs | `packages/provider-acp-registry/src/server/kimiAcp.ts` (1-312, whole file); `kimiAcp.test.ts` (cases) | ported-to-Rust (adapted: one process environment instead of recorded vs runtime) |
| crates/goat2-engine-acp/src/registry/agents/vibe.rs | `packages/provider-acp-registry/src/server/adapter.ts` (100-129) | adapted (retry becomes a warning notice) |
| crates/goat2-engine-acp/src/subagents.rs | `packages/provider-acp/src/server/adapter.ts` (465-468 gate, 1646-1669, 1790-2070 `emitSubagent`, 2335-2404 `followNativeChild`, 2519-2629 `emitTool`, 3741-3775 and 3817-3879 child routing, 4675-4725 `finishSubagentFromNotice`, 4833-4851 carryover); `acpSubagentStatus.ts` (1-17) | adapted (no child thread: progress events plus a `subagent` item) |
| crates/goat2-engine-acp/src/items.rs (take_ordinal) | `packages/provider-acp/src/server/adapter.ts` (1841-1842 subagent item ordinal) | adapted |
| crates/goat2-engine-acp/src/bin/acp_mock_agent.rs (GOAT_ACP_SCRIPT, GOAT_ACP_DEVIN_PLAN_BYPASS) | `apps/server/scripts/acp-mock-agent.ts` (scenario style); traffic from `copilotAcp.test.ts`, `kimiAcp.integration.test.ts`, `opencodeAcp.test.ts`, `devinAcp.ts` | adapted (GOAT 2 scripted steps) |
| crates/goat2-engine-acp/tests/registry_agents.rs | `copilotAcp.test.ts`, `kimiAcp.integration.test.ts`, `opencodeAcp.test.ts`, `devinAcp.ts`, `droidAcp.ts`, `ompAcp.ts`, `adapter.ts` (100-129, 213-349) | adapted |
| crates/goat2-engine-acp/tests/engine.rs (Devin plan bypass, Copilot model resend) | `devinAcp.ts` (58-63); `adapter.ts` (334-361) | adapted |
| crates/goat2-engine-acp/src/agents/antigravity*.rs, fx.rs, fx_skills.rs, src/bin/mock_flavors/antigravity_fx.rs, tests/antigravity.rs, tests/fx.rs | apps/server/src/provider/acp/Antigravity*.ts, antigravityAuthSupport.ts, Drivers/AntigravityDriver.ts, orchestration-v2/Adapters/AntigravityAdapterV2.ts; packages/provider-fx/src/server/* ; apps/server/scripts/acp-mock-agent.ts | ported-to-Rust (rows per file in provenance/antigravity-fx.md) |
| crates/goat2-engine-acp/src/flavor.rs, engine.rs (config write sequences, mode writes, interaction_ permission questions, stdout/stderr failure lines, sign-in errors, fs/read_text_file, attachment blocks, runtime version refusal, re-auth with the configured method) | packages/provider-acp/src/server/AcpSessionRuntime.ts (1023-1075, 1363-1420, 1505-1555, 2068-2098); adapter.ts (5081-5147, 5961-6204, 8419); adapterFlavor.ts (157-159, 204, 253) | ported-to-Rust; Antigravity and fx use the lane's `extract_subagent` and `extract_elicitation_form` hooks (one shape per v1 hook) |
| crates/goat2-engine-acp/src/agents/grok.rs (hooks), grok_tools.rs, grok_notifications.rs, grok_plan.rs, grok_model.rs, grok_skills.rs, grok_auth.rs | packages/provider-grok/src/server/adapter.ts:92-475; acpSupport.ts:30-33,125-325; xaiAcpExtension.ts:16-87,98-859,957-1090,1236-1482; xaiMcpToolCall.ts:1-57; commandTitle.ts:1-7; skills.ts:1-146; auth.ts:19-64; status.ts:134-206 | ported-to-Rust (per-file rows in crates/goat2-engine-acp/provenance/grok.md) |
| crates/goat2-engine-acp/src/flavor.rs (background, wake, deferral, settled interrupt, cancel settlement, plan file, composite model write and session-aware hooks) | packages/provider-acp/src/server/adapterFlavor.ts:66-111,300-400 | adapted |
| crates/goat2-engine-acp/src/items.rs (normalized tool state, background tasks, proposed-plan dedup) | packages/provider-acp/src/server/adapter.ts:1152-1258,2474-2642,3187-3213,4047-4087,5480-5530; deferredBackground.ts:13-43; toolOutputText.ts:68-90 | adapted |
| crates/goat2-engine-acp/src/subagents.rs (registered-task polls, end notices in user text, blocks_turn, kept-running interrupt) | packages/provider-acp/src/server/adapter.ts:2558-2621,3775-3797,4088-4111,4640-4670,6544-6556,7874-7900 | adapted |
| crates/goat2-engine-acp/src/engine.rs (deferred finalize, wake frames, settled interrupt, cancel settlement, background task events, composite model writes, auth_policy_for, rewrite_user_text_for) | packages/provider-acp/src/server/adapter.ts:3880-3899,4459-4467,5422-5530,7874-8082; deferredBackground.ts:45-47,131-233; packages/provider-grok/src/server/xaiAcpExtension.ts:1323-1357,1553-1560 | adapted |
| crates/goat2-engine-acp/src/bin/acp_mock_agent.rs (Grok scenarios, kill shapes, monitor poll, background task, Grok models, inspect) | apps/server/scripts/acpMockGrokScenarios.ts:1-69; acp-mock-agent.ts:431-461,1836-1980; frame shapes from xaiAcpExtension.test.ts, skills.test.ts | ported-to-Rust (GOAT 2 scenarios marked) |
| crates/goat2-engine-acp/tests/grok.rs | behaviours of packages/provider-grok/src/server/adapter.test.ts, xaiAcpExtension.test.ts, skills.test.ts | adapted |

Per-slice detail and known gaps: crates/goat2-engine-acp/provenance/*.md, crates/goat2-acp-mcp-bridge/provenance/bridge.md.
| crates/goat2-engine-acp/src/stderr.rs | packages/provider-acp/src/server/stderr.ts (ACP_STDERR_TAIL_MAX_CHARS, appendAcpStderrTail, sanitizeAcpStderrExcerpt); bounded reading per apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts:419-441 | ported-to-Rust |
| crates/goat2-acp-mcp-bridge/src/lib.rs (send_collect, bounded HttpRelay::send), crates/goat2-engine-acp/src/mcp_over_acp.rs (MAX_RESPONSE_BYTES) | packages/provider-acp/src/server/mcpOverAcpBridge.ts:150 (collected the whole stream; GOAT 2 bounds it) | adapted |
