import type { ProjectId, ProjectSettingsOverrides, ServerSettings } from "@goat/contracts";

export function builtInSkillProjectPatch(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
  projectIds: readonly ProjectId[],
  name: string,
  enabled: boolean | undefined,
): Record<ProjectId, ProjectSettingsOverrides> {
  return Object.fromEntries(
    projectIds.map((projectId) => {
      const current = settings.projectSettingsOverrides[projectId] ?? {};
      const builtInSkills = { ...current.builtInSkills };
      if (enabled === undefined) {
        delete builtInSkills[name];
      } else {
        builtInSkills[name] = { ...builtInSkills[name], enabled };
      }
      // An explicit empty map clears the last skill; null preserves it for older clients.
      return [projectId, { ...current, builtInSkills }];
    }),
  );
}

export function builtInSkillEnvironmentPatch(
  disabled: readonly string[],
  name: string,
  enabled: boolean,
): { disabledBuiltInSkills: string[] } {
  const others = disabled.filter((entry) => entry !== name);
  return { disabledBuiltInSkills: enabled ? others : [...others, name] };
}
