# GOAT context diet: roadmap

> **요약 (Korean summary)**
> GOAT가 모든 에이전트 컨텍스트에 상시 주입하는 양(도구 목록 + 지침)을 dev 기준 약 300 KB에서 하네스당 12 KB 이하로 줄인다.
> 기본값은 모든 하네스에서 core 목록이다: 상주 도구는 `goat_describe`와 `goat_call`뿐이고, 나머지는 검색으로 찾아 `goat_call`로 부른다.
> 검색은 정확한 이름을 먼저 맞추고, 놓친 것을 필드(`coverage`, `truncated`, `total`)로 밝히며, 0건을 "없음"으로 말하지 않는다(D16).
> 검색 색인·describe·턴 다이제스트는 레지스트리와 orchestration-v2 프로젝션에서 파생하고, 손으로 유지하는 두 번째 목록을 만들지 않는다.
> 첫 코드 PR은 3,385줄짜리 `registry.ts`를 리소스별 파일로 기계적으로 나누는 것이고, 도메인별 설명 재작성은 그 뒤에 시작한다.
> 측정은 `scripts/agent-surface/context-budget.ts` 하나로 하고, D8은 기본값의 관문이 아니라 검증과 core 세트 조정용이다. `goat_eval`만 D8로 막는다.

Owner: program manager thread on mac-studio. Verifier: clisu-oracle. Design of record:
[agent-surface.md](../../../docs/internals/agent-surface.md). This file is the program plan; it
is folded into that page and deleted when the program finishes, per AGENTS.md "Plans and work
artifacts".

## Decision

