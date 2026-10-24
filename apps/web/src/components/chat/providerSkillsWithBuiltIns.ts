import {
  resolveProviderSkillsForCwd,
  withBuiltInProviderSkills,
} from "@goat/client-runtime/providerSkills";
import type { ServerProvider, ServerProviderSkill, ServerSettings } from "@goat/contracts";

const NO_PROVIDER_SKILLS: ReadonlyArray<ServerProviderSkill> = [];

/** The selected provider's skills for this workspace, with GOAT's built-in skills it can carry. */
export function providerSkillsWithBuiltIns(
  provider: ServerProvider | null,
  cwd: string | null | undefined,
  settings: Pick<ServerSettings, "enableCua" | "disabledBuiltInSkills">,
): ReadonlyArray<ServerProviderSkill> {
  const skills = provider ? resolveProviderSkillsForCwd(provider, cwd) : NO_PROVIDER_SKILLS;
  return withBuiltInProviderSkills(skills, provider, settings);
}
