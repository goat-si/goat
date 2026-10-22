# Agent surface

> **요약 (Korean summary)**
> GOAT의 에이전트 표면(MCP 106개 도구, `goat` CLI, 문서)을 작은 균일 문법 위로 다시 세우는 설계안이다.
> 모든 기능은 `resource.verb` 경로 하나로 식별되고, 같은 레지스트리에서 MCP 도구 이름, CLI 명령, `--help`, 참조 문서, `llms.txt`가 생성된다.
> 결과는 `ok | error | needs_human` 세 갈래 봉투로 통일하고, 사람이 꼭 해야 하는 단계(OAuth, 디바이스 코드, 시크릿, 승인, 2FA)는 `handoff` 레코드로 넘겨 사람이 끝내면 서버가 작업을 이어서 완료한다. 자격 증명은 에이전트를 거치지 않는다.
> `goat_describe`와 작은 평가기 `goat_eval`(JSON 형식, 호출 32회 상한, 개별 호출과 같은 권한 검사)이 "Lisp 같은 작은 코어" 역할을 한다.
> 이미 `goat_<resource>_<verb>` 형태인 58개 이름은 그대로 두고, 나머지 48개만 별칭과 함께 새 이름으로 옮긴다.
> CLI 설치(macOS/Linux/Windows)는 이미 Settings에 있으므로 이를 확장하고, 첫 소비자는 Claude Cloud·Devin Cloud 프로바이더 설정이다.
> 12개의 작은 PR로 단계적으로 배포하며 각 PR은 단독으로 배포 가능하다.

Status: proposal. Nothing below is implemented unless a paragraph is marked **Now**.

This page uses two labels. **Now** describes `dev` at `a0b5b0ed3`, with source
paths and lines. **Proposed** is design that does not exist yet. Unlabeled text in a
Proposed section is also proposal.

## Why this exists

An agent working in GOAT today has three surfaces that grew separately: 106 MCP
tools, a server CLI built for operators, and prose docs. They disagree in naming,
result shape, and coverage, and each one is maintained by hand.

**Now.** The 106 tools are declared with `Tool.make` across 16 toolkit directories under
`apps/server/src/mcp/toolkits/`. Fifty-eight are named `goat_*`; the rest use
bare prefixes (`preview_*`, `device_*`, `channel_*`, `html_*`) or verb-first
names (`delegate_task`, `list_scheduled_tasks`, `link_pull_request`). ADR-0007
renamed the old `t3_*` tools to `goat_*` and left the others alone
([ADR-0007](../../structure/decisions/ADR-0007-mcp-tool-names.md)). The
hand-written tool reference in
[orchestrator-mcp-server.md](../orchestration-v2/orchestrator-mcp-server.md)
(693 lines) covers about twenty of them. Drift already shows in small places:
`DesktopCliCommandStateSchema` still documents the installed command as `t3`
(`packages/contracts/src/ipc.ts:370`) while the installer links `goat`
(`apps/desktop/src/app/DesktopCliCommand.ts:167`).

The goal is a surface where an agent can find, call, and chain every capability
without reading source, where steps that need a person go to that person and come
back, and where the documentation is generated from the code that runs.

## Design rules

1. **One registry.** Every capability has one entry. MCP names, CLI commands,
   help text, reference docs, and `llms.txt` are derived from it.
2. **Small core.** Three meta tools (`goat_describe`, `goat_call`, `goat_eval`)
   plus the handoff verbs make every other capability reachable as data.
3. **Additive.** New names and envelopes are added beside the old ones. Old names
   keep working through a deprecation window.
4. **No new authority.** Composition, the CLI, and handoffs reuse the existing
   access checks. Nothing in this design lets an agent widen its own grant.
5. **People finish human steps.** OAuth codes, device codes, secrets, approvals,
   and second factors are shown only on human surfaces and never returned to the
   agent.

## Grammar

### Paths

**Proposed.** A capability is identified by a path `resource.verb`. Resources are
lower snake case nouns (`thread`, `pending_request`, `pull_request`). Verbs come
from a small standard set when one fits:

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

A domain verb (`thread.send`, `thread.interrupt`, `preview.click`) is allowed when
no standard verb fits, but it must declare its effect class. The registry stores
resource and verb as separate fields, because names like
`goat_preview_recording_start` cannot be split reliably from the string.

Three projections come from a path:

| Surface     | `thread.send`              | `pending_request.respond`              |
| ----------- | -------------------------- | -------------------------------------- |
| MCP tool    | `goat_thread_send`         | `goat_pending_request_respond`         |
| CLI         | `goat thread send`         | `goat pending-request respond`         |
| Docs anchor | `reference/thread.md#send` | `reference/pending-request.md#respond` |

### Common arguments

**Now.** Several conventions already exist, unevenly:

- `clientRequestId` for retry safety appears in 8 input schemas in
  `packages/contracts/src/orchestratorMcp.ts`.
- `host` routes a call to an SSH host. Unknown top-level arguments are refused
  before the handler runs, so a misspelled `hostId` cannot silently run locally
  (`apps/server/src/mcp/McpHttpServer.ts:805-855`).
- Paging uses numeric offsets (`orchestratorMcp.ts:486`, `:525`;
  `apps/server/src/mcp/toolkits/previewControls/tools.ts:30`) and, for host
  fan-out, an encoded string (`orchestratorMcp.ts:569`).
- Only `goat_worktree_cleanup` offers `dryRun`
  (`apps/server/src/mcp/toolkits/worktree/tools.ts:137`).

