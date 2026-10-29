import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import * as M from "@goat/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as MemoryService from "../../../memory/MemoryService.ts";
import * as MemorySyncService from "../../../memory/MemorySyncService.ts";
import * as MemorySettingsService from "../../../memory/MemorySettingsService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { memoryInputSchema } from "../memory/tools.ts";
const keyedInputSchema = (schema: Schema.Top) => {
  const input = memoryInputSchema(schema);
  return {
    ...input,
    properties: {
      ...(input as { properties?: Record<string, unknown> }).properties,
      clientRequestId: {
        type: "string",
        minLength: 1,
        maxLength: 256,
        description: "Idempotency key for this write; reuse it only with the same arguments.",
      },
    },
  };
};
export const MemoryAdministrationToolkit = Toolkit.make(
  Tool.dynamic(agentSurfaceRegistry["memory.binding_read"].name, {
    description: agentSurfaceRegistry["memory.binding_read"].description,
    parameters: memoryInputSchema(M.MemoryProjectBindingGetInput),
    success: Schema.Struct({ binding: Schema.NullOr(M.MemoryProjectBinding) }),
    failure: Schema.Union([M.MemoryRpcError, M.OrchestratorMcpFailure]),
    failureMode: "return",
  })
    .addDependency(McpInvocationContext.McpInvocationContext)
    .addDependency(MemoryService.MemoryService)
    .addDependency(ThreadManagementService.ThreadManagementService)
    .annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["memory.binding_read"])),
  Tool.dynamic(agentSurfaceRegistry["memory.binding_update"].name, {
    description: agentSurfaceRegistry["memory.binding_update"].description,
    parameters: keyedInputSchema(
      Schema.Struct({
        memorySpaceId: M.MemorySpaceId,
        project: M.ScopedProjectRef,
        requestId: M.MemoryOperationId,
        expectedVersion: M.NonNegativeInt,
        action: Schema.Literals(["setExplicit", "useRepository"]),
        sharedProjectId: Schema.optionalKey(Schema.String),
      }),
    ),
    success: M.MemoryProjectBindingUpdateResult,
    failure: Schema.Union([M.MemoryRpcError, M.OrchestratorMcpFailure]),
    failureMode: "return",
  })
    .addDependency(McpInvocationContext.McpInvocationContext)
    .addDependency(MemoryService.MemoryService)
    .addDependency(ThreadManagementService.ThreadManagementService)
    .annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["memory.binding_update"])),
  Tool.dynamic(agentSurfaceRegistry["memory.hub_diagnostics"].name, {
    description: agentSurfaceRegistry["memory.hub_diagnostics"].description,
    parameters: memoryInputSchema(M.MemorySyncStatusInput),
    success: M.MemoryHubDiagnostics,
    failure: Schema.Union([M.MemoryRpcError, M.OrchestratorMcpFailure]),
    failureMode: "return",
  })
    .addDependency(McpInvocationContext.McpInvocationContext)
    .addDependency(MemorySyncService.MemorySyncService)
    .addDependency(ThreadManagementService.ThreadManagementService)
    .annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["memory.hub_diagnostics"])),
  Tool.dynamic(agentSurfaceRegistry["memory.hub_reconcile"].name, {
    description: agentSurfaceRegistry["memory.hub_reconcile"].description,
    parameters: keyedInputSchema(M.MemoryHubReconcileInput),
    success: M.MemoryHubReconcileResult,
    failure: Schema.Union([M.MemoryRpcError, M.OrchestratorMcpFailure]),
    failureMode: "return",
  })
    .addDependency(McpInvocationContext.McpInvocationContext)
    .addDependency(MemorySyncService.MemorySyncService)
    .addDependency(ThreadManagementService.ThreadManagementService)
    .annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["memory.hub_reconcile"])),
  Tool.dynamic(agentSurfaceRegistry["memory.report_attempts_reset"].name, {
    description: agentSurfaceRegistry["memory.report_attempts_reset"].description,
    parameters: keyedInputSchema(M.MemoryResetReportAttemptsInput),
    success: M.MemoryResetReportAttemptsResult,
    failure: Schema.Union([M.MemoryRpcError, M.OrchestratorMcpFailure]),
    failureMode: "return",
  })
    .addDependency(McpInvocationContext.McpInvocationContext)
    .addDependency(MemoryService.MemoryService)
    .addDependency(ThreadManagementService.ThreadManagementService)
    .annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["memory.report_attempts_reset"])),
  Tool.dynamic(agentSurfaceRegistry["memory.settings_read"].name, {
    description: agentSurfaceRegistry["memory.settings_read"].description,
    parameters: memoryInputSchema(M.MemorySettingsGetInput),
    success: M.MemorySettingsView,
    failure: Schema.Union([M.MemoryRpcError, M.OrchestratorMcpFailure]),
    failureMode: "return",
  })
    .addDependency(McpInvocationContext.McpInvocationContext)
    .addDependency(MemorySettingsService.MemorySettingsService)
    .addDependency(ThreadManagementService.ThreadManagementService)
    .annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["memory.settings_read"])),
  Tool.dynamic(agentSurfaceRegistry["memory.settings_update"].name, {
    description: agentSurfaceRegistry["memory.settings_update"].description,
    parameters: memoryInputSchema(M.MemorySettingsUpdateInput),
    success: M.MemorySettingsView,
    failure: Schema.Union([M.MemoryRpcError, M.OrchestratorMcpFailure]),
    failureMode: "return",
  })
    .addDependency(McpInvocationContext.McpInvocationContext)
    .addDependency(MemorySettingsService.MemorySettingsService)
    .addDependency(ThreadManagementService.ThreadManagementService)
    .annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["memory.settings_update"])),
  Tool.dynamic(agentSurfaceRegistry["memory.hub_disable"].name, {
    description: agentSurfaceRegistry["memory.hub_disable"].description,
    parameters: memoryInputSchema(M.MemoryHubDisableInput),
    success: M.MemoryHubDisableResult,
    failure: Schema.Union([M.MemoryRpcError, M.OrchestratorMcpFailure]),
    failureMode: "return",
  })
    .addDependency(McpInvocationContext.McpInvocationContext)
    .addDependency(MemorySyncService.MemorySyncService)
    .addDependency(ThreadManagementService.ThreadManagementService)
    .annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["memory.hub_disable"])),
);
