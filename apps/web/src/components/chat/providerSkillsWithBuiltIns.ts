import { useAtomValue } from "@effect/atom-react";
import {
  resolveProviderSkillsForCwd,
  withBuiltInProviderSkills,
} from "@goat/client-runtime/providerSkills";
import type {
  EnvironmentId,
  ProjectId,
  ServerProvider,
  ServerProviderSkill,
  ServerSettings,
} from "@goat/contracts";

import { serverEnvironment } from "../../state/server";

const NO_PROVIDER_SKILLS: ReadonlyArray<ServerProviderSkill> = [];

/**
 * The selected provider's skills for this workspace, with GOAT's built-in skills it can carry.
 * Message-named skills are offered only when the destination server delivers each one.
 */
export function useOfferedSkills(
  provider: ServerProvider | null,
  cwd: string | null | undefined,
  settings: Pick<
    ServerSettings,
    "enableCua" | "disabledBuiltInSkills" | "projectSettingsOverrides"
  >,
  scope: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId | null | undefined;
  },
): ReadonlyArray<ServerProviderSkill> {
  const capabilities = useAtomValue(
    serverEnvironment.configValueAtom(scope.environmentId),
    (config) => config?.environment.capabilities,
  );
  const skills = provider ? resolveProviderSkillsForCwd(provider, cwd) : NO_PROVIDER_SKILLS;
  return withBuiltInProviderSkills(skills, provider, settings, {
    builtInSkills: capabilities?.builtInSkills,
    devDisciplineSkill: capabilities?.devDisciplineSkill,
    projectId: scope.projectId,
  });
}
