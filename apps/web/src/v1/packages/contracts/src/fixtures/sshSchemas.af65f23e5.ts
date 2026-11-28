// Wire schemas copied from af65f23e5234c0e9dbea48e9a1fbda74b02450b9.
// Leaf dependencies below did not change; keep the closed fields independent of current schemas.
import * as Schema from "effect/Schema";
import { DesktopSshEnvironmentTargetSchema } from "../ipc.ts";
import {
  SshHostState,
  SshRuntimePhase,
  SshHostFailure,
  SshHostProviders,
  SshKeyAuthInstructions,
  SshHostSetupProgress,
} from "../sshHost.ts";

export const SshRefreshDeferred = Schema.Struct({
  reason: Schema.Literals(["archive_unavailable"]),
  requestedVersion: Schema.String,
  detail: Schema.String,
});

const SshHostStatusShape = Schema.Struct({
  host: Schema.String,
  state: SshHostState,
  runtimeVersion: Schema.NullOr(Schema.String),
  requestedVersion: Schema.String,
  phase: Schema.optionalKey(SshRuntimePhase),
  waitingReason: Schema.optionalKey(Schema.Literals(["busy", "unknown", "contended"])),
  detail: Schema.optionalKey(Schema.String),
  failure: Schema.optionalKey(SshHostFailure),
  refreshDeferred: Schema.optionalKey(SshRefreshDeferred),
  providers: Schema.optionalKey(SshHostProviders),
  publicKey: Schema.optionalKey(Schema.String),
  keyAuth: Schema.optionalKey(SshKeyAuthInstructions),
  setup: Schema.optionalKey(SshHostSetupProgress),
});

/** Check a snapshot before publishing it through IPC or an SSH host tool. */
function validateSshHostStatus(status: typeof SshHostStatusShape.Type) {
  if ((status.state === "preparing") !== (status.phase !== undefined)) return false;
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

export const SshRuntimePendingReplacementSchema = Schema.Struct({
  reason: Schema.Literals(["busy", "unknown", "contended"]),
  detail: Schema.optionalKey(Schema.Literal("recovery-stale")),
  /** `capability`: the live runtime cannot issue sessions this app needs, such as memory scopes. */
  replacement: Schema.Literals(["older", "legacy", "incompatible", "capability"]),
  requestedVersion: Schema.String,
  liveVersion: Schema.String,
});
export type SshRuntimePendingReplacement = typeof SshRuntimePendingReplacementSchema.Type;

export const DesktopSshEnvironmentBootstrapSchema = Schema.Struct({
  target: DesktopSshEnvironmentTargetSchema,
  httpBaseUrl: Schema.String,
  wsBaseUrl: Schema.String,
  pairingToken: Schema.NullOr(Schema.String),
  remotePort: Schema.optionalKey(Schema.Number),
  remoteServerKind: Schema.optionalKey(Schema.Literals(["external", "managed"])),
  remoteServerVersion: Schema.optionalKey(Schema.String),
  pendingReplacement: Schema.optionalKey(SshRuntimePendingReplacementSchema),
});

export const DesktopSshRuntimePendingResultSchema = Schema.Struct({
  type: Schema.Literal("ssh-runtime-pending"),
  target: DesktopSshEnvironmentTargetSchema,
  pending: SshRuntimePendingReplacementSchema,
});
export type DesktopSshRuntimePendingResult = typeof DesktopSshRuntimePendingResultSchema.Type;
