import * as Schema from "effect/Schema";

import { IsoDateTime } from "./baseSchemas.ts";
import { HandoffSummary } from "./handoff.ts";
import { ProviderDiagnosisFix } from "./providerDiagnosis.ts";

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

const SshHostStatusShape = Schema.Struct({
  host: Schema.String,
  state: SshHostState,
  runtimeVersion: Schema.NullOr(Schema.String),
  requestedVersion: Schema.String,
  phase: Schema.optionalKey(SshRuntimePhase),
  waitingReason: Schema.optionalKey(Schema.Literals(["busy", "unknown", "contended"])),
  detail: Schema.optionalKey(Schema.String),
  failure: Schema.optionalKey(SshHostFailure),
  providers: Schema.optionalKey(SshHostProviders),
});

/** Check a snapshot before publishing it through IPC or an SSH host tool. */
export function validateSshHostStatus(status: typeof SshHostStatusShape.Type) {
  if ((status.state === "preparing") !== (status.phase !== undefined)) return false;
  if (status.state === "failed" && status.failure === undefined) return false;
  if (status.waitingReason !== undefined && status.state !== "update_waiting") return false;
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

export const SshHostStatusInput = Schema.Struct({ host: Schema.String });
export type SshHostStatusInput = typeof SshHostStatusInput.Type;

export const SshRuntimeUpdateInput = Schema.Struct({
  host: Schema.String,
  // Callers omit mode to use the service's idle-safe when_idle default.
  mode: Schema.optionalKey(SshRuntimeUpdateMode),
});
export type SshRuntimeUpdateInput = typeof SshRuntimeUpdateInput.Type;

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
