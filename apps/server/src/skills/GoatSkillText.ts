import { BUILTIN_SKILL_PROVIDER_DRIVERS, isGoatSkillName } from "@goat/contracts";
import { mentionedSkillNames } from "@goat/provider-core/server/builtinSkills/registry";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { builtInSkillProviderText } from "../orchestration-v2/BuiltInSkillText.ts";
import { makeGlobalSkills } from "./GlobalSkills.ts";

/**
 * The provider text with built-in skills, then the GOAT-global skills the message names in front,
 * read from disk at send time. A skill switched off, an ineligible driver, or unreadable settings
 * add nothing, so a disabled skill never arrives by accident.
 */
export const providerTextWithSkills = Effect.fn("GoatSkillText.providerText")(function* (
  settings: Parameters<typeof builtInSkillProviderText>[0],
  input: Parameters<typeof builtInSkillProviderText>[1] & {
    readonly globalSkillsDir?: string | undefined;
  },
) {
  const text = yield* builtInSkillProviderText(settings, input);
  const names = mentionedSkillNames(input.message.text).filter(isGoatSkillName);
  if (
    names.length === 0 ||
    input.globalSkillsDir === undefined ||
    !BUILTIN_SKILL_PROVIDER_DRIVERS.has(input.driver) ||
    Option.isNone(settings)
  )
    return text;
  const disabled = yield* settings.value.getSettings.pipe(
    Effect.map((current) => Option.some(current.disabledGlobalSkills)),
    Effect.catch((cause) =>
      Effect.logWarning("GOAT skill not delivered: settings unreadable.", { cause }).pipe(
        Effect.as(Option.none()),
      ),
    ),
  );
  if (Option.isNone(disabled)) return text;
  const skills = yield* makeGlobalSkills({
    globalSkillsDir: input.globalSkillsDir,
    disabled: Effect.succeed(disabled.value),
  }).readForTurn(names);
  return skills ? `${skills}\n\n${text}` : text;
});
