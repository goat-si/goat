# Agent surface

> **요약 (Korean summary)**
> GOAT의 에이전트 표면(MCP 도구, `goat` CLI, 문서)을 작은 균일 문법 위로 다시 세우는 설계다.
> 레지스트리(`resource.verb` 경로, 패리티 테스트 포함)와 사람 핸드오프 레코드는 이미 배포되었다.
> 결과는 `ok | error | needs_human` 세 갈래로 유지하고, 등록된 operation 종류의 끝나지 않은 작업은 `meta.operation` 핸들을 붙여 `operation.read/wait/cancel`로 다룬다.
> 오류 코드에 `resource_exhausted`, `failed_precondition`, `unknown_outcome`을 더하고, 재시도 가능 여부는 호출마다 계산한다. 도메인 사유는 변환 전에 보존한다.
> `clientRequestId`는 인자 다이제스트와 함께 원자적으로 예약하고, 결과가 기록되기 전에 끊긴 키는 `unknown_outcome`으로 남겨 자동 재실행을 막는다.
> `goat_call`은 직접 MCP 호출과 같은 단일 검사 경로를 쓴다. 화면 작업에는 `goat_screen_run`이 유한한 JavaScript 셀을 제공하며, 호출마다 권한을 다시 검사한다.
> 런타임 승인은 사람의 클라이언트 세션 또는 `orchestration:operate`와 `orchestration:approve`를 모두 가진 외부 MCP 클라이언트만, 그 밖의 사람 단계는 사람의 클라이언트 세션만 해결한다.
> 모든 하네스의 기본 도구 목록은 core(`goat_describe`, `goat_call`)이고, `agentToolListing: "full"`이 되돌리는 길이다(D21). `goat_screen_run`은 턴에 내장 브라우저나 컴퓨터 사용이 붙었을 때만 나열된다.
> `goat_eval`은 코드 모드가 없는 하네스를 위해 여러 호출을 서버에서 묶는 작은 S-식 실행기로, opt-in으로 추가한다. 호출마다 같은 검사를 거치고, 프로그램 위치로 키를 잡은 저널 덕분에 재시도와 재개가 읽기를 다시 부르거나 쓰기를 중복하지 않으며, 재개할 때 기록된 권한을 다시 확인한다. core 대 core+eval 측정이 합격선을 넘으면 별도 PR로 기본 목록에 올린다(D8).
> 생성된 참조 문서는 저장소에 커밋하지 않고 실행 중인 서버가 제공한다. 결정 기록(D1–D22)과 선행 사례 비교를 끝에 둔다.

