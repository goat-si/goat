import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Cloud machines are Boat (boat.dev) sandboxes that the GOAT server creates and keeps reachable
 * as ordinary OpenSSH aliases. The server owns the Boat API key, which goes in through configure
 * and never comes back out.
 */

const SANDBOX_ID_PATTERN = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
const ALIAS_PATTERN = /^boat-bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;

/** The SSH alias GOAT writes for a machine: `boat-` plus the Boat sandbox id. */
export const CloudMachineAlias = TrimmedNonEmptyString.check(Schema.isPattern(ALIAS_PATTERN));
export type CloudMachineAlias = typeof CloudMachineAlias.Type;
export const isCloudMachineAlias = Schema.is(CloudMachineAlias);
/** Aliases with this prefix are reserved for machines a GOAT server manages. */
export const CLOUD_MACHINE_ALIAS_PREFIX = "boat-";

/**
 * Whether an SSH alias falls in the reserved Boat namespace, valid or not. OpenSSH matches host
 * names without regard to case, so neither does this. Prefer the CloudMachine record where one
 * is at hand; this is the fallback for code that only has the alias.
 */
export const hasCloudMachineAliasPrefix = (alias: string): boolean =>
  alias.toLowerCase().startsWith(CLOUD_MACHINE_ALIAS_PREFIX);

export const BoatSandboxId = TrimmedNonEmptyString.check(Schema.isPattern(SANDBOX_ID_PATTERN));
export type BoatSandboxId = typeof BoatSandboxId.Type;

export const cloudMachineAlias = (sandboxId: BoatSandboxId): CloudMachineAlias =>
  `${CLOUD_MACHINE_ALIAS_PREFIX}${sandboxId}` as CloudMachineAlias;

export const CloudMachineState = Schema.Literals([
  "init",
  "provisioning",
  "provisioned",
  "cloning",
  "ready",
  "idle",
  "running",
  "archiving",
  "archived",
  "error",
  "cancelled",
]);
export type CloudMachineState = typeof CloudMachineState.Type;

/** States in which the machine accepts SSH. */
export const CLOUD_MACHINE_READY_STATES: ReadonlySet<CloudMachineState> = new Set([
  "ready",
  "idle",
  "running",
]);

export const CloudMachineType = Schema.Literals(["small", "default", "large", "xlarge"]);
export type CloudMachineType = typeof CloudMachineType.Type;

export const CLOUD_MACHINE_MAX_TTL_SECONDS = 2_592_000;
export const CloudMachineTtlSeconds = Schema.Int.check(
  Schema.isBetween({ minimum: 60, maximum: CLOUD_MACHINE_MAX_TTL_SECONDS }),
);

/**
 * What Boat last said about the machine: `present` with a state, `not_found` when Boat does not
 * show it to the current key, `unknown` when Boat could not be asked.
 */
export const CloudMachinePresence = Schema.Literals(["present", "not_found", "unknown"]);
export type CloudMachinePresence = typeof CloudMachinePresence.Type;

export const CloudMachine = Schema.Struct({
  alias: CloudMachineAlias,
  sandboxId: BoatSandboxId,
  label: TrimmedNonEmptyString,
  provider: Schema.Literal("boat"),
  type: CloudMachineType,
  ttlSeconds: CloudMachineTtlSeconds,
  presence: CloudMachinePresence,
  state: Schema.NullOr(CloudMachineState),
  /** Boat accepted a delete; the entry stays until Boat no longer shows the machine. */
  deletePending: Schema.Boolean,
  /** A safe, user-facing message; never a raw Boat response. */
  lastError: Schema.NullOr(Schema.String),
});
export type CloudMachine = typeof CloudMachine.Type;

export const CloudMachinesListInput = Schema.Struct({});
export type CloudMachinesListInput = typeof CloudMachinesListInput.Type;
export const CloudMachinesListResult = Schema.Struct({
  /** Whether a Boat API key is stored. Machines can be listed without one. */
  configured: Schema.Boolean,
  /**
   * Create requests whose outcome GOAT never learned. The next create retries them; Boat may
   * still have made a machine, so the user can check its dashboard.
   */
  unconfirmedCreates: Schema.Number,
  machines: Schema.Array(CloudMachine),
});
export type CloudMachinesListResult = typeof CloudMachinesListResult.Type;

