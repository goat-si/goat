import {
  OrchestratorMcpFailure,
  type ProjectId,
  type ProjectSettingsOverrides,
  type ServerSettings,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as AutomationHold from "../../../automationHold.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { EnvironmentToolkit } from "./tools.ts";

export function preferences(settings: ServerSettings) {
  const {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity,
    sourceControlWritingStyle,
    standingInstructions,
    projectSettingsOverrides,
  } = settings;
  const characters = Array.from(sourceControlWritingStyle.customInstructions);
  const projectStandingInstructions: Record<ProjectId, string> = {};
  for (const [projectId, overrides] of Object.entries(projectSettingsOverrides)) {
    if (overrides.standingInstructions !== undefined)
      projectStandingInstructions[projectId as ProjectId] = overrides.standingInstructions;
  }
  return {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity: { profile: backgroundActivity.profile },
    sourceControlWritingStyle: {
      ...sourceControlWritingStyle,
      customInstructions: characters.slice(0, 4000).join(""),
      truncated: characters.length > 4000,
    },
    standingInstructions,
    projectStandingInstructions,
  };
}

/**
 * Project override entries that set or remove only standingInstructions,
 * keeping each project's other overrides; a patch entry replaces the whole set.
 */
function projectStandingInstructionsPatch(
  current: ServerSettings["projectSettingsOverrides"],
  changes: Readonly<Record<ProjectId, string | null>>,
): Record<ProjectId, ProjectSettingsOverrides | null> {
  const entries: Record<ProjectId, ProjectSettingsOverrides | null> = {};
  for (const [key, value] of Object.entries(changes)) {
    const projectId = key as ProjectId;
    const { standingInstructions: _previous, ...rest } = current[projectId] ?? {};
    const next: ProjectSettingsOverrides =
      value === null ? rest : { ...rest, standingInstructions: value };
    entries[projectId] = Object.keys(next).length === 0 ? null : next;
  }
  return entries;
}
const access = Effect.gen(function* () {
  const context = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== context.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  return { ...context, descriptor, settings: yield* Settings.ServerSettingsService };
});
export const layer = McpToolAccess.toLayer(EnvironmentToolkit, {
  goat_environment_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { descriptor, settings } = yield* access;
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        serverVersion: descriptor.serverVersion,
        platform: descriptor.platform,
        preferences: preferences(current),
        automationHold: yield* (yield* AutomationHold.AutomationHold).current,
      };
    }),
  ),
  goat_environment_preferences_update: McpToolAccess.destructive(
    McpToolAccess.writesEnvironment((input, check) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        const update = Effect.gen(function* () {
          // The turn may have ended, or the thread's modes changed, while this waited for the lock.
          yield* check;
          const { settings } = yield* access;
          const { projectStandingInstructions, ...patch } = input;
          const projectSettingsOverrides =
            projectStandingInstructions === undefined
              ? undefined
              : projectStandingInstructionsPatch(
                  (yield* settings.getSettings.pipe(Effect.mapError(unavailable)))
                    .projectSettingsOverrides,
                  projectStandingInstructions,
                );
          return preferences(
            yield* settings
              .updateSettings(
                projectSettingsOverrides === undefined
                  ? patch
                  : { ...patch, projectSettingsOverrides },
              )
              .pipe(Effect.mapError(unavailable)),
          );
        });
        return yield* scope.thread === undefined
          ? update
          : executor.withLock(scope.thread.threadId, update);
      }),
    ),
  ),
});