**Proposed.** Every registry entry gets the same reserved arguments, validated by
the registry layer before the handler runs:

| Argument          | Applies to                   | Rule                                                                                                                              |
| ----------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `host`            | Entries marked host-routable | Unchanged routing through `SshRemoteDispatch`                                                                                     |
| `clientRequestId` | Every write                  | Same id from the same caller returns the first result for 24 hours                                                                |
| `dryRun`          | Every write that can plan    | Returns `{plan: [...]}` and changes nothing. Entries that cannot plan are marked `dryRun: "unsupported"`, and the call is refused |
| `cursor`, `limit` | Every `list`                 | Cursor is an opaque string; result carries `nextCursor` (string or null)                                                          |

Writes that go through orchestration already get a command receipt in the event
sink. Writes that do not (settings, worktree removal, preview actions) get a small
receipt table keyed by `(caller, path, clientRequestId)`.

### Result envelope

**Now.** `McpServer.toolkit` serializes each result as JSON text
(`McpHttpServer.ts:650-653`). Failures are returned values of
`OrchestratorMcpFailure {code, message}` with 18 codes
(`packages/contracts/src/orchestratorMcp.ts:1093-1122`); preview tools,
secret requests (`packages/contracts/src/secretRequest.ts:19-31`), and provider
setup (`packages/contracts/src/providerSetup.ts:189-200`) each have their own
failure types. Nothing says whether a failure is worth retrying.

**Proposed.** New entry points return one envelope:

```ts
type Result<A> =
  | { status: "ok"; value: A; meta?: { nextCursor?: string | null; receipt?: string } }
  | {
      status: "error";
      error: {
        code: ErrorCode;
        reason: string;
        message: string;
        retryable: boolean;
        details?: unknown;
      };
    }
  | { status: "needs_human"; handoff: HandoffSummary };
```

`needs_human` is a third status because the call has not failed. An agent that
only checks for errors would treat a pending login as a failure and retry it,
starting a second login flow.

`ErrorCode` is a closed set: `invalid_request`, `unauthenticated`,
`permission_denied`, `not_found`, `conflict`, `unavailable`, `timeout`,
`expired`, `cancelled`, `internal`. `reason` keeps the specific code, so no
information is lost:

| Today                                                                                                      | `code`              | `retryable`   |
| ---------------------------------------------------------------------------------------------------------- | ------------------- | ------------- |
| `capability_denied`, `runtime_mode_escalation_denied`, `interaction_mode_escalation_denied`                | `permission_denied` | no            |
| `thread_credential_required`                                                                               | `unauthenticated`   | no            |
| `task_not_found`, `thread_not_found`, `run_not_found`                                                      | `not_found`         | no            |
| `parent_not_active`, `task_not_cancellable`, `thread_not_sendable`, `thread_not_interruptible`, `not_home` | `conflict`          | no            |
| `provider_unavailable`, `model_unavailable`, `host_unavailable`                                            | `unavailable`       | yes           |
| `invalid_request`, `target_required`                                                                       | `invalid_request`   | no            |
| `orchestration_error`                                                                                      | `internal`          | yes, once     |
| Secret `ref_expired`                                                                                       | `expired`           | no; ask again |

Legacy tool names keep their current result shapes until they are removed. The
envelope applies to `goat_call`, `goat_eval`, the CLI's `--json` output, and
canonical names after the listing flip (phase 11).

## Registry

**Now.** Names are string literals inside each `tools.ts`, except
`CHANNEL_MCP_TOOL_NAMES` (`packages/contracts/src/channelGateway.ts:320`). Tool
annotations already record read-only, destructive, idempotent, and open-world
hints (`McpHttpServer.ts:676-680`). Access is declared per handler with
`McpToolAccess` (`reads`, `readsAsCaller`, `writes`, `writesThreads`,
`startsThreads`, `writesEnvironment`, `removesCheckouts`;
`apps/server/src/mcp/McpToolAccess.ts:136-304`), and `/mcp` registers only
toolkits that went through that declaration
(`McpHttpServer.ts:868-882`).

**Proposed.** Add `packages/contracts/src/agentSurface/registry.ts`, a typed table
with one entry per capability:

```ts
{
  path: "thread.send",
  legacyNames: ["goat_thread_send"],
  summary: "Send a message to a thread.",       // one line, used in lists and --help
  description: "...",                            // the model-facing text
  effect: "write",                               // read | write | destructive
  hostRoutable: true,
  dryRun: "unsupported",
  requires: "thread",                            // thread | client | either
  examples: [{ title: "...", args: {...}, expect: { status: "ok" } }],
  related: ["thread.wait", "thread.read"],
  since: "0.9.0",
}
```

Each `tools.ts` reads its name and description from the registry, the way the
channel toolkit already reads `CHANNEL_MCP_TOOL_NAMES`. A rename is then a
one-line change in contracts and a one-token change in the toolkit, which keeps
merge conflicts with upstream T3 Code small. The registry holds no schemas;
schemas stay in contracts beside their tools and the registry refers to them.

The access class shown to agents is read from the `McpToolAccess` declaration
at registration. A test fails when the registry's `effect` disagrees with it,
so documentation cannot claim a tool is read-only while its handler writes.

## Naming map

**Proposed.** The 58 `goat_*` names already parse as `goat_<resource>_<verb>`
and keep their names. The other 48 get canonical names, and their old names
become aliases. Grouped by resource:

