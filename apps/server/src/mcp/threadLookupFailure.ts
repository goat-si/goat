import {
  OrchestratorMcpFailure,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ProviderInstanceId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

type ThreadShells = Pick<ThreadManagement.ThreadManagementService["Service"], "getThreadShell">;

/** Background subagents retain credentials until provider exit; archived threads and other instances cannot act. */
export const isLiveCallerShell = (
  shell: Pick<
    OrchestrationV2ThreadShell,
    "archivedAt" | "activeRunId" | "providerInstanceId" | "pendingBackgroundTasks"
  > | null,
  providerInstanceId: ProviderInstanceId | undefined,
) =>
  shell !== null &&
  shell.archivedAt === null &&
  shell.providerInstanceId === providerInstanceId &&
  (shell.activeRunId !== null ||
    (shell.pendingBackgroundTasks?.some(
      (task) => task.kind === "subagent" && task.providerInstanceId === providerInstanceId,
    ) ??
      false));

const linkedHostHint = Effect.fn("OrchestratorMcpService.linkedHostHint")(function* (
  threads: ThreadShells,
  scope: McpInvocationScope,
  permissions?: Profiles.PermissionProfiles["Service"],
) {
  // Outside credentials can belong to a linked host; its own catalog uses different names.
  if (
    scope.thread === undefined ||
    scope.readOnly === true ||
    !scope.capabilities.has("orchestration")
  )
    return "";
  const policy =
    permissions ?? Option.getOrUndefined(yield* Effect.serviceOption(Profiles.PermissionProfiles));
  if (policy === undefined) return "";
  const caller = yield* threads
    .getThreadShell(scope.thread.threadId)
    .pipe(Effect.orElseSucceed(() => null));
  if (
    caller === null ||
    caller.deletedAt !== null ||
    !isLiveCallerShell(caller, scope.thread.providerInstanceId)
  )
    return "";
  const grant = yield* policy.check(scope, "threads.remote").pipe(Effect.option);
  if (Option.isNone(grant) || !grant.value.ok) return "";
  if (grant.value.effective.enabled && grant.value.effective.profile.hosts?.length === 0) return "";
  return " Thread IDs are local to an environment. For a linked host, use `goat_host_link_list`, then pass the saved name as `host` to a host-aware tool.";
});

const DELEGATED_TASK_PREFIX = "thread:delegated-task:";

function correctedThreadId(threadId: ThreadId): ThreadId | null {
  if (!threadId.isWellFormed()) return null;
  if (!threadId.startsWith(DELEGATED_TASK_PREFIX)) return ThreadId.make(`mcp:${threadId}`);
  const suffix = threadId.slice(DELEGATED_TASK_PREFIX.length);
  const encoded = encodeURIComponent(suffix);
  return encoded === suffix ? null : ThreadId.make(`${DELEGATED_TASK_PREFIX}${encoded}`);
}

export const threadNotFound = Effect.fn("OrchestratorMcpService.threadNotFound")(function* (
  threads: ThreadShells,
  scope: McpInvocationScope,
  threadId: ThreadId,
  message: string,
  permissions?: Profiles.PermissionProfiles["Service"],
) {
  let detail = message;
  if (
    scope.childSetupPurpose === undefined &&
    (scope.capabilities.has("orchestration") || scope.capabilities.has("pull-requests"))
  ) {
    const canRead =
      scope.reauthorize === undefined
        ? scope.grantedScopes?.includes("orchestration:read") !== false
        : yield* scope.reauthorize(["orchestration:read"]).pipe(Effect.isSuccess);
    if (canRead) {
      const corrected = correctedThreadId(threadId);
      if (corrected !== null) {
        const shell = yield* threads
          .getThreadShell(corrected)
          .pipe(Effect.orElseSucceed(() => null));
        if (shell !== null && shell.deletedAt === null) detail += ` Did you mean \`${corrected}\`?`;
      }
      detail += yield* linkedHostHint(threads, scope, permissions);
    }
  }
  return yield* new OrchestratorMcpFailure({ code: "thread_not_found", message: detail });
});
