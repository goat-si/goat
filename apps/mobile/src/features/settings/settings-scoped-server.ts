import {
  environmentDeliversBuiltInSkill,
  isNullableProjectSettingsOverride,
  MESSAGE_NAMED_BUILTIN_SKILLS,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  type BuiltInSkillName,
  type EnvironmentId,
  type ProjectId,
  type ProjectScopedServerSettingKey,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@goat/contracts";
import {
  builtInSkillEnvironmentPatch,
  builtInSkillProjectPatch,
} from "@goat/client-runtime/built-in-skill-settings";
import {
  clearProjectSettingsOverrides,
  resolveProjectSettings,
} from "@goat/shared/projectSettings";

import type { SettingsTarget } from "./settings-environment-filter";

export interface ScopedMobileSettingsTarget {
  readonly environment: SettingsTarget;
  readonly projectId: ProjectId | null;
  readonly settings: ServerSettings;
  readonly sources: ReturnType<typeof resolveProjectSettings>["sources"];
}

export function resolveMobileSettingsTargets(
  environments: readonly SettingsTarget[],
  members: readonly { readonly environmentId: EnvironmentId; readonly id: ProjectId }[] | null,
): readonly ScopedMobileSettingsTarget[] {
  if (members === null) {
    return environments.map((environment) => ({
      environment,
      projectId: null,
      ...resolveProjectSettings(environment.serverConfig.settings, null),
    }));
  }
  const byId = new Map(environments.map((environment) => [environment.environmentId, environment]));
  return members.flatMap((member) => {
    const environment = byId.get(member.environmentId);
    if (!environment) return [];
    return [
      {
        environment,
        projectId: member.id,
        ...resolveProjectSettings(environment.serverConfig.settings, member.id),
      },
    ];
  });
}

export function planMobileScopedSettingsPatch(
  targets: readonly ScopedMobileSettingsTarget[],
  projectSelected: boolean,
  patch: ServerSettingsPatch,
) {
  if (!projectSelected) {
    return targets.map((target) => ({ environmentId: target.environment.environmentId, patch }));
  }
  const keys = Object.keys(patch);
  if (
    keys.some(
      (key) => !PROJECT_SCOPED_SERVER_SETTING_KEYS.includes(key as ProjectScopedServerSettingKey),
    )
  )
    return [];
  const writes = new Map<EnvironmentId, Record<string, unknown>>();
  for (const target of targets) {
    if (
      target.projectId === null ||
      target.environment.serverConfig.environment.capabilities.projectSettingsOverrides !== true
    )
      continue;
    const current =
      target.environment.serverConfig.settings.projectSettingsOverrides[target.projectId] ?? {};
    const next: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (
        value === null &&
        !isNullableProjectSettingsOverride(key as ProjectScopedServerSettingKey)
      ) {
        delete next[key];
      } else {
        next[key] = value;
      }
    }
    const overrides = writes.get(target.environment.environmentId) ?? {};
    overrides[target.projectId] = next;
    writes.set(target.environment.environmentId, overrides);
  }
  return [...writes].map(([environmentId, projectSettingsOverrides]) => ({
    environmentId,
    patch: { projectSettingsOverrides } as ServerSettingsPatch,
  }));
}

export function uniformMobileSetting<K extends keyof ServerSettings>(
  targets: readonly Pick<ScopedMobileSettingsTarget, "settings">[],
  key: K,
): ServerSettings[K] | null {
  const reference = targets[0];
  if (!reference) return null;
  const value = reference.settings[key];
  return targets.every((target) => target.settings[key] === value) ? value : null;
}

export function planMobileScopedSettingsClear(
  targets: readonly ScopedMobileSettingsTarget[],
  keys: readonly ProjectScopedServerSettingKey[],
  skills: readonly BuiltInSkillName[] = [],
) {
  const writes = new Map<EnvironmentId, Record<string, unknown>>();
  for (const target of targets) {
    if (
      target.projectId === null ||
      target.environment.serverConfig.environment.capabilities.projectSettingsOverrides !== true
    )
      continue;
    const overrides = writes.get(target.environment.environmentId) ?? {};
    let entry = clearProjectSettingsOverrides(
      target.environment.serverConfig.settings,
      target.projectId,
      keys,
    );
    if (
      skills.some((skill) =>
        environmentDeliversBuiltInSkill(
          target.environment.serverConfig.environment.capabilities,
          skill,
        ),
      )
    ) {
      const builtInSkills = { ...entry?.builtInSkills };
      for (const skill of skills) {
        if (
          environmentDeliversBuiltInSkill(
            target.environment.serverConfig.environment.capabilities,
            skill,
          )
        )
          delete builtInSkills[skill];
      }
      entry = { ...entry, builtInSkills };
    }
    overrides[target.projectId] = entry;
    writes.set(target.environment.environmentId, overrides);
  }
  return [...writes].map(([environmentId, projectSettingsOverrides]) => ({
    environmentId,
    patch: { projectSettingsOverrides } as ServerSettingsPatch,
  }));
}

/** A skill a message loads by name, which only a server that lists it delivers. */
const isMessageNamedSkill = (skill: string): skill is BuiltInSkillName =>
  (MESSAGE_NAMED_BUILTIN_SKILLS as ReadonlyArray<string>).includes(skill);

/**
 * Switches one built-in skill on or off in every selected environment. Each environment keeps
 * its own switched-off list, so names written by a newer build survive the toggle.
 */
export function planMobileBuiltInSkillToggle(
  targets: readonly ScopedMobileSettingsTarget[],
  skill: string,
  on: boolean,
) {
  const writes = new Map<EnvironmentId, ServerSettingsPatch>();
  for (const target of targets) {
    if (
      isMessageNamedSkill(skill) &&
      !environmentDeliversBuiltInSkill(
        target.environment.serverConfig.environment.capabilities,
        skill,
      )
    )
      continue;
    writes.set(
      target.environment.environmentId,
      builtInSkillEnvironmentPatch(
        target.environment.serverConfig.settings.disabledBuiltInSkills,
        skill,
        on,
      ),
    );
  }
  return [...writes].map(([environmentId, patch]) => ({ environmentId, patch }));
}

export function planMobileBuiltInSkillProjectPatch(
  targets: readonly ScopedMobileSettingsTarget[],
  skill: string,
  enabled: boolean | undefined,
) {
  const writes = new Map<
    EnvironmentId,
    NonNullable<ServerSettingsPatch["projectSettingsOverrides"]>
  >();
  for (const target of targets) {
    if (
      target.projectId === null ||
      (isMessageNamedSkill(skill) &&
        !environmentDeliversBuiltInSkill(
          target.environment.serverConfig.environment.capabilities,
          skill,
        ))
    )
      continue;
    writes.set(target.environment.environmentId, {
      ...writes.get(target.environment.environmentId),
      ...builtInSkillProjectPatch(
        target.environment.serverConfig.settings,
        [target.projectId],
        skill,
        enabled,
      ),
    });
  }
  return [...writes].map(([environmentId, projectSettingsOverrides]) => ({
    environmentId,
    patch: { projectSettingsOverrides },
  }));
}
