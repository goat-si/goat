import {
  OrchestratorMcpFailure,
  ThreadId,
  VcsListRefsInput,
  VcsListRefsResult,
  WorktreeMcpCleanupInput,
  WorktreeMcpCleanupResult,
  WorktreeMcpFailure,
  WorktreeMcpHandoffInput,
  WorktreeMcpHandoffResult,
  WorktreeMcpInventoryInput,
  WorktreeMcpInventoryResult,
  WorktreeMcpRemoveInput,
  WorktreeMcpRemoveResult,
  WorktreeMcpStatusResult,
} from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";

import * as HostThreadsMcpService from "../../HostThreadsMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WorktreeInventoryService from "../../WorktreeInventoryService.ts";
import * as WorktreeMcpService from "../../WorktreeMcpService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  WorktreeMcpService.WorktreeMcpService,
];

const WorktreeToolFailure = Schema.Union([WorktreeMcpFailure, OrchestratorMcpFailure]);

const WorktreeHandoffTool = Tool.make(agentSurfaceRegistry["worktree.handoff"].name, {
  description: agentSurfaceRegistry["worktree.handoff"].description,
  parameters: WorktreeMcpHandoffInput,
  success: WorktreeMcpHandoffResult,
  failure: WorktreeToolFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["worktree.handoff"]));

const WorktreeStatusTool = Tool.make(agentSurfaceRegistry["worktree.status"].name, {
  description: agentSurfaceRegistry["worktree.status"].description,
  // No `parameters`: Tool.make defaults to Tool.EmptyParams, which serializes
  // to a top-level `type: "object"` JSON Schema. An explicit empty
  // Schema.Struct({}) serializes to `anyOf: [object, array]`, which is not a
  // valid MCP tool input schema and makes clients reject the whole server.
  success: WorktreeMcpStatusResult,
  failure: WorktreeToolFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["worktree.status"]));

const WorktreeListTool = Tool.make(agentSurfaceRegistry["worktree.list"].name, {
  description: agentSurfaceRegistry["worktree.list"].description,
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    query: VcsListRefsInput.fields.query,
    cursor: VcsListRefsInput.fields.cursor,
    limit: VcsListRefsInput.fields.limit,
    refKind: VcsListRefsInput.fields.refKind,
    includeMatchingRemoteRefs: VcsListRefsInput.fields.includeMatchingRemoteRefs,
  }),
  success: VcsListRefsResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    GitWorkflowService.GitWorkflowService,
  ],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["worktree.list"]));

const worktreeHostDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  WorktreeInventoryService.WorktreeInventoryService,
  HostThreadsMcpService.HostThreadsMcpService,
];

const WorktreeInventoryTool = Tool.make(agentSurfaceRegistry["worktree.inventory"].name, {
  description: agentSurfaceRegistry["worktree.inventory"].description,
  parameters: WorktreeMcpInventoryInput,
  success: WorktreeMcpInventoryResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: worktreeHostDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["worktree.inventory"]));

const WorktreeRemoveTool = Tool.make(agentSurfaceRegistry["worktree.remove"].name, {
  description: agentSurfaceRegistry["worktree.remove"].description,
  parameters: WorktreeMcpRemoveInput,
  success: WorktreeMcpRemoveResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: worktreeHostDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["worktree.remove"]));

const WorktreeCleanupTool = Tool.make(agentSurfaceRegistry["worktree.cleanup"].name, {
  description: agentSurfaceRegistry["worktree.cleanup"].description,
  parameters: WorktreeMcpCleanupInput,
  success: WorktreeMcpCleanupResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: worktreeHostDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["worktree.cleanup"]));

export const WorktreeToolkit = Toolkit.make(
  WorktreeHandoffTool,
  WorktreeStatusTool,
  WorktreeListTool,
  WorktreeInventoryTool,
  WorktreeRemoveTool,
  WorktreeCleanupTool,
);
