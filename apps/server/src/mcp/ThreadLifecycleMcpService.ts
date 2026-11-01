import {
  AuthOrchestrationOperateScope,
  CommandId,
  isProviderNativeSubagentThread,
  OrchestratorMcpFailure,
  type ProviderSessionId,
  type RunId,
  type ThreadId,
} from "@goat/contracts";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema } from "effect/ai";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { McpThreadDeletionPolicy } from "../orchestration-v2/goat/McpThreadDeletionPolicy.ts";
import { LifecycleAdmissionReceipt } from "./LifecycleAdmissionReceipt.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as ToolAdmission from "./ToolAdmission.ts";
import {
  assertLiveCaller,
  assertTargetWithinLimits,
  dispatchFailure,
  newCommandId,
  readCaller,
  reauthorizationFailure,
  unavailable,
} from "./threadAccess.ts";

type Target = { readonly threadId?: ThreadId | undefined };
type Accepted = {
  readonly accepted: true;
  readonly commandId: CommandId;
  readonly sequence: number;
};
type Operation = "queue.resume" | "queued_run.start" | "thread.delete" | "provider_session.detach";
type Receipt = {
  readonly state: "completed" | "in_progress" | "unknown" | "missing";
  readonly commandStatus?: "accepted" | "rejected" | null;
  readonly result?: McpSchema.CallToolResult;
  readonly failure?: { readonly _tag: string; readonly code?: string };
};
export class ThreadLifecycleMcpService extends Context.Service<
  ThreadLifecycleMcpService,
  {
    readonly resume: (
      scope: McpInvocationContext.McpInvocationScope,
      input: Target,
    ) => Effect.Effect<Accepted, OrchestratorMcpFailure>;
    readonly start: (
      scope: McpInvocationContext.McpInvocationScope,
      input: Target & { readonly queuedRunId: RunId },
    ) => Effect.Effect<Accepted, OrchestratorMcpFailure>;
    readonly delete: (
      scope: McpInvocationContext.McpInvocationScope,
      input: { readonly threadId: ThreadId },
    ) => Effect.Effect<Accepted, OrchestratorMcpFailure>;
    readonly detach: (
      scope: McpInvocationContext.McpInvocationScope,
      input: { readonly threadId: ThreadId; readonly providerSessionId: ProviderSessionId },
    ) => Effect.Effect<Accepted, OrchestratorMcpFailure>;
    readonly receipt: (
      scope: McpInvocationContext.McpInvocationScope,
      operation: Operation,
      input: { readonly clientRequestId: string },
    ) => Effect.Effect<Receipt, OrchestratorMcpFailure>;
  }
