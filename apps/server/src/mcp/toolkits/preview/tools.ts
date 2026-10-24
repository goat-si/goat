import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import {
  OrchestratorMcpFailure,
  ToolActivityIcon,
  PreviewAutomationClickInput,
  PreviewAutomationDialogInput,
  PreviewAutomationDragInput,
  PreviewAutomationError,
  PreviewAutomationEvaluateInput,
  PreviewAutomationHoverInput,
  PreviewAutomationHistoryInput,
  PreviewAutomationLogs,
  PreviewAutomationLogsInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationOpenInput,
  PreviewAutomationPressInput,
  PreviewAutomationRecordingArtifact,
  PreviewAutomationRecordingStatus,
  PreviewAutomationReloadInput,
  PreviewAutomationResizeInput,
  PreviewAutomationResizeResult,
  PreviewAutomationScrollInput,
  PreviewAutomationSelectInput,
  PreviewAutomationSelectResult,
  PreviewAutomationSetColorSchemeInput,
  PreviewAutomationSetColorSchemeResult,
  PreviewAutomationSnapshot,
  PreviewAutomationSnapshotInput,
  PreviewAutomationStatus,
  PreviewAutomationTabTargetInput,
  PreviewAutomationTypeInput,
  PreviewAutomationUploadInput,
  PreviewAutomationWaitForInput,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as ServerConfig from "../../../config.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { withClientRequestId } from "../keyedParameters.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  PreviewAutomationBroker.PreviewAutomationBroker,
];

const PreviewToolFailure = Schema.Union([PreviewAutomationError, OrchestratorMcpFailure]);

const presentationFields = { toolIcon: Schema.optional(ToolActivityIcon) };

const PreviewActionResult = Schema.Struct(presentationFields).annotate({
  description: "The preview action completed successfully.",
});

