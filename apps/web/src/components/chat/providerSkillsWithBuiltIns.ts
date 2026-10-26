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
 * goat-discipline is offered only when the destination server delivers it.
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
  const devDisciplineSkill = useAtomValue(
    serverEnvironment.configValueAtom(scope.environmentId),
    (config) => config?.environment.capabilities.devDisciplineSkill === true,
  );
  const skills = provider ? resolveProviderSkillsForCwd(provider, cwd) : NO_PROVIDER_SKILLS;
  return withBuiltInProviderSkills(skills, provider, settings, {
    devDisciplineSkill,
    projectId: scope.projectId,
  });
}
