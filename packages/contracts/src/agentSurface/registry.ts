import { attachmentEntries } from "./entries/attachment.ts";
import { channelEntries } from "./entries/channel.ts";
import { cloudAgentEntries } from "./entries/cloud_agent.ts";
import { cloudMachineEntries } from "./entries/cloud_machine.ts";
import { computerUseEntries } from "./entries/computer_use.ts";
import { connectionEntries } from "./entries/connection.ts";
import { decisionEntries } from "./entries/decision.ts";
import { deviceEntries } from "./entries/device.ts";
import { environmentEntries } from "./entries/environment.ts";
import { fallbackChainEntries } from "./entries/fallback_chain.ts";
import { goalEntries } from "./entries/goal.ts";
import { handoffEntries } from "./entries/handoff.ts";
import { hostEntries } from "./entries/host.ts";
import { hostLinkEntries } from "./entries/host_link.ts";
import { htmlEntries } from "./entries/html.ts";
import { hubEntries } from "./entries/hub.ts";
import { memoryEntries } from "./entries/memory.ts";
import { noteEntries } from "./entries/note.ts";
import { operationEntries } from "./entries/operation.ts";
import { originEntries } from "./entries/origin.ts";
import { pendingRequestEntries } from "./entries/pending_request.ts";
import { permissionProfileEntries } from "./entries/permission_profile.ts";
import { previewEntries } from "./entries/preview.ts";
import { projectEntries } from "./entries/project.ts";
import { providerEntries } from "./entries/provider.ts";
import { pullRequestEntries } from "./entries/pull_request.ts";
import { pullRequestGuideEntries } from "./entries/pull_request_guide.ts";
import { queueEntries } from "./entries/queue.ts";
import { repositoryEntries } from "./entries/repository.ts";
import { reviewFindingsEntries } from "./entries/review_findings.ts";
import { scheduleEntries } from "./entries/schedule.ts";
import { schedulerEntries } from "./entries/scheduler.ts";
import { sshEntries } from "./entries/ssh.ts";
import { surfaceEntries } from "./entries/surface.ts";
import { taskEntries } from "./entries/task.ts";
import { threadEntries } from "./entries/thread.ts";
import { workflowEntries } from "./entries/workflow.ts";
import { worktreeEntries } from "./entries/worktree.ts";

export type {
  AgentSurfaceCapability,
  AgentSurfaceEffect,
  AgentSurfaceEntry,
  AgentSurfaceExample,
  CapabilityDeclaration,
} from "./types.ts";

/** Every entry, one file per resource under entries/. */
export const agentSurfaceRegistry = {
  ...decisionEntries,
  ...permissionProfileEntries,
  ...attachmentEntries,
  ...threadEntries,
  ...channelEntries,
  ...computerUseEntries,
  ...connectionEntries,
  ...deviceEntries,
  ...environmentEntries,
  ...goalEntries,
  ...hubEntries,
  ...hostEntries,
  ...repositoryEntries,
  ...schedulerEntries,
  ...fallbackChainEntries,
  ...htmlEntries,
  ...memoryEntries,
  ...providerEntries,
  ...taskEntries,
  ...reviewFindingsEntries,
  ...workflowEntries,
  ...scheduleEntries,
  ...handoffEntries,
  ...previewEntries,
  ...projectEntries,
  ...pullRequestEntries,
  ...pullRequestGuideEntries,
  ...originEntries,
  ...sshEntries,
  ...hostLinkEntries,
  ...cloudMachineEntries,
  ...pendingRequestEntries,
  ...queueEntries,
  ...worktreeEntries,
  ...cloudAgentEntries,
  ...noteEntries,
  ...surfaceEntries,
  ...operationEntries,
} as const;

export type AgentSurfacePath = keyof typeof agentSurfaceRegistry;
export type AgentSurfaceRegistryEntry = (typeof agentSurfaceRegistry)[AgentSurfacePath];
