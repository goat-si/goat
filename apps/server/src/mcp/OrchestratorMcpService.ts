import * as FleetSync from "../goatclaw/FleetSync.ts";
import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import {
  CommandId,
  type GoatclawCeilingAdvice,
  isOrchestrationV2WorkActive,
  isProviderAvailable,
  MessageId,
  ModelSelection,
  NodeId,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  OrchestratorMcpCapabilitiesResult,
  type OrchestratorMcpCreatedThread,
  type OrchestratorMcpCapabilitiesInput,
  type OrchestratorMcpModelOption,
  type OrchestratorMcpCreateThreadsInput,
  type OrchestratorMcpCreateThreadsResult,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpDelegateTaskResult,
  type OrchestratorMcpDeleteScheduledTaskInput,
  type OrchestratorMcpDeleteScheduledTaskResult,
  OrchestratorMcpFailure,
  type OrchestratorMcpInteractionMode,
  type OrchestratorMcpListScheduledTasksInput,
  type OrchestratorMcpListScheduledTasksResult,
  type OrchestratorMcpRequestSecretInput,
  type OrchestratorMcpRequestSecretResult,
  type OrchestratorMcpReviewFindingsExportInput,
  type OrchestratorMcpReviewFindingsExportResult,
  type OrchestratorMcpReviewFindingsRecordInput,
  type OrchestratorMcpReviewFindingsRecordResult,
  type OrchestratorMcpRuntimeMode,
  type OrchestratorMcpScheduledTask,
  type OrchestratorMcpScheduleTaskInput,
  type OrchestratorMcpScheduleTaskResult,
  type OrchestratorMcpTarget,
  type OrchestratorMcpTaskCancelInput,
  type OrchestratorMcpTaskCancelResult,
  type OrchestratorMcpThreadDetail,
  type OrchestratorMcpThreadInterruptInput,
  type OrchestratorMcpThreadRetryInput,
  type OrchestratorMcpThreadRetryResult,
  type OrchestratorMcpThreadInterruptResult,
  type OrchestratorMcpThreadListInput,
  type OrchestratorMcpThreadListItem,
  type OrchestratorMcpThreadListResult,
  type OrchestratorMcpThreadPullRequest,
  type OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  type OrchestratorMcpThreadRun,
  type OrchestratorMcpThreadSendDelivered,
  type OrchestratorMcpThreadSendInput,
  type OrchestratorMcpThreadStatusInput,
  OrchestratorMcpThreadStatusResult,
  type OrchestratorMcpThreadTimelineItem,
  type OrchestratorMcpThreadWaitInput,
  type OrchestratorMcpThreadWaitResult,
  type OrchestratorMcpUpdateScheduledTaskInput,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  ProviderRequestKind,
  ReviewLedgerEntry,
  type RunId,
  type RuntimeMode,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
  type ScheduledTaskWebhookUrlUnavailableReason,
  type ServerProvider,
  ThreadId,
} from "@goat/contracts";
import { derive } from "@goat/provider-core/server/IdAllocator";
import { isGoatConnectEnabled } from "@goat/shared/goatConnect";
import { getProviderOptionCurrentValue } from "@goat/shared/model";
import { runRanAfter } from "@goat/shared/orchestrationV2ThreadError";
import { withTurnCapabilities } from "@goat/shared/turnCapabilities";
import {
  normalizeThreadPullRequestKey,
  visibleThreadPullRequests,
} from "@goat/shared/threadPullRequests";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as CloudSource from "../orchestration-v2/CloudTaskSourceService.ts";
import * as ChannelChildWork from "../channels/ChannelChildWork.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import {
  admissionCorrelationId,
  admitDelegate,
  bindChildWork,
  existingChildWorkConflict,
  launchChildWork,
  launchRemoteChildWork,
  releaseChildWork,
  releaseReservation,
} from "./childWorkAdmission.ts";
import * as ReviewExport from "./reviewExport.ts";
import { recordRemoteTaskResult } from "../remoteReports/recordRemoteTaskResult.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import { cloudTaskForRun } from "./cloudTaskView.ts";
import { hostFailure } from "./hostFailure.ts";
import { listCapabilityModels } from "./OrchestratorMcpCapabilities.ts";
import { overrideOptionSelections } from "./modelOptionOverrides.ts";

import {
  delegatedTaskProgress,
  subagentResultForRun,
} from "@goat/provider-core/server/subagentProjection";
import { captureRpcMemoryGrantCeiling } from "../auth/RpcAuthorization.ts";
import {
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { runOutcome } from "../orchestration-v2/RestartBackgroundNote.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { isSnoozed } from "../orchestration-v2/ThreadSettlementService.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  clientRuntimeModeCeiling,
  type McpInvocationScope,
  type McpThreadInvocationScope,
  requireThreadScope,
} from "./McpInvocationContext.ts";

import * as SecretRequests from "../secrets/SecretRequests.ts";
import { makeRequestSecret } from "./SecretRequestTool.ts";
import { stableCommandId, stablePart } from "./stableCommandId.ts";
import { makeRemoteTaskTargets } from "./goat/RemoteTaskTargets.ts";
import { statusFromShell } from "./threadStatus.ts";
import { goatCallText } from "@goat/contracts/agentSurface/callText";

// Resolved per call: RemoteDispatchCoordinator → LaunchWatchService → PressureNudger →
// HostStatusMcpService → HostThreadsMcpService → this module is an import cycle, so the
// coordinator's exports can still be undefined while this module evaluates.
const isRemoteDispatchError = (u: unknown): u is RemoteDispatchCoordinator.RemoteDispatchError =>
  // eslint-disable-next-line goat/no-inline-schema-compile -- The remote schema resolves after this import cycle initializes.
  Schema.is(RemoteDispatchCoordinator.RemoteDispatchError)(u);
const isOrchestratorMcpFailure = Schema.is(OrchestratorMcpFailure);

const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_WAIT_TIMEOUT_MS = 60 * 60 * 1_000;
const TASK_WAKE_EVENTS = [
  { thread: "parent", eventType: "subagent.updated" },
  { thread: "parent", eventType: "turn-item.updated" },
  { thread: "child", eventType: "run.updated" },
  { thread: "child", eventType: "subagent.updated" },
  { thread: "child", eventType: "provider-thread.updated" },
  { thread: "child", eventType: "runtime-request.updated" },
  { thread: "child", eventType: "turn-item.updated" },
] as const;
const DEFAULT_THREAD_LIST_LIMIT = 50;
const DEFAULT_THREAD_READ_LIMIT = 50;
const DEFAULT_THREAD_RUN_LIMIT = 10;
const DEFAULT_THREAD_ITEM_MAX_CHARS = 20_000;

interface ResolvedTarget {
  readonly modelSelection: ModelSelection;
  readonly supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined;
}

type TerminalTaskStatus = Extract<
  OrchestratorMcpDelegateTaskResult["status"],
  "completed" | "failed" | "cancelled" | "interrupted"
>;

export interface OrchestratorMcpServiceShape {
  readonly permissionProfile: (
    scope: McpInvocationScope,
  ) => Effect.Effect<import("@goat/contracts").PermissionProfileView, OrchestratorMcpFailure>;
  /**
   * goatclaw admission for a follow-up send to a thread on another host: the caller needs
   * `threads.remote` for it and a lane. `ceiling` is what the destination must enforce; undefined
   * while goatclaw is off. `settle` keeps the lane on that thread's dispatch, or frees it.
   */
  readonly admitRemoteSend: (
    scope: McpInvocationScope,
    input: { readonly host: string; readonly threadId: string; readonly clientRequestId?: string },
  ) => Effect.Effect<
    {
      readonly ceiling: import("@goat/contracts").PermissionProfile | undefined;
      readonly settle: (sent: boolean) => Effect.Effect<void, OrchestratorMcpFailure>;
    },
    OrchestratorMcpFailure
  >;
  readonly capabilities: (
    scope: McpInvocationScope,
    input?: OrchestratorMcpCapabilitiesInput,
  ) => Effect.Effect<OrchestratorMcpCapabilitiesResult, OrchestratorMcpFailure>;
  readonly delegateTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpDelegateTaskInput,
  ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>;
  readonly taskStatus: (
    scope: McpInvocationScope,
    taskId: NodeId,
  ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>;
  readonly recordReviewFindings: (
    scope: McpInvocationScope,
    input: OrchestratorMcpReviewFindingsRecordInput,
  ) => Effect.Effect<OrchestratorMcpReviewFindingsRecordResult, OrchestratorMcpFailure>;
  readonly exportReviewFindings: (
    scope: McpInvocationScope,
    input: OrchestratorMcpReviewFindingsExportInput,
  ) => Effect.Effect<OrchestratorMcpReviewFindingsExportResult, OrchestratorMcpFailure>;
  readonly cancelTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpTaskCancelInput,
  ) => Effect.Effect<OrchestratorMcpTaskCancelResult, OrchestratorMcpFailure>;
  readonly createThreads: (
    scope: McpInvocationScope,
    input: OrchestratorMcpCreateThreadsInput,
  ) => Effect.Effect<OrchestratorMcpCreateThreadsResult, OrchestratorMcpFailure>;
  readonly scheduleTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpScheduleTaskInput,
  ) => Effect.Effect<OrchestratorMcpScheduleTaskResult, OrchestratorMcpFailure>;
  readonly listScheduledTasks: (
    scope: McpInvocationScope,
    input: OrchestratorMcpListScheduledTasksInput,
  ) => Effect.Effect<OrchestratorMcpListScheduledTasksResult, OrchestratorMcpFailure>;
  readonly updateScheduledTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpUpdateScheduledTaskInput,
    /**
     * Admits a keyed call once the caller may change this task, before it saves, so a replay
     * passes these checks again and never consumes a secretRef twice.
     */
    admit?: Effect.Effect<void>,
  ) => Effect.Effect<OrchestratorMcpScheduleTaskResult, OrchestratorMcpFailure>;
  readonly deleteScheduledTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpDeleteScheduledTaskInput,
  ) => Effect.Effect<OrchestratorMcpDeleteScheduledTaskResult, OrchestratorMcpFailure>;
  /**
   * The value never reaches the agent: the result is a status.
   */
  readonly requestSecret: (
    scope: McpInvocationScope,
    input: OrchestratorMcpRequestSecretInput,
  ) => Effect.Effect<OrchestratorMcpRequestSecretResult, OrchestratorMcpFailure>;
  readonly listThreads: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadListInput,
  ) => Effect.Effect<OrchestratorMcpThreadListResult, OrchestratorMcpFailure>;
  readonly readThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadReadInput,
  ) => Effect.Effect<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;
  readonly sendToThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadSendInput,
  ) => Effect.Effect<OrchestratorMcpThreadSendDelivered, OrchestratorMcpFailure>;
  readonly waitForThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadWaitInput,
  ) => Effect.Effect<OrchestratorMcpThreadWaitResult, OrchestratorMcpFailure>;
  /** Where a thread's current run is, from its shell; never waits. */
  readonly threadStatus: (
    scope: McpInvocationScope,
    input: Omit<OrchestratorMcpThreadStatusInput, "host">,
  ) => Effect.Effect<Omit<OrchestratorMcpThreadStatusResult, "watch">, OrchestratorMcpFailure>;
  readonly interruptThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadInterruptInput,
  ) => Effect.Effect<OrchestratorMcpThreadInterruptResult, OrchestratorMcpFailure>;
  /** Runs a failed run's workspace preparation again, like Retry in the thread. */
  readonly retryThread: (
    scope: McpInvocationScope,
    input: Omit<OrchestratorMcpThreadRetryInput, "host">,
  ) => Effect.Effect<Omit<OrchestratorMcpThreadRetryResult, "host">, OrchestratorMcpFailure>;
}

export class OrchestratorMcpService extends Context.Service<
  OrchestratorMcpService,
  OrchestratorMcpServiceShape
>()("goat/mcp/OrchestratorMcpService") {}

const isThreadManagementError = Schema.is(ThreadManagementService.ThreadManagementError);

function failure(code: OrchestratorMcpFailure["code"], message: string): OrchestratorMcpFailure {
  return new OrchestratorMcpFailure({ code, message });
}

/**
 * A caller's thread is live while it is not archived, runs on the caller's
 * provider instance, and has an active run or a background subagent that
 * instance started. A background subagent outlives its run and calls tools
 * with its thread's credential, which is revoked when the provider process
 * goes away.
 */
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

/**
 * Threads an agent starts over MCP are `mcp:<uuid>`, and agents often paste the
 * bare uuid. The id is never rewritten, so permission checks keyed on it still
 * hold; the miss only names a live thread the caller could read by its full id.
 */
export const threadNotFound = Effect.fn("OrchestratorMcpService.threadNotFound")(function* (
  threads: Pick<ThreadManagementService.ThreadManagementService["Service"], "getThreadShell">,
  threadId: ThreadId,
  message: string,
) {
  const prefixed = ThreadId.make(`mcp:${threadId}`);
  const shell = yield* threads.getThreadShell(prefixed).pipe(Effect.orElseSucceed(() => null));
  return yield* failure(
    "thread_not_found",
    shell === null || shell.deletedAt !== null
      ? message
      : `${message} Did you mean \`${prefixed}\`?`,
  );
});

function threadManagementFailure(error: unknown): OrchestratorMcpFailure {
  if (!isThreadManagementError(error)) return failure("orchestration_error", errorMessage(error));
  switch (error._tag) {
    case "ThreadManagementThreadNotFoundError":
      return failure("thread_not_found", error.message);
    case "ThreadManagementRunNotFoundError":
      return failure("run_not_found", error.message);
    case "ThreadManagementReviewTaskFinishedError":
    case "ThreadManagementThreadArchivedError":
    case "ThreadManagementNoSteerableRunError":
    case "ThreadManagementTargetStoppedError":
      return failure("thread_not_sendable", error.message);
    case "ThreadManagementThreadNotInterruptibleError":
      return failure("thread_not_interruptible", error.message);
    case "ThreadManagementProjectionLoadError":
    case "ThreadManagementProjectThreadsListError":
    case "ThreadManagementDurableRunProjectionError":
      return failure("orchestration_error", error.message);
    case "ThreadManagementProviderInstanceDisabledError":
      return failure("invalid_request", error.message);
  }
}

