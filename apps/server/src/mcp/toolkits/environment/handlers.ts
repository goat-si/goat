import {
  OrchestratorMcpFailure,
  type ProjectId,
  type ProjectSettingsOverrides,
  ServerSettings as ServerSettingsSchema,
  ServerSettingsError,
  ServerSettingsPatch,
  type ServerSettings,
} from "@goat/contracts";
import { SETTINGS_ACCESS, type SettingsKey } from "@goat/contracts/agentSurface";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
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

const isSettingsKey = (key: string): key is SettingsKey => Object.hasOwn(SETTINGS_ACCESS, key);
const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const encodeSettings = Schema.encodeUnknownEffect(ServerSettingsSchema);
const decodePatch = Schema.decodeUnknownEffect(ServerSettingsPatch);

/** The JSON schema of one setting's value, as goat_environment_settings_update decodes it. */
function settingSchema(key: SettingsKey): unknown {
  const document = Schema.toJsonSchemaDocument(
    Schema.Struct({ [key]: ServerSettingsPatch.fields[key] }),
  );
  const properties = (document.schema as { readonly properties?: Record<string, unknown> })
    .properties;
  const value = properties?.[key] ?? {};
  return Object.keys(document.definitions).length === 0
    ? value
    : { ...(value as object), $defs: document.definitions };
}

/** Settings as clients see them: secrets redacted, values encoded for the wire. */
const visibleSettings = (settings: ServerSettings) =>
  encodeSettings(Settings.redactServerSettingsForClient(settings)).pipe(
    Effect.map((encoded) => encoded as Readonly<Record<string, unknown>>),
    Effect.mapError(unavailable),
  );

function settingEntry(
  key: SettingsKey,
  visible: Readonly<Record<string, unknown>>,
  withSchema: boolean,
) {
  const rule = SETTINGS_ACCESS[key];
  return {
    key,
    access: rule.access,
    ...(rule.access === "agent" && Object.hasOwn(visible, key) ? { value: visible[key] } : {}),
    ...(rule.access === "path" ? { path: rule.path } : {}),
    ...(rule.access === "person" ? { reason: rule.reason } : {}),
    ...(withSchema ? { schema: settingSchema(key) } : {}),
  };
}

/** Every key a patch may not carry, with the path to use or the reason a person must act. */
function refusedKeys(patch: Readonly<Record<string, unknown>>) {
  const refusals: Array<{
    readonly code: "invalid_request" | "capability_denied";
    readonly text: string;
  }> = [];
  for (const key of Object.keys(patch)) {
    if (!isSettingsKey(key)) {
      refusals.push({
        code: "invalid_request",
        text: `${key} is not a setting; goat_environment_settings_read lists every setting.`,
      });
      continue;
    }
    const rule = SETTINGS_ACCESS[key];
    if (rule.access === "path")
      refusals.push({ code: "invalid_request", text: `${key} is changed through ${rule.path}.` });
    if (rule.access === "person")
      refusals.push({
        code: "capability_denied",
        text: `${key} is changed only by a person in Settings: ${rule.reason}`,
      });
  }
  return refusals;
}

/** settingsPath of the error the commit-time grant check raises, told apart from real failures. */
const CLIENT_REVOKED = "mcp:settings-update-client-revoked";
const clientDenied = () =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: "Changing settings needs a full-access client with live settings:write access.",
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
  goat_environment_settings_read: McpToolAccess.reads(({ keys }) =>
    Effect.gen(function* () {
      const unknown = (keys ?? []).filter((key) => !isSettingsKey(key));
      if (unknown.length > 0)
        return yield* invalid(
          `Not settings: ${unknown.join(", ")}. Omit keys to list every setting.`,
        );
      const { settings } = yield* access;
      const visible = yield* visibleSettings(
        yield* settings.getSettings.pipe(Effect.mapError(unavailable)),
      );
      const selected = (keys as ReadonlyArray<SettingsKey> | undefined) ?? [];
      return {
        settings:
          keys === undefined
            ? (Object.keys(SETTINGS_ACCESS) as ReadonlyArray<SettingsKey>).map((key) =>
                settingEntry(key, visible, false),
              )
            : selected.map((key) => settingEntry(key, visible, true)),
      };
    }),
  ),
  goat_environment_settings_update: McpToolAccess.destructive(
    McpToolAccess.writesEnvironment(({ patch }, check) =>
      Effect.gen(function* () {
        const keys = Object.keys(patch);
        if (keys.length === 0) return yield* invalid("patch names no setting.");
        const refusals = refusedKeys(patch);
        if (refusals.length > 0)
          return yield* new OrchestratorMcpFailure({
            code: refusals.some((refusal) => refusal.code === "capability_denied")
              ? "capability_denied"
              : "invalid_request",
            message: `Nothing was changed. ${refusals.map((refusal) => refusal.text).join(" ")}`,
          });
        const decoded = yield* decodePatch(patch, { onExcessProperty: "error" }).pipe(
          Effect.mapError((error) => invalid(`Nothing was changed. ${error.message}`)),
        );
        const scope = yield* McpInvocationContext.McpInvocationContext;
        // A thread caller is bounded by its own modes and profile; a client by its live grant.
        let authorizeAtCommit: Effect.Effect<void, ServerSettingsError> | undefined;
        if (scope.thread === undefined) {
          const reauthorize = scope.reauthorize;
          if (!scope.grantedScopes?.includes("settings:write") || reauthorize === undefined)
            return yield* clientDenied();
          yield* reauthorize(["settings:write"]).pipe(Effect.mapError(clientDenied));
          authorizeAtCommit = reauthorize(["settings:write"]).pipe(
            Effect.mapError(
              () =>
                new ServerSettingsError({
                  settingsPath: CLIENT_REVOKED,
                  operation: "write-file",
                }),
            ),
          );
        }
        const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        const update = Effect.gen(function* () {
          // The turn may have ended, or the thread's modes changed, while this waited for the lock.
          yield* check;
          const { settings } = yield* access;
          const next = yield* settings
            .updateSettings(decoded, authorizeAtCommit)
            .pipe(
              Effect.mapError((error) =>
                error.settingsPath === CLIENT_REVOKED ? clientDenied() : unavailable(),
              ),
            );
          const visible = yield* visibleSettings(next);
          return {
            settings: (keys as ReadonlyArray<SettingsKey>).map((key) =>
              settingEntry(key, visible, false),
            ),
          };
        });
        return yield* scope.thread === undefined
          ? update
          : executor.withLock(scope.thread.threadId, update);
      }),
    ),
  ),
});
