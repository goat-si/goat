import {
  BUILTIN_SKILLS,
  type BuiltInSkillActivation,
  type BuiltInSkillActivationInput,
  BuiltInSkillName,
} from "@goat/contracts";
import { hasLegacyContextMarkers } from "@goat/shared/composerContextLegacy";
import { replaceComposerContextReferences } from "@goat/shared/composerContextReferences";
import { SKILL_MENTION_PATTERN } from "@goat/shared/composerInlineTokens";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Schema from "effect/Schema";

import {
  COMPUTER_USE_PLATFORM_NOTES,
  COMPUTER_USE_SKILL_CORE,
  COMPUTER_USE_SKILL_PEOPLE,
} from "./computerUse.ts";
import { GOAT_DISCIPLINE_SKILL } from "./goatDiscipline.ts";

const SECTIONS: Readonly<
  Record<BuiltInSkillName, (platform: NodeJS.Platform) => ReadonlyArray<string>>
> = {
  "computer-use": (platform) => {
    const notes = COMPUTER_USE_PLATFORM_NOTES[platform];
    const skill = [COMPUTER_USE_SKILL_CORE, COMPUTER_USE_SKILL_PEOPLE];
    return notes === undefined ? skill : [...skill, notes];
  },
  "goat-discipline": () => [GOAT_DISCIPLINE_SKILL],
};

/**
 * The one decision for which built-in skills a turn carries. A capability skill loads only with
 * its capability attached, so Plan, read-only, cloud and Muse turns, which never get computer
 * use, never get its skill either. A skill without a capability loads when the message names it
 * and neither the environment nor the thread's project switched it off.
 */
export function resolveBuiltInSkills(input: BuiltInSkillActivationInput): BuiltInSkillActivation {
  const attached = new Set(input.attached);
  const requested = new Set(input.requested ?? []);
  const named = new Set(input.named ?? []);
  const disabled = new Set(input.disabled ?? []);
  return {
    active: BUILTIN_SKILLS.filter((skill) =>
      skill.capability === undefined
        ? named.has(skill.name) && !disabled.has(skill.name)
        : attached.has(skill.capability) &&
          (requested.has(skill.capability) || !disabled.has(skill.name)),
    ).map((skill) => skill.name),
    unattached: [...requested].filter((capability) => !attached.has(capability)),
  };
}

const isBuiltInSkillName = Schema.is(BuiltInSkillName);
const NAMED_SKILLS = new Set(
  BUILTIN_SKILLS.filter((skill) => skill.capability === undefined).map((skill) => skill.name),
);

/**
 * Skills without a capability that a person named in a message's own text. Attachments never
 * count: references (labels included) are dropped first, and a message in the legacy serialized
 * form names nothing, because its attachment text cannot be told apart from what was written.
 */
export function namedBuiltInSkills(text: string): ReadonlyArray<BuiltInSkillName> {
  const authored = replaceComposerContextReferences(text, () => " ");
  if (hasLegacyContextMarkers(authored)) return [];
  const names = new Set<BuiltInSkillName>();
  for (const match of authored.matchAll(SKILL_MENTION_PATTERN)) {
    const name = match[2];
    if (isBuiltInSkillName(name) && NAMED_SKILLS.has(name)) names.add(name);
  }
  return [...names];
}

/**
 * The provider text with each active skill's text in front, so a provider's own skill dispatch
 * (Claude keeps the text before its last skill mention whole) carries it once. A message that
 * opens with a native command belongs to that command and gets nothing.
 */
export function withBuiltInSkillText(text: string, names: ReadonlyArray<BuiltInSkillName>): string {
  if (names.length === 0 || text.trimStart().startsWith("/")) return text;
  const blocks = names.map(
    (name) =>
      `<goat_skill name="${name}">\n${builtInSkillSections([name]).join("\n\n")}\n</goat_skill>`,
  );
  return `${blocks.join("\n\n")}\n\n${text}`;
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
