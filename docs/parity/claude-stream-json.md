# Claude Code stream-json control protocol — Part 2 research

Scope: source-based protocol notes for a Rust Part 2 host, comparing the pinned GOAT v1 adapter, Python SDK v0.2.189 at 6c1b03f, and the installed TypeScript SDK 0.3.276 declarations. The SDK versions are independent snapshots; declarations, Python behavior, and observed GOAT use are not interchangeable. No live Claude CLI or paid model was run, and provider replay transcripts are not assumed to be raw stdin/stdout captures.

Pinned GOAT v1: `916b5ccc1b2b6d4ecd991ab1573172bab8fb1cc4` (read-only export `/tmp/goat-v1-916b5cc`).

## Rules

**R1.** Python launches the configured executable with `--output-format stream-json --verbose`; stream input adds `--input-format stream-json`.

OBSERVED — SDK-declared/implemented (Python 6c1b03f). `claude-agent-sdk-python/src/claude_agent_sdk/_internal/transport/subprocess_cli.py:520-523`; `claude-agent-sdk-python/src/claude_agent_sdk/_internal/transport/subprocess_cli.py:738-742`.

**R2.** Python uses `--system-prompt` for a custom prompt (empty if unspecified), `--system-prompt-file` for a file prompt, optional preset append, tools/allowed/disallowed lists, max turns and budgets, `--model` and `--fallback-model`.

OBSERVED — SDK-declared/implemented (Python 6c1b03f). `claude-agent-sdk-python/src/claude_agent_sdk/_internal/transport/subprocess_cli.py:525-575`.

**R3.** Permission callback configuration routes prompts through `--permission-prompt-tool stdio`; explicit prompt tool and callback are mutually exclusive. Permission mode goes through `--permission-mode`.

OBSERVED — SDK-declared/implemented (Python 6c1b03f). `claude-agent-sdk-python/src/claude_agent_sdk/types.py:2383-2406`; `claude-agent-sdk-python/src/claude_agent_sdk/_internal/transport/subprocess_cli.py:580-586`.

**R4.** Continue is `--continue`; resume, session ID and resume-at use equals-form arguments; `--fork-session` forks. Binding values with equals is deliberate protection against treating a dash-leading resume value as another flag.

OBSERVED — SDK-declared/implemented (Python 6c1b03f). `claude-agent-sdk-python/src/claude_agent_sdk/_internal/transport/subprocess_cli.py:588-604`; `claude-agent-sdk-python/src/claude_agent_sdk/_internal/transport/subprocess_cli.py:652-661`.

**R5.** MCP config is either a path/string or JSON `{mcpServers: ...}` with SDK server `instance` removed; partial events use `--include-partial-messages` and sources use `--setting-sources=...`.

OBSERVED — SDK-declared/implemented (Python 6c1b03f). `claude-agent-sdk-python/src/claude_agent_sdk/_internal/transport/subprocess_cli.py:618-644`; `claude-agent-sdk-python/src/claude_agent_sdk/_internal/transport/subprocess_cli.py:675-679`.

**R6.** Python initially copies the environment without `CLAUDECODE`, defaults `CLAUDE_CODE_ENTRYPOINT=sdk-py`, then merges supplied env, which can reintroduce `CLAUDECODE`, and sets SDK version. It subsequently removes or derives the client-app variable and may replace inherited trace context; it sets PWD to cwd and optionally enables SDK file checkpointing.

OBSERVED — SDK-declared/implemented (Python 6c1b03f). `claude-agent-sdk-python/src/claude_agent_sdk/_internal/transport/subprocess_cli.py:757-804`; `claude-agent-sdk-python/src/claude_agent_sdk/_internal/transport/subprocess_cli.py:808-823`.

**R7.** A string prompt is sent as a user frame with `message.role=user`, content, `parent_tool_use_id:null`, and `session_id`; client defaults the latter to `default`, but the TS input type does not require that field (`@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5929`).

OBSERVED — SDK-declared/implemented (Python 6c1b03f). `claude-agent-sdk-python/src/claude_agent_sdk/client.py:273-303`; `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5865-5877`.

**R8.** GOAT constructs a root user message and a UUID-bearing empty content message for a resume turn; the exact message sent depends on its turn path.

OBSERVED — v1-observed. `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:9355-9379`; `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:9592-9606`; `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:9730-9734`.

**R9.** Control requests are NDJSON objects `{type:"control_request",request_id,request:{subtype,...}}`; responses nest success or error under `response`, echo the request ID, and may contain subtype-specific `response` or an error string.

OBSERVED — SDK-declared/implemented (Python 6c1b03f). `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:734-759`; `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:781-788`; `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:314-346`; `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4682-4693`.

**R10.** Python generates IDs `req_<counter>_<8 lowercase hex digits>` and correlates out-of-order responses by ID. This is its implementation choice, not a required universal format: TS only requires uniqueness among in-flight IDs.

OBSERVED — SDK-declared/implemented (Python 6c1b03f). `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:451-463`; `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:773-780`; `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:791-802`; `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4682-4693`.

**R11.** Python waits 60 seconds by default, including default initialize; on timeout it removes pending state and raises `Control request timeout: <subtype>`. This is not evidence of the TS SDK timeout.

