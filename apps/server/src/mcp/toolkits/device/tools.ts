import {
  DeviceToolCloseInput,
  DeviceToolError,
  DeviceToolListResult,
  DeviceToolOpenInput,
  DeviceToolOpenResult,
  DeviceToolScreenshotResult,
  DeviceToolTargetInput,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { Tool, Toolkit } from "effect/ai";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../../../config.ts";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";

import * as DeviceService from "../../../device/DeviceService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { withClientRequestId } from "../keyedParameters.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  DeviceService.DeviceService,
  // Each call reads the thread's project to authorize Agent device access.
  ProjectService.ProjectService,
  ServerSettings.ServerSettingsService,
];

const DeviceToolFailure = Schema.Union([DeviceToolError, OrchestratorMcpFailure]);

const DeviceListTool = Tool.make(agentSurfaceRegistry["device.list"].name, {
  description: agentSurfaceRegistry["device.list"].description,
  // An empty struct serializes as `anyOf [object, array]`, which some
  // providers reject and then drop every tool on the server with it.
  parameters: Schema.Struct({
    hostId: Schema.optional(
      Schema.String.annotate({ description: "Limit to one device host. Defaults to all hosts." }),
    ),
  }),
  success: DeviceToolListResult,
  failure: DeviceToolFailure,
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["device.list"]));

const DeviceOpenTool = Tool.make(agentSurfaceRegistry["device.open"].name, {
  description: agentSurfaceRegistry["device.open"].description,
  parameters: withClientRequestId(DeviceToolOpenInput),
  success: DeviceToolOpenResult,
  failure: DeviceToolFailure,
  dependencies: [...dependencies, FileSystem.FileSystem, Path.Path, ServerConfig.ServerConfig],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["device.open"]));

export const DeviceScreenshotTool = Tool.make(agentSurfaceRegistry["device.screenshot"].name, {
  description: agentSurfaceRegistry["device.screenshot"].description,
  parameters: DeviceToolTargetInput,
  success: DeviceToolScreenshotResult,
  failure: DeviceToolFailure,
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["device.screenshot"]));

const DeviceCloseTool = Tool.make(agentSurfaceRegistry["device.close"].name, {
  description: agentSurfaceRegistry["device.close"].description,
  parameters: DeviceToolCloseInput,
  success: Schema.Record(Schema.String, Schema.Never).annotate({
    description: "The device was closed.",
  }),
  failure: DeviceToolFailure,
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["device.close"]));

export const DeviceStandardToolkit = Toolkit.make(DeviceListTool, DeviceOpenTool, DeviceCloseTool);

export const DeviceScreenshotToolkit = Toolkit.make(DeviceScreenshotTool);

export const DeviceToolkit = Toolkit.make(
  DeviceListTool,
  DeviceOpenTool,
  DeviceScreenshotTool,
  DeviceCloseTool,
);
