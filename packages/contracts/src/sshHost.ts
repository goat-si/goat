import * as Schema from "effect/Schema";

import { IsoDateTime, PortSchema, SshHostAlias, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { HandoffHuman, HandoffReadInput, HandoffSummary } from "./handoff.ts";
import { ServerActivityBlocker } from "./serverActivity.ts";
import { ProviderDiagnosisFix } from "./providerDiagnosis.ts";

export { SshHostAlias } from "./baseSchemas.ts";

export const SshHostState = Schema.Literals([
  "untrusted",
  "trust_pending",
  "auth_failed",
  "preparing",
  "stopped",
  "ready",
  "update_waiting",
  "update_blocked",
  "failed",
  "providers_not_ready",
]);
export type SshHostState = typeof SshHostState.Type;

export const SshRuntimePhase = Schema.Literals(["connecting", "checking", "uploading", "starting"]);
export type SshRuntimePhase = typeof SshRuntimePhase.Type;

export const SshHostFailureReason = Schema.Literals([
  "archive_unavailable",
  "host_key_changed",
  "start_timeout",
  "missing_tools",
  "unsupported_platform",
  "diagnosis_failed",
  "approval_expired",
  "authorization_revoked",
  "operation_failed",
]);
export type SshHostFailureReason = typeof SshHostFailureReason.Type;

export const SshRuntimeUpdateMode = Schema.Literals(["when_idle", "now"]);
export type SshRuntimeUpdateMode = typeof SshRuntimeUpdateMode.Type;

export const SshHostFix = ProviderDiagnosisFix;
export type SshHostFix = typeof SshHostFix.Type;

export const SshHostFailure = Schema.Struct({
  reason: SshHostFailureReason,
  archive: Schema.optionalKey(
    Schema.Struct({
      requestedVersion: Schema.String,
      platformKey: Schema.NullOr(Schema.String),
      sourcesTried: Schema.Array(Schema.String),
    }),
  ),
  fix: ProviderDiagnosisFix,
}).check(
  Schema.makeFilter(
    (failure) => (failure.reason === "archive_unavailable") === (failure.archive !== undefined),
  ),
);
export type SshHostFailure = typeof SshHostFailure.Type;

export const SshRefreshDeferred = Schema.Struct({
  // Older clients decode this closed literal; the optional cause carries new refresh failures.
  reason: Schema.Literals(["archive_unavailable"]),
  refreshCause: Schema.optionalKey(Schema.Literal("drain_unavailable")),
  requestedVersion: Schema.String,
  detail: Schema.String,
});
export type SshRefreshDeferred = typeof SshRefreshDeferred.Type;

export const SshHostProviders = Schema.Struct({
  checkedAt: IsoDateTime,
  ready: Schema.Boolean,
  fixes: Schema.Array(ProviderDiagnosisFix),
});
export type SshHostProviders = typeof SshHostProviders.Type;

export const SshHostErrorCode = Schema.Literals([
  "host_unknown",
  "host_unreachable",
  "alias_conflict",
  "invalid_request",
  "unsupported",
  "declined",
  "cancelled",
  "operation_failed",
]);
export type SshHostErrorCode = typeof SshHostErrorCode.Type;

/** Identifies the operation whose runtime and diagnosis publications clients are following. */
export const SshHostSetupProgress = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  generation: Schema.Int,
  stage: Schema.Literals(["runtime", "diagnosis", "complete"]),
});
export type SshHostSetupProgress = typeof SshHostSetupProgress.Type;

/** Public key-auth recovery, produced by buildSshKeyAuthInstructions on the SSH owner. */
export const SshKeyAuthInstructions = Schema.Struct({
  originLabel: TrimmedNonEmptyString,
  instruction: TrimmedNonEmptyString,
  command: Schema.optionalKey(TrimmedNonEmptyString),
  publicKey: Schema.optionalKey(TrimmedNonEmptyString),
});
export type SshKeyAuthInstructions = typeof SshKeyAuthInstructions.Type;

