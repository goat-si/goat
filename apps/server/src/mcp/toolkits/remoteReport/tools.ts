import {
  OrchestratorMcpFailure,
  RemoteOriginReportInput,
  RemoteOriginReportResult,
  RemoteOriginReportsWaitInput,
  RemoteOriginReportsWaitResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as RemoteReportService from "../../../remoteReports/RemoteReportService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    RemoteReportService.RemoteReportService,
  ],
};
const ReportTool = Tool.make("goat_origin_report", {
  ...shared,
  description:
    "Report progress, a result, failure or a need for human input to the origin of this thread. Only available inside a thread launched with an origin binding. The summary is data; a completed report is a claim and does not stop the run. Maximum 4000 characters.",
  parameters: RemoteOriginReportInput,
  success: RemoteOriginReportResult,
}).annotate(Tool.Destructive, false);
const WaitTool = Tool.make("goat_origin_reports_wait", {
  ...shared,
  description:
    "Collect one origin correlation's reports using its read key. afterSequence acknowledges only durably imported reports. Returns up to 50 reports; drain hasMore before settling. watchRunId selects an exact run, null selects latest. observedRun lists a live run's pendingRequestIds and a finished run's holds (background tasks, a pending restart continuation); do not settle while a hold remains. knownRun tracks its last observed identity and status, plus pendingRequestIds and holds when echoed back; timeoutMs is 0..600000. A terminal report is not proof of run settlement.",
  parameters: RemoteOriginReportsWaitInput,
  success: RemoteOriginReportsWaitResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
export const RemoteReportToolkit = Toolkit.make(ReportTool, WaitTool);
