import {
  OrchestratorMcpCapabilitiesInput,
  OrchestrationV2StopWorkflowInput,
  ThreadReplicaCaptureInput,
  ThreadReplicaCaptureResult,
  ThreadReplicaRestoreInput,
  ThreadReplicaRestoreResult,
  ThreadReplicaRecoveryInput,
  ThreadReplicaSettingInput,
  ThreadReplicaReconcileInput,
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpCreateThreadsInput,
  OrchestratorMcpCreateThreadsResult,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpDeleteScheduledTaskInput,
  OrchestratorMcpDeleteScheduledTaskResult,
  OrchestratorMcpFailure,
  OrchestratorMcpListScheduledTasksInput,
  OrchestratorMcpListScheduledTasksResult,
  OrchestratorMcpRequestSecretInput,
  OrchestratorMcpRequestSecretResult,
  OrchestratorMcpReviewFindingsExportInput,
  OrchestratorMcpReviewFindingsExportResult,
  OrchestratorMcpReviewFindingsRecordInput,
  OrchestratorMcpReviewFindingsRecordResult,
  OrchestratorMcpScheduleTaskInput,
  OrchestratorMcpScheduleTaskResult,
  OrchestratorMcpTaskCancelInput,
  OrchestratorMcpTaskCancelResult,
  OrchestratorMcpTaskStatusInput,
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadRetryInput,
  OrchestratorMcpThreadRetryResult,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendInput,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadStatusInput,
  OrchestratorMcpThreadStatusResult,
  OrchestratorMcpThreadUnwatchResult,
  OrchestratorMcpThreadWaitInput,
  OrchestratorMcpThreadWaitResult,
  OrchestratorMcpThreadWatchInput,
  OrchestratorMcpThreadWatchListResult,
  OrchestratorMcpThreadWatchResult,
  OrchestratorMcpUpdateScheduledTaskInput,
  ThreadMetadataMcpUpdateInput,
  ThreadMetadataMcpUpdateResult,
} from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadResultService from "../../../threadResults/ThreadResultService.ts";
import * as HostThreadsMcpService from "../../HostThreadsMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  OrchestratorMcpService.OrchestratorMcpService,
];
const threadMetadataDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ThreadMetadataMcpService.ThreadMetadataMcpService,
];
/** Thread tools that can also reach another machine's threads. */
const hostThreadDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  HostThreadsMcpService.HostThreadsMcpService,
];

/** Reads that also return a run's structured result. */
const hostThreadResultDependencies = [
  ...hostThreadDependencies,
  ThreadResultService.ThreadResultService,
];

const OrchestratorCapabilitiesTool = Tool.make(agentSurfaceRegistry["provider.list"].name, {
  description: agentSurfaceRegistry["provider.list"].description,
  parameters: OrchestratorMcpCapabilitiesInput,
  success: OrchestratorMcpCapabilitiesResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["provider.list"]));

const DelegateTaskTool = Tool.make(agentSurfaceRegistry["task.create"].name, {
  description: agentSurfaceRegistry["task.create"].description,
  parameters: OrchestratorMcpDelegateTaskInput,
  success: OrchestratorMcpDelegateTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["task.create"]));

const TaskStatusTool = Tool.make(agentSurfaceRegistry["task.read"].name, {
  description: agentSurfaceRegistry["task.read"].description,
  parameters: OrchestratorMcpTaskStatusInput,
  success: OrchestratorMcpDelegateTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["task.read"]));

const ReviewFindingsRecordTool = Tool.make(agentSurfaceRegistry["review_findings.record"].name, {
  description: agentSurfaceRegistry["review_findings.record"].description,
  parameters: OrchestratorMcpReviewFindingsRecordInput,
  success: OrchestratorMcpReviewFindingsRecordResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["review_findings.record"]));

const ReviewFindingsExportTool = Tool.make(agentSurfaceRegistry["review_findings.export"].name, {
  description: agentSurfaceRegistry["review_findings.export"].description,
  parameters: OrchestratorMcpReviewFindingsExportInput,
  success: OrchestratorMcpReviewFindingsExportResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["review_findings.export"]));

const TaskCancelTool = Tool.make(agentSurfaceRegistry["task.cancel"].name, {
  description: agentSurfaceRegistry["task.cancel"].description,
  parameters: OrchestratorMcpTaskCancelInput,
  success: OrchestratorMcpTaskCancelResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["task.cancel"]));