const SshHostStatusShape = Schema.Struct({
  host: Schema.String,
  state: SshHostState,
  runtimeVersion: Schema.NullOr(Schema.String),
  requestedVersion: Schema.String,
  phase: Schema.optionalKey(SshRuntimePhase),
  /** Archive bytes this client has sent; only while it uploads, never for a host download. */
  upload: Schema.optionalKey(
    Schema.Struct({ sentBytes: Schema.Int, totalBytes: Schema.Int }).check(
      Schema.makeFilter(
        (upload) =>
          upload.sentBytes >= 0 && upload.totalBytes > 0 && upload.sentBytes <= upload.totalBytes,
      ),
    ),
  ),
  waitingReason: Schema.optionalKey(Schema.Literals(["busy", "unknown", "contended"])),
  /** With waitingReason "busy": the threads the host reports as running work, oldest first. */
  blockers: Schema.optionalKey(Schema.Array(ServerActivityBlocker)),
  detail: Schema.optionalKey(Schema.String),
  failure: Schema.optionalKey(SshHostFailure),
  refreshDeferred: Schema.optionalKey(SshRefreshDeferred),
  providers: Schema.optionalKey(SshHostProviders),
  publicKey: Schema.optionalKey(Schema.String),
  keyAuth: Schema.optionalKey(SshKeyAuthInstructions),
  setup: Schema.optionalKey(SshHostSetupProgress),
});

/** Check a snapshot before publishing it through IPC or an SSH host tool. */
export function validateSshHostStatus(status: typeof SshHostStatusShape.Type) {
  if ((status.state === "preparing") !== (status.phase !== undefined)) return false;
  if (status.upload !== undefined && status.phase !== "uploading") return false;
  if (status.state === "failed" && status.failure === undefined) return false;
  if (
    status.refreshDeferred !== undefined &&
    ((status.state !== "ready" && status.state !== "providers_not_ready") ||
      status.runtimeVersion === null ||
      status.failure !== undefined ||
      status.refreshDeferred.requestedVersion !== status.requestedVersion)
  )
    return false;
  if (status.waitingReason !== undefined && status.state !== "update_waiting") return false;
  if (
    (status.publicKey !== undefined || status.keyAuth !== undefined) &&
    status.state !== "auth_failed"
  )
    return false;
  if (status.keyAuth?.publicKey !== undefined && status.keyAuth.publicKey !== status.publicKey)
    return false;
  if (
    status.failure !== undefined &&
    (status.failure.reason === "archive_unavailable") !== (status.failure.archive !== undefined)
  ) {
    return false;
  }
  if (status.state === "providers_not_ready") {
    return status.runtimeVersion !== null && status.providers?.ready === false;
  }
  return status.state !== "ready" || status.providers?.ready !== false;
}

export const SshHostStatus = SshHostStatusShape.check(Schema.makeFilter(validateSshHostStatus));
export type SshHostStatus = typeof SshHostStatus.Type;

export const SshHostStatusInput = Schema.Struct({ host: SshHostAlias });
export type SshHostStatusInput = typeof SshHostStatusInput.Type;

export const SshRuntimeUpdateInput = Schema.Struct({
  host: SshHostAlias,
  // Callers omit mode to use the service's idle-safe when_idle default.
  mode: Schema.optionalKey(SshRuntimeUpdateMode),
});
export type SshRuntimeUpdateInput = typeof SshRuntimeUpdateInput.Type;

export const SshHostAddInput = Schema.Struct({
  address: TrimmedNonEmptyString,
  user: Schema.optional(TrimmedNonEmptyString),
  port: Schema.optional(PortSchema),
  alias: Schema.optional(SshHostAlias),
  label: Schema.optional(TrimmedNonEmptyString),
  identityFile: Schema.optional(TrimmedNonEmptyString),
});
export type SshHostAddInput = typeof SshHostAddInput.Type;

