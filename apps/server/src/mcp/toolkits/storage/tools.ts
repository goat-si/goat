import {
  OrchestratorMcpFailure,
  StorageMcpCleanInput,
  StorageMcpCleanResultJson,
  StorageMcpUsageInput,
  StorageMcpUsageResult,
} from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { Tool } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as StorageConsent from "../../../storage/StorageConsent.ts";
import * as StorageReclaim from "../../../storage/StorageReclaim.ts";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import * as HostThreadsMcpService from "../../HostThreadsMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  StorageReclaim.StorageReclaim,
  StorageConsent.StorageConsent,
  HostThreadsMcpService.HostThreadsMcpService,
];

/** Served in the worktree toolkit, where most of what they clean lives. */
export const StorageUsageTool = Tool.make(agentSurfaceRegistry["storage.usage"].name, {
  description: agentSurfaceRegistry["storage.usage"].description,
  parameters: StorageMcpUsageInput,
  success: StorageMcpUsageResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["storage.usage"]));

export const StorageCleanTool = Tool.make(agentSurfaceRegistry["storage.clean"].name, {
  description: agentSurfaceRegistry["storage.clean"].description,
  parameters: StorageMcpCleanInput,
  success: StorageMcpCleanResultJson,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["storage.clean"]));
