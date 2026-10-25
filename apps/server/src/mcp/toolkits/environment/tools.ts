import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import {
  AutomationHold,
  BackgroundActivityProfile,
  BackgroundActivityProfileSelection,
  ExecutionEnvironmentDescriptor,
  OrchestratorMcpFailure,
  ProjectId,
  ServerSettings,
  ServerSettingsPatch,
  StandingInstructions,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const PreferenceFields = {
  defaultThreadEnvMode: ServerSettings.fields.defaultThreadEnvMode,
  newWorktreesStartFromOrigin: ServerSettings.fields.newWorktreesStartFromOrigin,
  enableProviderUpdateChecks: ServerSettings.fields.enableProviderUpdateChecks,
  backgroundActivity: Schema.Struct({ profile: BackgroundActivityProfileSelection }),
  sourceControlWritingStyle: Schema.Struct({
    mode: Schema.String,
    followChangeRequestTemplates: Schema.Boolean,
    customInstructions: Schema.String,
    truncated: Schema.Boolean,
  }),
  /** Prepended to the first message of threads agents launch here; empty for none. */
  standingInstructions: Schema.String,
  /** Per-project replacements for standingInstructions; an empty one turns them off. */
  projectStandingInstructions: Schema.Record(ProjectId, Schema.String),
};
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerEnvironment.ServerEnvironment,
    Settings.ServerSettingsService,
    ThreadCommandExecutor.ThreadCommandExecutor,
  ],
};
const EnvironmentReadTool = Tool.make(agentSurfaceRegistry["environment.read"].name, {
  ...shared,
  description: agentSurfaceRegistry["environment.read"].description,
  success: Schema.Struct({
    environmentId: ExecutionEnvironmentDescriptor.fields.environmentId,
    label: Schema.String,
    serverVersion: Schema.String,
    platform: ExecutionEnvironmentDescriptor.fields.platform,
    preferences: Schema.Struct(PreferenceFields),
    automationHold: Schema.NullOr(AutomationHold),
  }),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["environment.read"]));
const EnvironmentPreferencesTool = Tool.make(
  agentSurfaceRegistry["environment.preferences_update"].name,
  {
    ...shared,
    description: agentSurfaceRegistry["environment.preferences_update"].description,
    parameters: Schema.Struct({
      defaultThreadEnvMode: ServerSettingsPatch.fields.defaultThreadEnvMode,
      newWorktreesStartFromOrigin: ServerSettingsPatch.fields.newWorktreesStartFromOrigin,
      enableProviderUpdateChecks: ServerSettingsPatch.fields.enableProviderUpdateChecks,
      backgroundActivity: Schema.optionalKey(Schema.Struct({ profile: BackgroundActivityProfile })),
      sourceControlWritingStyle: ServerSettingsPatch.fields.sourceControlWritingStyle,
      standingInstructions: ServerSettingsPatch.fields.standingInstructions,
      projectStandingInstructions: Schema.optionalKey(
        Schema.Record(ProjectId, Schema.NullOr(StandingInstructions)),
      ),
    }),
    success: Schema.Struct(PreferenceFields),
  },
).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["environment.preferences_update"]));
export const EnvironmentToolkit = Toolkit.make(EnvironmentReadTool, EnvironmentPreferencesTool);
