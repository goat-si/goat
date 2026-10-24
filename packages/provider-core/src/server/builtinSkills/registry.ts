import {
  BUILTIN_SKILLS,
  type BuiltInSkillActivation,
  type BuiltInSkillActivationInput,
  type BuiltInSkillName,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";

import {
  COMPUTER_USE_PLATFORM_NOTES,
  COMPUTER_USE_SKILL_CORE,
  COMPUTER_USE_SKILL_PEOPLE,
} from "./computerUse.ts";

const SECTIONS: Readonly<
  Record<BuiltInSkillName, (platform: NodeJS.Platform) => ReadonlyArray<string>>
> = {
  "computer-use": (platform) => {
    const notes = COMPUTER_USE_PLATFORM_NOTES[platform];
    const skill = [COMPUTER_USE_SKILL_CORE, COMPUTER_USE_SKILL_PEOPLE];
    return notes === undefined ? skill : [...skill, notes];
  },
};

/**
 * The one decision for which built-in skills a turn carries. A skill loads only with its
 * capability attached, so Plan, read-only, cloud and Muse turns, which never get computer use,
 * never get its skill either.
 */
export function resolveBuiltInSkills(input: BuiltInSkillActivationInput): BuiltInSkillActivation {
  const attached = new Set(input.attached);
  const requested = new Set(input.requested ?? []);
  const disabled = new Set(input.disabled ?? []);
  return {
    active: BUILTIN_SKILLS.filter(
      (skill) =>
        attached.has(skill.capability) &&
        (requested.has(skill.capability) || !disabled.has(skill.name)),
    ).map((skill) => skill.name),
    unattached: [...requested].filter((capability) => !attached.has(capability)),
  };
}

/**
 * Instruction sections for the given skills, each within one Codex context entry. Computer use
 * always controls the machine this server runs on, so the default is this process's platform.
 */
export function builtInSkillSections(
  names: ReadonlyArray<BuiltInSkillName>,
  platform: NodeJS.Platform = HostProcess.Platform.defaultValue(),
): ReadonlyArray<string> {
  return names.flatMap((name) => SECTIONS[name](platform));
}