export const CloudMachinesConfigureInput = Schema.Struct({
  apiKey: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  /** The user agreed to one Include line at the top of this computer's ~/.ssh/config. */
  consentToSshInclude: Schema.Literal(true),
});
export type CloudMachinesConfigureInput = typeof CloudMachinesConfigureInput.Type;
export const CloudMachinesConfigureResult = Schema.Struct({ configured: Schema.Literal(true) });

export const CloudMachinesDisconnectInput = Schema.Struct({});
export const CloudMachinesDisconnectResult = Schema.Struct({ configured: Schema.Literal(false) });

export const CloudMachinesCreateInput = Schema.Struct({
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  type: CloudMachineType,
  ttlSeconds: CloudMachineTtlSeconds,
});
export type CloudMachinesCreateInput = typeof CloudMachinesCreateInput.Type;

export const CloudMachinesAliasInput = Schema.Struct({ alias: CloudMachineAlias });
export type CloudMachinesAliasInput = typeof CloudMachinesAliasInput.Type;

export const CloudMachinesEnsureReadyResult = Schema.Struct({
  alias: CloudMachineAlias,
  endpointChanged: Schema.Boolean,
});
export type CloudMachinesEnsureReadyResult = typeof CloudMachinesEnsureReadyResult.Type;

export const CloudMachinesForgetResult = Schema.Struct({ forgotten: Schema.Literal(true) });
export const CloudMachinesDismissUnconfirmedInput = Schema.Struct({});
export const CloudMachinesDismissUnconfirmedResult = Schema.Struct({ dismissed: Schema.Number });

const CLOUD_MACHINE_FAILURE_MESSAGES = {
  not_configured: "Connect a Boat API key in Settings → Connections → Cloud machines first.",
  invalid_key: "Boat rejected the API key.",
  scope_denied:
    "The Boat API key lacks a permission this needs (create it with the ci preset: boat api-key create goat --preset ci), or the Boat plan does not include this machine size.",
  billing_required: "Boat needs an active plan or payment for this.",
  limit_reached: "A Boat machine or rate limit was reached. Stop another machine or try later.",
  snapshot_expired: "This machine's saved snapshot expired, so it can no longer be resumed.",
  not_found: "This cloud machine is not managed by this GOAT server.",
  stopped: "This cloud machine is stopped. Resume it in Settings → Connections → Cloud machines.",
  not_ready: "This cloud machine is not running. Check its state in Settings → Connections.",
  readiness_timeout: "The cloud machine did not become ready in time. Try again shortly.",
  alias_conflict: "Another SSH host in ~/.ssh/config already uses this machine's name.",
  ssh_config_failed: "Could not write the SSH settings for this cloud machine.",
  ssh_config_overridden:
    "Your ~/.ssh/config overrides the host key settings GOAT pins for this machine. Keep the GOAT Include line at the top of ~/.ssh/config.",
  forget_refused:
    "Only a stopped machine, or one Boat no longer shows, can be forgotten. Stop or delete it first.",
  conflict: "Boat refused this because of the machine's current state.",
  protocol_error: "Boat returned a response GOAT could not read.",
  transport_error: "Could not reach Boat.",
  storage_failed: "Could not save the cloud machine settings.",
} as const;

export const CloudMachineErrorReason = Schema.Literals(
  Object.keys(CLOUD_MACHINE_FAILURE_MESSAGES) as Array<keyof typeof CLOUD_MACHINE_FAILURE_MESSAGES>,
);
export type CloudMachineErrorReason = typeof CloudMachineErrorReason.Type;

/** Safe to show: never carries the API key or a raw Boat response. */
export class CloudMachineError extends Schema.TaggedError<CloudMachineError>()(
  "CloudMachineError",
  { reason: CloudMachineErrorReason },
) {
  override get message(): string {
    return CLOUD_MACHINE_FAILURE_MESSAGES[this.reason];
  }
}
export const isCloudMachineError = Schema.is(CloudMachineError);