| Resource             | Today                                                                                                                                                                                                                                               | Canonical MCP name                                                                             | Source                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `thread`             | `goat_thread_list`, `_read`, `_update`, `_send`, `_wait`, `_interrupt`, `_status`, `_watch`, `_unwatch`, `_watch_list`                                                                                                                              | unchanged                                                                                      | `toolkits/orchestrator/tools.ts:217-354`                                 |
| `thread`             | `goat_thread_organize`, `_configuration`, `_configure`, `_fork`, `_merge_back`, `_transfers`, `_search`, `_report_result`                                                                                                                           | unchanged                                                                                      | `toolkits/thread/tools.ts:38-268`                                        |
| `thread`             | `goat_thread_launch`                                                                                                                                                                                                                                | unchanged                                                                                      | `toolkits/project/tools.ts:201`                                          |
| `thread`             | `goat_thread_send_attachments`                                                                                                                                                                                                                      | unchanged                                                                                      | `toolkits/attachment/tools.ts:47`                                        |
| `thread`             | `create_threads`                                                                                                                                                                                                                                    | `goat_thread_create_many`                                                                      | `toolkits/orchestrator/tools.ts:204`                                     |
| `task`               | `delegate_task`, `task_status`, `task_cancel`                                                                                                                                                                                                       | `goat_task_create`, `goat_task_read`, `goat_task_cancel`                                       | `toolkits/orchestrator/tools.ts:90-117`                                  |
| `workflow`           | `goat_workflow_stop`                                                                                                                                                                                                                                | unchanged                                                                                      | `toolkits/orchestrator/tools.ts:129`                                     |
| `provider`           | `orchestrator_capabilities`                                                                                                                                                                                                                         | `goat_provider_list`                                                                           | `toolkits/orchestrator/tools.ts:77`                                      |
| `schedule`           | `schedule_task`, `list_scheduled_tasks`, `update_scheduled_task`, `delete_scheduled_task`, `run_scheduled_task_now`                                                                                                                                 | `goat_schedule_create`, `_list`, `_update`, `_delete`, `_run`                                  | `toolkits/orchestrator/tools.ts:141-180`, `toolkits/thread/tools.ts:251` |
| `handoff`            | `request_secret`                                                                                                                                                                                                                                    | `goat_handoff_create` with `kind: "secret"` (phase 6)                                          | `toolkits/orchestrator/tools.ts:192`                                     |
| `queue`              | `goat_queue_list`, `_read`, `_edit`, `_cancel`, `_reorder`, `_promote_to_steer`                                                                                                                                                                     | unchanged                                                                                      | `toolkits/thread/tools.ts:87-130`                                        |
| `pending_request`    | `goat_pending_request_list`, `_read`, `_respond`                                                                                                                                                                                                    | unchanged                                                                                      | `toolkits/thread/tools.ts:147-165`                                       |
| `project`            | `goat_project_list`, `_read`, `_create`, `_update`, `_delete`, `_clone`                                                                                                                                                                             | unchanged                                                                                      | `toolkits/project/tools.ts:57-110`                                       |
| `worktree`           | `goat_worktree_handoff`, `_status`, `_list`, `_inventory`, `_remove`, `_cleanup`                                                                                                                                                                    | unchanged                                                                                      | `toolkits/worktree/tools.ts:37-135`                                      |
| `environment`        | `goat_environment_read`, `goat_environment_preferences_update`                                                                                                                                                                                      | unchanged                                                                                      | `toolkits/environment/tools.ts:46-60`                                    |
| `host`               | `goat_host_status`                                                                                                                                                                                                                                  | unchanged                                                                                      | `toolkits/hostStatus/tools.ts:8`                                         |
| `cloud_agent`        | `goat_cloud_holders`, `goat_cloud_launch`, `goat_cloud_run_register`, `_run_list`, `_run_forget` ([credential holders](./cloud-credential-holders.md))                                                                                              | unchanged                                                                                      | `toolkits/provider/tools.ts`                                             |
| `connection`         | `goat_connection_list`, `_add_ssh`, `_remove`                                                                                                                                                                                                       | unchanged                                                                                      | `toolkits/connection/tools.ts:24-51`                                     |
| `ssh`                | [SSH toolkit](../../apps/server/src/mcp/toolkits/ssh/tools.ts) and [callable registry](../../packages/contracts/src/agentSurface/registry.ts)                                                                                                       | SSH setup and runtime approvals resume on the server; status observes progress                 | `toolkits/ssh/tools.ts`                                                  |
| `origin`             | `goat_origin_report`, `goat_origin_reports_wait`                                                                                                                                                                                                    | unchanged                                                                                      | `toolkits/remoteReport/tools.ts:22-29`                                   |
| `attachment`         | `goat_attachment_prepare_upload`, `goat_attachment_discard`                                                                                                                                                                                         | unchanged                                                                                      | `toolkits/attachment/tools.ts:33-40`                                     |
| `preview`            | `goat_preview_list`, `goat_preview_close`                                                                                                                                                                                                           | unchanged                                                                                      | `toolkits/previewControls/tools.ts:25-40`                                |
| `preview`            | `preview_status`, `_open`, `_dialog`, `_navigate`, `_resize`, `_set_appearance`, `_snapshot`, `_click`, `_type`, `_hover`, `_select`, `_drag`, `_upload`, `_press`, `_scroll`, `_evaluate`, `_wait_for`, `_recording_start`, `_recording_stop` (19) | `goat_preview_<same verb>`                                                                     | `toolkits/preview/tools.ts:65-305`                                       |
| `device`             | `device_list`, `_open`, `_screenshot`, `_close`                                                                                                                                                                                                     | `goat_device_<same verb>`                                                                      | `toolkits/device/tools.ts:37-85`                                         |
| `html`               | `html_preview`, `html_render`                                                                                                                                                                                                                       | `goat_html_preview`, `goat_html_render`                                                        | `toolkits/html/tools.ts:25-74`                                           |
| `pull_request`       | `link_pull_request`, `unlink_pull_request`, `list_thread_pull_requests`, `watch_pull_request`, `unwatch_pull_request`                                                                                                                               | `goat_pull_request_link`, `_unlink`, `_list`, `_watch`, `_unwatch`                             | `toolkits/pullRequests/tools.ts:278-336`                                 |
| `pull_request_guide` | `write_pull_request_guides`, `read_pull_request_guide`                                                                                                                                                                                              | `goat_pull_request_guide_update`, `_read`                                                      | `toolkits/pullRequests/tools.ts:384-400`                                 |
| `channel`            | `channel_ingest`, `channel_input_get`, `channel_task_get`, `channel_task_list`, `channel_task_report`                                                                                                                                               | `goat_channel_ingest`, `goat_channel_input_read`, `goat_channel_task_read`, `_list`, `_report` | `packages/contracts/src/channelGateway.ts:320-326`                       |

