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
packages/provider-icons/src/ProviderChip.tsx, apps/web/src/bot-home/*, apps/server/src/*,
apps/desktop/src/*, docs/PRD.md, README.md, package/workspace manifests (modeled on goat's
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
||||||| parent of 7445429b537 (feat(thread-store): startup bench, fewer syncs on settlement, v1 rule ports, design doc)
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