const PreviewStatusTool = Tool.make(agentSurfaceRegistry["preview.status"].name, {
  description: agentSurfaceRegistry["preview.status"].description,
  parameters: PreviewAutomationTabTargetInput,
  success: PreviewAutomationStatus,
  failure: PreviewToolFailure,
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.status"]));

const PreviewOpenTool = Tool.make(agentSurfaceRegistry["preview.open"].name, {
  description: agentSurfaceRegistry["preview.open"].description,
  parameters: withClientRequestId(PreviewAutomationOpenInput),
  success: PreviewAutomationStatus,
  failure: PreviewToolFailure,
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.open"]));

const PreviewDialogTool = Tool.make(agentSurfaceRegistry["preview.dialog"].name, {
  description: agentSurfaceRegistry["preview.dialog"].description,
  parameters: PreviewAutomationDialogInput,
  success: PreviewAutomationStatus,
  failure: PreviewToolFailure,
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.dialog"]));

const PreviewNavigateTool = Tool.make(agentSurfaceRegistry["preview.navigate"].name, {
  description: agentSurfaceRegistry["preview.navigate"].description,
  parameters: PreviewAutomationNavigateInput,
  success: PreviewAutomationStatus,
  failure: PreviewToolFailure,
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.navigate"]));

const PreviewBackTool = Tool.make(agentSurfaceRegistry["preview.back"].name, {
  description: agentSurfaceRegistry["preview.back"].description,
  parameters: PreviewAutomationHistoryInput,
  success: PreviewAutomationStatus,
  failure: PreviewToolFailure,
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.back"]));

const PreviewForwardTool = Tool.make(agentSurfaceRegistry["preview.forward"].name, {
  description: agentSurfaceRegistry["preview.forward"].description,
  parameters: PreviewAutomationHistoryInput,
  success: PreviewAutomationStatus,
  failure: PreviewToolFailure,
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.forward"]));

const PreviewReloadTool = Tool.make(agentSurfaceRegistry["preview.reload"].name, {
  description: agentSurfaceRegistry["preview.reload"].description,
  parameters: PreviewAutomationReloadInput,
  success: PreviewAutomationStatus,
  failure: PreviewToolFailure,
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.reload"]));

const PreviewResizeTool = Tool.make(agentSurfaceRegistry["preview.resize"].name, {
  description: agentSurfaceRegistry["preview.resize"].description,
  parameters: PreviewAutomationResizeInput,
  success: Schema.Struct({ ...PreviewAutomationResizeResult.fields, ...presentationFields }),
  failure: PreviewToolFailure,
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.resize"]));

const PreviewSetAppearanceTool = Tool.make(agentSurfaceRegistry["preview.set_appearance"].name, {
  description: agentSurfaceRegistry["preview.set_appearance"].description,
  parameters: PreviewAutomationSetColorSchemeInput,
  success: Schema.Struct({
    ...PreviewAutomationSetColorSchemeResult.fields,
    ...presentationFields,
  }),
  failure: PreviewToolFailure,
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.set_appearance"]));

// Not read-only: save=true writes the screenshot to disk.
export const PreviewSnapshotTool = Tool.make(agentSurfaceRegistry["preview.snapshot"].name, {
  description: agentSurfaceRegistry["preview.snapshot"].description,
  parameters: Schema.Struct({
    ...PreviewAutomationSnapshotInput.fields,
    includeImage: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Include the PNG image in the tool response. Defaults to false. Set true only when you need to see the page.",
      }),
    ),
    save: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Write the screenshot PNG to disk and return its absolute path as screenshotPath. Unless includeImage=true, omit the page dump and return url, screenshotPath, and any full-page capture metadata. Defaults to false.",
      }),
    ),
  }),
  success: PreviewAutomationSnapshot,
  failure: PreviewToolFailure,
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.snapshot"]));

const PreviewLogsTool = Tool.make(agentSurfaceRegistry["preview.logs"].name, {
  description: agentSurfaceRegistry["preview.logs"].description,
  parameters: PreviewAutomationLogsInput,
  success: PreviewAutomationLogs,
  failure: PreviewToolFailure,
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.logs"]));

const PreviewClickTool = Tool.make(agentSurfaceRegistry["preview.click"].name, {
  description: agentSurfaceRegistry["preview.click"].description,
  parameters: PreviewAutomationClickInput,
  success: PreviewActionResult,
  failure: PreviewToolFailure,
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.click"]));

const PreviewTypeTool = Tool.make(agentSurfaceRegistry["preview.type"].name, {
  description: agentSurfaceRegistry["preview.type"].description,
  parameters: PreviewAutomationTypeInput,
  success: PreviewActionResult,
  failure: PreviewToolFailure,
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.type"]));

const PreviewHoverTool = Tool.make(agentSurfaceRegistry["preview.hover"].name, {
  description: agentSurfaceRegistry["preview.hover"].description,
  parameters: PreviewAutomationHoverInput,
  success: PreviewActionResult,
  failure: PreviewToolFailure,
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.hover"]));

const PreviewSelectTool = Tool.make(agentSurfaceRegistry["preview.select"].name, {
  description: agentSurfaceRegistry["preview.select"].description,
  parameters: PreviewAutomationSelectInput,
  success: Schema.Struct({
    ...PreviewAutomationSelectResult.fields,
    ...presentationFields,
  }),
  failure: PreviewToolFailure,
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.select"]));

const PreviewDragTool = Tool.make(agentSurfaceRegistry["preview.drag"].name, {
  description: agentSurfaceRegistry["preview.drag"].description,
  parameters: PreviewAutomationDragInput,
  success: PreviewActionResult,
  failure: PreviewToolFailure,
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.drag"]));

const PreviewUploadTool = Tool.make(agentSurfaceRegistry["preview.upload"].name, {
  description: agentSurfaceRegistry["preview.upload"].description,
  parameters: PreviewAutomationUploadInput,
  success: PreviewActionResult,
  failure: PreviewToolFailure,
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.upload"]));

const PreviewPressTool = Tool.make(agentSurfaceRegistry["preview.press"].name, {
  description: agentSurfaceRegistry["preview.press"].description,
  parameters: PreviewAutomationPressInput,
  success: PreviewActionResult,
  failure: PreviewToolFailure,
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.press"]));

const PreviewScrollTool = Tool.make(agentSurfaceRegistry["preview.scroll"].name, {
  description: agentSurfaceRegistry["preview.scroll"].description,
  parameters: PreviewAutomationScrollInput,
  success: PreviewActionResult,
  failure: PreviewToolFailure,
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.scroll"]));

/**
 * MCP `structuredContent` must be a JSON object, and Claude Code rejects the
 * whole result when it is not. Wrapping keeps arrays, strings, numbers, and
 * null valid instead of failing only for non-object expressions.
 */
export const PreviewEvaluateResult = Schema.Struct({
  ...presentationFields,
  value: Schema.Unknown.annotate({
    description: "The JSON-serializable value the expression produced, or null.",
  }),
}).annotate({ description: "The evaluated expression result." });

const PreviewEvaluateTool = Tool.make(agentSurfaceRegistry["preview.evaluate"].name, {
  description: agentSurfaceRegistry["preview.evaluate"].description,
  parameters: PreviewAutomationEvaluateInput,
  success: PreviewEvaluateResult,
  failure: PreviewToolFailure,
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.evaluate"]));

const PreviewWaitForTool = Tool.make(agentSurfaceRegistry["preview.wait"].name, {
  description: agentSurfaceRegistry["preview.wait"].description,
  parameters: PreviewAutomationWaitForInput,
  success: PreviewActionResult,
  failure: PreviewToolFailure,
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.wait"]));

const PreviewRecordingStartTool = Tool.make(agentSurfaceRegistry["preview.recording_start"].name, {
  description: agentSurfaceRegistry["preview.recording_start"].description,
  parameters: PreviewAutomationTabTargetInput,
  success: Schema.Struct({ ...PreviewAutomationRecordingStatus.fields, ...presentationFields }),
  failure: PreviewToolFailure,
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.recording_start"]));

const PreviewRecordingStopTool = Tool.make(agentSurfaceRegistry["preview.recording_stop"].name, {
  description: agentSurfaceRegistry["preview.recording_stop"].description,
  parameters: PreviewAutomationTabTargetInput,
  success: Schema.Struct({ ...PreviewAutomationRecordingArtifact.fields, ...presentationFields }),
  failure: PreviewToolFailure,
  dependencies: [...dependencies, FileSystem.FileSystem, ServerConfig.ServerConfig],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.recording_stop"]));

export const PreviewToolkit = Toolkit.make(
  PreviewDialogTool,
  PreviewStatusTool,
  PreviewOpenTool,
  PreviewNavigateTool,
  PreviewBackTool,
  PreviewForwardTool,
  PreviewReloadTool,
  PreviewResizeTool,
  PreviewSetAppearanceTool,
  PreviewSnapshotTool,
  PreviewLogsTool,
  PreviewClickTool,
  PreviewTypeTool,
  PreviewHoverTool,
  PreviewSelectTool,
  PreviewDragTool,
  PreviewUploadTool,
  PreviewPressTool,
  PreviewScrollTool,
  PreviewEvaluateTool,
  PreviewWaitForTool,
  PreviewRecordingStartTool,
  PreviewRecordingStopTool,
);

export const PreviewStandardToolkit = Toolkit.make(
  PreviewLogsTool,
  PreviewDialogTool,
  PreviewStatusTool,
  PreviewOpenTool,
  PreviewNavigateTool,
  PreviewBackTool,
  PreviewForwardTool,
  PreviewReloadTool,
  PreviewResizeTool,
  PreviewSetAppearanceTool,
  PreviewClickTool,
  PreviewTypeTool,
  PreviewHoverTool,
  PreviewSelectTool,
  PreviewDragTool,
  PreviewUploadTool,
  PreviewPressTool,
  PreviewScrollTool,
  PreviewEvaluateTool,
  PreviewWaitForTool,
  PreviewRecordingStartTool,
  PreviewRecordingStopTool,
);

export const PreviewSnapshotToolkit = Toolkit.make(PreviewSnapshotTool);
