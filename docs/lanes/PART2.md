# GOAT 2 Part 2 lanes (bot runtime + every GOAT v1 provider)

Design source of truth (read first): https://goat-si.github.io/goat2-design/prd/part2/
(source `goat-si/goat2-design/prd-src/part2/*.md`, local `~/Developer/goat2-design`).
Pages: `index` (scope, done criteria), `providers` (every v1 provider from source, trait gaps), `bot` (what "bot works"
needs, v1 channel files), `plan` (lanes, order).

**Every rule in `docs/lanes/PART1.md` applies unchanged**: lift from GOAT v1 first (read real source at `origin/dev`,
record in `docs/PROVENANCE.md`), `structure/` is the code-structure SSOT (propose changes to the owner), PRD edits only
after owner approval, fixed decisions, workspace + kache, cxc-loop, the merge lock script (incl. the conflict-marker
check), **merge only after a fresh independent review PASS on the exact lane head**, `goat2` always builds, rebuild
GOAT 2 (Dev) after merges that touch host/ui/desktop. Ask the owner: `aside session queue abQKPhrntOQV9jG1 "[goat2_<lane>
thread <id>] ..."`.

## Part 2 additions
- v1 reference commit: `goat-si/goat` `origin/dev` `916b5ccc1b2` (same as Part 1). Lift once, do not chase v1.
- Provider list = v1 `apps/web/src/components/settings/providerDriverMeta.ts` (14 driver kinds). Part 2 covers the 11
  local ones; Cursor Cloud, Claude Cloud, Devin Cloud are Part 3. Routines are not in Part 2.
- Each driver declares v1's capability flags for its driver kind (`goat2-contracts::ProviderCapabilities`) and the
  host chooses steer vs interrupt-restart from them (ACP: `supportsActiveSteering: false`,
  `supportsSteeringByInterruptRestart: true`, v1 `packages/provider-acp/src/server/capabilities.ts`).
- Contract format v1 is frozen: new enum variants / fields are **additive only** and go through lane C.
- Every driver ships a fake engine that replays recorded sessions (v1 `*.testkit.ts`, `apps/server/scripts/acp-mock-*.ts`)
  so `cargo test` never needs a real CLI or a login.
- Never put provider credentials in logs, `goat.jsonl`, screenshots or test fixtures.

## Order
1. Lane C (with E): additive `EngineDriver` variants (`Claude`, `Acp { agent_id }`, `SdkHelper { driver_kind }`),
   `EngineFactory::capabilities()`, `SessionSpec.instructions` + `launch {binary,args,env}`, a `ProviderProbe` trait
   (installed, version, auth state, models), `EngineEvent::AuthRequired { url }` / `SubagentUpdate`,
   `EngineSession::set_config`. Announce to B/E before merging.
2. Wave 1 now: C + P2-A + P2-B + P2-S. Wave 2 after the Part 1 host (E) merges: P2-E, P2-F, P2-M, P2-D. P2-F follows P2-E's commands; P2-M follows the probes. P2-D runs throughout.

