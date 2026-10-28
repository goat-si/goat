import * as Schema from "effect/Schema";

// The capabilities a turn can carry are the composer's: Settings attach them to every eligible
// turn, and an `@computer`/`@browser` chip requests one for a single turn (D13, #1238).
import { TurnCapability } from "./composerContext.ts";

/** `ServerProviderSkill.scope` of skills GOAT ships itself rather than a provider discovers. */
export const BUILTIN_SKILL_SCOPE = "builtin";

export const BuiltInSkillName = Schema.Literals([
  "computer-use",
  "browser",
  "screen-code",
  "goat-discipline",
  "goat-docs",
]);
export type BuiltInSkillName = typeof BuiltInSkillName.Type;

export interface BuiltInSkillListing {
  readonly name: BuiltInSkillName;
  readonly displayName: string;
  readonly description: string;
  /** Any attached capability can load this skill; absent means message-named only. */
  readonly anyOf?: ReadonlyArray<TurnCapability>;
}

/** What clients list; the skill text lives with the provider runtime. */
export const BUILTIN_SKILLS: ReadonlyArray<BuiltInSkillListing> = [
  {
    name: "computer-use",
    displayName: "Computer Use",
    description:
      "Operate app windows on the computer that runs GOAT: observe one window, act in single calls or batches, verify at checkpoints. Loads on every turn that has computer use.",
    anyOf: ["computer-use"],
  },
  {
    name: "browser",
    displayName: "Browser",
    description:
      "Read and operate web pages in GOAT's browser: observe, act, batch in one screen cell, verify. Loads on every turn that has the browser.",
    anyOf: ["browser"],
  },
  {
    name: "screen-code",
    displayName: "Screen Code",
    description:
      "Run bounded JavaScript cells against available GOAT browser tabs or admitted desktop apps. Loads when either surface is attached.",
    anyOf: ["browser", "computer-use"],
  },
  {
    name: "goat-discipline",
    displayName: "Development discipline",
    description:
      "GOAT's guidance for code changes: size the work, prove each claim, stay safe, brief subagents. Loads on the turn whose message names it.",
  },
  {
    name: "goat-docs",
    displayName: "GOAT Docs",
    description:
      "Answer questions about GOAT itself from its user guides: search, read the page, cite it. Loads on the turn whose message names it.",
  },
];

/** Built-in skills a message loads by naming them; a server lists the ones it delivers. */
export const MESSAGE_NAMED_BUILTIN_SKILLS: ReadonlyArray<BuiltInSkillName> = BUILTIN_SKILLS.filter(
  (skill) => skill.anyOf === undefined,
).map((skill) => skill.name);

/**
 * Whether a server delivers a message-named built-in skill: it lists the skill, or, for a server
 * from before that list, it advertises goat-discipline the older way.
 */
export function environmentDeliversBuiltInSkill(
  capabilities:
    | {
        readonly builtInSkills?: ReadonlyArray<string> | undefined;
        readonly devDisciplineSkill?: boolean | undefined;
      }
    | null
    | undefined,
  name: BuiltInSkillName,
): boolean {
  if (capabilities?.builtInSkills !== undefined) return capabilities.builtInSkills.includes(name);
  return name === "goat-discipline" && capabilities?.devDisciplineSkill === true;
}

/**
 * Drivers whose turns carry GOAT's instructions, so a message-named built-in skill reaches them.
 * Muse and cloud providers never received GOAT's development instructions and get none.
 */
export const BUILTIN_SKILL_PROVIDER_DRIVERS: ReadonlySet<string> = new Set([
  "claudeAgent",
  "codex",
  "cursor",
  "fx",
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
