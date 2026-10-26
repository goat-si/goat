import {
  BUILTIN_SKILL_PROVIDER_DRIVERS,
  BUILTIN_SKILL_SCOPE,
  BUILTIN_SKILLS,
  COMPUTER_USE_PROVIDER_DRIVERS,
  type ProjectId,
  resolveProjectBuiltInSkillEnabled,
  isProviderWorkspaceSnapshotCurrent,
  type ServerProvider,
  type ServerSettings,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@goat/contracts";

export type ProviderSkillSourceKind =
  | "builtin"
  | "app"
  | "repo"
  | "project"
  | "personal"
  | "system"
  | "other";

function normalizePathSeparators(pathValue: string): string {
  return pathValue.replaceAll("\\", "/");
}

export function dedupeProviderSkillsByName(
  skills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSkill[] {
  const seenNames = new Set<string>();
  return skills.filter((skill) => {
    const normalizedName = skill.name.trim().toLowerCase();
    if (seenNames.has(normalizedName)) {
      return false;
    }
    seenNames.add(normalizedName);
    return true;
  });
}

/**
 * A skill switched off in the provider's settings will not run, and one the
 * provider reserves for the agent (Claude Code's `user-invocable: false`)
 * rejects a user invocation. Everything else, including skills the agent may
 * not start on its own, is fair game: the server dispatches the pick in the
 * provider's native form.
 */
export function isProviderSkillUserInvocable(
  skill: Pick<ServerProviderSkill, "enabled" | "userInvocable">,
): boolean {
  return skill.enabled && skill.userInvocable !== false;
}

export function getProviderSkillsForSlashMenu(
  skills: ReadonlyArray<ServerProviderSkill>,
  showSkillsInSlashMenu: boolean,
): ServerProviderSkill[] {
  return showSkillsInSlashMenu
    ? dedupeProviderSkillsByName(skills.filter(isProviderSkillUserInvocable))
    : [];
}

export function getProviderSlashCommandsForSlashMenu(
  slashCommands: ReadonlyArray<ServerProviderSlashCommand>,
  visibleSkills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSlashCommand[] {
  const skillNames = new Set(visibleSkills.map((skill) => skill.name.trim().toLowerCase()));
  return slashCommands.filter((command) => !skillNames.has(command.name.trim().toLowerCase()));
}

export function resolveProviderSkillSourceKind(
  skill: Pick<ServerProviderSkill, "path" | "scope">,
): ProviderSkillSourceKind {
  const normalizedPath = normalizePathSeparators(skill.path);
  if (normalizedPath.includes("/.codex/plugins/") || normalizedPath.includes("/.agents/plugins/")) {
    return "app";
  }

  const normalizedScope = skill.scope?.trim().toLowerCase();
  switch (normalizedScope) {
    case BUILTIN_SKILL_SCOPE:
      return "builtin";
    case "repo":
    case "repository":
      return "repo";
    case "project":
    case "workspace":
    case "local":
      return "project";
    case "user":
    case "personal":
      return "personal";
    case "system":
      return "system";
    case undefined:
    case "":
      return "other";
    default:
      return "other";
  }
}

function resolveProviderWorkspaceSnapshot(
  provider: ServerProvider,
  cwd: string | null | undefined,
) {
  if (!cwd) return undefined;
  return provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd);
}

export function hasCompleteProviderWorkspaceSnapshot(
  provider: ServerProvider | null | undefined,
  cwd: string | null | undefined,
): boolean {
  const snapshot = provider && resolveProviderWorkspaceSnapshot(provider, cwd);
  return Boolean(snapshot && !snapshot.slashCommandsPending);
}

export function hasCurrentProviderWorkspaceSnapshot(
  provider: ServerProvider | null | undefined,
  cwd: string | null | undefined,
  nowMs: number,
): boolean {
  const snapshot = provider && resolveProviderWorkspaceSnapshot(provider, cwd);
  return Boolean(
    snapshot &&
    !snapshot.slashCommandsPending &&
    isProviderWorkspaceSnapshotCurrent(snapshot, nowMs),
  );
}

export function resolveProviderSkillsForCwd(
  provider: ServerProvider,
  cwd: string | null | undefined,
): ServerProvider["skills"] {
  return resolveProviderWorkspaceSnapshot(provider, cwd)?.skills ?? provider.skills;
}

type BuiltInSkillSettings = Pick<ServerSettings, "enableCua" | "disabledBuiltInSkills"> &
  Partial<Pick<ServerSettings, "projectSettingsOverrides">>;

/** Where the skills are offered: the destination server's support and the thread's project. */
export interface BuiltInSkillTarget {
  /** The destination environment advertises `devDisciplineSkill`. */
  readonly devDisciplineSkill?: boolean | undefined;
  readonly projectId?: ProjectId | null | undefined;
}

/**
 * Adds GOAT's built-in skills that this provider's turns can carry. They come last, so a skill
 * of the same name the person wrote wins when the menu dedupes by name. A skill switched off in
 * Settings, for the environment or the thread's project, is listed as disabled, which keeps it
 * out of the menu. Computer Use needs computer use on; goat-discipline needs a server that
 * delivers it.
 */
export function withBuiltInProviderSkills(
  skills: ReadonlyArray<ServerProviderSkill>,
  provider: Pick<ServerProvider, "driver"> | null | undefined,
  settings: BuiltInSkillSettings | null | undefined,
  target?: BuiltInSkillTarget,
): ReadonlyArray<ServerProviderSkill> {
  if (!provider || !settings) return skills;
  const offered = BUILTIN_SKILLS.filter((skill) =>
    skill.capability === "computer-use"
      ? settings.enableCua && COMPUTER_USE_PROVIDER_DRIVERS.has(provider.driver)
      : target?.devDisciplineSkill === true && BUILTIN_SKILL_PROVIDER_DRIVERS.has(provider.driver),
  );
  if (offered.length === 0) return skills;
  const resolved = { projectSettingsOverrides: {}, ...settings };
  return [
    ...skills,
    ...offered.map((skill) => ({
      name: skill.name,
      displayName: skill.displayName,
      description: skill.description,
      path: `goat:builtin/${skill.name}`,
      scope: BUILTIN_SKILL_SCOPE,
      enabled: resolveProjectBuiltInSkillEnabled(resolved, target?.projectId ?? null, skill.name),
    })),
  ];
}

/** The skills a thread's provider offers in its workspace, GOAT's built-in ones included. */
export function resolveThreadProviderSkills(
  config:
    | {
        readonly providers: ReadonlyArray<ServerProvider>;
        readonly settings?: BuiltInSkillSettings;
        readonly environment?: {
          readonly capabilities: { readonly devDisciplineSkill?: boolean | undefined };
        };
      }
    | null
    | undefined,
  instanceId: ServerProvider["instanceId"],
  cwd: string | null | undefined,
  projectId?: ProjectId | null,
): ReadonlyArray<ServerProviderSkill> {
  const provider = config?.providers.find((candidate) => candidate.instanceId === instanceId);
  return provider
    ? withBuiltInProviderSkills(
        resolveProviderSkillsForCwd(provider, cwd),
        provider,
        config?.settings,
        {
          devDisciplineSkill: config?.environment?.capabilities.devDisciplineSkill,
          projectId,
        },
      )
    : [];
}

export function resolveProviderSlashCommandsForCwd(
  provider: ServerProvider,
  cwd: string | null | undefined,
): ServerProvider["slashCommands"] {
  return resolveProviderWorkspaceSnapshot(provider, cwd)?.slashCommands ?? provider.slashCommands;
}
