# 031 — wp3 stale check against a67b3f9c3 (rebased onto origin/dev c355a3b8c)

wp3 consumes [030_wp3_host_tools_waits.md](030_wp3_host_tools_waits.md) with errata E1–E7 and the 000 dispositions. Changes since 030 was written (base `070941cae`):

- **wp1/wp2 landed.** Pending tool handlers already gained reason/provenance/resolved reads (`apps/server/src/mcp/toolkits/thread/handlers.ts`, `tools.ts`); `McpToolAccess.writesThreads` has `refusalSuffix`; `threadAccess.readQuestion`-style helpers moved. 030 §2/§3 extract _these current_ handlers into `PendingQuestionsMcpService` — re-anchor by symbol and keep every wp1 behaviour (reason, respondedBy stamping, typed already-answered mapping, refusal suffix).
- **Upstream (09b3aac83):** `HostThreadsMcpService.readOnHost(scope, {host, tool, arguments}, decode)` exists (`HostThreadsMcpService.ts:144,391`). Remote list/read reuse it; remote respond needs a write call — add the smallest sibling (`writeOnHost`, `writes: true`) in the same service rather than a copy of `onHost`.
- **Upstream (ed96cfee2):** strict top-level arguments. Every new argument (`host`, `scope`, `hosts`, `launcherThreadId`, `launcherEnvironmentId`, `launcher` on `goat_thread_launch`, transported `respondedBy` on respond) must be declared on the tool schema. SSH launch retries once without `launcher` only on the remote's pre-handler refusal "goat_thread_launch does not take launcher, so nothing ran" (resolves 030 open question 5).
- **Upstream brand (e0596e725):** instruction text says "GOAT" instead of "T3"; `orchestrationInstructions.test.ts` changed. Add the wp3 sentences in the new wording and update its test.
- `ThreadManagementService.ts` (+56/−29) and `OrchestratorMcpService.ts` moved (wp1 + upstream); wait hunks (030 §5–§6, E6) re-anchor by `waitForThread` / `waitForTask` / `readTask`.
- wp2 is the in-environment delivery path; the escalation message already names `goat_pending_request_respond`. wp3's `scope:"launched"` list complements it (and is the only discovery path for remote launches until #5).

Consultation record: decisions from the wp0 consultation (`q13-wp0-architect-proposal`, `-reflection`, `q13-wp0-audit-r1b`); none added here.

## wp3 execution packet

- Builder: one `delegate_task` implementation child on `codex/gpt-6.1-sol`, sole writer.
- Verifiers: `$B/vp test run` on PendingQuestionsMcpService.test.ts (new), HostThreadsMcpService.test.ts, ThreadManagementService.test.ts, OrchestratorMcpService.test.ts, OrchestratorMcpToolkit.integration.test.ts, toolkits/core.test.ts, toolkits/project/handlers.test.ts, SshRemoteDispatch.test.ts, orchestrationInstructions.test.ts, contracts orchestratorMcp tests if present; `$B/vp lint` with no new warnings; tsc in contracts, provider-core, apps/server (+ client-runtime/web if contracts reach them).
- Review: Anthropic-family reviewer on the wp3 diff.