OBSERVED — SDK-declared/implemented (Python 6c1b03f). `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:198-198`; `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:393-394`; `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:761-806`.

**R12.** GOAT wraps TS SDK initialization in a five-minute deadline and dynamic MCP registration in 90 seconds when MCP servers are supplied.

OBSERVED — v1-observed. `apps/server/src/orchestration-v2/Adapters/ClaudeAgentSdkQueryRunner.ts:75-76`; `apps/server/src/orchestration-v2/Adapters/ClaudeAgentSdkQueryRunner.ts:586-617`.

**R13.** Either side can cancel its own pending control request by `control_cancel_request` with request_id, with no reply to the cancellation; Python cancels its inbound handler and emits no response when cancellation takes effect.

OBSERVED — SDK-declared/implemented (Python 6c1b03f). `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:474-480`; `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:745-748`; `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3668-3677`.

**R14.** CLI-originated Python requests run in separate tasks; successful callbacks return success, exceptions return error with their string. A cancelled callback is not reported as success.

OBSERVED — SDK-declared/implemented (Python 6c1b03f). `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:431-434`; `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:466-480`; `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:731-759`.

**R15.** Host-to-CLI initialize can carry hooks, sdkMcpServers, per-server config and cached manifests, jsonSchema, agents, prompt configuration, skills and optional capability declarations. Its success supplies commands, agents, output styles, models and account; optional fields are version dependent.

OBSERVED — SDK-declared (TypeScript 0.3.276). `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4216-4226`; `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4232-4244`; `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4245-4247`; `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4265-4285`; `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4295-4310`.

**R16.** Python initialize assigns hook_N callback IDs, sends matcher, hookCallbackIds, optional timeout and onFailure; it can also send agents, dynamic-section exclusion, prompt snapshot, skills and forwarding.

OBSERVED — SDK-declared/implemented (Python 6c1b03f). `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:348-390`.

**R17.** When a hook with on-failure blocking is requested (the check sits inside `if blocks_on_failure`), Python fails initialization if the response does not affirm support, or reports hooks_applied false: an uninstalled guard must not appear active.

OBSERVED — SDK-declared/implemented (Python 6c1b03f). `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:392-413`.

**R18.** A CLI-to-host can_use_tool request requires tool_name, input and tool_use_id; permission_suggestions, blocked_path, and agent, decision and display fields are optional. The wire spelling is tool_use_id; SDK callback-facing names can differ.

OBSERVED — SDK-declared (TypeScript 0.3.276). `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4485-4523`; `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4524-4528`.

**R19.** An allow response includes behavior=allow and updatedInput, defaulting to the original input in Python, and optionally updatedPermissions; denial includes behavior=deny, message and optionally interrupt.

OBSERVED — SDK-declared/implemented (Python 6c1b03f). `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:640-689`.

**R20.** Missing Python permission callback produces `canUseTool callback is not provided`; invalid callback result type and callback exceptions are returned as error control responses.

OBSERVED — SDK-declared/implemented (Python 6c1b03f). `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:640-645`; `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:690-693`; `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:749-759`.

**R21.** CLI-to-host hook_callback identifies callback_id and supplies input and tool_use_id; missing callbacks error `No hook callback found for ID: ...`. Python converts hook result field names before replying.

OBSERVED — SDK-declared/implemented (Python 6c1b03f). `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:695-709`.

**R22.** mcp_message is bidirectional and contains server_name and JSON-RPC message; a host response wraps the reply as mcp_response. Python acknowledges a JSON-RPC notification with an empty JSON-RPC result inside the control success.

OBSERVED — SDK-declared/implemented (Python 6c1b03f). `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:711-729`; `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4439-4448`.

**R23.** Python rejects unrecognized inbound subtypes with `Unsupported control request subtype: ...`; TS additionally declares elicitation and user dialogs, so copying that dispatcher alone cannot implement all TS features.

OBSERVED — SDK-declared/implemented (Python 6c1b03f). `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:711-732`; `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3682-3702`; `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4717-4728`.

**R24.** Host-to-CLI interrupt accepts optional cancel_queued on capable newer CLIs; receipt fields can distinguish queued survivors from cancellations. Capability negotiation matters because older CLIs can ignore the field.

OBSERVED — SDK-declared (TypeScript 0.3.276). `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4338-4353`; `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5620-5620`.

**R25.** On the active-turn path, GOAT checks that a query exists and the requested provider turn is active before calling SDK interrupt; it marks the turn interrupted and waits for closure up to a timeout, which does not confirm interruption. With no active turn and a requested runtime restart, a separate cleanup path may return without those checks or SDK interrupt.

OBSERVED — v1-observed. `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:9755-9760`; `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:9760-9815`.

**R26.** Host-to-CLI set_model accepts model or null/default; set_permission_mode has mode; set_max_thinking_tokens has max_thinking_tokens and optional thinking_display. TS declares these as controls rather than new conversation messages.

OBSERVED — SDK-declared (TypeScript 0.3.276). `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4769-4805`.

**R27.** Host-to-CLI rewind_files names user_message_id and optional dry_run; Python requires checkpointing for file rewind. Rewind is a filesystem operation, not an implied transcript truncation.

OBSERVED — SDK-declared/implemented (Python 6c1b03f). `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:869-882`; `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4741-4748`.

