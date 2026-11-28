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
| `src/probe.rs` (`CodexEngineFactory::probe`) | P/CodexProvider.ts:143-276,286-380,486-668,730-1000, P/CodexProviderAccount.ts:1-170, P/OpenCodexRoute.ts:151-178, P/CodexModelOptionDefaults.ts, P/codexModelDefaults.ts, packages/shared/src/model.ts:387-393, packages/contracts/src/model.ts:129-134, packages/effect-codex-app-server/src/client.ts:276-288 | ported to Rust (app-server probe: initialize version, account/read status and labels, effective route from the cwd config so a route away from OpenAI needs no OpenAI login, config/read service tier, cyber access and custom endpoint, paginated model/list with the ChatGPT catalog refresh wait and every entry checked against the pinned `Model` schema as v1 decodes it, initialize, account/read and config/read checked against their pinned schemas for their required fields and every field the probe reads, preferred default model, `codex --version` fallback in an owned process group, v1 messages; base URLs parsed by the `url` crate, WHATWG with UTS46/IDNA like v1's `new URL`, owner decision); usage limits, skills, slash commands, OpenCodex routes and custom models are not carried (no field in the GOAT 2 probe result); written difference (owner decision): v1 decodes answers with a generator from an older Codex schema, GOAT 2 by the pinned 0.167.0 schema, following v1's leniency where the value is unused (any `planType` string, workspace fields unchecked), accepting the 0.167.0 `gcp` account v1's decoder predates, and not type-checking config fields the probe never reads, so a mistyped unrelated config field cannot change the sign-in state |
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

## apps/web/src/v1: GOAT v1 lift (lanes F and P2-M, 2026-11-29)

Source: goat-si/goat `origin/dev` 916b5ccc1b2. Layout: v1 `apps/web/src/<X>` -> `apps/web/src/v1/<X>`, v1 `packages/<pkg>/src/<Y>` -> `apps/web/src/v1/packages/<pkg>/src/<Y>`.
Every lifted file is **verbatim** (byte-identical, imports included). The exact file list is `scripts/v1-lift.d/*.txt` (base.txt and providers.txt P2-M, timeline.txt and contracts.txt lane F) plus the pure modules `scripts/v1-lift.py` lifts transitively (AUTO_LIFT); `python3 scripts/v1-lift.py --check` fails if any lifted file differs from v1. Imports that leave the lift set resolve to the bridges below through `src/v1/aliases.json` (generated) or one-line re-export files at the mirrored path.

Lifted: 717 files.

| GOAT 2 path (under apps/web/src/v1/) | v1 path @916b5ccc | files | How |
|---|---|---|---|
| *.ts (top level) | apps/web/src/* | 18 | verbatim |
| appearance/ | apps/web/src/appearance/ | 1 | verbatim |
| assets/fonts/ | apps/web/src/assets/fonts/ | 1 | verbatim |
| browser/ | apps/web/src/browser/ | 1 | verbatim |
| cloud/ | apps/web/src/cloud/ | 1 | verbatim |
| components/ | apps/web/src/components/ | 7 | verbatim |
| components/chat/ | apps/web/src/components/chat/ | 49 | verbatim |
| components/pullRequest/ | apps/web/src/components/pullRequest/ | 1 | verbatim |
| components/settings/ | apps/web/src/components/settings/ | 44 | verbatim |
| components/solar/ | apps/web/src/components/solar/ | 4 | verbatim |
| components/ui/ | apps/web/src/components/ui/ | 36 | verbatim |
| desktop/ | apps/web/src/desktop/ | 1 | verbatim |
| hooks/ | apps/web/src/hooks/ | 7 | verbatim |
| lib/ | apps/web/src/lib/ | 12 | verbatim |
| notes/ | apps/web/src/notes/ | 1 | verbatim |
| packages/client-runtime/src/ | packages/client-runtime/src/ | 17 | verbatim |
| packages/client-runtime/src/connection/ | packages/client-runtime/src/connection/ | 3 | verbatim |
| packages/client-runtime/src/environment/ | packages/client-runtime/src/environment/ | 3 | verbatim |
| packages/client-runtime/src/errors/ | packages/client-runtime/src/errors/ | 6 | verbatim |
| packages/client-runtime/src/goatBot/ | packages/client-runtime/src/goatBot/ | 8 | verbatim |
| packages/client-runtime/src/state/ | packages/client-runtime/src/state/ | 9 | verbatim |
| packages/client-runtime/src/work-log/ | packages/client-runtime/src/work-log/ | 12 | verbatim |
| packages/contracts/src/ | packages/contracts/src/ | 297 | verbatim |
| packages/contracts/src/agentSurface/ | packages/contracts/src/agentSurface/ | 21 | verbatim |
| packages/contracts/src/agentSurface/entries/ | packages/contracts/src/agentSurface/entries/ | 48 | verbatim |
| packages/provider-acp-registry/src/ | packages/provider-acp-registry/src/ | 3 | verbatim |
| packages/provider-claude-cloud/src/ | packages/provider-claude-cloud/src/ | 1 | verbatim |
| packages/provider-core/src/ | packages/provider-core/src/ | 1 | verbatim |
| packages/provider-cursor/src/ | packages/provider-cursor/src/ | 2 | verbatim |
| packages/provider-devin-cloud/src/ | packages/provider-devin-cloud/src/ | 2 | verbatim |
| packages/provider-fx/src/ | packages/provider-fx/src/ | 2 | verbatim |
| packages/provider-grok/src/ | packages/provider-grok/src/ | 2 | verbatim |
| packages/provider-muse/src/ | packages/provider-muse/src/ | 2 | verbatim |
| packages/provider-opencode/src/ | packages/provider-opencode/src/ | 2 | verbatim |
| packages/provider-pi/src/ | packages/provider-pi/src/ | 4 | verbatim |
| packages/shared/src/ | packages/shared/src/ | 66 | verbatim |
| packages/source-control-azure-devops/src/shared/ | packages/source-control-azure-devops/src/shared/ | 2 | verbatim |
| packages/source-control-bitbucket/src/shared/ | packages/source-control-bitbucket/src/shared/ | 2 | verbatim |
| packages/source-control-core/src/shared/ | packages/source-control-core/src/shared/ | 2 | verbatim |
| packages/source-control-cursor-origin/src/shared/ | packages/source-control-cursor-origin/src/shared/ | 2 | verbatim |
| packages/source-control-definitions/src/ | packages/source-control-definitions/src/ | 1 | verbatim |
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
| assets/assetUrls.ts | apps/web/src/assets/assetUrls.ts | Lane F. v1 mints asset URLs from the environment's asset server; GOAT 2 serves no assets yet, so every asset reports Failure / null and the lifted rows draw their own fallbacks (app icon tile, no image). Planned: GOAT 2 asset route. |
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
| components/chat/ChatGptSharingControl.tsx | apps/web/src/components/chat/ChatGptSharingControl.tsx | Seam for v1 apps/web/src/components/chat/ChatGptSharingControl.tsx (goat 916b5ccc1b2): ChatGPT subscription sharing is a v1 OpenCodex feature GOAT 2 does not have. |
| components/chat/ChatMarkdownMedia.tsx | apps/web/src/components/chat/ChatMarkdownMedia.tsx | Lane F. No GOAT 2 asset route yet: the image draws only a caller-supplied fallbackSrc. assetMediaActionsSource is v1's function minus the right-panel open-file action (no right panel in GOAT 2). |
| components/chat/ComputerUseHistorySection.tsx | apps/web/src/components/chat/ComputerUseHistorySection.tsx | Lane F. Planned: computer-use history is a v1 environment command GOAT 2 does not have (Part 2). Renders nothing. |
| components/chat/ComputerUseRunCard.tsx | apps/web/src/components/chat/ComputerUseRunCard.tsx | Lane F. Planned: GOAT 2 has no computer-use runs (Part 2); the row itself still draws the tool line. |
| components/chat/ExpandedImagePreview.tsx | apps/web/src/components/chat/ExpandedImagePreview.tsx | Lane F. v1's file also resolves markdown media through the environment; lifted code imports only ExpandedImageItem / ExpandedImagePreview, copied verbatim. |
| components/chat/FileChangeInlineDiff.tsx | apps/web/src/components/chat/FileChangeInlineDiff.tsx | Lane F. Planned (Part 2: diffs by engine locator). The row renders it only when onOpenTurnDiff is set, which GOAT 2 leaves undefined, so it never draws today. |
| components/chat/markdownImageGallery.ts | apps/web/src/components/chat/markdownImageGallery.ts | Lane F. v1's module also imports media/connection runtime; workGroupImageGallery is pure and copied verbatim. |
| components/chat/V2ItemInspector.tsx | apps/web/src/components/chat/V2ItemInspector.tsx | Lane F. v1 fetches the full item from the environment; in GOAT 2 that is Part 2 (host fetches details lazily by engine locator). Until then the expanded row shows what the log line carries (command input + inline output, tool input + inline output). fileChangeDiffTarget copied verbatim. |
| components/chat/V2LifecycleRow.tsx | apps/web/src/components/chat/V2LifecycleRow.tsx | Lane F. v1 draws subagent lifecycle rows from environment thread atoms; until lifted, SubagentNotificationLink returns v1's own fallback (the plain work entry row). HandoffTimelineRun re-exported from the lifted handoff module. |
| components/ChatMarkdown.tsx | apps/web/src/components/ChatMarkdown.tsx | Lane F. Until v1 ChatMarkdown (1.6k lines: file links, previews, media, math, mermaid, environment stores) is lifted, renders the same props with v1's react-markdown 10.1.0 + remark-gfm and the caller's remark plugins, so the work log's thought previews behave as in v1. Raw HTML never parsed. |
| components/media/MediaActions.ts | apps/web/src/components/media/MediaActions.tsx | Lane F. Only the MediaActionSource type (used by the two seams above), copied verbatim. |
| components/ProviderUpdatesAction.tsx | apps/web/src/components/ProviderUpdatesAction.tsx | Seam for v1 apps/web/src/components/ProviderUpdatesAction.tsx (goat 916b5ccc1b2): GOAT 2 has no provider self-update in Part 2, so the action is not shown. |
| components/settings/AcpSessionManagementSection.tsx | apps/web/src/components/settings/AcpSessionManagementSection.tsx | Seam for v1 apps/web/src/components/settings/AcpSessionManagementSection.tsx (goat 916b5ccc1b2): importing native ACP sessions is not in GOAT 2 Part 2. |
| components/settings/ChatGptConnectionButton.tsx | apps/web/src/components/settings/ChatGptConnectionButton.tsx | Seam for v1 apps/web/src/components/settings/ChatGptConnectionButton.tsx (goat 916b5ccc1b2): ChatGPT connection is a v1 OpenCodex feature GOAT 2 does not have. |
| components/settings/CodexSetupSection.tsx | apps/web/src/components/settings/CodexSetupSection.tsx | Seam for v1 apps/web/src/components/settings/CodexSetupSection.tsx (goat 916b5ccc1b2): v1 shows these only for managed Codex accounts (OpenCodex Home, setupMode "managed"); GOAT 2 Codex uses the signed-in codex CLI (setupMode "existing"), so they render nothing. Props are v1's (CodexSetupSection.types.ts). |
| components/settings/ProviderCodexHomeRouteSection.tsx | apps/web/src/components/settings/ProviderCodexHomeRouteSection.tsx | Seam for v1 apps/web/src/components/settings/ProviderCodexHomeRouteSection.tsx (goat 916b5ccc1b2): OpenCodex Home routing is a v1-only service, so the section is not shown. Callback props keep v1's types (:8-20). |
| components/settings/ProviderHostMatrix.commands.ts | apps/web/src/components/settings/ProviderHostMatrix.commands.ts | Seam for v1 apps/web/src/components/settings/ProviderHostMatrix.commands.ts (goat 916b5ccc1b2): GOAT 2 has one host, so the sync command is never permitted (its permission atom is false and v1 hides the action) and refuses with that reason if run. |
| components/settings/ProviderHostSyncDialog.tsx | apps/web/src/components/settings/ProviderHostSyncDialog.tsx | Seam for v1 apps/web/src/components/settings/ProviderHostSyncDialog.tsx (goat 916b5ccc1b2): GOAT 2 has one host; there is nothing to sync providers to. |
| components/settings/scopedSettings.ts | apps/web/src/components/settings/scopedSettings.ts | Seam for v1 apps/web/src/components/settings/scopedSettings.ts (goat 916b5ccc1b2): GOAT 2 has no project-scoped settings, so no key is project scoped, nothing is mixed and every value comes from the environment. Types keep v1's shapes (scopedSettings.ts:33-43, 84-91, 166, 382-385). |
| components/settings/SecretReferencePicker.tsx | apps/web/src/components/settings/SecretReferencePicker.tsx | Seam for v1 apps/web/src/components/settings/SecretReferencePicker.tsx (goat 916b5ccc1b2): v1 secret references are behind GOAT_FEATURE_SECRETS (off), and GOAT 2 has no secret store, so the picker is not shown. Props are v1's (:25-35). |
| components/settings/SecretsSettings.tsx | apps/web/src/components/settings/SecretsSettings.tsx | Seam for v1 apps/web/src/components/settings/SecretsSettings.tsx (goat 916b5ccc1b2): v1 secrets are behind GOAT_FEATURE_SECRETS (off), and GOAT 2 has no secret store. |
| components/settings/SettingInheritance.tsx | apps/web/src/components/settings/SettingInheritance.tsx | Seam for v1 apps/web/src/components/settings/SettingInheritance.tsx (goat 916b5ccc1b2): project overrides do not exist in GOAT 2 (one environment, no project settings), so nothing is inherited or overridden. |
| components/settings/SettingsPageLead.tsx | apps/web/src/components/settings/SettingsPageLead.tsx | Seam for v1 apps/web/src/components/settings/SettingsPageLead.tsx (goat 916b5ccc1b2). v1 picks the lead from the router path; GOAT 2 has one settings page here, so the providers lead is fixed. Markup and the first sentence of the text are v1's (settingsNav.ts:67-72); the OpenCodex Home sentence and Hub link are v1-only and dropped. |
| components/settings/SettingsScopeContext.tsx | apps/web/src/components/settings/SettingsScopeContext.tsx | Seam for v1 apps/web/src/components/settings/SettingsScopeContext.tsx (goat 916b5ccc1b2): GOAT 2 renders settings for its one environment without v1's scope picker, so no scope provider is mounted and useOptionalSettingsScope() is null, the case v1's settingsLayout already handles. The value type keeps the fields v1 readers use. |
| components/settings/SettingsScopeSentence.tsx | apps/web/src/components/settings/SettingsScopeSentence.tsx | Seam for v1 apps/web/src/components/settings/SettingsScopeSentence.tsx (goat 916b5ccc1b2): GOAT 2 has one environment and no project scopes, so there is no scope to describe. |
| components/settings/settingsSearch.ts | apps/web/src/components/settings/settingsSearch.ts | Seam for v1 apps/web/src/components/settings/settingsSearch.ts (goat 916b5ccc1b2): v1's settings search registry (1,397 lines across every settings page) is not carried; the provider page's rows keep v1's anchor ids and titles. |
| components/settings/TextGeneratorAndUsageSettings.tsx | apps/web/src/components/settings/TextGeneratorAndUsageSettings.tsx | Seam for v1 apps/web/src/components/settings/TextGeneratorAndUsageSettings.tsx (goat 916b5ccc1b2): usage limits are outside Part 2 (PRD part2/providers, usage row). |
| components/settings/useScopedSettings.ts | apps/web/src/components/settings/useScopedSettings.ts | Seam for v1 apps/web/src/components/settings/useScopedSettings.ts (goat 916b5ccc1b2): with no project overrides (seam scopedSettings.ts) there is nothing to clear. |
| components/settings/useTranslatedSearchableSetting.ts | apps/web/src/components/settings/useTranslatedSearchableSetting.ts | Seam for v1 apps/web/src/components/settings/useTranslatedSearchableSetting.ts (goat 916b5ccc1b2): GOAT 2 is English first (owner rule), so titles are returned as registered. |
| components/ThreadTerminalDrawer.tsx | apps/web/src/components/ThreadTerminalDrawer.tsx | Seam for v1 apps/web/src/components/ThreadTerminalDrawer.tsx (goat 916b5ccc1b2): only terminalThemeFromApp, used by the terminal sign-in surface, which GOAT 2 does not have (seam terminal/ghostty/surface.ts). |
| composerDraftStore.ts | apps/web/src/composerDraftStore.ts | Seam for v1 apps/web/src/composerDraftStore.ts (goat 916b5ccc1b2), shared by lanes F and P2-M. v1's 4,000-line draft store is not carried: GOAT 2 keeps drafts in its own composer. DraftId keeps v1's schema (composerDraftStore.ts:138). The lifted TraitsPicker is always given onModelOptionsChange in GOAT 2, so it never writes options into a draft. |
| composerHandleContext.ts | apps/web/src/composerHandleContext.ts | Seam for v1 apps/web/src/composerHandleContext.ts (goat 916b5ccc1b2). v1 hands menus the chat composer's handle so a closing menu can refocus the editor; GOAT 2's composer is not the v1 ChatComposer, so there is no handle and menus keep their own focus return (v1 composerEventScope.ts:20-21 handles a null handle). |
| connection/desktopLocal.ts | apps/web/src/connection/desktopLocal.ts | Seam for v1 apps/web/src/connection/desktopLocal.ts (goat 916b5ccc1b2): GOAT 2's one environment is its own local host, never a v1 desktop-local backend or WSL distro. |
| diffPanelStore.ts | apps/web/src/diffPanelStore.ts | Lane F. v1's persisted diff panel store; GOAT 2 has no diff panel (Part 2). Only DiffPanelSourceItem / OpenTurnDiff types, copied verbatim. |
| environments/primary/target.ts | apps/web/src/environments/primary/target.ts | Seam for v1 apps/web/src/environments/primary/target.ts (goat 916b5ccc1b2): GOAT 2 (Dev) always talks to the host its desktop shell started, which v1 calls a desktop-managed primary target. |
| fixture/V1Fixture.tsx | - | ?v1fixture: checks the v1 CSS scoping and portal root (e2e/v1fixture.spec.ts). A v1 Button, text-work-log text, an open Popover and an open Tooltip inside the boundary; identical plain elements outside it keep browser defaults. |
| goat2/environment.ts | - | GOAT 2 runs one local host per app (docs/lanes/PART1.md fixed decisions), so the lifted v1 screens see exactly one environment: this machine, whose owner holds every scope. |
| goat2/globals.d.ts | apps/web/src/vite-env.d.ts | v1 apps/web/src/vite-env.d.ts (goat 916b5ccc1b2) global declarations the lifted files compile against. GOAT 2's shell never sets window.desktopBridge (the lifted env.ts then reports isElectron = false), so these paths stay inert. |
| goat2/providerPort.ts | - | GOAT 2 seam: the one place provider data enters the lifted v1 provider screens (P2-M). The lifted v1 code reads providers through v1 atoms (state/server.ts serverEnvironment.*) and calls v1 WS methods. The GOAT 2 app installs a ProviderPort that answers those methods from the GOAT 2 host (or the fake host scene) and pushes provider entries; this file turns entries into v1 ServerProvider values (decoded with the lifte |
| goat2/surfaces.ts | - | @v1/surfaces: every lifted v1 surface GOAT 2 mounts, typed against surfaces.types.ts (see there). Also the typecheck entry of tsconfig.v1.json, so the v1 provider screens are checked even before a GOAT 2 frame mounts them. |
| goat2/surfaces.types.ts | - | The typed boundary between GOAT 2 code and the lifted v1 tree (@v1/surfaces). GOAT 2's tsconfig resolves @v1/surfaces to this file, so its typecheck never walks v1 internals (v1 needs its own compiler options); vite resolves it to surfaces.ts, and tsconfig.v1.json checks that surfaces.ts implements exactly these declarations. Declarations only, valid under both compiler setups. |
| hooks/useSettings.ts | apps/web/src/hooks/useSettings.ts | Seam for v1 apps/web/src/hooks/useSettings.ts (goat 916b5ccc1b2): the settings hooks the lifted provider screens use. Server settings live behind the GOAT 2 provider port (server.updateSettings); client settings stay in this browser (localStorage), as v1's browser client does. v1's multi-environment shared-settings sync, project overrides and legacy migrations are not carried: GOAT 2 has one environment. |
| hooks/useThreadRouteTarget.ts | apps/web/src/hooks/useThreadRouteTarget.ts | Seam for v1 apps/web/src/hooks/useThreadRouteTarget.ts (goat 916b5ccc1b2): GOAT 2 does not use v1's router, so toasts never scope themselves to a v1 thread route. The type is v1's (threadRoutes.ts:8-20). |
| localApi.ts | apps/web/src/localApi.ts | Seam for v1 apps/web/src/localApi.ts (goat 916b5ccc1b2): the browser branch of v1 createBrowserLocalApi (localApi.ts:15-40). GOAT 2 (Dev) opens links in the system browser through the Electron window-open handler. |
| npm-aliases.json | npm specifiers | Hand-written map of npm modules answered by the seam (@tanstack/react-router); merged into the alias map by vite-plugin-v1.ts and tsconfig.v1.paths.json. |
| npm/tanstack-react-router.tsx | @tanstack/react-router | Seam for the npm module @tanstack/react-router, which lifted v1 files import (settingsLayout, ModelPickerProviderNotices, TimelineWorkEntryRow, lib/sentFromNavigation). Lane F added Link: the path is resolved with its params and handed to the GOAT 2 navigator. GOAT 2 has its own navigation (apps/web/src/ui-state), so this module answers v1's two hooks: useLocation reads the location the GOAT 2 frame sets, and useNavigate hands v1 paths to the GOAT 2 frame (setGoat2Navigator). |
| packages/client-runtime/src/connection/index.ts | packages/client-runtime/src/connection | Seam for v1 packages/client-runtime/src/connection (goat 916b5ccc1b2). v1's connection catalog (SSH, relay, hub proxy routes, credential profiles) is not carried: GOAT 2 has one local host, which v1 calls the primary target, with no profile and no extra routes. Type shapes follow v1 model.ts/catalog.ts; connectionStatusTitle keeps v1's phase wording (presentation.ts:17-24). |
| packages/client-runtime/src/environment/index.ts | @goat/client-runtime/environment | Bridge for v1 @goat/client-runtime/environment (packages/client-runtime/src/environment/index.ts, docs/PROVENANCE.md). Re-exports the three pure, byte-identical lifted modules. v1's descriptor.ts (environment descriptor fetch over the v1 HTTP RPC client) is left out: GOAT 2 has one local host and no v1 environment HTTP API. |
| packages/client-runtime/src/state/runtime.ts | packages/client-runtime/src/state/runtime.ts | Seam for v1 packages/client-runtime/src/state/runtime.ts (goat 916b5ccc1b2): only the atom-command surface the lifted provider screens use. Bodies are copied from v1 (runtime.ts:136-156, 199-207, 352-383, 469-496). v1's RPC runtime, connection registry and schedulers are not carried: GOAT 2 commands run through seam/goat2/providerPort.ts. |
| packages/client-runtime/src/state/shell.ts | packages/client-runtime/src/state/shell.ts | Lane F. v1 shell.ts is the environment shell runtime (connections, snapshots, rpc reducers); lifted code reads only the shell model types, re-exported from the lifted models.ts (as v1 does). |
| packages/client-runtime/src/state/threadRequests.ts | packages/client-runtime/src/state/threadRequests.ts | Lane F. v1 builds pending requests from thread atoms; lifted code imports only ThreadPendingApproval / ThreadUserInputQuestion / ThreadPendingUserInput, copied verbatim. |
| state/entities.ts | apps/web/src/state/entities.ts | Seam for v1 apps/web/src/state/entities.ts (goat 916b5ccc1b2), shared by lanes F and P2-M (lane F adds useThreadShell -> null: a "read thread" row shows its unlinked label, v1's own fallback; Planned: GOAT 2 thread cards). The provider screens read projects (ACP custom-model editor) and thread shells (which threads a provider change would stop). GOAT 2 has no v1 projects, and P2-M does not wire thread shells: both lists are empty. |
| state/environments.ts | apps/web/src/state/environments.ts | Seam for v1 apps/web/src/state/environments.ts (goat 916b5ccc1b2): the one GOAT 2 environment, the local host this app's desktop shell started (v1's primary target), connected once the host has sent its provider list. |
| state/queries.ts | apps/web/src/state/queries.ts | Lane F. v1 environment query atoms; only the TurnItemDetailSource type, copied verbatim. |
| state/server.ts | apps/web/src/state/server.ts | Seam for v1 apps/web/src/state/server.ts + packages/client-runtime/src/state/server.ts (goat 916b5ccc1b2): the serverEnvironment members the lifted provider screens use, answered by the GOAT 2 provider port. Each command keeps v1's label, input shape ({environmentId, input}) and result schema; results are decoded with the lifted v1 schemas. |
| state/session.ts | apps/web/src/state/session.ts | Seam for v1 apps/web/src/state/session.ts (goat 916b5ccc1b2): session grants for the one GOAT 2 environment. |
| terminal/ghostty/surface.ts | apps/web/src/terminal/ghostty/surface.ts | Seam for v1 apps/web/src/terminal/ghostty/surface.ts (goat 916b5ccc1b2). GOAT 2 has no in-app terminal in Part 2, so a terminal sign-in cannot be shown; creating the surface fails and v1's ProviderAuthTerminal says so ("Could not load the sign-in terminal. Cancel and retry sign-in."). |
| v1-entry.css | - | Seam rules for the v1 CSS (devlog 070 audit-3 residual), loaded right after the byte-identical v1 index.css, which |
| sidebarProjectGrouping.ts | apps/web/src/sidebarProjectGrouping.ts | Seam for v1 apps/web/src/sidebarProjectGrouping.ts (goat 916b5ccc1b2): settings scope needs only the project snapshot types, not v1's project store. |
| goat2/BotModelSettings.tsx | - | Settings > GOAT Bot, Model row (Paper board 1QYE-2): v1's settings section and row (components/settings settingsLayout.tsx) with the GOAT 2 model picker. v1's goat-bot page has more rows (reply style, notes); those belong to the bot runtime (lane P2-E) and arrive with it. The choice is sent with change_thread on the bot's thread. |
| goat2/Goat2ModelPicker.tsx | - | GOAT 2's model picker: v1's ProviderModelPicker with the entries and model options derived exactly as v1's GOAT Bot picker derives them (components/goatBot/useGoatBotModel.ts:28-38 at goat 916b5ccc1b2) for GOAT 2's one environment. The GOAT 2 frame owns where the choice goes (change_thread on the thread, docs/part2/provider-wire.md). |
| goat2/ProvidersSettingsScreen.tsx | - | GOAT 2's Settings > Providers page: v1's providers route body (routes/_chat.settings.providers.tsx at goat 916b5ccc1b2) for GOAT 2's one environment (no project scopes, so no projectIds), inside the toast providers v1's root mounts (routes/__root.tsx:164-168). v1's SettingsPageShell (breadcrumb header, close button) is app chrome GOAT 2's own top bar replaces (Paper board 1PBB-2), so the panel renders directly in the |
| goat2/SettingsNavFrame.tsx | apps/web/src/components/settings/SettingsSidebarNav.tsx | Seam for v1 apps/web/src/components/settings/SettingsSidebarNav.tsx (goat 916b5ccc1b2): provide v1 sidebar context at the GOAT 2 surface boundary. |
| goat2/i18n.tsx | - | v1's gt-react setup (apps/web/src/i18n/initializeI18n.ts + I18nProvider.tsx at goat 916b5ccc1b2) for the lifted surfaces. GOAT 2 is English first (owner rule), and English is v1's source text, so no translation chunk is loaded: v1's initializeGTSPA call with only its default locale, and its GTProvider with empty translations. |
| components/sidebar/SidebarChrome.tsx | apps/web/src/components/sidebar/SidebarChrome.tsx | Seam for v1 apps/web/src/components/sidebar/SidebarChrome.tsx (goat 916b5ccc1b2): GOAT 2's own rail replaces the utility menu. |
| components/settings/useAvailableSettingsSearchItems.ts | apps/web/src/components/settings/useAvailableSettingsSearchItems.ts | Seam for v1 apps/web/src/components/settings/useAvailableSettingsSearchItems.ts (goat 916b5ccc1b2): GOAT 2 exposes only the provider settings rows. |
| components/settings/useSettingsSectionPrefetch.ts | apps/web/src/components/settings/useSettingsSectionPrefetch.ts | Seam for v1 apps/web/src/components/settings/useSettingsSectionPrefetch.ts (goat 916b5ccc1b2): GOAT 2 does not expose v1 route or environment prefetching. |
| components/clerk/GoatConnectSidebarSignIn.tsx | apps/web/src/components/clerk/GoatConnectSidebarSignIn.tsx | Seam for v1 apps/web/src/components/clerk/GoatConnectSidebarSignIn.tsx (goat 916b5ccc1b2): GOAT 2 has no cloud sign-in UI. |

### Build wiring for the lifted tree (P2-M for lanes F and P2-M; devlog 070 Revision A2 and audit-3 residuals)

| GOAT 2 path | v1 source @916b5ccc | How / why |
|---|---|---|
| apps/web/vite-plugin-v1.ts | - (new) | Resolves imports from src/v1 through src/v1/aliases.json + seam/npm-aliases.json, so lifted files stay byte-identical; only importers under src/v1 are aliased (GOAT 2 keeps the real @base-ui/react). Also resolves @v1/surfaces for GOAT 2 code. |
| apps/web/tsconfig.v1.paths.json (generated by scripts/v1-lift.py) | - | The same alias map as TypeScript paths; no second hand-kept copy. |
| apps/web/tsconfig.v1.json, tsconfig.v1-all.json | v1 apps/web/tsconfig.json (compiler options) | v1 code needs v1's options (no verbatimModuleSyntax/erasableSyntaxOnly); tsconfig.v1.json typechecks what @v1/surfaces reaches and is part of `pnpm typecheck`; v1-all is the whole tree, not a gate yet. |
| apps/web/src/v1/seam/goat2/surfaces.ts + surfaces.types.ts | - (new) | @v1/surfaces: the only way GOAT 2 code reaches v1. GOAT 2's tsconfig sees the declarations; tsconfig.v1.json checks the implementation against them. |
| apps/web/postcss.config.js + apps/web/v1-css-scope.js | - (new) | @tailwindcss/postcss (source detection limited to src/v1), then postcss-prefix-selector on src/v1 CSS only: :root/:host -> [data-v1]; html/body -> [data-v1-body] (v1 page rules: height 100%, overflow hidden, position relative, 100svh, grain; opt-in for a full-page v1 surface); every other top-level rule -> :where([data-v1]) <sel>. Class rules are scoped too because v1 uses @theme inline (utilities carry literal values, e.g. text-work-log 0.78125rem, and would style GOAT 2 elements); :where() adds no specificity, so v1's cascade is unchanged. .dark variants never activate. |
| apps/web/src/v1/seam/v1-entry.css | apps/web/src/index.css (imported unchanged) | Loaded right after the byte-identical index.css, which main.tsx and V1Boundary.tsx import directly so its relative url() (Pretendard font) resolves from its own folder and the font ships in dist; Tailwind scans src/v1 via the postcss base option. Adds v1's body typography (font-family var(--font-sans), color var(--foreground)) on every [data-v1], since body maps to the opt-in [data-v1-body]; and pointer-events back for portal descendants (zero specificity, v1's pointer-events-none still wins). |
| apps/web/src/v1/seam/V1Boundary.tsx | - (new) | The [data-v1] element a v1 surface renders inside; imports v1-entry.css. |
| apps/web/src/v1/seam/base-ui/portalRoot.ts + base-ui/<part>.ts, <part>.parts.ts (combobox, context-menu, dialog, menu, popover, select, toast, tooltip) | @base-ui/react/<part> (npm, v1 lock version) | v1 portals go to <body>; GOAT 2 scopes v1 CSS, so a Portal without a container (tooltip passes container={undefined}) mounts into one [data-v1][data-v1-portal] root under <body>: fixed, viewport-sized like body (shrink-to-fit popups keep their width), pointer-events none on the root itself. The real package is imported by file path (no alias recursion); named namespaces and Portal.Props/State types kept. Only parts that render a Portal are wrapped (scripts/v1-lift.py detects them). |
| apps/web/src/main.tsx (v1-entry.css import, ?v1fixture) | - | v1 CSS loads with the app, so the 7 bot-home pixel baselines (maxDiffPixels 0) prove it leaks nothing; ?v1fixture mounts seam/fixture/V1Fixture.tsx for e2e/v1fixture.spec.ts (tokens inside, browser defaults outside, both popups painted inside the portal root). |
| apps/web/e2e/baseline.spec.ts-snapshots/*.png | - | Recaptured on mac-studio from clean goat2_ui 6f79579 (the origin-Mac captures differ by font rasterization before any change). |

Global names (audit-3 residual): v1's @keyframes (fleet-*, goat-arrive, goat-mobile-*, goat-onboarding-signal, live-activity-focus*, live-tool-shine, preview-loading-progress, scroll-edge-fade, settings-search-target-pulse, sidebar-drag-label-reveal, status-ping, status-pulse, Tailwind's spin) and the Pretendard @font-face stay global. Checked against GOAT 2 CSS and inline styles (apps/web/src outside v1, packages/*): GOAT 2 defines and uses only goat2-spin and goat2-chip-spin and never names Pretendard, so nothing collides.

### GOAT 2 provider surfaces (lane P2-M, 2026-11-29)

New GOAT 2 code around the lifted v1 provider screens; no v1 counterpart unless named.

| GOAT 2 path | v1 source @916b5ccc | How / why |
|---|---|---|
| docs/part2/provider-wire.md | packages/contracts/src/{rpc,server,providerSetup,acpRegistry}.ts (names and shapes) | owner-approved provider wire; lane C implements the frames, lane E the host module |
| apps/web/src/providers/wire.ts | the same v1 shapes, via lane C's generated TS (goat2_contracts_step2 1a1b123) | field-for-field mirror until contracts step 2 reaches goat2 |
| apps/web/src/providers/hostProviderPort.ts | v1 WS method names (rpc.ts WS_METHODS) | answers the v1 methods the screens call with provider frames; v1 methods GOAT 2 does not serve (provider self-update, credential sign-in steps, install removal) are refused with a sentence |
| apps/web/src/host/client.ts (watchProviders, providerCommand) | - | providers subscription (resubscribe on reconnect, stale subIds dropped) and provider commands |
| apps/web/src/host/fakeProviders.ts + fakeHost.ts delegation + HostProvider scenes | Paper boards 1PBB-2 / 1QAN-2 (drawn from v1), v1 model defaults (contracts model.ts:126-160), live ACP registry index | demo provider world for scenes and the prototype; flows step through v1's phases; never signs in or installs for real |
| apps/web/src/settings/SettingsMode.tsx, App.tsx settings mode, ui-state settingsPath | routes/_chat.settings.providers.tsx | GOAT 2 frame (rail + v1 settings nav + page); Providers and GOAT Bot pages live, other sections Planned |
| apps/web/src/App.tsx BotModelPicker / BotSettingsPage / useThreadModelChange | components/goatBot/GoatBotModelPicker.tsx | composer chip and bot settings use v1's picker; the choice is change_thread on the bot's thread |
| apps/web/e2e/providers.spec.ts, src/providers/hostProviderPort.test.ts, src/v1/seam/goat2/providerPort.test.ts | - | the 11 local kinds listed with state, sign-in, registry add, pickers, nav; adapter frames; fake data through v1 schemas |
| apps/web/e2e/baseline.spec.ts-snapshots (2026-11-29) | - | recaptured after the composer chip became v1's picker trigger (v1 shows the short model name, e.g. "6.1 Sol") |

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
| `src/engine.rs` boot | A/ClaudeAgentSdkQueryRunner.ts:75-76 (5 min boot, 90 s MCP), :500-540 (MCP servers sent with `mcp_set_servers` on stdin, never argv or env); A/ClaudeAdapterV2.ts:719-735 (appended system prompt; the SDK sends it as initialize `appendSystemPrompt`) | ported. The lane brief named `--mcp-config`; v1 keeps the bearer out of argv and the owner confirmed following v1. Servers Claude cannot attach (per-server `errors` or a refused request) are logged by name only (`claude-mcp-servers-unavailable`, :609-625; only names GOAT registered are printed, other keys are counted) and the session carries on; a timeout or Claude exiting during registration fails the start. Every reason the driver hands out (control errors, failed-turn and exit reasons from results or stderr, sign-in and steer-cancel messages) has the bearer token and any `Bearer` value redacted (new in GOAT 2) |
| `src/engine.rs` MCP server config | A/ClaudeAdapterV2.ts:778-830 (`goat` http server, `Authorization` header, 65 min `timeout`) | ported |
| `src/engine.rs` turns and steering | A/ClaudeUserMessage.ts; A/ClaudeTurnCursor.ts (synthetic `turn:` ids); A/ClaudeAdapterV2.ts:9899-10061 (steer = `priority:"next"` user frame with uuid, echo = acceptance); A/ClaudePromptFrames.ts:32-84; A/ClaudeSteerLifecycle.ts (hold a result while a steer is queued, drop refused/cancelled/discarded steers) | ported. Only a CLI that reports `command_lifecycle` is steered (decided by the first frame after the root prompt; 2.1.268/2.1.288/2.1.332 send it first): `steer` waits for that, then answers from Claude's first verdict (`queued`/`started`/echo/refusal). On a CLI without it (or before it shows either way within the steer deadline) the steer is Declined and never written, so the host queues it as the next turn's followup; deliberate difference from v1 (owner decision 2026-11-29), which steers such CLIs blindly and cannot tell whether a steer was read; what happens to the steer afterwards goes out as `EngineEvent::SteerUpdated`, v1's `steer.updated`. Consumption = `started` or a uuid echo, never `completed` alone (A/ClaudeAdapterV2.ts:5237-5256). Late status: `EngineEvent::SteerUpdated` (lane C step 2) carries v1 `steer.updated`; deliberate difference from v1 (owner decision 2026-11-29): for `Cancelled` the host requeues the input as a followup with the same inputId, like `SteerResult::Declined`, where v1 marks the message cancelled (A/ClaudeAdapterV2.ts:5223-5266, ProviderEventIngestor.ts:638-664). A steer is accepted when Claude's verdict is read (`queued`/`started`/echo), so its outcome is always reported in frame order before its turn ends: Completed when Claude starts or echoes it (read is final), Cancelled when Claude cancels/discards/refuses it unread; at turn end a steer with no evidence of being read is Cancelled before TurnFinished (lane C contract: Completed = read); deliberate difference from v1 finalizeActiveTurn (A/ClaudeAdapterV2.ts:5296-5305), which marks pending steers completed with a completed turn. A turn that ends before a steer has a verdict (still being written, or written and unanswered) answers Unknown, since Claude may run (or have run) it; Declined is kept for a refusal or a write that never landed. A success is held for a pending steer only when it echoes prompt uuids (v1 holdSuccessfulResult); a steering abort keeps a steered turn open (:7830) |
| `src/engine.rs` interrupt | A/ClaudeAdapterV2.ts:9755-9818 (active turn only; interrupt timeout keeps the turn open), A/ClaudeStopTeardown.ts `interruptUnlessClosed` (interrupt control with 10 s, then close the query), `CLAUDE_STOP_CONFIRM_TIMEOUT_MS` (10 s) | ported: interrupt control, then TERM/KILL the process group; the exit settles the turn as interrupted; unconfirmed within the deadline the turn stays open and `interrupt` returns an error. A result that arrives before the interrupt answer is held until it: a refusal makes it a normal completion. No turn starts while an interrupt is closing the CLI; shutdown is final, a reopen in flight starts nothing. The next turn starts a new process with `--resume` (host restarts the session after `Exited`) |
| `src/engine.rs` exit settlement and background subagents | A/ClaudeAdapterV2.ts:9219-9236 (`finalizeActiveTurnAfterQueryExit`, `endSubagentCallsOfClosedQuery` interrupted/failed), :2572-2574 (background subagents kept past root settlement) | ported: one idempotent settlement on EOF, shutdown, write failure or failed reopen closes requests, settles a turn whose prompt was written, ends retained background subagents, reaps the group, then `Exited`. A background subagent completes on the turn that started it; v1 wake turns are not ported |
| `src/engine.rs` model, mode and `set_config` | A/ClaudeAdapterV2.ts:8918-8926 (no process replacement while background work runs), ClaudeQueryRunnerErrors.ts:61-67 (message) | ported: a turn whose settings need a new process is declined with v1's text while a background subagent (live from its `task_started` `local_agent` until a notification or terminal update, in any frame order, v1 sessionSubagentsByTaskId / ClaudeAdapterV2.test.ts:12230-12253) or a background shell command runs (checked in one step with the generation change, under the frame gate; v1 `local_bash` roster from `task_started`/`task_notification`/`background_tasks_changed`, A/ClaudeAdapterV2.ts:6350-6440, A/ClaudeBackgroundTasks.ts:6-13); `set_config` applies model and permission mode on the live process and answers `Unsupported` for effort, thinking or fast mode (launch settings); refusals come before any change, and a refused permission-mode change after a model change sets the model back; a model or permission request Claude never confirms ends the process so the host resumes in a known state (new in GOAT 2; v1 has no live config call) |
| `src/engine.rs` `can_use_tool` | A/ClaudeAdapterV2.ts:8241-8520 (AskUserQuestion, ExitPlanMode denial text, removal check, approval prompt choice, no-active-turn and computer-use denials); A/ClaudeApproval.ts (presentation, `permissionResultFromDecision`, session grants, removal denial text) | ported; v1 never offers `acceptAlways` to Claude, GOAT 2 reads it as accept-for-session |
| `src/engine.rs` result status and failure text | A/ClaudeResultFailure.ts:13-212 | ported (`terminalResultError` texts verbatim, 429/529 texts); no usage-limit reset-time parsing |
| `src/engine.rs` sign-in message | D/ClaudeHome.ts:131-140 `claudeSignedOutMessage` | verbatim text |
| `src/items.rs` | A/ClaudeToolFrames.ts:72-503 (classification, command/file/summary/web search, subagent report cleanup, async launch ack); A/ClaudeAdapterV2.ts:1917-2016 (questions, answers, todo steps), :2166-2175 (plan) | ported; tool output stays out of items (`outputOmitted`), as in the Codex driver |
| `src/probe.rs`, `data/model-manifest.claudeAgent.json` | apps/server/src/provider/ClaudeProvider.ts:861-885 (messages); apps/server/src/provider/model-manifest.json `providers.claudeAgent` | manifest verbatim; probe adapted to `claude --version` / `claude auth status` instead of an SDK query |
| `src/process.rs` | GOAT 2 `crates/goat2-engine-codex/src/process.rs` (lane B, branch `goat2_engine_codex` c297ed6) | copied (drivers may not depend on each other); adds `stderr_handle` |
| `src/bin/fake_claude.rs` | A/ClaudeAdapterV2.testkit.ts:488-890 `makeReplayQueryRunner` (strict cursor, uuid replacement) | adapted to the wire: translates v1 SDK-level transcript frames to stream-json |
| `tests/fixtures/v1/*.ndjson` | apps/server/src/orchestration-v2/testkit/fixtures/{simple,multi_turn,multi_turn_restart,queued_turn,claude_idle_resume,subagent,tool_call_restricted_granular,tool_call_denied_write,message_steering,turn_interrupt,claude_result_is_error}/claude_transcript.ndjson | verbatim |
| `tests/fixtures/wire/auth_failure_2_1_332.ndjson` | real `claude` 2.1.332 stdout, logged-out home, 2026-11-28 | captured; init lists trimmed, home path anonymised |

New in GOAT 2: the other `tests/fixtures/wire/*` (hand-written from 2.1.332 frame shapes seen in the capture: `command_lifecycle`, `set_model`/`set_permission_mode`/`mcp_set_servers` responses), `src/protocol.rs` framing, `src/util.rs`.
