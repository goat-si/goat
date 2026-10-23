# Agent surface

> **요약 (Korean summary)**
> GOAT의 에이전트 표면(MCP 도구 191개, `goat` CLI, 문서)을 작은 균일 문법 위로 다시 세우는 설계다.
> 레지스트리(`resource.verb` 경로, 패리티 테스트 포함)와 사람 핸드오프 레코드는 이미 배포되었다.
> 결과는 `ok | error | needs_human` 세 갈래로 유지하고, 끝나지 않은 작업은 반드시 `meta.operation` 핸들을 붙여 `operation.read/wait/cancel`로 다룬다.
> 오류 코드에 `resource_exhausted`, `failed_precondition`, `unknown_outcome`을 더하고, 재시도 가능 여부는 호출마다 계산한다. 도메인 사유는 변환 전에 보존한다.
> `clientRequestId`는 인자 다이제스트와 함께 원자적으로 예약하고, 결과가 기록되기 전에 끊긴 키는 `unknown_outcome`으로 남겨 자동 재실행을 막는다.
> `goat_call`은 직접 MCP 호출과 같은 단일 검사 경로를 쓰고, `goat_eval`은 측정으로 필요가 입증될 때까지 보류한다.
> 런타임 승인은 사람의 클라이언트 세션 또는 `orchestration:operate`와 `orchestration:approve`를 모두 가진 외부 MCP 클라이언트만, 그 밖의 사람 단계는 사람의 클라이언트 세션만 해결한다.
> 생성된 참조 문서는 저장소에 커밋하지 않고 실행 중인 서버가 제공한다. 결정 기록(D1–D20)과 선행 사례 비교를 끝에 둔다.