**R28.** Host-to-CLI mcp_status has no arguments; mcp_reconnect and mcp_toggle use serverName, toggle adds enabled; mcp_set_servers replaces the dynamic set.

OBSERVED — SDK-declared/implemented (Python 6c1b03f). `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:839-841`; `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:884-909`; `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4450-4483`.

**R29.** Host-to-CLI stop_task names task_id; background_tasks can optionally target tool_use_id. GOAT exposes both through its running query wrapper.

OBSERVED — SDK-declared (TypeScript 0.3.276). `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3650-3657`; `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4800-4806`; `apps/server/src/orchestration-v2/Adapters/ClaudeAgentSdkQueryRunner.ts:803-831`.

**R30.** The SDK message union includes assistant, user, result, system and partial assistant (`stream_event`) plus many advisory frame types. `keep_alive` has no payload, may be sent by either side, and is ignored.

OBSERVED — SDK-declared (TypeScript 0.3.276). `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4950-4954`; `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5019-5019`; `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5164-5169`.

**R31.** SDK-declared: System/init includes version, cwd, tools, MCP server names/status, model, permissionMode, commands and skills; capabilities are an open set. INFERRED Rust requirement: unknown values should not be treated as errors.

OBSERVED — SDK-declared (TypeScript 0.3.276). `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5567-5599`; `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5620-5620`.

**R32.** Task start includes task_id, optional tool_use_id, description, task_type, background and nesting metadata. Progress contains description and usage; notification has status completed/failed/stopped, output_file and summary.

OBSERVED — SDK-declared (TypeScript 0.3.276). `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5634-5650`; `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5664-5678`; `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5689-5707`.

**R33.** task_updated carries a patch to merge, including status pending/running/completed/failed/killed/paused, error and is_backgrounded; killed is not spelled stopped in this patch.

OBSERVED — SDK-declared (TypeScript 0.3.276). `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5725-5741`.

**R34.** Hook started, progress and response system frames carry hook_id/name/event, uuid and session_id; progress and response include output/stdout/stderr, response adds outcome and optional exit_code.

OBSERVED — SDK-declared (TypeScript 0.3.276). `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4888-4923`.

**R35.** Python consumes transcript_mirror as a top-level frame carrying filePath and entries, enqueues it only when a mirror batcher is installed, and flushes before exposing a result. This is distinct from a system subtype.

OBSERVED — SDK-declared/implemented (Python 6c1b03f). `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:482-489`; `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:508-514`.

**R36.** Python result does not necessarily mean all background work is over: it tracks system task lifecycle. Do not infer TS or GOAT termination solely from this Python detail.

OBSERVED — SDK-declared/implemented (Python 6c1b03f). `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:491-499`; `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:925-929`; `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:968-975`.

**R37.** GOAT includes partial messages, configures permissions, MCP and callbacks, and invokes the TS query with an asynchronous prompt queue.

OBSERVED — v1-observed. `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:675-680`; `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:8975-9022`; `apps/server/src/orchestration-v2/Adapters/ClaudeAgentSdkQueryRunner.ts:472-473`; `apps/server/src/orchestration-v2/Adapters/ClaudeAgentSdkQueryRunner.ts:575-580`.

**R38.** GOAT active steering creates an extra UUID-bearing user message with priority next, registers its pending state before offering to the existing query, and expects a Claude echo as its acceptance evidence.

OBSERVED — v1-observed. `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:9899-9923`; `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:9948-9961`; `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:10023-10038`; `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:10053-10061`.

**R39.** At the adapter boundary, steer errors when there is no live query, the active turn is wrong, or the turn ends before the message is offered. The orchestration outcome depends on admission and error classification; this adapter observation alone does not establish a terminal refusal.

OBSERVED — v1-observed. `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:9907-9919`; `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:10046-10052`.

**R40.** GOAT selects resume based on existing native session state and passes nativeThreadId and resume into query options; it also handles a changed session_id from the CLI.

OBSERVED — v1-observed. `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:8959-8970`; `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:8975-8983`; `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:9163-9173`.

**R41.** The declarations include request_user_dialog and elicitation; a dialog kind must be declared during initialize or the CLI fails closed, and an undeclared dialog must not be answered as a user cancellation.

OBSERVED — SDK-declared (TypeScript 0.3.276). `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3678-3694`; `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4275-4283`; `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4717-4728`.

**R42.** INFERRED Rust requirement: A raw protocol replay must preserve frame boundaries and tolerate concurrent callback/response interleaving; no source shown promises a global serialization of completion across request IDs.

OBSERVED — SDK-declared/implemented (Python 6c1b03f). `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:431-434`; `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:445-480`; `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:773-802`.

## Requested subtype evidence

### initialize
SDK-declared (TS), OBSERVED: request and response fields are declared in `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4216-4226` and `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4295-4310`. Python implementation registers callbacks `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:348-390`.

### interrupt
SDK-declared (TS), OBSERVED: optional cancel_queued and receipt capabilities `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4338-4353`. v1-observed: active turn is checked `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:9779-9789`.

### can_use_tool
SDK-declared (TS), OBSERVED: permission request fields `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4485-4494`. Python implementation responds with allow/deny `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:640-689`.