// Without a reason, a Stop reads as the user's (see RunExecutionService.USER_STOP_REASON).
function agentStopReason(reason: string | undefined): string {
  return reason === undefined ? "Stopped by an agent" : `Stopped by an agent: ${reason}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scheduledTaskWorkspaceStrategy(
  boundToThread: boolean,
): ScheduledTask["workspaceStrategy"] {
  return boundToThread
    ? { type: "root" }
    : { type: "worktree", baseRef: "main", startFromOrigin: true };
}

/**
 * What an agent tells the user when a webhook task has no public URL. A URL,
 * when present, shows only that the tunnel is configured, not that it runs.
 */
const WEBHOOK_URL_UNAVAILABLE: Record<ScheduledTaskWebhookUrlUnavailableReason, string> = {
  relay_not_linked:
    "This environment is not linked to GOAT Connect. Ask the user to sign in to GOAT Connect and turn on remote access for it.",
  managed_tunnel_not_configured:
    "This environment is linked to GOAT Connect but has no managed tunnel. Ask the user to turn on remote access for it in Settings → Connections.",
  managed_tunnel_unrecognized:
    "This environment's managed tunnel is not one GOAT Connect can route webhooks to. Ask the user to turn remote access off and on again in Settings → Connections.",
};

/**
 * The server cannot tell which of its addresses a sender can reach, so only a
 * client, which knows the address it uses, offers a direct URL.
 */
const WEBHOOK_DIRECT_URL_HINT =
  " A sender that reaches this environment directly (this computer, the local network, or Tailscale) can use the address shown for the task in Settings → Scheduled Tasks.";

/** The link state could not be read, so the cause is unknown. */
const WEBHOOK_URL_UNKNOWN =
  "This environment could not read its GOAT Connect state. Ask the user to check remote access in Settings → Connections.";

/** Public webhook URLs come from the hosted tunnel, which is off until GOAT Connect ships. */
const WEBHOOK_URL_CONNECT_OFF =
  "Public webhook URLs need GOAT Connect, which is coming soon, so this task has no public URL yet.";

/** The URL starts runs, so a caller that may not start one does not see it. */
const WEBHOOK_URL_WITHHELD =
  "The URL is withheld because this caller may not start this task's runs: that needs write access, an active turn for a thread caller, and modes at least as broad as the task's. The user can copy it from Settings → Scheduled Tasks.";

/** The webhook fields of an agent's task summary: the URL, or why it is absent. */

function webhookUrlFields(
  webhook: ScheduledTask["webhook"],
  mayRun: boolean,
): Pick<OrchestratorMcpScheduledTask, "webhookUrl" | "webhookUrlUnavailableReason"> {
  if (webhook === undefined) return {};
  if (webhook.url !== null) {
    return mayRun
      ? { webhookUrl: webhook.url }
      : { webhookUrlUnavailableReason: WEBHOOK_URL_WITHHELD };
  }
  const reason = webhook.urlUnavailableReason;
  const cause = !isGoatConnectEnabled()
    ? WEBHOOK_URL_CONNECT_OFF
    : reason === undefined
      ? WEBHOOK_URL_UNKNOWN
      : WEBHOOK_URL_UNAVAILABLE[reason];
  return {
    webhookUrlUnavailableReason: cause + WEBHOOK_DIRECT_URL_HINT,
  };
}
function scheduledTaskSummary(task: ScheduledTask, mayRun: boolean): OrchestratorMcpScheduledTask {
  return {
    scheduledTaskId: task.id,
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    projectId: task.projectId,
    boundThreadId: task.threadId,
    schedule: task.schedule,
    nextRunAt: task.nextRunAt,
    lastRunStatus: task.lastRunStatus,
    runCount: task.runCount,
    lastRunAt: task.lastRunAt,
    ...webhookUrlFields(task.webhook, mayRun),
    ...(task.webhook === undefined
      ? {}
      : { webhookSignature: task.webhook.hasSecret ? "set" : "none" }),
    ...(task.webhook?.secretRef === undefined
      ? {}
      : { webhookSignatureSecretRef: task.webhook.secretRef }),
  };
}

/** Option ids and allowed values are all a delegating agent needs; labels are UI copy. */
function capabilityModelOption(descriptor: ProviderOptionDescriptor): OrchestratorMcpModelOption {
  const defaultValue = getProviderOptionCurrentValue(descriptor);
  return {
    id: descriptor.id,
    values:
      descriptor.type === "boolean" ? [false, true] : descriptor.options.map((choice) => choice.id),
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
  };
}

function providerConstraints(
  provider: ServerProvider | undefined,
  supportsOrchestrationV2: boolean,
): ReadonlyArray<string> {
  const constraints: Array<string> = [];
  if (!supportsOrchestrationV2) {
    constraints.push("No V2 provider adapter is registered.");
  }
  if (provider === undefined) return constraints;
  // Driver availability comes from the registry, even when health probes are skipped.
  if (!isProviderAvailable(provider)) {
    constraints.push(provider.unavailableReason ?? "Provider driver is unavailable.");
  }
  if (!provider.enabled) {
    constraints.push("Provider instance is disabled.");
    // Disabled snapshots contain placeholders for installation, health, and auth.
    return constraints;
  }
  if (!provider.installed) constraints.push("Provider executable is not installed.");
  if (provider.status === "error" || provider.status === "disabled") {
    constraints.push(provider.message ?? `Provider status is ${provider.status}.`);
  }
  if (provider.auth.status === "unauthenticated") {
    constraints.push("Provider is not authenticated.");
  }
  return constraints;
}

/**
 * Models without descriptors skip the descriptor checks (mirroring how model slugs are only
 * validated when the provider advertises models), but duplicate ids always fail: downstream
 * consumers disagree on whether the first or last value of a duplicated id wins.
 */
/** Reads a remote host's advertised options in either the current or the older descriptor shape. */
function advertisedOptionDescriptors(
  options: OrchestratorMcpCapabilitiesResult["providers"][number]["models"][number]["options"] & {},
): ReadonlyArray<ProviderOptionDescriptor> {
  return options.map((option): ProviderOptionDescriptor => {
    if (!("values" in option)) return option;
    return option.values.every((value) => typeof value === "boolean")
      ? { id: option.id, label: option.id, type: "boolean" }
      : {
          id: option.id,
          label: option.id,
          type: "select",
          options: option.values.map((value) => ({ id: String(value), label: String(value) })),
        };
  });
}

function invalidOptionSelections(
  selections: ReadonlyArray<ProviderOptionSelection>,
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): ReadonlyArray<string> {
  const problems: Array<string> = [];
  const seen = new Set<string>();
  for (const selection of selections) {
    if (seen.has(selection.id)) {
      problems.push(`Option ${selection.id} was specified more than once.`);
      continue;
    }
    seen.add(selection.id);
    if (descriptors === undefined) continue;
    const descriptor = descriptors.find((candidate) => candidate.id === selection.id);
    if (descriptor === undefined) {
      const known = descriptors.map((candidate) => candidate.id).join(", ");
      problems.push(`Unknown option ${selection.id}; supported options: ${known || "none"}.`);
      continue;
    }
    if (descriptor.type === "boolean" && typeof selection.value !== "boolean") {
      problems.push(`Option ${selection.id} expects a boolean value.`);
      continue;
    }
    if (
      descriptor.type === "select" &&
      !descriptor.options.some((choice) => choice.id === selection.value)
    ) {
      const choices = descriptor.options.map((choice) => choice.id).join(", ");
      problems.push(`Option ${selection.id} must be one of: ${choices}.`);
    }
  }
  return problems;
}

function taskStatusForRun(
  run: Pick<OrchestrationV2Run, "status" | "restartCancelledBackgroundWork"> | undefined,
): OrchestratorMcpDelegateTaskResult["status"] {
  switch (run === undefined ? undefined : runOutcome(run)) {
    case "queued":
      return "queued";
    case "waiting":
      return "waiting";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "rolled_back":
      return "cancelled";
    case "interrupted":
      return "interrupted";
    case "preparing":
    case "starting":
    case "running":
    case undefined:
      return "running";
  }
}
function delegatedTaskRun(
  childProjection: Pick<OrchestrationV2ThreadProjection, "runs" | "contextTransfers">,
  task: OrchestrationV2Subagent,
): OrchestrationV2Run | undefined {
  const taskRun = childProjection.runs.find((run) => run.delegatedTaskId === task.id);
  if (taskRun !== undefined) return taskRun;
  const spawnTransfer = childProjection.contextTransfers.find(
    (transfer) =>
      transfer.type === "subagent_spawn" &&
      transfer.sourceThreadId === task.threadId &&
      transfer.targetThreadId === task.childThreadId,
  );
  if (spawnTransfer === undefined) {
    return childProjection.runs[0];
  }
  return spawnTransfer.targetRunId === null
    ? undefined
    : childProjection.runs.find((run) => run.id === spawnTransfer.targetRunId);
}
function hasPendingChildRuns(
  childProjection: Pick<OrchestrationV2ThreadProjection, "runs">,
  delegatedRun: OrchestrationV2Run | undefined,
): boolean {
  return childProjection.runs.some(
    (run) =>
      !ThreadManagementService.isTerminalRunStatus(run.status) &&
      !(run.status === "queued" && run.queueHeld === true) &&
      (delegatedRun === undefined || run.ordinal > delegatedRun.ordinal),
  );
}

function isTerminalTaskStatus(
  status: OrchestratorMcpDelegateTaskResult["status"] | OrchestrationV2Subagent["status"],
): status is TerminalTaskStatus {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

// pendingRequestIds lists questions on the task's own runs; hasPendingQuestion covers any live one.
const hasTaskQuestion = (
  result: Pick<OrchestratorMcpDelegateTaskResult, "hasPendingQuestion" | "pendingRequestIds">,
) => result.hasPendingQuestion || (result.pendingRequestIds?.length ?? 0) > 0;

function endsTaskWait(result: OrchestratorMcpDelegateTaskResult): boolean {
  return (
    hasTaskQuestion(result) ||
    result.pendingApproval !== null ||
    isTerminalTaskStatus(result.status)
  );
}

const isApprovalRequestKind = Schema.is(ProviderRequestKind);

function pendingTaskApproval(
  child: Pick<OrchestrationV2ThreadProjection, "runs" | "nodes" | "runtimeRequests">,
  taskId: NodeId,
  originalRun: OrchestrationV2Run | undefined,
) {
  const taskRunIds = new Set(
    child.runs
      .filter(
        (run) =>
          !ThreadManagementService.isTerminalRunStatus(run.status) &&
          (run.delegatedTaskId === taskId ||
            // Legacy tasks own only their original run, not later turns in the child thread.
            (run.delegatedTaskId === undefined && run.id === originalRun?.id)),
      )
      .map((run) => run.id),
  );
  let approval: OrchestratorMcpDelegateTaskResult["pendingApproval"] = null;
  let oldestCreatedAt = Infinity;
  for (const request of child.runtimeRequests) {
    if (
      request.status !== "pending" ||
      request.responseCapability.type !== "live" ||
      !isApprovalRequestKind(request.kind)
    ) {
      continue;
    }
    const runId = child.nodes.find((node) => node.id === request.nodeId)?.runId;
    if (runId === undefined || runId === null || !taskRunIds.has(runId)) continue;
    const createdAt = DateTime.toEpochMillis(request.createdAt);
    if (createdAt < oldestCreatedAt) {
      oldestCreatedAt = createdAt;
      approval = { requestId: request.id, kind: request.kind, runId };
    }
  }
  return approval;
}

function directAppOwnedChildTasks(
  parent: Pick<OrchestrationV2ThreadProjection, "thread" | "subagents">,
  target: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
  returnedRunIds: ReadonlySet<RunId | null>,
): ReadonlyArray<OrchestrationV2Subagent> {
  if (
    target.thread.lineage.parentThreadId !== parent.thread.id ||
    target.thread.lineage.relationshipToParent !== "subagent"
  ) {
    return [];
  }
  const original = parent.subagents.find(
    (task) =>
      task.origin === "app_owned" &&
      task.threadId === parent.thread.id &&
      task.id ===
        (target.thread.forkedFrom?.type === "node" ? target.thread.forkedFrom.nodeId : undefined) &&
      task.childThreadId === target.thread.id,
  );
  const taskIds = new Set(
    target.runs
      .filter((run) => returnedRunIds.has(run.id))
      .map((run) => run.delegatedTaskId ?? original?.id),
  );
  return parent.subagents.filter(
    (task) =>
      taskIds.has(task.id) &&
      task.origin === "app_owned" &&
      task.childThreadId === target.thread.id,
  );
}

function taskResultTransfer(
  parent: Pick<OrchestrationV2ThreadProjection, "thread" | "contextTransfers">,
  child: Pick<OrchestrationV2ThreadProjection, "runs" | "contextTransfers">,
  task: OrchestrationV2Subagent,
) {
  const originalRun = delegatedTaskRun(child, task);
  const resultRunIds = new Set(
    child.runs
      .filter(
        (run) =>
          run.delegatedTaskId === task.id ||
          (originalRun?.delegatedTaskId === undefined && run.delegatedTaskId === undefined),
      )
      .map((run) => run.id),
  );
  if (originalRun !== undefined) resultRunIds.add(originalRun.id);
  return parent.contextTransfers.find(
    (transfer) =>
      transfer.type === "subagent_result" &&
      transfer.sourceThreadId === task.childThreadId &&
      transfer.targetThreadId === parent.thread.id &&
      ((transfer.sourcePoint.runId !== undefined && resultRunIds.has(transfer.sourcePoint.runId)) ||
        (transfer.sourcePoint.runId === undefined && originalRun?.delegatedTaskId === undefined)),
  );
}

function pageIncludesTerminalTaskResult(input: {
  readonly parent: Pick<OrchestrationV2ThreadProjection, "thread" | "contextTransfers">;
  readonly page: ReadonlyArray<OrchestrationV2ThreadProjection["visibleTurnItems"][number]>;
  readonly task: OrchestrationV2Subagent;
  readonly target: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "contextTransfers" | "messages" | "turnItems"
  >;
  readonly maxChars: number;
}): boolean {
  const transfer = taskResultTransfer(input.parent, input.target, input.task);
  if (transfer === undefined) return false;
  const run =
    transfer.sourcePoint.runId === undefined
      ? delegatedTaskRun(input.target, input.task)
      : input.target.runs.find((run) => run.id === transfer.sourcePoint.runId);
  if (run === undefined || !isTerminalTaskStatus(taskStatusForRun(run))) return false;

  const result = subagentResultForRun(input.target, run);
  if (result.messageId === null && result.turnItemId === null) return false;

  return input.page.some((row) => {
    if (row.sourceThreadId !== input.target.thread.id) return false;
    const matchesResult =
      (result.turnItemId !== null && row.sourceItemId === result.turnItemId) ||
      (result.messageId !== null &&
        row.item.type === "assistant_message" &&
        row.item.messageId === result.messageId);
    if (!matchesResult) return false;

    const text = turnItemText(row.item);
    return text !== null && text.length <= input.maxChars;
  });
}

function latestTerminalResultRun(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "runs">,
  delegatedRun: OrchestrationV2Run | undefined,
): OrchestrationV2Run | undefined {
  const monitorRunIds = new Set(
    projection.messages
      .filter((message) => message.notification?.source.kind === "monitor")
      .map((message) => message.runId),
  );
  return projection.runs
    .filter(
      (run) =>
        ThreadManagementService.isTerminalRunStatus(run.status) &&
        !monitorRunIds.has(run.id) &&
        run.status !== "rolled_back" &&
        (run.id === delegatedRun?.id || run.startedAt !== null),
    )
    .reduce<OrchestrationV2Run | undefined>(
      (latest, run) => (latest === undefined || runRanAfter(run, latest) ? run : latest),
      undefined,
    );
}

function canExposeTaskRunResult(run: OrchestrationV2Run | undefined): run is OrchestrationV2Run {
  return (
    run !== undefined && run.status !== "rolled_back" && isTerminalTaskStatus(taskStatusForRun(run))
  );
}

function runtimeModeRank(mode: RuntimeMode): number {
  switch (mode) {
    case "approval-required":
      return 0;
    case "auto-accept-edits":
      return 1;
    case "auto":
      return 2;
    case "full-access":
      return 3;
  }
}

function interactionModeRank(mode: ProviderInteractionMode): number {
  return mode === "plan" ? 0 : 1;
}

export function resolveRuntimeMode(
  parentMode: RuntimeMode,
  requested: OrchestratorMcpRuntimeMode | undefined,
  target?: Pick<ResolvedTarget, "modelSelection" | "supportedRuntimeModes">,
): Effect.Effect<RuntimeMode, OrchestratorMcpFailure> {
  const inherited = requested === undefined || requested === "inherit";
  const resolved = inherited ? parentMode : requested;
  if (runtimeModeRank(resolved) > runtimeModeRank(parentMode)) {
    return Effect.fail(
      failure(
        "runtime_mode_escalation_denied",
        `Child runtime mode ${resolved} is broader than parent mode ${parentMode}.`,
      ),
    );
  }
  const supported = target?.supportedRuntimeModes;
  if (supported === undefined || supported.length === 0 || supported.includes(resolved)) {
    return Effect.succeed(resolved);
  }
  if (!inherited) {
    return Effect.fail(
      failure(
        "invalid_request",
        `Provider ${target?.modelSelection.instanceId} does not offer runtime mode ${resolved}, so it would run as approval-required. Use one of: ${supported.join(", ")}.`,
      ),
    );
  }
  return Effect.succeed(
    supported
      .filter((mode) => runtimeModeRank(mode) <= runtimeModeRank(resolved))
      .toSorted((left, right) => runtimeModeRank(right) - runtimeModeRank(left))[0] ??
      "approval-required",
  );
}

export function resolveInteractionMode(
  parentMode: ProviderInteractionMode,
  requested: OrchestratorMcpInteractionMode | undefined,
): Effect.Effect<ProviderInteractionMode, OrchestratorMcpFailure> {
  const resolved = requested === undefined || requested === "inherit" ? parentMode : requested;
  return interactionModeRank(resolved) > interactionModeRank(parentMode)
    ? Effect.fail(
        failure(
          "interaction_mode_escalation_denied",
          `Child interaction mode ${resolved} is broader than parent mode ${parentMode}.`,
        ),
      )
    : Effect.succeed(resolved);
}

function stableThreadId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly index: number;
}): ThreadId {
  return ThreadId.make(
    [
      "thread",
      "mcp",
      stablePart(input.scope.requestNamespace),
      stablePart(input.requestKey),
      String(input.index),
    ].join(":"),
  );
}

function stableMessageId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly index: number;
}): MessageId {
  return MessageId.make(
    [
      "message",
      "mcp",
      stablePart(input.scope.requestNamespace),
      stablePart(input.requestKey),
      String(input.index),
    ].join(":"),
  );
}

function stableOperationMessageId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly operation: string;
}): MessageId {
  return MessageId.make(
    [
      "message",
      "mcp",
      stablePart(input.scope.requestNamespace),
      stablePart(input.operation),
      stablePart(input.requestKey),
    ].join(":"),
  );
}

function threadTitle(input: {
  readonly parentTitle: string;
  readonly prompt: string | undefined;
  readonly title: string | undefined;
  readonly index: number;
}): string {
  const detail = input.title?.trim() || input.prompt?.trim();
  if (!detail) return `${input.parentTitle} thread ${input.index + 1}`;
  return detail.length > 80 ? `${detail.slice(0, 77)}...` : detail;
}

function taskPrompt(input: OrchestratorMcpDelegateTaskInput): string {
  return input.role === undefined || input.role === "general"
    ? input.task
    : `Act as the ${input.role} sub-agent for this task.\n\n${input.task}`;
}

function threadSettlement(
  thread: Pick<OrchestrationV2ThreadShell, "settledOverride" | "settledAt">,
): Pick<OrchestratorMcpThreadListItem, "settled" | "settledAt"> {
  const settled = thread.settledOverride === "settled";
  return {
    settled,
    settledAt: settled && thread.settledAt !== null ? DateTime.formatIso(thread.settledAt) : null,
  };
}

function threadSnooze(
  thread: Parameters<typeof isSnoozed>[0],
  nowMs: number,
): Pick<OrchestratorMcpThreadListItem, "snoozed" | "snoozedUntil"> {
  const snoozed = isSnoozed(thread, nowMs);
  return {
    snoozed,
    snoozedUntil:
      snoozed && thread.snoozedUntil != null ? DateTime.formatIso(thread.snoozedUntil) : null,
  };
}

/** The same links `list_thread_pull_requests` reports, without the snapshot details. */
function threadPullRequests(
  links: OrchestrationV2ThreadShell["pullRequests"],
): OrchestratorMcpThreadPullRequest[] {
  return visibleThreadPullRequests(links ?? []).map((link) => ({
    host: normalizeThreadPullRequestKey(link).host,
    repository: link.repository,
    number: link.number,
    url: link.url,
    source: link.source,
    state: link.snapshot?.state ?? null,
  }));
}

function listItemFromShell(
  shell: OrchestrationV2ThreadShell,
  nowMs: number,
): OrchestratorMcpThreadListItem {
  return {
    threadId: shell.id,
    projectId: shell.projectId,
    title: shell.title,
    createdBy: shell.createdBy,
    creationSource: shell.creationSource,
    status: shell.activityRunStatus ?? shell.status,
    latestRunId: shell.latestRunId,
    providerInstanceId: shell.modelSelection.instanceId,
    model: shell.modelSelection.model,
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
    linkedPullRequest: shell.linkedPullRequest ?? null,
    pullRequests: threadPullRequests(shell.pullRequests),
    ...threadSettlement(shell),
    ...threadSnooze(shell, nowMs),
    parentThreadId: shell.lineage.parentThreadId,
    relationshipToParent: shell.lineage.relationshipToParent,
    itemCount: shell.visibleItemCount,
    createdAt: DateTime.formatIso(shell.createdAt),
    updatedAt: DateTime.formatIso(shell.updatedAt),
  };
}

function threadDetail(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "runtimeRequests">,
  itemCount: number,
  shell: OrchestrationV2ThreadShell,
  nowMs: number,
): OrchestratorMcpThreadDetail {
  const latest = ThreadManagementService.latestRun(projection);
  const active = ThreadManagementService.latestActiveRun(projection);
  return {
    threadId: projection.thread.id,
    projectId: projection.thread.projectId,
    title: projection.thread.title,
    createdBy: projection.thread.createdBy,
    creationSource: projection.thread.creationSource,
    status: active?.status ?? latest?.status ?? "idle",
    latestRunId: latest?.id ?? null,
    activeRunId: active?.id ?? null,
    providerInstanceId: projection.thread.modelSelection.instanceId,
    model: projection.thread.modelSelection.model,
    runtimeMode: projection.thread.runtimeMode,
    interactionMode: projection.thread.interactionMode,
    linkedPullRequest: projection.thread.linkedPullRequest ?? null,
    pullRequests: threadPullRequests(projection.thread.pullRequests),
    titleRegeneration:
      projection.thread.titleRegeneration === undefined ||
      projection.thread.titleRegeneration === null
        ? null
        : {
            requestId: projection.thread.titleRegeneration.requestId,
            startedAt: DateTime.formatIso(projection.thread.titleRegeneration.startedAt),
          },
    branch: projection.thread.branch,
    worktreePath: projection.thread.worktreePath,
    parentThreadId: projection.thread.lineage.parentThreadId,
    relationshipToParent: projection.thread.lineage.relationshipToParent,
    runCount: projection.runs.length,
    itemCount,
    pendingRequestCount: projection.runtimeRequests.filter(
      (request) => request.status === "pending",
    ).length,
    archived: projection.thread.archivedAt !== null,
    ...threadSettlement(projection.thread),
    ...threadSnooze(shell, nowMs),
    ...threadOrganization(projection.thread, latest),
    createdAt: DateTime.formatIso(projection.thread.createdAt),
    updatedAt: DateTime.formatIso(projection.thread.updatedAt),
  };
}

/** What goat_thread_organize changes beyond archive, settle and snooze, so a caller can reconcile it. */
function threadOrganization(
  thread: OrchestrationV2ThreadProjection["thread"],
  latest: OrchestrationV2Run | undefined,
): Pick<OrchestratorMcpThreadDetail, "snoozedAt" | "pinned" | "unread"> {
  const completedAt = latest?.completedAt ?? null;
  return {
    snoozedAt: thread.snoozedAt == null ? null : DateTime.formatIso(thread.snoozedAt),
    pinned: thread.pinnedAt != null,
    // The sidebar's rule; thread.mark-unread rewinds lastVisitedAt to just before completion.
    unread:
      completedAt !== null &&
      thread.lastVisitedAt != null &&
      DateTime.isGreaterThan(completedAt, thread.lastVisitedAt),
  };
}

function threadRun(run: OrchestrationV2Run): OrchestratorMcpThreadRun {
  return {
    runId: run.id,
    ordinal: run.ordinal,
    status: run.status,
    ...(run.terminationCause === undefined ? {} : { terminationCause: run.terminationCause }),
    providerInstanceId: run.modelSelection.instanceId,
    model: run.modelSelection.model,
    requestedAt: DateTime.formatIso(run.requestedAt),
    startedAt: run.startedAt === null ? null : DateTime.formatIso(run.startedAt),
    completedAt: run.completedAt === null ? null : DateTime.formatIso(run.completedAt),
  };
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function turnItemText(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "notification":
      return [item.summary, item.detail].filter((part) => part !== undefined).join("\n");
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return item.text;
    case "proposed_plan":
      return item.markdown;
    case "todo_list":
      return [item.explanation, ...item.steps.map((step) => `[${step.status}] ${step.text}`)]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "user_input_request":
      return jsonText(item.questions);
    case "file_change":
      return [
        item.fileName,
        item.additions === undefined && item.deletions === undefined
          ? undefined
          : `+${item.additions ?? 0} -${item.deletions ?? 0}`,
        item.diffStr ?? item.newStr,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "command_execution":
      return [`$ ${item.input}`, item.output]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "file_search":
      return jsonText({ pattern: item.pattern, results: item.results });
    case "web_search":
      return jsonText({ patterns: item.patterns, results: item.results });
    case "approval_request":
      return [item.prompt ?? item.requestKind, item.reason]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "checkpoint":
      return jsonText(item.files);
    case "run_interrupt_request":
    case "run_interrupt_result":
    case "system_notice":
      return item.message;
    case "error":
      return item.failure.message;
    case "compaction":
      return item.summary ?? null;
    case "handoff":
      return item.summary ?? `${item.strategy} handoff to ${item.toProviderInstanceId}`;
    case "fork":
      return `Forked to thread ${item.targetThreadId}.`;
    case "thread_created":
      return `Created thread ${item.targetThreadId} with ${item.targetProviderInstanceId} (${item.targetModel}).`;
    case "human_handoff":
      return `${item.handoff.title}: ${item.handoff.state} (${item.handoff.target.path})`;
    case "secret_request":
      return `Asked the user for ${item.label}: ${item.secretStatus}.`;
    case "subagent":
      return item.result ?? item.progress ?? item.prompt;
    case "dynamic_tool":
      return jsonText({ toolName: item.toolName, input: item.input, output: item.output });
  }
}

function timelineItem(input: {
  readonly row: OrchestrationV2ThreadProjection["visibleTurnItems"][number];
  readonly maxChars: number;
  readonly textOffset?: number;
  readonly messagesByThreadId: ReadonlyMap<ThreadId, OrchestrationV2ThreadProjection["messages"]>;
  readonly tasksByThreadId: ReadonlyMap<ThreadId, OrchestrationV2ThreadProjection["subagents"]>;
}): OrchestratorMcpThreadTimelineItem {
  const item = input.row.item;
  const task =
    item.type === "subagent"
      ? input.tasksByThreadId
          .get(input.row.sourceThreadId)
          ?.find((task) => task.id === item.subagentId)
      : undefined;
  const text = turnItemText(item);
  const offset = input.textOffset ?? 0;
  const end = offset + input.maxChars;
  const textTruncated = text !== null && text.length > end;
  const messageId =
    input.row.item.type === "user_message" || input.row.item.type === "assistant_message"
      ? input.row.item.messageId
      : null;
  const message =
    messageId === null
      ? undefined
      : input.messagesByThreadId
          .get(input.row.sourceThreadId)
          ?.find((candidate) => candidate.id === messageId);
  return {
    position: input.row.position,
    visibility: input.row.visibility,
    sourceThreadId: input.row.sourceThreadId,
    itemId: input.row.sourceItemId,
    ...(input.row.item.type === "subagent" ? { subagentId: input.row.item.subagentId } : {}),
    ...(task?.role === undefined ? {} : { role: task.role }),
    ...(task?.modelSelection === undefined ? {} : { modelSelection: task.modelSelection }),
    ...(task?.parentModelSelection === undefined
      ? {}
      : { parentModelSelection: task.parentModelSelection }),
    runId: input.row.item.runId,
    messageId,
    createdBy: message?.createdBy ?? null,
    creationSource: message?.creationSource ?? null,
    ...(message?.senderThreadId === undefined ? {} : { senderThreadId: message.senderThreadId }),
    type: input.row.item.type,
    status: input.row.item.status,
    title: input.row.item.title,
    text: text === null ? null : text.slice(offset, end),
    textTruncated,
    nextTextOffset: textTruncated ? end : null,
    updatedAt: DateTime.formatIso(input.row.item.updatedAt),
  };
}

const make = Effect.gen(function* () {
  const permissions = yield* Profiles.PermissionProfiles;
  const fleet = yield* FleetSync.GoatclawFleetSync;
  const crypto = yield* Crypto.Crypto;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const remoteDispatch = yield* RemoteDispatchCoordinator.RemoteDispatchCoordinator;
  const ssh = yield* SshRemoteDispatch.SshRemoteDispatch;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const providerAdapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const projects = yield* ProjectService.ProjectService;
  const cloudSources = yield* Effect.serviceOption(CloudSource.CloudTaskSourceService);
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const gitDriver = yield* GitVcsDriver.GitVcsDriver;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const requireProject = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.mapError((error) =>
        failure("orchestration_error", `Unable to read project ${projectId}: ${error.message}`),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(failure("invalid_request", `Project ${projectId} was not found.`)),
          onSome: Effect.succeed,
        }),
      ),
    );

  const projectDefaultModelSelection = (
    project: Effect.Success<ReturnType<typeof requireProject>>,
  ) =>
    project.defaultModelSelection === null
      ? Effect.fail(
          failure(
            "invalid_request",
            `Project ${project.id} has no default model, so this caller cannot pick one for it.`,
          ),
        )
      : Effect.succeed(project.defaultModelSelection);
  const secretRequests = yield* SecretRequests.SecretRequests;

  const requireCapability = (scope: McpInvocationScope) =>
    scope.capabilities.has("orchestration")
      ? Effect.void
      : Effect.fail(
          failure(
            "capability_denied",
            "This MCP credential does not grant orchestration capabilities.",
          ),
        );

  const loadProjection = (threadId: ThreadId) =>
    threadManagement
      .getThreadRecords(
        threadId,
        [
          "runs",
          "messages",
          "subagents",
          "providerThreads",
          "providerTurns",
          "runtimeRequests",
          "contextTransfers",
          "turnItems",
        ],
        { turnItemTypes: [], messageRoles: ["user"] },
      )
      .pipe(
        Effect.mapError((error) =>
          failure(
            "orchestration_error",
            `Unable to read thread ${threadId}: ${errorMessage(error)}`,
          ),
        ),
      );

  const loadProjectThread = (
    projectId: OrchestrationV2ThreadProjection["thread"]["projectId"],
    threadId: ThreadId,
  ) =>
    threadManagement
      .getProjectThreadRecords(
        { projectId, threadId },
        [
          "runs",
          "messages",
          "subagents",
          "providerThreads",
          "providerTurns",
          "runtimeRequests",
          "contextTransfers",
          "turnItems",
        ],
        { turnItemTypes: [], messageRoles: ["user"] },
      )
      .pipe(Effect.mapError(threadManagementFailure));

  const loadCaller = Effect.fn("OrchestratorMcpService.loadCaller")(function* (
    scope: McpInvocationScope,
  ) {
    yield* requireCapability(scope);
    if (scope.thread === undefined) {
      return {
        parent: undefined,
        limits: {
          runtimeMode: clientRuntimeModeCeiling(scope.client),
          interactionMode: "default",
        } satisfies { runtimeMode: RuntimeMode; interactionMode: ProviderInteractionMode },
      } as const;
    }
    const parent = yield* loadProjection(scope.thread.threadId);
    return {
      parent,
      limits: {
        runtimeMode: parent.thread.runtimeMode,
        interactionMode: parent.thread.interactionMode,
      },
    } as const;
  });

  const loadThreadCaller = Effect.fn("OrchestratorMcpService.loadThreadCaller")(function* (
    scope: McpInvocationScope,
    operation: string,
  ) {
    yield* requireCapability(scope);
    const threadScope = yield* requireThreadScope(scope, operation);
    const parent = yield* loadProjection(threadScope.thread.threadId);
    return { scope: threadScope, parent } as const;
  });

  const resolveProjectTarget = (
    parent: Pick<OrchestrationV2ThreadProjection, "thread"> | undefined,
    projectId: ProjectId | undefined,
  ) =>
    projectId !== undefined
      ? Effect.succeed(projectId)
      : parent !== undefined
        ? Effect.succeed(parent.thread.projectId)
        : Effect.fail(
            failure(
              "target_required",
              "Pass projectId: this MCP client is not running inside a GOAT thread.",
            ),
          );

  const loadTargetThread = Effect.fn("OrchestratorMcpService.loadTargetThread")(function* (
    threadId: ThreadId,
  ) {
    const shell = yield* threadManagement
      .getThreadShell(threadId)
      .pipe(Effect.mapError(threadManagementFailure));
    if (shell === null || shell.deletedAt !== null) {
      return yield* threadNotFound(threadManagement, threadId, `Thread ${threadId} was not found.`);
    }
    return yield* loadProjectThread(shell.projectId, threadId);
  });

  const loadScopedThread = Effect.fn("OrchestratorMcpService.loadScopedThread")(function* (
    scope: McpInvocationScope,
    threadId: ThreadId,
  ) {
    const caller = yield* loadCaller(scope);
    const target =
      caller.parent !== undefined && threadId === caller.parent.thread.id
        ? caller.parent
        : yield* loadTargetThread(threadId);
    return { ...caller, target } as const;
  });

  /**
   * A thread caller writes to another thread only while its own run is live,
   * so a credential that outlived its session cannot reach across threads.
   */
  const assertLiveCallerForOtherThread = (
    scope: McpInvocationScope,
    parent: Pick<OrchestrationV2ThreadProjection, "thread" | "runs"> | undefined,
    target: Pick<OrchestrationV2ThreadProjection, "thread">,
  ) =>
    parent === undefined || target.thread.id === parent.thread.id
      ? Effect.void
      : assertLiveCaller(scope, parent);

  const assertLiveCallerForOtherProject = (
    scope: McpInvocationScope,
    parent: Pick<OrchestrationV2ThreadProjection, "thread" | "runs"> | undefined,
    projectId: ProjectId,
  ) =>
    parent === undefined || projectId === parent.thread.projectId
      ? Effect.void
      : assertLiveCaller(scope, parent);

  const assertLiveCaller = (
    scope: McpInvocationScope,
    parent: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
  ) => {
    const notActive = failure(
      "parent_not_active",
      "The calling provider no longer owns an active thread run.",
    );
    const activeRun = ThreadManagementService.latestActiveRun(parent);
    if (parent.thread.archivedAt === null && activeRun === undefined) {
      // Decide from this one fresh snapshot: a run may have started since `parent` was read.
      return threadManagement.getThreadShell(parent.thread.id).pipe(
        Effect.mapError(threadManagementFailure),
        Effect.flatMap((shell) =>
          isLiveCallerShell(shell, scope.thread?.providerInstanceId)
            ? Effect.void
            : Effect.fail(notActive),
        ),
      );
    }
    return parent.thread.archivedAt !== null ||
      activeRun === undefined ||
      activeRun.providerInstanceId !== scope.thread?.providerInstanceId
      ? Effect.fail(notActive)
      : Effect.void;
  };

  const loadReadableThread = Effect.fn("OrchestratorMcpService.loadReadableThread")(function* (
    scope: McpInvocationScope,
    threadId: ThreadId,
  ) {
    const { parent } = yield* loadCaller(scope);
    const shell = yield* threadManagement
      .getThreadShell(threadId)
      .pipe(Effect.mapError(threadManagementFailure));
    if (shell === null || shell.deletedAt !== null) {
      return yield* threadNotFound(
        threadManagement,
        threadId,
        `Thread ${threadId} is no longer available.`,
      );
    }
    const target = yield* threadManagement
      .getProjectThreadRecords({ projectId: shell.projectId, threadId }, [
        "runs",
        "runtimeRequests",
        "contextTransfers",
        "providerThreads",
      ])
      .pipe(Effect.mapError(threadManagementFailure));
    return { parent, target, shell } as const;
  });

  const loadProviders = providerRegistry.getProviders;

  const loadOrchestrationCapableInstanceIds = () =>
    providerAdapters.list().pipe(Effect.map((instanceIds) => new Set(instanceIds)));

  /**
   * Provider snapshots only re-probe while a client is in the foreground, so an
   * unattended agent can see a provider as unavailable after it was fixed.
   * Re-probe the requested instance once before refusing it.
   */
  const assertTargetEnabledForProject = (
    parent: Pick<OrchestrationV2ThreadProjection, "thread">,
    commandId: CommandId,
    target: ResolvedTarget,
  ) =>
    threadManagement
      .assertProviderInstanceEnabled({
        projectId: parent.thread.projectId,
        commandId,
        instanceId: target.modelSelection.instanceId,
      })
      .pipe(Effect.mapError(threadManagementFailure));

  const resolveTargetRechecking = (input: Parameters<typeof resolveTarget>[0]) => {
    const instanceId =
      input.target?.providerInstanceId ??
      (input.target?.driverKind === undefined
        ? input.parent.thread.modelSelection.instanceId
        : undefined);
    const resolved = resolveTarget(input);
    if (instanceId === undefined) return resolved;
    return resolved.pipe(
      Effect.catchIf(
        (error) => error.code === "provider_unavailable",
        () =>
          providerRegistry
            .refreshInstance(instanceId)
            .pipe(Effect.flatMap((providers) => resolveTarget({ ...input, providers }))),
      ),
    );
  };

  const {
    authorizeRemoteWrite,
    preflightCloudLaunch,
    ensureCloudCancellationSupported,
    readRemoteCloudTask,
    resolveRemoteTarget,
  } = makeRemoteTaskTargets({
    permissions,
    projects,
    providerAdapters,
    ssh,
    threadManagement,
    cloudSources,
    requireCapability,
    failure,
    threadManagementFailure,
    advertisedOptionDescriptors,
    invalidOptionSelections,
  });

  const resolveTarget = Effect.fn("OrchestratorMcpService.resolveTarget")(function* (input: {
    readonly parent: Pick<OrchestrationV2ThreadProjection, "thread">;
    readonly target: OrchestratorMcpTarget | undefined;
    readonly providers: ReadonlyArray<ServerProvider>;
    /**
     * Set only when the command that will dispatch this target already has a receipt: that
     * dispatch can only replay the recorded result, never start anything new, so filtering
     * candidates by the project's current settings would just refuse a retry that does no new
     * work. Never set this for a resolution whose dispatch uses a different command id than the
     * one checked for a receipt.
     */
    readonly skipProjectEnablementFilter?: boolean;
  }): Effect.fn.Return<ResolvedTarget, OrchestratorMcpFailure> {
    const requestedInstanceId = input.target?.providerInstanceId;
    const requestedDriver = input.target?.driverKind;
    const orchestrationCapableInstanceIds = yield* loadOrchestrationCapableInstanceIds();
    let instanceId = requestedInstanceId;

    if (instanceId === undefined && requestedDriver !== undefined) {
      const candidates = input.providers.filter(
        (provider) =>
          provider.driver === requestedDriver &&
          orchestrationCapableInstanceIds.has(provider.instanceId),
      );
      if (candidates.length === 0) {
        return yield* failure(
          "provider_unavailable",
          `No V2 provider adapter is registered for driver ${requestedDriver}.`,
        );
      }
      const healthyCandidates = candidates.filter(
        (candidate) => providerConstraints(candidate, true).length === 0,
      );
      const inheritedCandidate = healthyCandidates.find(
        (candidate) => candidate.instanceId === input.parent.thread.modelSelection.instanceId,
      );
      const orderedCandidates = [
        ...(inheritedCandidate === undefined ? [] : [inheritedCandidate]),
        ...healthyCandidates.filter((candidate) => candidate !== inheritedCandidate),
      ];
      for (const candidate of orderedCandidates) {
        const enabledForProject =
          input.skipProjectEnablementFilter === true ||
          (yield* threadManagement.isProviderInstanceEnabledForProject({
            projectId: input.parent.thread.projectId,
            instanceId: candidate.instanceId,
          }));
        if (enabledForProject) {
          instanceId = candidate.instanceId;
          break;
        }
      }
      if (instanceId === undefined) {
        return yield* failure(
          "provider_unavailable",
          healthyCandidates.length === 0
            ? `No available V2 provider instance for driver ${requestedDriver}.`
            : `No instance of driver ${requestedDriver} is enabled for this project.`,
        );
      }
    }
    instanceId ??= input.parent.thread.modelSelection.instanceId;

    const provider = input.providers.find((candidate) => candidate.instanceId === instanceId);
    if (provider === undefined) {
      return yield* failure(
        "provider_unavailable",
        `Provider instance ${instanceId} is not registered.`,
      );
    }
    if (requestedDriver !== undefined && provider.driver !== requestedDriver) {
      return yield* failure(
        "invalid_request",
        `Provider instance ${instanceId} uses driver ${provider.driver}, not ${requestedDriver}.`,
      );
    }
    const constraints = providerConstraints(
      provider,
      orchestrationCapableInstanceIds.has(provider.instanceId),
    );
    if (constraints.length > 0) {
      return yield* failure(
        "provider_unavailable",
        `Provider ${instanceId} cannot run a child task: ${constraints.join(" ")}`,
      );
    }

    const inheritedSelection = input.parent.thread.modelSelection;
    const requestedModel = input.target?.model;
    const model =
      requestedModel ??
      (instanceId === inheritedSelection.instanceId
        ? inheritedSelection.model
        : provider?.models[0]?.slug);
    if (model === undefined) {
      return yield* failure(
        "model_unavailable",
        `Provider ${instanceId} has no model available for inheritance.`,
      );
    }
    if (
      requestedModel !== undefined &&
      provider !== undefined &&
      provider.models.length > 0 &&
      !provider.models.some((candidate) => candidate.slug === requestedModel)
    ) {
      return yield* failure(
        "model_unavailable",
        `Model ${requestedModel} is not advertised by provider ${instanceId}.`,
      );
    }

    const requestedOptions = input.target?.options;
    if (requestedOptions !== undefined) {
      const descriptors = provider.models.find((candidate) => candidate.slug === model)
        ?.capabilities?.optionDescriptors;
      const invalid = invalidOptionSelections(requestedOptions, descriptors);
      if (invalid.length > 0) {
        return yield* failure(
          "invalid_request",
          `Model ${model} on provider ${instanceId} rejected options: ${invalid.join(" ")}`,
        );
      }
    }

    const inheritsOptions =
      instanceId === inheritedSelection.instanceId && model === inheritedSelection.model;
    const options = overrideOptionSelections(
      inheritsOptions ? inheritedSelection.options : undefined,
      requestedOptions,
    );
    return {
      modelSelection: { instanceId, model, ...(options === undefined ? {} : { options }) },
      supportedRuntimeModes: provider.supportedRuntimeModes,
    };
  });

  const requestKey = (clientRequestId: string | undefined): Effect.Effect<string> =>
    clientRequestId === undefined
      ? crypto.randomUUIDv4().pipe(Effect.orDie)
      : Effect.succeed(clientRequestId);

  const readTask = Effect.fn("OrchestratorMcpService.readTask")(function* (
    scope: McpThreadInvocationScope,
    taskId: NodeId,
    waitTimedOut = false,
    acknowledgeTerminal = false,
    acknowledgementOperation = "task-status-acknowledge",
  ): Effect.fn.Return<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure> {
    yield* requireCapability(scope);
    const parentProjection = yield* loadProjection(scope.thread.threadId);
    const task = parentProjection.subagents.find(
      (candidate) =>
        candidate.id === taskId &&
        candidate.origin === "app_owned" &&
        candidate.threadId === scope.thread.threadId,
    );
    if (task === undefined) {
      return yield* failure(
        "task_not_found",
        `Delegated task ${taskId} does not belong to thread ${scope.thread.threadId}.`,
      );
    }
    if (task.remote !== undefined) {
      const status = isTerminalTaskStatus(task.status) ? task.status : "running";
      const terminal = isTerminalTaskStatus(status);
      // The coordinator records the remote run's open questions before announcing them.
      const pendingRequestIds = terminal
        ? []
        : ((yield* remoteDispatch
            .get(task.remote.correlationId)
            .pipe(
              Effect.mapError(() =>
                failure("orchestration_error", "Unable to load the persisted remote dispatch."),
              ),
            ))?.pendingRequestIds ?? []);
      const response = {
        taskId: task.id,
        host: task.remote.host,
        childThreadId: task.remote.threadId,
        childRunId: null,
        childNodeId: task.id,
        status,
        workState: terminal ? "result_available" : "working",
        hasPendingChildRuns: false,
        providerInstanceId: task.providerInstanceId,
        model: task.model,
        ...(task.role === undefined ? {} : { role: task.role }),
        ...(task.reviewLedger === undefined ? {} : { reviewLedger: task.reviewLedger }),
        ...(task.modelSelection === undefined ? {} : { modelSelection: task.modelSelection }),
        ...(task.parentModelSelection === undefined
          ? {}
          : { parentModelSelection: task.parentModelSelection }),
        options: task.modelSelection?.options ?? [],
        pendingApproval: null,
        summary: task.result,
        resultContextTransferId: null,
        latestTerminalRunId: null,
        latestTerminalStatus: terminal ? status : null,
        latestTerminalSummary: terminal ? task.result : null,
        latestTerminalResultContextTransferId: null,
        hasPendingQuestion: pendingRequestIds.length > 0,
        waitTimedOut,
        ...(pendingRequestIds.length === 0 ? {} : { pendingRequestIds }),
      } satisfies OrchestratorMcpDelegateTaskResult;
      if (acknowledgeTerminal)
        yield* acknowledgeTaskResult(
          scope,
          task,
          parentProjection,
          response.status,
          acknowledgementOperation,
        );
      return response;
    }

    if (task.childThreadId === null)
      return yield* failure("task_not_found", "This task has no local child thread.");
    const childControls = yield* threadManagement
      .getThreadRecords(
        task.childThreadId,
        [
          "runs",
          "messages",
          "contextTransfers",
          "subagents",
          "providerThreads",
          "runtimeRequests",
          "nodes",
        ],
        { messageRoles: ["user"], omitSettledLeafNodes: true },
      )
      .pipe(Effect.mapError(threadManagementFailure));
    const childRun = delegatedTaskRun(childControls, task);
    const terminalRun = latestTerminalResultRun(childControls, childRun);
    const progress = delegatedTaskProgress(childControls);
    const taskResultRun =
      childRun?.delegatedTaskId === task.id
        ? childControls.runs
            .filter((run) => run.delegatedTaskId === task.id)
            .toSorted((a, b) => b.ordinal - a.ordinal)[0]
        : progress.resultRun;
    const taskWorkState =
      childRun?.delegatedTaskId === task.id
        ? isTerminalTaskStatus(taskStatusForRun(taskResultRun))
          ? "result_available"
          : "working"
        : progress.state;
    const resultRunIds = [
      ...new Set(
        [taskResultRun?.id, terminalRun?.id].filter((id): id is RunId => id !== undefined),
      ),
    ];
    const resultRecords = yield* threadManagement
      .getThreadRecords(task.childThreadId, ["messages", "turnItems"], {
        messageRoles: ["assistant"],
        messageRunIds: resultRunIds,
        turnItemRunIds: resultRunIds,
        turnItemTypes: ["assistant_message", "error"],
      })
      .pipe(Effect.mapError(threadManagementFailure));
    const childProjection = {
      ...childControls,
      messages: [...childControls.messages, ...resultRecords.messages],
      turnItems: resultRecords.turnItems,
    };
    const heldForRestart =
      task.result === null &&
      taskWorkState === "result_available" &&
      (yield* threadManagement
        .delegatedTaskResultPending(task.childThreadId, childRun?.delegatedTaskId)
        .pipe(Effect.mapError(threadManagementFailure)));
    const workState =
      task.result !== null ? "result_available" : heldForRestart ? "working" : taskWorkState;
    const status =
      task.result !== null
        ? taskStatusForRun(
            task.status === "completed" ||
              task.status === "failed" ||
              task.status === "cancelled" ||
              task.status === "interrupted"
              ? { status: task.status }
              : childRun,
          )
        : workState === "result_available"
          ? taskStatusForRun(taskResultRun ?? childRun)
          : taskStatusForRun(taskResultRun ?? childRun) === "queued"
            ? "queued"
            : "running";
    const latestRun = ThreadManagementService.latestRun(childControls);
    const questionRunIds = childControls.runs
      .filter(
        (run) =>
          run.id === latestRun?.id || !ThreadManagementService.isTerminalRunStatus(run.status),
      )
      .map((run) => run.id);
    const questionItems = yield* threadManagement
      .getThreadRecords(task.childThreadId, ["turnItems"], {
        turnItemTypes: ["user_input_request"],
        turnItemRunIds: questionRunIds,
      })
      .pipe(Effect.mapError(threadManagementFailure));
    const questionIds = questionItems.turnItems.flatMap((item) =>
      item.type === "user_input_request" &&
      item.runId !== null &&
      questionRunIds.includes(item.runId)
        ? [item.requestId]
        : [],
    );
    const questionRequests =
      questionIds.length === 0
        ? { runtimeRequests: [] }
        : yield* threadManagement
            .getThreadRecords(task.childThreadId, ["runtimeRequests"], {
              runtimeRequestIds: questionIds,
            })
            .pipe(Effect.mapError(threadManagementFailure));
    const questionRecords = { ...questionItems, ...questionRequests };
    const pendingRequestIds = [
      ...new Set(
        questionRunIds.flatMap((runId) =>
          ThreadManagementService.pendingUserInputRequestIdsForRun(questionRecords, runId),
        ),
      ),
    ].toSorted();
    const derivedResult =
      task.result !== null
        ? task.result
        : taskResultRun !== undefined && isTerminalTaskStatus(status)
          ? subagentResultForRun(childProjection, taskResultRun).text
          : null;
    const resultTransfers = parentProjection.contextTransfers.filter(
      (transfer) =>
        transfer.type === "subagent_result" &&
        transfer.sourceThreadId === task.childThreadId &&
        transfer.targetThreadId === scope.thread.threadId,
    );
    const resultTransferForRun = (run: OrchestrationV2Run | undefined) =>
      !canExposeTaskRunResult(run)
        ? null
        : (resultTransfers.find((transfer) => transfer.sourcePoint.runId === run.id) ??
          (run.id === childRun?.id
            ? resultTransfers.find((transfer) => transfer.sourcePoint.runId === undefined)
            : undefined) ??
          null);
    const resultTransfer = taskResultTransfer(parentProjection, childProjection, task) ?? null;
    const terminalStatus = terminalRun === undefined ? null : taskStatusForRun(terminalRun);
    const cloudTask = cloudTaskForRun(
      childControls.providerThreads ?? [],
      taskResultRun ?? childRun,
    );
    const latestTerminalSummary = canExposeTaskRunResult(terminalRun)
      ? terminalRun.id === childRun?.id
        ? derivedResult
        : subagentResultForRun(childProjection, terminalRun).text
      : null;
    const resultContextTransferId = resultTransfer?.id ?? null;
    const latestTerminalResultContextTransferId = resultTransferForRun(terminalRun)?.id ?? null;
    const modelSelection = childRun?.modelSelection ??
      childControls.thread.modelSelection ?? {
        instanceId: task.providerInstanceId,
        model: task.model,
      };
    const response = {
      ...(cloudTask === undefined ? {} : { cloudTask }),
      taskId: task.id,
      childThreadId: task.childThreadId,
      childRunId: childRun?.id ?? null,
      childNodeId: task.id,
      status,
      workState,
      hasPendingChildRuns: hasPendingChildRuns(childProjection, childRun),
      providerInstanceId: modelSelection.instanceId,
      model: modelSelection.model,

      ...(task.role === undefined ? {} : { role: task.role }),
      ...(task.reviewLedger === undefined ? {} : { reviewLedger: task.reviewLedger }),
      ...(task.modelSelection === undefined ? {} : { modelSelection: task.modelSelection }),
      ...(task.parentModelSelection === undefined
        ? {}
        : { parentModelSelection: task.parentModelSelection }),

      options: modelSelection.options ?? [],

      summary: derivedResult,
      resultContextTransferId,
      latestTerminalRunId: terminalRun?.id ?? null,
      latestTerminalStatus:
        terminalStatus !== null && isTerminalTaskStatus(terminalStatus) ? terminalStatus : null,
      latestTerminalSummary: latestTerminalSummary === derivedResult ? null : latestTerminalSummary,
      latestTerminalResultContextTransferId:
        latestTerminalResultContextTransferId === resultContextTransferId
          ? null
          : latestTerminalResultContextTransferId,
      hasPendingQuestion:
        !isTerminalTaskStatus(status) &&
        childControls.runtimeRequests.some(
          (request) =>
            request.kind === "user_input" &&
            request.status === "pending" &&
            request.responseCapability.type === "live",
        ),
      pendingApproval:
        isTerminalTaskStatus(status) || task.completionDelivery?.state === "disposed"
          ? null
          : pendingTaskApproval(childControls, task.id, childRun),
      waitTimedOut,
      ...(pendingRequestIds.length === 0 ? {} : { pendingRequestIds }),
    } satisfies OrchestratorMcpDelegateTaskResult;
    if (acknowledgeTerminal)
      yield* acknowledgeTaskResult(scope, task, parentProjection, status, acknowledgementOperation);
    return response;
  });

  const waitForTask = Effect.fn("OrchestratorMcpService.waitForTask")(
    function* (scope: McpThreadInvocationScope, taskId: NodeId, _timeoutMs: number) {
      const streamError = (error: unknown) =>
        failure(
          "orchestration_error",
          `Unable to watch delegated task ${taskId}: ${errorMessage(error)}`,
        );
      // Sequences are global, so one cursor taken before the first read
      // replays anything either thread records after it.
      const afterSequence = yield* threadManagement
        .getThreadEventSequence(scope.thread.threadId)
        .pipe(Effect.mapError(streamError));
      const initial = yield* readTask(scope, taskId, false, true);
      if (endsTaskWait(initial)) {
        return Option.some(initial);
      }
      // Keep event types narrow, then skip non-question transcript items.
      // A steered user_message on the parent thread wakes the wait early so the parent turn
      // can answer the follow-up while finishTaskWait promotes completionWake to "always".
      return yield* Stream.mergeAll(
        TASK_WAKE_EVENTS.flatMap(({ thread, eventType }) => {
          if (thread === "child" && (initial.host !== undefined || initial.childThreadId === null))
            return [];
          const threadId = thread === "parent" ? scope.thread.threadId : initial.childThreadId;
          return threadId === null
            ? []
            : [
                threadManagement
                  .streamStoredEventsFrom({ threadId, afterSequence, eventType })
                  .pipe(Stream.map((stored) => ({ thread, stored }))),
              ];
        }),
        { concurrency: "unbounded" },
      ).pipe(
        Stream.mapError(streamError),
        // The item can commit after its request; other transcript items need no read.
        Stream.filter(({ thread, stored }) => {
          if (stored.event.type !== "turn-item.updated") return true;
          if (thread === "parent") {
            return (
              stored.event.payload.type === "user_message" &&
              stored.event.payload.inputIntent === "steer"
            );
          }
          return stored.event.payload.type === "user_input_request";
        }),
        Stream.mapEffect(({ thread, stored }) => {
          const isParentSteer =
            thread === "parent" &&
            stored.event.type === "turn-item.updated" &&
            stored.event.payload.type === "user_message" &&
            stored.event.payload.inputIntent === "steer";
          return readTask(scope, taskId, false, true).pipe(
            Effect.map((task) => ({ isParentSteer, task })),
          );
        }),
        Stream.filter(({ isParentSteer, task }) => isParentSteer || endsTaskWait(task)),
        Stream.map(({ task }) => task),

        Stream.runHead,
      );
    },
    (effect, _scope, _taskId, timeoutMs) =>
      effect.pipe(Effect.timeoutOption(Duration.millis(timeoutMs)), Effect.map(Option.flatten)),
  );

  const acknowledgeTaskResult = (
    scope: McpThreadInvocationScope,
    task: OrchestrationV2Subagent,
    parentProjection: Pick<OrchestrationV2ThreadProjection, "runs">,
    status: OrchestratorMcpDelegateTaskResult["status"],
    acknowledgementOperation: string,
  ) =>
    Effect.gen(function* () {
      if (
        !isTerminalTaskStatus(status) ||
        task.completionDelivery?.state === "acknowledged" ||
        task.completionDelivery?.state === "disposed"
      )
        return;
      const observingRun = ThreadManagementService.latestActiveRun(parentProjection);
      const acknowledgementRequestKey = yield* requestKey(undefined);
      yield* threadManagement
        .dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: stableCommandId({
            scope,
            requestKey: acknowledgementRequestKey,
            operation: acknowledgementOperation,
          }),
          parentThreadId: scope.thread.threadId,
          taskId: task.id,
          observedByRunId:
            observingRun?.providerInstanceId === scope.thread.providerInstanceId
              ? observingRun.id
              : null,
        })
        .pipe(
          Effect.mapError((error) =>
            failure(
              "orchestration_error",
              `Unable to acknowledge delegated task ${task.id}: ${errorMessage(error)}`,
            ),
          ),
        );
    });
  const finishTaskWait = (
    scope: McpThreadInvocationScope,
    taskId: NodeId,
    key: string,
    input: OrchestratorMcpDelegateTaskInput,
  ) =>
    Effect.gen(function* () {
      if (input.mode !== "wait") {
        return yield* readTask(scope, taskId, false, true);
      }
      const timeoutMs = Math.min(
        MAX_WAIT_TIMEOUT_MS,
        Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
      );
      const waited = yield* waitForTask(scope, taskId, timeoutMs);
      if (Option.isSome(waited) && isTerminalTaskStatus(waited.value.status)) {
        return waited.value;
      }
      // An incomplete wait gives up delivery: upgrade so a later terminal
      // wakes the parent even mid-turn. Best effort; settled_only still
      // wakes a settled parent if the upgrade fails.
      yield* threadManagement
        .dispatch({
          type: "delegated_task.wake-policy",
          commandId: stableCommandId({
            scope,
            requestKey: key,
            operation: "delegate-task-wake-policy",
          }),
          parentThreadId: scope.thread.threadId,
          taskId,
          completionWake: "always",
        })
        .pipe(
          // The tool result still returns after a timeout or question, so failures
          // stay warnings. Keep the two shapes apart: a rejected receipt
          // means this exact command id already failed (a replay of a
          // no-op upgrade), while anything else is a fresh dispatch fault.
          Effect.catch((error) =>
            Effect.logWarning("orchestrator-mcp.delegate-task.wake-policy-failed", {
              taskId,
              outcome:
                error._tag === "OrchestratorCommandPreviouslyRejectedError"
                  ? "previously_rejected"
                  : "dispatch_failed",
              error,
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestrator-mcp.delegate-task.wake-policy-failed", {
              taskId,
              outcome: "defect",
              cause,
            }),
          ),
        );
      if (Option.isSome(waited)) return waited.value;
      const final = yield* readTask(scope, taskId, false, true);
      return {
        ...final,
        waitTimedOut: !endsTaskWait(final),
      };
    });
  const scheduledTaskRunModes = Effect.fn("OrchestratorMcpService.scheduledTaskRunModes")(
    function* (task: ScheduledTask) {
      const modes = [{ runtimeMode: task.runtimeMode, interactionMode: task.interactionMode }];
      if (task.threadId === null) return modes;
      const bound = yield* threadManagement
        .getThreadShell(task.threadId)
        .pipe(Effect.mapError(threadManagementFailure));
      return bound === null || bound.deletedAt !== null ? modes : [...modes, bound];
    },
  );

  const withinLimits = (
    limits: {
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    },
    modes: { readonly runtimeMode: RuntimeMode; readonly interactionMode: ProviderInteractionMode },
  ) =>
    runtimeModeRank(modes.runtimeMode) <= runtimeModeRank(limits.runtimeMode) &&
    interactionModeRank(modes.interactionMode) <= interactionModeRank(limits.interactionMode);

  /**
   * Its webhook URL starts runs, so only a caller that may start one sees it: never a client
   * approved for read-only access, and a thread caller only with a live turn, at modes covering
   * every mode the task runs at.
   */
  const summarizeScheduledTask = Effect.fn("OrchestratorMcpService.summarizeScheduledTask")(
    function* (
      scope: McpInvocationScope,
      caller: {
        readonly parent: Pick<OrchestrationV2ThreadProjection, "thread" | "runs"> | undefined;
        readonly limits: {
          readonly runtimeMode: RuntimeMode;
          readonly interactionMode: ProviderInteractionMode;
        };
      },
      task: ScheduledTask,
    ) {
      const live =
        caller.parent === undefined
          ? scope.client?.access !== "read-only"
          : Exit.isSuccess(yield* Effect.exit(assertLiveCaller(scope, caller.parent)));
      const modes = yield* scheduledTaskRunModes(task).pipe(Effect.option);
      return scheduledTaskSummary(
        task,
        live &&
          Option.isSome(modes) &&
          modes.value.every((mode) => withinLimits(caller.limits, mode)),
      );
    },
  );

  /**
   * A scheduled task the caller may change: one whose runs execute at modes no
   * broader than the caller's own, so editing its prompt cannot run work above
   * the caller's limits.
   */
  const loadScheduledTask = Effect.fn("OrchestratorMcpService.loadScheduledTask")(function* (
    scheduledTaskId: ScheduledTask["id"],
    limits: {
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    },
  ): Effect.fn.Return<ScheduledTask, OrchestratorMcpFailure> {
    const { tasks } = yield* scheduledTasks
      .list()
      .pipe(
        Effect.mapError((error) =>
          failure("orchestration_error", `Could not load scheduled task: ${error.message}`),
        ),
      );
    const task = tasks.find((candidate) => candidate.id === scheduledTaskId);
    if (task === undefined) {
      return yield* failure("task_not_found", `Scheduled task ${scheduledTaskId} was not found.`);
    }
    for (const modes of yield* scheduledTaskRunModes(task)) {
      yield* resolveRuntimeMode(limits.runtimeMode, modes.runtimeMode);
      yield* resolveInteractionMode(limits.interactionMode, modes.interactionMode);
    }
    return task;
  });

  return OrchestratorMcpService.of({
    permissionProfile: (scope) =>
      permissions.resolve(scope).pipe(Effect.map(({ narrowing: _narrowing, ...view }) => view)),
    admitRemoteSend: Effect.fn("OrchestratorMcpService.admitRemoteSend")(function* (scope, input) {
      const effective = yield* permissions.resolve(scope);
      if (!effective.enabled) return { ceiling: undefined, settle: () => Effect.void };
      const context = { host: input.host, runtimeMode: effective.runtimeMode };
      yield* permissions.require(scope, "threads.launch", context);
      yield* permissions.require(scope, "threads.remote", context);
      const id = stableCommandId({
        scope,
        requestKey: yield* requestKey(input.clientRequestId),
        operation: `remote-send:${input.host}:${input.threadId}`,
      });
      const admitted = yield* permissions.claim(scope, {
        id,
        host: input.host,
        runtimeMode: effective.runtimeMode,
        remoteThreadId: input.threadId,
      });
      return {
        ceiling: admitted.enabled ? admitted.profile : undefined,
        settle: (sent: boolean) =>
          sent
            ? permissions.completeRemote(id, input.host, input.threadId)
            : permissions.release(id),
      };
    }),
    scheduleTask: Effect.fn("OrchestratorMcpService.scheduleTask")(function* (scope, input) {
      const { parent, limits } = yield* loadCaller(scope);
      const projectId = yield* resolveProjectTarget(parent, input.projectId);
      yield* assertLiveCallerForOtherProject(scope, parent, projectId);
      const project = yield* requireProject(projectId);
      const bindToCurrentThread =
        input.bindToCurrentThread ??
        (parent !== undefined && parent.thread.projectId === projectId);
      if (bindToCurrentThread && (parent === undefined || parent.thread.projectId !== projectId)) {
        return yield* failure(
          "invalid_request",
          parent === undefined
            ? "bindToCurrentThread needs an agent running inside a GOAT thread."
            : "bindToCurrentThread binds to this thread, which belongs to a different project.",
        );
      }
      const modelSelection =
        parent?.thread.modelSelection ?? (yield* projectDefaultModelSelection(project));
      const derivedTitle = input.prompt.split("\n")[0]?.trim() ?? "";
      const title =
        input.title ?? (derivedTitle.length > 0 ? derivedTitle.slice(0, 80) : "Scheduled task");
      const upsertInput: ScheduledTaskUpsertInput = {
        title,
        prompt: input.prompt,
        enabled: input.enabled ?? true,
        schedule: input.schedule,
        projectId,
        threadId: bindToCurrentThread && parent !== undefined ? parent.thread.id : null,
        workspaceStrategy: scheduledTaskWorkspaceStrategy(bindToCurrentThread),
        modelSelection,
        runtimeMode: limits.runtimeMode,
        interactionMode: limits.interactionMode,
        createdBy: "agent",
        creationSource: "mcp",
        // Scope the idempotency key by provider session so two callers
        // reusing the same clientRequestId cannot collide on one task row.
        ...(input.clientRequestId === undefined
          ? {}
          : {
              commandId: stableCommandId({
                scope,
                requestKey: input.clientRequestId,
                operation: "schedule-task",
              }),
            }),
      };
      const memoryGrantCeiling = yield* captureMcpTaskMemoryGrantCeiling(scope, false).pipe(
        Effect.mapError(() =>
          failure("invalid_request", "Caller memory authority is no longer available."),
        ),
      );
      const { task } = yield* scheduledTasks
        .upsert(upsertInput, { memoryGrantCeiling })
        .pipe(
          Effect.mapError((error) =>
            failure("orchestration_error", `Could not schedule task: ${error.message}`),
          ),
        );
      return yield* summarizeScheduledTask(scope, { parent, limits }, task);
    }),
    listScheduledTasks: Effect.fn("OrchestratorMcpService.listScheduledTasks")(
      function* (scope, input) {
        const { parent, limits } = yield* loadCaller(scope);
        const projectId = input.projectId ?? parent?.thread.projectId;
        const { tasks } = yield* scheduledTasks
          .list()
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Could not list scheduled tasks: ${error.message}`),
            ),
          );
        return {
          tasks: yield* Effect.forEach(
            tasks.filter((task) => projectId === undefined || task.projectId === projectId),
            (task) => summarizeScheduledTask(scope, { parent, limits }, task),
          ),
        };
      },
    ),
    updateScheduledTask: Effect.fn("OrchestratorMcpService.updateScheduledTask")(function* (
      scope,
      input,
      admit = Effect.void,
    ) {
      const { parent, limits } = yield* loadCaller(scope);
      const existing = yield* loadScheduledTask(input.scheduledTaskId, limits);
      yield* assertLiveCallerForOtherProject(scope, parent, existing.projectId);
      if (
        input.bindToCurrentThread === true &&
        (parent === undefined || parent.thread.projectId !== existing.projectId)
      ) {
        return yield* failure(
          "invalid_request",
          parent === undefined
            ? "bindToCurrentThread needs an agent running inside a GOAT thread."
            : "bindToCurrentThread binds to this thread, which belongs to a different project.",
        );
      }
      const threadId =
        input.bindToCurrentThread === undefined
          ? existing.threadId
          : input.bindToCurrentThread && parent !== undefined
            ? parent.thread.id
            : null;
      // Rebinding changes where runs execute, so the workspace strategy must
      // follow: unbinding a root-strategy task would otherwise run loose
      // prompts in the shared project checkout.
      const workspaceStrategy =
        input.bindToCurrentThread === undefined
          ? existing.workspaceStrategy
          : scheduledTaskWorkspaceStrategy(input.bindToCurrentThread);
      const upsertInput: ScheduledTaskUpsertInput = {
        id: existing.id,
        title: input.title ?? existing.title,
        prompt: input.prompt ?? existing.prompt,
        enabled: input.enabled ?? existing.enabled,
        schedule: input.schedule ?? existing.schedule,
        projectId: existing.projectId,
        threadId,
        workspaceStrategy,
        modelSelection: existing.modelSelection,
        runtimeMode: existing.runtimeMode,
        interactionMode: existing.interactionMode,
        createdBy: existing.createdBy,
        creationSource: existing.creationSource,
      };
      const memoryGrantCeiling = yield* captureMcpTaskMemoryGrantCeiling(scope, false).pipe(
        Effect.mapError(() =>
          failure("invalid_request", "Caller memory authority is no longer available."),
        ),
      );
      yield* admit;
      const { task } = yield* scheduledTasks
        .upsert(upsertInput, { memoryGrantCeiling })
        .pipe(
          Effect.mapError((error) =>
            failure("orchestration_error", `Could not update scheduled task: ${error.message}`),
          ),
        );
      return yield* summarizeScheduledTask(scope, { parent, limits }, task);
    }),
    deleteScheduledTask: Effect.fn("OrchestratorMcpService.deleteScheduledTask")(
      function* (scope, input) {
        const { parent, limits } = yield* loadCaller(scope);
        const existing = yield* loadScheduledTask(input.scheduledTaskId, limits);
        yield* assertLiveCallerForOtherProject(scope, parent, existing.projectId);
        yield* scheduledTasks
          .delete({ id: existing.id })
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Could not delete scheduled task: ${error.message}`),
            ),
          );
        return { scheduledTaskId: existing.id, deleted: true };
      },
    ),
    requestSecret: makeRequestSecret({
      threadManagement,
      secretRequests,
      loadThreadCaller,
      requestKey,
    }),

    capabilities: Effect.fn("OrchestratorMcpService.capabilities")(function* (scope, input = {}) {
      const { parent, limits } = yield* loadCaller(scope);
      const providers = yield* loadProviders;
      const orchestrationCapableInstanceIds = yield* loadOrchestrationCapableInstanceIds();
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(() => failure("orchestration_error", "Unable to read server settings.")),
      );
      const inherited = parent?.thread.modelSelection;
      const searchTerms = input.search?.toLowerCase().split(/\s+/) ?? [];
      return {
        parentThreadId: parent?.thread.id ?? null,
        inheritedProviderInstanceId: inherited?.instanceId ?? null,
        inheritedModel: inherited?.model ?? null,
        inheritedOptions: inherited?.options ?? [],
        runtimeMode: limits.runtimeMode,
        interactionMode: limits.interactionMode,
        providers: yield* Effect.forEach(providers, (provider) =>
          Effect.gen(function* () {
            const maybeAdapter = orchestrationCapableInstanceIds.has(provider.instanceId)
              ? yield* providerAdapters.get(provider.instanceId).pipe(Effect.option)
              : Option.none();
            const maybeCapabilities = Option.isSome(maybeAdapter)
              ? yield* maybeAdapter.value.getCapabilities().pipe(Effect.option)
              : Option.none();
            const caps = Option.getOrUndefined(maybeCapabilities);
            const constraints = providerConstraints(
              provider,
              orchestrationCapableInstanceIds.has(provider.instanceId) && caps !== undefined,
            );
            const { listed, omitted } = listCapabilityModels({
              provider,
              preferences: settings.providerModelPreferences?.[provider.instanceId],
              searchTerms,
              isPinned: (model) =>
                model.isCustom ||
                (inherited?.instanceId === provider.instanceId && inherited.model === model.slug) ||
                (settings.favorites ?? []).some(
                  (favorite) =>
                    favorite.provider === provider.instanceId && favorite.model === model.slug,
                ),
            });
            return {
              executionLocation:
                provider.executionLocation ?? caps?.sessions.executionLocation ?? "local",
              ...(caps === undefined
                ? {}
                : {
                    followUp: {
                      supported: caps.sessions.followUp?.supported ?? true,
                      ...(caps.sessions.followUp?.reason === undefined
                        ? {}
                        : {
                            reason: caps.sessions.followUp.reason.slice(0, 1000),
                          }),
                    },
                  }),
              providerInstanceId: provider.instanceId,
              driverKind: provider.driver,
              displayName: provider.displayName ?? null,
              models: listed.map((model) => {
                const options = model.capabilities?.optionDescriptors ?? [];
                return {
                  id: model.slug,
                  ...(model.name.toLowerCase() === model.slug.toLowerCase()
                    ? {}
                    : { label: model.name }),
                  ...(options.length === 0 ? {} : { options: options.map(capabilityModelOption) }),
                };
              }),
              ...(omitted === 0 ? {} : { omittedModels: omitted }),
              ...(provider.supportedRuntimeModes === undefined ||
              provider.supportedRuntimeModes.length === 0
                ? {}
                : { runtimeModes: [...provider.supportedRuntimeModes] }),
              canRunChildTask: constraints.length === 0,
              canRunCrossProviderChildTask: constraints.length === 0,
              constraints: [...constraints],
            };
          }),
        ),
        features: {
          appOwnedSubagents: true,
          asyncPolling: true,
          cancellation: true,
          batchThreadCreation: true,
          threadManagement: true,
          incrementalThreadRead: true,
          scheduledTasks: true,
          maxBatchThreads: 20,
        },
      };
    }),
    delegateTask: Effect.fn("OrchestratorMcpService.delegateTask")(function* (callerScope, input) {
      const { scope, parent } = yield* loadThreadCaller(callerScope, "delegate_task");
      // Resolved per call: the first memoized construction of this service precedes the
      // channel layer, so a construction-time capture would bypass channel admission.
      const channelChildWork = yield* Effect.serviceOption(ChannelChildWork.ChannelChildWork);
      // Same per-call reason as channelChildWork; absent from the call context only in
      // fixtures, where keeping the reservation is the safe answer.
      const commandReceipts = yield* Effect.serviceOption(
        CommandReceiptStore.CommandReceiptStoreV2,
      );
      const memoryGrantCeiling = yield* captureMcpTaskMemoryGrantCeiling(scope, false).pipe(
        Effect.mapError(() =>
          failure("invalid_request", "Caller memory authority is no longer available."),
        ),
      );
      const parentRun = parent.runs
        .filter(ThreadManagementService.isActiveRun)
        .toSorted((left, right) => right.ordinal - left.ordinal)[0];
      if (
        parentRun === undefined ||
        parentRun.rootNodeId === null ||
        parentRun.providerInstanceId !== scope.thread.providerInstanceId
      ) {
        return yield* failure(
          "parent_not_active",
          "Delegated tasks require an active run owned by this MCP provider session.",
        );
      }
      if ((input.target?.host === undefined) !== (input.remote === undefined))
        return yield* failure("invalid_request", "Pass target.host and remote.cwd together.");
      if (input.target?.host !== undefined && input.remote !== undefined) {
        const host = input.target.host;
        const remote = input.remote;
        const requestedTarget = input.target;
        const parentNodeId = parentRun.rootNodeId;
        const callerRuntimeMode = yield* authorizeRemoteWrite(scope, parentRun.id);
        let runtimeMode = yield* resolveRuntimeMode(callerRuntimeMode, input.runtimeMode);
        const interactionMode = yield* resolveInteractionMode(
          parent.thread.interactionMode,
          input.interactionMode,
        );
        const admission = yield* admitDelegate(channelChildWork, {
          callerThreadId: scope.thread.threadId,
          prompt: taskPrompt(input),
          clientRequestId: input.clientRequestId,
          target: input.target,
          role: input.role,
          remote: { host, cwd: remote.cwd, workspace: remote.workspace },
        });
        if (admission !== undefined && admission._tag === "existing")
          return yield* existingChildWorkConflict(admission);
        const key = admission?.requestKey ?? (yield* requestKey(input.clientRequestId));
        const commandId = stableCommandId({ scope, requestKey: key, operation: "delegate-task" });
        const taskId = derive.delegatedTaskNode({ commandId });
        const existing = parent.subagents.find((task) => task.id === taskId);
        const acknowledge = (ceiling: GoatclawCeilingAdvice | undefined) =>
          finishTaskWait(scope, taskId, key, input).pipe(
            Effect.map((delegated) =>
              ceiling === undefined ? delegated : { ...delegated, ceiling },
            ),
          );
        // A replay or a concurrent duplicate forwards nothing itself, and whether the call that
        // launched carried a ceiling is not recorded, so neither says anything about one.
        if (existing !== undefined) return yield* acknowledge(undefined);
        // Checks and claims sit between admission and launch; when one fails, the
        // reservation returns so a rejected request never holds the descendant budget.
        const prepared = yield* Effect.gen(function* () {
          yield* permissions.require(scope, "threads.launch", { host, runtimeMode });
          yield* permissions.require(scope, "threads.remote", { host, runtimeMode });
          const target = yield* resolveRemoteTarget(scope, parent, {
            ...requestedTarget,
            host,
          });
          const claimed = yield* permissions.claim(scope, {
            id: taskId,
            runtimeMode,
            host,
            worktree: remote.workspace?.type === "worktree",
          });
          const advice = claimed.enabled
            ? yield* FleetSync.syncBeforeForwarding(fleet, host)
            : undefined;
          return { target, claimed, advice };
        }).pipe(Effect.onError(() => releaseReservation(channelChildWork, admission)));
        const target = prepared.target;
        const admitted = prepared.claimed;
        const ceilingAdvice = prepared.advice;
        runtimeMode = admitted.runtimeMode;
        const register = Effect.gen(function* () {
          yield* permissions.recheck(scope, admitted, { host });
          yield* authorizeRemoteWrite(scope, parentRun.id);
          const records = yield* remoteDispatch
            .listForOrigin(scope.thread.threadId)
            .pipe(
              Effect.mapError(() =>
                failure("orchestration_error", "Unable to load the persisted remote dispatch."),
              ),
            );
          const record = records.find((row) => row.kind === "task" && row.task?.taskId === taskId);
          if (record === undefined)
            return yield* failure(
              "orchestration_error",
              "Remote dispatch was not persisted before launch.",
            );
          yield* threadManagement
            .dispatch({
              type: "delegated_task.remote.register",
              ...(input.role === undefined ? {} : { role: input.role }),
              parentModelSelection: parentRun.modelSelection,
              memoryGrantCeiling: record.memoryGrantCeiling,
              commandId,
              parentThreadId: scope.thread.threadId,
              parentRunId: parentRun.id,
              parentNodeId,
              task: Profiles.childBrief(admitted, scope.thread.threadId, taskPrompt(input)),
              ...(input.title === undefined ? {} : { title: input.title }),
              modelSelection: target.modelSelection,
              driver: target.driver,
              runtimeMode,
              interactionMode,
              createdBy: "agent",
              creationSource: "mcp",
              completionWake: input.mode === "wait" ? "settled_only" : "always",
              remote: { host, threadId: null, correlationId: record.correlationId },
            })
            .pipe(Effect.mapError(threadManagementFailure));
        });
        // A refused claim launched nothing, so the lane claimed above returns.
        const claimLaunch = launchRemoteChildWork(channelChildWork, admission, host).pipe(
          Effect.onError(() =>
            admitted.enabled ? permissions.release(taskId).pipe(Effect.ignore) : Effect.void,
          ),
        );
        const launched = yield* remoteDispatch
          .launch(
            {
              kind: "task",
              originThreadId: scope.thread.threadId,
              delivery: "wake",
              task: { taskId, parentRunId: parentRun.id },
              // A channel-owned caller's binding id derives from its child-work record, so a
              // retry collides on the remote_dispatches key instead of launching twice.
              correlationId: admissionCorrelationId(admission),
              launch: {
                host,
                cwd: remote.cwd,
                memoryGrantCeiling,
                workspace: remote.workspace ?? { type: "cwd" },
                title: input.title ?? taskPrompt(input).slice(0, 72),
                message: Profiles.childBrief(admitted, scope.thread.threadId, taskPrompt(input)),
                modelSelection: target.modelSelection,
                runtimeMode,
                callerRuntimeMode,
                ...(admitted.enabled ? { permissionProfileCeiling: admitted.profile } : {}),
                interactionMode,
                // Shown on the remote thread like a goat_ssh_thread_launch from this thread.
                launchedBy: {
                  kind: "launch",
                  threadId: scope.thread.threadId,
                  environmentId: scope.environmentId,
                  environmentLabel: null,
                  threadTitle: parent.thread.title,
                  via: "delegate_task",
                },
              },
            },
            register,
          )
          .pipe(
            Effect.result,
            // The claim holds the launch in flight until its row and remote write finish.
            (launch) => Effect.andThen(claimLaunch, launch),
            Effect.scoped,
          );
        if (launched._tag === "Failure") {
          // The coordinator wraps a failure it proved happened before any remote write
          // (stage "authorize"); the task key it deleted frees this lane and slot too.
          const preSend =
            isRemoteDispatchError(launched.failure) && launched.failure.stage === "authorize";
          const underlying = isRemoteDispatchError(launched.failure)
            ? launched.failure.cause
            : launched.failure;
          const refusedBeforeLaunch =
            preSend ||
            (underlying instanceof SshRemoteDispatch.SshRemoteDispatchError &&
              (underlying.reason === "remote_refused" ||
                underlying.reason === "invalid_request" ||
                underlying.reason === "host_unknown") &&
              underlying.launchMayHaveStarted !== true);
          // The destination never started, so the lane and the child-work slot return.
          if (refusedBeforeLaunch) {
            if (admitted.enabled) yield* permissions.release(taskId);
            yield* releaseChildWork(channelChildWork, admission);
          }
        }
        if (admitted.enabled && launched._tag === "Success")
          yield* permissions.complete(
            taskId,
            launched.success.launch.threadId,
            launched.success.correlationId,
          );
        if (launched._tag === "Success") yield* bindChildWork(channelChildWork, admission);
        if (
          launched._tag === "Failure" &&
          isRemoteDispatchError(launched.failure) &&
          launched.failure.reason === "duplicate_task"
        )
          return yield* acknowledge(undefined);
        if (
          launched._tag === "Failure" &&
          isRemoteDispatchError(launched.failure) &&
          launched.failure.stage === "launch"
        ) {
          const ownerError = launched.failure.cause;
          if (isOrchestratorMcpFailure(ownerError)) return yield* ownerError;
          if (ownerError instanceof SshRemoteDispatch.SshRemoteDispatchError)
            return yield* hostFailure(ownerError);
          if (ownerError === undefined)
            return yield* failure(
              "invalid_request",
              "An earlier goat_task_create with this clientRequestId did not finish launching; use a new clientRequestId.",
            );
        }
        if (
          launched._tag === "Failure" &&
          isRemoteDispatchError(launched.failure) &&
          launched.failure.stage === "authorize"
        ) {
          // A proven pre-send failure wraps the one the caller can act on.
          const ownerError = launched.failure.cause;
          if (isOrchestratorMcpFailure(ownerError)) return yield* ownerError;
          if (ownerError instanceof SshRemoteDispatch.SshRemoteDispatchError)
            return yield* hostFailure(ownerError);
        }
        if (launched._tag === "Failure" || launched.success.launch.runId === null) {
          const refreshed = yield* loadProjection(scope.thread.threadId);
          if (
            !refreshed.subagents.some((task) => task.id === taskId) &&
            launched._tag === "Failure"
          )
            return yield* launched.failure instanceof SshRemoteDispatch.SshRemoteDispatchError
              ? hostFailure(launched.failure)
              : isOrchestratorMcpFailure(launched.failure)
                ? launched.failure
                : Object.defineProperty(
                    failure(
                      "orchestration_error",
                      "Remote dispatch failed before task registration.",
                    ),
                    // Keep diagnostics out of both the wire schema and JSON serialization.
                    "cause",
                    { value: launched.failure, configurable: true, writable: true },
                  );
          const failedTask = refreshed.subagents.find((task) => task.id === taskId);
          if (failedTask?.remote === undefined || failedTask.runId === null)
            return yield* failure(
              "orchestration_error",
              "Remote task registration has no durable binding.",
            );
          const launchError = launched._tag === "Failure" ? launched.failure : undefined;
          const refusal =
            launchError instanceof SshRemoteDispatch.SshRemoteDispatchError &&
            launchError.reason !== "ssh_failed" &&
            launchError.reason !== "host_unavailable"
              ? launchError.reason
              : isOrchestratorMcpFailure(launchError)
                ? launchError.code
                : null;
          // Only a definite refusal proves nothing ran; a transport or local storage
          // failure after the call may hide a remote thread that did start.
          yield* recordRemoteTaskResult({
            originThreadId: scope.thread.threadId,
            task: { taskId, parentRunId: failedTask.runId },
            correlationId: failedTask.remote.correlationId,
            status: "failed",
            summary:
              refusal !== null
                ? `Remote launch refused on host ${host}; nothing was launched (${refusal}).`
                : `launch outcome unknown; inspect ${goatCallText("thread.list")} with host ${host} before retrying`,
          }).pipe(
            Effect.provideService(
              ThreadManagementService.ThreadManagementService,
              threadManagement,
            ),
            Effect.mapError(threadManagementFailure),
          );
        }
        return yield* acknowledge(ceilingAdvice);
      }

      const providers = yield* loadProviders;
      const admission = yield* admitDelegate(channelChildWork, {
        callerThreadId: scope.thread.threadId,
        prompt: taskPrompt(input),
        clientRequestId: input.clientRequestId,
        target: input.target,
        isolation: input.isolation,
        role: input.role,
      });
      if (admission !== undefined && admission._tag === "existing")
        return yield* existingChildWorkConflict(admission);
      const key = admission?.requestKey ?? (yield* requestKey(input.clientRequestId));
      const commandId = stableCommandId({
        scope,
        requestKey: key,
        operation: "delegate-task",
      });
      const prepared = yield* Effect.gen(function* () {
        const isRetryOfAcceptedDelegation = yield* threadManagement.hasReceipt(commandId);
        const target = yield* resolveTargetRechecking({
          parent,
          target: input.target,
          providers,
          skipProjectEnablementFilter: isRetryOfAcceptedDelegation,
        });
        const requestedRuntimeMode = yield* resolveRuntimeMode(
          parent.thread.runtimeMode,
          input.runtimeMode,
          target,
        );
        const interactionMode = yield* resolveInteractionMode(
          parent.thread.interactionMode,
          input.interactionMode,
        );
        let workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy | undefined;
        if (input.isolation === "worktree" && !isRetryOfAcceptedDelegation) {
          const project = yield* requireProject(parent.thread.projectId);
          const base = yield* gitDriver
            .resolveCommit({
              cwd: parent.thread.worktreePath ?? project.workspaceRoot,
              revision: "HEAD",
            })
            .pipe(
              Effect.mapError(() =>
                failure("invalid_request", "Unable to resolve the parent checkout commit."),
              ),
            );
          // Launch preparation creates the worktree from the project root, so a
          // parent checkout in another repository (such as a Git folder inside
          // Scratch) would hand it a commit it cannot find.
          if (parent.thread.worktreePath !== null) {
            yield* gitDriver
              .resolveCommit({ cwd: project.workspaceRoot, revision: base.commitSha })
              .pipe(
                Effect.mapError(() =>
                  failure(
                    "invalid_request",
                    `Isolation "worktree" creates the child checkout in project "${project.title}" (${project.workspaceRoot}), which does not contain the parent checkout's commit. Use isolation "shared" to work in the parent's checkout.`,
                  ),
                ),
              );
          }
          workspaceStrategy = { type: "worktree", baseRef: base.commitSha, startFromOrigin: false };
        }
        // ThreadManagementService.dispatch is the chokepoint for this command
        // type's own enablement check, using the same command id and its
        // receipt-replay exemption, so no separate assert runs here.
        if (!isRetryOfAcceptedDelegation)
          yield* preflightCloudLaunch(
            scope,
            parent.thread.projectId,
            target.modelSelection,
            parent.thread.worktreePath,
            parent.thread.branch,
          );
        yield* captureMcpTaskMemoryGrantCeiling(scope, false).pipe(
          Effect.mapError(() =>
            failure("invalid_request", "Caller memory authority is no longer available."),
          ),
        );
        return {
          isRetryOfAcceptedDelegation,
          target,
          requestedRuntimeMode,
          interactionMode,
          workspaceStrategy,
        };
      }).pipe(Effect.onError(() => releaseReservation(channelChildWork, admission)));
      const target = prepared.target;
      const requestedRuntimeMode = prepared.requestedRuntimeMode;
      const interactionMode = prepared.interactionMode;
      const workspaceStrategy = prepared.workspaceStrategy;
      const admitted = yield* permissions
        .claim(scope, {
          id: commandId,
          childThreadId: derive.delegatedTaskThread({ commandId }),
          runtimeMode: requestedRuntimeMode,
          worktree: input.isolation === "worktree",
        })
        .pipe(Effect.onError(() => releaseChildWork(channelChildWork, admission)));
      // A refused claim launched nothing, so the lane claimed above returns.
      const claimLaunch = launchChildWork(channelChildWork, admission, {
        threadId: derive.delegatedTaskThread({ commandId }),
      }).pipe(
        Effect.onError(() =>
          admitted.enabled ? permissions.release(commandId).pipe(Effect.ignore) : Effect.void,
        ),
      );
      const runtimeMode = admitted.runtimeMode;
      const result = yield* threadManagement
        .dispatch({
          type: "delegated_task.request",
          ...(input.role === undefined ? {} : { role: input.role }),
          parentModelSelection: parentRun.modelSelection,
          memoryGrantCeiling,
          createdBy: "agent",
          creationSource: "mcp",
          commandId,
          parentThreadId: scope.thread.threadId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId,
          task: Profiles.childBrief(admitted, scope.thread.threadId, taskPrompt(input)),
          ...(input.title === undefined ? {} : { title: input.title }),
          modelSelection: target.modelSelection,
          runtimeMode,
          interactionMode,
          ...(workspaceStrategy === undefined ? {} : { workspaceStrategy }),
          // Async delegations wake the parent on every child terminal; wait
          // delegations deliver through the blocking tool call, so a wake is
          // only needed if the parent settled first (timeout, disconnect).
          completionWake: input.mode === "wait" ? "settled_only" : "always",
        })
        .pipe(
          Effect.onError(() =>
            admitted.enabled
              ? permissions.release(commandId, true).pipe(Effect.ignore)
              : Effect.void,
          ),
          // Commit certainty from the receipt, not from the dispatch error: an accepted
          // receipt means the work exists and keeps its slot; a rejected or absent receipt
          // means the command never ran, so the reservation goes back. An unreadable
          // receipt proves nothing, so the slot stays rather than double-spend.
          Effect.onError(() =>
            commandReceipts._tag === "None"
              ? Effect.void
              : commandReceipts.value.getByCommandId(commandId).pipe(
                  Effect.flatMap((receipt) =>
                    Option.isSome(receipt) && receipt.value.status === "accepted"
                      ? Effect.void
                      : releaseChildWork(channelChildWork, admission),
                  ),
                  Effect.ignore,
                ),
          ),
          Effect.mapError((error) =>
            error._tag === "ThreadManagementProviderInstanceDisabledError"
              ? threadManagementFailure(error)
              : failure(
                  "orchestration_error",
                  `Unable to create delegated task: ${errorMessage(error)}`,
                ),
          ),
          // The claim holds the launch in flight until the delegation commits.
          (dispatch) => Effect.andThen(claimLaunch, dispatch),
          Effect.scoped,
        );
      if (admitted.enabled) yield* permissions.complete(commandId);
      const taskEvent = result.storedEvents.find(
        (stored) =>
          stored.event.type === "subagent.updated" && stored.event.payload.origin === "app_owned",
      );
      if (taskEvent?.event.type !== "subagent.updated") {
        return yield* failure(
          "orchestration_error",
          "Delegated task command did not produce a task projection.",
        );
      }
      const taskId = taskEvent.event.payload.id;
      const childThreadId = taskEvent.event.payload.childThreadId;
      if (childThreadId !== null)
        yield* bindChildWork(channelChildWork, admission, { threadId: childThreadId });
      const childRunEvent = result.storedEvents.find(
        (stored) => stored.event.type === "run.created" && stored.event.threadId === childThreadId,
      );
      if (
        childThreadId !== null &&
        childRunEvent?.event.type === "run.created" &&
        childRunEvent.event.payload.workspacePreparation !== undefined
      ) {
        yield* threadLaunch.prepareRun({
          commandId,
          threadId: childThreadId,
          runId: childRunEvent.event.payload.id,
        });
      }
      return yield* finishTaskWait(scope, taskId, key, input);
    }),
    taskStatus: Effect.fn("OrchestratorMcpService.taskStatus")(function* (callerScope, taskId) {
      const scope = yield* requireThreadScope(callerScope, "task_status");
      const status = yield* readTask(scope, taskId, false, true);
      if (status.host === undefined || status.childThreadId === null) return status;
      // Only explicit status reads enrich persisted SSH results. Launches,
      // event-driven waits and cancellation must not wait for optional host I/O.
      const cloudTask = yield* readRemoteCloudTask(scope, status.host, status.childThreadId).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
        Effect.timeoutOption("5 seconds"),
        Effect.map(Option.getOrUndefined),
      );
      return {
        ...status,
        ...(cloudTask === undefined ? {} : { cloudTask }),
      };
    }),
    recordReviewFindings: (callerScope, input) =>
      Effect.gen(function* () {
        const { scope, parent } = yield* loadThreadCaller(
          callerScope,
          "goat_review_findings_record",
        );
        const key = yield* requestKey(input.clientRequestId);
        yield* threadManagement
          .dispatch({
            type: "delegated_task.review-ledger.append",
            commandId: stableCommandId({
              scope,
              requestKey: key,
              operation: "review-findings-record",
            }),
            parentThreadId: parent.thread.id,
            taskId: input.taskId,
            entries: input.entries,
          })
          .pipe(
            Effect.mapError((error) =>
              failure(
                error._tag === "OrchestratorReviewLedgerError" ||
                  error._tag === "OrchestratorCommandPreviouslyRejectedError"
                  ? "invalid_request"
                  : "orchestration_error",
                errorMessage(error),
              ),
            ),
          );
        const updated = yield* loadProjection(parent.thread.id);
        const reviewLedger =
          updated.subagents.find((task) => task.id === input.taskId)?.reviewLedger ?? [];
        return {
          taskId: input.taskId,
          reviewLedger,
          findings: ReviewExport.reviewFindings(reviewLedger),
        };
      }),
    exportReviewFindings: (scope, input) =>
      Effect.gen(function* () {
        // Like goat_thread_read, orchestration credentials may read any available
        // thread in this environment. Include archived parents, exclude deleted ones.
        yield* loadCaller(scope);
        if (!(Date.parse(input.from) < Date.parse(input.to)))
          return yield* failure("invalid_request", "from must precede to.");
        const cursor =
          input.cursor === undefined
            ? undefined
            : yield* ReviewExport.decodeReviewExportCursor(input.cursor).pipe(
                Effect.mapError(() =>
                  failure("invalid_request", "Invalid review findings cursor."),
                ),
              );
        if (cursor !== undefined && (cursor.from !== input.from || cursor.to !== input.to))
          return yield* failure("invalid_request", "Use the cursor with the same date range.");
        const limit = input.limit ?? 100;
        const rows = yield* threadManagement
          .getReviewLedgerEntries({
            from: input.from,
            to: input.to,
            limit: limit + 1,
            ...(cursor === undefined
              ? {}
              : { cursor: { taskId: cursor.taskId, index: cursor.index } }),
          })
          .pipe(Effect.mapError(threadManagementFailure));
        const page = rows.slice(0, limit);
        const lines = yield* Effect.forEach(page, ({ task, index }) => {
          const entry = task.reviewLedger![index]!;
          let latestOutcome: Extract<ReviewLedgerEntry, { readonly kind: "outcome" }> | null = null;
          if (entry.kind === "decision") {
            for (let next = index + 1; next < task.reviewLedger!.length; next++) {
              const candidate = task.reviewLedger![next]!;
              if (candidate.findingId !== entry.findingId) continue;
              if (candidate.kind === "decision") break;
              latestOutcome = candidate;
            }
          }
          const metadata = {
            taskId: task.id,
            threadId: task.threadId,
            role: task.role,
            reviewerModel: task.modelSelection ?? null,
            authorModel: task.parentModelSelection ?? null,
          };
          return ReviewExport.encodeReviewExportEntry(
            entry.kind === "decision"
              ? {
                  ...entry,
                  ...metadata,
                  latestOutcome: latestOutcome?.kind === "outcome" ? latestOutcome : null,
                }
              : { ...entry, ...metadata },
          ).pipe(
            Effect.mapError(() =>
              failure("orchestration_error", "Unable to encode review findings."),
            ),
          );
        });
        const last = page.at(-1);
        return {
          jsonl: lines.length === 0 ? "" : `${lines.join("\n")}\n`,
          ...(rows.length <= limit || last === undefined
            ? {}
            : {
                nextCursor: yield* ReviewExport.encodeReviewExportCursor({
                  from: input.from,
                  to: input.to,
                  taskId: last.task.id,
                  index: last.index,
                }).pipe(
                  Effect.mapError(() =>
                    failure("orchestration_error", "Unable to encode review findings cursor."),
                  ),
                ),
              }),
        };
      }),
    cancelTask: Effect.fn("OrchestratorMcpService.cancelTask")(function* (callerScope, input) {
      const scope = yield* requireThreadScope(callerScope, "task_cancel");
      const current = yield* readTask(scope, input.taskId);
      const key = yield* requestKey(input.clientRequestId);
      const parentProjection = yield* loadProjection(scope.thread.threadId);
      // The user promoted the child to a top-level thread: it is no longer this task's to stop.
      if (
        parentProjection.subagents.some(
          (task) => task.id === input.taskId && task.promotedAt !== undefined,
        )
      ) {
        // Promotion ends a running task as cancelled; a finished one keeps its status.
        return {
          taskId: input.taskId,
          status: isTerminalTaskStatus(current.status) ? current.status : "cancelled",
        } satisfies OrchestratorMcpTaskCancelResult;
      }
      const remoteTask = parentProjection.subagents.find(
        (task) =>
          task.id === input.taskId && task.origin === "app_owned" && task.remote !== undefined,
      );
      if (remoteTask?.remote !== undefined) {
        if (isTerminalTaskStatus(current.status))
          return {
            taskId: input.taskId,
            status: current.status,
          } satisfies OrchestratorMcpTaskCancelResult;
        const cancellation = yield* remoteDispatch
          .cancel(remoteTask.remote.correlationId, authorizeRemoteWrite(scope))
          .pipe(
            Effect.mapError((error) =>
              error instanceof SshRemoteDispatch.SshRemoteDispatchError
                ? hostFailure(error)
                : isOrchestratorMcpFailure(error)
                  ? error
                  : failure("orchestration_error", "Remote cancellation could not be requested."),
            ),
          );
        const refreshed = yield* readTask(scope, input.taskId);
        if (cancellation === "already_settled" && !isTerminalTaskStatus(refreshed.status)) {
          if (remoteTask.runId === null)
            return yield* failure("orchestration_error", "Remote task has no parent run.");
          yield* recordRemoteTaskResult({
            originThreadId: scope.thread.threadId,
            task: { taskId: input.taskId, parentRunId: remoteTask.runId },
            correlationId: remoteTask.remote.correlationId,
            status: "failed",
            summary: "The remote task's thread or report binding is unavailable.",
          }).pipe(
            Effect.provideService(
              ThreadManagementService.ThreadManagementService,
              threadManagement,
            ),
            Effect.mapError(threadManagementFailure),
          );
          const recorded = yield* readTask(scope, input.taskId);
          if (!isTerminalTaskStatus(recorded.status))
            return yield* failure("orchestration_error", "Remote task result was not recorded.");
          return {
            taskId: input.taskId,
            status: recorded.status,
          } satisfies OrchestratorMcpTaskCancelResult;
        }
        return {
          taskId: input.taskId,
          status: isTerminalTaskStatus(refreshed.status) ? refreshed.status : "cancel_requested",
        } satisfies OrchestratorMcpTaskCancelResult;
      }
      if (current.childThreadId === null)
        return yield* failure("task_not_cancellable", "The task has no local child thread.");
      const childThreadId = current.childThreadId;
      yield* ensureCloudCancellationSupported(
        yield* loadProjection(childThreadId),
        "task_not_cancellable",
      );
      // Cancelling stops the child and every task under it, each a write to a
      // thread its user may have raised above the parent's modes since it was
      // delegated. All of them are checked before anything is stopped.
      const assertStoppable = Effect.fn("OrchestratorMcpService.assertStoppable")(function* (
        threadId: ThreadId,
      ): Effect.fn.Return<void, OrchestratorMcpFailure> {
        const shell = yield* threadManagement
          .getThreadShell(threadId)
          .pipe(Effect.mapError(threadManagementFailure));
        if (shell !== null && shell.deletedAt === null) {
          yield* resolveRuntimeMode(parentProjection.thread.runtimeMode, shell.runtimeMode);
          yield* resolveInteractionMode(
            parentProjection.thread.interactionMode,
            shell.interactionMode,
          );
        }
        const { subagents } = yield* threadManagement
          .getThreadRecords(threadId, ["subagents"])
          .pipe(Effect.mapError(threadManagementFailure));
        for (const task of subagents) {
          if (
            task.origin === "app_owned" &&
            task.childThreadId !== null &&
            task.promotedAt === undefined
          ) {
            yield* assertStoppable(task.childThreadId);
          }
        }
      });
      yield* assertStoppable(childThreadId);
      const parentTask = parentProjection.subagents.find(
        (task) => task.id === input.taskId && task.origin === "app_owned",
      );
      const disposeCompletionDelivery = Effect.gen(function* () {
        const child = yield* loadProjection(childThreadId);
        const latestRun =
          ThreadManagementService.latestActiveRun(child) ??
          ThreadManagementService.latestRun(child);
        const cloudTask = child.providerThreads.find(
          (thread) => thread.id === latestRun?.providerThreadId,
        )?.cloudTask;
        // Stop only requests cloud cancellation. Keep the promised parent
        // delivery until the observer records the actual result, including
        // a link-only task whose GOAT observation has already completed.
        if (
          cloudTask !== undefined &&
          (latestRun?.status === "running" ||
            cloudTask.status === "running" ||
            cloudTask.status === "submitting" ||
            parentTask?.completionDelivery?.state === "pending" ||
            parentTask?.completionDelivery?.state === "claimed")
        )
          return;
        return yield* parentTask?.completionDelivery?.state === "disposed"
          ? Effect.void
          : threadManagement
              .dispatch({
                type: "delegated_task.completion-delivery.dispose",
                commandId: stableCommandId({
                  scope,
                  requestKey: key,
                  operation: "cancel-task-completion-delivery",
                }),
                parentThreadId: scope.thread.threadId,
                taskId: input.taskId,
              })
              .pipe(
                Effect.asVoid,
                Effect.mapError((error) =>
                  failure(
                    "orchestration_error",
                    `Unable to dispose delegated task ${input.taskId} completion delivery: ${errorMessage(error)}`,
                  ),
                ),
              );
      });
      const stopChild = Effect.gen(function* () {
        const commandId = stableCommandId({ scope, requestKey: key, operation: "cancel-task" });
        const reason = agentStopReason(input.reason);
        yield* threadManagement
          .dispatch({
            type: "thread.stop",
            commandId,
            threadId: childThreadId,
            stopDelegatedTasks: false,
            reason,
            stopCascadeFrom: scope.thread.threadId,
          })
          .pipe(
            Effect.mapError((error) =>
              failure(
                "task_not_cancellable",
                `Unable to stop delegated task ${input.taskId}: ${errorMessage(error)}${
                  current.cloudTask === undefined
                    ? ""
                    : " Remote work may continue; check cloud tracking and cancellation support before retrying."
                }`,
              ),
            ),
          );
        yield* threadManagement
          .stopDelegatedTasks({
            threadId: childThreadId,
            commandId,
            reason,
            stopCascadeFrom: scope.thread.threadId,
          })
          .pipe(
            Effect.mapError((error) =>
              failure(
                "task_not_cancellable",
                `Stopped delegated task ${input.taskId}, but not every task it delegated: ${errorMessage(error)}`,
              ),
            ),
          );
        const stopped = yield* threadManagement
          .getThreadRecords(childThreadId, ["runs"])
          .pipe(Effect.mapError(threadManagementFailure));
        for (const run of stopped.runs) {
          if (
            run.status !== "queued" ||
            (run.delegatedTaskId !== input.taskId && run.id !== current.childRunId)
          )
            continue;
          // Stop preserves the queue for Resume. Cancelling a task must also
          // remove that task's queued turn, including a previously held one.
          yield* threadManagement
            .dispatch({
              type: "queued-run.cancel",
              commandId: stableCommandId({
                scope,
                requestKey: key,
                operation: `cancel-task-queued-run:${run.id}`,
              }),
              threadId: childThreadId,
              runId: run.id,
            })
            .pipe(Effect.mapError(threadManagementFailure));
        }
      });
      // Checked above; a user raising one of these threads meanwhile is
      // caught again under that thread's lock, which leaves it running.
      const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
      const stopWithinLimit = stopChild.pipe(
        Effect.provideService(DispatchModeLimit, {
          runtimeMode: parentProjection.thread.runtimeMode,
          interactionMode: parentProjection.thread.interactionMode,
          refused,
        }),
        Effect.catch((error) =>
          Effect.flatMap(Ref.get(refused), (refusal) =>
            Effect.fail(
              refusal === undefined
                ? error
                : failure(
                    refusal.mode === "runtime"
                      ? "runtime_mode_escalation_denied"
                      : "interaction_mode_escalation_denied",
                    `Thread ${refusal.threadId} now runs in ${refusal.runtimeMode}/${refusal.interactionMode} mode, above this thread's; its user changed it while the task was being cancelled.`,
                  ),
            ),
          ),
        ),
      );
      // A follow-up that lost its child run (#19002) stays running on the parent, while its
      // status here comes from the child's last run. Stop on the parent cancels that task.
      const cancelOrphan = Effect.gen(function* () {
        if (parentTask?.runId == null || !isOrchestrationV2WorkActive(parentTask.status))
          return false;
        yield* threadManagement
          .dispatch({
            type: "subagent.stop",
            commandId: stableCommandId({
              scope,
              requestKey: key,
              operation: "cancel-task-orphan",
            }),
            threadId: scope.thread.threadId,
            runId: parentTask.runId,
            subagentId: parentTask.id,
          })
          .pipe(Effect.mapError(threadManagementFailure));
        const { subagents } = yield* threadManagement
          .getThreadRecords(scope.thread.threadId, ["subagents"])
          .pipe(Effect.mapError(threadManagementFailure));
        return subagents.some((task) => task.id === input.taskId && task.status === "cancelled");
      });
      if (isTerminalTaskStatus(current.status)) {
        // The child can still run work for another turn, so it is stopped either way.
        yield* stopWithinLimit;
        const cancelled = yield* cancelOrphan;
        yield* disposeCompletionDelivery;
        return {
          taskId: input.taskId,
          status: cancelled ? "cancelled" : current.status,
        } satisfies OrchestratorMcpTaskCancelResult;
      }
      const child = yield* loadProjection(childThreadId);
      if (
        current.workState !== "waiting_for_children" &&
        ThreadManagementService.latestActiveRun(child) === undefined &&
        !child.runs.some(
          (run) =>
            run.status === "queued" &&
            (run.delegatedTaskId === input.taskId || run.id === current.childRunId),
        )
      ) {
        if (yield* cancelOrphan) return { taskId: input.taskId, status: "cancelled" };
        return yield* failure(
          "task_not_cancellable",
          `Delegated task ${input.taskId} has no interruptible child run.`,
        );
      }
      yield* stopWithinLimit;
      yield* disposeCompletionDelivery.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestrator-mcp.cancel-task.delivery-dispose-failed", {
            taskId: input.taskId,
            cause,
          }),
        ),
      );
      return {
        taskId: input.taskId,
        status: "cancel_requested",
      };
    }),
    createThreads: Effect.fn("OrchestratorMcpService.createThreads")(
      function* (callerScope, input) {
        const { scope, parent } = yield* loadThreadCaller(callerScope, "create_threads");
        const parentRun = ThreadManagementService.latestActiveRun(parent);
        if (
          parentRun === undefined ||
          parentRun.rootNodeId === null ||
          parentRun.providerInstanceId !== scope.thread.providerInstanceId
        ) {
          return yield* failure(
            "parent_not_active",
            "Thread creation requires an active run owned by this MCP provider session.",
          );
        }
        if ((yield* permissions.resolve(scope, parent.thread.runtimeMode)).enabled)
          return yield* failure(
            "capability_denied",
            `With goatclaw enabled, use ${goatCallText("thread.launch")} or ${goatCallText("task.create")} so every child inherits its permission profile.`,
          );
        const parentNodeId = parentRun.rootNodeId;
        const providers = yield* loadProviders;
        const key = yield* requestKey(input.clientRequestId);
        const created = yield* Effect.forEach(
          input.threads,
          (request, index) =>
            Effect.gen(function* () {
              const commandId = stableCommandId({
                scope,
                requestKey: key,
                operation: "create-thread",
                index,
              });
              const threadId = stableThreadId({
                scope,
                requestKey: key,
                index,
              });
              const isRetryOfAcceptedCreation = yield* threadManagement.hasReceipt(commandId);
              const committedThread = isRetryOfAcceptedCreation
                ? yield* threadManagement
                    .getThreadShell(threadId)
                    .pipe(Effect.mapError(threadManagementFailure))
                : null;
              const target = yield* resolveTargetRechecking({
                parent,
                target:
                  committedThread === null
                    ? request.target
                    : {
                        ...request.target,
                        providerInstanceId: committedThread.modelSelection.instanceId,
                      },
                providers,
                skipProjectEnablementFilter: isRetryOfAcceptedCreation,
              });
              const runtimeMode = yield* resolveRuntimeMode(
                parent.thread.runtimeMode,
                request.runtimeMode,
                target,
              );
              const interactionMode = yield* resolveInteractionMode(
                parent.thread.interactionMode,
                request.interactionMode,
              );
              yield* assertTargetEnabledForProject(parent, commandId, target);
              if (request.prompt !== undefined && !isRetryOfAcceptedCreation) {
                yield* preflightCloudLaunch(
                  scope,
                  parent.thread.projectId,
                  target.modelSelection,
                  parent.thread.worktreePath,
                  parent.thread.branch,
                );
              }
              const title = threadTitle({
                parentTitle: parent.thread.title,
                prompt: request.prompt,
                title: request.title,
                index,
              });
              yield* threadManagement
                .dispatch({
                  type: "thread.create",
                  createdBy: "agent",
                  creationSource: "mcp",
                  launchedBy: {
                    kind: "launch",
                    threadId: scope.thread.threadId,
                    environmentId: null,
                    environmentLabel: null,
                    threadTitle: parent.thread.title,
                    via: "create_threads",
                  },
                  commandId,
                  threadId,
                  projectId: parent.thread.projectId,
                  title,
                  modelSelection: target.modelSelection,
                  runtimeMode,
                  interactionMode,
                  branch: parent.thread.branch,
                  worktreePath: parent.thread.worktreePath,
                })
                .pipe(
                  Effect.mapError((error) =>
                    failure(
                      "orchestration_error",
                      `Unable to create thread ${index + 1}: ${errorMessage(error)}`,
                    ),
                  ),
                );
              // A receipt can appear after target resolution; use the committed thread's selection.
              const resolvedModelSelection = (yield* threadManagement
                .getThreadRecords(threadId, [])
                .pipe(Effect.mapError(threadManagementFailure))).thread.modelSelection;
              if (request.prompt !== undefined) {
                yield* threadManagement
                  .dispatch({
                    type: "message.dispatch",
                    createdBy: "agent",
                    creationSource: "mcp",
                    commandId: stableCommandId({
                      scope,
                      requestKey: key,
                      operation: "dispatch-thread",
                      index,
                    }),
                    threadId,
                    senderThreadId: scope.thread.threadId,
                    messageId: stableMessageId({
                      scope,
                      requestKey: key,
                      index,
                    }),
                    text: request.prompt,
                    attachments: [],
                    modelSelection: resolvedModelSelection,
                    dispatchMode: { type: "start_immediately" },
                  })
                  .pipe(
                    Effect.mapError((error) =>
                      error._tag === "ThreadManagementProviderInstanceDisabledError"
                        ? threadManagementFailure(error)
                        : failure(
                            "orchestration_error",
                            `Unable to start thread ${index + 1}: ${errorMessage(error)}`,
                          ),
                    ),
                  );
              }
              const projection = yield* loadProjection(threadId);
              const run = projection.runs.at(-1);
              yield* threadManagement
                .dispatch({
                  type: "thread.created.record",
                  commandId: stableCommandId({
                    scope,
                    requestKey: key,
                    operation: "record-created-thread",
                    index,
                  }),
                  parentThreadId: scope.thread.threadId,
                  parentRunId: parentRun.id,
                  parentNodeId,
                  targetThreadId: threadId,
                  targetRunId: run?.id ?? null,
                })
                .pipe(
                  Effect.mapError((error) =>
                    failure(
                      "orchestration_error",
                      `Unable to record thread ${index + 1} in the parent timeline: ${errorMessage(error)}`,
                    ),
                  ),
                );
              return {
                threadId,
                runId: run?.id ?? null,
                status: run?.status ?? "idle",
                title: projection.thread.title,
                createdBy: projection.thread.createdBy,
                creationSource: projection.thread.creationSource,
                providerInstanceId: resolvedModelSelection.instanceId,
                model: resolvedModelSelection.model,
              } satisfies OrchestratorMcpCreatedThread;
            }),
          { concurrency: 1 },
        );
        return { threads: created };
      },
    ),
    listThreads: Effect.fn("OrchestratorMcpService.listThreads")(function* (scope, input) {
      const { parent } = yield* loadCaller(scope);
      if (input.host !== undefined || input.allHosts === true) {
        // HostThreadsMcpService routes these; reaching here is a wiring bug, not a local list.
        return yield* failure("invalid_request", "host and allHosts are not handled here.");
      }
      if (input.allProjects === true && input.projectId !== undefined) {
        return yield* failure("invalid_request", "Pass either projectId or allProjects, not both.");
      }
      const projectId =
        input.allProjects === true
          ? undefined
          : yield* resolveProjectTarget(parent, input.projectId);
      const projectThreads = yield* threadManagement
        .listProjectThreads({
          projectId,
          includeSubagents: input.includeSubagents !== false,
        })
        .pipe(
          Effect.mapError((error) =>
            failure("orchestration_error", `Unable to list threads: ${errorMessage(error)}`),
          ),
        );
      const nowMs = yield* Clock.currentTimeMillis;
      const statuses = input.statuses === undefined ? null : new Set(input.statuses);
      const titleContains = input.titleContains?.toLocaleLowerCase();
      const filtered = projectThreads
        .filter(
          (thread) => statuses === null || statuses.has(thread.activityRunStatus ?? thread.status),
        )
        .filter(
          (thread) =>
            input.settled === undefined || threadSettlement(thread).settled === input.settled,
        )
        .filter(
          (thread) => input.snoozed === undefined || isSnoozed(thread, nowMs) === input.snoozed,
        )
        .filter(
          (thread) =>
            titleContains === undefined || thread.title.toLocaleLowerCase().includes(titleContains),
        );
      const cursor = input.cursor ?? 0;
      const limit = input.limit ?? DEFAULT_THREAD_LIST_LIMIT;
      const page = filtered.slice(cursor, cursor + limit);
      const nextCursor = cursor + page.length < filtered.length ? cursor + page.length : null;
      return {
        projectId: projectId ?? null,
        currentThreadId: parent?.thread.id ?? null,
        threads: page.map((shell) => listItemFromShell(shell, nowMs)),
        nextCursor,
        total: filtered.length,
      } satisfies OrchestratorMcpThreadListResult;
    }),
    readThread: Effect.fn("OrchestratorMcpService.readThread")(function* (scope, input) {
      const { parent, target, shell } = yield* loadReadableThread(scope, input.threadId);
      const view = input.view ?? "messages";
      const afterPosition = input.afterPosition ?? -1;
      const limit = input.limit ?? DEFAULT_THREAD_READ_LIMIT;
      const maxChars = input.maxCharsPerItem ?? DEFAULT_THREAD_ITEM_MAX_CHARS;
      const timeline = yield* threadManagement
        .getTimelinePage(input.threadId, {
          afterPosition,
          limit,
          view,
          ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
        })
        .pipe(Effect.mapError(threadManagementFailure));
      const page = timeline.items;
      const taskSources = [
        ...new Set(
          page.filter((row) => row.item.type === "subagent").map((row) => row.sourceThreadId),
        ),
      ];
      const tasksByThreadId = new Map(
        yield* Effect.forEach(taskSources, (threadId) =>
          threadManagement.getThreadRecords(threadId, ["subagents"]).pipe(
            Effect.map((records) => [threadId, records.subagents] as const),
            Effect.mapError(threadManagementFailure),
          ),
        ),
      );
      const messageIdsByThread = new Map<ThreadId, Array<MessageId>>();
      for (const row of page) {
        if (row.item.type !== "user_message" && row.item.type !== "assistant_message") continue;
        const ids = messageIdsByThread.get(row.sourceThreadId) ?? [];
        ids.push(row.item.messageId);
        messageIdsByThread.set(row.sourceThreadId, ids);
      }
      const sourceMessages = yield* Effect.forEach(
        [...messageIdsByThread],
        ([threadId, messageIds]) =>
          threadManagement.getThreadRecords(threadId, ["messages"], { messageIds }).pipe(
            Effect.map((records) => [threadId, records.messages] as const),
            Effect.mapError(threadManagementFailure),
          ),
        { concurrency: 1 },
      );
      const messagesByThreadId = new Map(sourceMessages);
      const returnedRunIds = new Set(
        page.filter((row) => row.sourceThreadId === target.thread.id).map((row) => row.item.runId),
      );
      const tasks =
        parent === undefined ? [] : directAppOwnedChildTasks(parent, target, returnedRunIds);
      if (
        parent !== undefined &&
        scope.thread !== undefined &&
        tasks.length > 0 &&
        (input.textOffset ?? 0) === 0
      ) {
        for (const task of tasks) {
          const transfer = taskResultTransfer(parent, target, task);
          const resultRunId = transfer?.sourcePoint.runId ?? delegatedTaskRun(target, task)?.id;
          const resultRunIds = resultRunId === undefined ? [] : [resultRunId];
          const resultRecords = yield* threadManagement
            .getThreadRecords(target.thread.id, ["messages", "turnItems"], {
              messageRoles: ["assistant"],
              messageRunIds: resultRunIds,
              turnItemRunIds: resultRunIds,
              turnItemTypes: ["assistant_message", "error"],
            })
            .pipe(Effect.mapError(threadManagementFailure));
          if (
            pageIncludesTerminalTaskResult({
              parent,
              page,
              task,
              target: { ...target, ...resultRecords },
              maxChars,
            })
          ) {
            yield* readTask(
              scope as McpThreadInvocationScope,
              task.id,
              false,
              true,
              "thread-read-acknowledge",
            );
          }
        }
      }
      const cloudTask = cloudTaskForRun(
        target.providerThreads ?? [],
        target.runs.find((run) => run.id === (shell.activeRunId ?? shell.latestRunId)),
      );
      return {
        ...(cloudTask === undefined ? {} : { cloudTask }),
        thread: threadDetail(target, timeline.totalItems, shell, yield* Clock.currentTimeMillis),
        recentRuns: target.runs
          .toSorted((left, right) => right.ordinal - left.ordinal)
          .slice(0, input.runLimit ?? DEFAULT_THREAD_RUN_LIMIT)
          .map(threadRun),
        items: page.map((row) =>
          timelineItem({
            row,
            maxChars,
            messagesByThreadId,
            tasksByThreadId,
            ...(input.itemId === undefined ? {} : { textOffset: input.textOffset ?? 0 }),
          }),
        ),
        nextPosition: page.at(-1)?.position ?? null,
        hasMore: timeline.hasMore,
      } satisfies OrchestratorMcpThreadReadResult;
    }),
    sendToThread: Effect.fn("OrchestratorMcpService.sendToThread")(function* (scope, input) {
      const { parent, limits, target } = yield* loadScopedThread(scope, input.threadId);
      yield* assertLiveCallerForOtherThread(scope, parent, target);
      yield* resolveRuntimeMode(limits.runtimeMode, target.thread.runtimeMode);
      yield* resolveInteractionMode(limits.interactionMode, target.thread.interactionMode);

      const mode = ThreadManagementService.threadSendMode({
        requested: input.mode,
        senderThreadId: parent?.thread.id,
        targetThreadId: input.threadId,
      });
      const key = yield* requestKey(input.clientRequestId);
      const messageId = stableOperationMessageId({
        scope,
        requestKey: key,
        operation: "thread-send",
      });
      // Another GOAT forwarding a profiled caller's send: this machine enforces that ceiling too.
      const forwarded = input.permissionProfileCeiling;
      if (scope.thread?.threadId !== input.threadId)
        yield* permissions.require(scope, "threads.launch", {
          runtimeMode: limits.runtimeMode,
          forwarded,
        });
      const effective = yield* permissions.resolve(scope, limits.runtimeMode, forwarded);
      if (effective.enabled && scope.thread?.threadId !== input.threadId) {
        yield* resolveRuntimeMode(effective.runtimeMode, target.thread.runtimeMode);
        yield* permissions.assertTarget(
          scope,
          input.threadId,
          limits.runtimeMode,
          target.thread.runtimeMode,
          forwarded,
        );
      }
      const admissionId = stableCommandId({ scope, requestKey: key, operation: "thread-send" });
      const admitted =
        scope.thread?.threadId === input.threadId ||
        target.runs.some(ThreadManagementService.isActiveRun)
          ? null
          : yield* permissions.claim(scope, {
              id: admissionId,
              childThreadId: input.threadId,
              runtimeMode: target.thread.runtimeMode,
              forwarded,
            });
      const result = yield* threadManagement
        .sendToThread({
          projectId: target.thread.projectId,
          commandId: admissionId,
          threadId: input.threadId,
          ...(parent === undefined ? {} : { senderThreadId: parent.thread.id }),
          messageId,
          ...withTurnCapabilities({ text: input.message }, input.capabilities ?? []),
          attachments: [],
          mode,
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(
          Effect.mapError((error) =>
            isThreadManagementError(error)
              ? threadManagementFailure(error)
              : failure(
                  "orchestration_error",
                  `Unable to send to thread ${input.threadId}: ${userFacingDispatchErrorMessage(error) ?? errorMessage(error)}`,
                ),
          ),
        );
      if (admitted?.enabled) yield* permissions.complete(admissionId);
      return {
        threadId: input.threadId,
        messageId,
        runId: result.run.id,
        ...(result.run.delegatedTaskId === undefined ? {} : { taskId: result.run.delegatedTaskId }),
        status: result.run.status,
        delivery: result.delivery,
      } satisfies OrchestratorMcpThreadSendDelivered;
    }),
    waitForThread: Effect.fn("OrchestratorMcpService.waitForThread")(function* (scope, input) {
      const { target } = yield* loadScopedThread(scope, input.threadId);
      const result = yield* threadManagement
        .waitForThread({
          projectId: target.thread.projectId,
          threadId: input.threadId,
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          ...(input.ignoreRequestIds === undefined
            ? {}
            : { ignoreRequestIds: input.ignoreRequestIds }),
          timeoutMs: Math.min(
            MAX_WAIT_TIMEOUT_MS,
            Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
          ),
        })
        .pipe(Effect.mapError(threadManagementFailure));
      return {
        threadId: input.threadId,
        runId: result.run?.id ?? null,
        status: result.run === null ? "idle" : runOutcome(result.run),
        timedOut: result.timedOut,
        ...(result.pendingRequestIds === undefined
          ? {}
          : { pendingRequestIds: result.pendingRequestIds }),
        ...(result.run?.completedAt == null
          ? {}
          : { completedAt: DateTime.formatIso(result.run.completedAt) }),
      } satisfies OrchestratorMcpThreadWaitResult;
    }),
    threadStatus: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        const shell = yield* threadManagement
          .getThreadShell(input.threadId)
          .pipe(Effect.mapError(threadManagementFailure));
        if (shell === null || shell.deletedAt !== null) {
          return yield* failure(
            "thread_not_found",
            `Thread ${input.threadId} is no longer available.`,
          );
        }
        const runIds = [
          ...new Set([shell.activeRunId, shell.latestRunId].filter((id) => id !== null)),
        ];
        const records = yield* threadManagement
          .getThreadRecords(input.threadId, ["runs", "turnItems", "providerThreads"], {
            runIds,
            turnItemRunIds: runIds,
            turnItemTypes: ["user_message", "assistant_message", "error"],
          })
          .pipe(Effect.mapError(threadManagementFailure));
        const cloudTask = cloudTaskForRun(
          records.providerThreads ?? [],
          records.runs.find((run) => run.id === (shell.activeRunId ?? shell.latestRunId)),
        );
        return {
          ...statusFromShell(shell, records.runs, records.turnItems),
          ...(cloudTask === undefined ? {} : { cloudTask }),
        };
      }),
    interruptThread: Effect.fn("OrchestratorMcpService.interruptThread")(function* (scope, input) {
      const { parent, limits, target } = yield* loadScopedThread(scope, input.threadId);
      yield* assertLiveCallerForOtherThread(scope, parent, target);
      yield* resolveRuntimeMode(limits.runtimeMode, target.thread.runtimeMode);
      yield* resolveInteractionMode(limits.interactionMode, target.thread.interactionMode);
      yield* ensureCloudCancellationSupported(target, "invalid_request", input.runId);
      const key = yield* requestKey(input.clientRequestId);
      if (input.stopCascade === true) {
        if (input.runId !== undefined)
          return yield* failure(
            "invalid_request",
            "stopCascade stops the whole thread; omit runId.",
          );
        const stopFailure = (error: unknown) =>
          failure(
            "orchestration_error",
            `Unable to stop thread ${input.threadId}: ${errorMessage(error)}`,
          );
        const { runs } = yield* threadManagement
          .getThreadRecords(input.threadId, ["runs"])
          .pipe(Effect.mapError(threadManagementFailure));
        const live = runs.findLast(
          (run) =>
            run.status !== "queued" && !ThreadManagementService.isTerminalRunStatus(run.status),
        );
        const commandId = stableCommandId({ scope, requestKey: key, operation: "thread-stop" });
        const reason = agentStopReason(input.reason);
        yield* threadManagement
          .dispatch({
            type: "thread.stop",
            commandId,
            threadId: input.threadId,
            stopDelegatedTasks: false,
            reason,
          })
          .pipe(Effect.mapError(stopFailure));
        yield* threadManagement
          .stopDelegatedTasks({ threadId: input.threadId, commandId, reason })
          .pipe(Effect.mapError(stopFailure));
        return {
          threadId: input.threadId,
          runId: live?.id ?? null,
          status: live === undefined ? "no_active_run" : "interrupt_requested",
          stopCascade: true,
        } satisfies OrchestratorMcpThreadInterruptResult;
      }
      const result = yield* threadManagement
        .interruptThread({
          projectId: target.thread.projectId,
          commandId: stableCommandId({
            scope,
            requestKey: key,
            operation: "thread-interrupt",
          }),
          threadId: input.threadId,
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          reason: agentStopReason(input.reason),
        })
        .pipe(
          Effect.mapError((error) =>
            isThreadManagementError(error)
              ? threadManagementFailure(error)
              : failure(
                  "orchestration_error",
                  `Unable to interrupt thread ${input.threadId}: ${errorMessage(error)}`,
                ),
          ),
        );
      if (result.type === "no_active_run") {
        return {
          threadId: input.threadId,
          runId: null,
          status: "no_active_run",
        } satisfies OrchestratorMcpThreadInterruptResult;
      }
      return {
        threadId: input.threadId,
        runId: result.run.id,
        status: result.type === "already_terminal" ? result.run.status : "interrupt_requested",
      } satisfies OrchestratorMcpThreadInterruptResult;
    }),
    retryThread: Effect.fn("OrchestratorMcpService.retryThread")(function* (scope, input) {
      const { parent, limits, target } = yield* loadScopedThread(scope, input.threadId);
      yield* assertLiveCallerForOtherThread(scope, parent, target);
      yield* resolveRuntimeMode(limits.runtimeMode, target.thread.runtimeMode);
      yield* resolveInteractionMode(limits.interactionMode, target.thread.interactionMode);
      const key = yield* requestKey(input.clientRequestId);
      const run =
        input.runId === undefined
          ? target.runs.toSorted((left, right) => left.ordinal - right.ordinal).at(-1)
          : target.runs.find((candidate) => candidate.id === input.runId);
      if (run === undefined)
        return yield* failure("run_not_found", `Thread ${input.threadId} has no run to retry.`);
      if (run.status === "preparing")
        return { threadId: input.threadId, runId: run.id, status: "preparing" as const };
      if (run.status !== "failed" || run.workspacePreparation === undefined)
        return yield* failure(
          "invalid_request",
          `Run ${run.id} did not fail while preparing its workspace, so there is nothing to retry. Read the thread and send it a new message with ${goatCallText("thread.send")} instead.`,
        );
      yield* threadLaunch
        .retryPreparation({
          commandId: stableCommandId({ scope, requestKey: key, operation: "thread-retry" }),
          threadId: input.threadId,
          runId: run.id,
        })
        .pipe(
          Effect.mapError((error) =>
            failure(
              "orchestration_error",
              `Unable to retry run ${run.id} of thread ${input.threadId}: ${errorMessage(error)}`,
            ),
          ),
        );
      return { threadId: input.threadId, runId: run.id, status: "preparing" as const };
    }),
  });
});

export const layer: Layer.Layer<
  OrchestratorMcpService,
  never,
  | Crypto.Crypto
  | ThreadManagementService.ThreadManagementService
  | ThreadLaunchService.ThreadLaunchService
  | GitVcsDriver.GitVcsDriver
  | ProviderRegistry.ProviderRegistry
  | ProviderAdapterRegistry.ProviderAdapterRegistryV2
  | ScheduledTaskService.ScheduledTaskService
  | ProjectService.ProjectService
  | SecretRequests.SecretRequests
  | RemoteDispatchCoordinator.RemoteDispatchCoordinator
  | FleetSync.GoatclawFleetSync
  | SshRemoteDispatch.SshRemoteDispatch
  | ServerSettings.ServerSettingsService
> = Layer.effect(OrchestratorMcpService, make).pipe(Layer.provide(Profiles.layer));

/** OAuth and managed callers use the same live grant port, never thread modes as authority. */
export const captureMcpTaskMemoryGrantCeiling = (scope: McpInvocationScope, readOnly: boolean) =>
  captureRpcMemoryGrantCeiling({
    grantedScopes: scope.grantedScopes,
    reauthorize: scope.reauthorize,
    readOnly: readOnly || scope.client?.access === "read-only",
  });
