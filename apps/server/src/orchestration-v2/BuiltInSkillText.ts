import {
  BUILTIN_SKILL_PROVIDER_DRIVERS,
  type ComposerContextRecord,
  type ProjectId,
  resolveProjectBuiltInSkillEnabled,
  type ServerSettings,
  type ServerSettingsError,
  type ThreadId,
} from "@goat/contracts";
import {
  namedBuiltInSkills,
  resolveBuiltInSkills,
  withBuiltInSkillText,
} from "@goat/provider-core/server/builtinSkills/registry";
import { projectComposerContextForProvider } from "@goat/shared/composerContextReferences";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import type { ProjectionStoreV2Error } from "./ProjectionStore.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { checkResponseContexts } from "./ResponseContextCheck.ts";

/** Reply records checked against this server's threads; without a thread, none pass. */
const checkedRecords = Effect.fn("BuiltInSkillText.checkedRecords")(function* (message: {
  readonly threadId?: ThreadId | undefined;
  readonly context?: { readonly records: ReadonlyArray<ComposerContextRecord> } | undefined;
}) {
  const records = message.context?.records ?? [];
  const none = { records, checkedResponseIds: new Set<never>() };
  if (message.threadId === undefined || !records.some((record) => record.kind === "response")) {
    return none;
  }
  const store = yield* Effect.serviceOption(ProjectionStoreV2);
  const identity = yield* Effect.serviceOption(ServerEnvironmentIdentity);
  if (Option.isNone(store) || Option.isNone(identity)) return none;
  return yield* checkResponseContexts({
    environmentId: yield* identity.value.getEnvironmentId,
    threadId: message.threadId,
    records,
    store: store.value,
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Reply not checked: the thread could not be read.", { cause }).pipe(
        Effect.as(none),
      ),
    ),
  );
});

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
      /** The receiving thread, which a reply's response must belong to. */
      readonly threadId?: ThreadId | undefined;
      readonly text: string;
      readonly context?: { readonly records: ReadonlyArray<ComposerContextRecord> } | undefined;
    };
    readonly driver: string;
    /** Read only when the message names a skill. */
    readonly project: Effect.Effect<ProjectId | null, ProjectionStoreV2Error>;
  },
) {
  const { records, checkedResponseIds } = yield* checkedRecords(input.message);
  const text = projectComposerContextForProvider({
    text: input.message.text,
    records,
    checkedResponseIds,
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