const WorkflowStopTool = Tool.make(agentSurfaceRegistry["workflow.stop"].name, {
  description: agentSurfaceRegistry["workflow.stop"].description,
  parameters: OrchestrationV2StopWorkflowInput,
  success: Schema.Struct({}),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["workflow.stop"]));

const ScheduleTaskTool = Tool.make(agentSurfaceRegistry["schedule.create"].name, {
  description: agentSurfaceRegistry["schedule.create"].description,
  parameters: OrchestratorMcpScheduleTaskInput,
  success: OrchestratorMcpScheduleTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["schedule.create"]));

const ListScheduledTasksTool = Tool.make(agentSurfaceRegistry["schedule.list"].name, {
  parameters: OrchestratorMcpListScheduledTasksInput,
  description: agentSurfaceRegistry["schedule.list"].description,
  success: OrchestratorMcpListScheduledTasksResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["schedule.list"]));

const UpdateScheduledTaskTool = Tool.make(agentSurfaceRegistry["schedule.update"].name, {
  description: agentSurfaceRegistry["schedule.update"].description,
  parameters: OrchestratorMcpUpdateScheduledTaskInput,
  success: OrchestratorMcpScheduleTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["schedule.update"]));

const DeleteScheduledTaskTool = Tool.make(agentSurfaceRegistry["schedule.delete"].name, {
  description: agentSurfaceRegistry["schedule.delete"].description,
  parameters: OrchestratorMcpDeleteScheduledTaskInput,
  success: OrchestratorMcpDeleteScheduledTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["schedule.delete"]));

const RequestSecretTool = Tool.make(agentSurfaceRegistry["handoff.create"].name, {
  description: agentSurfaceRegistry["handoff.create"].description,
  parameters: OrchestratorMcpRequestSecretInput,
  success: OrchestratorMcpRequestSecretResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["handoff.create"]));

const CreateThreadsTool = Tool.make(agentSurfaceRegistry["thread.create_many"].name, {
  description: agentSurfaceRegistry["thread.create_many"].description,
  parameters: OrchestratorMcpCreateThreadsInput,
  success: OrchestratorMcpCreateThreadsResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["thread.create_many"]));

const ThreadListTool = Tool.make(agentSurfaceRegistry["thread.list"].name, {
  description: agentSurfaceRegistry["thread.list"].description,
  parameters: OrchestratorMcpThreadListInput,
  success: OrchestratorMcpThreadListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: hostThreadDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["thread.list"]));

const ThreadReadTool = Tool.make(agentSurfaceRegistry["thread.read"].name, {
  description: agentSurfaceRegistry["thread.read"].description,
  parameters: OrchestratorMcpThreadReadInput,
  success: OrchestratorMcpThreadReadResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: hostThreadResultDependencies,
})
  .annotate(Tool.Strict, true)
  .annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["thread.read"]));

const ThreadUpdateTool = Tool.make(agentSurfaceRegistry["thread.update"].name, {
  description: agentSurfaceRegistry["thread.update"].description,
  parameters: ThreadMetadataMcpUpdateInput,
  success: ThreadMetadataMcpUpdateResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: threadMetadataDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["thread.update"]));

const ThreadSendTool = Tool.make(agentSurfaceRegistry["thread.send"].name, {
  description: agentSurfaceRegistry["thread.send"].description,
  parameters: OrchestratorMcpThreadSendInput,
  success: OrchestratorMcpThreadSendResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: hostThreadDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["thread.send"]));

const ThreadWaitTool = Tool.make(agentSurfaceRegistry["thread.wait"].name, {
  description: agentSurfaceRegistry["thread.wait"].description,
  parameters: OrchestratorMcpThreadWaitInput,
  success: OrchestratorMcpThreadWaitResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: hostThreadResultDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["thread.wait"]));

const ThreadInterruptTool = Tool.make(agentSurfaceRegistry["thread.interrupt"].name, {
  description: agentSurfaceRegistry["thread.interrupt"].description,
  parameters: OrchestratorMcpThreadInterruptInput,
  success: OrchestratorMcpThreadInterruptResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: hostThreadDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["thread.interrupt"]));

