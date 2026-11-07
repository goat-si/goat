import { withClientRequestId } from "../keyedParameters.ts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import {
  ChannelBotHomeClaimResult,
  ChannelBotHomeStatus,
  ChannelBotListResult,
  ChannelIngestResult,
  ChannelInputId,
  ChannelInputSnapshot,
  ChannelListTasksInput,
  ChannelListTasksResult,
  ChannelTask,
  ChannelTaskExportInput,
  ChannelTaskExportResult,
  ChannelTaskId,
  ChannelTaskEvent,
  ChannelQuestionId,
  ChannelTaskReportInput,
  ChannelTaskMoveInput,
  ChannelTaskMoveResult,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ChannelBotHome from "../../../channels/ChannelBotHome.ts";
import * as ChannelBotProfiles from "../../../channels/ChannelBotProfiles.ts";
import * as ChannelGateway from "../../../channels/ChannelGateway.ts";
import * as ChannelLedger from "../../../channels/ChannelLedger.ts";
import * as ChannelRemoteWorkers from "../../../channels/ChannelRemoteWorkers.ts";
import * as ChannelRuntime from "../../../channels/ChannelRuntime.ts";
import * as ChannelSessionTaskActions from "../../../channels/channelSessionTaskActions.ts";
import * as ChannelSessionNoteActions from "../../../channels/channelSessionNoteActions.ts";
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

const ChannelBotHomeTool = Tool.make(agentSurfaceRegistry["channel.bot_home_read"].name, {
  ...shared,
  dependencies: [...shared.dependencies, ChannelBotHome.ChannelBotHome],
  description: agentSurfaceRegistry["channel.bot_home_read"].description,
  parameters: Tool.EmptyParams,
  success: ChannelBotHomeStatus,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["channel.bot_home_read"]));

const ChannelBotListTool = Tool.make(agentSurfaceRegistry["channel.bot_list"].name, {
  ...shared,
  dependencies: [...shared.dependencies, ChannelBotProfiles.ChannelBotProfiles],
  description: agentSurfaceRegistry["channel.bot_list"].description,
  parameters: Tool.EmptyParams,
  success: ChannelBotListResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["channel.bot_list"]));

const ChannelBotHomeClaimTool = Tool.make(agentSurfaceRegistry["channel.bot_home_claim"].name, {
  ...shared,
  dependencies: [...shared.dependencies, ChannelBotHome.ChannelBotHome],
  description: agentSurfaceRegistry["channel.bot_home_claim"].description,
  parameters: withClientRequestId(Schema.Struct({})),
  success: ChannelBotHomeClaimResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["channel.bot_home_claim"]));

const task_follow_upTool = Tool.make(agentSurfaceRegistry["channel.task_follow_up"].name, {
  ...shared,
  dependencies: [...shared.dependencies, ChannelSessionTaskActions.ChannelSessionTaskActions],
  description: agentSurfaceRegistry["channel.task_follow_up"].description,
  parameters: Schema.Struct({
    taskId: ChannelTaskId,
    text: Schema.String,
    clientRequestId: TrimmedNonEmptyString,
  }),
  success: Schema.NullOr(ChannelTaskEvent),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["channel.task_follow_up"]));

const task_stopTool = Tool.make(agentSurfaceRegistry["channel.task_stop"].name, {
  ...shared,
  dependencies: [...shared.dependencies, ChannelSessionTaskActions.ChannelSessionTaskActions],
  description: agentSurfaceRegistry["channel.task_stop"].description,
  parameters: Schema.Struct({ taskId: ChannelTaskId, clientRequestId: TrimmedNonEmptyString }),
  success: Schema.NullOr(ChannelTaskEvent),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["channel.task_stop"]));

const task_answerTool = Tool.make(agentSurfaceRegistry["channel.task_answer"].name, {
  ...shared,
  dependencies: [...shared.dependencies, ChannelSessionTaskActions.ChannelSessionTaskActions],
  description: agentSurfaceRegistry["channel.task_answer"].description,
  parameters: Schema.Struct({
    taskId: ChannelTaskId,
    questionId: ChannelQuestionId,
    answer: Schema.String,
    clientRequestId: TrimmedNonEmptyString,
  }),
  success: Schema.NullOr(ChannelTaskEvent),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["channel.task_answer"]));

const ChannelNotesChangeTool = Tool.make(agentSurfaceRegistry["channel.notes_change"].name, {
  ...shared,
  dependencies: [...shared.dependencies, ChannelSessionNoteActions.ChannelSessionNoteActions],
  description: agentSurfaceRegistry["channel.notes_change"].description,
  parameters: Schema.Struct({
    taskId: ChannelTaskId,
    inputId: ChannelInputId,
    kind: Schema.Literals(["remember", "edit"]),
    quote: TrimmedNonEmptyString,
    note: Schema.optional(TrimmedNonEmptyString),
    replaces: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Struct({
    outcome: Schema.Literals(["saved", "granted", "refused"]),
    reason: Schema.optional(Schema.String),
    told: Schema.Boolean,
    message: Schema.String,
  }),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["channel.notes_change"]));

export const ChannelToolkit = Toolkit.make(
  task_follow_upTool,
  task_stopTool,
  task_answerTool,
  ChannelNotesChangeTool,
  ChannelIngestTool,
  ChannelInputGetTool,
  ChannelTaskGetTool,
  ChannelTaskListTool,
  ChannelTaskExportTool,
  ChannelTaskReportTool,
  ChannelTaskMoveTool,
  ChannelBotHomeTool,
  ChannelBotListTool,
  ChannelBotHomeClaimTool,
);
