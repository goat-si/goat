import * as Schema from "effect/Schema";
import { EnvironmentId, ForwardCompatibleOptional, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * A Home's bounded authority to finish one Child's Codex setup. The Child signs it into a
 * read-scoped bearer for one dispatch phase; the Home re-checks its consent around every call.
 */
const ChildSetupTimestamp = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
export const ChildSetupPhase = Schema.Literals([
  "installOpenCodex",
  "startOpenCodex",
  "installCodex",
  "catalogConfigureProbe",
  "status",
]);
export type ChildSetupPhase = typeof ChildSetupPhase.Type;
export const ChildSetupPurpose = Schema.Struct({
  purpose: Schema.Literal("opencodex-child-setup"),
  homeEnvironmentId: EnvironmentId,
  destinationEnvironmentId: EnvironmentId,
  operationId: TrimmedNonEmptyString,
  grantId: TrimmedNonEmptyString,
  grantRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  issuedAt: ChildSetupTimestamp,
  expiresAt: ChildSetupTimestamp,
  phase: ChildSetupPhase,
  phaseId: TrimmedNonEmptyString,
  phaseDeadline: ChildSetupTimestamp,
});
export type ChildSetupPurpose = typeof ChildSetupPurpose.Type;
export const CHILD_SETUP_PHASE_MS = {
  installOpenCodex: 15 * 60_000,
  startOpenCodex: 170_000,
  installCodex: 15 * 60_000,
  catalogConfigureProbe: 210_000,
  status: 20_000,
} as const satisfies Record<ChildSetupPhase, number>;
/** Bounds credential cleanup and late replies; it never extends a phase's work deadline. */
export const CHILD_SETUP_EXPIRY_GRACE_MS = 5 * 60_000;
export type ChildSetupBinding = Pick<
  ChildSetupPurpose,
  | "purpose"
  | "homeEnvironmentId"
  | "destinationEnvironmentId"
  | "operationId"
  | "grantId"
  | "grantRevision"
>;
export const makeChildSetupPurpose = (
  binding: ChildSetupBinding,
  phase: ChildSetupPhase,
  phaseId: string,
  issuedAt: number,
): ChildSetupPurpose => {
  const phaseDeadline = issuedAt + CHILD_SETUP_PHASE_MS[phase];
  return {
    ...binding,
    phase,
    phaseId,
    issuedAt,
    phaseDeadline,
    expiresAt: phaseDeadline + CHILD_SETUP_EXPIRY_GRACE_MS,
  };
};
export const childSetupPurposeIsLive = (purpose: ChildSetupPurpose, now: number) =>
  purpose.homeEnvironmentId !== purpose.destinationEnvironmentId &&
  purpose.issuedAt <= now &&
  now < purpose.expiresAt &&
  purpose.phaseDeadline === purpose.issuedAt + CHILD_SETUP_PHASE_MS[purpose.phase] &&
  purpose.expiresAt === purpose.phaseDeadline + CHILD_SETUP_EXPIRY_GRACE_MS;
/**
 * `status` is a read every phase may make, and all a status phase may make; each other phase
 * owns its own actions.
 */
export const childSetupPurposeAllowsAction = (
  purpose: ChildSetupPurpose,
  action: ChildReadyPrepareInput["action"] | "status",
) =>
  action === "status" ||
  (purpose.phase === "catalogConfigureProbe"
    ? action === "syncCatalog" || action === "configure" || action === "probe"
    : purpose.phase === "startOpenCodex"
      ? action === "startOpenCodex" || action === "opencodexHealth"
      : action === purpose.phase);

export const ChildReadyRevision = Schema.Struct({ epoch: Schema.String, sequence: Schema.Int });
export type ChildReadyRevision = typeof ChildReadyRevision.Type;
export const ChildReadyStep = Schema.Literals([
  "goat_available",
  "opencodex_running",
  "link_established",
  "codex_installed",
  "instance_routed",
  "inference_verified",
]);
export type ChildReadyStep = typeof ChildReadyStep.Type;
export const ChildReadyFailureCode = Schema.Literals([
  "permission_denied",
  "destination_changed",
  "remote_outdated",
  "stale_configuration",
  "installation_failed",
  "startup_failed",
  "instance_changed",
  "instance_busy",
  "route_unverified",
  "link_changed",
  "probe_unsupported",
  "probe_failed",
  "probe_timeout",
  "storage_failed",
  "interrupted",
  "unreachable",
  "catalog_sync_failed",
  "attribution_unproven",
  "proof_expired",
  "setup_approval_stale",
  "setup_approval_revoked",
  "purpose_expired",
  "phase_timeout",
  "ocx_unusable",
  "platform_unsupported",
]);
export type ChildReadyFailureCode = typeof ChildReadyFailureCode.Type;
export const ChildReadyFailure = Schema.Struct({
  code: ChildReadyFailureCode,
  step: ChildReadyStep,
  message: Schema.String,
  retryable: Schema.Boolean,
});
export type ChildReadyFailure = typeof ChildReadyFailure.Type;
/** `continue_setup` finishes a Child linked before setup existed, through hub.device_setup. */
export const ChildReadyNextAction = Schema.Literals([
  "none",
  "continue_setup",
  "retry",
  "review_settings",
  "update_goat",
  "reconnect_home",
]);
export type ChildReadyNextAction = typeof ChildReadyNextAction.Type;
/** Ready lasts 24 hours at most and ends at once when any bound fact changes. */
export const CHILD_READY_PROOF_TTL_MS = 86_400_000;
export const ChildReadyProof = Schema.Struct({
  version: Schema.Literal(1),
  operationId: TrimmedNonEmptyString,
  destinationEnvironmentId: EnvironmentId,
  homeEnvironmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
  configFingerprint: TrimmedNonEmptyString,
  executablePath: TrimmedNonEmptyString,
  executableVersion: TrimmedNonEmptyString,
  linkId: TrimmedNonEmptyString,
  listenerInstanceId: TrimmedNonEmptyString,
  /** OpenCodex's link connection generation, unchanged across the request: no reconnect. */
  linkConnectionGeneration: TrimmedNonEmptyString,
  settingsDigest: TrimmedNonEmptyString,
  catalogDigest: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  completedAt: Schema.Number,
  expiresAt: Schema.Number,
  attribution: Schema.Literal("home_zero_local_accounts"),
  localAccountsDigest: TrimmedNonEmptyString,
});
export type ChildReadyProof = typeof ChildReadyProof.Type;
/** A proof counts only inside its exact 24-hour lifetime. */
export const childReadyProofIsCurrent = (proof: ChildReadyProof, now: number) =>
  Number.isFinite(proof.completedAt) &&
  proof.completedAt <= now &&
  now < proof.expiresAt &&
  proof.expiresAt - proof.completedAt === CHILD_READY_PROOF_TTL_MS;
export const ChildReadyStepState = Schema.Struct({
  step: ChildReadyStep,
  state: Schema.Literals(["pending", "running", "succeeded", "failed"]),
});
export const OpenCodexChildSetup = Schema.Struct({
  version: Schema.Literal(1),
  operationId: TrimmedNonEmptyString,
  destinationEnvironmentId: EnvironmentId,
  homeEnvironmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
  revision: ChildReadyRevision,
  steps: Schema.Array(ChildReadyStepState),
  readiness: Schema.Literals(["linked", "verifying", "ready", "invalid"]),
  attribution: Schema.Literals(["unproven", "home_zero_local_accounts"]),
  failure: ForwardCompatibleOptional(ChildReadyFailure),
  nextAction: ChildReadyNextAction,
  proof: ForwardCompatibleOptional(ChildReadyProof),
});
export type OpenCodexChildSetup = typeof OpenCodexChildSetup.Type;
/**
 * Ready and Home attribution stand only with a proof. A record whose proof is missing, or was
 * dropped because it no longer decodes (an older shape), reads as unverified with retry.
 */
export const withoutUnprovenReady = (setup: OpenCodexChildSetup): OpenCodexChildSetup =>
  setup.proof !== undefined || (setup.readiness !== "ready" && setup.attribution === "unproven")
    ? setup
    : {
        ...setup,
        readiness: setup.readiness === "ready" ? "linked" : setup.readiness,
        attribution: "unproven",
        nextAction: setup.readiness === "ready" ? "retry" : setup.nextAction,
      };
export const ChildReadyAddress = Schema.Struct({
  destinationEnvironmentId: EnvironmentId,
  homeEnvironmentId: EnvironmentId,
});
export type ChildReadyAddress = typeof ChildReadyAddress.Type;
export const ChildReadyPrepareInput = Schema.Struct({
  ...ChildReadyAddress.fields,
  operationId: TrimmedNonEmptyString,
  action: Schema.Literals([
    "installOpenCodex",
    "startOpenCodex",
    "opencodexHealth",
    "installCodex",
    "syncCatalog",
    "configure",
    "probe",
  ]),
  expectedRevision: Schema.optional(ChildReadyRevision),
});
export type ChildReadyPrepareInput = typeof ChildReadyPrepareInput.Type;
export const decodeChildReadyPrepareInput = Schema.decodeUnknownEffect(ChildReadyPrepareInput, {
  onExcessProperty: "error",
});
const ChildConnectionUrl = Schema.String.check(Schema.isPattern(/^https?:\/\/[^\s]+$/u));
export const ChildReadyConnectionInput = Schema.Struct({
  ...ChildReadyAddress.fields,
  operationId: TrimmedNonEmptyString,
  opencodexConnection: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("connectHubClient"),
      dataUrl: ChildConnectionUrl,
      managementUrl: ChildConnectionUrl,
      pairingCode: Schema.String.check(Schema.isPattern(/^ocx_pair_[A-Za-z0-9_-]{16,128}$/u)),
    }),
    Schema.Struct({ kind: Schema.Literal("disconnect"), expectedLinkId: TrimmedNonEmptyString }),
    Schema.Struct({ kind: Schema.Literal("restart"), expectedLinkId: TrimmedNonEmptyString }),
  ]),
});
export type ChildReadyConnectionInput = typeof ChildReadyConnectionInput.Type;
export const decodeChildReadyConnectionInput = Schema.decodeUnknownEffect(
  ChildReadyConnectionInput,
  { onExcessProperty: "error" },
);
export const ChildReadyConnectionResult = Schema.Struct({
  ...ChildReadyAddress.fields,
  operationId: TrimmedNonEmptyString,
  kind: Schema.Literals(["connectHubClient", "disconnect", "restart"]),
  code: Schema.Int,
  healthy: Schema.Boolean,
  role: Schema.optional(Schema.Literals(["standalone", "hub", "client", "unknown"])),
});
export type ChildReadyConnectionResult = typeof ChildReadyConnectionResult.Type;
export const ChildReadyDevice = Schema.Struct({
  platform: TrimmedNonEmptyString,
  arch: TrimmedNonEmptyString,
  ocx: Schema.Union([
    Schema.Struct({
      path: TrimmedNonEmptyString,
      version: TrimmedNonEmptyString,
      ownership: Schema.Literals(["managed", "adopted"]),
    }),
    Schema.Struct({
      path: Schema.Null,
      version: Schema.Null,
      ownership: Schema.Literal("missing"),
    }),
  ]),
  connection: Schema.Struct({
    role: Schema.Literals(["standalone", "hub", "client", "unknown"]),
    linkId: Schema.optional(TrimmedNonEmptyString),
  }),
});
export type ChildReadyDevice = typeof ChildReadyDevice.Type;
export const ChildReadyDeviceResult = Schema.Struct({
  kind: Schema.Literal("device"),
  ...ChildReadyAddress.fields,
  operationId: Schema.optional(TrimmedNonEmptyString),
  step: Schema.optional(ChildReadyStep),
  device: ChildReadyDevice,
  healthy: Schema.Boolean,
  revision: ChildReadyRevision,
  setup: Schema.optional(OpenCodexChildSetup),
});
export type ChildReadyDeviceResult = typeof ChildReadyDeviceResult.Type;
export const ChildReadyPrelinkResult = Schema.Struct({
  kind: Schema.Literal("prelink"),
  operationId: TrimmedNonEmptyString,
  ...ChildReadyAddress.fields,
  step: ChildReadyStep,
  version: Schema.optional(Schema.String),
  healthy: Schema.Boolean,
});
export const ChildReadyResult = Schema.Union([
  ChildReadyDeviceResult,
  ChildReadyPrelinkResult,
  Schema.Struct({ kind: Schema.Literal("ok"), setup: OpenCodexChildSetup }),
  Schema.Struct({ kind: Schema.Literal("error"), failure: ChildReadyFailure }),
]);
export type ChildReadyResult = typeof ChildReadyResult.Type;
export const decodeChildReadyResult = Schema.decodeUnknownEffect(ChildReadyResult, {
  onExcessProperty: "error",
});

/** goat_hub_device_setup and hub.device_setup: retry or finish one Child's setup from its Home. */
export const HubDeviceSetupInput = Schema.Struct({
  deviceAlias: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
});
export type HubDeviceSetupInput = typeof HubDeviceSetupInput.Type;