## Lanes
| Lane | Branch / folder | Crates / paths | Lift from v1 | Done when |
|---|---|---|---|---|
| C contracts (continues) | `goat2_contracts` | `goat2-contracts`, `goat2-engine-api` (with E) | `providerCapabilityParts.ts`, `orchestrationV2.ts`, `botProfile.ts`, `channelBotAttention.ts`, `agentSurface/entries/decision.ts` | trait additions above + decision/inbox/probe types, TS + schema regenerated, fixtures |
| P2-A Claude | `goat2_engine_claude` | `crates/goat2-engine-claude` | `Adapters/ClaudeAdapterV2.ts` + `Claude*.ts` rules, `claudeLaunch.ts`, `goatClaudeMcpServers.ts`, lane D's Agent SDK notes | drives `claude` stream-json directly (`can_use_tool`, `interrupt`, `set_model`, `set_permission_mode`, `--resume`, `--mcp-config` HTTP, appended system prompt, `task_*`); fake-claude replay tests; flags equal v1 `claudeAgent`; one Claude bot turn in Dev |
| P2-B ACP | `goat2_engine_acp` | `crates/goat2-engine-acp` (+ registry module) | `packages/effect-acp` (v1 normalization), `packages/provider-acp/src/server/*`, `packages/provider-acp-registry/src/*`, `provider-grok`, `provider-fx`, `apps/server/src/provider/acp/Antigravity*.ts` | Zed `agent-client-protocol` crate driver (initialize, session new/load/resume, prompt, cancel, request_permission, elicitation, modes, `mcpServers`, `systemPrompt append`), interrupt-restart steering; registry (CDN index, install npm/uvx/binary, command paths, local presets omp/minimax-code, per-agent fixes: Grok xAI extension, Antigravity auth URL, fx, Copilot, Devin, Droid, Kimi, OpenCode, omp, MiniMax, DeepSeek); mock-agent tests ported from v1; Grok, fx, Antigravity and 2+ registry agents run a turn in Dev |
| P2-S SDK helper | `goat2_engine_sdk` | `apps/engine-helper` (Node), `crates/goat2-engine-sdk` | `packages/provider-cursor`, `provider-opencode`, `provider-muse`, `provider-pi` (Pi/OmO via `--mode rpc`; move to Rust if the RPC is simple) | one stdio JSON shape for SDK-only engines; per-engine fake SDK tests; one turn each in Dev; one helper crash does not kill other engines; lane G bundles the helper |
| P2-E bot runtime | `goat2_bot_runtime` | `goat2-host` (bot module) | `channels/ChannelSessionFirst.ts` (ACK 20s / fixed line 55s, `:59-60`), `ChannelBotSession.ts`, `channelBotSessionBrief.ts`, `channelBotSessionRotation.ts`, `channelBotAttention.ts`, `channelDecisionChoices.ts`, `channelNativeQuestionCards.ts`, `ChannelChildWork.ts`, `channelBotNotes*.ts`, `agentSurface/entries/decision.ts` | main bot + bot registry, session brief/rotation, `send_to_user` ack/result with the 20s/55s guards, decision MCP (open/read/answer), inbox + per-bot counts in cards, bot notes read/write/inject, bot commands + subscriptions; PRD Part 2 done criteria 1-5 and 8 on Codex |
| P2-F ui (continues) | `goat2_ui` | `apps/web` | v1 `apps/web` chat + question card components (lifted directly) | bot home on the real host (fake scenes off), multi-question decision card (Back/Next, per-option description, recommended), inbox I1-I4, counts + face states, live task panel; side-by-side with Paper boards |
| P2-M providers UI | `goat2_providers_ui` | `apps/web` (settings, picker) | v1 `providerDriverMeta.ts`, provider settings screens, ACP registry dialog | provider list with install/auth state, login flow, model picker (composer chip + bot settings), registry search/install; all 11 local providers listed with correct state |
| P2-D parity (continues) | `goat2_parity` | `goat2-parity`, `docs/parity/` | v1 `*.testkit.ts`, `apps/server/scripts/acp-mock-*.ts`, `record-grok-acp-replay-fixture.ts` | per provider: one turn, stop, approval, question, resume, subagent recorded and compared v1 vs GOAT 2; capability table matches |
| E host (continues) | `goat2_host` | `goat2-host` | - | hosts the new drivers behind the trait, chooses steer/restart from flags, probes on demand |
| G desktop (continues) | `goat2_desktop` | `apps/desktop`, `scripts/` | v1 provider binary resolution | bundles `apps/engine-helper`, Dev build after merges |

A (thread_store) continues small: additive card fields for bots (`openAsks`, `unread`) and the bot notes folder.
B (engine_codex) finishes Part 1, then only adds `capabilities()` / instructions for Codex.