>()("goat/mcp/ThreadLifecycleMcpService") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const receipts = yield* ToolAdmission.makeReceiptReader();
  const check = Effect.fn("ThreadLifecycleMcpService.authorize")(function* (
    scope: McpInvocationContext.McpInvocationScope,
  ) {
    const context = yield* readCaller().pipe(
      Effect.provideService(ThreadManagement.ThreadManagementService, threads),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    );
    yield* assertLiveCaller(context);
    if (scope.readOnly === true || scope.client?.access === "read-only")
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "Thread lifecycle operations require write access.",
      });
    if (scope.reauthorize !== undefined)
      yield* scope
        .reauthorize(scope.thread === undefined ? [AuthOrchestrationOperateScope] : [])
        .pipe(Effect.mapError(reauthorizationFailure));
    return context;
  });
  const dispatch = Effect.fn("ThreadLifecycleMcpService.dispatch")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    operation: Operation,
    input: Target & {
      readonly queuedRunId?: RunId;
      readonly providerSessionId?: ProviderSessionId;
    },
  ) {
    const context = yield* check(scope);
    const threadId = input.threadId ?? context.caller?.id;
    if (threadId === undefined)
      return yield* new OrchestratorMcpFailure({
        code: "target_required",
        message: "Pass threadId for an outside client.",
      });
    // A replay must authorize its caller before admission, but must not need its deleted target.
    yield* McpToolAccess.admit(input);
    if (
      (operation === "thread.delete" || operation === "provider_session.detach") &&
      threadId === context.caller?.id
    )
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "An agent cannot delete or detach its own thread.",
      });
    const target = yield* context.threads
      .getThreadShell(threadId)
      .pipe(Effect.mapError(unavailable));
    if (target === null || target.deletedAt !== null)
      return yield* new OrchestratorMcpFailure({
        code: "thread_not_found",
        message: "The target thread was not found.",
      });
    yield* assertTargetWithinLimits(context.limits, target);
    if (isProviderNativeSubagentThread(target))
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "Provider-native subagent threads are read-only.",
      });
    const held = yield* Effect.serviceOption(LifecycleAdmissionReceipt);
    const receiptId = Option.isNone(held) ? undefined : yield* held.value.held;
    const commandId =
      receiptId === undefined
        ? yield* newCommandId().pipe(Effect.provideService(Crypto.Crypto, crypto))
        : CommandId.make(`mcp:lifecycle:${receiptId}`);
    const common = { threadId, commandId };
    const command =
      operation === "queue.resume"
        ? { ...common, type: "queue.resume" as const }
        : operation === "thread.delete"
          ? { ...common, type: "thread.delete" as const }
          : operation === "queued_run.start" && input.queuedRunId !== undefined
            ? { ...common, type: "queued-run.start" as const, runId: input.queuedRunId }
            : operation === "provider_session.detach" && input.providerSessionId !== undefined
              ? {
                  ...common,
                  type: "provider-session.detach" as const,
                  providerSessionId: input.providerSessionId,
                }
              : undefined;
    if (command === undefined)
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "The lifecycle operation needs its selected run or provider session.",
      });
    const result = yield* context.threads.dispatch(command).pipe(
      Effect.provideService(
        McpThreadDeletionPolicy,
        context.caller === undefined ? {} : { callerThreadId: context.caller.id },
      ),
      Effect.catch((error) =>
        Effect.gen(function* () {
          const failure = dispatchFailure(error);
          const status = yield* context.threads.receiptStatus(commandId);
          return yield* status === "rejected"
            ? new OrchestratorMcpFailure({ code: "invalid_request", message: failure.message })
            : failure;
        }),
      ),
    );
    return { accepted: true as const, commandId, sequence: result.sequence };
  });
  const receipt = Effect.fn("ThreadLifecycleMcpService.receipt")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    operation: Operation,
    input: { readonly clientRequestId: string },
  ) {
    const context = yield* check(scope);
    const record = yield* receipts(operation, input.clientRequestId).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(ThreadManagement.ThreadManagementService, threads),
      Effect.mapError((error) => (error._tag === "OrchestratorMcpFailure" ? error : unavailable())),
    );
    if (!("receiptId" in record)) return record;
    const commandStatus = yield* context.threads.receiptStatus(
      CommandId.make(`mcp:lifecycle:${record.receiptId}`),
    );
    const { receiptId: _receiptId, ...result } = record;
    return { ...result, commandStatus };
  });
  return ThreadLifecycleMcpService.of({
    resume: Effect.fn("ThreadLifecycleMcpService.resume")((scope, input) =>
      dispatch(scope, "queue.resume", input),
    ),
    start: Effect.fn("ThreadLifecycleMcpService.start")((scope, input) =>
      dispatch(scope, "queued_run.start", input),
    ),
    delete: Effect.fn("ThreadLifecycleMcpService.delete")((scope, input) =>
      dispatch(scope, "thread.delete", input),
    ),
    detach: Effect.fn("ThreadLifecycleMcpService.detach")((scope, input) =>
      dispatch(scope, "provider_session.detach", input),
    ),
    receipt,
  });
});
export const layer = Layer.effect(ThreadLifecycleMcpService, make);