### hook_callback
SDK implementation (Python), OBSERVED: callback lookup and response conversion `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:695-709`.

### mcp_message
SDK-declared (TS), OBSERVED: server and JSON-RPC message `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4439-4448`; Python handler `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:711-729`.

### set_model
SDK-declared (TS), OBSERVED: optional nullable model `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4779-4786`.

### set_permission_mode
SDK-declared (TS), OBSERVED: mode field `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4791-4798`.

### task_started
SDK-declared (TS), OBSERVED: task start metadata `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5689-5707`.

### task_updated and task_progress
SDK-declared (TS), OBSERVED: task update patch `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5725-5741` and progress fields `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5664-5678`.

### task_notification
SDK-declared (TS), OBSERVED: task status and summary `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5634-5650`.

### transcript_mirror
SDK implementation (Python), OBSERVED: top-level mirror batches and result flush `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:482-489`, `claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py:508-514`.

v1-observed: admission refusal fails closed with nothing sent; a Codex start onto a native turn GOAT did not own is steered into that turn and adopted when the start may steer, and otherwise, or when Codex refuses or does not confirm that steer, fails without resending (`apps/server/src/orchestration-v2/Adapters/CodexTurnStartGuard.ts:113-116`, `apps/server/src/orchestration-v2/Adapters/CodexTurnStartGuard.ts:150-189`). After admission, the same message id is re-dispatched as `queue_after_active` for delegated completions, notifications and tagged declines, or `start_immediately` for an ordinary steer that missed an ended turn (`apps/server/src/orchestration-v2/EffectWorker.ts:310-360`). Codex steer RPC errors are wrapped as `ProviderAdapterSteerRunError` (`apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:7315-7360`) and are not re-queued by that worker (`apps/server/src/orchestration-v2/ProviderTurnControlService.ts:558-570`, `apps/server/src/orchestration-v2/EffectWorker.ts:310-318`); final v1 outcome is pending replay `steer_rpc_error_codex`. Stop holds the queue, stops wait-mode children, and leaves async children running; there is no interrupt demotion (`goat2-design/prd-src/part1/runtime.md:67-69`).

## Capability flags

v1-observed, OBSERVED: GOAT v1 declares Claude `supportsInterrupt`, `supportsNativeResume`, and `supportsActiveSteering` true; `activeSteeringInterruptsTools` is false. Check the adjacent fields before assuming attachment or compaction behavior. `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:454-465`; contract: `packages/contracts/src/providerCapabilityParts.ts:108-118`.

SDK-declared (TypeScript 0.3.276), OBSERVED: the CLI's `system/init` protocol capability strings (including interrupt receipt/cancel behavior) are separate from GOAT provider capability flags. `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5618-5622`.

## TypeScript 0.3.276 control request inventory

SDK-declared (TypeScript 0.3.276), OBSERVED: the following index is extracted from the pinned SDK declarations. Direction is explicit in R14–R29 and R41; for remaining entries the declaration is a type inventory, not proof that GOAT invokes it or that every CLI version supports it. Payloads below show only top-level fields; refer to the declaration for nested schemas and response details. `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4682-4693`.

