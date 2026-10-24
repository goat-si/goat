import * as Schema from "effect/Schema";

/**
 * Capabilities a turn can carry. Settings attach them to every eligible turn; a composer chip
 * (`@computer`, `@browser`) or the matching agent service method requests one for a single
 * turn (D13, #1238).
 */
export const TurnCapability = Schema.Literals(["computer", "browser"]);
export type TurnCapability = typeof TurnCapability.Type;

/** `ServerProviderSkill.scope` of skills GOAT ships itself rather than a provider discovers. */
export const BUILTIN_SKILL_SCOPE = "builtin";

/**
 * Providers whose agent process runs on the GOAT host and can spawn the driver's stdio MCP
 * server. Cloud providers run elsewhere, and the driver would operate this host's desktop on
 * their behalf; Muse only accepts HTTP session servers. See ADR-0020 for the per-adapter table.
 */
export const COMPUTER_USE_PROVIDER_DRIVERS: ReadonlySet<string> = new Set([
  "claudeAgent",
  "codex",
  "cursor",
  "grok",
  "antigravity",
  "acpRegistry",
  "opencode",
  "pi",
]);

export const BuiltInSkillName = Schema.Literals(["computer-use"]);
export type BuiltInSkillName = typeof BuiltInSkillName.Type;

export interface BuiltInSkillListing {
  readonly name: BuiltInSkillName;
  readonly displayName: string;
  readonly description: string;
  /** The skill loads on turns that have this capability attached. */
  readonly capability: TurnCapability;
}

/** What clients list; the skill text lives with the provider runtime. */
export const BUILTIN_SKILLS: ReadonlyArray<BuiltInSkillListing> = [
  {
    name: "computer-use",
    displayName: "Computer Use",
    description:
      "Operate app windows on the computer that runs GOAT: observe one window, act once, verify. Loads on every turn that has computer use.",
    capability: "computer",
  },
];

export const BuiltInSkillActivationInput = Schema.Struct({
  /** Capabilities whose tools are attached to this turn. */
  attached: Schema.Array(TurnCapability),
  /**
   * Capabilities named for this turn only. A request loads the capability's skill even when
   * Settings switched it off, because the person asked for it on this turn.
   */
  requested: Schema.optionalKey(Schema.Array(TurnCapability)),
  /** Built-in skills switched off in Settings. */
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
