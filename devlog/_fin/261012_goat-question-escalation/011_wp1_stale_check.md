# 011 — wp1 stale check after rebase onto origin/dev (32f7bda9b)

wp1 consumes [010_wp1_foundations.md](010_wp1_foundations.md) with its binding errata. Base moved from `070941cae` to `32f7bda9b` (10 commits). Of the 43 source paths 010 names, five changed upstream:

| Path                                                                                              | Upstream change                                                                           | Effect on 010                                                                     |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `apps/server/src/mcp/toolkits/project/handlers.ts`                                                | `goat_project_list/read` gained `host` via `HostThreadsMcpService.readOnHost` (09b3aac83) | Launch handler (§3.1) unchanged; line numbers shift by ~+28. Re-anchor by symbol. |
| `apps/server/src/mcp/toolkits/project/handlers.test.ts`                                           | host tests added                                                                          | Extend the existing launch test by name, not line.                                |
| `apps/server/src/mcp/OrchestratorMcpService.ts`                                                   | webhook URL helpers (a67fc3857)                                                           | `create_threads` site (§3.3a) unchanged; lines shift ~+33.                        |
| `apps/server/src/mcp/OrchestratorMcpService.test.ts`, `apps/server/src/mcp/toolkits/core.test.ts` | tests for the above and for strict arguments                                              | No conflict.                                                                      |

New upstream constraint (ed96cfee2, `McpHttpServer.refuseUndeclaredArguments`): every MCP tool now refuses undeclared top-level arguments before its handler runs, with `invalid_request` "… does not take X, so nothing ran". Consequences:

- wp1: `reason` must be declared on `goat_pending_request_respond`'s parameter schema (010 §2.4 already does). No hidden arguments.
- wp3: `launcher` and transported `respondedBy` must be declared on `goat_thread_launch`/`goat_pending_request_respond`. A strict remote without them refuses before creating anything, so 030's SSH launch may retry once without `launcher` on exactly that refusal ("does not take launcher") — this resolves 030 open question 5. A pre-strict old remote silently drops it (documented).
- `HostThreadsMcpService` now exposes a generic `readOnHost(scope, {host, tool, arguments}, decode)`; wp3 reuses it for list/read instead of a copy.

Consultation record: wp1's decisions were made in the wp0 roadmap consultation (architect proposal `q13-wp0-architect-proposal`, reflection `q13-wp0-architect-reflection`, audit `q13-wp0-audit-r1b`). This P re-verifies the pre-written doc (DIFFLEVEL-ROADMAP-01) and adds no new decision, so no new architect round is opened.

## wp1 execution packet

- Builder: one `delegate_task` implementation child on `codex/gpt-6.1-sol` in this worktree (no concurrent writers), implementing 010 + errata E1–E11 + 000 dispositions, one commit `feat: record who launched a thread and who answered its questions` with `Refs #13`.
- Verifiers (from 010 §9 with E11): `$B/vp test run` on the touched test files; `$B/vp lint` on touched files; `tsc --noEmit` in `packages/contracts`, `packages/provider-core`, `packages/shared`, `packages/client-runtime`, `apps/server`, `apps/web`; mobile typecheck via its package script if mobile files change.
- Review: Anthropic-family reviewer on the wp1 diff before D.