- `apply_flag_settings` — `settings: Record<string, unknown>`. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3644-3647`.
- `background_tasks` — `tool_use_id?: string`. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3652-3658`.
- `cancel_async_message` — `message_uuid: string`. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3663-3666`.
- `elicitation` — `mcp_server_name: string`; `message: string`; `mode?: 'form' | 'url'`; `url?: string`; `elicitation_id?: string`; `requested_schema?: Record<string, unknown>`; `title?: string`; `display_name?: string`; `description?: string`. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3682-3702`.
- `file_suggestions` — `query: string`. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3707-3710`.
- `get_binary_version` — no scalar top-level fields captured. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3715-3717`.
- `get_context_usage` — `detail?: 'summary' | 'full'`. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3722-3728`.
- `get_hooks_listing` — no scalar top-level fields captured. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3832-3834`.
- `get_session_cost` — no scalar top-level fields captured. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3981-3983`.
- `get_settings` — no scalar top-level fields captured. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3988-3990`.
- `get_usage` — `skip_behaviors?: boolean`. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3995-4001`.
- `initialize` — `hooks?: Partial<Record<coreTypes.HookEvent, SDKHookCallbackMatcher[]>>`; `sdkMcpServers?: string[]`; `jsonSchema?: Record<string, unknown>`; `systemPrompt?: string[]`; `appendSystemPrompt?: string`; `systemPromptSnapshot?: boolean`; `planModeInstructions?: string`; `toolAliases?: Record<string, string>`; `excludeDynamicSections?: boolean`; `agents?: Record<string, coreTypes.AgentDefinition>`; `title?: string`; `skills?: string[]`; `promptSuggestions?: boolean`; `agentProgressSummaries?: boolean`; `forwardSubagentText?: boolean`; `supportedDialogKinds?: string[]`; `perTaskStopAffordance?: boolean`; `plugins?: coreTypes.SdkPluginConfig[]`. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4219-4293`.
- `interrupt` — `cancel_queued?: boolean`. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4341-4348`.
- `list_models` — no scalar top-level fields captured. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4367-4369`.
- `list_permission_rules` — no scalar top-level fields captured. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4374-4376`.
- `mcp_call` — `tool: string`; `arguments?: Record<string, unknown>`; `expires_at?: string`; `timeout_ms?: number`. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4391-4436`.
- `mcp_message` — `server_name: string`; `message: JSONRPCMessage`. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4441-4448`.
- `mcp_reconnect` — `serverName: string`. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4453-4456`.
- `mcp_set_servers` — `servers: Record<string, coreTypes.McpServerConfigForProcessTransport>`. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4461-4467`.
- `mcp_status` — no scalar top-level fields captured. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4472-4474`.
- `mcp_toggle` — `serverName: string`; `enabled: boolean`. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4479-4483`.
- `can_use_tool` — `tool_name: string`; `mcp_server?: coreTypes.McpServerProvenance`; `input: Record<string, unknown>`; `permission_suggestions?: coreTypes.PermissionUpdate[]`; `blocked_path?: string`; `decision_reason?: string`; `decision_reason_type?: 'rule' | 'mode' | 'subcommandResults' | 'permissionPromptTool' | 'hook' | 'asyncAgent' | 'sandboxOverride' | 'workingDir' | 'safetyCheck' | 'classifier' | 'other'`; `classifier_approvable?: boolean`; `suppress_always_allow_rule?: boolean`; `default_to_no?: boolean`; `tool_use_id: string`; `title?: string`; `display_name?: string`; `agent_id?: string`; `description?: string`; `requires_user_interaction?: boolean`. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4488-4534`.
- `read_file` — `path: string`; `max_bytes?: number`; `encoding?: 'utf-8' | 'base64'`. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4559-4567`.
- `register_repo_root` — `directory: string`; `reload_claude_md?: boolean`; `reload_plugins?: boolean`; `reload_skills?: boolean`. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4585-4591`.
- `reload_output_styles` — no scalar top-level fields captured. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4596-4598`.
- `reload_plugins` — `hold_on_cache_impact?: boolean`. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4610-4616`.
- `reload_skills` — no scalar top-level fields captured. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4652-4654`.
- `rename_session` — `title: string`; `source?: 'remote' | 'host'`; `session_id?: string`. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4666-4677`.
- `request_user_dialog` — `dialog_kind: string`; `payload: Record<string, unknown>`; `tool_use_id?: string`. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4717-4728`.
- `rewind_files` — `user_message_id: string`; `dry_run?: boolean`. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4744-4748`.
- `seed_read_state` — `path: string`; `mtime: number`. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4753-4757`.
- `set_color` — `color: string`. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4762-4765`.
- `set_max_thinking_tokens` — `max_thinking_tokens?: number | null`; `thinking_display?: ('summarized' | 'omitted') | null`. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4770-4774`.
- `set_model` — `model?: string | null`. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4779-4786`.
- `set_permission_mode` — `mode: coreTypes.PermissionMode`. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4791-4798`.
- `stop_task` — `task_id: string`. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4803-4806`.
- `update_settings` — `source: 'localSettings'`; `settings: Record<string, unknown>`. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4811-4818`.
- `hook_callback` — `callback_id: string`; `input: coreTypes.HookInput`; `tool_use_id?: string`. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4879-4886`.

The scalar inventory intentionally omits nested object members, complex multiline types, and response schemas. The declaration union is the authority for membership; e.g. `hook_callback` is declared separately. A future Rust implementation must make an explicit supported/unsupported decision per subtype rather than silently succeed. INFERRED from `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4682-4693`.


### System and stream frame field index

OBSERVED: declaration fields below are an index, not a guarantee that every CLI emits each frame. Nested structures are abbreviated; consult the cited declaration for exact types.

- `SDKCompactBoundaryMessage`: OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3524-3558`.
  - `type` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3525`.
  - `subtype` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3526`.
  - `uuid` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3555`.
  - `session_id` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3556`.
- `SDKStatusMessage`: OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5552-5562`.
  - `type` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5553`.
  - `subtype` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5554`.
  - `status` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5555`.
  - `permissionMode?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5556`.
  - `compact_result?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5557`.
  - `compact_error?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5558`.
  - `uuid` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5560`.
  - `session_id` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5561`.
- `SDKSystemMessage`: OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5567-5632`.
  - `type` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5568`.
  - `subtype` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5569`.
  - `agents?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5570`.
  - `apiKeySource` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5574`.
  - `betas?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5576`.
  - `claude_code_version` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5577`.
  - `cwd` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5578`.
  - `tools` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5579`.
  - `model` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5588`.
  - `permissionMode` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5592`.
  - `slash_commands` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5593`.
  - `terminal_slash_commands?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5597`.
  - `output_style` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5598`.
  - `skills` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5599`.
  - `fast_mode_state?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5612`.
  - `fast_mode_disabled_reason?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5613`.
  - `effort?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5618`.
  - `capabilities?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5622`.
  - `uuid` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5630`.
  - `session_id` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5631`.
- `SDKTaskStartedMessage`: OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5689-5723`.
  - `type` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5690`.
  - `subtype` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5691`.
  - `task_id` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5692`.
  - `tool_use_id?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5693`.
  - `description` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5694`.
  - `subagent_type?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5698`.
  - `is_backgrounded?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5702`.
  - `spawn_depth?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5706`.
  - `task_type?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5707`.
  - `workflow_name?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5711`.
  - `prompt?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5712`.
  - `skip_transcript?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5716`.
  - `ambient?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5720`.
  - `uuid` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5721`.
  - `session_id` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5722`.
