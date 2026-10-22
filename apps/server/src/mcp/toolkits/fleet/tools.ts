import {
  GoatGoatclawSyncInput,
  GoatGoatclawSyncResult,
  PermissionProfileView,
} from "@goat/contracts";
import * as Profiles from "../../../goatclaw/PermissionProfiles.ts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import {
  GoatGoalApplyInput,
  GoatGoalApplyResult,
  GoatGoalDeleteInput,
  GoatGoalDeleteResult,
  GoatGoalIdInput,
  GoatGoalListInput,
  GoatGoalListResult,
  GoatGoalGetResult,
  GoatGoalResult,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as GoalService from "../../../fleet/goals/GoalService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    GoalService.GoalService,
  ],
};

const PermissionProfileGetTool = Tool.make(agentSurfaceRegistry["permission_profile.get"].name, {
  ...shared,
  description: agentSurfaceRegistry["permission_profile.get"].description,
  parameters: Tool.EmptyParams,
  success: PermissionProfileView,
  dependencies: [...shared.dependencies, Profiles.PermissionProfiles],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["permission_profile.get"]));

const GoatclawSyncTool = Tool.make(agentSurfaceRegistry["permission_profile.sync"].name, {
  ...shared,
  description: agentSurfaceRegistry["permission_profile.sync"].description,
  parameters: GoatGoatclawSyncInput,
  success: GoatGoatclawSyncResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["permission_profile.sync"]));

const GoalApplyTool = Tool.make(agentSurfaceRegistry["goal.apply"].name, {
  ...shared,
  description: agentSurfaceRegistry["goal.apply"].description,
  parameters: GoatGoalApplyInput,
  success: GoatGoalApplyResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["goal.apply"]));

const GoalGetTool = Tool.make(agentSurfaceRegistry["goal.get"].name, {
  ...shared,
  description: agentSurfaceRegistry["goal.get"].description,
  parameters: GoatGoalIdInput,
  success: GoatGoalGetResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["goal.get"]));

const GoalListTool = Tool.make(agentSurfaceRegistry["goal.list"].name, {
  ...shared,
  description: agentSurfaceRegistry["goal.list"].description,
  parameters: GoatGoalListInput,
  success: GoatGoalListResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["goal.list"]));

const GoalDeleteTool = Tool.make(agentSurfaceRegistry["goal.delete"].name, {
  ...shared,
  description: agentSurfaceRegistry["goal.delete"].description,
  parameters: GoatGoalDeleteInput,
  success: GoatGoalDeleteResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["goal.delete"]));

const GoalPauseTool = Tool.make(agentSurfaceRegistry["goal.pause"].name, {
  ...shared,
  description: agentSurfaceRegistry["goal.pause"].description,
  parameters: GoatGoalIdInput,
  success: GoatGoalResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["goal.pause"]));

const GoalResumeTool = Tool.make(agentSurfaceRegistry["goal.resume"].name, {
  ...shared,
  description: agentSurfaceRegistry["goal.resume"].description,
  parameters: GoatGoalIdInput,
  success: GoatGoalResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["goal.resume"]));

export const FleetToolkit = Toolkit.make(
  PermissionProfileGetTool,
  GoatclawSyncTool,
  GoalApplyTool,
  GoalGetTool,
  GoalListTool,
  GoalDeleteTool,
  GoalPauseTool,
  GoalResumeTool,
);