const ThreadRetryTool = Tool.make(agentSurfaceRegistry["thread.retry"].name, {
  description: agentSurfaceRegistry["thread.retry"].description,
  parameters: OrchestratorMcpThreadRetryInput,
  success: OrchestratorMcpThreadRetryResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: hostThreadDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["thread.retry"]));

const ThreadStatusTool = Tool.make(agentSurfaceRegistry["thread.status"].name, {
  description: agentSurfaceRegistry["thread.status"].description,
  parameters: OrchestratorMcpThreadStatusInput,
  success: OrchestratorMcpThreadStatusResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: hostThreadDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["thread.status"]));

const ThreadWatchTool = Tool.make(agentSurfaceRegistry["thread.watch"].name, {
  description: agentSurfaceRegistry["thread.watch"].description,
  parameters: OrchestratorMcpThreadWatchInput,
  success: OrchestratorMcpThreadWatchResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: hostThreadDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["thread.watch"]));

const ThreadUnwatchTool = Tool.make(agentSurfaceRegistry["thread.unwatch"].name, {
  description: agentSurfaceRegistry["thread.unwatch"].description,
  parameters: OrchestratorMcpThreadWatchInput,
  success: OrchestratorMcpThreadUnwatchResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: hostThreadDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["thread.unwatch"]));

const ThreadWatchListTool = Tool.make(agentSurfaceRegistry["thread.watch_list"].name, {
  description: agentSurfaceRegistry["thread.watch_list"].description,
  // No parameters: an explicit empty struct is not a valid MCP input schema.
  success: OrchestratorMcpThreadWatchListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: hostThreadDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["thread.watch_list"]));

const CheckpointCaptureTool = Tool.make(agentSurfaceRegistry["thread.checkpoint_capture"].name, {
  description: agentSurfaceRegistry["thread.checkpoint_capture"].description,
  parameters: ThreadReplicaCaptureInput,
  success: ThreadReplicaCaptureResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: hostThreadDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["thread.checkpoint_capture"]));

const CheckpointRestoreTool = Tool.make(agentSurfaceRegistry["thread.checkpoint_restore"].name, {
  description: agentSurfaceRegistry["thread.checkpoint_restore"].description,
  parameters: ThreadReplicaRestoreInput,
  success: ThreadReplicaRestoreResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: hostThreadDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["thread.checkpoint_restore"]));

const CheckpointRecoveryTool = Tool.make(agentSurfaceRegistry["thread.handoff_host"].name, {
  description: agentSurfaceRegistry["thread.handoff_host"].description,
  parameters: ThreadReplicaRecoveryInput,
  success: ThreadReplicaRestoreResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: hostThreadDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["thread.handoff_host"]));

const ReplicationSettingTool = Tool.make(agentSurfaceRegistry["thread.replication_set"].name, {
  description: agentSurfaceRegistry["thread.replication_set"].description,
  parameters: ThreadReplicaSettingInput,
  success: ThreadReplicaSettingInput,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: hostThreadDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["thread.replication_set"]));

const CheckpointReconcileTool = Tool.make(
  agentSurfaceRegistry["thread.checkpoint_reconcile"].name,
  {
    description: agentSurfaceRegistry["thread.checkpoint_reconcile"].description,
    parameters: ThreadReplicaReconcileInput,
    success: ThreadReplicaRestoreResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: hostThreadDependencies,
  },
).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["thread.checkpoint_reconcile"]));

export const OrchestratorToolkit = Toolkit.make(
  CheckpointReconcileTool,
  ReplicationSettingTool,
  CheckpointCaptureTool,
  CheckpointRestoreTool,
  CheckpointRecoveryTool,
  OrchestratorCapabilitiesTool,
  DelegateTaskTool,
  TaskStatusTool,
  ReviewFindingsRecordTool,
  ReviewFindingsExportTool,
  TaskCancelTool,
  WorkflowStopTool,
  ScheduleTaskTool,
  ListScheduledTasksTool,
  UpdateScheduledTaskTool,
  DeleteScheduledTaskTool,
  RequestSecretTool,
  CreateThreadsTool,
  ThreadListTool,
  ThreadReadTool,
  ThreadUpdateTool,
  ThreadSendTool,
  ThreadWaitTool,
  ThreadStatusTool,
  ThreadInterruptTool,
  ThreadRetryTool,
  ThreadWatchTool,
  ThreadUnwatchTool,
  ThreadWatchListTool,
);