- `SDKTaskUpdatedMessage`: OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5725-5742`.
  - `type` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5726`.
  - `subtype` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5727`.
  - `task_id` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5728`.
  - `uuid` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5740`.
  - `session_id` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5741`.
- `SDKTaskProgressMessage`: OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5664-5687`.
  - `type` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5665`.
  - `subtype` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5666`.
  - `task_id` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5667`.
  - `tool_use_id?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5668`.
  - `description` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5669`.
  - `subagent_type?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5673`.
  - `last_tool_name?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5679`.
  - `summary?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5683`.
  - `uuid` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5685`.
  - `session_id` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5686`.
- `SDKTaskNotificationMessage`: OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5634-5662`.
  - `type` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5635`.
  - `subtype` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5636`.
  - `task_id` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5637`.
  - `tool_use_id?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5638`.
  - `status` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5639`.
  - `reason?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5643`.
  - `output_file` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5644`.
  - `summary` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5645`.
  - `resource_links?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5654`.
  - `skip_transcript?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5655`.
  - `ambient?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5659`.
  - `uuid` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5660`.
  - `session_id` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5661`.
- `SDKHookStartedMessage`: OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4916-4924`.
  - `type` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4917`.
  - `subtype` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4918`.
  - `hook_id` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4919`.
  - `hook_name` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4920`.
  - `hook_event` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4921`.
  - `uuid` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4922`.
  - `session_id` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4923`.
- `SDKHookProgressMessage`: OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4888-4899`.
  - `type` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4889`.
  - `subtype` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4890`.
  - `hook_id` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4891`.
  - `hook_name` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4892`.
  - `hook_event` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4893`.
  - `stdout` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4894`.
  - `stderr` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4895`.
  - `output` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4896`.
  - `uuid` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4897`.
  - `session_id` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4898`.
- `SDKHookResponseMessage`: OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4901-4914`.
  - `type` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4902`.
  - `subtype` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4903`.
  - `hook_id` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4904`.
  - `hook_name` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4905`.
  - `hook_event` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4906`.
  - `output` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4907`.
  - `stdout` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4908`.
  - `stderr` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4909`.
  - `exit_code?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4910`.
  - `outcome` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4911`.
  - `uuid` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4912`.
  - `session_id` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4913`.
- `SDKPartialAssistantMessage`: OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5164-5186`.
  - `type` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5165`.
  - `event` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5169`.
  - `parent_tool_use_id` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5170`.
  - `uuid` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5171`.
  - `session_id` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5172`.
  - `ttft_ms?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5173`.
  - `user_message_uuid?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5177`.
  - `user_message_uuids?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5181`.
  - `resume_reason?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5185`.
- `SDKAssistantMessage`: OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3399-3476`.
  - `type` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3400`.
  - `message` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3404`.
  - `parent_tool_use_id` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3405`.
  - `error?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3406`.
  - `uuid` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3407`.
  - `session_id` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3409`.
  - `request_id?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3410`.
  - `user_message_uuid?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3414`.
  - `user_message_uuids?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3418`.
  - `resume_reason?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3422`.
  - `resumed_from_incomplete_thinking?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3426`.
  - `supersedes?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3430`.
  - `aborted?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3434`.
  - `subagent_type?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3438`.
  - `task_description?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3442`.
  - `timestamp?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3448`.
  - `context_usage?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3453`.
  - `usage_report?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3457`.
- `SDKResultSuccess`: OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5412-5468`.
  - `type` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5413`.
  - `subtype` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5414`.
  - `duration_ms` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5415`.
  - `duration_api_ms` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5416`.
  - `ttft_ms?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5417`.
  - `ttft_stream_ms?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5418`.
  - `time_to_request_ms?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5419`.
  - `user_message_uuid?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5420`.
  - `user_message_uuids?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5421`.
  - `resume_reason?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5422`.
  - `local_command?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5423`.
  - `request_sent_wall_ms?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5424`.
  - `first_content_frame_ms?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5425`.
  - `first_stream_post_ms?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5426`.
  - `first_stream_post_ack_ms?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5427`.
  - `first_stream_post_wall_ms?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5428`.
  - `time_to_request_from_spawn_ms?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5429`.
  - `warm_spare_claimed?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5430`.
  - `time_origin_ms?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5431`.
  - `is_error` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5432`.
  - `api_error_status?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5433`.
  - `num_turns` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5435`.
  - `result` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5436`.
  - `stop_reason` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5437`.
  - `total_cost_usd` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5441`.
  - `usage` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5445`.
  - `modelUsage` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5449`.
  - `permission_denials` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5451`.
  - `queued_turn_count?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5455`.
  - `structured_output?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5456`.
  - `deferred_tool_use?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5457`.
  - `terminal_reason?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5458`.
  - `result_index?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5462`.
  - `fast_mode_state?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5463`.
  - `fast_mode_disabled_reason?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5464`.
  - `origin?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5465`.
  - `uuid` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5466`.
  - `session_id` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5467`.