New entries: `goat_describe`, `goat_call`, `goat_eval`, `goat_handoff_{create,list,read,wait,cancel}`,
`goat_provider_{diagnose,addable_list,setup_open,login_start,login_status,login_cancel}`.

Renames are 1:1 with identical schemas. Merging tools that overlap (for example
`goat_thread_watch` and `watch_pull_request` into one `watch` resource) is out
of scope until the registry has run for a release.

### Aliases and deprecation

**Now.** History recorded under `t3_*` names still renders because presentation
maps old names onto current ones
(`packages/shared/src/goatMcpToolPresentation.ts:102`, `:429`), and SSH dispatch
calls tools on remote GOAT servers by name, so an older remote only answers to
the names it shipped with
([ADR-0007](../../structure/decisions/ADR-0007-mcp-tool-names.md)).

**Proposed.** Deprecation runs in three steps, each one release:

1. **Resolve.** `goat_describe`, `goat_call`, `goat_eval`, and the CLI accept
   both names. `tools/list` is unchanged.
2. **Flip.** `tools/list` shows canonical names. Legacy names stay callable but
   unlisted, and their results carry `deprecated: "<canonical>"`. Presentation
   maps them for history. Provider instructions
   (`packages/provider-core/src/server/orchestrationInstructions.ts`) switch to
   canonical names in the same PR.
3. **Retire.** Legacy names stop being accepted from local callers. Remote
   dispatch keeps translating canonical to legacy when the remote's
   `serverVersion` (from `goat_environment_read`) predates the flip.

## Discovery: `goat_describe`

**Now.** An agent learns tools from `tools/list`: 106 names with long
descriptions, all loaded into context. Whether a tool works for this caller
(thread-only tools refuse outside clients, `McpToolAccess.ts:132`; read-only
clients cannot write, `McpInvocationContext.ts:49`) is found out by calling it.

**Proposed.** `goat_describe { path? }` answers at three depths:

- No path: resources with one-line summaries, the handoff kinds, and the
  evaluator's forms. About 1,500 tokens.
- A resource (`"thread"`): its verbs with summaries and effect classes.
- A full path (`"thread.send"`): input and output JSON Schema, effect class,
  reserved arguments it accepts, tested examples, related paths, legacy names,
  and `available: { now: boolean, reason?: string }` computed for this caller.

The same function backs `goat describe` and `goat <resource> <verb> --help`.

**Proposed (later).** A `core` listing profile shows only the meta tools, the
handoff tools, and the dozen most used tools, with everything else reachable
through `goat_call`. It is opt-in per provider instance and is measured against
the full listing before it becomes a default.

## Composition: `goat_call` and `goat_eval`

**Now.** `goat acp-mcp-call <tool> <json>` already calls any tool from a terminal,
authenticated by `GOAT_ACP_MCP_ENDPOINT` and `GOAT_ACP_MCP_AUTHORIZATION`
(`apps/server/src/cli/acpMcpBridge.ts:25-35`,
`apps/server/src/mcp/AcpMcpStdioBridge.ts:416-470`). There is no way to chain
calls without a model round trip per step.

**Proposed.** `goat_call { path, args }` runs one registry entry and returns the
envelope. `goat_eval { program, dryRun?, clientRequestId? }` runs a small program.

### Syntax

Programs are JSON so models emit them reliably and the server validates them with
a schema. The CLI also accepts an S-expression form that compiles to the same JSON.

| Form      | JSON                                             | S-expression                 |
| --------- | ------------------------------------------------ | ---------------------------- |
| Call      | `{"call": "thread.list", "args": {"limit": 5}}`  | `(thread.list :limit 5)`     |
| Bind      | `{"let": [["t", <expr>]], "in": <expr>}`         | `(let ((t <expr>)) <expr>)`  |
| Reference | `{"ref": "t.value.threads.0.threadId"}`          | `t.value.threads.0.threadId` |
| Sequence  | `{"seq": [<expr>, ...]}`                         | `(seq <expr> ...)`           |
| Map       | `{"map": <expr>, "as": "x", "do": <expr>}`       | `(map (x <expr>) <expr>)`    |
| Branch    | `{"if": <expr>, "then": <expr>, "else": <expr>}` | `(if <expr> <expr> <expr>)`  |
| Literal   | any JSON value under `{"quote": ...}`            | `'(...)`                     |

