# 010 — wp1 foundations: launcher identity and answer provenance

> **Main disposition (binding):** the amendments and open questions in this document (A1/A2, OQ1-OQ5) are decided in [000_plan.md](000_plan.md#main-dispositions-of-drafting-lane-amendments-wp0). Where this document proposes otherwise (notably rejecting threadless outside responders), 000 wins: they are recorded as `respondedBy: { type: "client", reason }`.

## Main errata (binding, from the wp0 reflection; supersedes conflicting hunks below)

**E1 — `client` responder variant.** Replace §2.1's `UserInputRespondedBy` with:

```ts
export const UserInputResponseReason = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2000),
  Schema.isPattern(/\S/), // at least one non-whitespace character; stored unchanged
);
export const UserInputRespondedBy = Schema.Union([
  Schema.Struct({ type: Schema.Literal("user") }),
  Schema.Struct({
    type: Schema.Literal("agent"),
    threadId: ThreadId,
    environmentId: Schema.NullOr(EnvironmentId),
    title: Schema.NullOr(Schema.String),
    reason: UserInputResponseReason,
  }),
  Schema.Struct({ type: Schema.Literal("client"), reason: UserInputResponseReason }),
]);
```

(If `Schema.isPattern` is not the local check name, use the repo's existing regex check helper; the rule is "contains \S".)

**E2 — Outside clients are not rejected.** §4.2: a threadless authenticated outside caller responding locally is stamped `{ type: "client", reason }`; delete the `invalid_request` guard and replace the §8.4 rejection test with "outside client respond persists respondedBy client". Message-mode answers from `client` dispatch with `createdBy: "agent"`, no `senderThreadId`, text prefix `Answered by an MCP client: <reason>`.

**E3 — Attribution text, one helper.** The shared attribution helper (§5.2) and the already-answered formatter (§4.3) render:
`user` → "the user"; `agent` with `environmentId: null` → `orchestrator "<title ?? threadId>"`; `agent` with non-null `environmentId` → `orchestrator "<title ?? threadId>" on another machine`; `client` → "an MCP client"; absent → "another responder". UI lines: "Answered by <that>: <reason>" for agent/client; nothing extra for user/absent.

**E4 — Forward-to-human refusal (D6).** In the respond path, map the two ceiling failures (`runtime_mode_escalation_denied`, `interaction_mode_escalation_denied`) raised by the preflight `writesThreads` check and by the locked `DispatchModeLimit` re-check (`McpToolAccess.ts` ~217) to the same code with the message suffix: ` This question needs a person: forward it to the user in your own thread, or let them answer it in the asking thread.` Implement it as a `Effect.mapError` around the respond handler only (no change to the shared wrappers). Test: caller `auto`, target `full-access` → code unchanged, message contains "forward it to the user".

**E5 — Reason tests.** Add whitespace-only reason rejection (`"   "` → schema decode failure / `invalid_request`) to the contracts test and the MCP respond test.

**E6 — Dismiss/settle are labelled truthfully (audit M3).** WS `thread.user-input.dismiss` gets `respondedBy: { type: "user" }` stamped in `withCreationProvenance` (add the optional field to the dismiss command) and threaded into the internal `runtime-request.respond` it dispatches. The settle path stamps nothing. The attribution helper takes `{ respondedBy, decision, status }`: `decision === "cancel"` renders "dismissed by the user" (with `user`) or "closed when its thread stopped or settled" (absent); `expired`/`cancelled` statuses render "expired"/"cancelled". Already-answered errors use the same helper ("This question was already dismissed by the user at …").

**E7 — Foreign/client message-mode answers (audit minor 2).** `senderThreadId` is set only for `agent` with `environmentId === null`; the text prefix comes from the E3 helper.

**E8 — Approvals reject any non-user responder (audit minor 3).** The decider's defense-in-depth rejects `respondedBy` of any type other than `user` on non-`user_input` requests.

**E9 — No `launcher: undefined` assignments (audit minor 7).** Omit the field by destructuring wherever a thread is copied (fork, native child helper, §4.1).

**E10 — Tool description (audit minor 6).** `goat_pending_request_respond` description states that `reason` is required and is shown to the user as who answered and why.

**E11 — Verifier commands.** Use `B=<worktree>/node_modules/.bin` and call `$B/vp`, `$B/tsc`; never prepend `$B` to PATH (its `rg` shim is Linux-only). This replaces every `export PATH=…` line in §9.

**E12 — Forward-to-human suffix lives in the wrapper (wp1 audit M1).** Supersedes E4's mechanism: add an optional `refusalSuffix?: string` option to `McpToolAccess.writesThreads`, appended to the message of both the preflight `assertTargetWithinLimits` failure and the locked `escalationDenied` failure (codes unchanged). Only `goat_pending_request_respond` passes it. Test both: preflight (caller `auto`, target `full-access`) and a locked re-check race if the existing McpToolAccess race harness supports it.

**E13 — Attribution helper lives in contracts (wp1 audit M2).** Supersedes E3's location: the pure formatter `describeUserInputResponder({ respondedBy, decision, status })` sits next to `UserInputRespondedBy` in `packages/contracts/src/providerPolicy.ts`; server (§4.3) and client (§5.2) import it. `OrchestratorQuestionAlreadyAnsweredError` gains optional `decision` and `status` so dismissed/expired wording works.

**E14 — Model-facing prefix keeps the thread id.** Message-mode agent answers: `Answered by ${describe(...)} (${threadId}): ${reason}` for a local agent; `Answered by ${describe(...)}: ${reason}` for foreign agents and clients. This wins over E7's wording.

**E15 — Scope clarifications.** `dispatchThreadUserInputDismiss`'s own non-pending rejection (`Orchestrator.ts` ~7490) also raises the typed error. History UI for cancelled (dismissed/settled) items is unchanged in wp1; the attribution for those shows through MCP read and error text only. §4.4's `agentResponder` generalises to any non-`user` responder; `senderThreadId` only for a local agent. The dismiss command's new field is `respondedBy: Schema.optional(UserInputRespondedBy)` on `thread.user-input.dismiss` only.

## Amendments requested

Binding policy is [000_plan.md](000_plan.md), D1–D9. This document does not approve either request below; main must dispose them before implementing the affected hunk.

1. **A1 — extend the write scope to `packages/provider-core/src/server/subagentProjection.ts` and its focused test.** D1 requires provider-native subagents to remain without a launcher. Current `makeSubagentChildThread` spreads `...input.parentThread` at line 55. Therefore adding a launcher only in the app-owned Orchestrator call is insufficient: a launched parent leaks its launcher into native children. The helper is called by Codex, Claude, Cursor, ACP/Grok/Antigravity, and both OpenCode implementations. The smallest fix is to clear the inherited launcher in the shared helper, then stamp the app-owned child at `Orchestrator.ts:6596`. This preserves D1 rather than changing it, but 000's provider-core write scope currently names only `orchestrationInstructions.ts`. Proposed disposition: accept the two-file scope extension. Without it, D1's native-child exclusion cannot ship with the proposed one-site recording change. See §3.4 for executable hunks and the complete caller list.
2. **A2 — define threadless outside MCP responses.** Current `McpInvocationScope.thread` and `readCaller().caller` can be undefined for authenticated outside clients (`McpInvocationContext.ts:53–60`, `threadAccess.ts:73–82`). The current respond tool accepts those clients with explicit `threadId`. D4's agent variant requires a real responder `threadId`; `scope.environmentId` identifies this environment, not an origin thread. No truthful agent record can be built for these callers from the present local contract. Proposed default: keep outside read/list and launch working, reject outside **local respond** with `invalid_request` and an explicit attribution message, pending main's decision. Do not invent an ID, record the target as the responder, stamp `user`, or silently omit provenance. This changes existing outside-client behavior and needs an explicit main disposition. wp3 must resolve authenticated SSH-origin responder attribution separately; its remote transport also arrives as an outside client. This document introduces no tool argument for caller identity and no host/scope fields.

## 1. Scope, source snapshot, and phase boundary

Docs-only deliverable: this one file. Implementation hunks below are a future work package; no production file is edited by this drafting task.

Source inspected on 2026-10-12, HEAD `070941cae03041421f55899d7f82c848afb9b0e2`. All paths and before-line ranges were read from this worktree, not copied from 001. Read first: 000, 001, AGENTS.md, `docs/internals/effect-services.md`. Older federated memory was cross-checked only for project context; current 000 and source govern this phase.

wp1 delivers D1 local recording, D2's contract, D4 trusted provenance/storage/display, and D5 resolved reads and detailed first-answer-wins rejection. wp2 owns question delivery, recovery, humanRequired calculation, cancellation/resolution notices. wp3 owns host/scope arguments, routing/service extraction, SSH launcher input, waits, and instructions. wp4 owns publication and durable internal guidance. Do not add `host`, `hosts`, or `scope` to wp1 tools. Include `via: "ssh_thread_launch"` in the **persisted identity enum** now because D1 defines it; there is no SSH creation path in this phase.

No DB migration: thread/request/item rows already carry complete schema-encoded JSON. Optional fields keep legacy payloads decodable. Do not infer old responder identity from authorship or lineage. D1's legacy **app-owned** lineage fallback belongs to the wp2 consumer, not a wp1 backfill.

Anchor correction: `ThreadLaunchService.ts:747` is the `ProjectCloneTracker.rejectCommandsDuringClone` discriminator, not a dispatched create command. Its actual `thread.create` dispatch is at 836; leave the clone guard alone. `ThreadMessageIntake.launchThread` starts at 182 (138 in old research points inside a different path).

All future edits below are MODIFY unless explicitly marked NEW. No DELETE is needed. Absolute editing root: `/Users/jun/.goat/worktrees/goat/goat-question-escalation`.

## 2. Contracts

Use one launcher schema and one responder schema. Put responder in `providerPolicy.ts`, where the shared answer payload already lives; it imports only base ID schemas and avoids a circular import from providerPolicy to orchestrationV2. Root index already re-exports both modules (`index.ts:1,23,38`), so no new barrel edit.

### 2.1 Responder and reason schema; historical answer payload

**MODIFY `packages/contracts/src/providerPolicy.ts`**

Reason validation is 1–2000 characters using the existing Effect string-length convention. It does not trim or rewrite answers or reasons. Null title is supported; display fallback is the recorded thread ID. OQ3 covers whitespace-only reasons.

Before, current source `packages/contracts/src/providerPolicy.ts:8–8`:

```ts
    8 | import { TrimmedNonEmptyString } from "./baseSchemas.ts";
```

Before, current source `packages/contracts/src/providerPolicy.ts:78–84`:

```ts
   78 | export const UserInputAttachmentAnswerPayload = Schema.Struct({
   79 |   requestId: TrimmedNonEmptyString,
   80 |   questionTextById: Schema.optional(Schema.Record(Schema.String, Schema.String)),
   81 |   answers: ProviderUserInputAnswers,
   82 |   attachmentsByQuestionId: UserInputAttachments,
   83 | });
   84 | export type UserInputAttachmentAnswerPayload = typeof UserInputAttachmentAnswerPayload.Type;
```

After, apply this diff (line numbers above are evidence, not patch content):

```diff
@@
-import { TrimmedNonEmptyString } from "./baseSchemas.ts";
+import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
@@
-export const UserInputAttachmentAnswerPayload = Schema.Struct({
+export const UserInputResponseReason = Schema.String.check(
+  Schema.isMinLength(1),
+  Schema.isMaxLength(2000),
+);
+export type UserInputResponseReason = typeof UserInputResponseReason.Type;
+
+export const UserInputRespondedBy = Schema.Union([
+  Schema.Struct({ type: Schema.Literal("user") }),
+  Schema.Struct({
+    type: Schema.Literal("agent"),
+    threadId: ThreadId,
+    environmentId: Schema.NullOr(EnvironmentId),
+    title: Schema.NullOr(Schema.String),
+    reason: UserInputResponseReason,
+  }),
+]);
+export type UserInputRespondedBy = typeof UserInputRespondedBy.Type;
+
+export const UserInputAttachmentAnswerPayload = Schema.Struct({
   requestId: TrimmedNonEmptyString,
+  respondedBy: Schema.optional(UserInputRespondedBy),
   questionTextById: Schema.optional(Schema.Record(Schema.String, Schema.String)),
```

### 2.2 Launcher and command/request/shell fields

**MODIFY `packages/contracts/src/orchestrationV2.ts`**

The two abbreviated @@ anchors naming a command discriminate the exact Schema.Struct member; do not add launcher to fork commands or respondedBy to similarly shaped approval schemas. All Json mapFields schemas retain ...fields, so they inherit these additions without another field declaration. Both runtime and JSON turn-item schemas already refer to UserInputAttachmentAnswerPayload.

Before, current source `packages/contracts/src/orchestrationV2.ts:8–16`:

```ts
    8 | import {
    9 |   CheckpointId,
   10 |   CheckpointRef,
   11 |   CheckpointScopeId,
   12 |   CommandId,
   13 |   ContextHandoffId,
   14 |   ContextTransferId,
   15 |   EventId,
   16 |   IsoDateTime,
```

Before, current source `packages/contracts/src/orchestrationV2.ts:56–65`:

```ts
   56 | import {
   57 |   ProviderApprovalDecision,
   58 |   ProviderApprovalOption,
   59 |   ProviderInteractionMode,
   60 |   ProviderRequestKind,
   61 |   ProviderUserInputAnswers,
   62 |   UserInputAttachments,
   63 |   UserInputAttachmentAnswerPayload,
   64 |   RuntimeMode,
   65 | } from "./providerPolicy.ts";
```

Before, current source `packages/contracts/src/orchestrationV2.ts:108–113`:

```ts
  108 | export const OrchestrationV2AppThreadLineage = Schema.Struct({
  109 |   parentThreadId: Schema.NullOr(ThreadId),
  110 |   relationshipToParent: Schema.NullOr(Schema.Literals(["fork", "subagent"])),
  111 |   rootThreadId: ThreadId,
  112 | });
  113 | export type OrchestrationV2AppThreadLineage = typeof OrchestrationV2AppThreadLineage.Type;
```

Before, current source `packages/contracts/src/orchestrationV2.ts:381–384`:

```ts
  381 |   activeProviderThreadId: Schema.NullOr(ProviderThreadId),
  382 |   historyOrigin: Schema.optional(OrchestrationV2ThreadHistoryOrigin),
  383 |   lineage: OrchestrationV2AppThreadLineage,
  384 |   forkedFrom: Schema.NullOr(
```

Before, current source `packages/contracts/src/orchestrationV2.ts:1044–1048`:

```ts
 1044 |   createdAt: Schema.DateTimeUtc,
 1045 |   resolvedAt: Schema.NullOr(Schema.DateTimeUtc),
 1046 |   decision: Schema.optional(ProviderApprovalDecision),
 1047 |   answers: Schema.optional(ProviderUserInputAnswers),
 1048 | });
```

Before, current source `packages/contracts/src/orchestrationV2.ts:1858–1861`:

```ts
 1858 |   lineage: OrchestrationV2AppThreadLineage,
 1859 |   forkedFrom: Schema.NullOr(OrchestrationV2AppThread.fields.forkedFrom),
 1860 |   activeProviderThreadId: Schema.NullOr(ProviderThreadId),
 1861 |   historyOrigin: Schema.optional(OrchestrationV2ThreadHistoryOrigin),
```

Before, current source `packages/contracts/src/orchestrationV2.ts:2627–2632`:

```ts
 2627 |     runtimeMode: RuntimeMode,
 2628 |     interactionMode: ProviderInteractionMode,
 2629 |     branch: Schema.NullOr(TrimmedNonEmptyString),
 2630 |     worktreePath: Schema.NullOr(TrimmedNonEmptyString),
 2631 |     importedNativeThread: Schema.optional(
 2632 |       Schema.Struct({
```

Before, current source `packages/contracts/src/orchestrationV2.ts:2967–2974`:

```ts
 2967 |     type: Schema.Literal("runtime-request.respond"),
 2968 |     commandId: CommandId,
 2969 |     threadId: ThreadId,
 2970 |     requestId: RuntimeRequestId,
 2971 |     decision: Schema.optional(ProviderApprovalDecision),
 2972 |     answers: Schema.optional(ProviderUserInputAnswers),
 2973 |     attachmentsByQuestionId: Schema.optional(UserInputAttachments),
 2974 |   }),
```

After, apply this diff (line numbers above are evidence, not patch content):

```diff
@@
   EventId,
+  EnvironmentId,
   IsoDateTime,
@@
   UserInputAttachmentAnswerPayload,
+  UserInputRespondedBy,
   RuntimeMode,
@@
 export type OrchestrationV2AppThreadLineage = typeof OrchestrationV2AppThreadLineage.Type;
+
+/** The authenticated thread that launched this work; independent of ancestry. */
+export const OrchestrationV2ThreadLauncher = Schema.Struct({
+  threadId: ThreadId,
+  environmentId: Schema.NullOr(EnvironmentId),
+  via: Schema.Literals([
+    "thread_launch",
+    "create_threads",
+    "ssh_thread_launch",
+    "delegate_task",
+  ]),
+});
+export type OrchestrationV2ThreadLauncher = typeof OrchestrationV2ThreadLauncher.Type;
@@
   lineage: OrchestrationV2AppThreadLineage,
+  launcher: Schema.optional(OrchestrationV2ThreadLauncher),
   forkedFrom: Schema.NullOr(
@@
   decision: Schema.optional(ProviderApprovalDecision),
   answers: Schema.optional(ProviderUserInputAnswers),
+  respondedBy: Schema.optional(UserInputRespondedBy),
 });
 export type OrchestrationV2RuntimeRequest = typeof OrchestrationV2RuntimeRequest.Type;
@@
   lineage: OrchestrationV2AppThreadLineage,
+  launcher: Schema.optional(OrchestrationV2ThreadLauncher),
   forkedFrom: Schema.NullOr(OrchestrationV2AppThread.fields.forkedFrom),
@@
     type: Schema.Literal("thread.create"),
@@
     worktreePath: Schema.NullOr(TrimmedNonEmptyString),
+    launcher: Schema.optional(OrchestrationV2ThreadLauncher),
     importedNativeThread: Schema.optional(
@@
     type: Schema.Literal("runtime-request.respond"),
@@
     attachmentsByQuestionId: Schema.optional(UserInputAttachments),
+    respondedBy: Schema.optional(UserInputRespondedBy),
   }),
```

### 2.3 Typed question notification source

**MODIFY `packages/contracts/src/orchestrationV2.ts`**

Retain kindUnionWithFallback and its existing unknown-kind fallback unchanged. A client using the pre-question version of this helper sees the new literal as unknown and returns background_task. A new client must reject malformed **known** question records (missing threadId/requestId/humanRequired); fallback must not hide corruption. Much older PreSpecificKindsNotification clients in the existing compatibility test reject new literals entirely; do not claim all historical builds support fallback. No encoder transformation to background_task: it would lose request identity on current clients. wp2 creates the source, wp1 only establishes its storage and consumers.

Before, current source `packages/contracts/src/orchestrationV2.ts:1095–1105`:

```ts
 1095 |     Schema.Struct({ kind: Schema.Literal("background_command").transform("command") }),
 1096 |     SubagentNotificationSource,
 1097 |     CommandNotificationSource,
 1098 |     Schema.Struct({ kind: Schema.Literal("monitor") }),
 1099 |     Schema.Struct({ kind: Schema.Literal("background_task") }),
 1100 |     /** T3 Code itself, such as a restart continuing an interrupted turn. */
 1101 |     Schema.Struct({ kind: Schema.Literal("system") }),
 1102 |   ],
 1103 |   (kind) => Schema.Struct({ kind }),
 1104 |   () => ({ kind: "background_task" }),
 1105 | );
```

After, apply this diff (line numbers above are evidence, not patch content):

```diff
@@
     Schema.Struct({ kind: Schema.Literal("monitor") }),
+    Schema.Struct({
+      kind: Schema.Literal("question"),
+      threadId: ThreadId,
+      requestId: RuntimeRequestId,
+      humanRequired: Schema.Boolean,
+    }),
     Schema.Struct({ kind: Schema.Literal("background_task") }),
```

### 2.4 Local pending MCP schemas

**MODIFY `apps/server/src/mcp/toolkits/thread/tools.ts`**

Add imports to the existing @t3tools/contracts import block, not a second import. IsoDateTime already exists at line 14; reuse it. ResolvedAt is ISO text in MCP output; response schemas are not DateTimeUtc runtime objects. PendingRequestRead retains its old requestId/questions fields and adds status/resolvedAt for every read; respondedBy is omitted for unknown history. List remains pending-only and unchanged. Exposed status includes pending/resolved/expired/cancelled, matching the request schema rather than inventing a second enum.

Before, current source `apps/server/src/mcp/toolkits/thread/tools.ts:1–26`:

```ts
    1 | import {
    2 |   ScheduledTaskId,
    3 |   ScheduledTask,
    4 |   OrchestrationSearchThreadsInput,
    5 |   OrchestrationSearchThreadsResult,
    6 |   OrchestrationV2ThreadForkSourcePoint,
    7 |   OrchestrationV2ContextTransfer,
    8 |   TrimmedNonEmptyString,
    9 |   ModelSelection,
   10 |   RuntimeMode,
   11 |   ProviderInteractionMode,
   12 |   RuntimeRequestId,
   13 |   ProviderUserInputAnswers,
   14 |   IsoDateTime,
   15 |   OrchestratorMcpFailure,
   16 |   OrchestrationV2DispatchCommandResult,
   17 |   ThreadId,
   18 |   RunId,
   19 |   NonNegativeInt,
   20 |   ProjectId,
   21 | } from "@t3tools/contracts";
   22 | import * as Crypto from "effect/Crypto";
   23 | import * as Schema from "effect/Schema";
   24 | import { Tool, Toolkit } from "effect/ai";
   25 |
   26 | import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
```

Before, current source `apps/server/src/mcp/toolkits/thread/tools.ts:147–176`:

```ts
  147 | const pendingRequest = Schema.Struct({
  148 |   requestId: RuntimeRequestId,
  149 |   questions: Schema.Array(question),
  150 | });
  151 | const PendingRequestListTool = Tool.make("goat_pending_request_list", {
  152 |   ...commandTool,
  153 |   description:
  154 |     "List pending user questions in a thread. Omit threadId for this thread. Approval requests are not included.",
  155 |   parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  156 |   success: Schema.Struct({ requestIds: Schema.Array(RuntimeRequestId) }),
  157 | })
  158 |   .annotate(Tool.Readonly, true)
  159 |   .annotate(Tool.Destructive, false);
  160 | const PendingRequestReadTool = Tool.make("goat_pending_request_read", {
  161 |   ...commandTool,
  162 |   description:
  163 |     "Read a pending user question. Answer with goat_pending_request_respond; existing live or message response handling is used.",
  164 |   parameters: Schema.Struct(requestTarget),
  165 |   success: pendingRequest,
  166 | })
  167 |   .annotate(Tool.Readonly, true)
  168 |   .annotate(Tool.Destructive, false);
  169 | const PendingRequestRespondTool = Tool.make("goat_pending_request_respond", {
  170 |   ...commandTool,
  171 |   description:
  172 |     "Answer a pending user-input request using the existing runtime response command. This cannot approve a permission request.",
  173 |   parameters: Schema.Struct({ ...requestTarget, answers: ProviderUserInputAnswers }),
  174 | })
  175 |   .annotate(Tool.Destructive, true)
  176 |   .annotate(Tool.OpenWorld, true);
```

After, apply this diff (line numbers above are evidence, not patch content):

```diff
@@
 import {
+  OrchestrationV2RuntimeRequest,
+  UserInputRespondedBy,
+  UserInputResponseReason,
@@
 const pendingRequest = Schema.Struct({
   requestId: RuntimeRequestId,
   questions: Schema.Array(question),
+  status: OrchestrationV2RuntimeRequest.fields.status,
+  respondedBy: Schema.optional(UserInputRespondedBy),
+  resolvedAt: Schema.NullOr(IsoDateTime),
 });
@@
-    "Read a pending user question. Answer with goat_pending_request_respond; existing live or message response handling is used.",
+    "Read a pending or resolved user question, including its status, responder and resolution time. Only pending questions can be answered with goat_pending_request_respond.",
@@
-    "Answer a pending user-input request using the existing runtime response command. This cannot approve a permission request.",
-  parameters: Schema.Struct({ ...requestTarget, answers: ProviderUserInputAnswers }),
+    "Answer a pending user-input request and explain why in reason (1–2000 characters). The authenticated calling thread is recorded as responder. This cannot approve a permission request.",
+  parameters: Schema.Struct({
+    ...requestTarget,
+    answers: ProviderUserInputAnswers,
+    reason: UserInputResponseReason,
+  }),
```

## 3. Authenticated local launcher recording

### 3.1 goat_thread_launch caller to intake

**MODIFY `apps/server/src/mcp/toolkits/project/handlers.ts`**

caller comes from readCaller at 60–61 after startsThreads authorization. Never inspect an input.launcher for this local path. The launcher is recorded even when there is no initial message. Outside clients have no launcher, and the initial-message sender behavior is unchanged.

Before, current source `apps/server/src/mcp/toolkits/project/handlers.ts:138–147`:

```ts
  138 |         const result = yield* ThreadMessageIntake.launchThread({
  139 |           commandId,
  140 |           threadId,
  141 |           projectId,
  142 |           title: input.title,
  143 |           modelSelection,
  144 |           runtimeMode,
  145 |           interactionMode,
  146 |           workspaceStrategy: input.workspaceStrategy ?? { type: "root" },
  147 |           ...(input.message === undefined && attachments.length === 0
```

Before, current source `apps/server/src/mcp/toolkits/project/handlers.ts:157–159`:

```ts
  157 |           createdBy: "agent",
  158 |           creationSource: "mcp",
  159 |         }).pipe(
```

After, apply this diff (line numbers above are evidence, not patch content):

```diff
@@
           workspaceStrategy: input.workspaceStrategy ?? { type: "root" },
+          ...(caller === undefined
+            ? {}
+            : {
+                launcher: {
+                  threadId: caller.id,
+                  environmentId: null,
+                  via: "thread_launch" as const,
+                },
+              }),
           ...(input.message === undefined && attachments.length === 0
```

### 3.2 ThreadLaunchInput and actual create dispatch

**MODIFY `apps/server/src/orchestration-v2/ThreadLaunchService.ts`**

ThreadMessageIntake.ts:182–188 passes input directly when there are no pending attachments; :199–204 uses ...input when claiming them. **N/A edit there: both branches already preserve new optional fields.** UI ws.ts:1955 constructs ThreadLaunchInput explicitly and supplies no launcher; keep that input unchanged. Reusable receipt replays use the originally persisted launcher; reuseExistingThread follows thread.metadata.update (828–834) and must not retag an existing UI draft. MCP goat_thread_launch does not expose reuseExistingThread.

Before, current source `apps/server/src/orchestration-v2/ThreadLaunchService.ts:9–14`:

```ts
    9 |   type ModelSelection,
   10 |   type OrchestrationV2Actor,
   11 |   type OrchestrationV2CreationSource,
   12 |   type OrchestrationV2ProviderThreadNativeMetadata,
   13 |   type OrchestrationV2ThreadProjection,
   14 |   type ProviderDriverKind,
```

Before, current source `apps/server/src/orchestration-v2/ThreadLaunchService.ts:75–87`:

```ts
   75 | export interface ThreadLaunchInput {
   76 |   readonly commandId: CommandId;
   77 |   readonly threadId?: ThreadId;
   78 |   readonly reuseExistingThread?: boolean;
   79 |   readonly projectId: ProjectId;
   80 |   readonly title: string;
   81 |   readonly generateTitle?: boolean;
   82 |   readonly modelSelection: ModelSelection;
   83 |   readonly runtimeMode: RuntimeMode;
   84 |   readonly interactionMode: ProviderInteractionMode;
   85 |   readonly workspaceStrategy: ThreadLaunchWorkspaceStrategy;
   86 |   readonly initialMessage?: ThreadLaunchInitialMessage;
   87 |   readonly importedNativeThread?: {
```

Before, current source `apps/server/src/orchestration-v2/ThreadLaunchService.ts:836–851`:

```ts
  836 |                 type: "thread.create",
  837 |                 commandId: input.commandId,
  838 |                 threadId: candidateThreadId,
  839 |                 projectId: input.projectId,
  840 |                 title: input.title,
  841 |                 modelSelection: input.modelSelection,
  842 |                 runtimeMode: input.runtimeMode,
  843 |                 interactionMode: input.interactionMode,
  844 |                 branch: initialBranch,
  845 |                 worktreePath: initialWorktreePath,
  846 |                 ...(input.importedNativeThread === undefined
  847 |                   ? {}
  848 |                   : { importedNativeThread: input.importedNativeThread }),
  849 |                 createdBy: input.createdBy,
  850 |                 creationSource: input.creationSource,
  851 |               });
```

After, apply this diff (line numbers above are evidence, not patch content):

```diff
@@
   type OrchestrationV2ThreadProjection,
+  type OrchestrationV2ThreadLauncher,
@@
   readonly initialMessage?: ThreadLaunchInitialMessage;
+  /** Supplied by a trusted launch boundary, never a UI launch argument. */
+  readonly launcher?: OrchestrationV2ThreadLauncher;
@@
                 worktreePath: initialWorktreePath,
+                ...(input.launcher === undefined ? {} : { launcher: input.launcher }),
                 ...(input.importedNativeThread === undefined
```

### 3.3 thread.create decider and create_threads

**MODIFY `apps/server/src/orchestration-v2/Orchestrator.ts`**

Before, current source `apps/server/src/orchestration-v2/Orchestrator.ts:2208–2217`:

```ts
 2208 |       interactionMode: command.interactionMode,
 2209 |       branch: command.branch,
 2210 |       worktreePath: command.worktreePath,
 2211 |       activeProviderThreadId: null,
 2212 |       lineage: {
 2213 |         parentThreadId: null,
 2214 |         relationshipToParent: null,
 2215 |         rootThreadId: command.threadId,
 2216 |       },
 2217 |       forkedFrom: null,
```

After, apply this diff (line numbers above are evidence, not patch content):

```diff
@@
       worktreePath: command.worktreePath,
+      ...(command.launcher === undefined ? {} : { launcher: command.launcher }),
       activeProviderThreadId: null,
```

### 3.3a create_threads caller recording

**MODIFY `apps/server/src/mcp/OrchestratorMcpService.ts`**

loadThreadCaller validates callerScope and provider ownership before creating. Use scope.thread.threadId, not a clientRequestId or request.target. No prompt is needed for launcher recording. Keep thread.created.record ancestry/timeline semantics and stable command IDs unchanged.

Before, current source `apps/server/src/mcp/OrchestratorMcpService.ts:2161–2164`:

```ts
 2161 |     createThreads: (callerScope, input) =>
 2162 |       Effect.gen(function* () {
 2163 |         const { scope, parent } = yield* loadThreadCaller(callerScope, "create_threads");
 2164 |         const parentRun = ThreadManagementService.latestActiveRun(parent);
```

Before, current source `apps/server/src/mcp/OrchestratorMcpService.ts:2217–2225`:

```ts
 2217 |                   threadId,
 2218 |                   projectId: parent.thread.projectId,
 2219 |                   title,
 2220 |                   modelSelection: target.modelSelection,
 2221 |                   runtimeMode,
 2222 |                   interactionMode,
 2223 |                   branch: parent.thread.branch,
 2224 |                   worktreePath: parent.thread.worktreePath,
 2225 |                 })
```

After, apply this diff (line numbers above are evidence, not patch content):

```diff
@@
                   worktreePath: parent.thread.worktreePath,
+                  launcher: {
+                    threadId: scope.thread.threadId,
+                    environmentId: null,
+                    via: "create_threads",
+                  },
                 })
```

### 3.4 Shared native child inheritance guard (requires A1)

**MODIFY `packages/provider-core/src/server/subagentProjection.ts`**

A1 gates this hunk. It does not add launcher to helper inputs. Caller inventory, freshly searched: Orchestrator.ts:6584 (app-owned); CodexAdapterV2.ts:2824; ClaudeAdapterV2.ts:4385; packages/provider-cursor/src/server/adapter.ts:1614; packages/provider-acp/src/server/adapter.ts:2795; packages/provider-opencode/src/server/adapter.ts:1372; packages/provider-opencode/src/server/v2/adapter.ts:1461. Grok and Antigravity use ACP; Pi/Muse have no direct helper caller in this search. Clearing in the shared helper covers all native creation paths without per-adapter edits.

Before, current source `packages/provider-core/src/server/subagentProjection.ts:54–66`:

```ts
   54 |   return {
   55 |     ...input.parentThread,
   56 |     createdBy: input.createdBy,
   57 |     creationSource: input.creationSource,
   58 |     id: input.childThreadId,
   59 |     title: input.title,
   60 |     linkedPullRequest: null,
   61 |     pullRequests: [],
   62 |     historyOrigin: undefined,
   63 |     providerInstanceId: input.providerInstanceId,
   64 |     modelSelection: input.modelSelection,
   65 |     activeProviderThreadId: input.activeProviderThreadId,
   66 |     lineage: {
```

After, apply this diff (line numbers above are evidence, not patch content):

```diff
@@
     historyOrigin: undefined,
+    // Launcher belongs to this dispatch, not to the parent's ancestry.
+    // App-owned delegation stamps its own launcher after this helper returns.
+    launcher: undefined,
     providerInstanceId: input.providerInstanceId,
```

### 3.4a App-owned delegate_task child

**MODIFY `apps/server/src/orchestration-v2/Orchestrator.ts`**

This exact delegated_task.request path is app-owned; do not change every makeSubagentChildThread call to add launcher. parentThreadId in this command was stamped by OrchestratorMcpService from its validated caller. Leave lineage/root/forkedFrom intact. For legacy app-owned records missing launcher, wp2 may use lineage only after confirming app-owned origin.

Before, current source `apps/server/src/orchestration-v2/Orchestrator.ts:6583–6598`:

```ts
 6583 |       const childThread: OrchestrationV2AppThread = {
 6584 |         ...makeSubagentChildThread({
 6585 |           parentThread: parentProjection.thread,
 6586 |           childThreadId,
 6587 |           parentNodeId: taskNodeId,
 6588 |           activeProviderThreadId: null,
 6589 |           providerInstanceId: command.modelSelection.instanceId,
 6590 |           modelSelection: command.modelSelection,
 6591 |           title: taskTitle,
 6592 |           now,
 6593 |           createdBy: command.createdBy,
 6594 |           creationSource: command.creationSource,
 6595 |         }),
 6596 |         runtimeMode: command.runtimeMode,
 6597 |         interactionMode: command.interactionMode,
 6598 |       };
```

After, apply this diff (line numbers above are evidence, not patch content):

```diff
@@
         runtimeMode: command.runtimeMode,
         interactionMode: command.interactionMode,
+        launcher: {
+          threadId: parentProjection.thread.id,
+          environmentId: null,
+          via: "delegate_task",
+        },
       };
       const task: OrchestrationV2Subagent = {
```

### 3.5 Full and compact shell copies

**MODIFY `apps/server/src/orchestration-v2/ProjectionStore.ts`**

Both threadShellFromProjection and the compact SQL-state builder need this. JSON payload codecs and DB columns stay unchanged. ShellStream exports whole shells, so transport subscriptions also inherit launcher.

Before, current source `apps/server/src/orchestration-v2/ProjectionStore.ts:1482–1487`:

```ts
 1482 |     lineage: projection.thread.lineage,
 1483 |     forkedFrom: projection.thread.forkedFrom,
 1484 |     activeProviderThreadId: projection.thread.activeProviderThreadId,
 1485 |     ...(projection.thread.historyOrigin === undefined
 1486 |       ? {}
 1487 |       : { historyOrigin: projection.thread.historyOrigin }),
```

Before, current source `apps/server/src/orchestration-v2/ProjectionStore.ts:1750–1755`:

```ts
 1750 |     lineage: input.state.thread.lineage,
 1751 |     forkedFrom: input.state.thread.forkedFrom,
 1752 |     activeProviderThreadId: input.state.thread.activeProviderThreadId,
 1753 |     ...(input.state.thread.historyOrigin === undefined
 1754 |       ? {}
 1755 |       : { historyOrigin: input.state.thread.historyOrigin }),
```

After, apply this diff (line numbers above are evidence, not patch content):

```diff
@@
     lineage: projection.thread.lineage,
+    ...(projection.thread.launcher === undefined ? {} : { launcher: projection.thread.launcher }),
     forkedFrom: projection.thread.forkedFrom,
@@
     lineage: input.state.thread.lineage,
+    ...(input.state.thread.launcher === undefined ? {} : { launcher: input.state.thread.launcher }),
     forkedFrom: input.state.thread.forkedFrom,
```

### 3.6 Fork must not inherit the original launcher (proposed OQ1 default)

**MODIFY `apps/server/src/orchestration-v2/ThreadForkService.ts`**

This is the proposed default for OQ1, not a new accepted product decision. Existing fork copies every source field. D1 lists launch/create/delegate/SSH rather than fork; copying the old source launcher would notify a thread that did not launch the new fork. Main should confirm clearing. No launcher is synthesized for UI or MCP forks in wp1.

Before, current source `apps/server/src/orchestration-v2/ThreadForkService.ts:88–100`:

```ts
   88 |         const targetThread: OrchestrationV2AppThread = {
   89 |           ...input.sourceProjection.thread,
   90 |           createdBy: input.createdBy,
   91 |           creationSource: input.creationSource,
   92 |           id: input.targetThreadId,
   93 |           title: input.title ?? `${input.sourceProjection.thread.title} fork`,
   94 |           activeProviderThreadId: null,
   95 |           lineage: {
   96 |             parentThreadId: input.sourceProjection.thread.id,
   97 |             relationshipToParent: "fork",
   98 |             rootThreadId: input.sourceProjection.thread.lineage.rootThreadId,
   99 |           },
  100 |           forkedFrom: {
```

After, apply this diff (line numbers above are evidence, not patch content):

```diff
@@
           ...input.sourceProjection.thread,
+          launcher: undefined,
           createdBy: input.createdBy,
```

## 4. Trusted response capture, persistence, and first-answer-wins

### 4.1 Extend the existing trusted creation boundary for responses

**MODIFY `apps/server/src/orchestration-v2/ThreadManagementService.ts`**

The cleanest location is this existing WS trusted boundary: one response case and one user-create guard, no new service or helper. provenance.createdBy is a trusted boundary argument, not command input. All ws dispatches already pass createdBy:user. The overwrite ignores a forged client agent identity/reason. An agent creation provenance does not imply a response identity; MCP constructs that from readCaller explicitly. The dedicated thread.create case also clears any user-supplied launcher, so UI dispatch cannot spoof launch attribution. No WS handler signature change is necessary.

Before, current source `apps/server/src/orchestration-v2/ThreadManagementService.ts:52–66`:

```ts
   52 | export function withCreationProvenance(
   53 |   command: OrchestrationV2Command,
   54 |   provenance: ThreadManagementProvenance,
   55 | ): OrchestrationV2Command {
   56 |   switch (command.type) {
   57 |     case "thread.create":
   58 |     case "message.dispatch":
   59 |     case "thread.fork":
   60 |     case "thread.merge_back":
   61 |     case "delegated_task.request":
   62 |       return { ...command, ...provenance };
   63 |     default:
   64 |       return command;
   65 |   }
   66 | }
```

After, apply this diff (line numbers above are evidence, not patch content):

```diff
@@
   switch (command.type) {
+    case "runtime-request.respond":
+      return provenance.createdBy === "user"
+        ? { ...command, respondedBy: { type: "user" } }
+        : command;
     case "thread.create":
+      return provenance.createdBy === "user"
+        ? { ...command, ...provenance, launcher: undefined }
+        : { ...command, ...provenance };
```

WS integration before, unchanged `apps/server/src/ws.ts:1840–1846`:

```ts
1840 | : ThreadMessageIntake.dispatchCommand(
1841 |     ThreadManagementService.withCreationProvenance(command, {
1842 |       createdBy: "user",
1843 |       creationSource:
1844 |         "creationSource" in command ? command.creationSource : "web",
1845 |     }),
1846 |   )
```

After: identical. **N/A edit**: the response case added in §4.1 executes on this path before attachment claiming and orchestration dispatch. prepared-run.retry bypasses this helper but cannot answer a request. UI launchThread uses explicit service inputs, no launcher. There are no new IPC or authorization scopes: web/desktop/mobile and remote/relay/tunnel all use the existing orchestration.dispatchCommand boundary and orchestration:operate permission.

### 4.2 Read resolved user questions and stamp authenticated MCP responses

**MODIFY `apps/server/src/mcp/toolkits/thread/handlers.ts`**

A2 gates the caller===undefined guard. Tool inputs choose only target/answers/reason. No launcher authority check: any live agent within the existing destination ceiling can answer; launcher selects notification delivery only. Keep writesThread → writesThreads and DispatchModeLimit. The helper now loads all user_input statuses; respond deliberately does **not** reject resolved status here, so the lock-protected decider produces D5 even if the request resolves after this read. Missing item remains invalid_request. Approval requests never match readQuestion. wp3 will move this local behavior intact into PendingQuestionsMcpService; do not perform that extraction now.

Before, current source `apps/server/src/mcp/toolkits/thread/handlers.ts:1–11`:

```ts
    1 | import {
    2 |   type CommandId,
    3 |   type RuntimeRequestId,
    4 |   ThreadId,
    5 |   type OrchestrationV2ThreadProjection,
    6 |   type RunId,
    7 |   OrchestratorMcpFailure,
    8 |   type OrchestrationV2Command,
    9 | } from "@t3tools/contracts";
   10 | import * as Effect from "effect/Effect";
   11 | import { modelSelectionCommandType } from "@t3tools/shared/model";
```

Before, current source `apps/server/src/mcp/toolkits/thread/handlers.ts:57–71`:

```ts
   57 |   const request = context.projection.runtimeRequests.find(
   58 |     (request) =>
   59 |       request.id === input.requestId &&
   60 |       request.kind === "user_input" &&
   61 |       request.status === "pending",
   62 |   );
   63 |   const item = context.projection.turnItems.find(
   64 |     (item) => item.type === "user_input_request" && item.requestId === input.requestId,
   65 |   );
   66 |   if (request === undefined || item?.type !== "user_input_request")
   67 |     return yield* new OrchestratorMcpFailure({
   68 |       code: "invalid_request",
   69 |       message: "The pending user-input request was not found.",
   70 |     });
   71 |   return { ...context, request, item };
```

Before, current source `apps/server/src/mcp/toolkits/thread/handlers.ts:213–233`:

```ts
  213 |   goat_pending_request_read: McpToolAccess.reads((input) =>
  214 |     Effect.gen(function* () {
  215 |       const { item } = yield* readQuestion(input);
  216 |       return { requestId: input.requestId, questions: item.questions };
  217 |     }),
  218 |   ),
  219 |   goat_pending_request_respond: writesThread((input) =>
  220 |     Effect.gen(function* () {
  221 |       const { threads, projection } = yield* readQuestion(input);
  222 |       const result = yield* threads
  223 |         .dispatch({
  224 |           type: "runtime-request.respond",
  225 |           threadId: projection.thread.id,
  226 |           commandId: yield* newCommandId(),
  227 |           requestId: input.requestId,
  228 |           answers: input.answers,
  229 |         })
  230 |         .pipe(Effect.mapError(dispatchFailure));
  231 |       return { sequence: result.sequence };
  232 |     }),
  233 |   ),
```

After, apply this diff (line numbers above are evidence, not patch content):

```diff
@@
 import * as Effect from "effect/Effect";
+import * as DateTime from "effect/DateTime";
@@
-      request.kind === "user_input" &&
-      request.status === "pending",
+      request.kind === "user_input",
@@
-      message: "The pending user-input request was not found.",
+      message: "The user-input request was not found.",
@@
-      const { item } = yield* readQuestion(input);
-      return { requestId: input.requestId, questions: item.questions };
+      const { item, request } = yield* readQuestion(input);
+      return {
+        requestId: input.requestId,
+        questions: item.questions,
+        status: request.status,
+        ...(request.respondedBy === undefined ? {} : { respondedBy: request.respondedBy }),
+        resolvedAt: request.resolvedAt === null ? null : DateTime.formatIso(request.resolvedAt),
+      };
@@
-      const { threads, projection } = yield* readQuestion(input);
+      const { threads, projection, caller } = yield* readQuestion(input);
+      if (caller === undefined)
+        return yield* new OrchestratorMcpFailure({
+          code: "invalid_request",
+          message: "Answer provenance requires an authenticated calling thread; this outside MCP client has no thread identity.",
+        });
       const result = yield* threads
@@
           answers: input.answers,
+          respondedBy: {
+            type: "agent",
+            threadId: caller.id,
+            environmentId: null,
+            title: caller.title,
+            reason: input.reason,
+          },
```

### 4.3 Typed already-answered domain error and union membership

**MODIFY `apps/server/src/orchestration-v2/Orchestrator.ts`**

Add both value/schema imports to the existing contracts import block at :19–62; RuntimeRequestId is not currently imported in this file. A separate typed error makes the transport mapping independent of prose parsing and preserves a useful rejection receipt message. Current generic OrchestratorDispatchError.message only says failed to dispatch, so merely changing cause would lose D5 detail on rejected-command replay. UserFacingErrors.ts already extracts non-generic Error.message recursively; N/A edit there. Error fields do not contain answers, attachments, raw causes, or reason. Main owns the proposed legacy unknown wording (OQ2).

Before, current source `apps/server/src/orchestration-v2/Orchestrator.ts:133–145`:

```ts
  133 | export class OrchestratorDispatchError extends Schema.TaggedError<OrchestratorDispatchError>()(
  134 |   "OrchestratorDispatchError",
  135 |   {
  136 |     commandId: CommandId,
  137 |     commandType: Schema.String,
  138 |     cause: Schema.optional(Schema.Defect()),
  139 |   },
  140 | ) {
  141 |   override get message(): string {
  142 |     return `Failed to dispatch orchestration command ${this.commandType} (${this.commandId}).`;
  143 |   }
  144 | }
  145 |
```

Before, current source `apps/server/src/orchestration-v2/Orchestrator.ts:256–267`:

```ts
  256 | export const OrchestratorV2Error = Schema.Union([
  257 |   OrchestratorDispatchError,
  258 |   OrchestratorCommandRejectedError,
  259 |   OrchestratorProjectionError,
  260 |   OrchestratorDomainEventStreamError,
  261 |   OrchestratorProviderAdapterError,
  262 |   OrchestratorCommandPreviouslyRejectedError,
  263 |   OrchestratorCommandIdConflictError,
  264 |   OrchestratorSubagentThreadReadOnlyError,
  265 |   OrchestratorThreadAboveModeLimitError,
  266 | ]);
  267 | export type OrchestratorV2Error = typeof OrchestratorV2Error.Type;
```

After, apply this diff (line numbers above are evidence, not patch content):

```diff
@@
 import {
+  UserInputRespondedBy,
+  RuntimeRequestId,
@@
 export class OrchestratorDispatchError extends Schema.TaggedError<OrchestratorDispatchError>()(
@@
 }
+
+export class OrchestratorQuestionAlreadyAnsweredError extends Schema.TaggedError<OrchestratorQuestionAlreadyAnsweredError>()(
+  "OrchestratorQuestionAlreadyAnsweredError",
+  {
+    commandId: CommandId,
+    requestId: RuntimeRequestId,
+    respondedBy: Schema.optional(UserInputRespondedBy),
+    resolvedAt: Schema.NullOr(Schema.DateTimeUtc),
+  },
+) {
+  override get message(): string {
+    const responder = this.respondedBy?.type === "agent"
+      ? `orchestrator "${this.respondedBy.title ?? this.respondedBy.threadId}" (${this.respondedBy.threadId})`
+      : this.respondedBy?.type === "user" ? "the user" : "an unknown responder";
+    const time = this.resolvedAt === null ? "an unknown time" : DateTime.formatIso(this.resolvedAt);
+    return `This question was already answered by ${responder} at ${time}.`;
+  }
+}
@@
 export const OrchestratorV2Error = Schema.Union([
+  OrchestratorQuestionAlreadyAnsweredError,
   OrchestratorDispatchError,
```

### 4.4 Lock-protected answer guard and provenance propagation

**MODIFY `apps/server/src/orchestration-v2/Orchestrator.ts`**

Keep the same messageId, active-steering/queue selection, and event transaction. Prefix affects only model-facing message text; questionAnswer.answers and live outbox request.answers remain byte-for-byte command.answers. Required message answers still validate before commit; a blank required answer rolls back all planned updates. User/legacy message answers retain their current text/createdBy. Approval defense-in-depth only recognizes agent metadata; authenticated MCP tools already exclude approvals. No adapter is modified, and provenance is not passed as an answer value or provider-native protocol field.

Before, current source `apps/server/src/orchestration-v2/Orchestrator.ts:7267–7280`:

```ts
 7267 |       if (runtimeRequest.status !== "pending") {
 7268 |         return yield* new OrchestratorDispatchError({
 7269 |           commandId: command.commandId,
 7270 |           commandType: command.type,
 7271 |           cause: `Runtime request ${command.requestId} is ${runtimeRequest.status}.`,
 7272 |         });
 7273 |       }
 7274 |       if (runtimeRequest.responseCapability.type === "not_resumable") {
 7275 |         return yield* new OrchestratorDispatchError({
 7276 |           commandId: command.commandId,
 7277 |           commandType: command.type,
 7278 |           cause: runtimeRequest.responseCapability.reason,
 7279 |         });
 7280 |       }
```

Before, current source `apps/server/src/orchestration-v2/Orchestrator.ts:7294–7301`:

```ts
 7294 |       const now = yield* DateTime.now;
 7295 |       const resolvedRequest = {
 7296 |         ...runtimeRequest,
 7297 |         status: "resolved" as const,
 7298 |         resolvedAt: now,
 7299 |         ...(command.decision === undefined ? {} : { decision: command.decision }),
 7300 |         ...(command.answers === undefined ? {} : { answers: command.answers }),
 7301 |       };
```

Before, current source `apps/server/src/orchestration-v2/Orchestrator.ts:7361–7371`:

```ts
 7361 |                   questionAnswer: {
 7362 |                     requestId: command.requestId,
 7363 |                     answers: command.answers ?? {},
 7364 |                     attachmentsByQuestionId: command.attachmentsByQuestionId ?? {},
 7365 |                     questionTextById: Object.fromEntries(
 7366 |                       approvalTurnItem.questions.map((question) => [
 7367 |                         question.id,
 7368 |                         question.question,
 7369 |                       ]),
 7370 |                     ),
 7371 |                   },
```

Before, current source `apps/server/src/orchestration-v2/Orchestrator.ts:7442–7454`:

```ts
 7442 |         // The resolution and normal message dispatch share one event transaction.
 7443 |         return yield* dispatchMessage(
 7444 |           {
 7445 |             type: "message.dispatch",
 7446 |             commandId: command.commandId,
 7447 |             threadId: command.threadId,
 7448 |             messageId: MessageId.make(`async-answer:${command.requestId}`),
 7449 |             text: replies.join("\n\n"),
 7450 |             attachments: [],
 7451 |             createdBy: "user",
 7452 |             creationSource: "server",
 7453 |             dispatchMode,
 7454 |           },
```

After, apply this diff (line numbers above are evidence, not patch content):

```diff
@@
       if (runtimeRequest.status !== "pending") {
+        if (runtimeRequest.kind === "user_input")
+          return yield* new OrchestratorQuestionAlreadyAnsweredError({
+            commandId: command.commandId,
+            requestId: command.requestId,
+            ...(runtimeRequest.respondedBy === undefined ? {} : { respondedBy: runtimeRequest.respondedBy }),
+            resolvedAt: runtimeRequest.resolvedAt,
+          });
         return yield* new OrchestratorDispatchError({
@@
       }
+      if (command.respondedBy?.type === "agent" && runtimeRequest.kind !== "user_input")
+        return yield* new OrchestratorDispatchError({
+          commandId: command.commandId,
+          commandType: command.type,
+          cause: "Only the user can answer approval requests.",
+        });
       if (runtimeRequest.responseCapability.type === "not_resumable") {
@@
         resolvedAt: now,
+        ...(command.respondedBy === undefined ? {} : { respondedBy: command.respondedBy }),
@@
                     requestId: command.requestId,
+                    ...(command.respondedBy === undefined ? {} : { respondedBy: command.respondedBy }),
                     answers: command.answers ?? {},
@@
         // The resolution and normal message dispatch share one event transaction.
+        const agentResponder = command.respondedBy?.type === "agent" ? command.respondedBy : undefined;
+        const answerText = replies.join("\n\n");
         return yield* dispatchMessage(
@@
-            text: replies.join("\n\n"),
+            text: agentResponder === undefined
+              ? answerText
+              : `Answered by orchestrator "${agentResponder.title ?? agentResponder.threadId}" (${agentResponder.threadId}): ${agentResponder.reason}\n\n${answerText}`,
             attachments: [],
-            createdBy: "user",
+            createdBy: agentResponder === undefined ? "user" : "agent",
+            ...(agentResponder === undefined ? {} : { senderThreadId: agentResponder.threadId }),
             creationSource: "server",
```

### 4.5 MCP invalid_request mapping

**MODIFY `apps/server/src/mcp/threadAccess.ts`**

Retain the existing bounded mapping for other string causes and unavailable() for storage failures. The typed D5 message uses only persisted responder identity and resolution time and is returned verbatim. It intentionally excludes reason/answers. Normal fresh MCP calls use newCommandId on every response attempt; no tool clientRequestId is added. Same successful orchestration command ID still replays its receipt once; a distinct losing command receives D5. Existing OrchestratorCommandPreviouslyRejectedError behavior is unchanged on direct command retries.

Before, current source `apps/server/src/mcp/threadAccess.ts:25–35`:

```ts
   25 | /** Decider string rejections are public; wrapped storage and hydration causes are not. */
   26 | export const dispatchFailure = (error: OrchestratorV2Error) =>
   27 |   (error._tag === "OrchestratorDispatchError" ||
   28 |     error._tag === "OrchestratorCommandRejectedError") &&
   29 |   typeof error.cause === "string" &&
   30 |   error.cause.length > 0
   31 |     ? new OrchestratorMcpFailure({
   32 |         code: "orchestration_error",
   33 |         message: Array.from(error.cause).slice(0, 1000).join(""),
   34 |       })
   35 |     : unavailable();
```

After, apply this diff (line numbers above are evidence, not patch content):

```diff
@@
-export const dispatchFailure = (error: OrchestratorV2Error) =>
-  (error._tag === "OrchestratorDispatchError" ||
+export const dispatchFailure = (error: OrchestratorV2Error) =>
+  error._tag === "OrchestratorQuestionAlreadyAnsweredError"
+    ? new OrchestratorMcpFailure({ code: "invalid_request", message: error.message })
+    : (error._tag === "OrchestratorDispatchError" ||
     error._tag === "OrchestratorCommandRejectedError") &&
```

### 4.6 Definitive planning failure releases claimed uploads

**MODIFY `apps/server/src/orchestration-v2/ThreadMessageIntake.ts`**

This typed error can only arise before the command commits under dispatchRuntimeRequestRespond. Treat it as a definite rejection so raced human attachment claims are released by the existing tapError path. Do not classify generic OrchestratorDispatchError as definitely unaccepted; it can occur after commit.

Before, current source `apps/server/src/orchestration-v2/ThreadMessageIntake.ts:19–29`:

```ts
   19 |   switch (error._tag) {
   20 |     case "OrchestratorCommandRejectedError":
   21 |     case "OrchestratorProjectionError":
   22 |     case "OrchestratorProviderAdapterError":
   23 |     case "OrchestratorCommandPreviouslyRejectedError":
   24 |     case "OrchestratorCommandIdConflictError":
   25 |     case "OrchestratorSubagentThreadReadOnlyError":
   26 |     case "OrchestratorThreadAboveModeLimitError":
   27 |       return true;
   28 |     default:
   29 |       return false;
```

After, apply this diff (line numbers above are evidence, not patch content):

```diff
@@
     case "OrchestratorCommandRejectedError":
+    case "OrchestratorQuestionAlreadyAnsweredError":
     case "OrchestratorProjectionError":
```

## 5. Minimal answer-history display and enum consumers

### 5.1 Legacy runtime-request fallback retains provenance

**MODIFY `packages/client-runtime/src/state/threadRequests.ts`**

Only applies to a resolved request with answers and a user_input_request item that lacks questionAnswer. Existing saved questionAnswer wins; do not overwrite its metadata or attachments. Keep the WeakMap and reference identity cache intact.

Before, current source `packages/client-runtime/src/state/threadRequests.ts:153–160`:

```ts
  153 |                   questionAnswer: {
  154 |                     requestId: request.id,
  155 |                     answers: request.answers,
  156 |                     attachmentsByQuestionId: {},
  157 |                     questionTextById: Object.fromEntries(
  158 |                       item.questions.map((question) => [question.id, question.question]),
  159 |                     ),
  160 |                   },
```

After, apply this diff (line numbers above are evidence, not patch content):

```diff
@@
                     requestId: request.id,
+                    ...(request.respondedBy === undefined ? {} : { respondedBy: request.respondedBy }),
                     answers: request.answers,
```

### 5.2 Shared attribution text in the existing question helper

**MODIFY `packages/client-runtime/src/work-log/userInput.ts`**

Existing package subpath work-log/user-input maps to work-log/userInput.ts (package.json:322–324); no package export edit. Test observable text here without rendering static markup to assert props. Do not append this label into getQuestionAnswerText, getQuestionAnswerPreview or hasQuestionAnswer: it is historical provenance, not an answer.

Before, current source `packages/client-runtime/src/work-log/userInput.ts:1–14`:

```ts
    1 | import { type UserInputAttachmentAnswerPayload } from "@t3tools/contracts";
    2 |
    3 | function record(value: unknown): Record<string, unknown> | undefined {
    4 |   return value !== null && typeof value === "object" && !Array.isArray(value)
    5 |     ? (value as Record<string, unknown>)
    6 |     : undefined;
    7 | }
    8 |
    9 | export function getQuestionAnswerText(value: unknown): string {
   10 |   if (typeof value === "string") return value;
   11 |   if (Array.isArray(value)) return value.map(getQuestionAnswerText).filter(Boolean).join(", ");
   12 |   const nested = record(value);
   13 |   return nested ? getQuestionAnswerText(nested.answers) : "";
   14 | }
```

After, apply this diff (line numbers above are evidence, not patch content):

```diff
@@
 import { type UserInputAttachmentAnswerPayload } from "@t3tools/contracts";
+
+/** Additional history detail for a recorded agent answer; unknown history stays quiet. */
+export function getQuestionAnswerAttribution(answer: UserInputAttachmentAnswerPayload): string | null {
+  const responder = answer.respondedBy;
+  return responder?.type === "agent"
+    ? `Answered by ${responder.title ?? responder.threadId}: ${responder.reason}`
+    : null;
+}
```

### 5.3 Web/desktop history attribution

**MODIFY `apps/web/src/components/chat/MessagesTimeline.tsx`**

Use the existing helper import from client-runtime/work-log/user-input. One plain p in the current history container; no new badge/Button variant, no components/ui className overrides, no link, animation, extra collapse state, or styling system. React text escapes title/reason. Render full reason including line breaks and wrap long words. Desktop uses this same web component; no Electron IPC change. The question icon branch is necessary because source satisfies never otherwise breaks typecheck.

Before, current source `apps/web/src/components/chat/MessagesTimeline.tsx:11–18`:

```ts
   11 | import {
   12 |   getQuestionAnswerPreview,
   13 |   getQuestionAnswerText,
   14 |   getQuestionTextPreview,
   15 |   hasQuestionAnswer,
   16 | } from "@t3tools/client-runtime/work-log/user-input";
   17 | import {
   18 |   deriveTimelineMinimapItems,
```

Before, current source `apps/web/src/components/chat/MessagesTimeline.tsx:5801–5811`:

```ts
 5801 |   const urls = useAssetUrls(activeThreadEnvironmentId, resources);
 5802 |   return (
 5803 |     <div className="ms-7 mt-2 space-y-2" onClick={stopRowToggle}>
 5804 |       {[
 5805 |         ...new Set([
 5806 |           ...Object.keys(answer.questionTextById ?? {}),
 5807 |           ...Object.keys(answer.answers),
 5808 |           ...Object.keys(answer.attachmentsByQuestionId),
 5809 |         ]),
 5810 |       ].map((questionId) => (
 5811 |         <div key={questionId} className="space-y-1">
```

Before, current source `apps/web/src/components/chat/MessagesTimeline.tsx:5276–5292`:

```ts
 5276 |     switch (source.kind) {
 5277 |       case "subagent":
 5278 |       case "delegated_task":
 5279 |         return "bot";
 5280 |       case "command":
 5281 |         return "terminal";
 5282 |       case "monitor":
 5283 |         return "eye";
 5284 |       case "background_task":
 5285 |         return "zap";
 5286 |       case "system":
 5287 |         return "t3-code";
 5288 |       default:
 5289 |         source satisfies never;
 5290 |         return "zap";
 5291 |     }
 5292 |   }
```

After, apply this diff (line numbers above are evidence, not patch content):

```diff
@@
   getQuestionAnswerText,
+  getQuestionAnswerAttribution,
@@
   const urls = useAssetUrls(activeThreadEnvironmentId, resources);
+  const attribution = getQuestionAnswerAttribution(answer);
   return (
     <div className="ms-7 mt-2 space-y-2" onClick={stopRowToggle}>
+      {attribution === null ? null : (
+        <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{attribution}</p>
+      )}
@@
       case "monitor":
         return "eye";
+      case "question":
+        return "message-circle";
       case "background_task":
```

### 5.4 Mobile history attribution

**MODIFY `apps/mobile/src/features/threads/QuestionAnswerHistory.tsx`**

One AppText row using the same muted text style as existing question text. The existing component is used by thread-work-log.tsx:1138. User/unknown records return null and add no line. Text/attachments and environment-scoped asset loading remain untouched.

Before, current source `apps/mobile/src/features/threads/QuestionAnswerHistory.tsx:6–9`:

```ts
    6 | import { Image, Linking, Pressable, View } from "react-native";
    7 | import { getQuestionAnswerText } from "@t3tools/client-runtime/work-log/user-input";
    8 | import { AppText as Text } from "../../components/AppText";
    9 | import { useAssetUrl } from "../../state/assets";
```

Before, current source `apps/mobile/src/features/threads/QuestionAnswerHistory.tsx:37–49`:

```ts
   37 | export function QuestionAnswerHistory(props: {
   38 |   environmentId: EnvironmentId;
   39 |   answer: UserInputAttachmentAnswerPayload;
   40 | }) {
   41 |   return (
   42 |     <View className="gap-2">
   43 |       {[
   44 |         ...new Set([
   45 |           ...Object.keys(props.answer.questionTextById ?? {}),
   46 |           ...Object.keys(props.answer.answers),
   47 |           ...Object.keys(props.answer.attachmentsByQuestionId),
   48 |         ]),
   49 |       ].map((questionId) => (
```

After, apply this diff (line numbers above are evidence, not patch content):

```diff
@@
-import { getQuestionAnswerText } from "@t3tools/client-runtime/work-log/user-input";
+import { getQuestionAnswerText, getQuestionAnswerAttribution } from "@t3tools/client-runtime/work-log/user-input";
@@
 }) {
+  const attribution = getQuestionAnswerAttribution(props.answer);
   return (
     <View className="gap-2">
+      {attribution === null ? null : (
+        <Text className="text-sm text-foreground-muted">{attribution}</Text>
+      )}
```

### 5.5 Exhaustive notification navigation consumer

**MODIFY `packages/client-runtime/src/state/threadExecution.ts`**

notificationChildThreadId navigates only subagent/delegated task children. D2 does not request a new question-row navigation action; return undefined for question. Use source.threadId directly in wp2 model-facing payload rather than pretending it is a childThreadId.

Before, current source `packages/client-runtime/src/state/threadExecution.ts:436–453`:

```ts
  436 | /** The thread a notification row opens: that of the one subagent or delegated task it reports. */
  437 | export function notificationChildThreadId(
  438 |   source: OrchestrationV2NotificationSource,
  439 | ): ThreadId | undefined {
  440 |   switch (source.kind) {
  441 |     case "subagent":
  442 |     case "delegated_task":
  443 |       return source.childThreadId;
  444 |     case "command":
  445 |     case "monitor":
  446 |     case "background_task":
  447 |     case "system":
  448 |       return undefined;
  449 |     default:
  450 |       source satisfies never;
  451 |       return undefined;
  452 |   }
  453 | }
```

After, apply this diff (line numbers above are evidence, not patch content):

```diff
@@
     case "command":
+    case "question":
     case "monitor":
```

### 5.6 Exhaustive mobile notification icon consumer

**MODIFY `apps/mobile/src/lib/threadActivity.ts`**

message is already in ThreadFeedActivity.icon (line 109). No new icon type or renderer. Other background-work switches operate on PendingBackgroundTask/BackgroundWorkReport, not NotificationSource: provider-core/server/notification.ts:116–125, shared/orchestrationV2PendingBackgroundWork.ts:85, RestartBackgroundNote.ts:62, ClaudeAdapterV2.ts:3374. N/A edits there; do not add question to unrelated provider task enums.

Before, current source `apps/mobile/src/lib/threadActivity.ts:513–529`:

```ts
  513 |   if (item.type === "notification") {
  514 |     const source = item.source;
  515 |     switch (source.kind) {
  516 |       case "subagent":
  517 |       case "delegated_task":
  518 |         return "hammer";
  519 |       case "command":
  520 |         return "command";
  521 |       case "monitor":
  522 |         return "eye";
  523 |       case "background_task":
  524 |       case "system":
  525 |         return "zap";
  526 |       default:
  527 |         source satisfies never;
  528 |         return "zap";
  529 |     }
```

After, apply this diff (line numbers above are evidence, not patch content):

```diff
@@
       case "monitor":
         return "eye";
+      case "question":
+        return "message";
       case "background_task":
```

### 5.7 Shared MCP read lifecycle label

**MODIFY `packages/shared/src/t3McpToolPresentation.ts`**

Read now includes resolved history, so pending questions is misleading for that tool. Respond remains [Answer, Answering, Answered, pending questions] and question-respond. It names the operation on the target; provenance is shown in answer history, not a duplicate tool label. Keep t3_pending_request_respond alias mapping (:360) unchanged.

Before, current source `packages/shared/src/t3McpToolPresentation.ts:272–283`:

```ts
  272 |   goat_pending_request_list: tool(
  273 |     ["List", "Listing", "Listed", "pending questions"],
  274 |     "question-list",
  275 |   ),
  276 |   goat_pending_request_read: tool(
  277 |     ["Read", "Reading", "Read", "pending questions"],
  278 |     "question-read",
  279 |   ),
  280 |   goat_pending_request_respond: tool(
  281 |     ["Answer", "Answering", "Answered", "pending questions"],
  282 |     "question-respond",
  283 |   ),
```

After, apply this diff (line numbers above are evidence, not patch content):

```diff
@@
   goat_pending_request_read: tool(
-    ["Read", "Reading", "Read", "pending questions"],
+    ["Read", "Reading", "Read", "questions"],
```

## 6. Whole-chain field and enum audit

Re-run the searches in §9 when implementing. Searches on this snapshot found no pre-existing responder field or orchestration launcher schema (unrelated desktop/CLI launchers are not consumers). The following tables enumerate creation, serialization, deserialization and all consumers of each new member. A row marked N/A is intentional, not an uninspected path.

### 6.1 launcher and its threadId/environmentId/via members

| Stage                                | Paths / handling                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Definition                           | contracts/orchestrationV2.ts: new OrchestrationV2ThreadLauncher; optional AppThread, ThreadShell, thread.create fields. ThreadId/EnvironmentId from baseSchemas.ts; null environment means same environment.                                                                                                                                                                                                 |
| Creation `via=thread_launch`         | mcp/toolkits/project/handlers.ts readCaller → ThreadMessageIntake.launchThread → ThreadLaunchService.launch → thread.create → Orchestrator.dispatchThreadCreate. Also no-message launches, scratch and root/existing-worktree/worktree strategies.                                                                                                                                                           |
| Creation `via=create_threads`        | mcp/OrchestratorMcpService.ts loadThreadCaller → stable thread.create command → same decider.                                                                                                                                                                                                                                                                                                                |
| Creation `via=delegate_task`         | authenticated delegated_task.request → Orchestrator app-owned child creation after makeSubagentChildThread. Parent ID is the caller, lineage unchanged.                                                                                                                                                                                                                                                      |
| Creation `via=ssh_thread_launch`     | N/A wp1: reserved D1 enum member; wp3 stamps authenticated origin seam. Do not add an argument here.                                                                                                                                                                                                                                                                                                         |
| UI/outside/native/legacy             | UI and outside launches omit; native children clear shared-helper inheritance (A1); legacy missing stays missing. App-owned lineage fallback is wp2. Fork clearing is OQ1.                                                                                                                                                                                                                                   |
| Command transport                    | Existing WS command decode from OrchestrationV2Command; internal ThreadLaunchInput carries field directly. Local MCP launch/create/delegate parameters contain no launcher. No client operation is taught to send it. UI does not call thread.create with a launcher.                                                                                                                                        |
| Event serialization                  | thread.created/other thread events use AppThread; AppThreadJson.mapFields at 1997 spreads fields. OrchestrationV2DomainEventJson (:2475/2501) and stored event schemas include full payload.                                                                                                                                                                                                                 |
| Projection serialization             | ProjectionStore.ts:1030–1032 encodeThreadPayload; :1845–1847 writes payload_json (schema version remains 2). Lifecycle/metadata updates spread stored thread; no allowlist drops launcher.                                                                                                                                                                                                                   |
| Projection deserialization           | ProjectionStore.ts:1080–1082 decodeThreadPayload; AppThreadJson optional launcher handles pre-field JSON. SQL schema loaders retain entire decoded thread.                                                                                                                                                                                                                                                   |
| Shell builders/wire                  | ProjectionStore.ts:1482 and :1750 changed; ThreadShellJson.mapFields :2417 keeps ...fields; ShellStream.ts carries whole thread shell; contracts shell snapshots/subscriptions, RPC getThreadShell and getThreadHistory consume updated type.                                                                                                                                                                |
| Client serialization/deserialization | client-runtime RPC schemas derive from contracts. mobile/connection/shell-cache-encoding.ts encodes ThreadShellJson; connection shell cache decodes shared JSON schema. Desktop reuses web runtime. No separate manual launcher codec.                                                                                                                                                                       |
| Current consumers                    | mcp/threadAccess.ts consumes ThreadShell; client-runtime/state/orchestrationV2Projection.ts copies thread.created payload; client state stores/snapshots keep shell. No wp1 launcher rendering or target-ceiling bypass. OrchestratorMcpService's manually built thread-summary output does not advertise launcher; N/A because neither current tools nor wp2/3 rely on that summary for launcher discovery. |
| Next-phase consumers                 | wp2 QuestionEscalationService uses exact local launcher and app-owned legacy fallback; wp3 launched-scope query uses persisted thread/shell launcher. Neither is implemented here.                                                                                                                                                                                                                           |

The three launcher members are transported together without remapping: threadId comes from authenticated caller; environmentId is explicitly null on all three local writes; via records the launch path. No lineage enum additions or history backfills.

### 6.2 respondedBy, user/agent, agent threadId/environmentId/title/reason

| Stage                                 | Paths / handling                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Definition                            | providerPolicy.ts UserInputResponseReason and UserInputRespondedBy; optional on UserInputAttachmentAnswerPayload; orchestrationV2.ts imports it for command/runtime request. Each agent member required (title/environmentId nullable); user has only type.                                                                                                                          |
| Creation user                         | WS dispatchCommand → ThreadManagementService.withCreationProvenance overwrites any supplied responder. User client operations/commands.ts:834–857 continue to send ordinary answers/attachments/decision.                                                                                                                                                                            |
| Creation agent                        | thread tool validated reason → readQuestion/readCaller shell → agent caller.id, environmentId:null, caller.title, input.reason. Caller not inferred from target, launcher or arguments. Outside response unresolved A2.                                                                                                                                                              |
| Creation unknown                      | Legacy commands, settle cancellation at Orchestrator.ts:2641–2648, and thread.user-input.dismiss at :7502–7509 may omit respondedBy. N/A synthesizing identity: unknown must stay unknown; these cancellation paths don't build answer history.                                                                                                                                      |
| Command serialization/deserialization | OrchestrationV2Command runtime-request.respond schema is shared by WS decoder and ThreadManagement dispatch. MCP has required reason but no respondedBy parameter. JS construction passes schema-derived metadata internally. No raw provider protocol additions.                                                                                                                    |
| Resolution                            | dispatchRuntimeRequestRespond copies the complete union into resolved request and user_input_request.questionAnswer in the same event transaction. Request lock/receipt arbitrates; no check-then-write in the handler.                                                                                                                                                              |
| Request persistence                   | RuntimeRequestJson mapFields (:2119–2125) keeps ...fields and converts dates; ProjectionStore.ts:1055,1104,2319–2354 encodes/decodes/writes JSON. EventSink runtime-request.updated/command receipt and outbox stay in one transaction.                                                                                                                                              |
| History persistence                   | Both user_input_request members (:1424–1430 runtime, :2203–2209 JSON) reference shared AnswerPayload; ProjectionStore.ts:1064,1112,2429 serializes/deserializes complete turn items.                                                                                                                                                                                                 |
| Message-mode consumer                 | Orchestrator builds agent createdBy/senderThreadId/prefix; conversation message schema already supports those fields (:1124,1389,2169,2849). Existing provider start/steer services receive text. No native answer values change.                                                                                                                                                    |
| Live-mode consumer                    | Orchestrator.ts:7460–7472 outbox only carries existing answers/decision; RuntimeRequestService.ts:88–122 requires persisted resolution before adapter response. N/A provenance in provider response schema, because application history owns it.                                                                                                                                     |
| Wire/detail consumers                 | WireProjection.ts projects/compacts turn items without filtering user_input_request.questionAnswer; contracts paged detail/stream schemas retain payload. client-runtime/state/orchestrationV2Projection.ts:245–251 upserts complete runtimeRequests and items.                                                                                                                      |
| Fallback consumer                     | client-runtime/state/threadRequests.ts:153 retains union when reconstructing missing history; saved history is not replaced.                                                                                                                                                                                                                                                         |
| Work-log/history consumers            | client-runtime/work-log/presentation.ts TimelineWorkEntry.questionAnswer and work-log summary/detail helpers preserve payload; userInput.ts attribution formats agent title ?? threadId + reason. Web MessagesTimeline and mobile QuestionAnswerHistory render it; desktop uses web. Preview/hasQuestionAnswer/text helpers intentionally do not treat provenance as answer content. |
| Stale-tool/error consumers            | pending_request_read returns optional respondedBy and ISO resolvedAt for resolved history; already-answered domain error uses type/title/threadId/time, omits reason; threadAccess.dispatchFailure maps to invalid_request. WS UserFacingErrors already displays typed Error.message.                                                                                                |
| Identity fields                       | agent.environmentId:null denotes local responder; wp1 does not route remote IDs. title is a resolution-time snapshot, not a later shell lookup, so renames/deletions do not rewrite history. reason is stored exactly and only appended to message-mode prefix/display, never to the option value.                                                                                   |

Literal `questionAnswer`/answer-type consumer inventory from the final source search (all N/A edits except the explicitly patched history components/projector):

- `apps/web/src/session-logic.ts:69,557–558,622–623,963`: typed work entry, copies whole payload, labels answered questions, folds async-answer message IDs, keeps answered item detail. `MessagesTimeline.tsx:3968–4025,5498–5569,5667–5744`: heading/preview/detail/expand checks; passes whole answer to history. The new responder must not change answer-preview availability or expand state.
- `apps/mobile/src/lib/threadActivity.ts:355,729–730,843,1758–1759`: answered grouping, whole-payload copy, detail availability, async-answer folding. `features/threads/thread-work-log.tsx:980–981,1079–1080,1130–1140`: previews and existing history mount; preserves all metadata without rebuilding it.
- `apps/server/src/orchestration-v2/ThreadFind.ts:88–89,376–377`: folds duplicate async-answer messages into question history by requestId; does not index new provenance text, so no unrequested search-policy expansion. `ThreadMessageIntake.ts:98–115`: uses persisted history to retain accepted attachment claims; responder metadata does not affect this acceptance check. The typed rejection cleanup hunk is separate.
- `packages/client-runtime/src/work-log/presentation.ts:66` is the shared work-entry type; `work-log/userInput.ts:16,23,39` preview/has-answer functions intentionally examine question/answer/attachment content only. Both contract runtime/JSON question item definitions reference the expanded payload and require no duplicate responder field.

Launcher/query lineage and notification consumers were also searched separately; unrelated shell/CLI launcher names and non-notification source.kind switches are excluded for the type-specific reasons in §§6.1/6.3.

### 6.3 question source and threadId/requestId/humanRequired

| Stage                   | Paths / handling                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Creation                | N/A wp1 production producer. wp2 builds question and resolution notifications; contract fixtures create examples. humanRequired always explicit Boolean, not default false.                                                                                                                                                         |
| Serialization           | OrchestrationV2NotificationSource → Notification → message.dispatch.notification → ConversationMessage[Json], notification turn-item [Json]. Existing Orchestrator dispatchMessage builds notification items; ProjectionStore encodes message and turn-item JSON. All three question fields survive.                                |
| Deserialization         | same shared schemas. Current old clients using kindUnionWithFallback treat unknown question as background_task; new known malformed records fail decoding. No DB migration or provider event enum edit.                                                                                                                             |
| Wire/client persistence | stored domain events, paged history, shell/thread subscriptions and client item stores carry notification source. Mobile shell cache receives any relevant shared contracts; there is no notification-specific cache codec.                                                                                                         |
| Exhaustive consumers    | web MessagesTimeline.workEntryIconName → message-circle; mobile threadActivity.itemIcon → message; shared client threadExecution.notificationChildThreadId → undefined.                                                                                                                                                             |
| Other consumers         | work-log presentation shows summary/detail generically; notification filtering for kind=monitor in provider-core/subagentProjection.ts and mcp/OrchestratorMcpService.ts intentionally ignores question. provider-core/notification.ts builds sources from BackgroundWorkReport and doesn't switch on NotificationSource; N/A edit. |
| Agent/provider consumer | text from message.dispatch, existing start/steer path. N/A provider-specific structured goat-question event; D2's model-facing text production is wp2.                                                                                                                                                                              |
| Next phase              | wp2 uses requestId for deterministic escalation/reconciliation, threadId as asking thread, humanRequired for forward-to-human instruction. Launcher relationship adds no authority.                                                                                                                                                 |

### 6.4 MCP reason/status/respondedBy/resolvedAt and typed error chain

- **reason:** MCP tool parameter schema → generated reference-free input JSON schema (Tool.getJsonSchema) → MCP input decode → authenticated command agent record → runtime request/history JSON → model-facing message prefix and history attribution. Missing/empty/overlong fails parameter decoding, before dispatch. No read/list parameter gets reason. The same reason schema also validates stored agent provenance. Client answer values never gain reason.
- **status:** existing runtime status enum reused in read result, no new literal. readQuestion → response status → Tool success schema/output JSON → caller gets pending/resolved/expired/cancelled. List's pending filter unchanged. A resolved read is read-only and does not re-answer.
- **respondedBy in read:** omitted for legacy, otherwise same union; schema→structured MCP output→caller. N/A separate client UI consumer of tool success: tool result is generic tool history, attribution comes from the resolved request/item.
- **resolvedAt in read:** runtime DateTimeUtc/null → DateTime.formatIso/null → IsoDateTime/null Tool output → caller. No new clock/deadline is invented. pending typically has null, resolved has stored time, historical anomalous null stays null.
- **OrchestratorQuestionAlreadyAnsweredError:** guarded non-pending user_input request inside existing dispatch lock → structured error with saved identity/time → rejected receipt stores error.message → MCP dispatchFailure returns invalid_request verbatim; WS UserFacingErrors extracts message. Add union membership and definitive-attachment-rejection consumer. No change to wire error schema/scopes; transport still wraps in existing dispatch/MCP failure.

## 7. Conditional paths: activation and observable proof

| Guard / fallback                | Activation                                                            | Observable proof (test in §8)                                                                                             |
| ------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| no caller launcher              | UI launch or outside MCP launch has no authenticated thread           | persisted thread/shell lacks launcher; no invented ID; ordinary launch succeeds                                           |
| launcher even without prompt    | goat_thread_launch or create_threads with no initial message          | thread.created launcher exists and messages stays empty                                                                   |
| intake passthrough              | no upload versus pending attachment upload                            | captured launch input launcher equal in both branches; uploaded assets still claimed                                      |
| root/existing/worktree          | service chooses different workspace strategies                        | the actual thread.create has same launcher before preparation; await preparation Deferred if asserting preparation        |
| receipt replay                  | same stable create/delegate command invoked twice                     | one created child and original launcher, no replacement event                                                             |
| native versus app-owned         | parent itself has a launcher and creates a native/app-owned child     | native launcher absent (A1); app-owned launcher names immediate parent, not grandparent                                   |
| fork copied source              | source has launcher, user forks                                       | proposed OQ1 default clears launcher; ancestry still fork/root inherited                                                  |
| old optional fields             | decoded persisted record predates wp1                                 | decoded record succeeds; history adds no attribution row                                                                  |
| forged WS agent                 | authenticated user command contains fake agent/thread/reason          | helper overwrites to user; persisted request/history and message authorship are user                                      |
| unrelated command               | helper sees run.interrupt etc.                                        | reference identity unchanged; creation stamping tests still pass                                                          |
| threadless response             | outside client has explicit target and reason but no source thread    | pending response fails invalid_request under proposed A2; read/list/launch still succeed                                  |
| missing/wrong request           | request absent, wrong kind or user_input item absent                  | invalid_request, no events; approval IDs never become agent answers                                                       |
| pending live                    | live provider callback waiting for answer                             | saved request/item agent metadata; effect-worker drain or response Deferred proves unchanged answers reach provider       |
| pending message                 | asking provider exited, or active steering is available/unavailable   | async-answer message has agent createdBy + senderThreadId + exact prefix; queue/steer policy unchanged                    |
| invalid message answer          | required string blank/no supplied usable reply                        | no resolution/history/message commits; pending remains pending                                                            |
| first answer wins               | two distinct responders dispatch same pending request                 | only one resolved event/history answer; losing error names stored winner/time; no second async message/live delivery      |
| idempotent successful retry     | exact accepted commandId repeats                                      | same receipt/result sequence, one answer/message/effect; not D5                                                           |
| already resolved legacy         | answered record lacks identity or time                                | error says unknown responder/time; read returns resolved + absent respondedBy + stored/null resolvedAt                    |
| expired/cancelled               | stale read sees non-answer terminal status                            | read status visible; respond uses the D5 typed rejection with stored or unknown responder/time                            |
| above ceiling                   | target already above caller or modes raised while call waits for lock | original ceiling failure code retained; no resolution; wp2/3 add forwarding guidance, no implicit authority from launcher |
| not resumable / missing session | pending request cannot resume or session missing                      | existing public reason/error remains; no request/history updates                                                          |
| direct agent approval defense   | internal respondedBy agent with non-user_input kind                   | decider rejects before recording resolution or approval effect                                                            |
| fallback historical row         | resolved runtime answers exist but timeline questionAnswer absent     | projector copies respondedBy and caches identity; existing history/attachments unchanged                                  |
| agent/user/unknown display      | answered history metadata variant                                     | agent label exactly Answered by <title>: <reason>; null title uses ID; user/absent no extra label                         |
| question enum                   | new well-formed notification/current-old decoder/malformed member     | all fields round-trip; old helper falls back; malformed known kind rejects; icon consumers typecheck                      |
| upload race loser               | human uploads attachments then loses answering race                   | typed planning failure releases owned claimed uploads; winner attachments and persisted answer untouched                  |

D5 literally specifies the already-answered sentence for a non-pending request. This implementation therefore uses it for every non-pending user_input status, including expired/cancelled, with explicit unknown fallbacks when metadata is absent. The read tool still exposes the real status. OQ2 requests clarification of that wording; do not change it to a different status-specific policy without main disposition. Approval-kind non-pending requests retain their existing status error. No resolution notices or queued-run cancellation are implemented here; those remain wp2.

## 8. Focused tests and implementation recipes

Every case below names a specific file, harness, activation, and assertion. These are acceptance tests for future implementation, not tests run by this docs-only task. No live provider, HTTP listener, server or browser is required. Use `@effect/vitest` it.effect/it.layer for services; use vite-plus/test for pure client functions. Backend side effects run after command commit: use `EffectWorker.OrchestrationEffectWorkerV2.drain()` or await the exact persisted event/adapter Deferred. Never add sleeps, repeated waitUntil/polling, TestClock delay advancement to make an answer arrive, or static-markup prop/callback tests. Existing harnesses contain waitUntil helpers for older tests; new wp1 cases must not reuse those helpers.

### 8.1 Complete pure test hunks

These are executable additions with existing fixture functions. Add the named schema/ID/helper imports to the existing blocks; do not introduce runtime service mocks for pure tests.

**MODIFY `packages/contracts/src/orchestrationV2.test.ts`**. Existing imports are at :5–44; `emptyThreadProjection()` at :47 returns a valid schema input. Existing background-work notification tests at :1334–1415 already exercise unknown fallback. Extend them with question cases; do not replace older compatibility tests.

Before `packages/contracts/src/orchestrationV2.test.ts:5–24`:

```ts
    5 | import {
    6 |   CheckpointId,
    7 |   CheckpointRef,
    8 |   CheckpointScopeId,
    9 |   ContextTransferId,
   10 |   CommandId,
   11 |   EventId,
   12 |   MessageId,
   13 |   NodeId,
   14 |   NonNegativeInt,
   15 |   ProjectId,
   16 |   ProviderInstanceId,
   17 |   ProviderReplayTranscript,
   18 |   ProviderThreadId,
   19 |   RunAttemptId,
   20 |   RunId,
   21 |   ThreadId,
   22 |   TrimmedNonEmptyString,
   23 |   TurnItemId,
   24 | } from "./index.ts";
```

After import additions and appended tests:

```diff
@@
   CommandId,
+  EnvironmentId,
@@
   RunId,
+  RuntimeRequestId,
@@
   TurnItemId,
+  UserInputRespondedBy,
+  UserInputResponseReason,
+  UserInputAttachmentAnswerPayload,
@@
 import {
+  OrchestrationV2AppThread,
+  OrchestrationV2AppThreadJson,
+  OrchestrationV2NotificationSource,
@@
+describe("question foundations", () => {
+  it("round-trips launcher on thread payloads and accepts legacy absence", () => {
+    const input = emptyThreadProjection().thread;
+    const decode = Schema.decodeUnknownSync(OrchestrationV2AppThread);
+    const encodeJson = Schema.encodeSync(OrchestrationV2AppThreadJson);
+    const decodeJson = Schema.decodeUnknownSync(OrchestrationV2AppThreadJson);
+    for (const via of ["thread_launch", "create_threads", "ssh_thread_launch", "delegate_task"] as const) {
+      const launcher = { threadId: ThreadId.make("caller"), environmentId: null, via };
+      const thread = decode({ ...input, launcher });
+      expect(decodeJson(encodeJson(thread)).launcher).toEqual(launcher);
+    }
+    expect(decodeJson(encodeJson(decode(input))).launcher).toBeUndefined();
+  });
+
+  it("requires every agent responder member and bounds reason", () => {
+    const decode = Schema.decodeUnknownSync(UserInputRespondedBy);
+    const reason = Schema.decodeUnknownSync(UserInputResponseReason);
+    const agent = {
+      type: "agent" as const,
+      threadId: ThreadId.make("caller"),
+      environmentId: null,
+      title: null,
+      reason: "R",
+    };
+    expect(decode({ type: "user" })).toEqual({ type: "user" });
+    expect(decode(agent)).toEqual(agent);
+    expect(reason("R".repeat(2000))).toHaveLength(2000);
+    expect(() => reason("")).toThrow();
+    expect(() => reason("R".repeat(2001))).toThrow();
+    for (const key of ["threadId", "environmentId", "title", "reason"] as const) {
+      const incomplete: Record<string, unknown> = { ...agent };
+      delete incomplete[key];
+      expect(() => decode(incomplete)).toThrow();
+    }
+    const outsideEnvironment = EnvironmentId.make("origin");
+    expect(decode({ ...agent, environmentId: outsideEnvironment })).toEqual({ ...agent, environmentId: outsideEnvironment });
+  });
+
+  it("accepts unknown answer provenance and preserves recorded agent metadata", () => {
+    const decode = Schema.decodeUnknownSync(UserInputAttachmentAnswerPayload);
+    const old = { requestId: "request", answers: { q: "  Exact option  " }, attachmentsByQuestionId: {} };
+    expect(decode(old).respondedBy).toBeUndefined();
+    const respondedBy = { type: "agent" as const, threadId: ThreadId.make("caller"), environmentId: null, title: "Coordinator", reason: "Matches the brief" };
+    expect(decode({ ...old, respondedBy })).toEqual({ ...old, respondedBy });
+  });
+
+  it("round-trips question source and rejects malformed known questions", () => {
+    const decode = Schema.decodeUnknownSync(OrchestrationV2NotificationSource);
+    const encode = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2NotificationSource));
+    const source = { kind: "question" as const, threadId: ThreadId.make("asking"), requestId: RuntimeRequestId.make("request"), humanRequired: true };
+    expect(decode(encode(source))).toEqual(source);
+    for (const key of ["threadId", "requestId", "humanRequired"] as const) {
+      const incomplete: Record<string, unknown> = { ...source };
+      delete incomplete[key];
+      expect(() => decode(incomplete)).toThrow();
+    }
+    expect(decode({ kind: "future-question-kind" })).toEqual({ kind: "background_task" });
+  });
+});
```

Additionally extend the **existing** source round-trip cases at :1305–1313 with `{ kind: "question", threadId: "asking", requestId: "request", humanRequired: false }` and add a question case to a test-local copy of the current pre-question `kindUnionWithFallback` codec. That old codec must decode new literal question as background_task, while the **new** codec retains the IDs/flag. Do not add question to the `PreSpecificKindsNotification` success cases at :1372–1408: that substantially older literal-only schema has no fallback and would correctly reject it.

The shell and command coverage below extends existing schema tests rather than making a second shell fixture. Test both null and non-null launcher.environmentId, and source humanRequired true/false.

**MODIFY `packages/client-runtime/src/work-log/userInput.test.ts`**. Full pure text behavior addition:

Before `packages/client-runtime/src/work-log/userInput.test.ts:1–17`:

```ts
    1 | import { describe, expect, it } from "vite-plus/test";
    2 | import { ApprovalRequestId, type UserInputAttachmentAnswerPayload } from "@t3tools/contracts";
    3 | import { getQuestionTextPreview } from "./userInput.ts";
    4 |
    5 | function answer(
    6 |   overrides: Partial<UserInputAttachmentAnswerPayload> = {},
    7 | ): UserInputAttachmentAnswerPayload {
    8 |   return {
    9 |     requestId: ApprovalRequestId.make("request-1"),
   10 |     questionTextById: { scope: "Which repository?" },
   11 |     answers: { scope: "Use the private repository" },
   12 |     attachmentsByQuestionId: {},
   13 |     ...overrides,
   14 |   };
   15 | }
   16 |
   17 | describe("getQuestionTextPreview", () => {
```

```diff
@@
-import { ApprovalRequestId, type UserInputAttachmentAnswerPayload } from "@t3tools/contracts";
-import { getQuestionTextPreview } from "./userInput.ts";
+import { ApprovalRequestId, ThreadId, type UserInputAttachmentAnswerPayload } from "@t3tools/contracts";
+import { getQuestionTextPreview, getQuestionAnswerAttribution } from "./userInput.ts";
@@
+describe("getQuestionAnswerAttribution", () => {
+  it("shows agent title and reason without changing answer text", () => {
+    const value = answer({ respondedBy: { type: "agent", threadId: ThreadId.make("caller"), environmentId: null, title: "Coordinator", reason: "Matches the brief\nKeep the option label" } });
+    expect(getQuestionAnswerAttribution(value)).toBe("Answered by Coordinator: Matches the brief\nKeep the option label");
+    expect(value.answers).toEqual({ scope: "Use the private repository" });
+  });
+  it("falls back to agent thread id when title is null", () => {
+    expect(getQuestionAnswerAttribution(answer({ respondedBy: { type: "agent", threadId: ThreadId.make("caller"), environmentId: null, title: null, reason: "R" } }))).toBe("Answered by caller: R");
+  });
+  it("adds nothing for user or unknown provenance", () => {
+    expect(getQuestionAnswerAttribution(answer())).toBeNull();
+    expect(getQuestionAnswerAttribution(answer({ respondedBy: { type: "user" } }))).toBeNull();
+  });
+});
```

**NEW `packages/provider-core/src/server/subagentProjection.test.ts`**, requires A1. Before: no file exists (`rg --files` found only notification.test.ts for this area). Full new-file sketch:

```ts
import { expect, it } from "@effect/vitest";
import { NodeId, OrchestrationV2AppThread, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { makeSubagentChildThread } from "./subagentProjection.ts";

it("does not inherit a launched parent's launcher into native children", () => {
  const now = DateTime.makeUnsafe("2026-10-12T00:00:00.000Z");
  const parentId = ThreadId.make("parent");
  const instanceId = ProviderInstanceId.make("codex");
  const parent = Schema.decodeUnknownSync(OrchestrationV2AppThread)({
    createdBy: "agent",
    creationSource: "mcp",
    id: parentId,
    projectId: "project",
    title: "Parent",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: parentId },
    launcher: { threadId: "grandparent", environmentId: null, via: "thread_launch" },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  });
  const child = makeSubagentChildThread({
    parentThread: parent,
    childThreadId: ThreadId.make("native-child"),
    parentNodeId: NodeId.make("node"),
    activeProviderThreadId: null,
    providerInstanceId: instanceId,
    modelSelection: parent.modelSelection,
    title: "Native child",
    now,
    createdBy: "agent",
    creationSource: "provider",
  });
  expect(child.launcher).toBeUndefined();
  expect(child.lineage).toEqual({
    parentThreadId: parentId,
    relationshipToParent: "subagent",
    rootThreadId: parentId,
  });
  expect(parent.launcher?.threadId).toBe("grandparent");
});
```

### 8.2 Service and projection tests: exact additions

Each entry is **MODIFY** the listed existing test file. Reuse its real subject/service layer; test doubles only stand in for providers/filesystem/transport. The recipes below specify command ordering and observable assertions for the diffs in §§2–5. Add a helper only inside a test file if the same fixture is repeated; do not add application APIs just to expose internals.

| File / current harness anchor                                                                                                                                                        | Exact new or extended test name                                                   | Setup and assertions                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/orchestrationV2.test.ts` Schema.decodeUnknownSync; existing shell decode at :1212                                                                            | `carries launcher through thread.create and thread shell JSON`                    | Extend existing thread.create and shell fixture inputs with launcher. Decode command, encode/decode ThreadShellJson; assert whole record and each via literal. Missing launcher decodes, missing launcher member fails.                                                                                   |
| same contracts test / existing runtime & turn-item JSON decoders                                                                                                                     | `round-trips respondedBy through request and question item JSON`                  | Seed runtime request resolvedAt=now and both user/agent variants; RuntimeRequestJson and TurnItemJson encode/decode retain all fields and untrimmed answers. Legacy optional omission succeeds. runtime-request.respond accepts optional provenance; incomplete agent rejects.                            |
| `apps/server/src/orchestration-v2/ThreadManagementService.test.ts` @effect/vitest, existing provenance tests :27–72                                                                  | `overwrites forged WS response provenance with the user`                          | Create runtime-request.respond with fake agent identity/reason; pass through withCreationProvenance(user/web). Exact respondedBy={type:user}; answers and attachments identical. Missing metadata also stamped. Agent/mcp helper call leaves authoritative caller handling to MCP.                        |
| same helper file                                                                                                                                                                     | `clears forged launcher on a user thread.create command`                          | Extend the existing create-command fixture with a launcher; user/web helper removes it, agent/mcp helper preserves authenticated internal launcher. Existing unrelated run.interrupt reference-identity test remains.                                                                                     |
| `apps/server/src/orchestration-v2/ThreadLaunchService.test.ts` makeHarness(:113), launchInput(:249), ProviderReplayHarness runEffectWorker:false                                     | `records launcher before worktree preparation and keeps it on receipt replay`     | Spread launcher onto launchInput (agent/mcp), with runSetup controlled by Deferred. launch accepted → getThreadRecords/getThreadShell shows same launcher before setup released. Replay exact command ID → one thread, same metadata. Signal setup via Deferred, never waitUntil helper.                  |
| same launch test                                                                                                                                                                     | `keeps UI launches without launcher across workspace strategies`                  | it.effect.each root/existing_worktree/worktree launchInput without new field. Assert persisted launcher undefined. For preparation assertions await setup Deferred; no ambient live state.                                                                                                                |
| same launch test using ThreadMessageIntake already imported                                                                                                                          | `preserves launcher through intake with and without attachment claims`            | Two cases through launchThread: no upload, pending upload. New launcher persists. Uploaded attachment still claimed once and remains associated with intended thread. No launcher mutation on reuseExistingThread; preserve existing draft provenance.                                                    |
| `apps/server/src/mcp/toolkits/project/handlers.test.ts` production ProjectToolkit.handle + McpInvocationContext layer; first case :30–92                                             | `records authenticated launcher even without an initial message`                  | Extend existing source-caller launch test: capture input.launcher in ThreadLaunch mock, call no-message launch. Exact {caller.id,null,thread_launch}, no initialMessage. Repeat with message; senderThreadId unchanged. Tool schema contains no launcher input.                                           |
| same project toolkit test                                                                                                                                                            | `does not invent a launcher for an outside MCP client`                            | Threadless authenticated scope + explicit project/model; capture no launcher. Existing startsThreads ceiling and launch success still work.                                                                                                                                                               |
| `apps/server/src/mcp/OrchestratorMcpService.test.ts` @effect/vitest service layers and captured dispatch requests, scope from :38                                                    | `records create_threads launcher from the authenticated caller without a prompt`  | Existing active parent fixture, request with no prompt, stable clientRequestId. Capture thread.create launcher scope.thread.threadId, null, create_threads. Second call uses same stable command key; no argument can change launcher. Existing parent-provider checks stay enforced.                     |
| `apps/server/src/orchestration-v2/Orchestrator.control-reads.test.ts` layerTest(:40), real memory SQLite + ProviderReplayHarness runEffectWorker:false; delegated creation near :584 | `records immediate app-owned delegator rather than inheriting its launcher`       | Extend delegated child fixture: parent launched by grandparent; delegate_task command owned by parent. Persisted child.launcher parent/null/delegate_task; existing child lineage & PR-link clearing unchanged. Native shared helper test above proves opposite branch. Command replay creates one child. |
| `apps/server/src/orchestration-v2/ProjectionStore.test.ts` real SQLite layerMemory + ProjectionStore layer                                                                           | `retains launcher in payload and both shell builders`                             | Apply a thread.created event with launcher. Query persisted payload_json (or schema round-trip) plus getThreadProjection, threadShellFromProjection, getThreadShell/getShellSnapshot. All launcher fields equal; legacy event lacks launcher and builders return no launcher.                             |
| same projection test                                                                                                                                                                 | `retains responder metadata in runtime request and answer history payloads`       | Apply resolved runtime-request.updated and turn-item.updated carrying questionAnswer; read stored JSON + request records + item records. All agent members equal, resolvedAt stored, no schema migration. Reapply lifecycle updates and verify metadata remains.                                          |
| `apps/server/src/orchestration-v2/ThreadForkService.test.ts` service plan, fixture makeSourceThread(:33)                                                                             | `does not copy launcher into a fork` (OQ1)                                        | Seed source launcher; run existing plan; target.launcher absent, lineage=root/source and source metadata unchanged. Only add once main approves default.                                                                                                                                                  |
| `apps/server/src/orchestration-v2/ThreadMessageIntake.test.ts` existing claimed-upload/dispatch rejection layers                                                                     | `releases claimed uploads when an already-answered question rejects the response` | Fake service throws typed OrchestratorQuestionAlreadyAnsweredError after claims. Own loser claims released; persisted winner assets not deleted; no success cleanup or answer mutation. Do not replace generic uncertain rejection test.                                                                  |
| `apps/server/src/orchestration-v2/UserFacingErrors.test.ts` pure extraction function                                                                                                 | `shows the already-answered responder and time through WS wrappers`               | Wrap typed error in current generic dispatch message/cause; extraction equals domain error.message including winner title/thread/time. No raw cause/answer/reason leaks.                                                                                                                                  |

### 8.3 Real command transaction and provider delivery tests

**MODIFY `apps/server/src/orchestration-v2/runtimeLayer.test.ts`**, harness `it.layer(layerTest)("OrchestrationV2LayerLive", …)` at :484; real EventSink, Orchestrator, outbox, ProjectionStore; existing test `answers an async question after its provider exits and commits the answer once` at :1019 provides the complete node/request/item seeding fixture (:1037–1111). That existing test already checks blank answers leave request pending and one async-answer message on retry. Extend it and add these cases:

1. `persists agent question provenance and attributes message answers`: seed message request via `EventSinkV2.write` exactly as existing fixture; respond with answers `{color:"  Blue  "}` and `{type:"agent",threadId:caller,environmentId:null,title:"Coordinator",reason:"Matches the brief"}`. Assert saved request.respondedBy and item.questionAnswer.respondedBy deeply equal, stored answers unchanged, exactly one async-answer message, message.createdBy=agent, senderThreadId=caller and text `Answered by orchestrator "Coordinator" (caller): Matches the brief

Which color?
Blue`. Same command replay must keep one resolution/message/outbox effect.
2. `preserves live answer labels while recording agent provenance`: use live request/session fixture; stub adapter respondToRuntimeRequest to complete a `Deferred<ProviderUserInputAnswers>`with its actual received answers. Dispatch agent response with leading/trailing whitespace, Unicode and multiple-choice label as supported by fixture. Await`worker.drain()`or the response Deferred, then assert received answers deeply equal command.answers and contain no reason/prefix. Both request and history have agent metadata before adapter called.
3.`records user answers without agent attribution`: use `withCreationProvenance`on a forged agent command with user/web boundary then dispatch. Request/history responder=user; async answer createdBy=user with unchanged text and no senderThreadId/prefix. The helper unit test and this persisted case jointly cover the WS stamping path; ws.ts remains unchanged, so no new socket-server harness.
4.`keeps the first answer and reports its responder and timestamp`: seed one pending message request; dispatch first agent response, then second user or different agent response with distinct command IDs. Second Result/Exit failure is `OrchestratorQuestionAlreadyAnsweredError`; message names **first** responder and DateTime.formatIso(first.resolvedAt). Request/items/message remain first answer; one resolved event. Repeat user-first then agent-second; error names the user. For concurrent proof use two fibers plus a Deferred gate to submit both, join both and assert one succeeds/one fails against persisted winner. No sleeps or polling. Drain effects only after the winning command when verifying provider work.
5. `reports legacy responder and time fallbacks without inventing identity`: seed non-pending user_input with respondedBy missing and resolvedAt null; rejection sentence exactly uses unknown responder/time. Repeat expired/cancelled statuses per literal D5 and assert real status is unchanged. Read tool case separately covers status visibility.
6. `does not commit invalid message answers or agent approval attempts`: retain blank-required-answer assertion from existing test; add agent metadata and confirm **neither** provenance nor resolution nor message commits. Seed each approval kind from providerPolicy (`command`, `file-read`, `file-change`, `mcp-elicitation`, `permission`), send direct internal agent respondedBy, and assert no decision/response effect or resolution. Human approval flow retains current behavior.

Tests assert committed events/projections immediately after dispatch for synchronous command planning. For asynchronous delivery use:

```ts
const worker = yield * EffectWorker.OrchestrationEffectWorkerV2;
yield * orchestrator.dispatch(command);
yield * worker.drain();
const deliveredAnswers = yield * Deferred.await(responseCaptured);
assert.deepEqual(deliveredAnswers, command.answers);
```

The Deferred is completed **by the fake external adapter** that implements runtime response; it must not be completed by the test to manufacture success. Store writes remain through EventSink so atomic command behavior is actually exercised. For duplicate rejection, read `eventSink.readByCommandId` or the winning storedEvents; no timeout or recurring observer is needed.

### 8.4 MCP schema, trusted caller, resolved reads, and failure tests

**MODIFY `apps/server/src/mcp/toolkits/core.test.ts`**. The production registration harness already calls `McpServer.callTool` with `McpSchema.McpServerClient`, uses `layerThreadToolkit` (:76), and decodes declared failures with `declaredFailure` (:62). Mock ThreadManagement as an external service boundary for toolkit schema/provenance mapping only; real first-answer arbitration is §8.3. Add:

| Exact test name                                                                | Inputs and assertion                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requires a bounded reason for pending request responses through registration` | call goat_pending_request_respond with missing reason, empty, 2001 chars → InvalidParams; 1 and 2000 chars → accepted. JSON schema contains required reason/maxLength=2000 and no host/scope/launcher/respondedBy input. Output still {sequence}.                                                                                |
| `stamps agent question provenance from the authenticated calling thread`       | live thread scope points to caller A; target B request/item present; capture threads.dispatch command. Responder A/title/null/reason; target B remains command.threadId. Unknown model-supplied responder is never used (current tool non-strict input handling can ignore it); launcher not needed for authority.               |
| `reads resolved questions with status responder and ISO resolution time`       | getProjectThreadRecords supplies resolved user_input and matching item. callTool succeeds; actual output schema validates status/responder/time, old requestId/questions remain, legacy responder omitted. Include pending/null, expired/cancelled status reads and question options optional fields unchanged.                  |
| `maps already-answered questions to invalid_request with winner detail`        | resolved request read succeeds; dispatch boundary returns typed already-answered error. declaredFailure.code=invalid_request and message exact domain message, no reason/answers. **Also** pending read followed by mocked dispatch typed rejection covers race; never return local pending-not-found first.                     |
| `rejects approval IDs without dispatching a response`                          | each ProviderRequestKind, explicit target with live caller; readQuestion invalid_request; captured dispatch count zero.                                                                                                                                                                                                          |
| `rejects an outside response without forging a thread identity` (A2)           | client scope with no thread, allowed access, explicit target/reason → invalid_request attribution message; outside list/read still work. Run only after main disposition.                                                                                                                                                        |
| `preserves response ceilings before dispatch and under the target lock`        | existing McpToolAccess harness: target above runtime or plan/default ceiling retains existing code; raised target after precheck exercises DispatchModeLimit refusal. No response persisted. Reuse lock-refusal test patterns in McpToolAccess.test.ts and OrchestratorMcpService.test.ts; do not grant authority from launcher. |

For exact before context of the schema/error harness see existing test at core.test.ts:355–379 (`returns invalid parameter errors through the production registration`) and :229–263 (`returns a bounded public failure without serializing storage causes`). Reuse these layers and actual callTool; asserting Tool parameters alone is insufficient for trusted response capture.

### 8.5 Client fallback/enum/presentation tests

**MODIFY `packages/client-runtime/src/state/threadRequests.test.ts`**, fixture `projection` (:46), `createQuestionHistoryProjector`, `v2Now`/`v2Projection`. Extend `restores old text answers without mutating history or replacing unchanged rows` (starts :151):

- `restores responder metadata without overwriting saved history`: resolved request has agent provenance, no saved questionAnswer → row.item.questionAnswer.respondedBy exact union; raw projection unchanged. Same refs return same output; changed request metadata creates a new row; unrelated rows retain identity.
- `keeps saved answer history and unknown provenance unchanged`: saved answer with attachments/respondedBy differs from runtime fallback → saved wins. Old request lacking metadata adds no responder.

**MODIFY `packages/client-runtime/src/state/threadExecution.test.ts`**, existing pure state helpers and notification fixture inputs: add `question notifications do not masquerade as child-thread navigation`, assert notificationChildThreadId({kind:question,threadId,requestId,humanRequired:false})===undefined; existing subagent/delegated child navigation intact.

**MODIFY `apps/mobile/src/lib/threadActivity.test.ts`**, `buildThreadFeed` + `base`/`projected` fixtures: add `renders question notification summaries with the existing message icon`, notification source question → visible summary/detail, icon message and no task-child false link. This exercises a real feed representation, not static props.

**MODIFY `packages/shared/src/t3McpToolPresentation.test.ts`**, existing resolver/alias harness: add `keeps response lifecycle labels and permits resolved question reads`, resolve both goat_pending_request_respond and legacy alias → Answer/Answering/Answered pending questions, same question-respond action; read → Read/Reading/Read questions. No agent-specific label is invented.

**N/A new web/mobile static-render tests.** Existing mobile QuestionAnswerHistory.test.tsx uses renderToStaticMarkup; do not extend that pattern merely to assert a new Text node or class. Shared attribution helper tests validate conditional wording, while targeted lint/typecheck checks both component integrations. If main later authorizes integrated frontend verification, use test-t3-app/test-t3-mobile exactly once after integration and show agent + user/unknown histories with real content. This docs-only task starts no browser or server and asks for no new authorization.

### 8.6 Concrete transaction, fallback, and trusted-boundary test hunks

**MODIFY `apps/server/src/orchestration-v2/runtimeLayer.test.ts`**. Keep the original human async-answer test. Copy its complete :1019–1174 fixture, replacing every runtime-async-question fixture ID prefix with runtime-agent-question to isolate the test, under the new test name `persists agent question provenance and attributes message answers`, then apply the following hunk to that copy. Seeding uses the real EventSink; it does not invent a new harness.

Before, current source `apps/server/src/orchestration-v2/runtimeLayer.test.ts:1129–1173`:

```ts
 1129 |       const command = {
 1130 |         type: "runtime-request.respond" as const,
 1131 |         commandId: CommandId.make("runtime-async-question-answer"),
 1132 |         threadId,
 1133 |         requestId,
 1134 |         answers: { color: "  Blue  " },
 1135 |       };
 1136 |       const accepted = yield* orchestrator.dispatch(command);
 1137 |       const repeated = yield* orchestrator.dispatch(command);
 1138 |       assert.equal(repeated.sequence, accepted.sequence);
 1139 |       const answered = yield* orchestrator.getThreadProjection(threadId);
 1140 |       assert.equal(answered.runtimeRequests[0]?.status, "resolved");
 1141 |       assert.deepEqual(answered.runtimeRequests[0]?.answers, command.answers);
 1142 |       assert.equal(answered.nodes.find((node) => node.id === nodeId)?.status, "completed");
 1143 |       assert.equal(answered.turnItems.find((item) => item.id === itemId)?.status, "completed");
 1144 |       const answeredItem = answered.turnItems.find((item) => item.id === itemId);
 1145 |       assert.equal(answeredItem?.type, "user_input_request");
 1146 |       if (answeredItem?.type === "user_input_request") {
 1147 |         assert.deepEqual(answeredItem.questionAnswer, {
 1148 |           requestId,
 1149 |           answers: command.answers,
 1150 |           attachmentsByQuestionId: {},
 1151 |           questionTextById: { color: "Which color?" },
 1152 |         });
 1153 |       }
 1154 |       assert.equal(answered.messages.length, 1);
 1155 |       assert.equal(answered.messages[0]?.text, "Which color?\nBlue");
 1156 |       assert.equal(answered.messages[0]?.role, "user");
 1157 |       assert.equal(answered.runs.length, 1);
 1158 |
 1159 |       const duplicate = yield* orchestrator
 1160 |         .dispatch({
 1161 |           ...command,
 1162 |           commandId: CommandId.make("runtime-async-question-duplicate"),
 1163 |         })
 1164 |         .pipe(Effect.result);
 1165 |       assert.equal(duplicate._tag, "Failure");
 1166 |       assert.equal((yield* orchestrator.getThreadProjection(threadId)).messages.length, 1);
 1167 |     }),
 1168 |   );
 1169 |
 1170 |   it.effect("dismisses message-capable questions directly and while settling", () =>
 1171 |     Effect.gen(function* () {
 1172 |       const orchestrator = yield* Orchestrator.OrchestratorV2;
 1173 |       const eventSink = yield* EventSink.EventSinkV2;
```

After, apply to the copied test:

```diff
@@
         answers: { color: "  Blue  " },
+        respondedBy: {
+          type: "agent" as const,
+          threadId: ThreadId.make("caller"),
+          environmentId: null,
+          title: "Coordinator",
+          reason: "Matches the brief",
+        },
@@
       assert.deepEqual(answered.runtimeRequests[0]?.answers, command.answers);
+      assert.deepEqual(answered.runtimeRequests[0]?.respondedBy, command.respondedBy);
@@
         assert.deepEqual(answeredItem.questionAnswer, {
           requestId,
+          respondedBy: command.respondedBy,
@@
-      assert.equal(answered.messages[0]?.text, "Which color?\nBlue");
+      assert.equal(answered.messages[0]?.text, 'Answered by orchestrator "Coordinator" (caller): Matches the brief\n\nWhich color?\nBlue');
       assert.equal(answered.messages[0]?.role, "user");
+      assert.equal(answered.messages[0]?.createdBy, "agent");
+      assert.equal(answered.messages[0]?.senderThreadId, command.respondedBy.threadId);
@@
       assert.equal(duplicate._tag, "Failure");
+      if (duplicate._tag === "Failure") {
+        assert.equal(duplicate.failure._tag, "OrchestratorQuestionAlreadyAnsweredError");
+        assert.equal(
+          duplicate.failure.message,
+          `This question was already answered by orchestrator "Coordinator" (caller) at ${DateTime.formatIso(answered.runtimeRequests[0]!.resolvedAt!)}.`,
+        );
+      }
```

No drain is needed for synchronous winning-transaction projection assertions; the separate live delivery test must drain/await its response Deferred. Message **role** remains user because it is the provider's incoming conversation message; **createdBy** and **senderThreadId** truthfully attribute agent authorship.

**MODIFY `packages/client-runtime/src/state/threadRequests.test.ts`**: extend the existing fallback case with provenance while retaining its reference-cache assertions. Before:

Before, current source `packages/client-runtime/src/state/threadRequests.test.ts:151–186`:

```ts
  151 |
  152 | it("restores old text answers without mutating history or replacing unchanged rows", () => {
  153 |   const project = createQuestionHistoryProjector();
  154 |   const item = projection.turnItems[0]!;
  155 |   const row = {
  156 |     item,
  157 |     position: 0,
  158 |     sourceItemId: item.id,
  159 |     sourceThreadId: item.threadId,
  160 |     visibility: "local" as const,
  161 |   };
  162 |   const rows = [row];
  163 |   const pending = { visibleTurnItems: rows, runtimeRequests: projection.runtimeRequests };
  164 |   expect(project(pending)).toBe(rows);
  165 |   const answered = {
  166 |     ...pending,
  167 |     runtimeRequests: [
  168 |       {
  169 |         ...projection.runtimeRequests[0]!,
  170 |         status: "resolved" as const,
  171 |         answers: { next: "Continue" },
  172 |       },
  173 |     ],
  174 |   };
  175 |   const result = project(answered);
  176 |   expect(result[0]?.item).toMatchObject({
  177 |     questionAnswer: {
  178 |       answers: { next: "Continue" },
  179 |       attachmentsByQuestionId: {},
  180 |       questionTextById: { next: "What should happen next?" },
  181 |     },
  182 |   });
  183 |   expect(row.item).not.toHaveProperty("questionAnswer");
  184 |   expect(project(answered)).toBe(result);
  185 |   expect(project({ ...answered, visibleTurnItems: [...rows] })[0]).toBe(result[0]);
  186 | });
```

After:

```diff
@@
   RuntimeRequestId,
+  ThreadId,
@@
         answers: { next: "Continue" },
+        respondedBy: {
+          type: "agent" as const,
+          threadId: ThreadId.make("caller"),
+          environmentId: null,
+          title: "Coordinator",
+          reason: "Matches the brief",
+        },
@@
       answers: { next: "Continue" },
+      respondedBy: answered.runtimeRequests[0]!.respondedBy,
       attachmentsByQuestionId: {},
```

Keep a separate legacy case without metadata, and add the saved-history-wins case specified in §8.5. The existing projection remains unmodified and repeated calls return the cached row.

**MODIFY `apps/server/src/orchestration-v2/ThreadManagementService.test.ts`**, add RuntimeRequestId import and append this complete test. Before:

Before, current source `apps/server/src/orchestration-v2/ThreadManagementService.test.ts:1–20`:

```ts
    1 | import { expect, it } from "@effect/vitest";
    2 | import {
    3 |   CommandId,
    4 |   MessageId,
    5 |   NodeId,
    6 |   type OrchestrationV2Command,
    7 |   type OrchestrationV2Run,
    8 |   type OrchestrationV2StoredEvent,
    9 |   type OrchestrationV2ThreadProjection,
   10 |   ProjectId,
   11 |   ProviderInstanceId,
   12 |   RunId,
   13 |   ThreadId,
   14 | } from "@t3tools/contracts";
   15 | import * as Deferred from "effect/Deferred";
   16 | import * as Duration from "effect/Duration";
   17 | import * as Effect from "effect/Effect";
   18 | import * as Fiber from "effect/Fiber";
   19 | import * as Layer from "effect/Layer";
   20 | import * as Queue from "effect/Queue";
```

After:

```diff
@@
   RunId,
+  RuntimeRequestId,
@@
+it("overwrites forged WS response provenance with the user", () => {
+  const command: OrchestrationV2Command = {
+    type: "runtime-request.respond",
+    commandId: CommandId.make("user-response"),
+    threadId: ThreadId.make("asking"),
+    requestId: RuntimeRequestId.make("question"),
+    answers: { q: "  Exact option  " },
+    attachmentsByQuestionId: {},
+    respondedBy: { type: "agent", threadId: ThreadId.make("forged"), environmentId: null, title: "Forged", reason: "Forged" },
+  };
+  const stamped = ThreadManagementService.withCreationProvenance(command, { createdBy: "user", creationSource: "web" });
+  expect(stamped).toMatchObject({ respondedBy: { type: "user" } });
+  if (stamped.type !== "runtime-request.respond") throw new Error("Unexpected command type");
+  expect(stamped.answers).toBe(command.answers);
+  expect(stamped.attachmentsByQuestionId).toBe(command.attachmentsByQuestionId);
+  expect(ThreadManagementService.withCreationProvenance(command, { createdBy: "agent", creationSource: "mcp" })).toBe(command);
+});
```

## 9. Verifier commands and recorded probe

Future implementation commands below are focused, run from the worktree root. No command below performs Git state changes, starts a server, or runs a repo-wide suite. Use the requested PATH for every command. Run only after implementing the relevant files and main disposing A1/A2/OQ1; the NEW provider-core test must exist before listing it in vp test/lint.

```sh
export PATH=/Users/jun/.goat/worktrees/goat/goat-question-escalation/node_modules/.bin:$PATH

# Contracts and shared/client logic
vp test run packages/contracts/src/orchestrationV2.test.ts packages/client-runtime/src/state/threadRequests.test.ts packages/client-runtime/src/state/threadExecution.test.ts packages/client-runtime/src/work-log/userInput.test.ts packages/shared/src/t3McpToolPresentation.test.ts

# Local launch, provenance boundary, committed answer scenarios and transport mapping
vp test run apps/server/src/orchestration-v2/ThreadManagementService.test.ts apps/server/src/orchestration-v2/ThreadLaunchService.test.ts apps/server/src/orchestration-v2/ThreadMessageIntake.test.ts apps/server/src/orchestration-v2/ProjectionStore.test.ts apps/server/src/orchestration-v2/Orchestrator.control-reads.test.ts apps/server/src/orchestration-v2/runtimeLayer.test.ts apps/server/src/orchestration-v2/UserFacingErrors.test.ts apps/server/src/mcp/OrchestratorMcpService.test.ts apps/server/src/mcp/toolkits/project/handlers.test.ts apps/server/src/mcp/toolkits/core.test.ts

# A1, OQ1 and mobile feed (when the respective hunks are approved)
vp test run packages/provider-core/src/server/subagentProjection.test.ts apps/server/src/orchestration-v2/ThreadForkService.test.ts apps/mobile/src/lib/threadActivity.test.ts

# Production files from this phase; ws.ts and unchanged intake launch paths need no new hunk
vp lint packages/contracts/src/providerPolicy.ts packages/contracts/src/orchestrationV2.ts apps/server/src/mcp/toolkits/thread/tools.ts apps/server/src/mcp/toolkits/thread/handlers.ts apps/server/src/mcp/toolkits/project/handlers.ts apps/server/src/mcp/threadAccess.ts apps/server/src/mcp/OrchestratorMcpService.ts apps/server/src/orchestration-v2/ThreadLaunchService.ts apps/server/src/orchestration-v2/ThreadManagementService.ts apps/server/src/orchestration-v2/ThreadMessageIntake.ts apps/server/src/orchestration-v2/Orchestrator.ts apps/server/src/orchestration-v2/ProjectionStore.ts packages/client-runtime/src/state/threadRequests.ts packages/client-runtime/src/state/threadExecution.ts packages/client-runtime/src/work-log/userInput.ts packages/shared/src/t3McpToolPresentation.ts apps/web/src/components/chat/MessagesTimeline.tsx apps/mobile/src/features/threads/QuestionAnswerHistory.tsx apps/mobile/src/lib/threadActivity.ts
vp lint packages/provider-core/src/server/subagentProjection.ts packages/provider-core/src/server/subagentProjection.test.ts apps/server/src/orchestration-v2/ThreadForkService.ts apps/server/src/orchestration-v2/ThreadForkService.test.ts
vp lint packages/contracts/src/orchestrationV2.test.ts packages/client-runtime/src/state/threadRequests.test.ts packages/client-runtime/src/state/threadExecution.test.ts packages/client-runtime/src/work-log/userInput.test.ts packages/shared/src/t3McpToolPresentation.test.ts apps/server/src/orchestration-v2/ThreadManagementService.test.ts apps/server/src/orchestration-v2/ThreadLaunchService.test.ts apps/server/src/orchestration-v2/ThreadMessageIntake.test.ts apps/server/src/orchestration-v2/ProjectionStore.test.ts apps/server/src/orchestration-v2/Orchestrator.control-reads.test.ts apps/server/src/orchestration-v2/runtimeLayer.test.ts apps/server/src/orchestration-v2/UserFacingErrors.test.ts apps/server/src/mcp/OrchestratorMcpService.test.ts apps/server/src/mcp/toolkits/project/handlers.test.ts apps/server/src/mcp/toolkits/core.test.ts apps/mobile/src/lib/threadActivity.test.ts

# Scope typechecks; each is one affected package, never a recursive repository command
# --incremental false also avoids a build-info write if package defaults change.
tsc --noEmit --incremental false -p packages/contracts
tsc --noEmit --incremental false -p packages/shared
tsc --noEmit --incremental false -p packages/client-runtime
tsc --noEmit --incremental false -p packages/provider-core
tsc --noEmit --incremental false -p apps/server
tsc --noEmit --incremental false -p apps/web
tsc --noEmit --incremental false -p apps/mobile
```

Desktop wraps web; no desktop source/IPC changed, so N/A additional desktop package typecheck. Provider-native adapter packages consume the same helper without signature change; no per-provider edits/tests are required to prove schema propagation here. Cross-package contracts will also be checked by touched package tsc invocations. Record pre-existing baseline failures separately; never report them as a green gate or solve unrelated failures in wp1.

Audit searches (read-only) to repeat immediately before implementation completion:

```sh
export PATH=/Users/jun/.goat/worktrees/goat/goat-question-escalation/node_modules/.bin:$PATH
rg -n 'OrchestrationV2AppThread|OrchestrationV2ThreadShell|OrchestrationV2ThreadLauncher|launcher' packages/contracts/src/orchestrationV2.ts apps/server/src/orchestration-v2 apps/server/src/mcp packages/provider-core/src/server/subagentProjection.ts
rg -n 'UserInputAttachmentAnswerPayload|UserInputRespondedBy|respondedBy|runtime-request.respond|questionAnswer' packages/contracts/src packages/client-runtime/src apps/server/src/orchestration-v2 apps/server/src/mcp apps/web/src/components/chat/MessagesTimeline.tsx apps/mobile/src/features/threads
rg -n 'OrchestrationV2NotificationSource|source.kind|case "subagent"|case "delegated_task"|case "monitor"|case "background_task"|case "system"|kind: "question"' packages/contracts/src packages/provider-core/src/server packages/client-runtime/src packages/shared/src apps/server/src/orchestration-v2 apps/web/src/components/chat/MessagesTimeline.tsx apps/mobile/src/lib/threadActivity.ts
rg -n 'goat_pending_request_respond|goat_pending_request_read|makeSubagentChildThread|withCreationProvenance' apps/server/src packages
```

**Docs-only probe actually executed once:**

```text
PATH=/Users/jun/.goat/worktrees/goat/goat-question-escalation/node_modules/.bin:$PATH vp test run packages/contracts/src/orchestrationV2.test.ts
exit 0
RUN v5.0.1 /Users/jun/.goat/worktrees/goat/goat-question-escalation
Test Files 1 passed (1)
Tests 36 passed (36)
Start at 02:13:15
Duration 554ms (transform 51%, import 40%, setup 7%, tests 3%)
```

This confirms only the existing test harness. No proposed wp1 production or test hunk was applied or verified. No lint/typecheck/browser/server/repo-wide command was run during drafting. The one assigned Markdown file was checked for matching source excerpt line numbers, fenced-block balance, and intended diff anchors after writing.

## 10. Open questions, proposed defaults, and handoff

| ID  | Question                                                                                         | Proposed default; authority                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Shared helper outside 000's narrowly listed provider-core scope is required for native exclusion | Main accept scope extension; until then do not claim D1 complete. No D1 semantic change.                                                                                                                                               |
| A2  | How does a threadless outside client truthfully satisfy D4's mandatory agent threadId?           | Main explicitly approve local invalid_request guard or amend D4. wp3 must separately design authenticated origin identity for remote respond. No new caller argument in wp1.                                                           |
| OQ1 | Should forks inherit the source launch relationship?                                             | Clear launcher on new forks; they were not launched by the old launcher. Proposed diff/test in §3.6/8.2. Await main disposition, never silently copy relationship.                                                                     |
| OQ2 | What responder/time text applies to legacy records and cancelled/expired user_input?             | Unknown responder/time strings above; follow literal D5 non-pending sentence for all user_input terminal statuses unless main amends it. Read tool retains actual status.                                                              |
| OQ3 | Are whitespace-only reasons allowed?                                                             | Literal D4 1–2000 Schema.String length, no trimming or extra policy. Main may decide non-whitespace validation explicitly; live answer bytes must remain unchanged.                                                                    |
| OQ4 | Null/empty title display and quoting in model-facing prefix                                      | Null title falls back to persisted threadId. Titles normally nonempty; no live lookup/rename synchronization. Prefix uses required double-quoted title form, plain text; UI displays text safely. Confirm fallback wording if desired. |
| OQ5 | Which historical client versions does D2 compatibility cover?                                    | Current pre-question kindUnionWithFallback clients supported; earlier literal-only PreSpecificKindsNotification builds are not. Do not silently add a lossy encoding alias. Main can state minimum supported version in wp4.           |

Handoff to wp2: durable launcher available on complete threads and both shell paths; optional provenance retained on resolved request/history; typed question source recognized by client consumers; local response first-answer arbitration unchanged and visible. wp2 owns delivery/recovery/humanRequired and resolution reconciliation. Handoff to wp3: local pending handlers/read result/reason contract must be moved into PendingQuestionsMcpService without losing ceiling checks, caller attribution or D5 transport text; A2 is an explicit unresolved outside/remote identity seam, not permission to trust model-supplied provenance.

Completion criteria for **this document**: all production changes have current path/action/before-line evidence/intended diffs; whole field chains and conditional proofs are enumerated; focused tests and commands specified; amendments and defaults disclosed; only this assigned document edited. Completion criteria for future **wp1 implementation** additionally require main dispositions plus the focused gates above. Delivery/recovery/host features and publication are later phases, not part of this document's stop condition.
