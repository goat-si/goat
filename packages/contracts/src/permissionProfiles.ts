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
  "providers.manage",
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

const DEFAULT_GOATCLAW_PROFILE = "owner";

export const GoatclawSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  defaultProfile: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_GOATCLAW_PROFILE)),
  ),
  profiles: Schema.Record(TrimmedNonEmptyString, PermissionProfile).pipe(
    Schema.withDecodingDefault(Effect.succeed(BUILTIN_PERMISSION_PROFILES)),
  ),
  /**
   * When a person last changed this policy, on whichever connected machine they changed it. The
   * policy applies fleet-wide, so the newest stamp wins on every host it syncs to. Absent means
   * the policy was never deliberately set here.
   */
  updatedAt: Schema.optionalKey(Schema.String),
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
  updatedAt: Schema.optionalKey(Schema.String),
});

/** One machine's goatclaw policy as `goat_goatclaw_sync` exchanges it between connected hosts. */
export const GoatclawFleetPolicy = Schema.Struct({
  enabled: Schema.Boolean,
  defaultProfile: TrimmedNonEmptyString,
  profiles: Schema.Record(TrimmedNonEmptyString, PermissionProfile),
  updatedAt: Schema.optionalKey(Schema.String),
});
export type GoatclawFleetPolicy = typeof GoatclawFleetPolicy.Type;

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
        )
      : value;

/** What a goatclaw policy enforces, ignoring its stamp and key order; equal on every host that applied it. */
export const goatclawPolicyContent = (
  policy: Pick<GoatclawFleetPolicy, "enabled" | "defaultProfile" | "profiles">,
): string =>
  JSON.stringify(
    canonical({
      enabled: policy.enabled,
      defaultProfile: policy.defaultProfile,
      profiles: policy.profiles,
    }),
  );

export const GoatGoatclawSyncInput = Schema.Struct({ policy: GoatclawFleetPolicy });
export type GoatGoatclawSyncInput = typeof GoatGoatclawSyncInput.Type;
/** The receiver's policy after the exchange, so the sender can adopt a newer one. */
export const GoatGoatclawSyncResult = Schema.Struct({ policy: GoatclawFleetPolicy });
export type GoatGoatclawSyncResult = typeof GoatGoatclawSyncResult.Type;

/**
 * Whether a connected host runs the launcher's goatclaw policy: `applied` once it holds the same
 * policy, `pending` while it has not answered, `outdated` when its GOAT predates fleet sync.
 */
export const GoatclawHostSyncState = Schema.Literals(["applied", "pending", "outdated"]);
export type GoatclawHostSyncState = typeof GoatclawHostSyncState.Type;
export const GoatclawHostSync = Schema.Struct({
  state: GoatclawHostSyncState,
  message: Schema.optional(Schema.String),
});
export type GoatclawHostSync = typeof GoatclawHostSync.Type;

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
