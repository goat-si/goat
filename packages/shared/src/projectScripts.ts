import type { GoatProjectFile, ProjectId, ProjectScript, ServerSettings } from "@goat/contracts";
import { withLegacyEnvNames } from "@goat/contracts/legacyT3Names";

type ProjectScriptSettings = Pick<
  ServerSettings,
  | "defaultProjectScripts"
  | "projectScriptOverrides"
  | "projectSettingsOverrides"
  | "projectSettingsFolded"
>;

export function resolveProjectScripts(
  settings: ProjectScriptSettings,
  project: { id: ProjectId; scripts: readonly ProjectScript[] },
): readonly ProjectScript[] {
  return resolveProjectScriptConfiguration(settings, project).scripts;
}

export function resolveProjectScriptConfiguration(
  settings: ProjectScriptSettings,
  project: { id: ProjectId; scripts: readonly ProjectScript[] },
) {
  const override = settings.projectSettingsOverrides[project.id]?.defaultProjectScripts;
  if (override !== undefined) return { scripts: override, source: "project-override" } as const;
  // Ignoring retired legacy sources prevents a reset from reviving old DB scripts.
  if (!settings.projectSettingsFolded) {
    const legacy = settings.projectScriptOverrides[project.id];
    if (legacy !== undefined)
      return {
        scripts: legacy ?? settings.defaultProjectScripts,
        source: "legacy-override",
      } as const;
    if (project.scripts.length > 0) return { scripts: project.scripts, source: "stored" } as const;
  }
  return {
    scripts: settings.defaultProjectScripts,
    source: settings.defaultProjectScripts.length > 0 ? "defaults" : "unconfigured",
  } as const;
}

/** The setup fallback is separate from persisted actions so edits never import repository commands. */
export function resolveProjectSetupScriptConfiguration(
  configuration: ReturnType<typeof resolveProjectScriptConfiguration>,
  file: GoatProjectFile | null,
) {
  if (configuration.source !== "unconfigured") return configuration;
  const declared = file?.scripts?.find((script) => script.runOnWorktreeCreate);
  if (declared === undefined) return configuration;
  let id = "goat-file-setup";
  for (let suffix = 2; configuration.scripts.some((script) => script.id === id); suffix++) {
    id = `goat-file-setup-${suffix}`;
  }
  return {
    source: "project-file",
    scripts: [
      ...configuration.scripts,
      {
        ...declared,
        id,
        icon: declared.icon ?? "play",
        runOnWorktreeCreate: true,
      } satisfies ProjectScript,
    ],
  } as const;
}

export function projectScriptsInheritDefaults(
  settings: ProjectScriptSettings,
  project: { id: ProjectId; scripts: readonly ProjectScript[] },
): boolean {
  if (settings.projectSettingsOverrides[project.id]?.defaultProjectScripts !== undefined) {
    return false;
  }
  if (settings.projectSettingsFolded) return true;
  const legacy = settings.projectScriptOverrides[project.id];
  return legacy === null || (legacy === undefined && project.scripts.length === 0);
}

interface ProjectScriptRuntimeEnvInput {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
  extraEnv?: Record<string, string>;
}

export function projectScriptCwd(input: {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
}): string {
  return input.worktreePath ?? input.project.cwd;
}

export function projectScriptRuntimeEnv(
  input: ProjectScriptRuntimeEnvInput,
): Record<string, string> {
  const env: Record<string, string> = {
    GOAT_PROJECT_ROOT: input.project.cwd,
  };
  if (input.worktreePath) {
    env.GOAT_WORKTREE_PATH = input.worktreePath;
  }
  // User scripts written before the GOAT rename read the legacy names. Applied after
  // overrides, so an overridden GOAT name carries its value to the legacy one.
  return withLegacyEnvNames(input.extraEnv ? { ...env, ...input.extraEnv } : env);
}

export function setupProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnWorktreeCreate) ?? null;
}

export function projectScriptMenuLabel(script: ProjectScript): string {
  const roles = [
    ...(script.runOnWorktreeCreate ? ["setup"] : []),
    ...(script.runOnSettle ? ["on settle"] : []),
    ...(script.runAsCheck ? ["check"] : []),
  ];
  return roles.length === 0 ? script.name : `${script.name} (${roles.join(", ")})`;
}

export function settleProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnSettle === true) ?? null;
}

/**
 * Leading spaces omit scripts from Bash history with ignorespace/ignoreboth,
 * zsh with HIST_IGNORE_SPACE, and fish. Only the first line is prefixed, so later
 * entries from multiline input may still enter history. PowerShell/PSReadLine history is not suppressed.
 */
export function projectScriptTerminalInput(command: string): string {
  return ` ${command}\r`;
}

export function checkProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runAsCheck === true) ?? null;
}
