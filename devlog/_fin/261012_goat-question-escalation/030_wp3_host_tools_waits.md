# 030 — wp3: host-aware questions, SSH launcher identity, and question-aware waits

> **Main disposition (binding):** the amendments and open questions in this document (A1 and section 11) are decided in [000_plan.md](000_plan.md#main-dispositions-of-drafting-lane-amendments-wp0). Where this document proposes otherwise (notably rejecting threadless outside responders), 000 wins: they are recorded as `respondedBy: { type: "client", reason }`.

## Main errata (binding, from the wp0 reflection; supersedes conflicting hunks below)

**E1 — Outside responders.** An outside client respond without a transported `respondedBy` is accepted and stamped `{ type: "client", reason }` (010 errata E2). A transported `respondedBy` is accepted only from an outside client and only as `agent` with non-null `environmentId`; a thread caller supplying it gets `invalid_request`. The origin builds it from its authenticated caller: `{ type: "agent", threadId: caller.id, environmentId: <this env id>, title: caller title, reason }`.

**E2 — Reason.** All schemas reuse `UserInputResponseReason` (non-whitespace, 1–2000). Tests cover whitespace-only on the transported path.

**E3 — Environment identity in discovery.** `scope:"launched"` result items carry `environmentId` (the asking thread's environment; a remote returns its own `ServerEnvironment` id, local items `null`). The origin dedups fan-out items by `(environmentId ?? "local", threadId, requestId)` so two aliases for one machine do not duplicate, and reports the alias it used as `host`.

**E4 — Bounded result.** The launched list returns at most 100 questions in deterministic order with `truncated: boolean`; the description says to answer or narrow (`host`, `threadId`) when truncated. Concurrency 4 for host fan-out.

**E5 — Forward-to-human text.** Remote respond refusals keep the remote's code; the origin appends the same forward-to-human suffix as 010 errata E4 when the code is a ceiling code.

**Disclosed residual risks.** Alias reassignment after a restart can point `hosts` at a different machine; results then carry that machine's `environmentId`, so the launcher can tell. Persisted dispatch links remain deferred (000 D8).

**E6 — Message-mode questions count for both waits (audit M1).** Codex async questions (`responseCapability.type === "message"`) stay pending after their run completes. `waitForThread` reports `pendingRequestIds` for pending `user_input` requests whose node belongs to the selected run regardless of run status (terminal or not); a terminal run still returns as before, now with the ids. `delegate_task` `readTask`/wait include pending `user_input` requests from the child's latest run even when the task is terminal. Replace the test "delegate wait ignores … historical terminal-run questions" with "terminal run with a pending message-mode question returns its id"; add a live-mode and a message-mode case to the thread-wait tests. This makes `goat_thread_wait({host})` on a remote Codex thread return with the question id in both modes (040 §1).

**E7 — Verifier commands.** Use `$B/vp`/`$B/tsc` with `B=<worktree>/node_modules/.bin`; never prepend it to PATH.

**E8 — Addendum from wp3 audit `q13-wp3-audit-r1` (binding; supersedes conflicting body text).**

1. **Launched lookup is a query.** Add `getLaunchedPendingQuestions({ launcherThreadId, launcherEnvironmentId: EnvironmentId | null, limit })` beside `getQuestionEscalationCandidates` in `ProjectionStore.ts` (SQL + in-memory twin): exact launcher match; the legacy app-owned delegated-child rule exactly as wp2's query, only when `launcherEnvironmentId` is null; order by request id then thread id; the service asks for 101 to set `truncated` (cap 100), then reads matched threads with concurrency 4. No `listProjectThreads` scan.
2. **SSH retry (031 wins).** Retry the remote `goat_thread_launch` once without `launcher` only when the refusal message contains `goat_thread_launch does not take launcher, so nothing ran`; re-run `beforeLaunch` first; add a result note that this remote does not record its launcher, so `scope:"launched"` cannot find its questions.
3. **E6 wins in `readTask`.** Pending ids = pending `user_input` requests of the child's latest run whatever its status, plus active runs. Line-1240 style exclusions are deleted.
4. **Threadless origin respond.** An origin without a calling thread forwards the remote respond without `respondedBy`; the remote records `client`. No refusal.
5. **Dedup key** is the item's `environmentId`, which is never null in results: local items carry this server's `scope.environmentId` (supersedes E3's "local items null").
6. **Wiring.** `PendingQuestionsMcpService` depends on `HostThreadsMcpService` (add `writeOnHost` beside `readOnHost`, `writes: true`); `layerThreadToolkit` in `McpHttpServer.ts` provides `HostThreadsMcpService.layer` like the toolkit that already does.
7. **Wake upgrade guard.** In `delegateTask` upgrade the wake policy on early release only when the task is not terminal and ids are non-empty.
8. **Outside-caller test** is `readCaller().caller === undefined` for `launcher` on `goat_thread_launch`, transported `respondedBy`, and the foreign launcher filter; refuse a transported `environmentId` equal to this server's own.
9. **Cuts.** No `remote_provenance_unconfirmed` warning and no provenance read-back (respond returns `{ host, sequence }`); do not move `OrchestratorMcpFailureCode` (`unavailableHosts[].code` is a string). Forward-to-human suffix is appended at the origin only when absent.
10. **Cheap wait reads.** Link requests to runs via `turnItems` filtered `{ turnItemTypes: ["user_input_request"], turnItemRunIds }` (items carry `runId`, `requestId`), then check `runtimeRequests` status for just those ids. `waitForThread` listens to `runtime-request.updated` too, returns ids on its early terminal path, and takes `releaseOnPendingQuestion` (default true; `settleAfterRun` passes false). `TASK_WAKE_EVENTS` gains a child `runtime-request.updated` entry. Pass ids through `OrchestratorMcpService`'s explicit wait result.
11. **Strict arguments.** Declare every new argument on its tool schema. Instruction text re-anchors to the current GOAT wording, including the SSH paragraph ("The remote thread cannot report back …" now also says `goat_thread_wait({host})` returns when the remote thread asks a question).

## Amendments requested

**A1 — D4 needs an explicit remote provenance transport seam.** A destination receives an SSH-origin MCP call as an outside client, not as the origin thread: `apps/server/src/mcp/McpInvocationContext.ts:30–35,46–51`, `apps/server/src/sshRemote/SshRemoteDispatch.ts:563–568`, and `apps/server/src/mcp/threadAccess.ts:70–98`. Consequently, stamping only the destination's authenticated thread cannot preserve D4's agent `threadId`/`environmentId`. Proposed default: an optional, reserved `respondedBy` transport argument on pending respond, accepted only for an authenticated outside client and only for an agent with a non-null foreign environment ID; the origin constructs it from its authenticated caller. Reject thread callers that supply it. This is the same outside-client trust boundary already accepted for D1's foreign launcher, **not independently authenticated proof of a foreign thread**. The destination still enforces its own client ceiling and `DispatchModeLimit`. Main must ratify this seam or explicitly defer provenance-preserving remote answers; do not silently label an outside agent as a human or fabricate a local thread. The code sketches below mark this seam and reject an outside respond without a transported agent identity by default. If wp1 specifies another outside-client policy, reconcile it with main before implementation.

No D1/D7/D8 disposition is changed. No reverse delivery mechanism for D9 is implemented. The requested document is explicitly authorized despite the general AGENTS preference against repository scratch plans; this cycle changes this document only.

## Scope, prerequisites, and source evidence

Binding source: [000_plan.md](000_plan.md), D1 SSH subset, D7 and D8; research: [001_research.md](001_research.md), R1–R3. Assume wp1 and wp2 have shipped before applying this phase. Reference wp1's `OrchestrationV2ThreadLauncher`, `UserInputRespondedBy`, `UserInputResponseReason`, `OrchestrationV2AppThread`, `OrchestrationV2ThreadShell`, `OrchestrationV2RuntimeRequest`, `UserInputAttachmentAnswerPayload`, and wp2's `QuestionEscalationService` by name. Reuse those schemas; do not invent a second provenance/launcher schema. wp1 owns command/projection serialization and resolved reads; wp2 owns question/resolution notification delivery and deterministic receipts. This phase does not subscribe a second notification reactor.

All before anchors below were re-derived from current source in this worktree on 2026-10-12. They describe pre-wp1/pre-wp2 source; at implementation time apply the patches over the wp1 changes, retaining its reason validation, first-answer error mapping, provenance stamping, and resolved-read behavior. wp1/wp2 documents became available during final review and were cross-checked: wp1 §1/§4.5 proposes the named schemas and updates `threadAccess.dispatchFailure`; wp1 A2 agrees that threadless outside response attribution needs a main disposition. wp2 reuses `exceededDispatchModeLimit` for `humanRequired`. Recheck exact lines after integration.

Read: worktree `AGENTS.md`, `docs/internals/effect-services.md`. No server, browser, git mutation, implementation change, or repo-wide check was run. One existing focused harness probe ran; see the last section.

| Operation    | Exact path                                                       | Ownership                                                                             |
| ------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| MODIFY       | `packages/contracts/src/orchestratorMcp.ts`                      | Pending input/result schemas, foreign launcher transport schema, optional wait fields |
| NEW          | `apps/server/src/mcp/PendingQuestionsMcpService.ts`              | Local pending operations, launched discovery, host routing                            |
| MODIFY       | `apps/server/src/mcp/toolkits/thread/handlers.ts`                | Delete handler-local question implementation; thin service calls                      |
| MODIFY       | `apps/server/src/mcp/toolkits/thread/tools.ts`                   | Shared contracts, service dependency, descriptions                                    |
| MODIFY       | `apps/server/src/mcp/McpHttpServer.ts`                           | Provide pending service layer to thread toolkit                                       |
| MODIFY       | `apps/server/src/mcp/toolkits/project/tools.ts`                  | Optional foreign launcher input                                                       |
| MODIFY       | `apps/server/src/mcp/toolkits/project/handlers.ts`               | Outside-only launcher guard and `via: "ssh_thread_launch"`                            |
| MODIFY       | `apps/server/src/mcp/toolkits/ssh/handlers.ts`                   | Capture authenticated origin thread/environment                                       |
| MODIFY       | `apps/server/src/sshRemote/SshRemoteDispatch.ts`                 | Forward optional origin launcher; no unsafe launch retry                              |
| MODIFY       | `apps/server/src/orchestration-v2/ThreadManagementService.ts`    | Pending-question release, event subscription, internal settle opt-out                 |
| MODIFY       | `apps/server/src/mcp/OrchestratorMcpService.ts`                  | Delegate pending IDs, wait release/wake upgrade, thread-wait result propagation       |
| MODIFY       | `apps/server/src/mcp/toolkits/orchestrator/tools.ts`             | Accurate wait/delegate descriptions                                                   |
| MODIFY       | `packages/provider-core/src/server/orchestrationInstructions.ts` | Three question-handling sentences and host-tool guidance                              |
| NEW / MODIFY | Test files listed in §8                                          | Behavioral proof and contract compatibility                                           |

`apps/server/src/mcp/HostThreadsMcpService.ts` needs **no production edit**: its `decodeWait` already decodes `OrchestratorMcpThreadWaitResult` (`:115`), and `onHost` spreads the decoded result (`:215–217`), preserving a newly optional field. Extend its test instead. No file deletion; DELETE applies only to obsolete inline declarations and handlers in modified files.

## 1. Shared contracts — MODIFY `packages/contracts/src/orchestratorMcp.ts`

### Before

Existing imports at `:5–19` have no `EnvironmentId` or `RuntimeRequestId`; `:25` imports provider modes but not `ProviderUserInputAnswers`; `:28–33` imports orchestration enums but not the runtime-request or question schemas. The thread tool inputs live at `:303–505`. Existing pending contracts are inline in `apps/server/src/mcp/toolkits/thread/tools.ts:130–175`, not in contracts.

```ts
// packages/contracts/src/orchestratorMcp.ts:295–301
export const OrchestratorMcpHost = TrimmedNonEmptyString.check(Schema.isMaxLength(255)).annotate({
  description:
    "Another machine's SSH host alias, from goat_ssh_host_list or the host goat_ssh_thread_launch returned. Omit for this environment.",
});
/** Set on results that came from another machine; absent for this environment. */
const OrchestratorMcpResultHost = Schema.optional(Schema.String);

// :209–213, inside OrchestratorMcpDelegateTaskResult
waitTimedOut: Schema.Boolean.annotate({
  description:
    "True only on that mode=wait call when timeoutMs elapsed. The timeout does not cancel the child. Later task_status reads return false and use status for liveness.",
}),

// :489–496
export const OrchestratorMcpThreadWaitResult = Schema.Struct({
  host: OrchestratorMcpResultHost,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  status: OrchestratorMcpThreadStatus,
  timedOut: Schema.Boolean,
});
export type OrchestratorMcpThreadWaitResult = typeof OrchestratorMcpThreadWaitResult.Type;
```

### After — insert immediately after `OrchestratorMcpResultHost`, beside thread inputs

Add `EnvironmentId`, `RuntimeRequestId` to base imports; `ProviderUserInputAnswers`, `UserInputRespondedBy`, `UserInputResponseReason` to provider-policy imports; `OrchestrationV2RuntimeRequest`, `OrchestrationV2ThreadLauncher`, `OrchestrationV2UserInputQuestion` to orchestration imports. These are runtime schema imports, not type-only imports.

**Move, do not copy**, the existing `OrchestratorMcpFailureCode` schema/type from `:692–711` to immediately before `OrchestratorMcpResultHost` at `:300`. Its current full declaration is:

```ts
// Before: orchestratorMcp.ts:692–711. After: same declaration before :300.
export const OrchestratorMcpFailureCode = Schema.Literals([
  "capability_denied",
  "parent_not_active",
  "provider_unavailable",
  "model_unavailable",
  "runtime_mode_escalation_denied",
  "interaction_mode_escalation_denied",
  "task_not_found",
  "task_not_cancellable",
  "thread_not_found",
  "run_not_found",
  "thread_not_sendable",
  "thread_not_interruptible",
  "invalid_request",
  "orchestration_error",
  "thread_credential_required",
  "target_required",
  "host_unavailable",
]);
export type OrchestratorMcpFailureCode = typeof OrchestratorMcpFailureCode.Type;
```

DELETE the old declaration at `:692–711`; leave `OrchestratorMcpFailure` at `:713–719` using the moved schema. New launched result schemas would otherwise execute before this constant is initialized. All existing failure consumers retain identical names and values; no error enum value is added.

```ts
export const OrchestratorMcpForeignLauncher = Schema.Struct({
  threadId: OrchestrationV2ThreadLauncher.fields.threadId,
  environmentId: EnvironmentId,
});
export type OrchestratorMcpForeignLauncher = typeof OrchestratorMcpForeignLauncher.Type;

export const OrchestratorMcpPendingRequestListInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  host: Schema.optional(OrchestratorMcpHost),
  scope: Schema.optional(Schema.Literals(["thread", "launched"])),
  hosts: Schema.optional(Schema.Array(OrchestratorMcpHost)),
  // Reserved outside-client filter. Both or neither; validated by the service.
  launcherThreadId: Schema.optional(ThreadId),
  launcherEnvironmentId: Schema.optional(EnvironmentId),
});
export type OrchestratorMcpPendingRequestListInput =
  typeof OrchestratorMcpPendingRequestListInput.Type;

export const OrchestratorMcpLaunchedQuestion = Schema.Struct({
  host: Schema.NullOr(OrchestratorMcpHost),
  threadId: ThreadId,
  title: Schema.String,
  requestId: RuntimeRequestId,
  questions: Schema.Array(OrchestrationV2UserInputQuestion),
  humanRequired: Schema.Boolean,
});
export type OrchestratorMcpLaunchedQuestion = typeof OrchestratorMcpLaunchedQuestion.Type;

export const OrchestratorMcpLaunchedQuestionsResult = Schema.Struct({
  host: OrchestratorMcpResultHost,
  questions: Schema.Array(OrchestratorMcpLaunchedQuestion),
  unavailableHosts: Schema.Array(
    Schema.Struct({
      host: OrchestratorMcpHost,
      code: OrchestratorMcpFailureCode,
      message: Schema.String,
    }),
  ),
});
export type OrchestratorMcpLaunchedQuestionsResult =
  typeof OrchestratorMcpLaunchedQuestionsResult.Type;
export const OrchestratorMcpPendingRequestListResult = Schema.Union([
  Schema.Struct({ host: OrchestratorMcpResultHost, requestIds: Schema.Array(RuntimeRequestId) }),
  OrchestratorMcpLaunchedQuestionsResult,
]);
export type OrchestratorMcpPendingRequestListResult =
  typeof OrchestratorMcpPendingRequestListResult.Type;

export const OrchestratorMcpPendingRequestReadInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  host: Schema.optional(OrchestratorMcpHost),
  requestId: RuntimeRequestId,
});
export type OrchestratorMcpPendingRequestReadInput =
  typeof OrchestratorMcpPendingRequestReadInput.Type;
export const OrchestratorMcpPendingRequestReadResult = Schema.Struct({
  host: OrchestratorMcpResultHost,
  requestId: RuntimeRequestId,
  questions: Schema.Array(OrchestrationV2UserInputQuestion),
  // Optional only for decoding old remotes; current local code always returns both.
  status: Schema.optional(OrchestrationV2RuntimeRequest.fields.status),
  respondedBy: Schema.optional(UserInputRespondedBy),
  resolvedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
});
export type OrchestratorMcpPendingRequestReadResult =
  typeof OrchestratorMcpPendingRequestReadResult.Type;

export const OrchestratorMcpPendingRequestRespondInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  host: Schema.optional(OrchestratorMcpHost),
  requestId: RuntimeRequestId,
  answers: ProviderUserInputAnswers,
  reason: UserInputResponseReason,
  // A1: destination accepts this only from an authenticated outside client.
  respondedBy: Schema.optional(UserInputRespondedBy),
});
export type OrchestratorMcpPendingRequestRespondInput =
  typeof OrchestratorMcpPendingRequestRespondInput.Type;
export const OrchestratorMcpPendingRequestRespondResult = Schema.Struct({
  host: OrchestratorMcpResultHost,
  sequence: NonNegativeInt,
  // Return committed provenance, never the submitted value merely echoed.
  respondedBy: Schema.optional(UserInputRespondedBy),
  warning: Schema.optional(Schema.Literal("remote_provenance_unconfirmed")),
});
export type OrchestratorMcpPendingRequestRespondResult =
  typeof OrchestratorMcpPendingRequestRespondResult.Type;
```

`packages/contracts/src/index.ts:40` already exports `*` from `orchestratorMcp.ts`; **N/A edit**, no new barrel. `reason` uses wp1's exact `UserInputResponseReason` (raw 1–2000 character string), without new trimming semantics.

```diff
// MODIFY packages/contracts/src/orchestratorMcp.ts:193–214 and :489–496
@@ OrchestratorMcpDelegateTaskResult
   waitTimedOut: Schema.Boolean.annotate({
     description:
       "True only on that mode=wait call when timeoutMs elapsed. The timeout does not cancel the child. Later task_status reads return false and use status for liveness.",
   }),
+  pendingRequestIds: Schema.optional(Schema.Array(RuntimeRequestId)),
@@ OrchestratorMcpThreadWaitResult
   timedOut: Schema.Boolean,
+  pendingRequestIds: Schema.optional(Schema.Array(RuntimeRequestId)),
```

No task status or `workState` enum change. Preserve `working | waiting_for_children | result_available`; `pendingRequestIds` is additional actionable state, not completion. Keep request status values `pending | resolved | expired | cancelled`; omit `pendingRequestIds` when none, never claim `waitTimedOut: true` for a question release. Current local reads return actual resolved status/provenance. Old remote reads without `status` remain unknown, never default to pending/resolved.

Input scenario matrix (service validation, before any remote request):

| Scenario                                                     | Result / observable proof                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| Default or `scope:"thread"`, local `threadId` omitted        | Caller thread; existing `{requestIds}` shape retained              |
| Single-thread list/read/respond with `host`, no `threadId`   | `target_required`; remote-call count zero                          |
| `scope:"launched"` from a thread, no foreign filter          | Caller identity only; local + connected/explicit hosts             |
| Launched combined with `threadId` or `host`                  | `invalid_request`; no fan-out; pass `hosts:[host]` instead         |
| `hosts` or foreign-launcher fields with thread scope         | `invalid_request`                                                  |
| Only one foreign-launcher field                              | `invalid_request`                                                  |
| Foreign filter with authenticated thread scope               | `invalid_request`, even if IDs equal the caller                    |
| Foreign filter from outside client, with host/hosts/threadId | `invalid_request`; destination must never recurse/fan-out          |
| Outside client launched list without foreign filter          | `target_required`; no fabricated caller                            |
| Foreign environment ID equals destination environment ID     | `invalid_request`; local launcher records use `environmentId:null` |

## 2. Pending service — NEW `apps/server/src/mcp/PendingQuestionsMcpService.ts`

Before: **N/A, file absent**. Current behavior to move is `thread/handlers.ts:52–72,203–232` (excerpt in §3). Use `Context.Service` with its interface inline, `make` private, and `Layer.effect`, matching `HostThreadsMcpService.ts:142–145,168–201,381` and the current Effect service convention. `hostFailure` is already exported at `HostThreadsMcpService.ts:49–68`; import that mapper, do not duplicate it or change host-thread policy.

### Full new-file sketch

This sketch uses wp1's named schemas/types and its amended `threadAccess.dispatchFailure` (already-answered maps to `invalid_request`). No handler owns discovery, retry, persistence, or response stamping.

```ts
import {
  OrchestratorMcpFailure,
  OrchestratorMcpLaunchedQuestionsResult,
  type OrchestratorMcpPendingRequestListResult,
  OrchestratorMcpPendingRequestReadResult,
  OrchestratorMcpPendingRequestRespondResult,
  RuntimeRequestId,
  type OrchestratorMcpPendingRequestListInput,
  type OrchestratorMcpPendingRequestReadInput,
  type OrchestratorMcpPendingRequestRespondInput,
  type OrchestratorMcpLaunchedQuestion,
  type UserInputRespondedBy,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { exceededDispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import { McpInvocationContext, type McpInvocationScope } from "./McpInvocationContext.ts";
import { hostFailure } from "./HostThreadsMcpService.ts";
import {
  assertLiveCaller,
  dispatchFailure,
  newCommandId,
  readCaller,
  readThread,
  unavailable,
} from "./threadAccess.ts";

const REMOTE_TIMEOUT_MS = 120_000;
const QUESTION_CONCURRENCY = 4;
const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });
const invalid = (message: string) => failure("invalid_request", message);

export class PendingQuestionsMcpService extends Context.Service<
  PendingQuestionsMcpService,
  {
    readonly list: (
      scope: McpInvocationScope,
      input: OrchestratorMcpPendingRequestListInput,
    ) => Effect.Effect<OrchestratorMcpPendingRequestListResult, OrchestratorMcpFailure>;
    readonly read: (
      scope: McpInvocationScope,
      input: OrchestratorMcpPendingRequestReadInput,
    ) => Effect.Effect<OrchestratorMcpPendingRequestReadResult, OrchestratorMcpFailure>;
    readonly respond: (
      scope: McpInvocationScope,
      input: OrchestratorMcpPendingRequestRespondInput,
    ) => Effect.Effect<OrchestratorMcpPendingRequestRespondResult, OrchestratorMcpFailure>;
  }
>()("t3/mcp/PendingQuestionsMcpService") {}

const withoutHost = <T extends { readonly host?: unknown }>(input: T): Omit<T, "host"> => {
  const { host: _host, ...rest } = input;
  return rest;
};

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
  // scope.environmentId is authenticated by McpSessionRegistry (:100–101).
  const inScope = <A, E, R>(scope: McpInvocationScope, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(McpInvocationContext, scope),
      Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
    );
  const authorize = (scope: McpInvocationScope, writes: boolean) =>
    inScope(
      scope,
      readCaller().pipe(
        Effect.tap(assertLiveCaller),
        Effect.flatMap((caller) => {
          if (caller.scope.client?.access === "read-only")
            return Effect.fail(
              failure("capability_denied", "Reaching an SSH host needs write-capable MCP access."),
            );
          return writes && caller.limits.interactionMode !== "default"
            ? Effect.fail(
                failure(
                  "interaction_mode_escalation_denied",
                  "Answering on another machine needs default interaction mode; forward this question to the human.",
                ),
              )
            : Effect.succeed(caller.limits.runtimeMode);
        }),
      ),
    );
  const remote = <A, E>(
    scope: McpInvocationScope,
    host: string,
    tool: string,
    args: Readonly<Record<string, unknown>>,
    writes: boolean,
    decode: (value: unknown) => Effect.Effect<A, E>,
  ) =>
    dispatch
      .callHostTool(
        { host, tool, arguments: args, writes, timeoutMs: REMOTE_TIMEOUT_MS },
        authorize(scope, writes),
      )
      .pipe(
        Effect.mapError((error) =>
          error instanceof SshRemoteDispatch.SshRemoteDispatchError ? hostFailure(error) : error,
        ),
        Effect.flatMap((raw) =>
          decode(raw).pipe(
            Effect.mapError(() =>
              failure("orchestration_error", `${host} returned a result ${tool} could not read.`),
            ),
          ),
        ),
      );
  const requireRemoteThread = (input: { host?: string; threadId?: ThreadId }) =>
    input.host !== undefined && input.threadId === undefined
      ? Effect.fail(failure("target_required", "Pass threadId for a question on another host."))
      : Effect.void;
  const readQuestion = (input: OrchestratorMcpPendingRequestReadInput) =>
    Effect.gen(function* () {
      const context = yield* readThread(input.threadId, ["runtimeRequests", "turnItems"]);
      const request = context.projection.runtimeRequests.find(
        (request) => request.id === input.requestId && request.kind === "user_input",
      );
      const item = context.projection.turnItems.find(
        (item) => item.type === "user_input_request" && item.requestId === input.requestId,
      );
      if (request === undefined || item?.type !== "user_input_request")
        return yield* invalid("The user-input request was not found.");
      return { ...context, request, item };
    });
  const localRead = (input: OrchestratorMcpPendingRequestReadInput) =>
    Effect.gen(function* () {
      const { request, item } = yield* readQuestion(input);
      return {
        requestId: request.id,
        questions: item.questions,
        status: request.status,
        ...(request.respondedBy === undefined ? {} : { respondedBy: request.respondedBy }),
        resolvedAt: request.resolvedAt === null ? null : DateTime.formatIso(request.resolvedAt),
      };
    });

  const responseIdentity = (input: OrchestratorMcpPendingRequestRespondInput) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      if (context.caller !== undefined) {
        if (input.respondedBy !== undefined)
          return yield* invalid("A thread caller cannot supply respondedBy.");
        return {
          type: "agent",
          threadId: context.caller.id,
          environmentId: null,
          title: context.caller.title,
          reason: input.reason,
        } satisfies UserInputRespondedBy;
      }
      // A1: a permitted outside client attests an origin, not a local caller.
      const origin = input.respondedBy;
      if (
        context.scope.client === undefined ||
        origin?.type !== "agent" ||
        origin.environmentId === null ||
        origin.environmentId === context.scope.environmentId ||
        origin.reason !== input.reason
      )
        return yield* invalid(
          "An outside answer needs foreign agent provenance and the same reason.",
        );
      return origin;
    });

  const localRespond = (input: OrchestratorMcpPendingRequestRespondInput) =>
    Effect.gen(function* () {
      const respondedBy = yield* responseIdentity(input);
      const { projection } = yield* readQuestion(input);
      // Do not pre-reject resolved status here: wp1's locked dispatch owns first-answer arbitration.
      const result = yield* threads
        .dispatch({
          type: "runtime-request.respond",
          commandId: yield* newCommandId(),
          threadId: projection.thread.id,
          requestId: input.requestId,
          answers: input.answers,
          respondedBy,
        })
        .pipe(Effect.mapError(dispatchFailure));
      // wp1's dispatchFailure preserves the typed already-answered invalid_request.
      const committed = yield* threads
        .getThreadRecords(projection.thread.id, ["runtimeRequests"])
        .pipe(Effect.mapError(unavailable));
      const request = committed.runtimeRequests.find((request) => request.id === input.requestId);
      return {
        sequence: result.sequence,
        ...(request?.respondedBy === undefined ? {} : { respondedBy: request.respondedBy }),
      };
    });

  const launched = (scope: McpInvocationScope, input: OrchestratorMcpPendingRequestListInput) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const foreign =
        input.launcherThreadId !== undefined || input.launcherEnvironmentId !== undefined;
      if (input.host !== undefined || input.threadId !== undefined)
        return yield* invalid(
          "For launched questions omit threadId and host; use hosts for fan-out.",
        );
      if (
        foreign &&
        (scope.thread !== undefined ||
          input.hosts !== undefined ||
          scope.client === undefined ||
          input.launcherThreadId === undefined ||
          input.launcherEnvironmentId === undefined ||
          input.launcherEnvironmentId === scope.environmentId)
      )
        return yield* invalid(
          "Foreign launcher filters require an outside client and a foreign identity pair.",
        );
      const launcherThreadId = foreign ? input.launcherThreadId : context.caller?.id;
      const launcherEnvironmentId = foreign ? input.launcherEnvironmentId : null;
      if (launcherThreadId === undefined)
        return yield* failure(
          "target_required",
          "Launched scope needs a thread caller or a foreign launcher filter.",
        );

      const shells = yield* threads
        .listProjectThreads({ projectId: undefined, includeSubagents: true })
        .pipe(Effect.mapError(unavailable));
      const legacyIds = new Set(
        foreign
          ? []
          : (yield* threads
              .getThreadRecords(launcherThreadId, ["subagents"])
              .pipe(Effect.mapError(unavailable))).subagents
              .filter(
                (task) =>
                  task.origin === "app_owned" &&
                  task.threadId === launcherThreadId &&
                  task.childThreadId !== null,
              )
              .map((task) => task.childThreadId),
      );
      const selected = shells.filter(
        (thread) =>
          thread.deletedAt === null &&
          (thread.launcher !== undefined
            ? thread.launcher.threadId === launcherThreadId &&
              thread.launcher.environmentId === launcherEnvironmentId
            : // D1's legacy app-owned child fallback; no foreign/ordinary/native inference.
              !foreign &&
              legacyIds.has(thread.id) &&
              thread.lineage.parentThreadId === launcherThreadId &&
              thread.lineage.relationshipToParent === "subagent" &&
              thread.forkedFrom?.type === "node"),
      );
      const local = (yield* Effect.forEach(
        selected,
        (thread) =>
          Effect.gen(function* () {
            const projection = yield* threads
              .getThreadRecords(thread.id, ["runtimeRequests", "turnItems"], {
                turnItemTypes: ["user_input_request"],
              })
              .pipe(Effect.mapError(unavailable));
            const humanRequired = exceededDispatchModeLimit(context.limits, thread) !== undefined;
            return projection.runtimeRequests
              .filter((request) => request.kind === "user_input" && request.status === "pending")
              .flatMap((request) => {
                const item = projection.turnItems.find(
                  (item) => item.type === "user_input_request" && item.requestId === request.id,
                );
                return item?.type === "user_input_request"
                  ? [
                      {
                        host: null,
                        threadId: thread.id,
                        title: thread.title,
                        requestId: request.id,
                        questions: item.questions,
                        humanRequired,
                      } satisfies OrchestratorMcpLaunchedQuestion,
                    ]
                  : [];
              });
          }),
        { concurrency: QUESTION_CONCURRENCY },
      )).flat();
      // Foreign-filter requests are destination-local only: no connectedHosts lookup or recursion.
      if (foreign) return { questions: local, unavailableHosts: [] };
      const hosts = [
        ...new Set(
          [...(yield* dispatch.connectedHosts), ...(input.hosts ?? [])].map((host) => host.trim()),
        ),
      ].toSorted();
      const pages = yield* Effect.forEach(
        hosts,
        (host) =>
          remote(
            scope,
            host,
            "goat_pending_request_list",
            {
              scope: "launched",
              launcherThreadId,
              launcherEnvironmentId: scope.environmentId,
            },
            false,
            Schema.decodeUnknownEffect(OrchestratorMcpLaunchedQuestionsResult),
          ).pipe(
            Effect.flatMap((page) =>
              page.unavailableHosts.length > 0 ||
              page.questions.some((question) => question.host !== null)
                ? Effect.fail(
                    failure(
                      "orchestration_error",
                      `${host} returned a non-local foreign-launcher page.`,
                    ),
                  )
                : Effect.succeed(page),
            ),
            Effect.map((page) => ({
              questions: page.questions.map((question) => ({
                ...question,
                host,
                // Remote writes require default even if its target is also plan-mode.
                humanRequired:
                  question.humanRequired || context.limits.interactionMode !== "default",
              })),
              unavailableHosts: [] as OrchestratorMcpLaunchedQuestionsResult["unavailableHosts"],
            })),
            Effect.catch((error) =>
              Effect.succeed({
                questions: [],
                unavailableHosts: [
                  {
                    host,
                    code: error.code,
                    message: error.message,
                  },
                ],
              }),
            ),
          ),
        { concurrency: QUESTION_CONCURRENCY },
      );
      const unique = new Map<string, OrchestratorMcpLaunchedQuestion>();
      for (const question of [...local, ...pages.flatMap((page) => page.questions)])
        unique.set(
          JSON.stringify([question.host, question.threadId, question.requestId]),
          question,
        );
      return {
        questions: [...unique.values()].toSorted(
          (a, b) =>
            (a.host ?? "").localeCompare(b.host ?? "") ||
            a.threadId.localeCompare(b.threadId) ||
            a.requestId.localeCompare(b.requestId),
        ),
        unavailableHosts: pages.flatMap((page) => page.unavailableHosts),
      };
    });

  return PendingQuestionsMcpService.of({
    list: (scope, input) =>
      inScope(
        scope,
        Effect.gen(function* () {
          if (input.scope === "launched") return yield* launched(scope, input);
          if (
            input.hosts !== undefined ||
            input.launcherThreadId !== undefined ||
            input.launcherEnvironmentId !== undefined
          )
            return yield* invalid("hosts and launcher filters require scope launched.");
          yield* requireRemoteThread(input);
          if (input.host !== undefined)
            return {
              ...(yield* remote(
                scope,
                input.host,
                "goat_pending_request_list",
                withoutHost(input),
                false,
                Schema.decodeUnknownEffect(
                  Schema.Struct({
                    host: Schema.optional(Schema.String),
                    requestIds: Schema.Array(RuntimeRequestId),
                  }),
                ),
              )),
              host: input.host,
            };
          const { projection } = yield* readThread(input.threadId, ["runtimeRequests"]);
          return {
            requestIds: projection.runtimeRequests
              .filter((request) => request.kind === "user_input" && request.status === "pending")
              .map((request) => request.id),
          };
        }),
      ),
    read: (scope, input) =>
      inScope(
        scope,
        Effect.gen(function* () {
          yield* requireRemoteThread(input);
          return input.host === undefined
            ? yield* localRead(input)
            : {
                ...(yield* remote(
                  scope,
                  input.host,
                  "goat_pending_request_read",
                  withoutHost(input),
                  false,
                  Schema.decodeUnknownEffect(OrchestratorMcpPendingRequestReadResult),
                )),
                host: input.host,
              };
        }),
      ),
    respond: (scope, input) =>
      inScope(
        scope,
        Effect.gen(function* () {
          yield* requireRemoteThread(input);
          if (input.host === undefined) return yield* localRespond(input);
          const identity = yield* responseIdentity(input);
          if (identity.type !== "agent")
            return yield* invalid("A remote answer needs an agent origin.");
          const respondedBy = {
            ...identity,
            environmentId: identity.environmentId ?? scope.environmentId,
          };
          const result = yield* remote(
            scope,
            input.host,
            "goat_pending_request_respond",
            { ...withoutHost(input), respondedBy },
            true,
            Schema.decodeUnknownEffect(OrchestratorMcpPendingRequestRespondResult),
          );
          const actual = result.respondedBy;
          const confirmed =
            actual?.type === "agent" &&
            actual.threadId === respondedBy.threadId &&
            actual.environmentId === respondedBy.environmentId &&
            actual.reason === respondedBy.reason;
          return {
            ...result,
            host: input.host,
            ...(confirmed ? {} : { warning: "remote_provenance_unconfirmed" as const }),
          };
        }),
      ),
  });
});
export const layer = Layer.effect(PendingQuestionsMcpService, make);
```

### Integration constraints implemented in the sketch

1. wp1 changes the shared `threadAccess.dispatchFailure` so already-answered refusals map to `invalid_request` with responder/time. The extracted service imports it; no copied mapper, no compatibility re-export, no change to locked arbitration.
2. Legacy fallback verifies the parent's `subagents` row is `origin:"app_owned"`, has matching `childThreadId`, and belongs to the caller. `lineage`/`forkedFrom` alone also describes provider-native children. Explicit launcher always wins. `humanRequired` uses the same `exceededDispatchModeLimit` as wp2 (`DispatchModeLimit.ts:44–52`), without copied rank tables.
3. The launched query uses `{turnItemTypes:["user_input_request"]}` as `readThread` does (`threadAccess.ts:185–187`). Shell discovery is complete, not capped thread-list pages; matched projection reads have concurrency 4. `listProjectThreads` reads one shell snapshot (`ThreadManagementService.ts:569–591`). wp2's startup candidate query currently selects local launchers, so it cannot serve foreign discovery unchanged. No extra SQL/migration here. A request with no committed question item is skipped and appears on a later list.
4. Single-thread remote list decodes only the thread branch; launched decoding requires `questions` and `unavailableHosts`. An old `{requestIds}` result cannot masquerade as an empty launched page.
5. Foreign page decoding requires empty `unavailableHosts` and null inner hosts. Origin overwrites inner tags with its selected SSH alias and deduplicates `(host,threadId,requestId)`. Distinct aliases remain distinct routes even if they point to one machine.
6. `callHostTool` re-runs runtime authorization immediately before `tools/call`; the callback also reloads default interaction mode. The credential's origin thread ID cannot change; title/reason are annotation, not authority. Local response ceiling enforcement remains toolkit `writesThreads` plus locked `DispatchModeLimit`.
7. Missing or mismatched returned agent thread/environment/reason produces the warning; title equality is not identity. Preserve the actual committed remote value. Successful writes and post-commit read failures never trigger an answer retry.

### Older remotes: smallest truthful behavior

The current tools are not annotated strict. The vendored implementation decodes excess keys with `onExcessProperty: strict ? "error" : "ignore"` (`.repos/effect-smol/packages/effect/src/ai/McpServer.ts:1845–1855`), then invokes `built.handle` (`:1918–1939`). An older non-strict pending respond may discard `reason` and `respondedBy`, commit the answer, and return only `{sequence}`. Decode that old result, tag `host`, return **`warning:"remote_provenance_unconfirmed"`**, and do not claim attribution was persisted. Missing provenance proves only that it was not confirmed in the result; it does not prove the remote dropped it. A stale notification can be read on an old remote only if its old implementation supports that status; preserve any refusal. An old read without status stays unknown.

A strict old remote rejects new keys before handler execution. `callHostTool` maps its RPC refusal through `hostFailure`; **do not retry respond without reason/provenance**. Answer values remain byte-for-byte as wp1/D4 requires. For launched discovery, an old endpoint either rejects the foreign filter or ignores it and then lacks a default target thread; either error becomes that host's `unavailableHosts` entry. A syntactically successful old `{requestIds}` result fails the launched result schema and also becomes `unavailableHosts`. Never claim it searched foreign launchers successfully.

Error activation/proof: invalid/unknown alias → `invalid_request`; SSH/timeout → `host_unavailable`; caller changed → `runtime_mode_escalation_denied`; remote recognized refusal → same code; unknown remote code/malformed result → `orchestration_error` (`HostThreadsMcpService.ts:49–68,103–110`). Single-host operations fail the call; launched fan-out catches each remote error into `unavailableHosts`; local projection failure fails the entire list. The caller can read/answer valid siblings even when one host fails. Transport writes need ceiling-compatible remotes (`SshRemoteDispatch.ts:656–740`). Connected hosts are process-local; after restart explicit `hosts` is required until a host has been touched. This remains D8's residual risk, not a persistence feature.

## 3. Thread toolkit extraction and composition

### MODIFY `apps/server/src/mcp/toolkits/thread/handlers.ts`

Before (`:52–72`): `readQuestion` calls `readThread`, requires `request.kind === "user_input" && request.status === "pending"`, finds `user_input_request`, fails `invalid_request` if absent, returns `{...context,request,item}`. DELETE this function after moving wp1's evolved version into the new service. `RuntimeRequestId` is used only by this helper in today's file; delete its now-unused import (`:3`). Retain `dispatch`, `writesThread`, `readThread`, etc. for all other tools.

```ts
// Before, handlers.ts:203–232 (current complete three handlers)
goat_pending_request_list: McpToolAccess.reads((input) =>
  Effect.gen(function* () {
    const { projection } = yield* readThread(input.threadId, ["runtimeRequests"]);
    return {
      requestIds: projection.runtimeRequests
        .filter((request) => request.kind === "user_input" && request.status === "pending")
        .map((request) => request.id),
    };
  }),
),
goat_pending_request_read: McpToolAccess.reads((input) =>
  Effect.gen(function* () {
    const { item } = yield* readQuestion(input);
    return { requestId: input.requestId, questions: item.questions };
  }),
),
goat_pending_request_respond: writesThread((input) =>
  Effect.gen(function* () {
    const { threads, projection } = yield* readQuestion(input);
    const result = yield* threads.dispatch({
      type: "runtime-request.respond",
      threadId: projection.thread.id,
      commandId: yield* newCommandId(),
      requestId: input.requestId,
      answers: input.answers,
    }).pipe(Effect.mapError(dispatchFailure));
    return { sequence: result.sequence };
  }),
),
```

After — add namespace imports for `PendingQuestionsMcpService`, `McpInvocationContext`, type imports for the new inputs; place the pure predicate above `layer`, replace only these three handlers:

```ts
const pendingReachesHost = (input: OrchestratorMcpPendingRequestListInput) =>
  input.host !== undefined || (input.scope === "launched" &&
    input.launcherThreadId === undefined && input.launcherEnvironmentId === undefined);

goat_pending_request_list: McpToolAccess.readsOrReachesHost(pendingReachesHost, (input) =>
  Effect.gen(function* () {
    const service = yield* PendingQuestionsMcpService.PendingQuestionsMcpService;
    const scope = yield* McpInvocationContext.McpInvocationContext;
    return yield* service.list(scope, input);
  }),
),
goat_pending_request_read: McpToolAccess.readsOrReachesHost(
  (input: OrchestratorMcpPendingRequestReadInput) => input.host !== undefined,
  (input) => Effect.gen(function* () {
    const service = yield* PendingQuestionsMcpService.PendingQuestionsMcpService;
    const scope = yield* McpInvocationContext.McpInvocationContext;
    return yield* service.read(scope, input);
  }),
),
goat_pending_request_respond: McpToolAccess.writesThreads(
  (input: OrchestratorMcpPendingRequestRespondInput) => input.host === undefined ? [input.threadId] : [],
  (input) => Effect.gen(function* () {
    const service = yield* PendingQuestionsMcpService.PendingQuestionsMcpService;
    const scope = yield* McpInvocationContext.McpInvocationContext;
    return yield* service.respond(scope, input);
  }),
),
```

Why launched counts as reaching a host even with `hosts` omitted: connected hosts are discovered inside the service. The wrapper cannot inspect them; conservatively authorize potential SSH access, exactly as `allHosts` does. A **foreign-filter destination call** is local-only and bypasses that SSH wrapper path, but still passes `readCaller` capability validation. The remote `threadId` is never looked up on the origin. Local writes still select `[input.threadId]`, preserving preflight target ceiling and `DispatchModeLimit` injection (`McpToolAccess.ts:182–211`) including own-thread/default-target behavior. Read-only clients cannot respond even when the remote target selector is empty. Plan-mode remote respond is refused before outbound tool execution by the service's authorization callback.

### MODIFY `apps/server/src/mcp/toolkits/thread/tools.ts`

Before: `:130–150` defines `requestTarget`, duplicate question schema and `pendingRequest`. `:151–175` uses inline list/read/respond schemas; respond's success inherits `{sequence}` from `commandTool`. `commandTool.dependencies` at `:69–73` are invocation context, thread management, Crypto.

After: DELETE `requestTarget`, `question`, `pendingRequest`; remove now-unused `RuntimeRequestId`/`ProviderUserInputAnswers` imports if no other use after wp1. Import the six `OrchestratorMcpPendingRequest*Input/Result` schemas and the new service namespace. Keep `commandTool` for queue/configuration tools; introduce separate pending dependencies.

```ts
const pendingDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  PendingQuestionsMcpService.PendingQuestionsMcpService,
  Crypto.Crypto,
];
const pendingTool = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: pendingDependencies,
};
const PendingRequestListTool = Tool.make("goat_pending_request_list", {
  ...pendingTool,
  description:
    "List pending user-input questions; approvals are human-only and excluded. Omit threadId for this thread, or pass host and threadId for another machine. scope='launched' lists questions in threads you launched locally and on connected hosts plus hosts[]. unavailableHosts identifies hosts that could not be queried. Foreign launcher filters are reserved for outside-client host transport.",
  parameters: OrchestratorMcpPendingRequestListInput,
  success: OrchestratorMcpPendingRequestListResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const PendingRequestReadTool = Tool.make("goat_pending_request_read", {
  ...pendingTool,
  description:
    "Read a user-input question, including resolved status and responder when available. Pass host and threadId for a remote request. Answer a pending question with goat_pending_request_respond or forward it to the user; old remote results can lack status and provenance.",
  parameters: OrchestratorMcpPendingRequestReadInput,
  success: OrchestratorMcpPendingRequestReadResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const PendingRequestRespondTool = Tool.make("goat_pending_request_respond", {
  ...pendingTool,
  description:
    "Answer a pending user-input request with answers and a required reason (1–2000 characters). Pass host and threadId for another machine; remote writes require default interaction mode. Approval requests are human-only. Forward humanRequired questions to the user. respondedBy is reserved for outside-client host transport; thread callers must omit it. remote_provenance_unconfirmed means the remote answer succeeded but its attribution was not confirmed; do not retry the answer to fix attribution.",
  parameters: OrchestratorMcpPendingRequestRespondInput,
  success: OrchestratorMcpPendingRequestRespondResult,
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);
```

### MODIFY `apps/server/src/mcp/McpHttpServer.ts`

```diff
// Before: HostThreadsMcpService import :41; thread registration :825
+import * as PendingQuestionsMcpService from "./PendingQuestionsMcpService.ts";
-export const layerThreadToolkit = toolkitRegistration(ThreadToolkit, ThreadHandlers.layer);
+export const layerThreadToolkit = toolkitRegistration(ThreadToolkit, ThreadHandlers.layer).pipe(
+  Layer.provide(PendingQuestionsMcpService.layer),
+);
```

The service needs only `ThreadManagementService`, `SshRemoteDispatch`, plus operation-level Crypto. Those dependencies are already application-owned services. No new `ManagedRuntime`, no extra server activation layer, no dependency on `OrchestratorMcpService` to implement local question operations. Integration harnesses that provide only `ThreadHandlers.layer` must provide the new layer; existing real toolkit registration does it once. Search `ThreadHandlers.layer`, `layerThreadToolkit`, and `ThreadToolkit` before integration.

## 4. SSH launcher identity — D1 remote subset

### MODIFY `apps/server/src/mcp/toolkits/project/tools.ts`

Before (`:107–118`): `goat_thread_launch.parameters` contains `projectId?`, `scratch?`, `title`, `modelSelection?`, `runtimeMode?`, `interactionMode?`; no launcher. Add imported `OrchestratorMcpForeignLauncher`:

```diff
@@ goat_thread_launch parameters, project/tools.ts:115–118
   title: TrimmedNonEmptyString,
+  launcher: Schema.optional(OrchestratorMcpForeignLauncher).annotate({
+    description: "Reserved for an outside client's cross-environment launch; thread callers must omit it.",
+  }),
   modelSelection: Schema.optional(ModelSelection),
```

No model-supplied `via` argument. The foreign transport type has a required environment ID; null remains only in wp1's persisted local launcher type.

### MODIFY `apps/server/src/mcp/toolkits/project/handlers.ts`

Before (`:59–64`) loads `readCaller`, destructures `caller`, generates IDs; launch input at `:138–159` has no launcher in current source. wp1 will add the local authenticated launcher at this launch input.

```diff
@@ project/handlers.ts:60–64, before IDs, scratch project creation, workspace checks, attachment claims
   const context = yield* readCaller();
   const { caller } = context;
+  if (input.launcher !== undefined && (context.scope.thread !== undefined ||
+      context.scope.client === undefined || input.launcher.environmentId === context.scope.environmentId))
+    return yield* new OrchestratorMcpFailure({
+      code: "invalid_request",
+      message: "launcher is accepted only from an outside client naming a foreign environment.",
+    });
@@ ThreadMessageIntake.launchThread input, project/handlers.ts:138–159, replacing wp1 local launcher expression
+  ...(caller !== undefined ? {
+    launcher: { threadId: caller.id, environmentId: null, via: "thread_launch" as const },
+  } : input.launcher !== undefined ? {
+    launcher: { ...input.launcher, via: "ssh_thread_launch" as const },
+  } : {}),
```

Activation/proof: thread caller supplies `launcher` → `invalid_request`, launch/managed-folder/workspace side-effect counts zero. Outside caller with foreign pair → `ThreadMessageIntake.launchThread` receives that identity with `via:"ssh_thread_launch"`; committed thread/shell readback retains it. Outside caller without launcher retains ordinary launch behavior. Origin IDs never become local lineage parent or initial-message sender. wp1's `ThreadLaunchService`/`ThreadMessageIntake` input and `thread.create` propagation already accept the persisted launcher type; **N/A additional schema or persistence edit** in those files.

### MODIFY `apps/server/src/mcp/toolkits/ssh/handlers.ts`

Before at `:56` captures `caller = yield* check`, and `:61–74` constructs the `SshLaunchInput`. Capture no model argument for this origin:

```diff
@@ ssh/handlers.ts:70–74, launchThread input
   modelSelection: input.modelSelection ?? caller.caller?.modelSelection,
   runtimeMode,
   callerRuntimeMode: caller.limits.runtimeMode,
   interactionMode: input.interactionMode,
+  ...(caller.scope.thread === undefined ? {} : { launcher: {
+    threadId: caller.scope.thread.threadId,
+    environmentId: caller.scope.environmentId,
+  } }),
```

`scope.environmentId` is the server's real identity, stamped by registry using `ServerEnvironment.getEnvironmentId` (`McpSessionRegistry.ts:100–101`), not a host alias or thread ID. No second environment identity lookup is necessary. Outside-origin SSH launches omit launcher because they have no origin thread; do not invent one.

### MODIFY `apps/server/src/sshRemote/SshRemoteDispatch.ts`

Before `SshLaunchInput:97–112` has no launcher; remote call at `:611–623`:

```ts
const launched = (yield *
  callRemote({
    ...remote,
    tool: "goat_thread_launch",
    arguments: {
      projectId: project.id,
      title: input.title,
      workspaceStrategy,
      runtimeMode: input.runtimeMode,
      ...(input.interactionMode === undefined ? {} : { interactionMode: input.interactionMode }),
      ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
      ...(input.message === undefined ? {} : { message: input.message }),
    },
  })) as { readonly threadId?: string };
```

```diff
// After, import type OrchestratorMcpForeignLauncher from @t3tools/contracts
@@ SshLaunchInput:110–112
   readonly callerRuntimeMode: RuntimeMode;
   readonly interactionMode?: ProviderInteractionMode | undefined;
+  readonly launcher?: OrchestratorMcpForeignLauncher | undefined;
@@ remote goat_thread_launch arguments:614–622
   runtimeMode: input.runtimeMode,
+  ...(input.launcher === undefined ? {} : { launcher: input.launcher }),
```

Do not add a second thread launch attempt in this phase. A non-strict old remote ignores launcher and creates an untracked thread; the caller can still use returned `(host,threadId)` with read/wait, but launched discovery cannot recover that thread by foreign launcher. A strict remote rejects launcher before handler execution and the original call fails. Current `callRemote` converts bridge errors into `ssh_failed` or a generic `remote_refused` (`:413–435`); the bridge retains only `kind:"rpc"`, with no typed RPC code or rejected-key location (`AcpMcpStdioBridge.ts:34–51,181–190`). Thus origin code cannot distinguish an unknown-key decode rejection from a handler failure/ambiguous response by structured evidence.

The decoder does run before handlers: `McpServer.ts:1853–1855,1919–1929` invokes toolkit parameter decoding; `:1873–1875` translates parameter-origin validation errors to `InvalidParams`. A future safe fallback would need a retained structured **parameter-origin unknown `launcher` key** error, proven before `ThreadMessageIntake.launchThread`; then reauthorize and retry exactly once without launcher, stating origin tracking was lost. `-32602` alone is insufficient (also unknown tool/other invalid parameters), and message substring matching is insufficient. **Chosen default per the task's “else omit”: omit automatic fallback, not the new launcher argument.** Do not add bridge error variants/capability negotiation merely for this roadmap phase. Failure after create, timeout, HTTP error, invalid result, or unknown tool never retries launch. Tests count remote thread creates and tool calls.

## 5. Thread waits — MODIFY `apps/server/src/orchestration-v2/ThreadManagementService.ts`

### Before

```ts
// :134–145
export interface ThreadManagementWaitInput {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly runId?: RunId;
  readonly timeoutMs: number;
}
export interface ThreadManagementWaitResult {
  readonly threadId: ThreadId;
  readonly run: OrchestrationV2Run | null;
  readonly timedOut: boolean;
}
// :691–709
const afterSequence =
  yield * orchestrator.getThreadEventSequence(input.threadId).pipe(Effect.mapError(loadError));
const target = yield * getProjectThreadRecords(input, ["runs"]);
const selectedRun =
  input.runId === undefined
    ? latestRun(target)
    : target.runs.find((candidate) => candidate.id === input.runId);
// ... run-not-found/idle branches ...
if (isTerminalRunStatus(selectedRun.status)) {
  return { threadId: input.threadId, run: selectedRun, timedOut: false };
}
// :715–747 subscribes only run.updated and thread.deleted, re-reads ["runs"],
// and filters isTerminalRunStatus(run.status).
// :763–766 timeout reconciliation
return { threadId: input.threadId, run, timedOut: !isTerminalRunStatus(run.status) };
// :773 internal settle caller
const { run } = yield * waitForThread({ ...input, timeoutMs: SETTLE_AFTER_RUN_WAIT_MS });
```

Runtime requests have `nodeId`, **no `runId`** (`orchestrationV2.ts:1029–1047`); execution nodes carry `runId` (`:626–630`). Do not compare request ID to a run or release for any request in the thread. Read nodes and join request.nodeId → node.id → selectedRun.id. This covers pending requests before their turn item arrives.

### After — interfaces and reusable pure helper

```diff
@@ imports :1–31
+  type RuntimeRequestId,
@@ ThreadManagementWaitInput
   readonly timeoutMs: number;
+  /** Internal settle wait must still wait for a terminal run. Not an MCP input. */
+  readonly releaseOnPendingQuestion?: boolean;
@@ ThreadManagementWaitResult
   readonly timedOut: boolean;
+  readonly pendingRequestIds?: ReadonlyArray<RuntimeRequestId>;
```

Add this exported helper next to existing `latestRun` helpers in **the same service module**, consumed by this service and `OrchestratorMcpService`. No new file or duplicated runtime logic in contracts.

```ts
export function pendingUserInputRequestIdsForRun(
  records: Pick<OrchestrationV2ThreadProjection, "nodes" | "runtimeRequests">,
  runId: RunId,
): ReadonlyArray<RuntimeRequestId> {
  const nodes = new Set(
    records.nodes.filter((node) => node.runId === runId).map((node) => node.id),
  );
  return records.runtimeRequests
    .filter(
      (request) =>
        request.kind === "user_input" && request.status === "pending" && nodes.has(request.nodeId),
    )
    .map((request) => request.id)
    .toSorted();
}
```

Replace `waitForThread` body (`:681–767`) with the following body, preserving loadError and named function shape:

```ts
Effect.gen(function* () {
  const loadError = (cause: unknown) =>
    new ThreadManagementProjectionLoadError({
      projectId: input.projectId,
      threadId: input.threadId,
      cause,
    });
  const afterSequence = yield* orchestrator
    .getThreadEventSequence(input.threadId)
    .pipe(Effect.mapError(loadError));
  const target = yield* getProjectThreadRecords(input, ["runs", "nodes", "runtimeRequests"]);
  const selectedRun =
    input.runId === undefined
      ? latestRun(target)
      : target.runs.find((run) => run.id === input.runId);
  if (input.runId !== undefined && selectedRun === undefined)
    return yield* new ThreadManagementRunNotFoundError({
      threadId: input.threadId,
      runId: input.runId,
    });
  if (selectedRun === undefined) return { threadId: input.threadId, run: null, timedOut: false };
  const state = (records: typeof target, run: OrchestrationV2Run) => {
    const pendingRequestIds =
      input.releaseOnPendingQuestion === false || isTerminalRunStatus(run.status)
        ? []
        : pendingUserInputRequestIdsForRun(records, run.id);
    return {
      run,
      pendingRequestIds,
      ready: isTerminalRunStatus(run.status) || pendingRequestIds.length > 0,
    };
  };
  const result = (
    current: ReturnType<typeof state>,
    timedOut: boolean,
  ): ThreadManagementWaitResult => ({
    threadId: input.threadId,
    run: current.run,
    timedOut,
    ...(current.pendingRequestIds.length === 0
      ? {}
      : { pendingRequestIds: current.pendingRequestIds }),
  });
  const initial = state(target, selectedRun);
  if (initial.ready) return result(initial, false);
  const reload = () =>
    getProjectThreadRecords(input, ["runs", "nodes", "runtimeRequests"], {
      runIds: [selectedRun.id],
    }).pipe(
      Effect.flatMap((records) => {
        const run = records.runs.find((run) => run.id === selectedRun.id);
        return run === undefined
          ? Effect.fail(
              new ThreadManagementRunNotFoundError({
                threadId: input.threadId,
                runId: selectedRun.id,
              }),
            )
          : Effect.succeed(state(records, run));
      }),
    );
  const waited = Option.flatten(
    yield* Stream.mergeAll(
      [
        orchestrator.streamStoredEventsFrom({
          threadId: input.threadId,
          afterSequence,
          eventType: "run.updated",
        }),
        orchestrator.streamStoredEventsFrom({
          threadId: input.threadId,
          afterSequence,
          eventType: "thread.deleted",
        }),
        orchestrator.streamStoredEventsFrom({
          threadId: input.threadId,
          afterSequence,
          eventType: "runtime-request.updated",
        }),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Stream.mapError(loadError),
      Stream.filter(
        (stored) =>
          stored.event.type !== "run.updated" || stored.event.payload.id === selectedRun.id,
      ),
      Stream.mapEffect(reload),
      Stream.filter((current) => current.ready),
      Stream.runHead,
      Effect.timeoutOption(Duration.millis(Math.max(1, input.timeoutMs))),
    ),
  );
  if (Option.isSome(waited)) return result(waited.value, false);
  const current = yield* reload();
  return result(current, !current.ready);
});
```

`ProjectionRecordFilter.runIds` filters run rows, not nodes/runtime requests (`ProjectionStore.ts:304–313,3105–3120`), so the helper's join remains necessary; never assume SQL has filtered requests to this run. Request updates for other runs may trigger one read, but never release. Nodes are committed with the runtime request in provider ingestion; malformed/orphan node references do not guess a run. If a future adapter splits node creation from request persistence, add a scoped node event then; current requirement/event path is request updates.

```diff
@@ settleAfterRun, ThreadManagementService.ts:773
-const { run } = yield* waitForThread({ ...input, timeoutMs: SETTLE_AFTER_RUN_WAIT_MS });
+const { run } = yield* waitForThread({
+  ...input, timeoutMs: SETTLE_AFTER_RUN_WAIT_MS, releaseOnPendingQuestion: false,
+});
```

Without that private opt-out, an own-thread settle request would silently stop waiting when the agent asks a question and never settle after eventual completion. Preserve existing terminal behavior for this internal consumer. The public MCP tool does not expose the opt-out.

### MODIFY `apps/server/src/mcp/OrchestratorMcpService.ts` thread-wait mapping

```diff
// Before/after :2527–2532
   return {
     threadId: input.threadId,
     runId: result.run?.id ?? null,
     status: result.run?.status ?? "idle",
     timedOut: result.timedOut,
+    ...(result.pendingRequestIds === undefined ? {} : { pendingRequestIds: result.pendingRequestIds }),
   } satisfies OrchestratorMcpThreadWaitResult;
```

`HostThreadsMcpService` decodes this optional field and spreads it as-is, tagging host; older remotes omit it and keep old terminal-only semantics. The existing wait answer budget (`HostThreadsMcpService.ts:336–350`) is unchanged: remote timeout result vs transport unavailability remains distinct. Current clients are MCP consumers, not WS/mobile UI: **N/A client component edit**. No persisted wait state or adapter change.

## 6. Delegate waits — MODIFY `apps/server/src/mcp/OrchestratorMcpService.ts`

### Before

```ts
// :102–107
const TASK_WAKE_EVENTS = [
  { thread: "parent", eventType: "subagent.updated" },
  { thread: "child", eventType: "run.updated" },
  { thread: "child", eventType: "subagent.updated" },
  { thread: "child", eventType: "provider-thread.updated" },
] as const;
// readTask :1291–1295
const childControls = yield* threadManagement.getThreadRecords(
  task.childThreadId, ["runs", "messages", "contextTransfers", "subagents", "providerThreads"],
  { messageRoles: ["user"] },
).pipe(Effect.mapError(threadManagementFailure));
// waitForTask :1449–1467
const initial = yield* readTask(scope, taskId, false, true);
if (isTerminalTaskStatus(initial.status)) return Option.some(initial);
// ... streams constructed from TASK_WAKE_EVENTS ...
Stream.mapEffect(() => readTask(scope, taskId, false, true)),
Stream.filter((result) => isTerminalTaskStatus(result.status)),
// delegateTask :1962–1970
const waited = yield* waitForTask(scope, taskId, timeoutMs);
if (Option.isSome(waited)) {
  return waited.value;
}
// timeout-only wake upgrade follows, best effort, with existing warning catches
// :2005
return yield* readTask(scope, taskId, true, true);
```

### After

```diff
@@ TASK_WAKE_EVENTS
   { thread: "child", eventType: "provider-thread.updated" },
+  { thread: "child", eventType: "runtime-request.updated" },
@@ childControls fields :1293
-  ["runs", "messages", "contextTransfers", "subagents", "providerThreads"],
+  ["runs", "messages", "contextTransfers", "subagents", "providerThreads", "nodes", "runtimeRequests"],
@@ readTask, before response :1377
+const pendingRequestIds = isTerminalTaskStatus(status) ? [] : [...new Set(
+  childControls.runs
+    .filter((run) => !ThreadManagementService.isTerminalRunStatus(run.status))
+    .flatMap((run) => ThreadManagementService.pendingUserInputRequestIdsForRun(childControls, run.id)),
+)].toSorted();
@@ readTask response :1398
   waitTimedOut,
+  ...(pendingRequestIds.length === 0 ? {} : { pendingRequestIds }),
@@ waitForTask :1450
-if (isTerminalTaskStatus(initial.status)) return Option.some(initial);
+if (isTerminalTaskStatus(initial.status) || (initial.pendingRequestIds?.length ?? 0) > 0)
+  return Option.some(initial);
@@ waitForTask :1464
-Stream.filter((result) => isTerminalTaskStatus(result.status)),
+Stream.filter((result) => isTerminalTaskStatus(result.status) || (result.pendingRequestIds?.length ?? 0) > 0),
@@ delegateTask :1963–1965
-if (Option.isSome(waited)) {
+if (Option.isSome(waited) && (waited.value.pendingRequestIds?.length ?? 0) === 0) {
   return waited.value;
 }
@@ timeout-only wake upgrade comment :1966–1969
-// The blocking wait timed out, so it no longer owns delivery: upgrade
+// Timeout or a pending question releases the blocking wait: upgrade
 // the task so a later terminal wakes the parent even mid-turn. Best
 // effort; on failure the settled_only policy still wakes a settled
 // parent.
@@ :2005, after the existing best-effort wake-policy dispatch/catches
-return yield* readTask(scope, taskId, true, true);
+if (Option.isSome(waited)) return waited.value; // question release; waitTimedOut stays false
+const final = yield* readTask(scope, taskId, false, true);
+return { ...final, waitTimedOut: !isTerminalTaskStatus(final.status) &&
+  (final.pendingRequestIds?.length ?? 0) === 0 };
```

**Task question ownership:** unlike `goat_thread_wait`, the brief requires a pending question in the **child thread**, not merely the originally delegated run. The helper above includes pending requests belonging to nonterminal child runs and deduplicates IDs. This excludes orphan requests and stale questions in historical terminal runs while allowing a nested-work continuation in this child thread to release a still-live task. Do not recurse into descendant threads: those have their own launcher/notification path. Keep `childRunId` identifying the original delegated run and all completion/cohort logic intact.

Preserve global sequence capture **before** `readTask` (`:1444–1448`), so a question between the read and subscription replays. Read-and-filter at entry covers questions already pending. A resolution that commits before the re-read results in no pending IDs and waiting continues normally; a result already returned is an observation, not a lease. The caller reads the request before responding, as D5 requires.

Keep the existing `delegated_task.wake-policy` command and `stableCommandId` operation `delegate-task-wake-policy` (`:1971–1980`), and all three existing warning outcomes (`:1983–2003`). It is the **same upgrade on question release and timeout**, not a second task, run, or completion wake. Do not acknowledge an active task's completion just because a question released the wait (`readTask` already gates acknowledgment on terminal status, `:1400–1405`). Async tasks keep `completionWake:"always"`; native provider subagents are not affected. Wake upgrade failures return the question IDs with a warning log and retained `settled_only`, matching D7's timeout behavior.

After timeout, a final committed projection containing a question returns `waitTimedOut:false` and IDs, with the wake already upgraded. If it has become terminal, timeout is false; otherwise timeout is true. No cancellation, task-status enum, delivery-state enum, or stored-event enum is added.

## 7. Model instructions and descriptions

### MODIFY `packages/provider-core/src/server/orchestrationInstructions.ts`

Before `:14–16` ends the introductory bullet list and begins workspace guidance; there is no shared question policy. Insert exactly three sentences before `### Choose the workspace`:

```diff
@@ :14–16
 - To mention another thread to the user, link it as \`[title](t3-thread://v1/<threadId>)\` with its exact \`threadId\`, not URL-encoded. T3 Code opens the thread in the app and shows its current title.
+
+Questions from threads you launched in this environment arrive as notifications; read them with \`goat_pending_request_read\` and decide with \`goat_pending_request_respond\` (\`reason\` required), or forward them to the user; approval requests and questions marked \`humanRequired\` are human-only.
+After asking an async question, end the turn so the answer can arrive as a message, never sleep-poll; provider-native blocking question tools resume when answered.
+\`goat_thread_wait\` and \`delegate_task(mode:"wait")\` also release on a pending user-input question with \`pendingRequestIds\`; for SSH-launched threads use \`host\` with the pending tools or \`scope:"launched"\` plus \`hosts\` to discover remote questions, since automatic remote notifications require the separate reverse-report channel.
```

In the current SSH paragraph (`:30`), extend the list “pass the same `host` to `goat_thread_wait`, `goat_thread_read`, `goat_thread_send`, `goat_thread_interrupt`, and `goat_thread_list`” to include `goat_pending_request_list/read/respond`. Keep “The remote thread cannot report back to you on its own” scoped to this unit, consistent with D9; do not promise remote automatic notifications.

### MODIFY `apps/server/src/mcp/toolkits/orchestrator/tools.ts`

Before delegate description at `:76` says `mode='wait' blocks until completion or timeout`; thread-wait description at `:248` says “Wait for a T3 thread run to reach a terminal durable state.” Replace those exact clauses:

```diff
@@ DelegateTaskTool description :76 (replace clause, retain rest)
-mode='wait' blocks until completion or timeout.
+mode='wait' releases on completion, timeout, or a pending user-input question in its child thread; pendingRequestIds identifies questions to read and answer or forward, and question release is not waitTimedOut.
@@ ThreadWaitTool description :248 (replace first sentence, retain rest and ON_ANOTHER_MACHINE)
-Wait for a T3 thread run to reach a terminal durable state.
+Wait for a T3 thread run to reach a terminal durable state or need user input; pendingRequestIds identifies questions that release the wait with timedOut=false.
```

Thread-tool pending descriptions are specified in §3. Contract input annotations for delegate timeout (`orchestratorMcp.ts:183–186`) still describe only timeout semantics and remain accurate; add one sentence to its `mode` description (`:180`) naming pending-question release if desired, using the same wording, without a new mode enum.

Instruction consumers: `t3OrchestrationSystemPrompt`, `t3OrchestrationPromptForFirstRun`, `t3AcpPromptWithInstructions` in the same provider-core module; Codex additional context (`apps/server/src/provider/CodexDeveloperInstructions.ts:218`) and adapter tests (`apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts:511,515,2751`); other providers receive existing shared instructions. Search found **no full-text snapshot assertion** for this shared block. `orchestrationInstructions.test.ts` uses substring assertions (`:10–27`) and direct equality to the live constant (`:49–52`); add behavior-relevant text assertions, not an entire new snapshot. Codex adapter assertions inspect selected strings in injected context; no snapshot refresh is required. All provider adapters/WS/mobile/desktop routes are **N/A implementation edit**, because injection and request resolution are existing shared paths.

## 8. Focused tests — exact files, harnesses, names, and assertions

Every new test observes service behavior or persisted results. Use `@effect/vitest` `it.effect`, Deferreds/queues, stored events and worker drain. No `Effect.sleep`, native timers, poll loops, or timeout-as-readiness. TestClock advancement is permitted only to test timeout semantics after a subscription Deferred is completed.

### NEW `apps/server/src/mcp/PendingQuestionsMcpService.test.ts`

Before: N/A, absent. New-file skeleton:

```ts
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Ref from "effect/Ref";
import * as Crypto from "@effect/platform-node/NodeCrypto";
import * as PendingQuestionsMcpService from "./PendingQuestionsMcpService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { exceededDispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
// Import contract fixture IDs/types and McpInvocationScope as in HostThreadsMcpService.test.ts.
// runService(options, body): acquire the real PendingQuestionsMcpService.layer, supplying
// NodeCrypto.layer, mocked thread storage/dispatch, and mocked remote transport only.
// Build full typed shell/request/item/node fixtures; do not mock list/read/respond.
// callHostTool records call, runs supplied authorize, then answers the fake endpoint.
// Expose origin-local dispatch commands and destination call args for assertions.
describe("PendingQuestionsMcpService", () => {
  // Add the following concrete tests to the harness, one it.effect per row.
});
```

Harness copied structurally from `HostThreadsMcpService.test.ts:67–132`, replacing the irrelevant mocked local `OrchestratorMcpService` with storage operations `getThreadShell`, `getThreadRecords`, `getProjectThreadRecords`, `listProjectThreads`, `dispatch`. Layer must provide no live database/server. Scope thread is active/unarchived with matching provider instance, configurable runtime/interaction mode; outside fixture has `thread:undefined`, authenticated client with configured ceiling and destination environment ID. For local respondedBy assertions dispatch commits a request fixture before returning; locked arbitration behavior is tested through the real orchestrator in wp1/toolkit integration, not simulated here as proof of locking.

| Exact test name                                                                  | Observable assertions                                                                                                                              |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `keeps default local list restricted to pending user_input`                      | `{requestIds}`, no approvals/resolved/cancelled/expired; no remote calls                                                                           |
| `reads resolved local questions without inventing a responder`                   | actual status/time; provenance present only if stored; wp1 resolved read retained                                                                  |
| `routes remote list and read without host and tags decoded results`              | Exact tool names/arguments; `writes:false`; host removed; return host origin alias                                                                 |
| `requires threadId for single-thread remote pending tools`                       | Table list/read/respond; target_required and zero tool executions                                                                                  |
| `answers locally with authenticated agent provenance and unchanged answer bytes` | runtime-request.respond has caller ID/null environment/reason, answer values identical; result reads committed provenance                          |
| `rejects forged provenance from a thread caller`                                 | invalid_request; no dispatch or remote execution                                                                                                   |
| `accepts foreign provenance only from an authenticated outside client`           | A1 guard table: missing client/user provenance/null or same environment/reason mismatch rejected; valid pair stored                                |
| `refuses remote respond in plan mode and after a mid-call mode change`           | callback reauthorization; no outbound write; interaction/runtime code preserved                                                                    |
| `warns without retrying when an older remote cannot confirm provenance`          | `{sequence}` accepted; warning returned; exactly one call; mismatched returned identity also warns                                                 |
| `preserves host failures and rejects malformed remote results`                   | Table all hostFailure reasons/known and unknown codes; invalid shapes fail orchestration_error                                                     |
| `lists only matching local launchers including legacy app-owned children`        | environment null and caller ID match; approval/native/foreign/unrelated launchers excluded; legacy requires app_owned parent row                   |
| `fans launched questions out once to connected and explicit hosts`               | union/dedup; exact `{scope:"launched",launcherThreadId:<caller>,launcherEnvironmentId:<origin env>}`; no host/hosts/targetThread fields forwarded  |
| `bounds launched host concurrency and retains partial success`                   | Ref active/max counters with Deferred gate; 5+ hosts, max <=4; release first cohort deterministically; successful questions plus failed host entry |
| `filters foreign launchers locally without recursive fan-out`                    | Outside pair exact environment+thread match; no connectedHosts read/callHostTool; result inner host null                                           |
| `rejects invalid scope and foreign filter combinations before fan-out`           | Full §1 guard table; zero tool calls                                                                                                               |
| `marks above-ceiling and remote plan questions humanRequired`                    | Local runtime/interaction ceiling; remote outside runtime ceiling; origin plan forces remote humanRequired because response guard prevents write   |
| `reports unsupported launched discovery instead of a false empty page`           | Old `{requestIds}` and refusal become unavailableHosts; foreign page with non-null inner host/nonempty unavailableHosts rejected                   |

For concurrency proof, each first-cohort remote effect increments a Ref and completes a `firstFourStarted` Deferred when count reaches four, then blocks on `releaseFirstCohort`. Fork the list, await that Deferred, inspect max/count, release, then join. Failure injected on one host must not cancel siblings. No sleeping to “let calls start”. Add assertion that a local storage failure aborts before any host calls.

### MODIFY `apps/server/src/orchestration-v2/ThreadManagementService.test.ts`

Before harness anchors: timeout table `:352–423` uses subscription Deferred + TestClock; event test `:425–474` uses Queue and Deferred. Existing fixture projections include only `runs`; add `nodes:[]`, `runtimeRequests:[]` to **every wait fixture** because the new method reads them. Before/after example:

```diff
@@ fixture at :451–454 (also :366–369 timeout fixture)
   thread: { id: threadId, projectId, deletedAt: null },
   runs: [{ id: runId, status }],
+  nodes: [],
+  runtimeRequests: [],
```

Add named tests:

| Exact test name                                                              | Harness / proof                                                                                                                                                   |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `waitForThread returns a pending user_input at entry for the selected run`   | Request.nodeId joins selected node.runId; running status, timedOut false, sorted IDs; stream never subscribed                                                     |
| `waitForThread releases on persisted runtime-request.updated`                | Separate event-type Queue streams; await request-stream subscribed Deferred; set committed node/request fixture then offer event; Fiber.join without run terminal |
| `waitForThread replays a question between sequence capture and subscription` | Inject committed event in first-record-read gate; stream fake replays afterSequence; no lost wake                                                                 |
| `waitForThread ignores approvals and another run's pending question`         | Process ignored-event read Deferred; fiber still pending; selected question then releases; no heuristic sleep                                                     |
| `waitForThread final timeout read prefers a pending question over timeout`   | Extend timeout table with pending request fixture, subscription Deferred + TestClock; false and IDs                                                               |
| `waitForThread keeps terminal and missing-run behavior`                      | Existing terminal/idle/deleted/missing cases remain; optional field omitted                                                                                       |
| `settleAfterRun still waits through a question and settles on completion`    | Internal opt-out; request event read Deferred, no settle dispatch; terminal event → one thread.settle                                                             |

The event `runtime-request.updated` predicate targets the same thread; request/node fixtures have selected run IDs. Assertions include an orphan-node request excluded. Existing “only when the run updates” test still expects unrelated-run updates not to read; request updates have their own explicitly tested behavior.

### MODIFY `apps/server/src/mcp/OrchestratorMcpService.test.ts`

Before: service tests start at `:43`, provider-resolution layers at `:763+`; `readTask` mocks currently provide `runs/messages/contextTransfers/subagents/providerThreads`. Extend relevant child-record fixtures with nodes/runtimeRequests rather than making production code default missing arrays to empty. Use real service, mocked storage/providers, persisted-event-shaped stream queues.

Add `delegate wait returns pending questions at entry and upgrades completion wake`, `delegate wait releases on child runtime-request.updated without terminal status`, `delegate wait ignores approvals and historical terminal-run questions`, `delegate question release keeps result when wake upgrade fails`, and `delegate timeout final read with a question does not claim timeout`. Assert pending IDs, `waitTimedOut:false`, nonterminal status unchanged, one `delegated_task.wake-policy` with `always`, no cancel/acknowledge; rejected upgrade logs existing outcome and still returns IDs. Use a Deferred marking subscription and a Deferred marking dispatch persistence, plus TestClock only in the timeout test.

### MODIFY `apps/server/src/mcp/OrchestratorMcpToolkit.integration.test.ts`

Before: real MCP toolkit layers composed at `:676–692`; `server.callTool` decode at `:760–770`; `CodexOrchestratorReplayHarness` imported at `:55`; the existing `waitForProjection` helper `:409–426` **sleep-polls**. Do not reuse it for new tests and do not extend its polling. Add a standalone test with real Orchestrator/ThreadManagement/EffectWorker layers and MCP registration using the existing replay harness; configure child `startTurn` to emit a Codex-shaped runtime request + node + question item and signal a persisted-request milestone. Register wp2 `QuestionEscalationService` once in this integration layer if notification assertions apply.

New test names: `delegate_task wait returns before a child question is answered`, `pending toolkit host routing preserves target authority`, and `goat_thread_wait host result retains pendingRequestIds`. First test:

1. Create/start parent with deterministic provider fixtures; drain `OrchestrationEffectWorkerV2.drain` after creation/start where needed, or await stored `run.updated` marking ready.
2. Capture global sequence before forked `server.callTool({name:"delegate_task",arguments:{mode:"wait",clientRequestId:"question-wait",task:...}})`.
3. Await stored child `runtime-request.updated` (or Deferred completed only after ingestor persistence), then drain worker. Read result with `OrchestratorMcpDelegateTaskResult` decoder; assert it returned while child run is nonterminal, `waitTimedOut:false`, IDs match the pending request, parent subagent wake is always.
4. Read via `goat_pending_request_read`, respond through real toolkit with reason, drain worker; assert committed request provenance is agent and provider response receives exact answer. Emit terminal event and await persisted completion delivery; one completion wake is retained after the blocking call released. Do not re-delegate or continue the child thread to manufacture completion.

For wrapper authority proof, call actual ThreadToolkit with mocked transport and real McpToolAccess checks: read-only host list/read refused; local cross-thread respond above ceiling refused; remote respond does not query a fake local thread sharing the remote ID, destination ceiling refusal preserved. Include mid-dispatch target-mode raise using the `McpToolAccess.race.test.ts` harness shape; inspect locked refusal and human-forward message from wp1.

Minimal required layer diff (all imports namespace style):

```diff
@@ integration layer :680
-Layer.provide(Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({})),
+Layer.provide(Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
+  connectedHosts: Effect.succeed([]),
+  // Supply callHostTool only in the explicit host test fixture.
+})),
```

The new service is provided by `McpHttpServer.layerThreadToolkit`, so do not provide a second instance. Crypto remains available from existing Node services. No additional environment service needed because origin uses authenticated scope.environmentId.

Also **MODIFY `apps/server/src/mcp/toolkits/core.test.ts`**: its registration fixture currently provides only ThreadSearch and ScheduledTaskService (`:75–79`). The new service eagerly acquires SshRemoteDispatch even for tests invoking unrelated thread tools, so supply the transport dependency once in this fixture:

```diff
@@ core.test.ts:75–79
 const layerThreadToolkit = McpHttpServer.layerThreadToolkit.pipe(
   Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
   Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
+  Layer.provide(Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
+    connectedHosts: Effect.succeed([]),
+  })),
 );
```

This file already imports SshRemoteDispatch at `:41`. Tests that exercise host routing must provide a complete fake transport in their own registration layer, rather than call an unimplemented mocked method. `ThreadManagementService` remains a pending tool dependency because the McpToolAccess wrappers themselves need it (`McpToolAccess.ts:77–79`).

### MODIFY `apps/server/src/sshRemote/SshRemoteDispatch.test.ts`

Before harness `:23–153` intercepts fetch JSON-RPC, mocks discoverHosts and `SshEnvironmentManager.layer`, counts creates, and restores globals in finally. New tests reuse that transport fixture with a current `goat_project_list` response matching the existing project, then record `goat_thread_launch.params.arguments`. No SSH/server executes.

Add `forwards authenticated launcher to remote goat_thread_launch`, `omits launcher when the origin has no thread`, `does not retry launch after a strict unknown launcher rejection`, and `does not retry launch after an ambiguous response`. Assert foreign pair plus all existing title/workspace/model/message/mode args; exactly one launch tools/call; strict fixture fails before creating thread; timeout/invalid result fixture has at most one launch side effect and no fallback. Non-strict old fixture ignores launcher and returns threadId: assert success without claiming discoverability. Input plumbing capture additionally tested below.

### MODIFY `apps/server/src/mcp/toolkits/project/handlers.test.ts`

Before existing launch attribution test at `:31+` uses real ProjectToolkit + handlers, NodeCrypto, mocked ThreadLaunch service; capture `input.launcher` alongside sender. Add `rejects supplied launcher from a thread caller before launch side effects`, `records an outside foreign launcher as ssh_thread_launch`, `keeps authenticated local launcher as thread_launch`. Assert exact service input, no side effect on invalid, persisted readback in toolkit integration (wp1 serialization proof). Extend ssh toolkit test coverage in `apps/server/src/mcp/toolkits/core.test.ts` or the integration file with `ssh launch derives origin identity from invocation scope`; capture SshLaunchInput, caller ID/environment pair, outside omission. Reuse its actual toolkit handler fixture; do not create tests that merely inspect callback source text.

### MODIFY `apps/server/src/mcp/HostThreadsMcpService.test.ts`

Before harness `runService:87–132` feeds remote responses through the authorize callback. Add `passes remote wait question IDs through schema decoding` and `accepts an older remote wait without question IDs`; assert host tag, timedOut false, exact array retained, no fabricated field on legacy response. Production code remains unchanged.

### MODIFY `packages/contracts/src/orchestratorMcp.test.ts`

Before decoders at `:15–22`, delegated result fixture `:38–55`. Import new schemas, add `decodes pending tools and optional legacy result fields`, `keeps launched results distinct from single-thread results`, and `decodes question wait IDs without changing task status`. Assert schema round-trip of complete foreign filter/provenance/warning fields, old response `{sequence}`, old read without status, host/null-host item, optional absence/presence of wait IDs; invalid reason length and malformed IDs refused. Service-only invalid combinations remain service tests, not assumed schema checks.

### MODIFY `packages/provider-core/src/server/orchestrationInstructions.test.ts`

Before substring tests at `:10–27`; no snapshot. Add:

```ts
it("explains question decisions and question-aware waits", () => {
  assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "goat_pending_request_respond");
  assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "reason");
  assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "human-only");
  assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "never sleep-poll");
  assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "pendingRequestIds");
  assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "automatic remote notifications require");
});
```

This asserts a deliberate agent contract, not implementation callback wiring. Existing instruction injection tests stay unchanged. `toolkits/orchestrator/tools.test.ts` and `CodexAdapterV2.test.ts` are consumers to inspect after text changes; no new full snapshot test or broad adapter test run required solely for prose.

## 9. Full field/type propagation inventory

Search performed for `OrchestratorMcpDelegateTaskResult`, `OrchestratorMcpThreadWaitResult`, `ThreadManagementWaitResult`, `waitForThread`, `launcher`, `respondedBy`, `pendingRequestIds`, `goat_pending_request_list/read/respond`, `user_input`, `pending/resolved/expired/cancelled`, `working/waiting_for_children/result_available`, and instruction constant/consumer names. `pendingRequestIds` has no current-source implementation before this phase. New fields do not imply adding values to existing event/task/request enums.

| Added/reused field or enum                                                                              | Creation → serialization                                                                                                  | Deserialization → every consumer / N/A                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pending `host?`                                                                                         | Tool parameter schema in contracts → MCP arguments at thread toolkit; service strips for callHostTool                     | Contract decoder → pending service route; thread wrappers readsOrReachesHost/writesThreads; destination receives no host; host tag on origin result → model; shared presentation reads tool name only, no UI field consumer                                                                                                       |
| `scope?:thread\|launched`                                                                               | Contracts → toolkit input → origin discovery/foreign destination request                                                  | Contract decoder → service validation; thread description/model; remote launched decoder rejects old thread-shaped result; N/A storage/UI because query-only                                                                                                                                                                      |
| `hosts[]?`                                                                                              | Model explicit aliases → input schema → union with dispatch.connectedHosts                                                | Service only; never forwarded to destination; unavailableHosts identifies individual failures; N/A persistence (D8 defers it)                                                                                                                                                                                                     |
| `launcherThreadId?`, `launcherEnvironmentId?`                                                           | Origin service uses authenticated caller ID + scope.environmentId → callHostTool arguments                                | Destination outside-only guard → exact persisted launcher match → launched items; reject thread callers, incomplete/nonforeign pair, wrong scope, recursion fields; N/A storage because filter-only                                                                                                                               |
| wire launch `launcher?`                                                                                 | ssh handler scope IDs → SshLaunchInput → callRemote JSON-RPC goat_thread_launch                                           | Project input OrchestratorMcpForeignLauncher decoder → outside guard → add via ssh_thread_launch → wp1 ThreadMessageIntake/ThreadLaunchService thread.create → AppThread JSON → ProjectionStore thread payload → ThreadShell builders → pending local/foreign filters, wp2 same-environment-only guard, wp4 #5 seam               |
| persisted `via:ssh_thread_launch`                                                                       | Only destination handler, not model args → existing wp1 launcher schema's accepted four values                            | wp1 command/projection/thread/shell decoders → discovery and wp2 delivery scope; existing enum full values thread_launch/create_threads/ssh_thread_launch/delegate_task; N/A new enum edit here because wp1 owns it                                                                                                               |
| pending result `requestIds`                                                                             | Local pending user_input projection or decoded single-thread remote → result schema                                       | MCP encoded structuredContent + JSON text fallback → agent/tool callers; retains old local shape; tests core/toolkit. N/A persistence                                                                                                                                                                                             |
| launched result `questions[]` inner `host:null\|alias,threadId,title,requestId,questions,humanRequired` | Local exact launcher query + pending request/turn item + ceiling check → schema → fan-out origin tags alias/OR plan guard | Destination-local result schema → origin decode/dedup/sort → model can read/respond `(host,threadId,requestId)`; wp2 uses its own same-domain question payload, no wire result dependency; N/A UI/store because query output only                                                                                                 |
| `unavailableHosts[]:{host,code,message}`                                                                | Each remote typed failure mapped via hostFailure/invalid schema → result schema                                           | Origin fan-out collection → model identifies partial failure; no local failure suppression; foreign destination must return []; N/A persistence                                                                                                                                                                                   |
| respond `reason`                                                                                        | Model input validated 1–2000 → authenticated caller provenance → remote forwarded unchanged                               | Destination validates and records via wp1 runtime-request.respond; provider live values unchanged; message answer/history text produced by wp1; read result/model and web/mobile history consumers already wp1. N/A new client edit                                                                                               |
| reserved respond `respondedBy?` (A1)                                                                    | Origin authenticated agent + reason, foreign environment for transport → respond input JSON schema                        | Outside-only destination validation → wp1 locked command/event/projection/UserInputAttachmentAnswerPayload; read/response result returns committed value; local thread rejects supplied provenance; WS overwrites user provenance as wp1. N/A new authority grant                                                                 |
| response result `respondedBy?`, `warning?:remote_provenance_unconfirmed`                                | Destination committed request readback or old remote sequence-only; origin comparison produces warning literal            | Response schema decoder → model/tool description/tests; missing/mismatch never restamped or retried; warning is query response only, not persisted. New warning enum has exactly one value; no client banner in this phase                                                                                                        |
| read `status?`, `resolvedAt?`, `respondedBy?`                                                           | wp1 local resolved/pending request → DateTime.formatIso for wire time                                                     | New remote-compatible result decoder accepts absence only for old remotes; agent must not infer missing status/provenance; existing wp1 user-history code separate; N/A new adapter/UI/storage schema in wp3                                                                                                                      |
| `pendingRequestIds?` on ThreadManagementWaitResult                                                      | Authoritative runtimeRequests + node run join at entry/event/final read → in-process result                               | OrchestratorMcpService.waitForThread result spreads → OrchestratorMcpThreadWaitResult MCP encoding → HostThreadsMcpService.decodeWait/spread host tag → model, contract/host/integration tests; settleAfterRun disables release; N/A event/store/WS/client because observation only                                               |
| `pendingRequestIds?` on OrchestratorMcpDelegateTaskResult                                               | readTask finds pending requests on live runs in backing child thread → result schema MCP encoding                         | waitForTask entry/event filter → delegateTask completion wake upgrade; taskStatus also exposes current IDs (but waitTimedOut false); sendToThread's task read at OrchestratorMcpService:2433 reads taskId only and needs no edit; orchestrator toolkit schema + service/integration/contract fixtures; N/A persistence/adapter/UI |
| private `releaseOnPendingQuestion?`                                                                     | ThreadManagementWaitInput default true; settleAfterRun explicitly false                                                   | waitForThread state predicate only; N/A MCP serialization/deserialization/public schema/storage because internal call option                                                                                                                                                                                                      |
| subscription `runtime-request.updated`                                                                  | Existing provider event ingest + EventSink commits; no new event enum                                                     | ThreadManagementService event stream; TASK_WAKE_EVENTS child stream → read authoritative state; wp2 notification stream independently uses same existing event. No wire contract change                                                                                                                                           |

Client surfaces: web/desktop/mobile continue consuming wp1 request provenance via existing projection/answer-history schemas. This phase changes agent MCP output only. Provider decision: Codex/Claude/ACP and other supported adapters retain blocking Deferred resolution, Cursor still does not support interactive approvals; no adapter behavior is widened, approvals remain excluded/human-only. Entry points: pending tools + thread wait + delegate wait and their descriptions, shared instructions; no Settings/keybinding/command-palette feature added. Remote/relay/tunnel clients all use the same server services; SSH MCP owns the host route, no baked origin. Reverse state: read resolved questions remains available, first answer wins under asking-thread lock; no one-way new lifecycle action.

Concrete inherited serialization paths (wp1 owns their edits; N/A additional wp3 edit): `apps/server/src/orchestration-v2/ThreadMessageIntake.ts:182–200` passes launch input to `ThreadLaunchService`; `apps/server/src/orchestration-v2/ThreadLaunchService.ts:836` emits `thread.create`; `apps/server/src/orchestration-v2/Orchestrator.ts:2212+` creates the persisted thread. `packages/contracts/src/orchestrationV2.ts:1997–2024` defines `OrchestrationV2AppThreadJson`; `apps/server/src/orchestration-v2/ProjectionStore.ts:1031,1081` encodes/decodes its JSON payload and `:1399` builds the shell. wp1 adds launcher copying there and in the contracts shell schema (`orchestrationV2.ts:1842–1935`). Provenance goes through wp1's `providerPolicy.ts` `UserInputRespondedBy` / `UserInputAttachmentAnswerPayload`, `orchestrationV2.ts` command/runtime request and JSON schemas, `Orchestrator.ts:7294–7376` resolution events, and `ProjectionStore.ts:2319–2354` runtime-request payload. Consumers are `packages/client-runtime/src/state/threadRequests.ts`, `apps/web/src/components/chat/MessagesTimeline.tsx`, and `apps/mobile/src/features/threads/QuestionAnswerHistory.tsx`; wp1 §6 records their provenance consumers. No second serialization layer is added by this phase.

## 10. Conditional path proof checklist

| Guard/fallback/error activation                   | Observable proof / focused test                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Request is approval, expired/cancelled/resolved   | List excludes; read actual user_input status; respond locked wp1 rejection; approval answer never dispatches        |
| Above target runtime/interaction ceiling          | humanRequired true; actual local wrapper+locked dispatch refusal; existing ceiling code with forward-human guidance |
| Remote plan/write-incompatible client             | No remote tool execution; origin interaction code or destination runtime-ceiling refusal retained                   |
| Target changes modes after preflight              | `DispatchModeLimit` under-lock refusal; one failed answer command, no resolved request                              |
| Old remote ignores provenance                     | One successful response, warning, no answer retry; actual returned provenance not fabricated                        |
| Old remote ignores foreign list filter            | Required launched schema fails or target_required refusal; host listed unavailable, not falsely empty               |
| Host unavailable/invalid/malformed                | Single route error or partial fan-out unavailableHosts; local success and remaining hosts retained                  |
| Foreign launcher same ID, wrong environment       | Zero matches; foreign filter cannot select local/null launcher                                                      |
| Explicit launcher absent in legacy child          | Only caller-owned app_owned task relationship fallback; native/unrelated excluded                                   |
| SSH launch unknown launcher key rejection         | Exactly one tools/call attempt; no schema-ambiguous fallback; current decode is before handler                      |
| SSH launch response lost after creation           | No automatic replacement launch; tool reports transport/refusal; side-effect counter remains one                    |
| Wait begins with pending selected-run question    | Immediate non-timeout IDs; run remains nonterminal; no subscription needed                                          |
| Question commits during wait/read-subscribe race  | Stored-event replay wakes; IDs from committed projection                                                            |
| Other-run question/approval/resolution-only event | Re-read allowed but wait stays until qualifying selected-run question/terminal                                      |
| Timeout races question/terminal                   | Final projection takes precedence; false timeout and IDs/terminal respectively                                      |
| Delegate question release                         | Nonterminal result, false timeout, IDs; persisted wake policy always (or existing best-effort warning)              |
| Internal settle observes a question               | Wait remains active; eventual terminal completion still settles exactly once                                        |

## 11. Open questions with proposed defaults

1. **A1 ratification / external outside MCP answers:** approve the outside-only transported provenance seam; reject outside answers lacking an agent origin instead of claiming user attribution. This is an amendment request, not silently adopted product policy. Prefer main's wp1 boundary if already specified; preserve truthful attribution and ceiling checks.
2. **Discovery ordering/caps:** deterministic `(host|null,threadId,requestId)` order, complete matched shells, concurrency 4 for both local projection reads and hosts. No new caps/pagination semantics that could silently omit pending questions. Revisit storage query only if measured shell discovery cost warrants it.
3. **Remote `humanRequired` when the origin is plan-mode:** destination checks outside runtime ceiling, origin ORs its own plan restriction because remote respond is unavailable regardless of target interaction mode. No new forwarded launcher-mode field; this reports whether this origin can answer using these tools.
4. **Older remote attribution:** return one optional warning literal in successful respond, preserve actual returned provenance, do not auto-retry or assert storage loss. Full capability negotiation and provenance repair are out of scope.
5. **Older remote launcher acceptance:** always send the new field to current remotes; omit fallback retry until a structured pre-handler unknown-key error is retained. Old non-strict success lacks discovery guarantees; do not claim remote origin tracking from success alone.
6. **wp1/wp2 integration naming:** final review confirmed `OrchestrationV2ThreadLauncher`, `UserInputRespondedBy`, and `UserInputResponseReason` in wp1's draft. Use those exports and the shared `exceededDispatchModeLimit`; reconcile future rename corrections without expanding this phase into the notification reactor.

## 12. Verifiers and probe record

Run implementation verifiers only after wp1/wp2/wp3 code is integrated. Every command uses workdir `/Users/jun/.goat/worktrees/goat/goat-question-escalation` and the required PATH. Never run `vp check`, recursive `vp run -r`, or repository-wide lint/typecheck. Split suites if a package runner requires package workdir? **No:** this task's workdir constraint remains root; use explicit root-relative paths as below.

```sh
PATH=/Users/jun/.goat/worktrees/goat/goat-question-escalation/node_modules/.bin:$PATH vp test run apps/server/src/mcp/PendingQuestionsMcpService.test.ts apps/server/src/mcp/HostThreadsMcpService.test.ts apps/server/src/orchestration-v2/ThreadManagementService.test.ts apps/server/src/mcp/OrchestratorMcpService.test.ts apps/server/src/mcp/OrchestratorMcpToolkit.integration.test.ts apps/server/src/sshRemote/SshRemoteDispatch.test.ts apps/server/src/mcp/toolkits/project/handlers.test.ts apps/server/src/mcp/toolkits/core.test.ts packages/contracts/src/orchestratorMcp.test.ts packages/provider-core/src/server/orchestrationInstructions.test.ts

PATH=/Users/jun/.goat/worktrees/goat/goat-question-escalation/node_modules/.bin:$PATH vp lint packages/contracts/src/orchestratorMcp.ts packages/contracts/src/orchestratorMcp.test.ts apps/server/src/mcp/PendingQuestionsMcpService.ts apps/server/src/mcp/PendingQuestionsMcpService.test.ts apps/server/src/mcp/toolkits/thread/handlers.ts apps/server/src/mcp/toolkits/thread/tools.ts apps/server/src/mcp/McpHttpServer.ts apps/server/src/mcp/toolkits/project/tools.ts apps/server/src/mcp/toolkits/project/handlers.ts apps/server/src/mcp/toolkits/project/handlers.test.ts apps/server/src/mcp/toolkits/ssh/handlers.ts apps/server/src/sshRemote/SshRemoteDispatch.ts apps/server/src/sshRemote/SshRemoteDispatch.test.ts apps/server/src/orchestration-v2/ThreadManagementService.ts apps/server/src/orchestration-v2/ThreadManagementService.test.ts apps/server/src/mcp/OrchestratorMcpService.ts apps/server/src/mcp/OrchestratorMcpService.test.ts apps/server/src/mcp/OrchestratorMcpToolkit.integration.test.ts apps/server/src/mcp/HostThreadsMcpService.test.ts apps/server/src/mcp/toolkits/orchestrator/tools.ts apps/server/src/mcp/toolkits/core.test.ts packages/provider-core/src/server/orchestrationInstructions.ts packages/provider-core/src/server/orchestrationInstructions.test.ts

PATH=/Users/jun/.goat/worktrees/goat/goat-question-escalation/node_modules/.bin:$PATH tsc --noEmit -p packages/contracts/tsconfig.json
PATH=/Users/jun/.goat/worktrees/goat/goat-question-escalation/node_modules/.bin:$PATH tsc --noEmit -p packages/provider-core/tsconfig.json
PATH=/Users/jun/.goat/worktrees/goat/goat-question-escalation/node_modules/.bin:$PATH tsc --noEmit -p apps/server/tsconfig.json
```

Docs-only probe executed once:

```text
$ PATH=/Users/jun/.goat/worktrees/goat/goat-question-escalation/node_modules/.bin:$PATH vp test run apps/server/src/mcp/HostThreadsMcpService.test.ts
RUN v5.0.1 /Users/jun/.goat/worktrees/goat/goat-question-escalation
Test Files  1 passed (1)
Tests       7 passed (7)
Duration    3.81s
exit_code: 0
```

This proves the existing host-service harness runs; it does not prove planned wp3 implementation. No other test/lint/typecheck executed during this document cycle. A read-only Node attempt to syntax-check embedded TypeScript via `typescript.transpileModule` could not run: the installed package exports only `version` / `versionMajorMinor`, so `ScriptTarget.ESNext` was unavailable. No syntax/typecheck success is claimed. Text-only checks verified paired Markdown fences, required sections/paths, and dependency/provenance chains against source and the wp1/wp2 drafts. The required output is this one assigned document; stop after its source/chain consistency review.
