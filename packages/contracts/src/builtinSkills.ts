import * as Schema from "effect/Schema";

// The capabilities a turn can carry are the composer's: Settings attach them to every eligible
// turn, and an `@computer`/`@browser` chip requests one for a single turn (D13, #1238).
import { TurnCapability } from "./composerContext.ts";

/** `ServerProviderSkill.scope` of skills GOAT ships itself rather than a provider discovers. */
export const BUILTIN_SKILL_SCOPE = "builtin";

export const BuiltInSkillName = Schema.Literals(["computer-use", "goat-discipline"]);
export type BuiltInSkillName = typeof BuiltInSkillName.Type;

export interface BuiltInSkillListing {
  readonly name: BuiltInSkillName;
  readonly displayName: string;
  readonly description: string;
  /**
   * The skill loads on turns that have this capability attached. A skill without one loads on
   * the turn whose message names it.
   */
  readonly capability?: TurnCapability;
}

/** What clients list; the skill text lives with the provider runtime. */
export const BUILTIN_SKILLS: ReadonlyArray<BuiltInSkillListing> = [
  {
    name: "computer-use",
    displayName: "Computer Use",
    description:
      "Operate app windows on the computer that runs GOAT: observe one window, act once, verify. Loads on every turn that has computer use.",
    capability: "computer-use",
  },
  {
    name: "goat-discipline",
    displayName: "Development discipline",
    description:
      "GOAT's guidance for code changes: size the work, prove each claim, stay safe, brief subagents. Loads on the turn whose message names it.",
  },
];

/**
 * Drivers whose turns carry GOAT's instructions, so a message-named built-in skill reaches them.
 * Muse and cloud providers never received GOAT's development instructions and get none.
 */
export const BUILTIN_SKILL_PROVIDER_DRIVERS: ReadonlySet<string> = new Set([
  "claudeAgent",
  "codex",
  "cursor",
  "grok",
  "antigravity",
  "acpRegistry",
  "opencode",
  "pi",
]);

export const BuiltInSkillActivationInput = Schema.Struct({
  /** Capabilities whose tools are attached to this turn. */
  attached: Schema.Array(TurnCapability),
  /**
   * Capabilities named for this turn only. A request loads the capability's skill even when
   * Settings switched it off, because the person asked for it on this turn.
   */
  requested: Schema.optionalKey(Schema.Array(TurnCapability)),
  /** Skills without a capability that this turn's message names. */
  named: Schema.optionalKey(Schema.Array(BuiltInSkillName)),
  /** Built-in skills switched off in Settings, for this environment or this thread's project. */
  disabled: Schema.optionalKey(Schema.Array(BuiltInSkillName)),
});
export type BuiltInSkillActivationInput = typeof BuiltInSkillActivationInput.Type;

export const BuiltInSkillActivation = Schema.Struct({
  active: Schema.Array(BuiltInSkillName),
  /**
   * Requested for this turn but not attached, so neither tools nor skill load. The turn must show
   * the capability's readiness reason instead of ignoring the request.
   */
  unattached: Schema.Array(TurnCapability),
});
export type BuiltInSkillActivation = typeof BuiltInSkillActivation.Type;

/**
 * A project's own switch per built-in skill, outside `PROJECT_SCOPED_SERVER_SETTING_KEYS` like
 * `providerInstances`: an absent name, or an absent `enabled`, follows the environment. Plain
 * string keys, so names from a newer build decode and survive a round trip.
 */
export const BuiltInSkillProjectOverrides = Schema.Record(
  Schema.String,
  Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean) }),
);
export type BuiltInSkillProjectOverrides = typeof BuiltInSkillProjectOverrides.Type;

/** Spread into `ProjectSettingsOverrides`. */
export const BuiltInSkillProjectOverrideFields = {
  builtInSkills: Schema.optionalKey(BuiltInSkillProjectOverrides),
};

/**
 * The project entry patch that removes everything, for a deleted project. A `null` entry keeps a
 * stored `builtInSkills`, because a client built before that field sends `null` when it clears
 * the last override it can see.
 */
export const PROJECT_SETTINGS_OVERRIDES_REMOVAL = { builtInSkills: {}, providerInstances: {} };

export function resolveProjectBuiltInSkillEnabled(
  settings: {
    readonly disabledBuiltInSkills: ReadonlyArray<string>;
    readonly projectSettingsOverrides: Readonly<
      Record<string, { readonly builtInSkills?: BuiltInSkillProjectOverrides | undefined }>
    >;
  },
  projectId: string | null,
  name: string,
): boolean {
  const entry = projectId === null ? undefined : settings.projectSettingsOverrides[projectId];
  const override = entry?.builtInSkills?.[name]?.enabled;
  return override ?? !settings.disabledBuiltInSkills.includes(name);
}
