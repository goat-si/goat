# 000 — GOAT Bot → Orca Bots parity: plan

Owner request (2026-11-21 KST): observe Orca's new Bots, plus well-known T3 Code–based bot apps, and bring GOAT Bot's UI, mobile integration and triggers up to Orca Bots' level. This folder is the roadmap; each unit ships as its own PR to `dev`.

## Corpus analyzed

Read-only clones under `~/Developer/codex` (not part of this repository). Analysis notes and full-size captures live in `~/Developer/codex/274_orca-analysis/`.

| Project                                 | Path            | Commit                                                                        | Why it is here                                      |
| --------------------------------------- | --------------- | ----------------------------------------------------------------------------- | --------------------------------------------------- |
| Orca (stablyai/orca, MIT, 131k★)        | `274_orca`      | `a5d0894a18cdd5f91293dc1c3abafb9c23c98e0a` (main, 2026-11-20, after v1.4.268) | Target: Orca Bots                                   |
| akeru-bot (opencoredev/akeru-bot, 132★) | `275_akeru-bot` | `de3bbc49ee106c9398609dc9859d27d95723571e`                                    | T3 Code fork: named bots on desktop, web and mobile |
| t3-tots (Deepusleepy/t3-tots, 215★)     | `276_t3-tots`   | `1d87d0ec320fb2cc42022fe7055bcae7cb144602` (v1.5.1)                           | Grok Bot–style companion for T3 Code                |
| threebot (RokaSwK/threebot, 44★)        | `277_threebot`  | `d6126b2155ac2eef806dfbedd6645aef1a1ff152` (v0.1.14)                          | Bots modeled as T3 threads                          |
| GOAT                                    | this repository | `d154f9218b1` (origin/dev at start)                                           | Baseline                                            |

Earlier GOAT Bot research this builds on: `~/Developer/codex/049_goat-bot-uiux-catchup` (gap ledger, Grok Bot parity, Home redesign), `045_grok-bot-analysis`, `047_bot-orchestrator-redesign`, `048_goat-bot-tab-redesign`, `270_openbot`, `271_openmausbot`, `272_deepseek-bot`.

## Documents

| Doc                    | Contents                                         |
| ---------------------- | ------------------------------------------------ |
| 000_plan.md            | This page: corpus, constraints, unit order       |
| 001_feature_matrix.md  | Orca Bots vs GOAT Bot by surface                 |
| 002_ux_observations.md | Experience audit with captures                   |
| 003_gap_ledger.md      | Gaps with severity and the unit that closes each |
| 010…0n0                | One decade doc per implementation unit           |
| 900_ledger.md          | Append-only progress ledger, one entry per unit  |

## Constraints every unit keeps

- Every surface: web, desktop and mobile decide each feature; a capability people can trigger is also reachable by agents through a service method and the MCP surface.
- Remote first: the client, server and agent may be on different machines; nothing assumes the bot's host is the viewing device.
- Performance: no continuously repainting animations; bounded websocket payloads and lists.
- New server settings reach agents through `SETTINGS_ACCESS`; wire types live in `packages/contracts`.
- Server resilience: every emitter guarded, every buffer and fan-out bounded.
- GOAT-owned modules; upstream T3 files get thin hooks only.
- External accounts (Slack, Linear, GitHub apps, APNs/FCM keys) are never created by agents; units needing them stop at a decision request.

## Units, in order of user value

| Unit                                                           | Closes                     | Class | Depends on                       | Decision              |
| -------------------------------------------------------------- | -------------------------- | ----- | -------------------------------- | --------------------- |
| [010](010_bot_event_triggers.md) Events start a named bot      | G01, G02                   | C4    | —                                | D1                    |
| [020](020_bot_work_items.md) Bot work says what done means     | G03                        | C4    | —                                | —                     |
| [030](030_bot_attention_alerts.md) Alerts when a bot needs you | G04, G05; G06, G07 partial | C4    | —                                | D2 (slice B)          |
| [040](040_slack_named_bots.md) Slack reaches named bots        | G08                        | C4    | —                                | D3                    |
| [050](050_bot_private_memory.md) Each bot keeps its own memory | G09                        | C4    | —                                | —                     |
| [060](060_bot_templates.md) Start from a template              | G10                        | C4    | 010, 050                         | —                     |
| [070](070_run_history.md) Run history says why                 | G11                        | C4    | 010                              | —                     |
| [080](080_mobile_continuity.md) The phone keeps up             | G12–G14                    | C4    | 010 (trigger rows), 070 (labels) | —                     |
| [090](090_bot_tool_scope.md) Tools per bot                     | G15                        | C4    | 050                              | —                     |
| [100](100_bot_sharing.md) Share a bot's setup                  | G16                        | C4    | 050, 060, 090                    | —                     |
| [110](110_agent_bot_surface.md) Agents propose bots            | G17                        | C4    | 060                              | D4                    |
| [120](120_hand_to_bot.md) A bot follows a thread               | G18                        | C4    | 020                              | —                     |
| [130](130_linear.md) Linear                                    | G19                        | C4    | 010                              | D5 (needs an account) |

Every unit changes a wire contract, persisted state or authority, so every unit is C4: a full plan at its start, failing-first tests including the denied, revoked and mixed-version cases, `vp run check:changed`, a fresh independent review, and a merge through `node scripts/merge-pr.ts` only when `goat-ci-result` is SUCCESS on the exact head. Before merge, every unit carries real-client captures on **each client surface it changes** — web/desktop through test-goat-app, iOS simulator and Android emulator through test-goat-mobile, with the Replay provider — and its unit doc lists them; a surface left unchanged is named as such in the PR. Three integrated passes then walk whole journeys across units: **M1** after 010–030 (an event starts a bot, its task says what done means, the person is alerted and answers), **M2** after 040–080, **M3** at the end.

## Decisions

Product calls go to a GOAT decision request when the unit starts; until answered, the dependent slice waits and other units proceed.

| ID  | Question                            | Recommendation                                                                                                        |
| --- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| D1  | What may an event trigger do?       | Start new work only, in its project, under a revocable grant re-checked at dispatch; timer check-ins stay answer-only |
| D2  | How does push reach a closed phone? | Wait for GOAT Connect; ship alerts for running clients now                                                            |
| D3  | How does Slack pick a bot?          | One Slack app; per-channel binding plus a name prefix, decided once per Slack thread                                  |
| D4  | What may agents do with bots?       | Propose only; a person accepts                                                                                        |
| D5  | Linear                              | Deferred until the owner sets read/write scope and provides the account                                               |

## Done means

Every unit meets its acceptance criteria with fresh evidence recorded in [900_ledger.md](900_ledger.md): the merged PR, the exact head with a green `goat-ci-result`, the review verdict and the captures. Units or slices waiting on D2 slice B or D5 end as NEEDS_HUMAN with the decision id, and their gaps stay open in [003](003_gap_ledger.md).

## Review history

- 2026-11-21: first independent audit returned FAIL with nine blockers (trigger authority and settlement, alert delivery path, Slack thread routing, enforcement points for memory and tools, import posture, agent authority, follow provenance, verification floors). All nine were folded in at a0e26fef649.
- 2026-11-21: second independent audit (fresh reviewer) returned FAIL: B3, B7, B8 closed; B1, B2, B4, B5, B6, B9 still open, plus five new blockers (local notification permission without Connect, Slack routing must not grant memory, Slack tasks must open, offline cache contents, export secret policy). All were folded in the next commit; verdicts are recorded in 900.