`if` tests `status == "ok"` or a boolean. There are no user functions, no
recursion, and no loops other than `map` over a value that already exists, so
every program terminates.

Example: wait for every running thread in a project.

```json
{
  "let": [["ts", { "call": "thread.list", "args": { "projectId": "p1", "status": "running" } }]],
  "in": {
    "map": { "ref": "ts.value.threads" },
    "as": "t",
    "do": {
      "call": "thread.wait",
      "args": { "threadId": { "ref": "t.threadId" }, "timeoutMs": 60000 }
    }
  }
}
```

### Limits

| Limit             | Value                                |
| ----------------- | ------------------------------------ |
| Calls per program | 32                                   |
| Nesting depth     | 8                                    |
| `map` width       | 16 items                             |
| Wall time         | 120 s; `wait` calls count against it |
| Result size       | 256 KB, then truncated with a marker |
| Program size      | 16 KB                                |

### Permission model

Each `call` goes through the same path a direct MCP call takes: argument refusal,
the `McpToolAccess` declaration, and the caller's `McpInvocationContext`. The
evaluator is declared `readsAsCaller` and adds no authority. A test calls every
registry entry once directly and once through `goat_eval` with the same caller
and asserts identical refusals.

Writes inside a program get derived idempotency keys
(`hash(program clientRequestId, call index)`), so retrying a whole program
replays completed writes from receipts. A program is not a transaction. It stops
at the first `error` and returns every step's envelope. With `dryRun`, reads run
and writes return their plans.

If a step returns `needs_human`, the program suspends and returns that handoff.
When the handoff completes, `goat_handoff_wait` re-runs the program from the
start, and completed steps come back from receipts.

## Human handoff

**Now.** Three mechanisms already hand work to a person, each with its own shape:

- **Secrets.** `request_secret` shows a private card in the thread; the saved
  value stays on the server under a one-use `secretRef` that expires after 24
  hours (`apps/server/src/secrets/SecretRequests.ts:41`, `:209-240`). Cards exist
  on web (`apps/web/src/components/chat/SecretRequestCard.tsx`) and mobile
  (`apps/mobile/src/features/threads/SecretRequestCard.tsx`).
