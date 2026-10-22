import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RuntimeMode } from "./providerPolicy.ts";

export const PermissionCapability = Schema.Literals([
  "threads.launch",
  "threads.remote",
  "worktree.create",
  "pr.open",
  "pr.merge",
  "hub.manage",
  "cloud.launch",
  "boat.start",
  "settings.write",
  "goals.apply",
]);
export type PermissionCapability = typeof PermissionCapability.Type;

export const PermissionProfile = Schema.Struct({
  id: TrimmedNonEmptyString,
  runtimeModeCeiling: RuntimeMode,
  capabilities: Schema.Array(PermissionCapability),
  hosts: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  maxLanes: NonNegativeInt,
  maxTurns: Schema.optionalKey(PositiveInt),
  maxWallClockMs: Schema.optionalKey(PositiveInt),
});
export type PermissionProfile = typeof PermissionProfile.Type;

const worker = ["threads.launch", "worktree.create", "pr.open"] as const;
const manager = [...worker, "threads.remote", "goals.apply"] as const;
export const BUILTIN_PERMISSION_PROFILES: Readonly<Record<string, PermissionProfile>> = {
  observer: {
    id: "observer",
    runtimeModeCeiling: "approval-required",
    capabilities: [],
    maxLanes: 0,
  },
  worker: { id: "worker", runtimeModeCeiling: "auto", capabilities: worker, maxLanes: 3 },
  manager: { id: "manager", runtimeModeCeiling: "full-access", capabilities: manager, maxLanes: 6 },
  "merge-manager": {
    id: "merge-manager",
    runtimeModeCeiling: "full-access",
    capabilities: [...manager, "pr.merge"],
    maxLanes: 6,
  },
  owner: {
    id: "owner",
    runtimeModeCeiling: "full-access",
    capabilities: PermissionCapability.literals,
    maxLanes: 32,
  },
};

const DEFAULT_GOATCLAW_PROFILE = "worker";

export const GoatclawSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  defaultProfile: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_GOATCLAW_PROFILE)),
  ),
  profiles: Schema.Record(TrimmedNonEmptyString, PermissionProfile).pipe(
    Schema.withDecodingDefault(Effect.succeed(BUILTIN_PERMISSION_PROFILES)),
  ),
}).check(
  Schema.makeFilter((settings) => {
    // The settings file stores only what differs from the defaults, and encoding checks that
    // sparse copy, so an absent key means the default it decodes to.
    const stored: Partial<typeof settings> = settings;
    const profiles = stored.profiles ?? BUILTIN_PERMISSION_PROFILES;
    return profiles[stored.defaultProfile ?? DEFAULT_GOATCLAW_PROFILE] !== undefined &&
      Object.entries(profiles).every(([id, profile]) => id === profile.id)
      ? undefined
      : "Profile keys must match their ids and defaultProfile must name a stored profile.";
  }),
);
export type GoatclawSettings = typeof GoatclawSettings.Type;

export const GoatclawSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  defaultProfile: Schema.optionalKey(TrimmedNonEmptyString),
  profiles: Schema.optionalKey(Schema.Record(TrimmedNonEmptyString, PermissionProfile)),
});

export const PermissionProfileView = Schema.Struct({
  enabled: Schema.Boolean,
  profile: PermissionProfile,
  runtimeMode: RuntimeMode,
});
export type PermissionProfileView = typeof PermissionProfileView.Type;

/** goatclaw launch presets (design §8.3). Each launches under the stored profile it names. */
export const GoatclawRole = Schema.Literals([
  "supervisor",
  "domain-manager",
  "merge-manager",
  "issue-sweeper",
]);
export type GoatclawRole = typeof GoatclawRole.Type;
export const GOATCLAW_ROLE_PROFILES: Readonly<Record<GoatclawRole, string>> = {
  supervisor: "owner",
  "domain-manager": "manager",
  "merge-manager": "merge-manager",
  "issue-sweeper": "worker",
};
