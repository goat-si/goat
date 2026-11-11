import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  Project,
  RuntimeRequestId,
  ThreadId,
} from "@goat/contracts";
import {
  isPendingApprovalRequest,
  isPendingUserInputRequest,
  isProviderNativeSubagentThread,
  isSideChatThread,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";

import { backgroundWorkHoldsCompletion } from "./orchestrationV2PendingBackgroundWork.ts";

export type AgentAwarenessPhase =
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "stale";

export interface SubagentRequestAwareness {
  readonly childId: ThreadId;
  readonly requestId: RuntimeRequestId;
  readonly phase: "waiting_for_approval" | "waiting_for_input";
  readonly createdAt: DateTime.Utc;
}

export function subagentRequestAwareness(
  thread: Pick<
    OrchestrationV2ThreadShell,
    "id" | "lineage" | "creationSource" | "pendingRuntimeRequest" | "activityRunStatus" | "status"
  >,
): SubagentRequestAwareness | null {
  const request = thread.pendingRuntimeRequest;
  if (
    thread.lineage.relationshipToParent !== "subagent" ||
    isProviderNativeSubagentThread(thread) ||
    request === null ||
    request.kind === "auth_refresh"
  )
    return null;
  const status = thread.activityRunStatus ?? thread.status;
  if (
    request.kind === "user_input" &&
    request.blocking === false &&
    (status === "preparing" || status === "starting" || status === "running")
  )
    return null;
  return {
    childId: thread.id,
    requestId: request.id,
    phase: request.kind === "user_input" ? "waiting_for_input" : "waiting_for_approval",
    createdAt: request.createdAt,
  };
}

export interface AgentAwarenessState {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly phase: AgentAwarenessPhase;
  readonly headline: string;
  readonly detail?: string;
  readonly modelTitle: string;
  readonly updatedAt: string;
  readonly deepLink: string;
}

function buildAgentAwarenessDeepLink(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): string {
  return `/threads/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
}

export interface ProjectThreadAwarenessV2Input {
  readonly environmentId: EnvironmentId;
  readonly project: Pick<Project, "title">;
  readonly pendingSubagentRequest?: SubagentRequestAwareness | null;
  readonly thread: Pick<
    OrchestrationV2ThreadShell,
    | "activityRunStatus"
    | "id"
    | "lineage"
    | "latestRunStopRequested"
    | "latestRunCompletionNotification"
    | "modelSelection"
    | "pendingBackgroundTasks"
    | "pendingRuntimeRequest"
    | "sideChatOf"
    | "settledOverride"
    | "status"
    | "title"
    | "updatedAt"
  >;
}

export function projectThreadAwarenessV2(
  input: ProjectThreadAwarenessV2Input,
): AgentAwarenessState | null {
  const { environmentId, project, thread } = input;
  if (thread.lineage.relationshipToParent === "subagent" || isSideChatThread(thread)) return null;
  const ownPhase = resolveThreadAwarenessPhaseV2(thread);
  const childRequest = input.pendingSubagentRequest ?? null;
  const childDrivesWait =
    childRequest !== null &&
    ownPhase !== "waiting_for_approval" &&
    ownPhase !== "waiting_for_input";
  const phase = childDrivesWait ? childRequest.phase : ownPhase;
  if (phase === null) {
    return null;
  }
  if (phase === "completed" && thread.latestRunStopRequested === true) return null;
  if (phase === "completed" && thread.latestRunCompletionNotification === "silent") return null;
  // Resolve the phase first so live or waiting work stays visible after settlement.
  if (
    thread.settledOverride === "settled" &&
    (phase === "completed" || phase === "failed") &&
    !backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])
  ) {
    return null;
  }
  const detail =
    phase === "completed"
      ? "Review the completed task."
      : phase === "failed"
        ? "The agent run failed."
        : phase === "waiting_for_approval"
          ? thread.pendingRuntimeRequest?.handoff?.title
          : undefined;
  return {
    environmentId,
    threadId: thread.id,
    projectTitle: project.title,
    threadTitle: thread.title,
    phase,
    headline: headlineForPhase(phase),
    ...(detail === undefined ? {} : { detail }),
    modelTitle: thread.modelSelection.model,
    updatedAt: DateTime.formatIso(childDrivesWait ? childRequest.createdAt : thread.updatedAt),
    deepLink: buildAgentAwarenessDeepLink({ environmentId, threadId: thread.id }),
  };
}

function resolveThreadAwarenessPhaseV2(
  thread: ProjectThreadAwarenessV2Input["thread"],
): AgentAwarenessPhase | null {
  const runStatus = thread.activityRunStatus ?? thread.status;
  if (
    isPendingUserInputRequest(thread.pendingRuntimeRequest) &&
    (thread.pendingRuntimeRequest?.blocking !== false ||
      !(runStatus === "preparing" || runStatus === "starting" || runStatus === "running"))
  ) {
    return "waiting_for_input";
  }
  if (isPendingApprovalRequest(thread.pendingRuntimeRequest)) {
    return "waiting_for_approval";
  }
  switch (runStatus) {
    case "preparing":
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "completed":
      return backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])
        ? "running"
        : "completed";
    case "failed":
      return "failed";
    case "idle":
    case "queued":
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return null;
  }
}

function headlineForPhase(phase: AgentAwarenessPhase): string {
  switch (phase) {
    case "starting":
      return "Starting agent";
    case "running":
      return "Agent is working";
    case "waiting_for_approval":
      return "Approval needed";
    case "waiting_for_input":
      return "Waiting for input";
    case "completed":
      return "Agent finished";
    case "failed":
      return "Agent failed";
    case "stale":
      return "Update delayed";
  }
}
