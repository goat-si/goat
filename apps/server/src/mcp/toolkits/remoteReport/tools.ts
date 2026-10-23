import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import {
  OrchestratorMcpFailure,
  RemoteOriginReportInput,
  RemoteOriginReportResult,
  RemoteOriginReportsWaitInput,
  RemoteOriginReportsWaitResult,
} from "@goat/contracts";
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
const ReportTool = Tool.make(agentSurfaceRegistry["origin.report"].name, {
  ...shared,
  description: agentSurfaceRegistry["origin.report"].description,
  parameters: RemoteOriginReportInput,
  success: RemoteOriginReportResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["origin.report"]));
const WaitTool = Tool.make(agentSurfaceRegistry["origin.report_wait"].name, {
  ...shared,
  description: agentSurfaceRegistry["origin.report_wait"].description,
  parameters: RemoteOriginReportsWaitInput,
  success: RemoteOriginReportsWaitResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["origin.report_wait"]));
export const RemoteReportToolkit = Toolkit.make(ReportTool, WaitTool);
