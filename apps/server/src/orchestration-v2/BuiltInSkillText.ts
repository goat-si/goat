import {
  BUILTIN_SKILL_PROVIDER_DRIVERS,
  type ComposerContextRecord,
  type ProjectId,
  resolveProjectBuiltInSkillEnabled,
  type ServerSettings,
  type ServerSettingsError,
} from "@goat/contracts";
import {
  namedBuiltInSkills,
  resolveBuiltInSkills,
  withBuiltInSkillText,
} from "@goat/provider-core/server/builtinSkills/registry";
import { projectComposerContextForProvider } from "@goat/shared/composerContextReferences";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionStoreV2Error } from "./ProjectionStore.ts";

/**
 * A message's text as its provider receives it, with the built-in skills the message names in
 * front. Only drivers that carry GOAT's instructions get them, and only while neither the
 * environment nor the thread's project switched the skill off. When the settings or the project
 * cannot be read, nothing is added, so a switched-off skill never arrives by accident.
 */
export const builtInSkillProviderText = Effect.fn("BuiltInSkillText.providerText")(function* (
  settings: Option.Option<{
    readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;
  }>,
  input: {
    readonly message: {
      readonly text: string;
      readonly context?: { readonly records: ReadonlyArray<ComposerContextRecord> } | undefined;
    };
    readonly driver: string;
    /** Read only when the message names a skill. */
    readonly project: Effect.Effect<ProjectId | null, ProjectionStoreV2Error>;
  },
) {
  const text = projectComposerContextForProvider({
    text: input.message.text,
    records: input.message.context?.records ?? [],
  });
  const named = namedBuiltInSkills(input.message.text);
  if (named.length === 0 || !BUILTIN_SKILL_PROVIDER_DRIVERS.has(input.driver)) return text;
  if (Option.isNone(settings)) return text;
  const resolved = yield* Effect.all([settings.value.getSettings, input.project]).pipe(
    Effect.map(Option.some),
    Effect.catch((cause) =>
      Effect.logWarning("Built-in skill not delivered: settings or project unreadable.", {
        cause,
      }).pipe(Effect.as(Option.none())),
    ),
  );
  if (Option.isNone(resolved)) return text;
  const [current, projectId] = resolved.value;
  const active = resolveBuiltInSkills({
    attached: [],
    named,
    disabled: named.filter((name) => !resolveProjectBuiltInSkillEnabled(current, projectId, name)),
  }).active;
  return withBuiltInSkillText(text, active);
});
