# Agent surface token diet and cleanup: roadmap

> **요약 (Korean summary)**
> GOAT가 실행하는 에이전트는 이미 core 목록(`goat_describe`, `goat_call`, 약 2.2 KB)을 받는다. 남은 큰 비용은 GOAT 밖에서 붙는 MCP 클라이언트가 헤더 없이 받는 전체 목록(약 210 KB, 약 52k 토큰)이다.
> 설계(D22, #1066)는 바깥 클라이언트가 `x-goat-tool-listing: core`로 core를 고르게 했지만, GOAT가 주는 연결 안내의 설정 예시에는 그 헤더가 없다.
> 이번 단위는 연결 안내의 모든 헤더 지원 클라이언트 예시에 헤더를 넣고(행동 변화 없음: 모든 도구는 이름과 `goat_call`로 계속 호출 가능), 낡은 agent-surface 문서와 감사 생성기를 고치고, `devlog/_fin`을 만들어 끝난 계획 단위를 옮긴다.
> computer use 상시 지침(약 8.7 KB)은 "턴이 놓치면 안 되는 규칙"으로 설계된 것이라 이번에 줄이지 않는다.

Branch `codex/agent-surface-token-diet` from dev `61343d617e`. One PR to `dev`, squash-merged
after `goat-ci-result` passes on its head.

**Status: done in [#1799](https://github.com/goat-si/goat/pull/1799).** The unit moved to
`devlog/_fin` in that pull request.

## Baseline (dev `61343d617e`, 2026-10-27)

From `node scripts/agent-surface/context-budget.ts` and `--listing full`:

| What                                                                       | Bytes (model-facing) |
| -------------------------------------------------------------------------- | -------------------: |
| Core listing (thread agents by default; outside client with the header)    |                2,226 |
| Full listing (outside client without the header, `agentToolListing: full`) |              210,728 |
| Instructions per harness                                                   |       4,166 to 5,434 |

## Research

Four read-only sol lanes (R1 budget, R2 provider practice through Aside, R3 docs, R4 devlog) and
one Aside verification lane. Findings that decide the scope:

- Thread agents already get the core listing (D21). Claude Code turns tool search on
  (`ClaudeAdapterV2.ts`), Codex defers MCP tools when `tool_search` exists, Pi defers optional
  tools only when its search exists. Another blanket deferral flag saves nothing for them.
- Outside clients keep the full listing unless they send the header (D22). The connection guide
  ([goat-mcp SKILL.md](../../../skills/goat-mcp/SKILL.md), bundled as `goat mcp skill`) and
  [outside-agents.md](../../../docs/user/outside-agents.md) never show it.
- Header syntax per client, read through Aside on 2026-10-27:
  [Claude Code](https://code.claude.com/docs/en/mcp) `--header` and `headers`;
  [Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) `http_headers` in
  `config.toml` (`codex mcp add --url` has no header flag);
  [Cursor](https://cursor.com/docs/mcp) and
  [VS Code](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) `headers`;
  [OpenCode](https://opencode.ai/docs/mcp-servers/) `headers`;
  [mcp-remote](https://github.com/punkpeye/mcp-remote) `--header`.
- The computer use always-on sections are deliberately resident
  ([computerUseSkillFiles.ts](../../../packages/provider-core/src/server/builtinSkills/computerUseSkillFiles.ts));
  moving them behind a file risks an agent acting before it reads the safety rules. Rejected.
- Rejected: making core the no-header default for outside clients (breaks older origins reading
  `tools/list`, D22); trimming the largest full-listing descriptions (changes what direct callers
  read).

## Work phases

| #   | Doc                                      | Outcome                                            | Depends on |
| --- | ---------------------------------------- | -------------------------------------------------- | ---------- |
| wp0 | this file                                | Roadmap and diff-level phase docs                  |            |
| wp1 | [010](./010_wp1_outside_core_listing.md) | Connection guide sends the core header             | wp0        |
| wp2 | [020](./020_wp2_stale_docs.md)           | Stale agent-surface docs and audit generator fixed | wp0        |
| wp3 | [030](./030_wp3_devlog_fin.md)           | `devlog/_fin` holds finished units                 | wp0        |
| wp4 | [040](./040_wp4_pr_merge.md)             | PR green and squash-merged                         | wp1-wp3    |

Out of scope: new tools, `goat_eval`, UI, access or permission changes, live `~/.goat` data.