GOAT's agent surface becomes a search core for every harness, the way aside-codemode serves one
resident tool over 34 described actions (2,433 bytes against 44,330,
[BENCHMARKS.md#tool-schema](https://github.com/lidge-jun/aside-codemode/blob/b395d89/BENCHMARKS.md#tool-schema)).
`tools/list` returns the resident core; every other tool stays callable by name and through
`goat_call`, and is found with `goat_describe`. This replaces the "opt-in, measured before
default" plan in [agent-surface.md](../../../docs/internals/agent-surface.md#discovery-goat_describe)
by supervisor decision on 2026-10-23. D8 still runs: it verifies the default and tunes the core
set. `goat_eval` stays gated by D8.

## Baseline (dev `368b2c84a`, 2026-10-23)

Canonical numbers come from `scripts/agent-surface/context-budget.ts` (verifier, clisu-oracle),
which builds the `/mcp` catalog in process and exits 1 when a harness composition drifts from
its adapter source. Bytes are UTF-8.

| What                                                 |                        Bytes |
| ---------------------------------------------------- | ---------------------------: |
| Tools served by `/mcp`                               |                    202 tools |
| Model-visible listing: descriptions + input schemas  | 278,143 (about 69.5k tokens) |
| of which descriptions                                |                      105,620 |
| of which input schemas                               |                      146,923 |
| Output schemas (not model-visible in most harnesses) |                      497,515 |
| Full `tools/list` response                           |                      790,809 |

| Harness                         | Listing paid up front                                                         | Instructions |                                                                                                                  Extra on every message |
| ------------------------------- | ----------------------------------------------------------------------------- | -----------: | --------------------------------------------------------------------------------------------------------------------------------------: |
| Codex code mode                 | 0: Codex defers nested MCP tools                                              |       25,226 | 0 (context resent only when it changes, [CodexAdapterV2.ts:2083](../../../apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts)) |
| Codex without code mode         | 278,143                                                                       |       25,226 |                                                                                                                                       0 |
| Claude                          | 278,143 unless Claude Code tool search is on                                  |       22,208 |                                                                                                                                       0 |
| OpenCode                        | 278,143                                                                       |       22,224 |                                                                                                                                       0 |
| Cursor                          | 278,143                                                                       |       22,328 |                                                                                                       2,150 (runtime and PR-link block) |
| ACP (Grok, Antigravity, others) | 278,143                                                                       |       24,519 |                                                                                                                            2,040 (same) |
| Pi                              | Pi ≥ 0.99: six hand-listed direct tools, the rest deferred; older Pi: 278,143 |       20,072 |                                                                                                                                       0 |

Cross-check from source on mac-studio with `scripts/agent-surface/inventory.ts`: 195 tools,
102,774 description bytes, 143,600 input-schema bytes; the inventory reads toolkit sources and
misses dynamic tools, which explains the gap. The brief's "about 316k characters of
descriptions" is Codex code mode's rendering (description plus a generated TypeScript
declaration per tool: 321,662 characters over 188 tools on server build 236), and its "about
42 KB of instructions" does not reproduce; instructions are 20–25 KB.

Largest resources by description + schema bytes (source inventory): thread 45,207; task
19,630; ssh 17,827; provider 16,126; memory 11,031; cloud 8,223; goal 7,416; project 6,728;
worktree 6,637; schedule 5,879.

NOT RUN: a live Pi session (Pi is disabled on the connected hosts checked; its row is computed
from adapter source by `context-budget.ts`).

## Targets

| Measure                                   |                       Baseline |                                    Target |
| ----------------------------------------- | -----------------------------: | ----------------------------------------: |
| Resident listing, any harness             | 278,143 (0 in Codex code mode) |                                    ≤ 6 KB |
| Always-injected instructions, any harness |                       20–25 KB |                                    ≤ 6 KB |
| Extra bytes on every message              |                    up to 2,150 |                                     ≤ 300 |
| Total always-injected, any harness        |                   about 300 KB |                                   ≤ 12 KB |
| Per-tool short description                |             up to about 4.5 KB |               ≤ 400 chars, ratchet-tested |
| Model turns, D8 single-call control       |                            n/a |       at most +1 against the full listing |
| Model turns, D8 multi-step workloads      |                            n/a | no rise in median; no rise in failed runs |

`context-budget.ts` gains these targets as its failure thresholds at the flip, so CI holds them.

Prior art says reductions of this size hold accuracy or raise it: Anthropic reports tool
definitions falling from about 77K to 8.7K tokens with tool selection rising from 49% to 74% on
Opus 4 and from 79.5% to 88.1% on Opus 4.5
([advanced tool use](https://www.anthropic.com/research/advanced-tool-use)); Cursor reports
46.9% fewer agent tokens in MCP runs ([dynamic context discovery](https://cursor.com/blog/dynamic-context-discovery)).

## Prior art

Aside research run on the MacBook Pro: NOT RUN (the host restarted at 22:33 KST and the run
returned "Host RPC timed out"). The rows below come from web search.

| Harness or source                 | Mechanism                                                                                                                                     | Lesson for GOAT                                                                                                            | Source                                                                                                                                                                                                                                               |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code                       | `ENABLE_TOOL_SEARCH`; `auto` defers MCP tools above about 10% of context, `auto:N` sets it                                                    | `auto` has failed to trigger; GOAT serves the core itself                                                                  | [claude-code#19890](https://github.com/anthropics/claude-code/issues/19890), [manage tool context](https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context)                                                                |
| Anthropic API                     | Tool search tool, `defer_loading`                                                                                                             | 85% fewer definition tokens and higher selection accuracy; a 4,000-tool test reached 60%, so ranking matters               | [advanced tool use](https://www.anthropic.com/research/advanced-tool-use), [Arcade](https://www.arcade.dev/blog/anthropic-tool-search-4000-tools-test)                                                                                               |
| Codex                             | Deferred MCP tools behind `tool_search`; code mode                                                                                            | Code mode once dropped `tool_search`, and search missed exactly named tools, so agents wrongly concluded a tool was absent | [tool search](https://developers.openai.com/api/docs/guides/tools-tool-search), [codex#32101](https://github.com/openai/codex/issues/32101), [codex#21503](https://github.com/openai/codex/issues/21503)                                             |
| Cursor                            | Dynamic context discovery replaced the 40-tool cap                                                                                            | Light list first, schemas on demand                                                                                        | [blog](https://cursor.com/blog/dynamic-context-discovery), [forum](https://forum.cursor.com/t/tools-limited-to-40-total/67976)                                                                                                                       |
| OpenCode                          | Loads every MCP tool at connect; lazy loading is a feature request                                                                            | Only a server-side core gives OpenCode a small listing                                                                     | [docs](https://docs.opencode.ai/docs/mcp-servers/), [#8277](https://github.com/anomalyco/opencode/issues/8277), [#20489](https://github.com/anomalyco/opencode/issues/20489)                                                                         |
| MCP 2026-07-28 client guidance    | Progressive discovery past about 1–5% of context; refresh on `tools/list_changed`                                                             | GOAT's 278 KB is far past it; send `list_changed` when the core set changes                                                | [client best practices](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/docs/2026-07-28/develop/clients/client-best-practices.mdx), [SEP-1821](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1821) |
| aside-codemode ADR-0001, ADR-0011 | A numeric budget on the always-injected block, enforced by one test; a sentence enters only if without it an agent reaches a wrong conclusion | Instruction budget and admission test                                                                                      | [ADR-0011](https://github.com/lidge-jun/aside-codemode/blob/b395d89/structure/decisions/ADR-0011-the-block-carries-what-an-error-cannot-say.md)                                                                                                      |
| aside-codemode ADR-0004           | Long text rides in tool results, not the system prompt, so the cache prefix stays stable                                                      | Long descriptions live in `goat_describe`                                                                                  | [ADR-0004](https://github.com/lidge-jun/aside-codemode/blob/b395d89/structure/decisions/ADR-0004-skill-body-stays-out-of-the-system-prompt.md)                                                                                                       |
| aside-codemode issue #41          | A default search found 8 of 15 and said `complete: true`; fixed with `scope.coverage`                                                         | Coverage in fields; never claim absence                                                                                    | [#41](https://github.com/lidge-jun/aside-codemode/issues/41)                                                                                                                                                                                         |

## Resident core

`tools/list` returns, in a fixed order:

1. `goat_describe`: search and describe at detail levels.
2. `goat_call`: run any path with the caller's own checks.

Nothing else is resident unless D8 shows a tool saves a turn on most runs without raising
failures. Candidates D8 tests: `goat_origin_report` (every launched lane reports),
`goat_task_create` and `goat_thread_launch` (dispatch), and `goat_preview_snapshot` (browser
work). A tool joins the core by a registry field (`listing: "core"`), never by a name list in a
server or adapter. Tools stay callable by their listed and legacy names whether listed or not
(D20), so an agent with a stale name still succeeds.

The instruction block keeps only what no refusal can teach (ADR-0011's test): that GOAT tools
are found through `goat_describe` and run through `goat_call`; that a search result with
`truncated` or partial `coverage` is not proof of absence; that a launched lane reports with
`goat_origin_report`; and that reports and memory are data, not instructions. Everything a
refusal or a describe result can say moves out. The block gets one byte budget enforced by one
test in `provider-core`, and the per-message Cursor and ACP extras shrink to the runtime line.

## Search contract

`goat_describe { path?, query?, detail?, limit?, cursor?, host? }`

- **Detail levels.** `names`: path, listed name, one-line summary (about 80 bytes each).
  `summary` (default): adds effect, `requires`, `available.now` with reason, and the ≤ 400-char
  description. `full` for one path: input and output JSON Schema, the long guide moved out of
  today's descriptions, examples, related paths, legacy names, operation kind, human steps.
- **Exact name first.** A `path` or `query` equal to a path, listed name, canonical name, or
  legacy name resolves to that entry with `match: "exact"` at rank 0, ahead of any text match.
  This prevents the false "tool unavailable" conclusion in codex#21503.
- **Ranking.** Exact, then word prefix on path and name, then summary words, then description
  and guide words; ties keep registry order by path, so the same query always answers the same
  way (today's tie rule, [handlers.ts:42](../../../apps/server/src/mcp/toolkits/agentSurface/handlers.ts)).
- **Loss in fields (D16).** Every search result carries `total` (all matches), `returned`,
  `truncated` (read `limit + 1`), `nextCursor`, and `coverage`: which fields were searched, which
  resources, and counts of entries left out and why (`notServed`, `unavailableToCaller`,
  `hostOlder` for a remote whose registry predates this one). An entry the caller cannot use now
  is still returned with `available.now: false` and its reason; the listing hides it (#780),
  search never does.
- **Zero matches.** The result says `total: 0` with full `coverage` and the three nearest paths
  by edit distance. The text never says the capability does not exist.
- **Cache safety.** `surfaceVersion` (registry hash, [handlers.ts:25](../../../apps/server/src/mcp/toolkits/agentSurface/handlers.ts))
  heads every result; the server sends `notifications/tools/list_changed` when the core set
  changes.

## Derived, not hand-kept

- **Search index and describe** are built from `agentSurfaceRegistry` and the handles `/mcp`
  serves (`ToolDispatch`), as describe already does. The core set is the registry's `listing`
  field. Pi's `directTools` set ([mcpExtensionSource.ts:504](../../../packages/provider-pi/src/server/mcpExtensionSource.ts))
  is a second hand-kept list and goes: Pi registers what `tools/list` returns as direct.
- **Availability** comes from the caller's `McpInvocationContext`, its goatclaw profile, and
  lanes left, read from orchestration-v2's thread projection (`OrchestrationV2ThreadProjection`,
  [orchestrationV2.ts:2040](../../../packages/contracts/src/orchestrationV2.ts)) through
  `ProjectionStoreV2`, not from a separate counter.
- **Per-turn digest.** Between turns a thread gets one digest of what changed for it: child
  runs that ended, pending questions, watched pull requests, host pressure. It is computed from
  orchestration-v2 events committed since the last delivered digest and delivered through the
  notification mailbox ([NotificationMailbox.ts](../../../apps/server/src/orchestration-v2/NotificationMailbox.ts));
  Codex resends it only when it changed. The digest logic lives in a GOAT-owned module and the
  orchestrator gets a thin hook.
- **Measurement** is `context-budget.ts` alone; `inventory.ts` stays the audit's source.

## Compatibility

- Every legacy and canonical name stays callable in `tools/call` after it leaves the listing
  (D20, [ToolDispatch.ts:74](../../../apps/server/src/mcp/ToolDispatch.ts)); a legacy name keeps
  `_meta["goat/deprecated"]`.
- `goat_call` accepts paths, listed names, canonical names, and legacy names.
- Remote hosts: an origin on the core listing reaching an older host goes through `goat_call`
  with remote name translation (#942). `goat_describe { host }` reports `coverage.hostOlder` when
  the remote's registry predates the origin's.
- Agents and skills that name tools directly (AGENTS.md, codexclaw skills, scheduled task
  prompts) keep working because names stay callable. Text that tells agents to call a tool
  directly moves to the `goat_call` form in the flip PR.
- The flip ships with a per-provider-instance setting `toolListing: "core" | "full"`, default
  `core`, for a harness that regresses. It is removed when D8 and a week on `dev` show no
  regression.

## Done and in flight

Lane `mcp:89b93e22…` on the MacBook Pro (branch `feat/agent-surface-core`) built the base this
program stands on. Merged this session: #929, #895, #897 (human steps); #927, #920, #925
(operations); #935, #938 (CLI); #940 (`8f48cd669`) and #941 (`368b2c84a`), canonical listed
names with legacy names callable; #913, #914, #917, #918, #908. It still owns #939
(idempotency) and #942 (remote name translation, closes #781). The supervisor resumes it after
the restart; its eval work stays behind D8.

## PR sequence and file ownership

At most two lanes edit one package at a time. A lane merges its own PRs under
[merging.md](../../../docs/operations/merging.md); the program manager orders them and says
when to merge `dev` in.

| Order | PR                                                                                                                                                                                                                                                                                                  | Lane (host)                                       | Owns                                                                                                                                                                                                                                                               |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | This roadmap                                                                                                                                                                                                                                                                                        | program manager (mac-studio)                      | `devlog/_plan/261023_context_diet/`                                                                                                                                                                                                                                |
| 0     | One measurement: `context-budget.ts` from `feat/context-budget-measure` (`4b1c3924b`); the tool-surface lane folds its script into it                                                                                                                                                               | program manager opens it; verifier wrote it       | `scripts/agent-surface/context-budget.ts`                                                                                                                                                                                                                          |
| 1     | #939 idempotency, then #942 remote names                                                                                                                                                                                                                                                            | agent-surface core (MacBook Pro, `mcp:89b93e22…`) | as in those PRs, including `registry.ts` and the new `launchEntries.ts`                                                                                                                                                                                            |
| 1     | check:changed runs provider replays on prompt changes (#901)                                                                                                                                                                                                                                        | injection (lidge-ts, `mcp:981767d2…`)             | `scripts/check-changed.ts`, `scripts/lib/changed-tests.ts`                                                                                                                                                                                                         |
| 2     | Registry split by resource, mechanical: one `packages/contracts/src/agentSurface/entries/<resource>.ts` per resource, `registry.ts` assembles them, no text change, parity test unchanged. After #939 merges; if #939 is not moving when the split is ready, the split lands first and #939 rebases | tool surface (mac-studio, `mcp:34ea0e63…`)        | `registry.ts`, `entries/*` until step 5                                                                                                                                                                                                                            |
| 3     | Description budget fields (`description` ≤ 400 plus `guide`) and a ratchet test                                                                                                                                                                                                                     | tool surface                                      | `packages/contracts/src/agentSurface/{types,entry,resolve}.ts`                                                                                                                                                                                                     |
| 3     | Instruction block under budget; per-message extras cut                                                                                                                                                                                                                                              | injection                                         | `packages/provider-core/src/server/{orchestrationInstructions,developmentInstructions}.ts`, `apps/server/src/provider/CodexDeveloperInstructions.ts`, replay fixtures, `CursorAdapterV2.testkit.ts`, `OpenCode2AdapterV2.testkit.ts`; rebases around #944 and #945 |
| 4     | `goat_describe` search contract (detail levels, exact first, coverage)                                                                                                                                                                                                                              | tool surface                                      | `apps/server/src/mcp/toolkits/agentSurface/*`                                                                                                                                                                                                                      |
| 5     | Domain rewrites A: thread/run, task, goal, schedule, channel, queue, project, worktree, origin, decision                                                                                                                                                                                            | domain A (clisu-oracle)                           | those `entries/*.ts`                                                                                                                                                                                                                                               |
| 5     | Domain rewrites B: ssh, host, host_link, connection, provider, cloud_*, memory, preview, device, hub, pull_request, the rest                                                                                                                                                                        | domain B (mac-studio)                             | those `entries/*.ts`, `providerEntries.ts`                                                                                                                                                                                                                         |
| 5     | Compact notices, one delivery per run end                                                                                                                                                                                                                                                           | injection                                         | `apps/server/src/mcp/launchWatch.ts`, `apps/server/src/remoteReports/*`, pressure text in `apps/server/src/fleet/pressure/pressureModel.ts`                                                                                                                        |
| 6     | Core listing mode: `listing` field, `list_changed`, per-instance setting (default stays `full` until 8)                                                                                                                                                                                             | tool surface                                      | listing in `apps/server/src/mcp/McpHttpServer.ts` (`withListedNames`, :1139), `ToolDispatch.ts`                                                                                                                                                                    |
| 6     | Harness adapters: Pi drops `directTools`; Claude, OpenCode, Cursor, ACP and Pi tests assert the core listing; Codex code mode unchanged                                                                                                                                                             | harness (clisu-oracle)                            | `packages/provider-pi/src/server/mcpExtensionSource.ts`, adapter tests outside the injection lane's fixtures                                                                                                                                                       |
| 7     | Between-turn digest from orchestration-v2                                                                                                                                                                                                                                                           | injection                                         | new `apps/server/src/orchestration-v2/TurnDigest.ts`, thin hooks in `Orchestrator.ts` and `RunExecutionService.ts`; no other program lane edits those two files                                                                                                    |
| 7     | D8 run on the #800 task set, core vs full arms, Codex and Claude; records numbers, tunes the core set                                                                                                                                                                                               | D8 (mac-studio, signed-in providers)              | `scripts/agent-surface/eval/*`, `docs/operations/agent-surface-eval.md`                                                                                                                                                                                            |
| 8     | Listing flip: default `core` for every harness, `goat_call` form in instruction text, budgets as `context-budget.ts` thresholds, docs                                                                                                                                                               | flip (mac-studio, after 2–7)                      | the default value, `docs/internals/agent-surface.md` rollout and decisions, user docs                                                                                                                                                                              |

Packages with two lanes at once: `packages/contracts` (domain A and B in step 5, after the split;
the tool-surface lane stays out of `entries/*` then) and `apps/server/src/mcp` (tool surface and
injection in steps 4–6, on disjoint files).

## Lane rules

Every lane brief carries the standing rules: repo goat-si/goat, base `dev`, small PRs, squash
merge with `gh pr merge <n> --admin --squash --match-head-commit <head>` once `goat-ci-result` is
SUCCESS on that head; prior-art research with Aside through the MacBook Pro, or web search when
it is unreachable, cited; AGENTS.md development discipline, the testing policy, and the
code-budget ratchet; `goat_host_status { placement: {} }` before heavy work; issues filed for
out-of-scope findings; reports to the program manager with `goat_origin_report`, in Korean at
the end, with PRs, merge SHAs, measurements, and a NOT RUN list. The verifier on clisu-oracle
measures each merged step; its findings block until answered.

## Done when

The flip is on `dev` for every harness; `context-budget.ts` measures ≤ 12 KB always-injected per
harness and fails above it; D8 numbers are recorded in `docs/internals/agent-surface.md`; and
every row above is merged or filed as an issue.
