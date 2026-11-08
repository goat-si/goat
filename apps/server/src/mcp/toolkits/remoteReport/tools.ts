import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import {
  OrchestratorMcpFailure,
  RemoteOriginReportInput,
  RemoteOriginReportReceiptInput,
  RemoteOriginReportReceiptResult,
  RemoteOriginReportResult,
  RemoteOriginReportsWaitInput,
  RemoteOriginReportsWaitResult,
  RemoteResolveBindingInput,
  RemoteResolveBindingResult,
  OriginBoundDeleteInput,
  OriginBoundDeleteResult,
} from "@goat/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as RemoteReportService from "../../../remoteReports/RemoteReportService.ts";
import * as OriginBoundDeleteService from "../../../remoteReports/OriginBoundDeleteService.ts";
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
const ReceiptTool = Tool.make(agentSurfaceRegistry["origin.report_receipt"].name, {
  ...shared,
  description: agentSurfaceRegistry["origin.report_receipt"].description,
  parameters: RemoteOriginReportReceiptInput,
  success: RemoteOriginReportReceiptResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["origin.report_receipt"]));
const WaitTool = Tool.make(agentSurfaceRegistry["origin.report_wait"].name, {
  ...shared,
  description: agentSurfaceRegistry["origin.report_wait"].description,
  parameters: RemoteOriginReportsWaitInput,
  success: RemoteOriginReportsWaitResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["origin.report_wait"]));
const ResolveBindingTool = Tool.make(agentSurfaceRegistry["origin.resolve_binding"].name, {
  ...shared,
  description: agentSurfaceRegistry["origin.resolve_binding"].description,
  parameters: RemoteResolveBindingInput,
  success: RemoteResolveBindingResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["origin.resolve_binding"]));
const boundDelete = {
  ...shared,
  dependencies: [...shared.dependencies, OriginBoundDeleteService.OriginBoundDeleteService],
};
const BoundDeleteTool = Tool.make(agentSurfaceRegistry["origin.bound_delete"].name, {
  ...boundDelete,
  description: agentSurfaceRegistry["origin.bound_delete"].description,
  parameters: OriginBoundDeleteInput,
  success: OriginBoundDeleteResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["origin.bound_delete"]));
const BoundDeleteReceiptTool = Tool.make(agentSurfaceRegistry["origin.bound_delete_receipt"].name, {
  ...boundDelete,
  description: agentSurfaceRegistry["origin.bound_delete_receipt"].description,
  parameters: OriginBoundDeleteInput,
  success: OriginBoundDeleteResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["origin.bound_delete_receipt"]));
export const RemoteReportToolkit = Toolkit.make(
  ReportTool,
  ReceiptTool,
  WaitTool,
  ResolveBindingTool,
  BoundDeleteTool,
  BoundDeleteReceiptTool,
);