- **Provider sign-in.** The `provider.auth.*` and `provider.install.*` RPCs
  model browser, device-code, terminal, and credential interactions with phases
  `idle → starting → waiting → verifying → succeeded | failed | cancelled`, an
  `expiresAt`, and a `credentialOwner`
  (`packages/contracts/src/providerSetup.ts:46-141`,
  `packages/contracts/src/rpc.ts:472-486`). They need `providers:manage`
  (`apps/server/src/auth/RpcAuthorization.ts:85-99`). Thread MCP credentials
  carry only preview and orchestration capabilities
  ([orchestrator-mcp-server.md](../orchestration-v2/orchestrator-mcp-server.md#transport-and-authentication)),
  so agents cannot start any of these today.
- **Approvals and questions.** Approvals are human-only; an outside MCP client
  token with `orchestration:approve` is the one exception
  (`apps/server/src/mcp/toolkits/thread/tools.ts:147-173`,
  `apps/server/src/cli/auth.ts:267-330`).

### Record

**Proposed.** One `Handoff` record generalizes these. It is persisted through
orchestration events, so it survives restarts and reaches every client the way
thread state does.

```ts
{
  handoffId, kind,            // oauth | device_code | terminal | secret | approval | mfa
  title, reason,              // reason is the agent's sentence, shown to the person
  requestedBy: { threadId, providerInstanceId, path },
  target: { environmentId, path, args },   // what resumes, e.g. provider.verify
  state, expiresAt, createdAt, resolvedAt?, resolvedBy?,   // resolvedBy: client label, never a credential
  human: { url?, userCode?, command?, fields? }            // human surfaces only
}
```

States: `pending → opened → completed | declined | expired | cancelled | failed`.
`opened` means a person viewed it, so the agent can tell an unseen request from
one in progress.

### What the agent sees

The agent receives `HandoffSummary`: id, kind, title, state, `expiresAt`, and
the target path. It never receives `human`. A device code or sign-in URL is the
person's consent step; an agent holding a browser profile that is already signed
in could otherwise complete it alone. This follows the rule already written on
`ProviderSetupError`: never include OAuth codes, URLs, or native token data
(`providerSetup.ts:189`).

Completing or declining a handoff is a human verb. It requires a client session,
and thread credentials cannot hold it. Outside clients with
`orchestration:approve` keep their current approval power for `kind: "approval"`
only.

### Resume

For SSH setup and runtime updates, the call returns the shared SSH
`kind: "needs_human"` result with a handoff summary. The server's
[SshHostSetup](../../apps/server/src/sshRemote/SshHostSetup.ts) continuation worker
resumes approved `ssh.host_prepare` and `ssh.runtime_update` targets after
rechecking the approving session's target permissions. An approved `ssh.host_add`
fingerprint only pins the host; the agent calls the tool again, which reruns the
preflight before anything is installed. Fingerprints remain private human data; agents see
only that the host key needs review. Key-registration instructions run in the person's
terminal on the environment's owning machine; completion triggers another key-auth
check, not an assumption that registration succeeded.

Preparation and idle updates return their first actual phase or terminal outcome
while a server job continues. Agents observe progress with SSH host status; thread
cards use authenticated handoff progress lookup, including after completion and
remount. Runtime `ready` with setup diagnosis still pending is intermediate: wait
for the current operation's setup completion or recovery result. An earlier provider
summary cannot complete a new setup operation.

The general continuation, wait, and wake behavior below remains proposed. It is
not provided by the SSH-specific worker:

- `goat_handoff_wait { handoffId, timeoutMs ≤ 300000 }` returns the final
  envelope of `target` once the handoff completes, or the current state on
  timeout.
- An agent that ends its turn is woken with a message when the handoff resolves,
  using the wake path launch watches already use
  (`apps/server/src/mcp/LaunchWatchService.ts`).
- Creating a handoff is idempotent on `(threadId, kind, target)`: a second
  request returns the pending one. A thread may hold at most three pending
  handoffs.

### Expiry

| Kind                   | Default lifetime                                       |
| ---------------------- | ------------------------------------------------------ |
| `device_code`, `oauth` | The provider's `expiresAt`, else 15 minutes            |
| `terminal`, `mfa`      | 15 minutes                                             |
| `secret`               | 1 hour to answer; the saved ref keeps today's 24 hours |
| `approval`             | Until the requesting turn ends                         |

SSH targets have a 24-hour lifetime and survive the requesting run ending.
Immediate runtime-update approval must also be executed within ten minutes of
approval, with the same host generation and target build; otherwise it must be
requested again. See [Handoffs](../../apps/server/src/handoffs/Handoffs.ts) for the
SSH expiry and acknowledgement rules. The table above describes the proposed
general lifetimes.

An expired handoff returns `error.code: "expired"` from the proposed `wait` path.
The agent may create a new one.

### Surfaces

| Surface         | Behavior                                                                                                                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web and desktop | A card in the requesting thread, generalized from `SecretRequestCard`, plus a count in the sidebar inbox                                                                                            |
| Mobile          | The same card in the thread feed and a push notification (see [mobile notifications](../user/mobile-notifications.md))                                                                              |
| CLI             | `goat handoff list` and `goat handoff open <id>`, which runs the human step in the person's own terminal: opens the URL, prints the device code, or runs the provider's login command interactively |
| Remote          | A handoff on an SSH host appears on the origin machine's clients through the existing remote report path                                                                                            |

### Audit

Every state change is an event with its actor: the agent thread that created it,
and the client label that opened, completed, or declined it. The activity log
shows them (see [activity log](../user/activity-log.md)). Secret values, codes, and
URLs are never written to events.

## Documentation from the registry

**Now.** Agent-facing docs are hand-written: per-tool sections in
[orchestrator-mcp-server.md](../orchestration-v2/orchestrator-mcp-server.md), the
prefix table in [structure/mcp-toolkits.md](../../structure/mcp-toolkits.md), and
CLI help strings in each `apps/server/src/cli/*.ts`. Nothing checks them against
the code.

**Proposed.** `vp run agent-surface:gen` writes, from the registry and the
contract schemas:

- `docs/reference/agent-surface/<resource>.md`, one page per resource;
- `docs/llms.txt`, a compact index (path, one line, effect class) with links;
- the CLI's help text and a `goat.1` man page bundled with the app.

The server also serves `/llms.txt` filtered to what the calling credential can
use.

CI fails when:

1. a registered MCP tool has no registry entry, or an entry has no tool
   (enumerated from the assembled `/mcp` layer in a test);
2. `agent-surface:gen --check` produces a diff;
3. an entry's `effect` disagrees with its `McpToolAccess` declaration;
4. any example fails when run against the in-memory server harness the toolkit
   tests already use (`apps/server/src/mcp/toolkits/core.test.ts`).

The per-tool sections of `orchestrator-mcp-server.md` are then replaced by links,
and the page keeps only lifecycle and policy.

This conflicts with the repository rule against documenting every method
([AGENTS.md](../../AGENTS.md#documentation)). Generated reference pages would
be the second allowed catalog after `structure/`, and they need maintainer
sign-off.

## The `goat` command

**Now.**

- The desktop app writes a launcher to `<GOAT home>/bin/goat` (`goat.cmd` on
  Windows) at every start, best-effort, and rewrites it when the app updates
  (`apps/desktop/src/app/DesktopCliShim.ts:136-193`).
- **Settings → General → About → Install** links the launcher into the first
  writable folder among `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`,
  and `~/bin` on macOS (`~/.local/bin` and `~/bin` on Linux), or adds its folder
  to the user `PATH` on Windows
  (`apps/desktop/src/app/DesktopCliCommand.ts:27-56`, `:225-255`;
  [install guide](../user/install.md#the-goat-command)). It refuses when another
  `goat` would shadow it. **Remove** undoes only what it added.
- Bare `goat` runs the server (`apps/server/src/binCli.ts:58-60`). The
  subcommands are operator tools: `serve`, `start`, `pair`, `auth`,
  `project`, `service`, `update`, `uninstall`, `connect`, `trace`, and
  others (`binCli.ts:61-88`). `acp-mcp-call` is unlisted.

### Install, update, uninstall

**Proposed.**

| Platform            | Install                                                                                                                                  | Update                                            | Uninstall                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| macOS               | Keep the Settings action and offer it once in the welcome wizard. No admin prompt; if no PATH folder is writable, show the launcher path | Automatic: the launcher is rewritten at app start | Settings → Remove. Deleting the app leaves a dangling link, which `goat` reports and Settings can remove |
| Linux `.deb`/`.rpm` | The package installs `/usr/bin/goat` pointing at the launcher                                                                            | Package manager                                   | Package removal                                                                                          |
| Linux AppImage      | The Settings action (the launcher mounts the AppImage, `DesktopCliShim.ts:158-164`)                                                      | Automatic                                         | Settings → Remove                                                                                        |
| Windows             | Keep the user `PATH` entry                                                                                                               | Automatic                                         | Settings → Remove, and the uninstaller removes the recorded PATH entry                                   |

The npm package keeps its `goat` and `t3` bins and keeps bare `goat` starting a
server, so `npx t3` users see no change. The desktop launcher sets
`GOAT_CLI_LAUNCHER=1`; with it, bare `goat` prints help instead of starting a
second server against the app's home.

### Command tree

```text
goat <resource> <verb> [args] [--json] [--host <alias>] [--dry-run] [--request-id <id>]
goat describe [path]
goat call <path> [json | -]
goat eval [file | -] [--sexp]
goat handoff list | open <id> | decline <id>
goat login | logout | whoami
goat serve | start | pair | auth | service | update | uninstall | connect | ...   (unchanged)
```

Resource commands are generated from the registry. `goat call` replaces
`acp-mcp-call`, which stays as an alias. `goat project` already has
`add`, `remove`, and `rename` (`apps/server/src/cli/project.ts:456-585`); they
become aliases of `create`, `delete`, and `update` from the registry.

### Help and output

- `--help` is generated: summary, usage, arguments with types and defaults, the
  tested examples, effect class, availability for the current credential,
  related commands, and legacy names.
- Default output is a short human rendering. `--json` prints the envelope
  exactly, one JSON document on stdout. Logs go to stderr.
- Exit codes: `0` ok, `1` error, `2` usage, `3` needs_human (stderr says how
  to finish it), `4` retryable error.
- Arguments: flags for top-level scalar fields, `--args <json>` or stdin for the
  rest.

### Credentials

The CLI resolves a credential in this order:

1. `GOAT_ACP_MCP_ENDPOINT` and `GOAT_ACP_MCP_AUTHORIZATION`, which GOAT already
   sets for ACP agents. The proposal sets them for every provider's subprocess
   and terminal, so `goat` inside a thread has exactly that thread's grant.
2. A session from `goat login`, which pairs the CLI with the local desktop server
   through the existing pairing flow and stores the token in the OS keychain.
3. `--host` reaches SSH hosts through the same routing as MCP.

One gap must be stated plainly. `goat auth client create` opens the environment's
state directly and can mint a token with `orchestration:approve`
(`apps/server/src/cli/auth.ts:36-48`, `:267-330`). An agent with full-access
shell can run it today, and it can also read the state directory itself, so the
real boundary is the OS user and the runtime mode. The CLI will refuse
credential-minting commands when a thread credential is present in its
environment and ask the person to run them. That check stops mistakes, but
removing the variable defeats it. Runtime-mode sandboxing is what enforces the
boundary.

## Worked example: provider setup

**Now.** Claude Cloud uses a local Claude instance's binary and claude.ai login,
named by `sourceInstanceId` (default `claudeAgent`;
`packages/contracts/src/settings.ts:734-750`). Readiness runs `claude --version`,
`--help`, and `claude auth status`, and requires `authMethod: "claude.ai"`;
otherwise it reports "Run claude auth login --claudeai on this environment's
machine" (`packages/provider-claude-cloud/src/server/cli.ts:142-160`). The
driver reports `setup: { canAuthenticate: false, canInstall: false }`
(`apps/server/src/provider/Drivers/ClaudeCloudDriver.ts:174`). Devin Cloud reuses
an ACP Registry Devin instance named by `siblingInstanceId`
(`packages/provider-devin-cloud/src/settings.ts:11`). Agents can inspect provider
availability through `orchestrator_capabilities` and request CLI installation
and sign-in across hosts through `provider.sync`.

**Now.** `provider.host_matrix` (`goat_provider_host_matrix`) reads installed
versions and sign-in state across this machine and SSH hosts. `provider.sync`
(`goat_provider_sync`, write) installs with the vendor's official npm package or
OS-specific script, matching this machine's version by default (latest if absent;
Cursor's installer always installs latest), then starts sign-in on each host.
Thread agents receive a `needs_human` approval handoff targeting
`provider.host_sync`; the approver needs `providers:manage`, and execution uses
their session. Follow approval with `goat_provider_sync_status` by `handoffId`,
then use its `syncId` for `goat_provider_sync_cancel` if needed. Cancellation
stops unfinished work but keeps completed installs.

Each remote runs its own `goat_provider_sync` locally. Installer output stays
there; only a device code and vendor page (Codex's `codex login --device-auth`)
or an allowlisted vendor sign-in page (Cursor) can be relayed. Other flows ask
the person to run the vendor's terminal command or finish in GOAT on that host.
Sign-in details are visible only to the requester, approver, or a
`providers:manage` caller. Credentials are never copied between machines. See
[ProviderHostSync](../../apps/server/src/provider/ProviderHostSync.ts) and its
[installer and login rules](../../apps/server/src/provider/ProviderHostSyncRecipes.ts).

Every provider write needs a live `providers:manage` grant, on the remote too.
The origin asks the remote for an SSH-issued session carrying
`providers:manage` only for calls it has already authorized against the
caller's (or approver's) live `providers:manage`, so the remote can attribute
the write instead of trusting any full-access outside client. A remote too old
to issue that scope fails the call rather than falling back.

Requesting an approval card (provider setup, login, sync, Codex home, SSH host
trust, SSH runtime update now) needs only a running, writable thread
credential, which carries `orchestration:read` and never
`orchestration:operate`. What runs after approval is authorized against the
approving person's session. See
[authorizeApprovalRequest](../../apps/server/src/sshRemote/SshHostAuthorization.ts).

**Single environment.** Five entries add providers and sign in on the caller's own
environment:

| Path                    | Effect | Does                                                                                                          |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| `provider.addable_list` | read   | Every driver this environment can add, its install state, how it signs in, and its configured instances       |
| `provider.setup_open`   | write  | Creates a `provider.setup` handoff that opens the add-provider window, preselecting a driver or instance      |
| `provider.login_start`  | write  | Thread agents get the same handoff; a client holding `providers:manage` starts the flow under its own session |
| `provider.login_status` | read   | The redacted phase of a flow the caller's own session started                                                 |
| `provider.login_cancel` | write  | Cancels that flow                                                                                             |

Thread credentials never hold `providers:manage`, so an agent cannot install a
CLI or sign in. It gets `needs_human` with a `provider.setup` handoff, and the
person finishes in the same add-provider window the model picker's **+** opens,
under their own session. The handoff is the only way an agent reaches that
window: it renders as a card in the thread, opening it needs `providers:manage`
on its origin environment, and the preselection travels in the encrypted human
payload. Its title, reason, and instructions are server text built from driver
metadata, so an agent cannot put a link or command in front of the person. It
expires on a 30-minute clock, since the person often finishes after the
requesting turn ends.

A sign-in flow is owned by the auth session that started it
([providerAuthFlow](../../packages/provider-core/src/server/providerAuthFlow.ts)), so
another session that replays its `flowId` sees no flow. MCP results go through
`redactProviderAuthState` in
[providerOnboarding](../../packages/contracts/src/providerOnboarding.ts): a device
code and its https verification URL are meant for the person and pass; browser
authorization and callback URLs, terminal output, and credential fields stay
with the client that owns the flow, and the result says `continueIn: "app"`.

Claude Code signs in with its own `claude auth login` in a PTY that the app
renders, and the Claude CLI writes the credentials
(`credentialOwner: "provider"`). Claude Cloud and Devin Cloud follow their
sibling instance, so signing in to the sibling is the fix.

The callable provider diagnosis path accepts an SSH host and uses
[ProviderDiagnosisRouting](../../apps/server/src/provider/ProviderDiagnosisRouting.ts)
to inspect that host's own providers. It requires a ready runtime; a stopped or
unprepared host returns instructions to prepare it and check status, without
waiting for installation or silently diagnosing the local environment.
Callable `provider.sync` installs CLIs and starts sign-in across hosts, with
installation and credential storage on each destination machine; the onboarding
entries above act on the caller's own environment.
See the [registry](../../packages/contracts/src/agentSurface/registry.ts) for current
callable paths and human steps, and the [SSH ownership map](../../structure/ssh.md#host-trust-and-forgetting)
for trust, key registration, and forget boundaries.

## Rollout

Each PR ships on its own and leaves `tools/list` unchanged until phase 11.

| #   | PR                                                                 | Ships                                                                                     | Proof                                                                                        |
| --- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | `feat(contracts): agent surface registry`                          | Registry with all 106 entries; toolkits read names from it                                | Parity test: assembled `/mcp` tools equal registry entries; `effect` matches `McpToolAccess` |
| 2   | `feat(server): goat_describe`                                      | Describe tool and `goat describe`                                                         | Tests per depth; availability for thread vs outside callers                                  |
| 3   | `docs: generate agent surface reference`                           | Generated pages, `llms.txt`, drift check in CI; trims hand-written tool sections          | `agent-surface:gen --check`; examples run in the harness                                     |
| 4   | `feat(server): goat_call and result envelope`                      | `goat_call`, error mapping, `goat call` (`acp-mcp-call` alias)                            | Mapping table tests for each failure type                                                    |
| 5   | `feat(cli): resource commands from the registry`                   | `goat <resource> <verb>`, `--json`, exit codes, launcher help, credential order           | CLI tests in `apps/server/src/cli`; snapshot of generated help                               |
| 6   | `feat: handoff record and cards`                                   | Handoff events, web/mobile cards; `request_secret` becomes `kind: "secret"`               | State machine tests draining the effect worker; one web and one mobile pass                  |
| 7   | `feat: handoff wait, wake, and CLI`                                | `goat_handoff_wait`, wake on resolve, `goat handoff`, push                                | Deferred-based tests; no sleeps                                                              |
| 8   | `feat(providers): provider.diagnose`                               | Read-only diagnosis for Claude Cloud and Devin Cloud                                      | Driver readiness fixtures                                                                    |
| 9   | `feat(providers): setup, login, verify through handoffs`           | The worked example end to end                                                             | Replay harness; manual run on one machine                                                    |
| 10  | `feat(server): goat_eval`                                          | Evaluator with limits and S-expression CLI input                                          | Permission equivalence test over every entry; limit tests                                    |
| 11  | `feat(mcp): list canonical tool names`                             | Listing flip, hidden legacy names, presentation map, instruction text, remote translation | Old-remote compatibility test in `SshRemoteDispatch` tests                                   |
| 12  | `feat(desktop): goat command on Linux packages and welcome wizard` | `/usr/bin/goat` in packages, wizard offer                                                 | `DesktopCliCommand` tests; package install check                                             |

Testing follows the repository rules: focused tests for each behavior, effect
worker draining instead of sleeps, and one real-client pass for the handoff cards
(`test-goat-app` for web, `test-goat-mobile` for mobile).

## Open questions

- Whether `tools/list` should move to the `core` profile by default. This needs
  measurements of tool-selection quality per provider before deciding.
- How long a legacy name must stay callable for SSH hosts that update rarely.
- Whether generated reference pages live in `docs/reference/` or are served only
  by the running server.