This page uses two labels. **Now** describes implemented source in this checkout;
it does not certify a release. **Proposed** is design that does not exist yet.
Unlabeled text in a Proposed section is also proposal. The [rollout](#rollout)
table tracks integration status.

## Why this exists

An agent working in GOAT meets three surfaces that grew separately: MCP tools, a
server CLI built for operators, and prose docs. They disagree in naming, result
shape, retry behavior, and coverage.

**Now.** `/mcp` mounts the tools counted in the generated [audit](./agent-surface-audit.md). Every tool has a registry
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

`background.wait` keeps the standard verb but records waiting state, so its effect is write;
the registry's effect class, not the verb, decides how a path is gated.

A domain verb (`thread.send`, `preview.click`, `decision.answer`) is allowed when
no standard verb fits, and the registry records its effect class. `forget` stays
distinct from `cancel` and `delete`: it stops GOAT observing something and leaves
it running, as `cloud_agent.run_forget` does.

A verb on a sub-resource names the sub-resource first: `channel.task_read`,
`memory.settings_update`, `ssh.host_prepare`.

**Now.** The full `tools/list` shows every path as `goat_<resource>_<verb>`; the meta tools keep
their short names, `goat_describe` and `goat_call`. 79 names a tool shipped under are
not that projection ([#781](https://github.com/goat-si/goat/issues/781)). `/mcp` still
accepts each of them in `tools/call` without listing it, runs the listed tool, and
returns `_meta["goat/deprecated"]` naming the listed name
([ToolDispatch.ts](../../apps/server/src/mcp/ToolDispatch.ts) `withServedToolNames`).
Toolkits register under the shipped name, so access declarations, capability checks, and
analytics keep that key whichever name a caller used; only the listing renames
(`McpHttpServer` `withListedNames`). Paths that used a near synonym of a standard verb were
normalized (D11): `decision.read`, `permission_profile.read`,
`thread.configuration_read`, `provider.sync_read`, `origin.report_wait`,
`memory.settings_read`, `memory.source_read`, and `preview.wait`. `goat_call` and
`goat_describe` still accept the old paths, and `goat_call` then reports the current
path in `meta.deprecated`. The registry and the audit page are the catalog; this page
keeps the rules.

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

**Now.** Writes the registry marks `idempotency: "key"` reserve their key in
`mcp_request_reservations` through
[ToolAdmission.ts](../../apps/server/src/mcp/ToolAdmission.ts). The key is taken
where the declaration admits the write, after every caller check, so direct calls
and `goat_call` share it and a replay passes the checks again. A handler that
authorizes inside its body (SSH launch's profile and role checks, the worktree
credential, a schedule update's task checks) declares `admission: "handler"`
and admits after them. Services also
authorize inside (provider settings, lane claims), so the reservation records the
caller's grant as the launch resolves it: its runtime and interaction modes, its
goatclaw capabilities, ceiling and host allowlist (narrowed by a forwarded ceiling
or a role's profile), and a client's scopes and read-only state. A replay is
answered only while the caller still holds at least that grant, with a client's
scopes reauthorized live. The
reservation is its own statement, not part of each domain's transaction; the gap
between it and the recorded outcome is what `unknown` covers. A transient
refusal that ran nothing frees the key, other failures replay, and a failure that
may have left effects, an interrupt, or a row an earlier server process left
running stays `unknown` and never runs again; its refusal names the read that settles
it, on the same host for a routed write. Keyed writes that dispatch orchestration
commands or remote thread launches derive their command or correlation id from the
reservation's receipt id (`mcp:<receiptId>`, `mcp:lifecycle:<receiptId>`, `rr-<receiptId>`).
When the caller runs the named reconcile read (or reads a lifecycle receipt),
[ToolAdmissionSettlement.ts](../../apps/server/src/mcp/ToolAdmissionSettlement.ts)
settles any `unknown` reservation whose domain outcome is provable—to `completed`
with a refreshed 24-hour window when its command receipt committed, or to `released`
when no command receipt was written or a remote launch was fenced—while leaving
ambiguous or legacy uncorrelated rows `unknown`. Only completed keys expire, after
24 hours.

Every other write records an `idempotencyReason` in the registry instead, and
[idempotency.test.ts](../../packages/contracts/src/agentSurface/idempotency.test.ts)
fails a write that has neither. A keyed write's reconcile read must be a
registered read, host-routable when the write is. Writes that deduplicate in
their own domain keep that store on purpose and declare `idempotency: "domain"`,
so `goat_call` treats a transient failure of a call that carried the key as
safe to repeat. Thread send, interrupt, retry and update, thread create-many,
task create and review findings turn the key into a stable orchestration
command id: its receipt commits in the same transaction as the command, which
the separate reservation statement cannot, and lives longer than 24 hours.
Thread configure uses the same durable command id locally and within one
destination dispatch session. Goal
apply stores the key with the goal it creates, channel ingest uses it as the
message key in the channel ledger, and a secret request's key is how a later
call collects the answer. An origin report stores the key as a receipt with
its report row or the launcher's inbox entry, and derives a launcher wake's
command id from it, so the receipt outlives the origin acknowledging the
report. Moving these onto the reservation would add a second,
weaker record of the same request.

`keyIgnoredWith` names the arguments that take a call outside that store. A
routed thread write (`host`) forwards the key, but the destination keys its
receipt by this machine's dispatch session, which renews, so a routed repeat
can run again. `stopCascade: true` re-reads delegated children on every call,
and a goal update (`id`) ignores the key. Schedule create and task cancel keep
only a reason: the first upserts its row with the repeated arguments, the
second re-reads the child's tasks, so neither holds a repeat to one effect.

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
`ok`. For the operation kinds GOAT registers, `meta.operation` is then required and callers
learn completion only from it; for those kinds an `ok` without it means the work is done.
Long-running work in other domains does not carry a handle yet (see
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
| Provider sync          | `handoffId`, then `syncId` | `goat_provider_sync_read`     | `goat_provider_sync_cancel` | Approved syncs   |
| SSH prepare and update | host alias                 | `goat_ssh_host_status`        | `goat_ssh_host_forget`      | Yes              |
| Delegated task         | `taskId`                   | `goat_task_read`, wait mode   | `goat_task_cancel`          | Yes              |
| Thread or cloud launch | `threadId`                 | `goat_thread_status`, watches | `goat_thread_interrupt`     | Yes              |
| Cloud machine create   | machine id once it answers | `goat_cloud_machine_list`     | `goat_cloud_machine_stop`   | Partly           |
| Worktree cleanup       | none; blocks               | none                          | none                        | n/a              |

An approved provider sync records its start, its syncId and its final per-host
result in the approval handoff's continuation
([approvedSyncs.ts](../../apps/server/src/provider/approvedSyncs.ts)). The intent is
written before any work is registered, so after a restart a recorded start that no
longer runs settles as failed and is never started again. A sync a person or outside
client starts directly has no handoff and stays in memory.

**Now.** `operation.read`, `operation.wait`, and `operation.cancel` expose task, SSH setup,
provider sync, and approved provider change work through signed handles over their existing
stores ([operations.ts](../../apps/server/src/mcp/toolkits/agentSurface/operations.ts)).
The opaque handle names work but grants no authority: each verb runs the domain's access checks.
A handle that verifies but whose store has lost the record reads `unknown`; a handle that fails
verification returns `not_found`, while one past its retention period returns `expired`.
Cancel returns `not_cancellable` when that kind has no cancel path, and terminal reads carry the
work's own result envelope. The `operation.wait` timeout bounds even its status read and leaves
the work running.

**Proposed.** Extend operation handles to remaining long-running domains, including cloud
machine creation. Each domain keeps its own store and cancellation policy; a common handle
would let an agent observe work without learning a different polling contract for every domain.

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
The pull request merge and close tools require `pr.merge`.
Supervisors retaining `pr.merge` can access those tools; the retention decision is tracked in [#2194](https://github.com/goat-si/goat/issues/2194).
Every check that compares a role thread's grant with its caller's, such as the
recheck before an SSH launch and a send's target check and rebinding, derives it
with the same `roleProfile`; comparing against the caller's plain profile reads the
kept capability as a narrowing, refusing the launch or send or stripping it.
Creating and cloning a project are the one environment write a calling thread at
`auto` may run, because worker agents run at `auto` at most. When goatclaw governs
the thread its profile decides, full access included, before and again after
admission: it must allow `worktree.create` and leave the thread at `auto` or above
after its runtime ceiling. Every other environment write still needs full access.
With goatclaw on, the served handle refuses a GOAT thread whose effective profile
lacks the declared capability, before arguments decode, so `goat_call` and anything
else that calls through the server inherit the check
([McpToolAccess.ts](../../apps/server/src/mcp/McpToolAccess.ts)
`requireDeclaredCapability`). Outside MCP clients are not gated per tool: other GOAT
hosts call writes on each other as outside clients, so their approved access level
and scopes bound them, and the launch, goal and hub handlers still apply the default
profile to them.

An entry's `operation` names the kind its accepted work becomes, and `goat_call`
returns that work's handle in `meta.operation`.

**Proposed.** Add the `idempotency` and `pagination` fields, and run each entry's
examples as tests.

## Discovery: `goat_describe`

**Now.** `tools/list` gives the agents GOAT runs the core listing by default: `goat_describe` and
`goat_call` (D21). An agent finds every other capability with `goat_describe` and runs it
through `goat_call`; each tool also stays callable by its own names. MCP clients, including
other GOAT hosts, keep the full listing (D22): a host's dispatch reads a remote's `tools/list` to
learn which launch arguments and memory tools it supports, and hosts on older versions have no
other way. An outside agent that does not need that sends `x-goat-tool-listing: core` on its
`/mcp` requests and is listed only the core tools; calls never read the header. A client's
`tools/list` result names the listing agents get in `_meta["goat/agentToolListing"]`, which is
how the D8 runner checks a core arm.

**Now.** `goat_describe` answers at the three depths, or for up to 10 `paths` at once, from the
[registry](../../packages/contracts/src/agentSurface/registry.ts), reading input and output
schemas from the tools this server actually serves, with `surfaceVersion` at the top.
`available` reports the refusals the server is sure of before a call: thread-only,
client-only, read-only client, not served, and for a GOAT thread the goatclaw capability its
effective profile lacks, judged as the call gate judges it. A profile that does not resolve
reports its reason on every write that needs a capability. What depends on the call's
arguments or the moment, such as a host allowlist and lanes left, is still judged
only when the call is made. At detail `full` it adds the worked `examples` a registry entry
declares; related paths are not in it yet. `query` returns up to 20 paths whose path,
summary, or description contains every word, best first, and `truncated` when more match;
with a resource as `path` it searches only that resource. See
[handlers](../../apps/server/src/mcp/toolkits/agentSurface/handlers.ts).

Provider-owned discovery narrows this further: GOAT changes Claude Code's `ENABLE_TOOL_SEARCH`
`auto` setting to `true`, while core tools carry `_meta["anthropic/alwaysLoad"]` so they stay
resident ([Claude adapter](../../apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts),
[listing](../../apps/server/src/mcp/toolListing.ts)). Codex can defer MCP tools when
`tool_search` is available; its code mode lacks that search, so GOAT keeps every core name in
turn context ([harness test](../../apps/server/src/mcp/harnessListing.test.ts)). Pi defers optional
tools only when its tool search exists, and keeps core tools active
([Pi extension](../../packages/provider-pi/src/server/mcpExtensionSource.ts)).
Codex also compacts an MCP input schema above 5,000 bytes, which the two launch tools exceed in
the full listing. The core listing avoids that: `goat_describe` returns their schemas whole as
result data. `context-budget.ts` names the tools over the limit.

**Now.** The D8 turns left after [#1065](https://github.com/goat-si/goat/pull/1065) come from
asking `goat_describe` before a first call, so the core listing carries the arguments of about 25
common paths. `goat_call`'s listed description ends with one line per path, such as
`(thread.read :threadId :host? ...)`, kept on its registry entry's `signatures`; a test renders each
line again from the schema the server serves, so a line cannot name an argument the path lacks or
omit a required key at a level it spells out. Deeper objects show as `{}` and lists as `[]`, with
their fields left to `goat_describe`; keys only `anyOf` branches declare show as optional ([signature.ts](../../packages/contracts/src/agentSurface/signature.ts),
[discovery test](../../apps/server/src/mcp/toolkits/agentSurface/discovery.test.ts)).
Search and resource entries carry the same `signature`, and a `goat_call` refused for an argument
the path does not take or cannot decode returns it as `details.expectedSignature`.

**Now.** `goat_describe { host }` asks that machine's own `goat_describe` through the same
authenticated host read as `thread.read`, behind the same host-reaching gate. The host answers for
the session this caller gets there, which carries no thread or profile, so this machine then
refuses each path it would not carry there for this caller: one it lacks or that takes no `host`
here, and for a write the interaction-mode, link-access and profile host checks a routed write
meets. `coverage.hostOlder` orders the two GOAT builds with `compareRuntimeBuilds`;
`surfaceVersion` is a hash and has no order. A host that predates reporting its build answers
`null`. See [hostDescribe](../../apps/server/src/mcp/toolkits/agentSurface/hostDescribe.ts).

**Now.** `tools/list` is filtered per caller around Effect's MCP core, which checks one
visibility predicate for both `tools/list` and `tools/call` and so cannot hide a tool that stays
callable ([toolListing.ts](../../apps/server/src/mcp/toolListing.ts)). Both listings hide what
`available.now` refuses for the caller, except that a profile that does not resolve hides
nothing, because a client keeps its listing for the session. The server setting
`agentToolListing` picks the listing of the agents GOAT runs: `full` (every other tool) or `core` (entries whose registry `listing` is `core`); core entries carry
`_meta["anthropic/alwaysLoad"]` in both, so harnesses that defer tools keep them resident. Every
tool stays callable by each of its names. The default is `core` (D21), `full` is the rollback for
a harness that regresses, and a change to the setting or to the goatclaw policy sends
`notifications/tools/list_changed`.
[context-budget.ts](../../scripts/agent-surface/context-budget.ts) measures what each harness
receives under the default listing and what an outside client that asks for core receives, and
`goat-ci` fails when a harness goes over 6 KiB of
instructions, 6 KiB of listing, 12 KiB for its first prompt, or 300 B on each later turn.

Known risk of the core default: an agent in a shell harness that does not find a tool in its
listing can work around it by calling `/mcp` from the shell, which prints its thread credential
into the transcript. Until [#1062](https://github.com/goat-si/goat/issues/1062) is fixed the core
listing makes that path more likely; `agentToolListing: "full"` avoids it for a harness that
shows it.

### Measured: D8

The paired campaign `cmvl7drv2` ([#1064](https://github.com/goat-si/goat/pull/1064)) ran 10 ABBA
pairs of full against core on each of 4 tasks, 80 runs one at a time, on Codex code mode with
`claude-opus-5-5`. Before each run the runner switched `agentToolListing` and read `tools/list`
back: every core run saw only `goat_describe` and `goat_call`, and every full run saw 147 tools.

| Task                       | Median model turns, full | Median model turns, core | Verdict                                           |
| -------------------------- | ------------------------ | ------------------------ | ------------------------------------------------- |
| read-control (single call) | 2–2                      | 2–5                      | fail: the control may rise by at most one turn    |
| wait-running               | 2–6                      | 2–8                      | fail                                              |
| fan-out-review             | 3–14                     | 3–13                     | fail: fewer than 10 clean successful runs per arm |
| launch-and-wait            | 3–5                      | 3–6.5                    | fail                                              |

No task's failure rate rose; only the upper end of the turn range did, since code mode batches
calls. The recorded failed calls show the cause: first calls in MCP-style argument shapes.
Agents called `goat_describe` with `name` 28 times and with `resource`, `verb` or `tool` 7
times, and called `goat_call` with `name` and `arguments`, `input`, `tool`, or `resource` and
`verb` 10 times. Each refusal named the right fields and the next call worked, so both meta
tools now accept those MCP-style shapes
([#1065](https://github.com/goat-si/goat/pull/1065)). A rerun of the campaign on top of that
change stopped at 50 of 80 runs without a verdict; its partial medians are close to the first
campaign's, and failed calls in core runs fell from 28 to 4. Two core runs were excluded because the agent worked around the
listing from the shell ([#1062](https://github.com/goat-si/goat/issues/1062)).

Two full-listing sets are kept as references and are not paired with anything: Codex code mode
(48 runs) and Claude on the MacBook Pro (rescored, original rows unchanged). The Claude arm of the
paired campaign has not run.

A third Claude reference, not paired: `claudeAgent` `claude-opus-4-8` with the full listing, on
`fan-out-review` only, had 10 of 10 clean successful runs, each answering in its fourth run after
three reviews, with median model turns of 7 to 9.5, a median of 5.5 tool calls, and a median wall
time of 55.3 s. Its rows are in `scripts/agent-surface/eval/results/261024-full-claude-mbp-fanout/`
([#1069](https://github.com/goat-si/goat/pull/1069)). The one recurring failed call was
`goat_provider_list` called with an `args` wrapper, refused with a message that named the legacy
tool name ([#1068](https://github.com/goat-si/goat/issues/1068)).

## Calling: `goat_call`

**Now.** `goat call <path> [json | -]` calls any capability from a terminal by sending one
`goat_call` to the origin's `/mcp` with the shell's credential (see
[The `goat` command](#the-goat-command)). `goat acp-mcp-call <tool> <json>`, the ACP terminal
fallback, is its alias and always prints the envelope.

**Now.** `goat_call` resolves a path, a canonical `goat_<resource>_<verb>` name, or a
legacy name, and runs the tool through the same registered handle `/mcp` serves
(`ToolDispatch`, built in `McpHttpServer`). Argument refusal, the tool's
`McpToolAccess` declaration, domain admission inside the handler, host routing, and
analytics therefore run as for a direct call. It adds no gate of its own and is declared
destructive, so a client that prompts before destructive tools still prompts before any
target reached through it. The checked-handler wrapper records the original typed error,
and `goat_call` uses it only to classify by a literal the envelope's table declares; the
message is always the text the direct call shows, so free-text reasons the direct path
scrubs never leave through it. A write the registry keys counts as deduplicated when it
carries a `clientRequestId`, and routed calls set `meta.host`.

**Now.** A direct `tools/call` by a legacy name runs the listed tool. The `/mcp` auth
middleware swaps the name for the listed one before Effect's MCP core sees the request,
because the core checks one visibility predicate for both `tools/list` and
`tools/call` and cannot hide a tool that stays callable. The call therefore gets the
listed tool's argument refusal, access checks, and result, plus
`_meta["goat/deprecated"]`. Analytics record every call under the shipped name the
toolkit registers, whichever name the caller used, so each tool keeps one series.

## Composition: `goat_eval`

**Now.** [evalRunner.ts](../../apps/server/src/mcp/toolkits/agentSurface/evalRunner.ts)
runs a small program of GOAT calls in one tool call and returns only what the program keeps.
`surface.eval` exposes it as `goat_eval`, with each step passed to `goat_call`'s own function
([handlers](../../apps/server/src/mcp/toolkits/agentSurface/handlers.ts)). It is for two cases that code-mode harnesses do not cover
(D8). In Claude Code, ACP agents, Pi and Cursor, a call whose arguments depend on an earlier
result costs another model turn, and every intermediate result lands in the transcript;
independent calls can share one response, so the turn saving is a hypothesis the
[composition campaign](../operations/agent-surface-eval.md#composition-campaigns) tests. Separately,
only the server can drop fields before they cross the wire, which that campaign measures in
result bytes.

A program is an S-expression, as text or as the same tree in JSON arrays:

```lisp
(let ((ts (thread.list :statuses ["running"] :limit 3)))
  (map t (. ts "threads") (pick (thread.read :threadId (. t "threadId")) "title" "status")))
```

The forms are `let`, `.`/`get`, `pick`, `map`, `filter`, `if`, `eq`, `not`, `seq`,
`quote`, `try`, and a call by path. The grammar and each form's meaning live with the contract in
[eval.ts](../../packages/contracts/src/agentSurface/eval.ts). There is no recursion, no user
function, and no way to call `goat_call` or `goat_eval`. Limits are fixed: 16 KiB of program,
depth 8, 32 calls, 16 elements per `map`, 256 KiB of step results, and 120 s. A program whose
call sites alone exceed 32 is refused before anything runs. `dryRun` returns only `{plan}`.

Every call takes the path `goat_call` takes (D6, D7), one at a time, so argument refusal, the
goatclaw gate, host routing, keyed admission and operation handles behave as for a direct call.
An `ok` result evaluates to its value; every result, halted ones included, lists the
`meta.operation` handles its steps returned, so unwrapping never hides running work (D1). An
`error` stops the program unless `try` wraps the call. `needs_human` and `unknown_outcome`
stop it even inside `try`.

### Replay safety

Replay by call index was rejected because after a fresh read the third call may name a
different target, and an index-keyed receipt would answer it with another call's result. The
journal keys a step by its place in the program instead. A run has an `evalRunId`, derived from
the caller and its `clientRequestId` when one is given. A call's coordinate is its position in
the parsed program; inside `map` it adds the element's index and the first 12 hex digits of the
element's digest. Every keyed write gets
`clientRequestId = "eval:" + sha256(evalRunId \0 stepCoord \0 path \0 argumentsDigest)[0:48]`, so
ToolAdmission deduplicates it like any keyed write and changed arguments get a different key. A
program may not pass its own `clientRequestId` to a call, so each key is first used by its
step.
`mcp_eval_runs` holds the run and its program; `mcp_eval_steps` holds each step's outcome by
`(eval_run_id, step_coord)` and the grant that call ran under, computed from its arguments as
ToolAdmission computes it (a role launch's role profile and a forwarded ceiling included) and
recorded before it runs.

A retry with the same `clientRequestId`, or `resume` with an `evalRunId`, continues the run:

- Only the caller that started a run sees it, and only with the same program and bindings
  (`conflict`, `eval_program_changed` otherwise). A stored step is returned only while the
  caller holds the grant that step ran under, recomputed for the same arguments and checked as
  ToolAdmission checks a replay, with a client's scopes reauthorized live; a caller that lost it
  gets `permission_denied`. A completed run is answered by evaluating the program again from the
  journal, so every step passes that check.
- Every outcome the program's control flow saw is journaled, refusals caught by `try` included,
  and replays as recorded, so a resumed run takes the same branches. A write whose failure does
  not prove what happened (ToolAdmission would settle it unknown, as for `host_unavailable`)
  stops the run with `unknown_outcome` even inside `try`. Only a failure that stopped the program
  and proves nothing ran is dropped, so resume tries it again. A step whose arguments no longer
  match its record is `conflict` (`eval_step_changed`).
- A read that started and never finished runs again. A keyed write that did is never sent
  again: its outcome is read from ToolAdmission's reservation for its derived key, under the
  same grant check. No reservation within 24 hours of the step proves nothing ran, because its
  key was first used there and only completed reservations expire, so the step runs. Every
  other case, and any other write that started, stops the run with `unknown_outcome` naming the
  read that settles it.
- `needs_human` ends the run. The person's action finishes that step through the handoff's own
  continuation, and calling the step again could start a second flow or apply a change twice.
  Resume returns the handoff's state: the same `needs_human` while it is pending, its settled
  read after. Remaining work goes in a new program.
- A run that hits its time limit while a write is in flight stops with `unknown_outcome`;
  otherwise with `timeout`.

A halted run answers `{status, evalRunId, haltedAt, completedSteps, operations}` with its
`error` or `handoff`. Completed runs expire after 24 hours. Halted runs expire after 7 days
unless a step's outcome is unknown; those stay, as unknown reservations do.

**Rollout.** `goat_eval` starts opt-in: the default core listing does not change. The
`agentToolListing` value `core_eval` lists it beside the core tools, loaded up front, for the
composition campaign and for users who want it; `full` lists it like any other tool. Whether it joins the
core listing is decided by that campaign and lands as its own change.

## Screen composition: `goat_screen_run`

**Now on this branch.** `surface.screen_run` exposes `goat_screen_run` for a
bounded JavaScript cell over GOAT-owned browser and desktop Targets. It is listed
only to a thread caller whose turn has the built-in browser or computer use
attached; otherwise `goat_describe` reports it unavailable with that reason
([toolAvailability.ts](../../apps/server/src/mcp/toolAvailability.ts)). The same
gate activates the built-in `screen-code` guide, which the server writes to
`<stateDir>/skills/screen-code/SKILL.md` when it attaches. Every harness's runtime
instructions name that path, so an agent reads the signature from disk on demand
instead of carrying it in each prompt. The
service, rather than the MCP handler, owns the turn session, per-effect admission,
limits and receipts. The guest cannot call arbitrary `goat_call` paths or use Node.
Browser-only turns can use browser Targets; desktop Targets require the computer-use
attachment and lease. Each effect uses the direct tool's authority boundary.
See [screen code mode](computer-use.md#screen-code-mode).

### Post-ship regression measurement

A paired screen-task campaign measures `goat_screen_run` after integration; it is
not a build or release gate. The existing
[agent-surface runner](../operations/agent-surface-eval.md) uses provider and
orchestration tasks, so its rows do not measure screen interaction.

For each fixed browser/desktop task, record an answer oracle and what would
falsify the claimed gain. Compare available direct preview/computer-use calls
with `goat_screen_run` on the same provider, model and seeded environment.
Alternate arms ABBA, retain raw rows, exclude contaminated runs, and count
failed calls and wrong outcomes rather than discarding them. Report model turns
as a range where exact request counts are unavailable, transcript bytes and
failed runs. A smaller turn count cannot excuse an admission, Stop, private-mode
or receipt regression. Investigate a paired task that loses its oracle, crosses
a safety boundary or meaningfully worsens turns or bytes.

## Settings

**Now.** Every server setting is reachable through two paths instead of a tool each, the
shape Codex's app server uses for its config (`config/read`, `config/value/write`).
`environment.settings_read` lists every `ServerSettingsPatch` key with its access, the
value for keys agents may change, and, for keys asked for by name, the value's JSON schema.
`environment.settings_update` takes `{patch}` with the values the Settings page would send,
decodes it with the same `ServerSettingsPatch` schema, and writes it through
`ServerSettingsService.updateSettings` in one commit. A refused key, or a value that does not
decode, changes nothing.

[settingsAccess.ts](../../packages/contracts/src/agentSurface/settingsAccess.ts) gives every
key one access:

- `agent`: the generic path changes it.
- `path`: a dedicated path owns it because its write does more than store a value, such as
  `provider.update` for provider instances. The refusal names that path.
- `person`: only a person changes it, and the refusal says why. These are credentials,
  grants that widen what agents may do (browser, device, memory or computer-use access,
  runtime-mode defaults, goatclaw), links to other machines, and addresses that send data
  out.

`projectSettingsOverrides` is `person` because an entry replaces a project's whole override
set, so a partial or null entry would drop runtime-mode, agent-access and provider overrides.
Agents still reach the per-field legacy keys (`projectScriptOverrides`,
`projectAutoPullOverrides`), which change one field of the stored entry. Client settings
(fonts, notifications, sidebar layout) live on each device and are out of scope.

A thread calls the update under the same rules as `environment.preferences_update`: live
full-access/default caller, the `settings.write` goatclaw capability, and the thread lock
with a recheck. An outside client needs a live `settings:write` grant, checked at admission
and again inside the settings write lock. No `agent` key needs `providers:manage`.

The rule is that settings never grow the MCP surface. Three tests hold it:
[settingsAccess.test.ts](../../packages/contracts/src/agentSurface/settingsAccess.test.ts)
fails on an unclassified key (the type does too), on an `agent` key whose schema holds a
credential, and on a registry path that declares `settings.write` without a reviewed reason in
`SETTINGS_WRITE_EXCEPTIONS`, and it keeps every settings path out of the core listing.
[settingsWriters.test.ts](../../apps/server/src/mcp/toolkits/environment/settingsWriters.test.ts)
pins every server file that writes settings directly, whatever capability its tool declares.
A new tool that reuses an already listed writer passes both; reviewers reject it by the rule
in AGENTS.md.

## Human steps

**Now.** One durable [Handoff](../../packages/contracts/src/handoff.ts) record
exists. Its `kind` is the modality (`oauth`, `device_code`, `terminal`, `secret`,
`approval`, `mfa`), and its `target.path` is what the person is deciding
(`ssh.host_add`, `provider.setup`, `computer_use.grant`). Human instructions and
continuation arguments are stored apart, encrypted, and returned only over
authenticated client RPC. Agents get `HandoffSummary`.

Around it, a human step reaches an agent in several shapes:

| Flow                         | Agent sees                                                                       | Who resolves                             | What continues                                                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSH trust, key, update       | `needs_human` with `next.call`                                                   | person with environment scopes           | server continues prepare and update; trust only pins                                                                                                             |
| Provider sync                | `needs_human` with `next.call`                                                   | person with `providers:manage`           | server runs the sync under the approver's session                                                                                                                |
| Provider setup, Codex home   | `needs_human` with `next.call`                                                   | person with `providers:manage`           | person finishes in the app; agent calls again                                                                                                                    |
| Computer use                 | `needs_human` beside `available` and `refused`                                   | person with settings authority           | the call waits for the answer when its turn has the tools; otherwise they attach next turn                                                                       |
| Screen step                  | `needs_human` with `next.call`                                                   | person at the agent's tab or desktop     | the tab or desktop stays held until Hand back, Stop or a thread answer; GOAT wakes the agent                                                                     |
| Sign-in by a managing client | `{kind: "flow"}` with `continueIn`                                               | the session that started it              | a server fiber, in memory                                                                                                                                        |
| Secrets                      | a blocking result with `secretRef`                                               | person in the thread                     | agent uses the ref in a later call                                                                                                                               |
| Runtime approvals, questions | a pending request by `requestId`                                                 | person, or an outside approver client    | the provider run                                                                                                                                                 |
| Decisions                    | `DecisionItem` by id                                                             | agent or person, per item                | answer delivered as a thread message                                                                                                                             |
| Cloud launch consent         | `needs_human` from a thread; outside one, a refusal naming a decision GOAT filed | person approving the handoff or decision | agent calls launch again with the same arguments and `handoffId` or `decisionId`; the approval binds a digest of the launch and its holder and starts one launch |

`delegate_task` and `goat_thread_launch` onto a cloud provider have no consent handoff and
take no `decisionId`: they refuse a turn a person did not start and point to
`goat_cloud_launch` on the machine that holds the account, since it does not take a remote
holder while goatclaw is on.

**Now.** Guest links, webhook token rotation, cloud machine credentials and removal, Slack and
channel identity links, hub child automatic setup, provider sign-out and ChatGPT profile import
stay a person's, with no agent path and no handoff
([#2062](https://github.com/goat-si/goat/issues/2062)). Each creates or revokes a secret, sets
who outside can reach the environment, or records a person's standing consent. These are
deliberate setup a person does rarely, and a handoff would let an agent decide when to ask a
person to widen or cut access it works under, so the nearest tool's guide names the step as a
person's instead. An agent never approves its own consent. A provider sign-out prompt runs only
when a person wrote the message and no schedule delivered it, and an agent cannot turn a
person's queued message into a slash command, because an edit keeps the author
(`ProviderAuthService.tryHandlePromptCommand`, `goat_queue_edit`). A person's own `/logout` runs whenever
its run starts, whether the queue advances or an agent starts, resumes or retries it: the
command and its consent are the person's, and only who wrote it and what it says are guarded.
For webhooks the person's step is the Rotate action in Settings, which replaces a live task's
URL on purpose; an agent that moves a schedule it may write off its webhook trigger, or deletes
it, ends that URL as part of the write, and a later webhook trigger gets a new URL.

When a handoff resolves or expires, GOAT wakes the thread that asked with a
queued message naming the next call
([HandoffWakeReactor.ts](../../apps/server/src/handoffs/HandoffWakeReactor.ts)).
Who may resolve a step is one predicate
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
and a send that carries one never falls back to the relay, which would deliver
without it. A destination that has not yet confirmed it enforces ceilings still
gets the launch or send, and the result's `ceiling` field says so; a launch to a
destination that cannot accept a ceiling at all is still refused. Remote
servers built before canonical names answer only to the tool names they shipped with
([ADR-0007](../../structure/decisions/ADR-0007-mcp-tool-names.md)), so the origin sends a
host-routed call under its canonical name only to a remote whose `serverVersion` is past
0.1.2, and under the shipped name otherwise, which every version accepts; the steps a
remote launch runs inside the dispatcher keep shipped names
([remoteToolNames.ts](../../apps/server/src/sshRemote/remoteToolNames.ts)). A remote that
has no such tool answers `failed_precondition` with reason `remote_outdated`, and the
call never runs locally instead.
The origin checks the calling thread's capability before forwarding, plus
`threads.remote` and the profile's host allowlist for every machine a write names:
`host` on a host-routable entry, and each argument listed for it in
[`agentSurface/hosts.ts`](../../packages/contracts/src/agentSurface/hosts.ts) (`targetHost`, `destinationHost`, or a `host` that is not routing,
as on cordon or SSH setup). This holds for writes that declare no capability of
their own, such as `thread.watch`. A `host` that names something else, such as a
git forge or the address of a machine being added, is not listed; a test pins
which arguments are. A write that lets placement pick the machine, such as
`thread.reschedule` without `targetHost`, picks only among the allowlist.
A thread launched or sent with a forwarded ceiling is bound to it on the
destination, so its own calls there are checked against it. Other host-routed writes
arrive as the origin's dispatch session, and the destination relies on the origin's
check.

**Proposed.**

- Forwarding stays with the origin server. A meta tool, the CLI, or a composed
  step names a `host`, and the origin's router builds the ceiling, claims the
  lane, and picks the tool name the remote answers to.
- `meta.host` says where a call ran. Remote errors keep their `reason` and gain
  `details.host`.

## Audit

**Now.** Each MCP call records one anonymous `mcp.tool.invoked` analytics event
with no ids or text. Orchestration receipts record commands. The decision inbox
keeps an append-only audit of actor, profile, action, target, and outcome, and
handoff transitions are events with actors. A keyed write's reservation records
principal, profile id, ceiling, host, path, argument digest, receipt id, and
outcome.

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
`goat_describe` and the generated `--help` read the same registry, so the running server is
the reference. Per-resource reference pages are not committed to the repository: the
[documentation rules](../../AGENTS.md#documentation) allow one catalog, which the registry
already is.

**Now.** An entry's `parameters` describe arguments its input schema leaves bare, and the
served schema shows them. Descriptions annotated on the decoded side of a transformation, such
as any `TrimmedNonEmptyString` field, are copied to the advertised schema too, since JSON Schema
shows only the encoded side ([servedDescriptions.ts](../../apps/server/src/mcp/servedDescriptions.ts)).
[discovery.test.ts](../../apps/server/src/mcp/toolkits/agentSurface/discovery.test.ts) fails
when a path `goat_call` lists, or any path with examples, has an undescribed argument, a
note the schema already covers, or an example its tool does not decode.

**Proposed.** `/llms.txt` is also filtered by the caller's permission profile. CI fails when
an entry's effect disagrees with its access declaration or when an example's call fails
against the toolkit test harness. The rest of the
hand-written tool prose in `orchestrator-mcp-server.md` moves to lifecycle and policy.

### User guides

**Now.** Questions about GOAT itself (how a feature works, how to set something up, what an
error means) are answered from the user guides in `docs/user`, the same pages the website
publishes. `docs.search` ranks their sections by the query's words and `docs.read` returns a
page or one section, at most 24,000 characters per call with `nextCursor` to continue
([UserDocs.ts](../../apps/server/src/userDocs/UserDocs.ts)). The pack build inlines the guides
into the server bundle (`__GOAT_USER_DOCS__` in
[vite.config.ts](../../apps/server/vite.config.ts)), so npm, desktop and the standalone
executable answer from the build they run without a docs directory; source runs read the
repository's files. Anchors come from `github-slugger`, which the site also uses, so a cited
`url` opens the right heading. That page shows the latest published guide, so results also
carry the build that served them, and the `goat-docs` built-in skill
([goatDocs.ts](../../packages/provider-core/src/server/builtinSkills/goatDocs.ts)) tells agents
to cite the guide, section and build. One always-injected line routes agents there without the
skill being named. Neither path is in the core listing.

## The `goat` command

**Now.** The desktop app writes a launcher to `<GOAT home>/bin/goat` (`goat.cmd`
on Windows) at start and rewrites it on update
([DesktopCliShim.ts](../../apps/desktop/src/app/DesktopCliShim.ts)). Nightly writes
`<GOAT home>/bin/nightly/goat` instead: both channels share the GOAT home, and the
launcher is each thread's `GOAT_CLI_PATH`, so one shared file would hand every thread
whichever app started last. **Settings →
General → About → Install** links it into the first writable folder among
`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, and `~/bin` on macOS
(`~/.local/bin` and `~/bin` on Linux), or adds its folder to the user `PATH` on
Windows ([DesktopCliCommand.ts](../../apps/desktop/src/app/DesktopCliCommand.ts);
[install guide](../user/install.md#the-goat-command)). Bare `goat` runs the
server; the subcommands are operator tools.

**Now.** `goat describe`, `goat call`, and a `goat <resource> <verb>` command for every
registry path run before the operator CLI loads
([agentSurfaceCommand.ts](../../apps/server/src/cli/agentSurfaceCommand.ts)). Each sends one
`goat_call` to the origin's `/mcp`, so a call through the CLI gets the same argument refusal,
access checks, goatclaw gate, and host routing as a direct one; `--host` is only the call's
`host` argument. Arguments are a JSON object (or `-` for stdin) plus `gh api`-style fields:
`-f key=value` sets a string, and `-F key=value` turns `true`, `false`, `null`, and integers
into JSON and reads `@file`. The operator verbs `thread list|start|send|show`, `project
add|remove|rename`, and `provider diagnose` keep their meaning, and their help lists the
registry verbs beside them. Exit codes are `0` for success, `1` for error, `2` for usage,
`3` for a human step, `4` for a retryable error, and `5` for an unknown outcome.
`goat operation wait` also exits `6` when work remains queued or running after its timeout.
When no envelope came back, a
failure before `goat_call` was sent exits `4` only when the server could not be reached or
answered the handshake with HTTP 429 or 5xx, and `1` for any other handshake refusal; after it
was sent, a lost answer exits `4` for a read and `5` for a write. A refused credential (401, 403,
or `/mcp`'s in-band refusal) exits `1` and never falls back to another credential. `acp-mcp-call`
resolves credentials like `goat call`, so outside a thread it uses the `goat login` session.
`goat operation read|wait|cancel <id>` are the generated commands for the operation verbs, and
`wait` exits by the operation's state as the table above says. Credentials resolve as below, and `goat login`, `logout`, and `whoami` manage the
stored one.

The npm package keeps its `goat` and `t3` bins, and bare `goat` keeps starting a
server. Use `goat serve` for GOAT; `npx t3` launches upstream T3 Code. The desktop launcher marks itself so that
bare `goat` from it prints help instead of starting a second server. Linux
packages gain `/usr/bin/goat`, and the welcome wizard offers the install once.

### Credentials

The CLI resolves a credential for the origin server only:

1. `GOAT_ACP_MCP_ENDPOINT` and `GOAT_ACP_MCP_AUTHORIZATION`, which GOAT sets for
   Claude Code, ACP (including Grok and Antigravity), Muse and Pi agent
   processes, Codex thread shell environments, and GOAT thread terminals, so `goat` uses the same credential as
   that thread's MCP connection. A terminal started before a credential exists
   gets empty markers; restart it after the provider attaches. A revoked credential
   stays invalid in existing shells. When the variables are present and invalid, the CLI fails; it never falls
   back to a stored login, which could carry more authority.
2. A session from `goat login`, which pairs with the local server and must yield an
   `mcp-client` credential, the only outside subject `/mcp` accepts
   ([EnvironmentAuth.ts](../../apps/server/src/auth/EnvironmentAuth.ts)).

Cursor's local SDK exposes no per-agent process environment, and OpenCode's local
server shares one process across threads; their native shells do not receive a
thread credential. External OpenCode servers and cloud agents do not have a
supported route to the origin's thread MCP credential. Their GOAT thread terminals
use the destination environment's credential like other providers.

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
  `goat_call` attaches a `provider_sync` operation handle to accepted work, and
  [HandoffWakeReactor](../../apps/server/src/handoffs/HandoffWakeReactor.ts) wakes the
  requesting thread when the approval's continuation settles.
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

**Proposed.** Replace this flow's per-call `next.call` hints with its operation handle as
the single follow-up instruction.

## Rollout

Each PR shipped on its own and left `tools/list` unchanged until the flip (row 10).

| #   | Ships                                                                         | State                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Registry and parity test                                                      | Shipped ([#211](https://github.com/goat-si/goat/pull/211))                                                                                                                                                                |
| 2   | Handoff record, cards, SSH continuations                                      | Shipped ([#212](https://github.com/goat-si/goat/pull/212))                                                                                                                                                                |
| 3   | Provider diagnose, setup, login, sync                                         | Shipped ([#210](https://github.com/goat-si/goat/pull/210), [#540](https://github.com/goat-si/goat/pull/540)); settings in [#774](https://github.com/goat-si/goat/pull/774)                                                |
| 4   | Envelope schema; handlers keep domain reasons; exhaustive classification test | Started: envelope shipped in [#773](https://github.com/goat-si/goat/pull/773); classification remains partial                                                                                                             |
| 5   | One invocation function, `goat_call`, `goat_describe`                         | Shipped ([#785](https://github.com/goat-si/goat/pull/785))                                                                                                                                                                |
| 6   | Idempotency receipts with digest, unknown state, audit columns                | Shipped ([#939](https://github.com/goat-si/goat/pull/939), [#1121](https://github.com/goat-si/goat/pull/1121), [#2071](https://github.com/goat-si/goat/pull/2071); per-domain settlement on reconcile reads)              |
| 7   | Operations over existing stores; durable provider sync                        | Started: task and SSH operations shipped in [#920](https://github.com/goat-si/goat/pull/920), provider sync and approved provider changes in [#925](https://github.com/goat-si/goat/pull/925); other domains remain       |
| 8   | Human steps return `needs_human`; cloud consent handoff; wake; one predicate  | Proposed                                                                                                                                                                                                                  |
| 9   | Registry-generated CLI commands and credentials                               | Shipped: credentials ([#935](https://github.com/goat-si/goat/pull/935)); generated commands ([#938](https://github.com/goat-si/goat/pull/938))                                                                            |
| 10  | Listing flip, verb normalization, remote name translation                     | Shipped: aliases ([#906](https://github.com/goat-si/goat/pull/906)); core listing mode ([#1026](https://github.com/goat-si/goat/pull/1026)); core by default with a CI budget (D21); normalization and translation (#781) |
| 11  | `goat_screen_run`                                                             | Implemented on this branch; runtime proof pending                                                                                                                                                                         |
| 12  | `goat_eval` runner and step journal; opt-in mount                             | Runner, journal and contract; mounted as `goat_eval` behind the `core_eval` listing; campaign not run                                                                                                                     |

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
| [Cloudflare Code Mode](https://blog.cloudflare.com/code-mode/), [Anthropic](https://www.anthropic.com/engineering/code-execution-with-mcp) | Models compose tools better in code; tool search with detail levels saves most of the context                                  | Screen-specific code mode; `query`         |
| [R7RS Scheme](https://small.r7rs.org/)                                                                                                     | A few special forms suffice when the host supplies primitives                                                                  | The eval forms                             |
| [Restate](https://docs.restate.dev/services/versioning), [DBOS](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial)              | A journaled step returns its recorded result on replay; a replay that yields a different step fails                            | Program and step checks                    |
| [JSON-e](https://json-e.js.org/language.html)                                                                                              | A JSON template language stays safe with fixed operators and no evaluation of computed code                                    | The eval forms; JSON programs              |

### Lessons from aside-codemode

aside-codemode is a code-mode tool for a signed-in browser and a local filesystem
([lidge-jun/aside-codemode](https://github.com/lidge-jun/aside-codemode) at `b395d89`). It already
ran into most of the problems this design addresses. What GOAT takes from it, and what it avoids:

| Take or avoid | What                                                                                                                                                                                           | Source                                                                                                                                                                                                                   | Here                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Take          | If the implementation skipped, capped, or could not apply something requested, the result must not report full success. A cap is honest only if the reader asked for `max + 1`.                | [result-completeness.md](https://github.com/lidge-jun/aside-codemode/blob/b395d89/structure/result-completeness.md)                                                                                                      | [Paging](#paging), D16                                    |
| Take          | Counts are tied to the verdict: a run is never complete while a requested item is missing, every requested item gets an answer even after a stop, and results are matched by id, not position. | [batch-contract.md](https://github.com/lidge-jun/aside-codemode/blob/b395d89/structure/batch-contract.md)                                                                                                                | Screen receipt discipline                                 |
| Take          | An effect that started and was never confirmed is its own state, neither success nor failure, and is never retried.                                                                            | [batch-contract.md](https://github.com/lidge-jun/aside-codemode/blob/b395d89/structure/batch-contract.md)                                                                                                                | `unknown_outcome`                                         |
| Take          | "A person can clear this" is a claim that has to be earned. A block that does not prove it stays a failure, and only a proven one becomes `needs_input`.                                       | [batch-contract.md](https://github.com/lidge-jun/aside-codemode/blob/b395d89/structure/batch-contract.md), [session-contract.md](https://github.com/lidge-jun/aside-codemode/blob/b395d89/structure/session-contract.md) | `needs_human` requires a handoff (D17)                    |
| Take          | Approval ids are not run ids. Approvals are consumed once by an atomic claim, and a claim whose run never recorded an id is reported as unknown.                                               | [ADR-0007](https://github.com/lidge-jun/aside-codemode/blob/b395d89/structure/decisions/ADR-0007-approval-ids-are-not-run-ids.md)                                                                                        | handoff ids, operations                                   |
| Take          | "What counts as a write" is one list, the effect ledger. Two hand-kept lists drifted twice before that.                                                                                        | [ADR-0006](https://github.com/lidge-jun/aside-codemode/blob/b395d89/structure/decisions/ADR-0006-the-write-gate-uses-the-effect-ledger.md)                                                                               | effect from `McpToolAccess` only                          |
| Take          | One resident tool (2.4 KB) with on-demand descriptions instead of 34 described actions (44 KB, paid every turn).                                                                               | [BENCHMARKS.md](https://github.com/lidge-jun/aside-codemode/blob/b395d89/BENCHMARKS.md#tool-schema)                                                                                                                      | `goat_describe`, `core` profile                           |
| Take          | Always-on instructions carry only what no refusal can teach, such as "a successful but incomplete result is not an answer"; everything an error can correct belongs to the error.              | [ADR-0011](https://github.com/lidge-jun/aside-codemode/blob/b395d89/structure/decisions/ADR-0011-the-block-carries-what-an-error-cannot-say.md)                                                                          | provider instructions after the flip                      |
| Avoid         | Guessing state from wording. A signed-in heuristic was wrong both ways, and its false pass was the failure the layer existed to stop.                                                          | [ADR-0003](https://github.com/lidge-jun/aside-codemode/blob/b395d89/structure/decisions/ADR-0003-session-proof-comes-from-the-caller.md)                                                                                 | plain-text failures stay `internal`                       |
| Avoid         | Deciding by name lists: metadata crossed the wire by action name, so a newly added action arrived bare.                                                                                        | [result-completeness.md](https://github.com/lidge-jun/aside-codemode/blob/b395d89/structure/result-completeness.md)                                                                                                      | registry-derived checks; exhaustive literal table         |
| Avoid         | Loss reported only inside text, such as a `[truncated: …]` suffix that a caller checking fields cannot see.                                                                                    | [result-completeness.md](https://github.com/lidge-jun/aside-codemode/blob/b395d89/structure/result-completeness.md)                                                                                                      | loss lives in fields                                      |
| Avoid         | A status in the vocabulary that nothing emits. `needs_input` was documented to agents for weeks before any code produced it.                                                                   | [batch-contract.md](https://github.com/lidge-jun/aside-codemode/blob/b395d89/structure/batch-contract.md)                                                                                                                | operation states ship with their producers                |
| Avoid         | "Complete" read as "absent": a default search returned 8 of 15 known matches and still said complete.                                                                                          | [BENCHMARKS.md](https://github.com/lidge-jun/aside-codemode/blob/b395d89/BENCHMARKS.md), [issue #41](https://github.com/lidge-jun/aside-codemode/issues/41)                                                              | completeness never claims absence                         |
| Avoid         | Measuring the harness, not the product: CLI numbers carried 60–70 ms of process start that the resident server never pays, and a single grep was the wrong unit of work.                       | [PROTOCOL.md](https://github.com/lidge-jun/aside-codemode/blob/b395d89/evidence/bench-260918/PROTOCOL.md)                                                                                                                | [measurement protocol](#post-ship-regression-measurement) |

Its session contract also applies by analogy. Steps that share a signed-in session are not
independent, so a batch over them can turn one expired session into many false successes.
Steps in a GOAT program share credentials, lanes, and thread state the same way, which is why
every gate runs per step (D7).

## Decision log

| #   | Decision                                                                                                                                                                           | Why                                                                                                                                                                                                                                                                                                                                                         | Rejected                                                                                                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| D1  | Three statuses; unfinished work is `ok` with a required `meta.operation`                                                                                                           | Accepting work succeeded; a fourth status splits every caller's branch; a required handle keeps "accepted" from reading as "done"                                                                                                                                                                                                                           | A `running` status                                                                                                  |
| D2  | Add `resource_exhausted`, `failed_precondition`, `unknown_outcome`; compute `retryable` per call; keep reasons in handlers                                                         | The surface already produces these; per-code retry flags would retry launches that may have started; a classifier cannot recover collapsed codes                                                                                                                                                                                                            | Folding them into `unavailable` and `conflict`                                                                      |
| D3  | `clientRequestId` reserves atomically with an argument digest; unrecorded outcomes stay `unknown`                                                                                  | Replaying a stored result for other arguments corrupts silently; redispatch after a crash duplicates side effects                                                                                                                                                                                                                                           | "Same id returns the first result"                                                                                  |
| D4  | Opaque cursors; fan-out lists that cannot continue say `truncated`                                                                                                                 | One shape; no false continuation                                                                                                                                                                                                                                                                                                                            | Numeric offsets everywhere                                                                                          |
| D5  | `operation.*` over existing stores with signed handles                                                                                                                             | Smallest change giving one handle; a signature separates "issued but lost" from "never issued"                                                                                                                                                                                                                                                              | A new operations table first                                                                                        |
| D6  | One invocation function for direct calls, `goat_call`, the CLI, and composition                                                                                                    | Equivalence by construction; `readsAsCaller` would refuse outside clients                                                                                                                                                                                                                                                                                   | Meta tools with their own access class                                                                              |
| D7  | Gates apply per step; composition holds no lane or grant                                                                                                                           | Lanes and ceilings are claimed by the work they bound                                                                                                                                                                                                                                                                                                       | Pre-admitting a whole program                                                                                       |
| D8  | `goat_eval` is built opt-in: an S-expression runner over `goat_call`'s path whose steps are journaled by program position; it joins core only if its campaign passes               | Without code mode, each dependent call costs a model turn and copies its result into the transcript, and only the server can drop fields before they cross the wire. A step keyed by program position, element digest and argument digest cannot reuse another call's receipt, the reason replay by call index was rejected                                 | Replay by call index; general JavaScript cells over `goat_call`; core before measurement                            |
| D9  | Handoffs own continuations, the inbox owns decisions; all human steps return `needs_human`; one resolver predicate; wake on resolve                                                | Nine contracts today; the two approval paths disagree; agents parse prose to learn a person must act                                                                                                                                                                                                                                                        | A third store; leaving the paths inconsistent                                                                       |
| D10 | `goat_describe` adds `query`, `surfaceVersion`, `host`, and availability per caller                                                                                                | Progressive discovery; cache safety; remotes differ                                                                                                                                                                                                                                                                                                         | Loading every schema                                                                                                |
| D11 | `read` and `cancel` are standard verbs; synonyms normalize at the flip                                                                                                             | `get` and `read` both exist today                                                                                                                                                                                                                                                                                                                           | Renaming now                                                                                                        |
| D12 | The CLI authenticates to the origin only and fails closed; `--host` is routing                                                                                                     | Ceiling forwarding and lane admission happen at the origin                                                                                                                                                                                                                                                                                                  | Local credentials for remotes                                                                                       |
| D13 | Write receipts double as the audit; spans and `traceparent` across hosts                                                                                                           | One record answers who, under which grant, and where                                                                                                                                                                                                                                                                                                        | Ids in analytics                                                                                                    |
| D14 | Served reference (describe, `/llms.txt`, `--help`) instead of committed pages                                                                                                      | The registry is the catalog; committed pages would be a second one                                                                                                                                                                                                                                                                                          | `docs/reference/` pages                                                                                             |
| D15 | Stay independent of MCP versions; `operation` can map to MCP tasks and `needs_human` to `input_required` later                                                                     | MCP removed sessions and moved tasks in 2026-07-28; tracking each revision would churn the surface                                                                                                                                                                                                                                                          | Adopting the tasks extension now                                                                                    |
| D16 | Every list and fan-out discloses loss in fields: read `limit + 1` before claiming more exists, and never report a request as complete when part of it was skipped                  | aside-codemode shipped the same silent-loss bug six times before writing the invariant                                                                                                                                                                                                                                                                      | Loss text inside values                                                                                             |
| D17 | `needs_human` only with a handoff a person can act on; a block nobody can clear stays `error`                                                                                      | A human status that does not hold makes agents hand back work no person can fix                                                                                                                                                                                                                                                                             | Inferring human steps from messages                                                                                 |
| D18 | Paired ABBA runs, an oracle per workload and model-turn accounting remain useful for post-ship screen regression measurement                                                       | Agent-level timing hid real gains behind per-turn cost in aside-codemode; fewer turns and bytes were the measurable effect                                                                                                                                                                                                                                  | A wall-clock threshold                                                                                              |
| D19 | Off-grammar names keep their paths except verb synonyms; `cloud_agent` stays the resource, so its canonical names are `goat_cloud_agent_*`                                         | The path is the stable identity agents already use through `goat_call`; `cloud` alone would read as a sibling of `cloud_machine`                                                                                                                                                                                                                            | Renaming paths to match shipped names                                                                               |
| D20 | Legacy names are unlisted aliases resolved at `/mcp` to the listed tool, whose checks and result apply; analytics keep the shipped name                                            | One handle keeps refusals identical by construction; the listing and provider instructions change together at the flip                                                                                                                                                                                                                                      | Registering alias tools, which would list them                                                                      |
| D21 | Every agent GOAT runs gets the core listing by default (`goat_describe`, `goat_call`), with `agentToolListing: "full"` as the rollback; CI fails a harness over its context budget | Supervisor decision, 2026-10-23: always-injected context falls from about 300 KB to under 12 KiB per harness; D8 verifies the default and tunes the core set rather than gating it                                                                                                                                                                          | Opt-in core, measured before it became the default                                                                  |
| D22 | Thread callers (agents GOAT runs) get the core listing; MCP clients, including SSH dispatch and linked hosts, keep the full one unless they send `x-goat-tool-listing: core`       | An origin of any version reads a remote's `tools/list` to learn launch arguments and memory support, and an older origin cannot be fixed. Outside agents opt into core with the header ([#1066](https://github.com/goat-si/goat/issues/1066)); a versioned capability record for remotes cannot change the no-header default while any older origin remains | Origins learning launch arguments through `goat_describe`, which does not help older origins                        |
| D23 | Settings reach agents through `environment.settings_read` and `environment.settings_update`, with every key classified `agent`, `path` or `person` in `SETTINGS_ACCESS`            | A tool per setting grows the listing and leaves new settings unreachable until someone writes one; one decoded patch reuses the Settings page's schema and merge rules                                                                                                                                                                                      | `environment.preferences_update` growing a field at a time; a settings layer outside MCP                            |
| D24 | Agents answer questions about GOAT from the user guides the server bundles, through `docs.search` and `docs.read`, and cite the guide, section and build                           | The guides already explain each feature for people; serving them from the build avoids answers from stale memory or source code and works offline and on remote hosts                                                                                                                                                                                       | Agents reading GOAT's source to answer product questions; MCP resources, which `goat_call` and the CLI cannot reach |

## Open questions

- Who owns the screen-task regression set and which providers it covers.
- How long a legacy name stays callable for SSH hosts that update rarely.
