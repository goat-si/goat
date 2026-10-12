# ADR-0003 — decision recorded under "Services"

- Contract owner: [server.md](../server.md#services)
- Commit: `094fb230e90ffb0af303a318ca716fecefd66c80` (2026-10-01)

## Decision record

- 목적과 의도: Write down the rule the subject states: "docs: server features are services, and handlers stay thin (#14613)".
- 기존 구현 및 제약 조건: The commit adds `docs/internals/effect-services.md` and updates `AGENTS.md`. It does not introduce the first `Context.Service` in the server.
- 검토한 주요 대안: The commit message does not record a rejected alternative.
- 선택한 방식: A WebSocket handler, HTTP route, or MCP tool decodes input, calls one service method, and maps errors. The service owns the behavior.
- 다른 대안 대신 이 방식을 선택한 이유: The message does not expand on the choice. The current tree still follows it: `LaunchWatchService`, `ScheduledTaskService`, and `ThreadManagementService` are services, and `apps/server/src/ws.ts` delegates to them.
- 장점, 단점 및 영향: The same service method is what MCP tools and scheduled tasks call. A behavior that exists only inside a transport handler is not reachable from those callers.