This page uses two labels. **Now** describes `dev` as of 2026-10-23 with source
paths. **Proposed** is design that does not exist yet. Unlabeled text in a Proposed
section is also proposal. The [rollout](#rollout) table is the one place that
tracks which parts have shipped.

## Why this exists

An agent working in GOAT meets three surfaces that grew separately: MCP tools, a
server CLI built for operators, and prose docs. They disagree in naming, result
shape, retry behavior, and coverage.

**Now.** `/mcp` mounts 191 tools: 179 `Tool.make` declarations and 12
`Tool.dynamic` ones, of which 123 are named `goat_*`. Every tool has a registry
entry, and a test fails when the assembled catalog and the registry disagree
([agentSurface.test.ts](../../apps/server/src/mcp/agentSurface.test.ts)). The
generated [audit](./agent-surface-audit.md) measures the rest: few mutating tools
accept `clientRequestId`, most input parameters have no description, and no CLI
command has a usage example. Failures come in more than ten unrelated shapes, and
a step that needs a person reaches the agent in nine different contracts (see
[Human steps](#human-steps)).

The goal is a surface where an agent can find, call, retry, and chain every
capability without reading source, where steps that need a person go to that
person and come back, and where reference documentation comes from the code that
runs.

## Design rules

1. **One registry.** Every capability has one entry. MCP names, CLI commands,
   help text, served reference docs, and `llms.txt` are derived from it.
2. **Small core.** Two meta tools (`goat_describe`, `goat_call`) and the
   operation verbs make every other capability reachable as data.
3. **Additive.** New names and envelopes are added beside the old ones. Old names
   keep working through a deprecation window.
4. **No new authority.** Meta tools, the CLI, and handoffs run the same checks a
   direct call runs. Nothing here lets an agent widen its own grant.
5. **People finish human steps.** OAuth codes, device codes, secrets, approvals,
   and second factors reach a person's session and never a thread credential.
6. **Every write says whether a retry is safe.** A write takes a deduplication
   key or is marked unsafe to retry, and the envelope never calls a write that
   may have applied retryable.
7. **One owner per human interaction.** Each kind of human step has one durable
   record that holds its state, expiry, and continuation. Other surfaces project it.

## Grammar

### Paths

**Now.** A capability is identified by `resource.verb`. The registry stores the
two parts as separate fields, because names such as
`goat_preview_recording_start` cannot be split reliably from the string
([registry.ts](../../packages/contracts/src/agentSurface/registry.ts)).

Verbs come from a small standard set when one fits:

| Verb                | Meaning                                                      | Effect class |
| ------------------- | ------------------------------------------------------------ | ------------ |
| `list`              | Page through resources                                       | read         |
| `read`              | One resource by id                                           | read         |
| `create`            | Make a resource                                              | write        |
| `update`            | Patch a resource                                             | write        |
| `delete`            | Remove a resource                                            | destructive  |
| `watch` / `unwatch` | Subscribe the calling thread to changes                      | write        |
| `wait`              | Block until a state is reached, with a timeout               | read         |
| `run`               | Trigger a resource that already exists (a schedule, a check) | write        |
| `cancel`            | Ask running work to stop; cooperative                        | write        |

A domain verb (`thread.send`, `preview.click`, `decision.answer`) is allowed when
no standard verb fits, and the registry records its effect class. `forget` stays
distinct from `cancel` and `delete`: it stops GOAT observing something and leaves
it running, as `cloud_agent.run_forget` does.

A verb on a sub-resource names the sub-resource first: `channel.task_read`,
`memory.settings_update`, `ssh.host_prepare`.

**Now.** 74 shipped names are not the projection of their path
([#781](https://github.com/goat-si/goat/issues/781)). They are still served and listed
under those names, and `/mcp` also accepts each one's canonical
`goat_<resource>_<verb>` name in `tools/call`, without listing it until the flip
([ToolDispatch.ts](../../apps/server/src/mcp/ToolDispatch.ts) `withServedToolNames`).
Their paths keep the resource and verb they shipped with, except three that used a
synonym (D11): `memory.settings_read`, `memory.source_read`, and `preview.wait`. The
meta tools keep their short names, `goat_describe` and `goat_call`.

**Proposed.** On-grammar paths that use a near synonym of a standard verb, such as
`decision.get`, `thread.configuration`, `provider.sync_status`, and
`origin.reports_wait`, become `read`, `wait`, or a `list` on a sub-resource at the
listing flip, and the old path stays as an alias. The registry and the audit page
are the catalog; this page keeps the rules.

Three projections come from a path:

| Surface  | `thread.send`      | `pending_request.respond`      |
| -------- | ------------------ | ------------------------------ |
| MCP tool | `goat_thread_send` | `goat_pending_request_respond` |
| CLI      | `goat thread send` | `goat pending-request respond` |

### Reserved arguments

**Now.** Unknown top-level arguments are refused before the handler runs, so a
misspelled `hostId` cannot silently run locally (`undeclaredArgumentsResult` in
[McpHttpServer.ts](../../apps/server/src/mcp/McpHttpServer.ts)). Other
conventions are uneven. Paging uses numeric offsets, string cursors, a bare
`limit`, or nothing, and `thread.list` across hosts returns a truncated top N with
no way to continue. Deduplication has different lifetimes: orchestration command
receipts are durable, while remote sends remember 1,000 request ids in memory
(`SENT_REQUEST_CACHE_LIMIT` in
[HostThreadsMcpService.ts](../../apps/server/src/mcp/HostThreadsMcpService.ts)).
Some writes deduplicate by a natural key instead, such as
`cloud_agent.run_register` by provider run id.

**Proposed.** The registry layer validates these before the handler runs:

| Argument          | Applies to                          | Rule                                                    |
| ----------------- | ----------------------------------- | ------------------------------------------------------- |
| `host`            | Entries marked `hostRoutable`       | Routed by the origin; see [Remote hosts](#remote-hosts) |
| `clientRequestId` | Writes marked `idempotency: "key"`  | See [Idempotency](#idempotency)                         |
| `dryRun`          | Writes marked `dryRun: "supported"` | Returns `{plan}` and changes nothing                    |
| `cursor`, `limit` | Every `list`                        | See [Paging](#paging)                                   |

The registry gains three fields so tools state these properties and tests check
them: `idempotency: "key" | "natural" | "none"`, `pagination: "cursor" | "limit" |
"none"`, and `operation`, the operation kind an entry returns when its work can
outlive the call. A test fails when an entry claims `"key"` and its input schema
has no `clientRequestId`.

### Idempotency

**Proposed.** A write that takes `clientRequestId` follows the rules payment APIs
settled on ([Stripe](https://docs.stripe.com/api/idempotent_requests),
[AIP-155](https://google.aip.dev/155)):

- The key is scoped to `(environment, caller principal, path, clientRequestId)`.
  For a thread the principal is the thread id; for an outside client it is the
  session subject.
- The first call reserves the key in the same transaction that admits the write,
  and stores a digest of the canonical arguments with it.
- A repeat with the same digest returns the stored envelope. A repeat while the
  first is still running returns `conflict` with reason `in_progress`. A repeat
  with a different digest returns `conflict` with reason `idempotency_mismatch`
  and runs nothing.
- A reservation whose work started but whose outcome was never recorded (the
  server crashed, or a remote stopped answering after dispatch) is `unknown`. A
  repeat returns `unknown_outcome` and does not dispatch again until a
  reconciliation read settles it. Where the downstream accepts its own key, the
  write passes one derived from the reservation, as cloud machine creation
  already journals its create before sending
  ([CloudMachineService.ts](../../apps/server/src/cloudMachines/CloudMachineService.ts)).
- Authorization is checked again on replay. A caller that lost its grant gets
  `permission_denied`, never the stored result.
- Keys live at least 24 hours. Orchestration receipts keep their current,
  longer life.

### Paging

**Proposed.** Paging follows MCP's cursor rules
([pagination](https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/pagination)).
The cursor is an opaque string, and `limit` is a maximum that the server may
undercut. The result carries `nextCursor`; a missing or null value means the end.
An unreadable cursor is `invalid_request` with reason `invalid_cursor`. Legacy
numeric offsets stay accepted under legacy names. A fan-out list that cannot
continue across hosts returns `truncated: true` and the hosts it skipped, never a
cursor it cannot honor.

## Result envelope

**Now.** Most tool results are JSON in one text block; some add `structuredContent` or image blocks, such as preview snapshots. Failures come as `OrchestratorMcpFailure`
with 21 codes ([orchestratorMcp.ts](../../packages/contracts/src/orchestratorMcp.ts))
and as separate families for preview, secrets, provider setup, SSH hosts, SSH
workspaces, cloud machines, memory, notes, channels, worktrees, devices, and pull
requests. Some refusals arrive inside a successful value, such as fleet
`status: "refused"`. Several handlers collapse domain codes before they leave the
toolkit: cloud machine errors become `invalid_request` or `orchestration_error`
([ssh/handlers.ts](../../apps/server/src/mcp/toolkits/ssh/handlers.ts)), and
provider errors lose their codes the same way
([provider/handlers.ts](../../apps/server/src/mcp/toolkits/provider/handlers.ts)).

**Proposed.** `goat_call`, the CLI's `--json` output, and canonical names after
the flip return one envelope:

```ts
type Result<A> =
  | { status: "ok"; value: A; meta?: Meta }
  | { status: "error"; error: AgentError; meta?: Meta }
  | { status: "needs_human"; handoff: HandoffSummary; next?: NextCall; meta?: Meta };

// What the agent calls after the person acts, when the server does not continue by itself.
type NextCall = { after: "approval" | "terminal" | "input"; path: string; args?: unknown };

type AgentError = {
  code: ErrorCode;
  reason: string; // the domain code, unchanged
  message: string;
  retryable: boolean; // computed for this call
  retryAfterMs?: number;
  details?: unknown;
};

type Meta = {
  nextCursor?: string | null;
  operation?: OperationRef; // required while accepted work is unfinished
  host?: string; // where a routed call ran
  content?: unknown[]; // non-text blocks, such as screenshots, as the tool returned them
  deprecated?: string; // canonical path when called by a legacy name
};
```

`needs_human` is its own status because the call has not failed: an agent that
treats a pending login as an error would retry it and start a second flow.
`next` carries today's `next.call` hints in registry-path form, such as
`provider.addable_list` after setup or `ssh.host_prepare` after key
registration. Long-running work gets no fourth status. Accepting it succeeded, so the result is
`ok`, and `meta.operation` is then required: an `ok` without it means the work is
done. Callers learn completion only from the operation (see
[Long-running work](#long-running-work)).

`ErrorCode` is a closed set. The first ten come from the original proposal; the
last three name cases the live surface already produces:

| Code                  | Means                                                         | Examples today                                                |
| --------------------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| `invalid_request`     | The arguments are wrong                                       | `target_required`, `invalid_cursor`                           |
| `unauthenticated`     | No usable credential for this call                            | `thread_credential_required`, cloud `invalid_key`             |
| `permission_denied`   | The credential, profile, or mode forbids it                   | `capability_denied`, `runtime_mode_escalation_denied`         |
| `not_found`           | The target does not exist here                                | `thread_not_found`, `host_unknown`                            |
| `conflict`            | The target's state changed or forbids this now; re-read first | `thread_not_sendable`, `head_changed`, `idempotency_mismatch` |
| `unavailable`         | A dependency did not answer before anything ran               | `provider_unavailable`, `host_unreachable`                    |
| `timeout`             | A bounded wait ended; the work may still be running           | preview `Timeout`, SSH `start_timeout`                        |
| `expired`             | A handle or grant aged out                                    | `ref_expired`, `approval_expired`                             |
| `cancelled`           | Stopped by request or declined by a person                    | SSH `cancelled`, `declined`                                   |
| `internal`            | A bug or storage failure                                      | `orchestration_error`, `storage_failed`                       |
| `resource_exhausted`  | A limit or capacity was reached; may clear later              | `host_pressure`, the lane limit, memory `capacity_exceeded`   |
| `failed_precondition` | Something must change first, often an update or a person      | a remote too old, `RecordingDesktopUpdateRequired`            |
| `unknown_outcome`     | A write may or may not have happened                          | `launchMayHaveStarted`, SSH handoff `launch_uncertain`        |

`retryable` is computed per call. It is true only when repeating the request
cannot duplicate an effect: the path is a read, the write carried a
`clientRequestId` the server deduplicates, or the error proves nothing ran.
`unknown_outcome` is never retryable, and its `details.reconcile` names the read
that settles it. A dispatch error that says `launchMayHaveStarted`
([SshRemoteDispatch.ts](../../apps/server/src/sshRemote/SshRemoteDispatch.ts))
maps to `unknown_outcome`.

Classification needs the facts before they are lost. Handlers keep the domain
reason, whether execution may have started, and any retry delay as structured
fields on the failure; mapping to an `ErrorCode` happens once, in the envelope
layer. The mapping is a table keyed by each domain's declared literals, and a test
enumerates every failure union in contracts and fails on a literal with no row.
Tag-name pattern matching is not used, since a new tag would be classified by
accident. Refusals that arrive inside a successful value become `error`, or
`needs_human` when a person can clear them.

Legacy tool names keep their current result shapes until they are removed.

## Long-running work

**Now.** Each domain starts and observes long work its own way:

| Work                   | Handle                     | Observe                       | Stop                        | Survives restart |
| ---------------------- | -------------------------- | ----------------------------- | --------------------------- | ---------------- |
| Provider sync          | `handoffId`, then `syncId` | `goat_provider_sync_status`   | `goat_provider_sync_cancel` | Approved syncs   |
| SSH prepare and update | host alias                 | `goat_ssh_host_status`        | `goat_ssh_host_forget`      | Yes              |
| Delegated task         | `taskId`                   | `task_status`, wait mode      | `task_cancel`               | Yes              |
| Thread or cloud launch | `threadId`                 | `goat_thread_status`, watches | `goat_thread_interrupt`     | Yes              |
| Cloud machine create   | machine id once it answers | `goat_cloud_machine_list`     | `goat_cloud_machine_stop`   | Partly           |
| Worktree cleanup       | none; blocks               | none                          | none                        | n/a              |

An approved provider sync records its start, its syncId and its final per-host
result in the approval handoff's continuation
([approvedSyncs.ts](../../apps/server/src/provider/approvedSyncs.ts)). The intent is
written before any work is registered, so after a restart a recorded start that no
longer runs settles as failed and is never started again. A sync a person or outside
client starts directly has no handoff and stays in memory.

**Proposed.** One reference type and three verbs over the stores that already own
the work:

```ts
type OperationRef = {
  operationId: string;
  kind: string; // provider_sync, ssh_setup, task, thread_run, cloud_machine, ...
  state: "queued" | "running" | "waiting_human" | "succeeded" | "failed" | "cancelled" | "unknown";
  cancellable: boolean;
  pollAfterMs?: number;
};
```

- `operationId` is an opaque token the server signs with the environment's key.
  It carries the kind, the native id, the environment, the caller principal, and
  the issue time. It names a target and grants nothing.
- `operation.read` and `operation.wait { timeoutMs ≤ 300000 }` call the kind's
  existing status path, and `operation.cancel` calls its existing cancel path,
  through the invocation function. Each verb therefore runs exactly the checks of
  the tool it replaces: cancel is a write and needs the domain's write
  authorization, runtime mode, and profile, the same as `goat_provider_sync_cancel`
  or `task_cancel` today.
- A valid token whose store has no record reports `unknown`: the server issued it,
  so the work may have happened. A token that fails verification is `not_found`.
  A token older than its kind's retention is `expired`. Kinds with in-memory stores
  give `unknown` after a restart until they persist.
- A terminal operation carries the envelope its work produced.
- `cancellable` comes from the kind; `operation.cancel` on a kind without cancel
  is `failed_precondition`. Cancel is cooperative and may end in another terminal
  state, as in MCP tasks and LSP. `forget` stops observing and leaves work running.
- `waiting_human` links the open handoff, so "a person must act, then the server
  continues" is one handle.

This mirrors Google's long-running operations ([AIP-151](https://google.aip.dev/151))
and the MCP tasks extension. It implements neither protocol; [D15](#decision-log)
covers the mapping.

## Registry

**Now.** [registry.ts](../../packages/contracts/src/agentSurface/registry.ts) holds
one entry per tool: resource, verb, legacy name, toolkit, summary, model-facing
description, effect, `hostRoutable`, `requires` (`thread | client | either`),
`dryRun`, `humanSteps`, `capability`, and MCP hints. Toolkits read their names and descriptions
from it. Registration takes read and destructive hints from each handler's
`McpToolAccess` declaration, and the parity test checks that every assembled tool
has an entry, every entry resolves a schema, and effects agree with access.
Schemas stay with their toolkits.

Every write names the goatclaw capability a caller's profile needs to run it, or
`none` with `capabilityReason` saying what bounds it instead: the caller's own
thread or browser, a person who completes the step, or another grant such as
`memory:write`. The type refuses a write without one. Tools whose thread callers
only ask a person, such as provider sign-in and sync, declare `none` so a profile
never preempts the person's decision.
No tool opens or merges a pull request, so `pr.open` gates only GOAT's pull
request tracking, and `pr.merge` gates nothing here: agents run `gh` in their own
terminal, which a profile bounds only through its runtime-mode ceiling. A goatclaw
role launch is refused when the narrowed profile lacks a capability the role's work
uses ([RoleTemplates.ts](../../apps/server/src/goatclaw/RoleTemplates.ts)), so a
merge manager is never started without `pr.merge`.
With goatclaw on, the served handle refuses a GOAT thread whose effective profile
lacks the declared capability, before arguments decode, so `goat_call` and anything
else that calls through the server inherit the check
([McpToolAccess.ts](../../apps/server/src/mcp/McpToolAccess.ts)
`requireDeclaredCapability`). Outside MCP clients are not gated per tool: other GOAT
hosts call writes on each other as outside clients, so their approved access level
and scopes bound them, and the launch, goal and hub handlers still apply the default
profile to them.

**Proposed.** Add the `idempotency`, `pagination`, and `operation` fields, and run
each entry's examples as tests.

## Discovery: `goat_describe`

**Now.** An agent learns tools from `tools/list`: 191 names with long
descriptions, all loaded into context. Whether a tool works for this caller is
found out by calling it.

**Proposed.** `goat_describe { path?, query?, host? }` answers at three depths:

- No path: resources with one-line summaries, the human-step kinds, and the
  operation verbs, in a fixed order, plus `surfaceVersion`, a hash of the
  registry that tells clients and prompt caches when it changed.
- A resource (`"thread"`): its verbs with summaries, effect classes, and
  `idempotency`.
- A full path (`"thread.send"`): input and output JSON Schema, effect class,
  reserved arguments, examples, related paths, legacy names, and
  `available: { now: boolean, reason?: string }` computed for this caller,
  including goatclaw profile capabilities and lanes left.

`query` ranks paths by text, the way a `search_tools` tool with a detail level
keeps large tool sets out of context
([Anthropic](https://www.anthropic.com/engineering/code-execution-with-mcp)).
`host` describes a remote's registry, which may be older. The same function backs
`goat describe` and `goat <resource> <verb> --help`.

**Now.** `goat_describe` answers at the three depths from the
[registry](../../packages/contracts/src/agentSurface/registry.ts), reading input and output
schemas from the tools this server actually serves, with `surfaceVersion` at the top.
`available` reports only the static refusals the server is sure of (thread-only,
client-only, read-only client, not served); goatclaw capabilities, lanes, `query`,
`host`, examples, and related paths are not in it yet. See
[handlers](../../apps/server/src/mcp/toolkits/agentSurface/handlers.ts).

**Proposed (later).** A `core` listing profile shows only the meta tools, the
operation verbs, and the most used tools. It is opt-in per provider instance and
measured against the full listing before it becomes a default.

## Calling: `goat_call`

**Now.** `goat acp-mcp-call <tool> <json>` calls any tool from a terminal with
`GOAT_ACP_MCP_ENDPOINT` and `GOAT_ACP_MCP_AUTHORIZATION`
([AcpMcpStdioBridge.ts](../../apps/server/src/mcp/AcpMcpStdioBridge.ts)).

**Proposed.** `goat_call { path, args }` runs one registry entry and returns the
envelope. It uses the one invocation function that direct MCP calls, the CLI, and
any later composition also use. That function runs argument refusal, the entry's
`McpToolAccess` declaration against the caller's `McpInvocationContext`, domain
admission (goatclaw profile, lane claims, human-only rules), and host routing, in
that order. `goat_call` has no access class of its own. Declaring it
`readsAsCaller` would be wrong twice: that declaration requires a thread
credential, so it would refuse outside clients that may call the same tools
directly, and it narrows nothing
([McpToolAccess.ts](../../apps/server/src/mcp/McpToolAccess.ts)).

A test calls every registry entry directly and through `goat_call` with the same
caller and asserts identical refusals.

**Now.** `goat_call` resolves a path, a canonical `goat_<resource>_<verb>` name, or a
legacy name, and runs the tool through the same registered handle `/mcp` serves
(`ToolDispatch`, built in `McpHttpServer`). Argument refusal, the tool's
`McpToolAccess` declaration, domain admission inside the handler, host routing, and
analytics therefore run as for a direct call. It adds no gate of its own and is declared
destructive, so a client that prompts before destructive tools still prompts before any
target reached through it. The checked-handler wrapper records the original typed error,
and `goat_call` uses it only to classify by a literal the envelope's table declares; the
message is always the text the direct call shows, so free-text reasons the direct path
scrubs never leave through it. Writes count as unkeyed until the registry gains
`idempotency`, and routed calls set `meta.host`.

**Now.** A direct `tools/call` by a canonical alias runs the served tool. The `/mcp`
auth middleware swaps the name for the served one before Effect's MCP core sees the
request, because the core checks one visibility predicate for both `tools/list` and
`tools/call` and cannot hide a tool that stays callable. The call therefore gets the
served tool's argument refusal, access checks, and result, and analytics record it
under the served name, so each tool keeps one series until the flip renames it.
Remote hosts are still called by the names they shipped with.

## Composition: `goat_eval`

**Proposed, gated.** `goat_eval` would run a small program of calls in one
request. It is built only if measurement shows it pays: on a fixed set of
multi-step tasks (wait for a project's running threads, sync a provider to every
host, fan a review out to three models), agents on providers without code
execution must spend at least a third fewer model turns with it than with
`goat_call` alone, with no rise in failed runs. Agents whose harness runs code,
such as Codex code mode or a shell with `goat call`, already compose calls in a
language they write well, which is the finding behind Cloudflare's
[Code Mode](https://blog.cloudflare.com/code-mode/) and Anthropic's code-execution
work. If it is built, these rules hold.

- **Syntax.** JSON only, validated by a schema. Forms: `call`, `let`, `ref` (an
  array path such as `["t", "value", "threads", 0, "threadId"]`, so keys with
  dots stay addressable), `seq`, `map`, `if` (on `status == "ok"` or a boolean),
  `eq`, `not`, and `quote`. No user functions, no recursion, and no loop except
  `map` over an existing value, so every program ends.
- **Limits.** 32 calls in total, counting each `map` item; depth 8; `map` input
  at most 16 items, and a longer one is `resource_exhausted` rather than a silent
  cut; 120 s wall time with any `wait` clamped to the time left; 256 KB of
  results; 16 KB of program. `map` runs items in order, one at a time.
- **Authority.** Each step goes through the invocation function, so every gate
  applies per step: the credential is checked before each step, a `map` over
  `task.create` claims one lane per child through the existing reservation, and a
  step with `host` is routed with the caller's ceiling. The program holds no lane
  and no grant.
- **Journal.** Each run has an `evalRunId`. Every completed step, reads included,
  is stored with its result under its structural id (position in the program plus
  `map` index) and a digest of its resolved arguments. On resume, completed read
  results, branch choices, and `map` bindings are fixed: they come from the
  journal and are never re-read. Write keys come from `(evalRunId, structural
  id)`, never from a call counter.
- **Suspension.** A step that returns `needs_human` ends the run with that status
  and its `evalRunId`, and its journal entry holds the handoff. On
  `goat_eval { resume: evalRunId }` the evaluator reads that handoff instead of
  calling the step again. Declined or expired becomes the step's `error`. Completed
  with a server-side continuation means the step's result is that operation's
  final envelope, waited on within the wall time. Completed without one, as with
  `provider.setup_open`, means the step's result is `ok` with the completed
  handoff summary and the `next` the step returned. The evaluator never runs
  `next` and never issues the original step again, since many human-step tools
  open a new flow on every call. A program that wants the follow-up calls it
  explicitly as a later step, which is journaled and admitted like any other call:
  `ssh.host_prepare` after key registration is a write and passes write
  admission. The server never continues a program by itself.
- **Cancellation.** Cancelling the request stops before the next step and still
  returns the journal so far with `cancelled`, as LSP requires of a cancelled
  request. A program is not a transaction and stops at the first `error`.

### Measurement protocol (draft)

**Proposed.** The D8 gate is a measurement, so it is written before any number exists, the way
aside-codemode wrote its [protocol](https://github.com/lidge-jun/aside-codemode/blob/b395d89/evidence/bench-260918/PROTOCOL.md) and runner
([paired-run.mjs](https://github.com/lidge-jun/aside-codemode/blob/b395d89/eval/paired-run.mjs)) after a first pass measured the wrong transport
and the wrong unit of work. `goat_eval` stays unbuilt until this protocol runs against a
prototype on a branch and passes. The task set, runner, and report are in
[scripts/agent-surface/eval](../../scripts/agent-surface/eval/), and
[Measuring `goat_eval`](../operations/agent-surface-eval.md) explains how to run them.

- **Claims first, including losers.** Each workload states its claim and what falsifies it. A
  single-call control is included and is expected to show no gain, because one call is one turn
  either way.
- **Workloads.** Wait for every running thread in a project; sync one provider to every connected
  host; fan one review out to three models and collect the three results; a program that stops on
  `needs_human` and resumes after a person approves; and the single `thread.read` control. Each
  workload is a fixed prompt plus an oracle: the exact ids, statuses, or report text a correct
  run returns. Reaching the end of a transcript is not correctness.
- **Arms.** `goat_call` alone against `goat_eval` available, on the same provider and model.
  Providers without code execution are the population the gate is about. A code-mode harness
  (Codex code mode, or a shell with `goat call`) runs as a reference arm and is not part of the
  pass criterion.
- **Pairs.** Arms alternate ABBA with a schedule derived from the pair index, and the report says
  how often each arm went first. Each run is a fresh thread on a dev server with seeded data, and
  its fixture is created for that run. At least 10 clean runs per arm and workload, with raw rows
  kept and a separate report step, so a disputed figure can be re-derived.
- **Metrics.** Primary: model turns per run. GOAT records no model request count, and calls made
  in one response arrive as consecutive items, so turns are a range from the run's items: tool
  rounds + 1 to tool calls + 1. Secondary: tool calls, bytes of tool results that enter the
  transcript, failed runs, and wall time. Timing alone never passes the gate.
  aside-codemode's agent-level pairs moved wall time only 5–45% (ratio 0.553 to
  0.952 against a target under 0.5), because about 8 s of fixed cost per model turn hid the
  primitive's speedup ([summary.md](https://github.com/lidge-jun/aside-codemode/blob/b395d89/evidence/summary.md)). Its gains were fewer calls and
  fewer bytes in context: one round trip instead of 24, and 356 bytes instead of 116,234 for eight
  pages ([BENCHMARKS.md](https://github.com/lidge-jun/aside-codemode/blob/b395d89/BENCHMARKS.md)).
- **Contamination.** A run that used a tool or capability its arm does not have, or that the
  harness could not finish, is reported and excluded from every figure. A failed tool call is
  the arm's own cost: the run keeps its extra turns in the medians, and the report counts failed
  calls per arm. A wrong answer keeps the run in the failure rate. Excluding either would hide the first-call mistakes a new syntax adds:
  aside-codemode counted 47 failed results in 371 runs, and the four most common were wrong
  names and argument shapes ([ADR-0011](https://github.com/lidge-jun/aside-codemode/blob/b395d89/structure/decisions/ADR-0011-the-block-carries-what-an-error-cannot-say.md)).
- **Pass.** On each multi-step workload, the candidate's most model turns are at least a third
  below the baseline's fewest, with no rise in failed runs and every oracle met, and the control
  shows no gain. Anything else is "not built", and the result is recorded either way.

## Human steps

**Now.** One durable [Handoff](../../packages/contracts/src/handoff.ts) record
exists. Its `kind` is the modality (`oauth`, `device_code`, `terminal`, `secret`,
`approval`, `mfa`), and its `target.path` is what the person is deciding
(`ssh.host_add`, `provider.setup`, `computer_use.grant`). Human instructions and
continuation arguments are stored apart, encrypted, and returned only over
authenticated client RPC. Agents get `HandoffSummary`.

Around it, a human step reaches an agent in several shapes:

| Flow                         | Agent sees                                        | Who resolves                          | What continues                                       |
| ---------------------------- | ------------------------------------------------- | ------------------------------------- | ---------------------------------------------------- |
| SSH trust, key, update       | `needs_human` with `next.call`                    | person with environment scopes        | server continues prepare and update; trust only pins |
| Provider sync                | `needs_human` with `next.call`                    | person with `providers:manage`        | server runs the sync under the approver's session    |
| Provider setup, Codex home   | `needs_human` with `next.call`                    | person with `providers:manage`        | person finishes in the app; agent calls again        |
| Computer use                 | `needs_human` beside `available` and `refused`    | person with settings authority        | an admission lease; tools attach next turn           |
| Sign-in by a managing client | `{kind: "flow"}` with `continueIn`                | the session that started it           | a server fiber, in memory                            |
| Secrets                      | a blocking result with `secretRef`                | person in the thread                  | agent uses the ref in a later call                   |
| Runtime approvals, questions | a pending request by `requestId`                  | person, or an outside approver client | the provider run                                     |
| Decisions                    | `DecisionItem` by id                              | agent or person, per item             | answer delivered as a thread message                 |
| Cloud launch consent         | `capability_denied` text telling the agent to ask | person answering a decision `approve` | agent calls launch again with `decisionId`           |

One gap follows. A handoff resolving does not wake the thread that asked; it
only updates the card. Who may resolve a step is one predicate
([HumanStepAuthority.ts](../../apps/server/src/handoffs/HumanStepAuthority.ts)),
used by pending-question MCP, the decision inbox, and handoffs, so an outside
client holding `orchestration:approve` answers a provider approval the same way
through either path.

**Proposed.**

- **Owners.** Handoffs own anything with private instructions or a server-side
  continuation. The decision inbox owns decisions and projects runtime requests
  and open handoffs for display. Neither copies the other's state.
- **One status.** Every flow above in which a person must act returns
  `needs_human` with a `HandoffSummary`, plus `meta.operation` when the server
  continues the work. Decisions and questions an agent may answer keep their
  current shapes; only human-required items change. Cloud launch consent
  becomes a handoff targeting `cloud_agent.launch`, whose approval binds a digest
  of the launch arguments and the credential holder; a different launch needs a
  new approval.
- **Who resolves.** One predicate, used by pending requests, the decision inbox,
  handoffs, aliases, and `goat_call`:
  - A runtime approval may be resolved by a person's client session, or by an
    outside MCP client session whose `approvals` flag is set, which requires both
    `orchestration:operate` and `orchestration:approve`
    ([EnvironmentAuth.ts](../../apps/server/src/auth/EnvironmentAuth.ts)), and which
    still passes live write authorization. A person mints that client on purpose
    from the local CLI for a tool they control; it proves the client was trusted,
    not that a person answered each approval. The decision inbox accepts the same
    clients for projected approvals, through the same predicate.
  - Every other human step (human-required questions, secrets, sign-in, host
    trust, computer use, billing consent) needs a person's client session.
  - A thread credential resolves none of them, whatever its scopes.
- **Wake.** When a handoff a thread created resolves or expires, that thread is
  woken through the launch-watch wake path
  ([LaunchWatchService.ts](../../apps/server/src/mcp/LaunchWatchService.ts)).
- **Confidentiality by credential.** Thread credentials never receive codes, URLs,
  fingerprints, or terminal output. A client session that owns a sign-in flow may,
  because that session is the person's own surface; managing-client sign-in
  already works this way.
- **Expiry** stays per target. Provider and computer-use handoffs run on a clock
  because people answer after the asking turn ends. SSH targets last 24 hours. An
  approval tied to a run ends with it.

Every state change is an event with its actor: the thread that asked, and the
client label that opened, completed, or declined it. Secret values, codes, and
URLs never enter events. A handoff on an SSH host appears on the origin's clients
through the remote report path; `goat handoff list` and `goat handoff open <id>`
give the person a terminal route.

## Remote hosts

**Now.** `host` on a host-routable tool sends the call over SSH or to a linked
host. Writes forward the caller's runtime ceiling. Since
[#758](https://github.com/goat-si/goat/pull/758), a follow-up `thread.send` with
`host` also forwards the caller's goatclaw ceiling as `permissionProfileCeiling`,
and the origin refuses a destination that has not shown it enforces ceilings
instead of falling back to the relay, which would deliver without one. Remote
servers answer only to the tool names they shipped with
([ADR-0007](../../structure/decisions/ADR-0007-mcp-tool-names.md)).
The origin checks the calling thread's capability before forwarding, plus
`threads.remote` and the profile's host allowlist for a host-routable write that
names `host`.
A thread launched or sent with a forwarded ceiling is bound to it on the
destination, so its own calls there are checked against it. Other host-routed writes
arrive as the origin's dispatch session, and the destination relies on the origin's
check. Writes that name their target machine in another argument (`targetHost`,
`destinationHost`, an alias) get the capability check but not the host allowlist.

**Proposed.**

- Forwarding stays with the origin server. A meta tool, the CLI, or a composed
  step names a `host`, and the origin's router builds the ceiling, claims the
  lane, and translates canonical names to legacy ones when the remote's
  `serverVersion` predates the listing flip.
- `meta.host` says where a call ran. Remote errors keep their `reason` and gain
  `details.host`.
- A remote too old for a requested feature answers `failed_precondition` with
  reason `remote_outdated`. It never falls back to running locally.

## Audit

**Now.** Each MCP call records one anonymous `mcp.tool.invoked` analytics event
with no ids or text. Orchestration receipts record commands. The decision inbox
keeps an append-only audit of actor, profile, action, target, and outcome, and
handoff transitions are events with actors.

**Proposed.** Analytics stays anonymous. Every write through the invocation
function records principal, profile id, effective ceiling, host, path, argument
digest, receipt id, and outcome in the receipts table that also serves
idempotency, so one table answers who did what, under which grant, and where.
Composed runs add their `evalRunId` to each step. Spans are named
`AgentSurface.call` and `AgentSurface.eval`, and remote dispatch carries
`traceparent`.

## Reference documentation

**Now.** [agent-surface-audit.md](./agent-surface-audit.md) is generated from the
registries, and goat-ci's check task runs `pnpm agent-surface:check`, so a change that
moves the registry, a toolkit, or a cited line fails until `pnpm agent-surface:audit`
regenerates the page. The server serves `/llms.txt`, one line per registry path
([llms.ts](../../packages/contracts/src/agentSurface/llms.ts)). Without a credential it
lists every path; with a credential `/mcp` accepts, it drops paths that credential's kind
cannot reach (thread-only, client-only, and writes for a read-only client). Permission
profiles are still checked only when a tool runs. Tool reference prose is still
hand-written in
[orchestrator-mcp-server.md](../orchestration-v2/orchestrator-mcp-server.md).

**Proposed.** The running server is the reference. `goat_describe`, `/llms.txt`
filtered by the caller's permission profile too, and generated `--help` all read
the registry, so they cannot drift from it, and they show what this caller on this
version can do. Per-resource reference pages are not committed to the repository:
the [documentation rules](../../AGENTS.md#documentation) allow one catalog, which
the registry already is. CI fails when an entry's effect disagrees with its access
declaration or when an example fails against the toolkit test harness. The
hand-written tool sections in `orchestrator-mcp-server.md` shrink to lifecycle
and policy once describe ships.

## The `goat` command

**Now.** The desktop app writes a launcher to `<GOAT home>/bin/goat` (`goat.cmd`
on Windows) at start and rewrites it on update
([DesktopCliShim.ts](../../apps/desktop/src/app/DesktopCliShim.ts)). **Settings →
General → About → Install** links it into the first writable folder among
`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, and `~/bin` on macOS
(`~/.local/bin` and `~/bin` on Linux), or adds its folder to the user `PATH` on
Windows ([DesktopCliCommand.ts](../../apps/desktop/src/app/DesktopCliCommand.ts);
[install guide](../user/install.md#the-goat-command)). Bare `goat` runs the
server; the subcommands are operator tools.

**Proposed.**

```text
goat <resource> <verb> [args] [--json] [--host <alias>] [--dry-run] [--request-id <id>]
goat describe [path] [--query <text>]
goat call <path> [json | -]
goat operation read|wait|cancel <id>
goat handoff list | open <id> | decline <id>
goat login | logout | whoami
goat serve | start | pair | auth | service | update | uninstall | connect | ...   (unchanged)
```

Resource commands and `--help` are generated from the registry. `goat call`
replaces `acp-mcp-call`, which stays as an alias. `--json` prints the envelope as
one JSON document on stdout, with logs on stderr. Exit codes: `0` ok, `1` error,
`2` usage, `3` needs_human, `4` retryable error, `5` unknown outcome. An `ok` that
carries an operation exits `0` and prints the operation id. `goat operation wait`
maps the operation's state: `succeeded` exits `0`, `failed` and `cancelled`
exit `1`, `waiting_human` exits `3`, `unknown` exits `5`, and a wait that
times out while the work is still `queued` or `running` exits `6`.

The npm package keeps its `goat` and `t3` bins, and bare `goat` keeps starting a
server, so `npx t3` users see no change. The desktop launcher marks itself so that
bare `goat` from it prints help instead of starting a second server. Linux
packages gain `/usr/bin/goat`, and the welcome wizard offers the install once.

### Credentials

The CLI resolves a credential for the origin server only:

1. `GOAT_ACP_MCP_ENDPOINT` and `GOAT_ACP_MCP_AUTHORIZATION`, which GOAT sets for
   agent subprocesses and terminals, so `goat` inside a thread has exactly that
   thread's grant. When they are present and invalid, the CLI fails; it never falls
   back to a stored login, which could carry more authority.
2. A session from `goat login`, which pairs with the local server and must yield an
   `mcp-client` credential, the only outside subject `/mcp` accepts
   ([EnvironmentAuth.ts](../../apps/server/src/auth/EnvironmentAuth.ts)).

`--host` is routing, not a credential. The CLI sends the call with `host` to the
origin, which applies lane admission and ceiling forwarding; calling a remote
directly would skip both.

`goat auth client create` opens the environment's state directly and can mint a
token with approval scope. An agent with a full-access shell can run it, and can
read the state directory itself, so the real boundary is the OS user and the
runtime mode. The CLI refuses credential-minting commands when a thread credential
is in its environment. That stops mistakes; runtime-mode sandboxing enforces the
boundary.

## Worked example: provider setup

**Now.** This flow is shipped and is the model for the rest.

- `provider.diagnose` explains why a provider is not ready, here or on an SSH host
  through [ProviderDiagnosisRouting](../../apps/server/src/provider/ProviderDiagnosisRouting.ts).
  Claude Cloud and Devin Cloud follow a sibling instance (`sourceInstanceId`,
  `siblingInstanceId`), so signing in to the sibling is the fix.
- `provider.setup_open` returns `needs_human` with a `provider.setup` handoff. The
  person finishes in the add-provider window the model picker's **+** opens, under
  their own session, and the agent calls `provider.addable_list` again.
- `provider.login_start` gives thread agents the same handoff. A client holding
  `providers:manage` starts the flow under its own session, and only that session
  can read or cancel it
  ([providerAuthFlow](../../packages/provider-core/src/server/providerAuthFlow.ts)).
  Results go through `redactProviderAuthState`
  ([providerOnboarding.ts](../../packages/contracts/src/providerOnboarding.ts)).
- `provider.sync` installs CLIs and starts sign-in across hosts after a person with
  `providers:manage` approves. It runs under the approver's session, and each
  remote installs and stores credentials itself; credentials are never copied
  between machines ([ProviderHostSync](../../apps/server/src/provider/ProviderHostSync.ts)).
- `provider.update`, `provider.add`, `provider.link`, and `provider.remove` change
  provider settings here or on an SSH host through
  [ProviderSettings](../../apps/server/src/provider/ProviderSettings.ts), which writes
  with the same `updateProviderInstance` call Settings uses. A client holding a live
  `providers:manage`, or a full-access/default thread whose goatclaw profile allows
  `providers.manage`, applies the change itself. Any other thread gets a
  `provider.settings` approval card that stores the exact request, and approving it
  applies that request under the approver's session. `provider.diagnose` fixes that a
  settings change resolves carry a `call` and become `actor: "agent"` for a caller
  allowed to make it.
  An approved change records each effect (install, save, link, or the call to a remote)
  in its handoff's continuation before and after it runs, and keeps the outcome for a day
  after, apart from the approval itself. A restart repeats only effects proven safe to
  repeat; one that may have run without a recorded outcome ends as `unknown_outcome`
  naming the `provider.diagnose` call that settles it
  ([ProviderSettingsProgress](../../apps/server/src/provider/ProviderSettingsProgress.ts)).

Asking for any of these approvals needs only a running, writable thread
credential. What runs after approval is authorized against the approving person's
session ([SshHostAuthorization.ts](../../apps/server/src/sshRemote/SshHostAuthorization.ts)).
A remote write runs under an SSH-issued `providers:manage` session that the origin
requests only for a call it has already admitted, and a remote too old to issue one
fails the call rather than falling back.

**Proposed.** Three things change. `provider.sync` returns
`meta.operation` (kind `provider_sync`) and either persists or reports `unknown`
after a restart. The requesting thread is woken when the card resolves. The
per-flow `next.call` hints become the operation, so the agent waits on one handle.

## Rollout

Each PR ships on its own and leaves `tools/list` unchanged until the flip.

| #   | Ships                                                                         | State                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Registry and parity test                                                      | Shipped ([#211](https://github.com/goat-si/goat/pull/211))                                                                                                                 |
| 2   | Handoff record, cards, SSH continuations                                      | Shipped ([#212](https://github.com/goat-si/goat/pull/212))                                                                                                                 |
| 3   | Provider diagnose, setup, login, sync                                         | Shipped ([#210](https://github.com/goat-si/goat/pull/210), [#540](https://github.com/goat-si/goat/pull/540)); settings in [#774](https://github.com/goat-si/goat/pull/774) |
| 4   | Envelope schema; handlers keep domain reasons; exhaustive classification test | Started ([#773](https://github.com/goat-si/goat/pull/773))                                                                                                                 |
| 5   | One invocation function, `goat_call`, `goat_describe`                         | Started ([#785](https://github.com/goat-si/goat/pull/785))                                                                                                                 |
| 6   | Idempotency receipts with digest, unknown state, audit columns                | Proposed                                                                                                                                                                   |
| 7   | Operations over existing stores; durable provider sync                        | Proposed                                                                                                                                                                   |
| 8   | Human steps return `needs_human`; cloud consent handoff; wake; one predicate  | Proposed                                                                                                                                                                   |
| 9   | Registry-generated CLI commands and credentials                               | Proposed                                                                                                                                                                   |
| 10  | Listing flip, verb normalization, remote name translation                     | Started: canonical names callable as unlisted aliases ([#906](https://github.com/goat-si/goat/pull/906))                                                                   |
| 11  | `goat_eval`                                                                   | Gated on measurement                                                                                                                                                       |

Testing follows the repository rules: focused tests per behavior, effect worker
draining instead of sleeps, and one real-client pass for cards.

## Prior art

| Source                                                                                                                                     | Lesson                                                                                                                         | Used for                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| [MCP 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)                                             | Results carry `resultType` (`complete` or `input_required`); tasks became an extension; tool lists come in deterministic order | `needs_human` as a result; stable describe |
| [MCP 2025-06-18 changelog](https://modelcontextprotocol.io/specification/2025-06-18/changelog)                                             | JSON-RPC batching was removed                                                                                                  | No batch protocol; composition is explicit |
| [MCP tasks extension](https://modelcontextprotocol.io/extensions/tasks/overview)                                                           | A durable handle with `working`, `input_required`, and terminal states; cooperative cancel                                     | Operation states and cancel                |
| [MCP URL-mode elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)                                    | Sensitive input must not pass through the client                                                                               | Confidentiality by credential              |
| [MCP pagination](https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/pagination)                                     | Opaque cursors; server page size; a bad cursor is invalid params                                                               | Paging                                     |
| [LSP 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)                                    | A cancelled request still answers, possibly with partial results; `ContentModified` asks the client to re-read                 | Cancelled journal; `conflict`              |
| [JSON-RPC 2.0](https://www.jsonrpc.org/specification)                                                                                      | Batches are unordered and not transactional                                                                                    | Sequential `map`; "not a transaction"      |
| [AIP-151](https://google.aip.dev/151), [AIP-155](https://google.aip.dev/155), [AIP-193](https://google.aip.dev/193)                        | One operation interface; request ids guarantee idempotency; errors keep a stable reason with metadata                          | Operations; `clientRequestId`; `reason`    |
| [Stripe](https://docs.stripe.com/api/idempotent_requests)                                                                                  | Keys compare parameters and reject a mismatch; 24-hour retention                                                               | Digest and mismatch                        |
| [Temporal](https://docs.temporal.io/activity-definition)                                                                                   | Replay from recorded history; a crash after a side effect and before its record needs a downstream key                         | Journal; unknown reservations              |
| [Cloudflare Code Mode](https://blog.cloudflare.com/code-mode/), [Anthropic](https://www.anthropic.com/engineering/code-execution-with-mcp) | Models compose tools better in code; tool search with detail levels saves most of the context                                  | Gate `goat_eval`; `query`                  |
| [R7RS Scheme](https://small.r7rs.org/)                                                                                                     | A few special forms suffice when the host supplies primitives                                                                  | The eval forms                             |

### Lessons from aside-codemode

aside-codemode is a code-mode tool for a signed-in browser and a local filesystem
([lidge-jun/aside-codemode](https://github.com/lidge-jun/aside-codemode) at `b395d89`). It already
ran into most of the problems this design addresses. What GOAT takes from it, and what it avoids:

| Take or avoid | What                                                                                                                                                                                           | Source                                                                                                                                                                                                                   | Here                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Take          | If the implementation skipped, capped, or could not apply something requested, the result must not report full success. A cap is honest only if the reader asked for `max + 1`.                | [result-completeness.md](https://github.com/lidge-jun/aside-codemode/blob/b395d89/structure/result-completeness.md)                                                                                                      | [Paging](#paging), D16                              |
| Take          | Counts are tied to the verdict: a run is never complete while a requested item is missing, every requested item gets an answer even after a stop, and results are matched by id, not position. | [batch-contract.md](https://github.com/lidge-jun/aside-codemode/blob/b395d89/structure/batch-contract.md)                                                                                                                | `goat_eval` journal, `map`                          |
| Take          | An effect that started and was never confirmed is its own state, neither success nor failure, and is never retried.                                                                            | [batch-contract.md](https://github.com/lidge-jun/aside-codemode/blob/b395d89/structure/batch-contract.md)                                                                                                                | `unknown_outcome`                                   |
| Take          | "A person can clear this" is a claim that has to be earned. A block that does not prove it stays a failure, and only a proven one becomes `needs_input`.                                       | [batch-contract.md](https://github.com/lidge-jun/aside-codemode/blob/b395d89/structure/batch-contract.md), [session-contract.md](https://github.com/lidge-jun/aside-codemode/blob/b395d89/structure/session-contract.md) | `needs_human` requires a handoff (D17)              |
| Take          | Approval ids are not run ids. Approvals are consumed once by an atomic claim, and a claim whose run never recorded an id is reported as unknown.                                               | [ADR-0007](https://github.com/lidge-jun/aside-codemode/blob/b395d89/structure/decisions/ADR-0007-approval-ids-are-not-run-ids.md)                                                                                        | handoff ids, operations                             |
| Take          | "What counts as a write" is one list, the effect ledger. Two hand-kept lists drifted twice before that.                                                                                        | [ADR-0006](https://github.com/lidge-jun/aside-codemode/blob/b395d89/structure/decisions/ADR-0006-the-write-gate-uses-the-effect-ledger.md)                                                                               | effect from `McpToolAccess` only                    |
| Take          | One resident tool (2.4 KB) with on-demand descriptions instead of 34 described actions (44 KB, paid every turn).                                                                               | [BENCHMARKS.md](https://github.com/lidge-jun/aside-codemode/blob/b395d89/BENCHMARKS.md#tool-schema)                                                                                                                      | `goat_describe`, `core` profile                     |
| Take          | Always-on instructions carry only what no refusal can teach, such as "a successful but incomplete result is not an answer"; everything an error can correct belongs to the error.              | [ADR-0011](https://github.com/lidge-jun/aside-codemode/blob/b395d89/structure/decisions/ADR-0011-the-block-carries-what-an-error-cannot-say.md)                                                                          | provider instructions after the flip                |
| Avoid         | Guessing state from wording. A signed-in heuristic was wrong both ways, and its false pass was the failure the layer existed to stop.                                                          | [ADR-0003](https://github.com/lidge-jun/aside-codemode/blob/b395d89/structure/decisions/ADR-0003-session-proof-comes-from-the-caller.md)                                                                                 | plain-text failures stay `internal`                 |
| Avoid         | Deciding by name lists: metadata crossed the wire by action name, so a newly added action arrived bare.                                                                                        | [result-completeness.md](https://github.com/lidge-jun/aside-codemode/blob/b395d89/structure/result-completeness.md)                                                                                                      | registry-derived checks; exhaustive literal table   |
| Avoid         | Loss reported only inside text, such as a `[truncated: …]` suffix that a caller checking fields cannot see.                                                                                    | [result-completeness.md](https://github.com/lidge-jun/aside-codemode/blob/b395d89/structure/result-completeness.md)                                                                                                      | loss lives in fields                                |
| Avoid         | A status in the vocabulary that nothing emits. `needs_input` was documented to agents for weeks before any code produced it.                                                                   | [batch-contract.md](https://github.com/lidge-jun/aside-codemode/blob/b395d89/structure/batch-contract.md)                                                                                                                | operation states ship with their producers          |
| Avoid         | "Complete" read as "absent": a default search returned 8 of 15 known matches and still said complete.                                                                                          | [BENCHMARKS.md](https://github.com/lidge-jun/aside-codemode/blob/b395d89/BENCHMARKS.md), [issue #41](https://github.com/lidge-jun/aside-codemode/issues/41)                                                              | completeness never claims absence                   |
| Avoid         | Measuring the harness, not the product: CLI numbers carried 60–70 ms of process start that the resident server never pays, and a single grep was the wrong unit of work.                       | [PROTOCOL.md](https://github.com/lidge-jun/aside-codemode/blob/b395d89/evidence/bench-260918/PROTOCOL.md)                                                                                                                | [measurement protocol](#measurement-protocol-draft) |

Its session contract also applies by analogy. Steps that share a signed-in session are not
independent, so a batch over them can turn one expired session into many false successes.
Steps in a GOAT program share credentials, lanes, and thread state the same way, which is why
every gate runs per step (D7).

## Decision log

| #   | Decision                                                                                                                                                          | Why                                                                                                                                              | Rejected                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| D1  | Three statuses; unfinished work is `ok` with a required `meta.operation`                                                                                          | Accepting work succeeded; a fourth status splits every caller's branch; a required handle keeps "accepted" from reading as "done"                | A `running` status                             |
| D2  | Add `resource_exhausted`, `failed_precondition`, `unknown_outcome`; compute `retryable` per call; keep reasons in handlers                                        | The surface already produces these; per-code retry flags would retry launches that may have started; a classifier cannot recover collapsed codes | Folding them into `unavailable` and `conflict` |
| D3  | `clientRequestId` reserves atomically with an argument digest; unrecorded outcomes stay `unknown`                                                                 | Replaying a stored result for other arguments corrupts silently; redispatch after a crash duplicates side effects                                | "Same id returns the first result"             |
| D4  | Opaque cursors; fan-out lists that cannot continue say `truncated`                                                                                                | One shape; no false continuation                                                                                                                 | Numeric offsets everywhere                     |
| D5  | `operation.*` over existing stores with signed handles                                                                                                            | Smallest change giving one handle; a signature separates "issued but lost" from "never issued"                                                   | A new operations table first                   |
| D6  | One invocation function for direct calls, `goat_call`, the CLI, and composition                                                                                   | Equivalence by construction; `readsAsCaller` would refuse outside clients                                                                        | Meta tools with their own access class         |
| D7  | Gates apply per step; composition holds no lane or grant                                                                                                          | Lanes and ceilings are claimed by the work they bound                                                                                            | Pre-admitting a whole program                  |
| D8  | Gate `goat_eval` on a stated measurement; if built: JSON, array refs, ordered `map`, fixed journal, no server-run programs                                        | Code-mode harnesses already compose; replay by call index after fresh reads can reuse a receipt for a different call                             | S-expression syntax; replay by index           |
| D9  | Handoffs own continuations, the inbox owns decisions; all human steps return `needs_human`; one resolver predicate; wake on resolve                               | Nine contracts today; the two approval paths disagree; agents parse prose to learn a person must act                                             | A third store; leaving the paths inconsistent  |
| D10 | `goat_describe` adds `query`, `surfaceVersion`, `host`, and availability per caller                                                                               | Progressive discovery; cache safety; remotes differ                                                                                              | Loading every schema                           |
| D11 | `read` and `cancel` are standard verbs; synonyms normalize at the flip                                                                                            | `get` and `read` both exist today                                                                                                                | Renaming now                                   |
| D12 | The CLI authenticates to the origin only and fails closed; `--host` is routing                                                                                    | Ceiling forwarding and lane admission happen at the origin                                                                                       | Local credentials for remotes                  |
| D13 | Write receipts double as the audit; spans and `traceparent` across hosts                                                                                          | One record answers who, under which grant, and where                                                                                             | Ids in analytics                               |
| D14 | Served reference (describe, `/llms.txt`, `--help`) instead of committed pages                                                                                     | The registry is the catalog; committed pages would be a second one                                                                               | `docs/reference/` pages                        |
| D15 | Stay independent of MCP versions; `operation` can map to MCP tasks and `needs_human` to `input_required` later                                                    | MCP removed sessions and moved tasks in 2026-07-28; tracking each revision would churn the surface                                               | Adopting the tasks extension now               |
| D16 | Every list and fan-out discloses loss in fields: read `limit + 1` before claiming more exists, and never report a request as complete when part of it was skipped | aside-codemode shipped the same silent-loss bug six times before writing the invariant                                                           | Loss text inside values                        |
| D17 | `needs_human` only with a handoff a person can act on; a block nobody can clear stays `error`                                                                     | A human status that does not hold makes agents hand back work no person can fix                                                                  | Inferring human steps from messages            |
| D18 | The D8 gate is a written protocol with paired ABBA runs, an oracle per workload, and model turns as the primary metric                                            | Agent-level timing hid real gains behind per-turn cost in aside-codemode; fewer turns and bytes were the measurable effect                       | A wall-clock threshold                         |
| D19 | Off-grammar names keep their paths except verb synonyms; `cloud_agent` stays the resource, so its canonical names are `goat_cloud_agent_*`                        | The path is the stable identity agents already use through `goat_call`; `cloud` alone would read as a sibling of `cloud_machine`                 | Renaming paths to match shipped names          |
| D20 | Before the flip, canonical names are unlisted aliases resolved at `/mcp` to the served tool, whose checks, result and analytics name apply                        | One handle keeps refusals identical by construction; the listing and provider instructions change together at the flip                           | Registering alias tools, which would list them |

## Open questions

- Which providers the `goat_eval` measurement runs on, and who owns the task set.
- Whether `tools/list` should move to the `core` profile by default.
- How long a legacy name stays callable for SSH hosts that update rarely.