- `SDKResultError`: OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5351-5405`.
  - `type` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5352`.
  - `subtype` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5353`.
  - `duration_ms` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5354`.
  - `duration_api_ms` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5355`.
  - `is_error` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5356`.
  - `num_turns` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5357`.
  - `stop_reason` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5358`.
  - `total_cost_usd` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5362`.
  - `usage` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5366`.
  - `modelUsage` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5370`.
  - `permission_denials` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5372`.
  - `queued_turn_count?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5376`.
  - `errors` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5377`.
  - `startup_failure_reason?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5382`.
  - `user_message_uuid?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5386`.
  - `user_message_uuids?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5390`.
  - `resume_reason?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5394`.
  - `terminal_reason?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5395`.
  - `result_index?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5399`.
  - `fast_mode_state?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5400`.
  - `fast_mode_disabled_reason?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5401`.
  - `origin?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5402`.
  - `uuid` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5403`.
  - `session_id` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5404`.
- `SDKUserMessage`: OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5865-5939`.
  - `type` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5866`.
  - `message` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5870`.
  - `parent_tool_use_id` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5871`.
  - `isSynthetic?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5872`.
  - `tool_use_result?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5876`.
  - `priority?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5877`.
  - `origin?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5878`.
  - `shouldQuery?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5908`.
  - `timestamp?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5912`.
  - `uuid?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5928`.
  - `session_id?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5929`.
  - `subagent_type?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5933`.
  - `task_description?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5937`.
- `SDKSessionStateChangedMessage`: OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5519-5525`.
  - `type` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5520`.
  - `subtype` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5521`.
  - `state` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5522`.
  - `uuid` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5523`.
  - `session_id` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5524`.
- `SDKAPIRetryMessage`: OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3377-3394`.
  - `type` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3378`.
  - `subtype` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3379`.
  - `attempt` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3380`.
  - `max_retries` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3381`.
  - `retry_delay_ms` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3382`.
  - `error_status` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3383`.
  - `error` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3384`.
  - `uuid` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3392`.
  - `session_id` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:3393`.
- `SDKToolProgressMessage`: OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5760-5779`.
  - `type` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5761`.
  - `tool_use_id` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5762`.
  - `tool_name` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5763`.
  - `parent_tool_use_id` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5764`.
  - `elapsed_time_seconds` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5765`.
  - `task_id?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5766`.
  - `uuid` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5767`.
  - `session_id` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5768`.
  - `heartbeat?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5769`.
  - `subagent_type?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5770`.
- `SDKMirrorErrorMessage`: OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5080-5091`.
  - `type` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5081`.
  - `subtype` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5082`.
  - `error` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5083`.
  - `uuid` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5089`.
  - `session_id` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:5090`.
- `SDKInformationalMessage`: OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4929-4947`.
  - `type` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4930`.
  - `subtype` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4931`.
  - `content` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4932`.
  - `level` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4936`.
  - `tool_use_id?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4940`.
  - `prevent_continuation?` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4944`.
  - `uuid` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4945`.
  - `session_id` — declared field. OBSERVED — SDK-declared (TypeScript 0.3.276) `@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts:4946`.

## Existing v1 tests and fixtures

v1-observed, OBSERVED: `ClaudeReplayFixtures.integration.test.ts` loads `fixtures/<name>/claude_transcript.ndjson`, decodes through the Claude replay harness and runs orchestrator scenarios; it also asserts native child thread messages are refused. `apps/server/src/orchestration-v2/testkit/ClaudeReplayFixtures.integration.test.ts:14-24`; `apps/server/src/orchestration-v2/testkit/ClaudeReplayFixtures.integration.test.ts:39-55`; `apps/server/src/orchestration-v2/testkit/ClaudeReplayFixtures.integration.test.ts:76-123`.

v1-observed, OBSERVED: the fixture directories include `message_steering`, `turn_interrupt`, `multi_turn_restart`, `claude_idle_resume`, `claude_background_task_interrupt`, `claude_nested_background_subagent_wake`, `claude_compact_after_resume_wake`, and `claude_result_is_error`; each cited path is a Claude replay transcript, not a Codex transcript. `apps/server/src/orchestration-v2/testkit/fixtures/message_steering/claude_transcript.ndjson:1`; `apps/server/src/orchestration-v2/testkit/fixtures/turn_interrupt/claude_transcript.ndjson:1`; `apps/server/src/orchestration-v2/testkit/fixtures/multi_turn_restart/claude_transcript.ndjson:1`; `apps/server/src/orchestration-v2/testkit/fixtures/claude_idle_resume/claude_transcript.ndjson:1`; `apps/server/src/orchestration-v2/testkit/fixtures/claude_background_task_interrupt/claude_transcript.ndjson:1`; `apps/server/src/orchestration-v2/testkit/fixtures/claude_nested_background_subagent_wake/claude_transcript.ndjson:1`; `apps/server/src/orchestration-v2/testkit/fixtures/claude_compact_after_resume_wake/claude_transcript.ndjson:1`; `apps/server/src/orchestration-v2/testkit/fixtures/claude_result_is_error/claude_transcript.ndjson:1`.

## GOAT 2 mapping

INFERRED: R1–R7 and R9–R23 describe transport machinery and need not each become a Part 1 log event. Map accepted user input to `input.accepted`, completed materialized output to `item.completed`, permission/human interactions to `request.opened`/`request.resolved`, and durable run outcomes to `run.finished`; do not log a control acknowledgement as completed model work.