export const SshPreflightStepId = Schema.Literals([
  "reachability",
  "host_key",
  "key_auth",
  "platform",
  "disk",
  "runtime",
]);
export type SshPreflightStepId = typeof SshPreflightStepId.Type;

/** Display order; disk is evaluated after runtime because only a transfer needs free space. */
export const SSH_PREFLIGHT_STEP_ORDER: ReadonlyArray<SshPreflightStepId> =
  SshPreflightStepId.literals;

export const SshPreflightStepState = Schema.Literals([
  "passed",
  "warning",
  "needs_review",
  "failed",
  "skipped",
]);
export type SshPreflightStepState = typeof SshPreflightStepState.Type;

export const SshPreflightStep = Schema.Struct({
  id: SshPreflightStepId,
  state: SshPreflightStepState,
  /** One line a person can read without knowing SSH internals. */
  summary: TrimmedNonEmptyString,
  detail: Schema.optionalKey(TrimmedNonEmptyString),
  fix: Schema.optionalKey(SshHostFix),
  /** The negotiated host key, present only on a host_key step that needs review. */
  fingerprint: Schema.optionalKey(TrimmedNonEmptyString),
});
export type SshPreflightStep = typeof SshPreflightStep.Type;

export const SshPreflightInput = Schema.Struct({
  /** An ~/.ssh/config alias, or user@address with an optional :port. */
  host: TrimmedNonEmptyString,
  user: Schema.optional(TrimmedNonEmptyString),
  port: Schema.optional(PortSchema),
  identityFile: Schema.optional(TrimmedNonEmptyString),
});
export type SshPreflightInput = typeof SshPreflightInput.Type;

export const SshPreflightReport = Schema.Struct({
  host: TrimmedNonEmptyString,
  destination: Schema.Struct({
    // A person's own ~/.ssh/config alias; only aliases GOAT creates carry the SshHostAlias limit.
    alias: Schema.optionalKey(TrimmedNonEmptyString),
    /** The alias is GOAT's managed entry, so Forget host can remove it and its pin. */
    managed: Schema.optionalKey(Schema.Literal(true)),
    hostname: TrimmedNonEmptyString,
    user: TrimmedNonEmptyString,
    port: PortSchema,
  }),
  steps: Schema.Array(SshPreflightStep),
  ready: Schema.Boolean,
  platformKey: Schema.optionalKey(TrimmedNonEmptyString),
}).check(
  Schema.makeFilter(
    (report) =>
      report.steps.length === SSH_PREFLIGHT_STEP_ORDER.length &&
      report.steps.every((step, index) => step.id === SSH_PREFLIGHT_STEP_ORDER[index]) &&
      report.ready ===
        report.steps.every((step) => step.state !== "failed" && step.state !== "needs_review"),
  ),
);
export type SshPreflightReport = typeof SshPreflightReport.Type;

export const SshHostPrepareInput = Schema.Struct({ host: SshHostAlias });
export type SshHostPrepareInput = typeof SshHostPrepareInput.Type;

export const SshHostForgetInput = Schema.Struct({
  host: SshHostAlias,
  stopRuntime: Schema.Literals(["if_idle", "no"]),
});
export type SshHostForgetInput = typeof SshHostForgetInput.Type;

export const SshHostTrustInput = Schema.Struct({
  probeId: TrimmedNonEmptyString,
  accepted: Schema.Boolean,
});
export type SshHostTrustInput = typeof SshHostTrustInput.Type;

/** Client probe errors distinguish transport failures without exposing SSH diagnostics or keys. */
export class SshHostProbeError extends Schema.TaggedError<SshHostProbeError>()(
  "SshHostProbeError",
  {
    host: Schema.String,
    reason: Schema.Literals([
      "unreachable",
      "connection_refused",
      "invalid_request",
      "alias_conflict",
      "operation_failed",
    ]),
    message: TrimmedNonEmptyString,
  },
) {}

