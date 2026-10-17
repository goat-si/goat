import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import {
  ChannelIngestResult,
  ChannelInputId,
  ChannelInputSnapshot,
  ChannelListTasksInput,
  ChannelListTasksResult,
  ChannelTask,
  ChannelTaskExportInput,
  ChannelTaskExportResult,
  ChannelTaskId,
  ChannelTaskReportInput,
  ChannelTaskMoveInput,
  ChannelTaskMoveResult,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ChannelGateway from "../../../channels/ChannelGateway.ts";
import * as ChannelLedger from "../../../channels/ChannelLedger.ts";
import * as ChannelRemoteWorkers from "../../../channels/ChannelRemoteWorkers.ts";
import * as ChannelRuntime from "../../../channels/ChannelRuntime.ts";
import * as ChannelWorkerReports from "../../../channels/ChannelWorkerReports.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ChannelGateway.ChannelGateway,
    ChannelLedger.ChannelLedger,
    ChannelWorkerReports.ChannelWorkerReports,
  ],
};

const ChannelIngestTool = Tool.make(agentSurfaceRegistry["channel.ingest"].name, {
  ...shared,
  description: agentSurfaceRegistry["channel.ingest"].description,
  parameters: Schema.Struct({
    text: Schema.String.check(Schema.isMaxLength(20_000)),
    clientRequestId: TrimmedNonEmptyString,
    conversationKey: Schema.optional(TrimmedNonEmptyString),
  }),
  success: ChannelIngestResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["channel.ingest"]));

const ChannelInputGetTool = Tool.make(agentSurfaceRegistry["channel.input_read"].name, {
  ...shared,
  description: agentSurfaceRegistry["channel.input_read"].description,
  parameters: Schema.Struct({ inputId: ChannelInputId }),
  success: ChannelInputSnapshot,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["channel.input_read"]));

const ChannelTaskGetTool = Tool.make(agentSurfaceRegistry["channel.task_read"].name, {
  ...shared,
  description: agentSurfaceRegistry["channel.task_read"].description,
  parameters: Schema.Struct({ taskId: ChannelTaskId }),
  success: ChannelTask,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["channel.task_read"]));

const ChannelTaskListTool = Tool.make(agentSurfaceRegistry["channel.task_list"].name, {
  ...shared,
  description: agentSurfaceRegistry["channel.task_list"].description,
  parameters: ChannelListTasksInput,
  success: ChannelListTasksResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["channel.task_list"]));

const ChannelTaskExportTool = Tool.make(agentSurfaceRegistry["channel.task_export"].name, {
  ...shared,
  description: agentSurfaceRegistry["channel.task_export"].description,
  parameters: ChannelTaskExportInput,
  success: ChannelTaskExportResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["channel.task_export"]));

const ChannelTaskReportTool = Tool.make(agentSurfaceRegistry["channel.task_report"].name, {
  ...shared,
  description: agentSurfaceRegistry["channel.task_report"].description,
  parameters: ChannelTaskReportInput,
  success: Schema.Struct({}),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["channel.task_report"]));

const ChannelTaskMoveTool = Tool.make(agentSurfaceRegistry["channel.task_move"].name, {
  ...shared,
  dependencies: [
    ...shared.dependencies,
    ChannelRemoteWorkers.ChannelRemoteWorkers,
    ChannelRuntime.ChannelRuntime,
  ],
  description: agentSurfaceRegistry["channel.task_move"].description,
  parameters: ChannelTaskMoveInput,
  success: ChannelTaskMoveResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["channel.task_move"]));

export const ChannelToolkit = Toolkit.make(
  ChannelIngestTool,
  ChannelInputGetTool,
  ChannelTaskGetTool,
  ChannelTaskListTool,
  ChannelTaskExportTool,
  ChannelTaskReportTool,
  ChannelTaskMoveTool,
);
