# ADR-0007 — decision recorded under "Tool names"

- Contract owner: [mcp-toolkits.md](../mcp-toolkits.md#tool-names)
- Commit: `e893682a4a8dde93d2e802477f372a46105804d5` (2026-10-11)

## Decision record

- 목적과 의도: Name the agent-facing tools `goat_*` and the MCP server `GOAT`.
- 기존 구현 및 제약 조건: The message says agents saw `t3_thread_list`, `t3_ssh_thread_launch`, and the rest, from a server named "T3 Code".
- 검토한 주요 대안: The message does not record a rejected naming scheme beyond the `t3_*` names it replaced. It keeps the provider registration key as `t3-code`.
- 선택한 방식: The 42 `t3_*` tools became `goat_*`. The HTTP MCP server identifies as GOAT. History recorded before the rename still renders: presentation maps old `t3_*` names onto the new tools for display and identity recovery, not for registration or permissions. A GOAT client that calls an older remote exposing only `t3_*` fails with the tool and host named.
- 다른 대안 대신 이 방식을 선택한 이유: The message frames the change as the server's own name. It does not argue a second prefix.
- 장점, 단점 및 영향: `layerMcpTransport` in `apps/server/src/mcp/McpHttpServer.ts` uses `name: "GOAT"`. `goat_thread_send` is registered from `apps/server/src/mcp/toolkits/orchestrator/tools.ts`. Tools that were never in that `t3_*` set keep other names (`delegate_task`, `schedule_task`, `channel_*`, `preview_*`).
