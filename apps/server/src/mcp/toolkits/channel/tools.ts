import {
  CHANNEL_MCP_TOOL_NAMES,
  ChannelIngestResult,
  ChannelInputId,
  ChannelInputSnapshot,
  ChannelListTasksInput,
  ChannelListTasksResult,
  ChannelTask,
  ChannelTaskId,
  ChannelTaskReportInput,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ChannelGateway from "../../../channels/ChannelGateway.ts";
import * as ChannelLedger from "../../../channels/ChannelLedger.ts";
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

const ChannelIngestTool = Tool.make(CHANNEL_MCP_TOOL_NAMES.ingest, {
  ...shared,
  description:
    "Send a message to GOAT's front desk as an agent. It answers within seconds; read the answer with channel_input_get and the returned inputId. Agents can ask how work is going; only people can start work or answer a task's questions. Reuse clientRequestId to retry safely. conversationKey keeps related messages in one conversation (default: one per caller).",
  parameters: Schema.Struct({
    text: Schema.String.check(Schema.isMaxLength(20_000)),
    clientRequestId: TrimmedNonEmptyString,
    conversationKey: Schema.optional(TrimmedNonEmptyString),
  }),
  success: ChannelIngestResult,
})
  .annotate(Tool.Title, "Message GOAT's front desk")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ChannelInputGetTool = Tool.make(CHANNEL_MCP_TOOL_NAMES.inputGet, {
  ...shared,
  description:
    "Read a message you sent with channel_ingest: its state and the front desk's reply once it has one (reply.text), or failure. Only your own messages are visible.",
  parameters: Schema.Struct({ inputId: ChannelInputId }),
  success: ChannelInputSnapshot,
})
  .annotate(Tool.Title, "Read a front desk reply")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ChannelTaskGetTool = Tool.make(CHANNEL_MCP_TOOL_NAMES.taskGet, {
  ...shared,
  description:
    "Read one GOAT ledger task: status, worker thread, result summary, and open questions.",
  parameters: Schema.Struct({ taskId: ChannelTaskId }),
  success: ChannelTask,
})
  .annotate(Tool.Title, "Read a GOAT ledger task")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ChannelTaskListTool = Tool.make(CHANNEL_MCP_TOOL_NAMES.taskList, {
  ...shared,
  description: "List GOAT ledger tasks, newest change first, optionally filtered by status.",
  parameters: ChannelListTasksInput,
  success: ChannelListTasksResult,
})
  .annotate(Tool.Title, "List GOAT ledger tasks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ChannelTaskReportTool = Tool.make(CHANNEL_MCP_TOOL_NAMES.taskReport, {
  ...shared,
  description:
    "Report on the GOAT ledger task this thread is working on: progress (running), a question for the person who asked (waiting_input, with question; then stop), a proposed completion (completed; recorded when your run ends), or failure. Only the task's worker thread can report, with the task's current generation. Use a new eventId for each report.",
  parameters: ChannelTaskReportInput,
  success: Schema.Struct({}),
})
  .annotate(Tool.Title, "Report on a GOAT ledger task")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ChannelToolkit = Toolkit.make(
  ChannelIngestTool,
  ChannelInputGetTool,
  ChannelTaskGetTool,
  ChannelTaskListTool,
  ChannelTaskReportTool,
);