/** Private client response; never use as an MCP result schema. */
export const SshHostProbeResult = Schema.Struct({
  probeId: TrimmedNonEmptyString,
  host: SshHostAlias,
  human: HandoffHuman,
  includeRequired: Schema.Boolean,
});
export type SshHostProbeResult = typeof SshHostProbeResult.Type;

function sameProviders(left: SshHostProviders, right: SshHostProviders) {
  return (
    left.checkedAt === right.checkedAt &&
    left.ready === right.ready &&
    left.fixes.length === right.fixes.length &&
    left.fixes.every((fix, index) => {
      const other = right.fixes[index];
      return (
        other !== undefined &&
        fix.actor === other.actor &&
        fix.instruction === other.instruction &&
        fix.path === other.path &&
        fix.handoff === other.handoff &&
        fix.command === other.command
      );
    })
  );
}

export const SshHostResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("ok"),
    status: SshHostStatus,
    publicKey: Schema.optionalKey(Schema.String),
    providers: Schema.optionalKey(SshHostProviders),
  }),
  Schema.Struct({
    kind: Schema.Literal("error"),
    code: SshHostErrorCode,
    message: Schema.String,
    status: Schema.optionalKey(SshHostStatus),
    fix: Schema.optionalKey(ProviderDiagnosisFix),
  }),
  Schema.Struct({
    kind: Schema.Literal("needs_human"),
    handoff: HandoffSummary,
    next: Schema.Struct({
      after: Schema.Literals(["approval", "terminal"]),
      call: Schema.Literals(["goat_ssh_host_status", "goat_ssh_host_prepare"]),
    }),
    status: SshHostStatus,
  }),
]).check(
  Schema.makeFilter(
    (result) =>
      result.kind !== "ok" ||
      result.providers === undefined ||
      (result.status.providers !== undefined &&
        sameProviders(result.providers, result.status.providers)),
  ),
);
export type SshHostResult = typeof SshHostResult.Type;

export const SshHandoffProgressInput = HandoffReadInput;
export type SshHandoffProgressInput = typeof SshHandoffProgressInput.Type;

export const SshHandoffProgressResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("available"),
    host: SshHostAlias,
    operationId: TrimmedNonEmptyString,
    generation: Schema.Int,
    result: SshHostResult,
  }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    reason: Schema.Literals(["not_ssh", "expired", "superseded"]),
  }),
]).check(
  Schema.makeFilter((progress) => {
    if (progress.kind === "unavailable") return true;
    const setup = progress.result.status?.setup;
    return (
      setup === undefined ||
      (setup.operationId === progress.operationId && setup.generation === progress.generation)
    );
  }),
);
export type SshHandoffProgressResult = typeof SshHandoffProgressResult.Type;

const quoteShellArgument = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Formats public key-auth guidance for the person using the SSH origin's terminal. */
export function buildSshKeyAuthInstructions(context: {
  readonly originLabel: string;
  readonly host: string;
  readonly alias?: string;
  readonly user: string;
  readonly port: number;
  readonly publicKey?: string;
  readonly publicKeyPath?: string;
  readonly generatedKey?: boolean;
}) {
  const introduction =
    context.generatedKey && context.publicKey !== undefined
      ? `GOAT created a key for ${context.host}. Add this public key to the server. Most providers ask for it when you create a server.`
      : `${context.host} refused the SSH key. Add your public key to the server, then try again.`;
  const command =
    context.publicKeyPath === undefined
      ? undefined
      : context.alias
        ? `ssh-copy-id -i ${quoteShellArgument(context.publicKeyPath)} ${quoteShellArgument(context.alias)}`
        : `ssh-copy-id -i ${quoteShellArgument(context.publicKeyPath)} -p ${quoteShellArgument(String(context.port))} ${quoteShellArgument(`${context.user}@${context.host}`)}`;
  return {
    originLabel: context.originLabel,
    instruction: `${introduction} Run this on ${context.originLabel}.`,
    ...(command === undefined ? {} : { command }),
    ...(context.publicKey === undefined ? {} : { publicKey: context.publicKey }),
  };
}