INFERRED: R24–R29 and R35–R42 need explicit ownership between Rust process, per-thread actor and durable state. In particular persist enough native session/UUID and input state in `checkpoint` to reconcile interrupted/restarted sessions; a sent steer is not necessarily an applied steer, and an unknown outcome must remain unknown until evidence resolves it.

INFERRED: R30–R34 require distinguishing child/task lifecycle from a root `result`; represent native children with `child.started`/`child.reported` only where the actor's child model actually applies. Transient progress and keepalives need not become durable events. `transcript_mirror` is a separate optional session-store channel, not itself a Part 1 event.

OBSERVED: Part 1 plans 15 log events: 14 in `goat2/crates/goat2-contracts/src/log.rs:62-94` plus owner-approved `input.changed` (`goat2-design/prd-src/decisions.md:73`). A Part 2 CLI protocol driver is outside that event contract.

| v1 rule | v1 observable | Part 1 status (same / deliberate difference / deferred / pending) | GOAT 2 evidence (log event or command/MCP reply) | coverage (scenario name or source-only) |
|---|---|---|---|---|
| R8, R37–R40 | v1-observed SDK query, steering and resume | deferred | INFERRED Part 2 driver; `input.accepted`, `run.finished` for eventual durable boundaries | boot_and_resume; steer_and_interrupt |
| R12, R25, R29 | v1-observed deadlines and SDK control wrapper | deferred | INFERRED Part 2 CLI controls; no Part 1 transport reply established | permission_and_hook; mcp_and_timeout |
| R1–R7, R9–R11, R13–R24, R26–R28, R30–R36, R41–R42 | SDK-declared or Python implementation, not evidence of v1 use | deferred | INFERRED Part 2 driver; `request.opened`, `request.resolved`, `item.completed` where applicable | background_and_mirror; version_and_failure; source-only |

## Recorded-session test plan for Part 2

INFERRED Rust requirement: implement a fake executable that records argv, selected environment keys, cwd, stdin NDJSON and closure; emits scripted stdout NDJSON, stderr and exit codes; gates outputs on matching input; can split lines across writes; and never calls a model. A script should specify request-ID capture/substitution rather than assume Python's request-ID generator is the Rust generator.

1. **boot_and_resume**: verify stream format flags, settings sources, model and permission flags; exchange initialize and init frame; send user; emit assistant/result; relaunch with saved native session and verify resume binding. Base adapter-level outputs on `apps/server/src/orchestration-v2/testkit/fixtures/multi_turn_restart/claude_transcript.ndjson:1`; record a separate raw control exchange because v1 provider replay is not established as raw CLI wire data.
2. **permission_and_hook**: initialize callback IDs; issue can_use_tool and hook_callback, match success/deny/error by ID, verify updatedInput and updatedPermissions, cancel a still-pending callback and assert no stale settlement. Test both stdio permission setup and unsupported subtype explicitly.
3. **steer_and_interrupt**: hold a live turn, read a second UUID user frame, echo it, send partials and result; also interrupt before/after offer, with capability-dependent still_queued/cancelled responses. Compare adapter behavior with `apps/server/src/orchestration-v2/testkit/fixtures/message_steering/claude_transcript.ndjson:1` and `apps/server/src/orchestration-v2/testkit/fixtures/turn_interrupt/claude_transcript.ndjson:1`.
4. **mcp_and_timeout**: interleave SDK-hosted MCP JSON-RPC and control requests, include notification acknowledgement, reconnect/toggle/status, unknown ID, error, EOF and bounded timeout; validate no accidental retry of side effects. GOAT's initialization and registration deadlines are separate (R12).
5. **background_and_mirror**: issue task_started, task_updated, task_progress, result and task_notification in recorded order, include child parent_tool_use_id and top-level transcript_mirror; verify no premature child completion and mirror flush ordering only if a session store is enabled. Compare `apps/server/src/orchestration-v2/testkit/fixtures/claude_background_task_interrupt/claude_transcript.ndjson:1` and `apps/server/src/orchestration-v2/testkit/fixtures/claude_nested_background_subagent_wake/claude_transcript.ndjson:1`.
6. **version_and_failure**: simulate absent capabilities/optional fields, unknown advisory frames, control errors, malformed JSON, stderr, premature EOF, lost response and duplicate/late response; pin each supported CLI version with a sanitized real capture before calling it compatible. Include result-is-error and compact/resume fixture data.

Fixture references above are relative to the v1 repository root. These are proposed tests, not tests run in this research.

## Open questions

- Which exact Claude Code CLI versions and feature subset must Part 2 support? Type declarations document optional newer features, but do not prove the binary on a target host implements them.
- Is GOAT v1's installed TS SDK configured with a session store in any launch path? No transcript_mirror configuration was established in the inspected adapter paths; absence has not been exhaustively proven.
- Which v1 replay fixture entries preserve raw wire frames and stdin control exchanges, versus normalized SDK/provider events? Do not feed them directly to a fake CLI until their schema is audited.
- What exact Rust policy and deadline should apply to control requests other than the specific GOAT initialization/registration wrappers? Python's 60-second timeout is not proof of TS parity.
