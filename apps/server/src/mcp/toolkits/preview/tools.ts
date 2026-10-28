import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import {
  ActionOutcomeSafety,
  OrchestratorMcpFailure,
  ToolActivityIcon,
  PreviewAutomationClickInput,
  PreviewAutomationDialogInput,
  PreviewAutomationDragInput,
  PreviewAutomationError,
  PreviewAutomationEvaluateInput,
  PreviewAutomationFetchInput,
  PreviewAutomationFetchResult,
  PreviewAutomationFillSecretInput,
  PreviewAutomationFillSecretResult,
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
  PreviewAutomationScrollCollectInput,
  PreviewAutomationScrollCollectResult,
  PreviewAutomationScrollInput,
  PreviewAutomationSelectInput,
  PreviewAutomationSelectResult,
  PreviewAutomationSetColorSchemeInput,
  PreviewAutomationSetColorSchemeResult,
  PreviewAutomationSnapshot,
  PreviewAutomationRead,
  PreviewAutomationReadInput,
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

const safetyFields = { safety: Schema.optionalKey(ActionOutcomeSafety) };
const presentationFields = {
  toolIcon: Schema.optional(ToolActivityIcon),
  next: Schema.optional(Schema.String),
  ...safetyFields,
};

const PreviewActionResult = Schema.Struct(presentationFields);
const PreviewClickResult = Schema.Struct({
  ...presentationFields,
  /** What the server browser saw change right after the click; absent from other hosts. */
  effect: Schema.optional(Schema.Literals(["confirmed", "suspected_noop"])),
  evidence: Schema.optional(Schema.Array(Schema.String)),
});
/** The browser skill's path on a thread's first visit and a site's notes on its first visit there. */
const guideFields = { guide: Schema.optional(Schema.String) };

const PreviewStatusTool = Tool.make(agentSurfaceRegistry["preview.status"].name, {
  description: agentSurfaceRegistry["preview.status"].description,
  parameters: PreviewAutomationTabTargetInput,
  success: Schema.Struct({
    ...PreviewAutomationStatus.fields,
    next: Schema.optional(Schema.String),
    ...safetyFields,
  }),
  failure: PreviewToolFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.status"]));

const PreviewOpenTool = Tool.make(agentSurfaceRegistry["preview.open"].name, {
  description: agentSurfaceRegistry["preview.open"].description,
  parameters: withClientRequestId(PreviewAutomationOpenInput),
  success: Schema.Struct({
    ...PreviewAutomationStatus.fields,
    next: Schema.optional(Schema.String),
    ...guideFields,
    ...safetyFields,
  }),
  failure: PreviewToolFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.open"]));

const PreviewDialogTool = Tool.make(agentSurfaceRegistry["preview.dialog"].name, {
  description: agentSurfaceRegistry["preview.dialog"].description,
  parameters: PreviewAutomationDialogInput,
  success: Schema.Struct({
    ...PreviewAutomationStatus.fields,
    next: Schema.optional(Schema.String),
    ...safetyFields,
  }),
  failure: PreviewToolFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.dialog"]));

const PreviewNavigateTool = Tool.make(agentSurfaceRegistry["preview.navigate"].name, {
  description: agentSurfaceRegistry["preview.navigate"].description,
  parameters: PreviewAutomationNavigateInput,
  success: Schema.Struct({
    ...PreviewAutomationStatus.fields,
    next: Schema.optional(Schema.String),
    ...guideFields,
    ...safetyFields,
  }),
  failure: PreviewToolFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.navigate"]));

const PreviewBackTool = Tool.make(agentSurfaceRegistry["preview.back"].name, {
  description: agentSurfaceRegistry["preview.back"].description,
  parameters: PreviewAutomationHistoryInput,
  success: Schema.Struct({
    ...PreviewAutomationStatus.fields,
    next: Schema.optional(Schema.String),
    ...safetyFields,
  }),
  failure: PreviewToolFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.back"]));

const PreviewForwardTool = Tool.make(agentSurfaceRegistry["preview.forward"].name, {
  description: agentSurfaceRegistry["preview.forward"].description,
  parameters: PreviewAutomationHistoryInput,
  success: Schema.Struct({
    ...PreviewAutomationStatus.fields,
    next: Schema.optional(Schema.String),
    ...safetyFields,
  }),
  failure: PreviewToolFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.forward"]));

const PreviewReloadTool = Tool.make(agentSurfaceRegistry["preview.reload"].name, {
  description: agentSurfaceRegistry["preview.reload"].description,
  parameters: PreviewAutomationReloadInput,
  success: Schema.Struct({
    ...PreviewAutomationStatus.fields,
    next: Schema.optional(Schema.String),
    ...safetyFields,
  }),
  failure: PreviewToolFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.reload"]));

const PreviewResizeTool = Tool.make(agentSurfaceRegistry["preview.resize"].name, {
  description: agentSurfaceRegistry["preview.resize"].description,
  parameters: PreviewAutomationResizeInput,
  success: Schema.Struct({ ...PreviewAutomationResizeResult.fields, ...presentationFields }),
  failure: PreviewToolFailure,
  failureMode: "return",
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
  failureMode: "return",
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
  success: Schema.Struct({ ...PreviewAutomationSnapshot.fields, ...safetyFields }),
  failure: PreviewToolFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.snapshot"]));

const PreviewLogsTool = Tool.make(agentSurfaceRegistry["preview.logs"].name, {
  description: agentSurfaceRegistry["preview.logs"].description,
  parameters: PreviewAutomationLogsInput,
  success: Schema.Struct({ ...PreviewAutomationLogs.fields, ...safetyFields }),
  failure: PreviewToolFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.logs"]));

const PreviewReadTool = Tool.make(agentSurfaceRegistry["preview.read"].name, {
  description: agentSurfaceRegistry["preview.read"].description,
  parameters: PreviewAutomationReadInput,
  success: Schema.Struct({ ...PreviewAutomationRead.fields, ...guideFields }),
  failure: PreviewToolFailure,
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.read"]));

const PreviewFetchTool = Tool.make(agentSurfaceRegistry["preview.fetch"].name, {
  description: agentSurfaceRegistry["preview.fetch"].description,
  parameters: PreviewAutomationFetchInput,
  success: Schema.Struct({ ...PreviewAutomationFetchResult.fields, ...presentationFields }),
  failure: PreviewToolFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.fetch"]));

const PreviewFillSecretTool = Tool.make(agentSurfaceRegistry["preview.fill_secret"].name, {
  description: agentSurfaceRegistry["preview.fill_secret"].description,
  parameters: PreviewAutomationFillSecretInput,
  success: Schema.Struct({ ...PreviewAutomationFillSecretResult.fields, ...safetyFields }),
  failure: PreviewToolFailure,
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.fill_secret"]));

const PreviewScrollCollectTool = Tool.make(agentSurfaceRegistry["preview.scroll_collect"].name, {
  description: agentSurfaceRegistry["preview.scroll_collect"].description,
  parameters: PreviewAutomationScrollCollectInput,
  success: Schema.Struct({ ...PreviewAutomationScrollCollectResult.fields, ...presentationFields }),
  failure: PreviewToolFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.scroll_collect"]));

const PreviewClickTool = Tool.make(agentSurfaceRegistry["preview.click"].name, {
  description: agentSurfaceRegistry["preview.click"].description,
  parameters: PreviewAutomationClickInput,
  success: PreviewClickResult,
  failure: PreviewToolFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.click"]));

const PreviewTypeTool = Tool.make(agentSurfaceRegistry["preview.type"].name, {
  description: agentSurfaceRegistry["preview.type"].description,
  parameters: PreviewAutomationTypeInput,
  success: PreviewActionResult,
  failure: PreviewToolFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.type"]));

const PreviewHoverTool = Tool.make(agentSurfaceRegistry["preview.hover"].name, {
  description: agentSurfaceRegistry["preview.hover"].description,
  parameters: PreviewAutomationHoverInput,
  success: PreviewActionResult,
  failure: PreviewToolFailure,
  failureMode: "return",
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
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.select"]));

const PreviewDragTool = Tool.make(agentSurfaceRegistry["preview.drag"].name, {
  description: agentSurfaceRegistry["preview.drag"].description,
  parameters: PreviewAutomationDragInput,
  success: PreviewActionResult,
  failure: PreviewToolFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.drag"]));

const PreviewUploadTool = Tool.make(agentSurfaceRegistry["preview.upload"].name, {
  description: agentSurfaceRegistry["preview.upload"].description,
  parameters: PreviewAutomationUploadInput,
  success: PreviewActionResult,
  failure: PreviewToolFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.upload"]));

const PreviewPressTool = Tool.make(agentSurfaceRegistry["preview.press"].name, {
  description: agentSurfaceRegistry["preview.press"].description,
  parameters: PreviewAutomationPressInput,
  success: PreviewActionResult,
  failure: PreviewToolFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.press"]));

const PreviewScrollTool = Tool.make(agentSurfaceRegistry["preview.scroll"].name, {
  description: agentSurfaceRegistry["preview.scroll"].description,
  parameters: PreviewAutomationScrollInput,
  success: PreviewActionResult,
  failure: PreviewToolFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.scroll"]));

/** Wrap non-objects: MCP requires object structuredContent, and Claude Code rejects invalid results entirely. */
export const PreviewEvaluateResult = Schema.Struct({
  ...presentationFields,
  value: Schema.Unknown.annotate({
    description: "The JSON-serializable value the expression produced, or null.",
  }),
});

const PreviewEvaluateTool = Tool.make(agentSurfaceRegistry["preview.evaluate"].name, {
  description: agentSurfaceRegistry["preview.evaluate"].description,
  parameters: PreviewAutomationEvaluateInput,
  success: PreviewEvaluateResult,
  failure: PreviewToolFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.evaluate"]));

const PreviewWaitForTool = Tool.make(agentSurfaceRegistry["preview.wait"].name, {
  description: agentSurfaceRegistry["preview.wait"].description,
  parameters: PreviewAutomationWaitForInput,
  success: PreviewActionResult,
  failure: PreviewToolFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.wait"]));

const PreviewRecordingStartTool = Tool.make(agentSurfaceRegistry["preview.recording_start"].name, {
  description: agentSurfaceRegistry["preview.recording_start"].description,
  parameters: PreviewAutomationTabTargetInput,
  success: Schema.Struct({ ...PreviewAutomationRecordingStatus.fields, ...presentationFields }),
  failure: PreviewToolFailure,
  failureMode: "return",
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.recording_start"]));

const PreviewRecordingStopTool = Tool.make(agentSurfaceRegistry["preview.recording_stop"].name, {
  description: agentSurfaceRegistry["preview.recording_stop"].description,
  parameters: PreviewAutomationTabTargetInput,
  success: Schema.Struct({ ...PreviewAutomationRecordingArtifact.fields, ...presentationFields }),
  failure: PreviewToolFailure,
  failureMode: "return",
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
  PreviewFetchTool,
  PreviewReadTool,
  PreviewScrollCollectTool,
  PreviewClickTool,
  PreviewTypeTool,
  PreviewFillSecretTool,
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
  PreviewFetchTool,
  PreviewReadTool,
  PreviewScrollCollectTool,
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
  PreviewFillSecretTool,
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
