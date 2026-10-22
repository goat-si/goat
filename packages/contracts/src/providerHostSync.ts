/**
 * Provider × host matrix and sync: which coding-agent CLIs each connected
 * machine has, and installing plus signing in to one on other machines.
 *
 * Every host installs and signs in on its own, with the provider's official
 * installer and login. Results never carry credentials, tokens, environment
 * values, or installer output; a device code and its verification page are
 * the only sign-in data relayed, because the person must type them elsewhere.
 *
 * `cloud` on a row, present only when the request sets `cloud: true`, is whether
 * that machine can launch Claude Cloud, Cursor Cloud, and Devin Cloud. It is the
 * holder diagnosis, not the CLI `signed_in` flag: an API key or a `GIT_*`
 * override can be signed in and still not launch. Settings omits it.
 */
import * as Schema from "effect/Schema";

import {
  ForwardCompatibleOptional,
  IsoDateTime,
  SshHostAlias,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { CloudHolder } from "./cloudAgents.ts";
import { HostComputerUse } from "./cua.ts";
import { HandoffSummary } from "./handoff.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

/** Drivers whose CLI GOAT knows how to install with the vendor's own installer. */
export const ProviderHostSyncDriver = Schema.Literals([
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "opencode",
  "pi",
]);
export type ProviderHostSyncDriver = typeof ProviderHostSyncDriver.Type;

/** npm: the vendor's npm package. script: the vendor's install script. manual: a person installs it. */
export const ProviderHostInstallMethod = Schema.Literals(["npm", "script", "manual"]);
export type ProviderHostInstallMethod = typeof ProviderHostInstallMethod.Type;

/**
 * goat: GOAT's own sign-in for that provider instance. device_code: the CLI's
 * official device login, relayed as a code. terminal: a person runs the CLI's
 * login on that machine.
 */
export const ProviderHostLoginMethod = Schema.Literals(["goat", "device_code", "terminal"]);
export type ProviderHostLoginMethod = typeof ProviderHostLoginMethod.Type;

const Version = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

export const ProviderHostProviderState = Schema.Struct({
  driver: ProviderDriverKind,
  displayName: TrimmedNonEmptyString,
  installed: Schema.Boolean,
  version: Schema.NullOr(Version),
  auth: Schema.Literals(["signed_in", "signed_out", "unknown"]),
  installMethod: ProviderHostInstallMethod,
  loginMethod: ProviderHostLoginMethod,
});
export type ProviderHostProviderState = typeof ProviderHostProviderState.Type;

/**
 * One cloud driver's readiness on this machine. Same fields `goat_cloud_holders`
 * reports for a holder, without host or runtime: those belong to the row.
 * Absent keys are omitted; older GOAT rows omit `cloud` entirely.
 */
const holderField = CloudHolder.fields;
export const ProviderHostCloudCell = Schema.Struct({
  instanceId: holderField.instanceId,
  ready: holderField.ready,
  accountLabel: holderField.accountLabel,
  reason: holderField.reason,
  command: holderField.command,
  activeRuns: holderField.activeRuns,
  hub: holderField.hub,
});
export type ProviderHostCloudCell = typeof ProviderHostCloudCell.Type;

export const ProviderHostCloudReadiness = Schema.Struct({
  claudeCloud: ProviderHostCloudCell,
  cursorCloud: ProviderHostCloudCell,
  devinCloud: ProviderHostCloudCell,
});
export type ProviderHostCloudReadiness = typeof ProviderHostCloudReadiness.Type;

/**
 * ok: the host answered. update_runtime: its GOAT predates this tool.
 * not_ready: its runtime is not running; prepare it first. unreachable: SSH
 * or GOAT there did not answer.
 */
export const ProviderHostRowStatus = Schema.Literals([
  "ok",
  "update_runtime",
  "not_ready",
  "unreachable",
]);
export type ProviderHostRowStatus = typeof ProviderHostRowStatus.Type;

export const ProviderHostRow = Schema.Struct({
  /** SSH alias; null is the machine that answered the request. */
  host: Schema.NullOr(SshHostAlias),
  status: ProviderHostRowStatus,
  /** `process.platform` and `process.arch` of that machine. */
  platform: Schema.optionalKey(TrimmedNonEmptyString),
  arch: Schema.optionalKey(TrimmedNonEmptyString),
  goatVersion: Schema.optionalKey(TrimmedNonEmptyString),
  /** Set when the host runs another GOAT build than the machine that asked. */
  versionMismatch: Schema.optionalKey(Schema.Boolean),
  message: Schema.optionalKey(TrimmedNonEmptyString),
  providers: Schema.Array(ProviderHostProviderState),
  /** Present when this GOAT can say whether the machine launches cloud runs. */
  cloud: Schema.optionalKey(ProviderHostCloudReadiness),
  /** Whether that machine can run computer use. Older hosts omit it. */
  computerUse: ForwardCompatibleOptional(HostComputerUse),
});
export type ProviderHostRow = typeof ProviderHostRow.Type;

export const ProviderHostMatrixInput = Schema.Struct({
  hosts: Schema.optional(Schema.Array(SshHostAlias).check(Schema.isMaxLength(32))).annotate({
    description:
      "SSH hosts to include. Omit for connected hosts and the aliases in your ssh config.",
  }),
  localOnly: Schema.optional(Schema.Boolean).annotate({
    description: "Report only this machine. Another machine asking a host sets this.",
  }),
  cloud: Schema.optional(Schema.Boolean).annotate({
    description:
      "Include each row's cloud column; slower because it diagnoses Claude Cloud, Cursor Cloud and Devin Cloud on every machine.",
  }),
});
export type ProviderHostMatrixInput = typeof ProviderHostMatrixInput.Type;

export const ProviderHostMatrixResult = Schema.Struct({
  rows: Schema.Array(ProviderHostRow),
});
export type ProviderHostMatrixResult = typeof ProviderHostMatrixResult.Type;

/**
 * What a person does to finish sign-in on one host. browser is only a
 * vendor-hosted approval page that completes without a callback to that
 * host; a flow that redirects to the host's loopback becomes open_host.
 */
export const ProviderSyncLogin = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("device_code"),
    url: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
    userCode: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  }),
  Schema.Struct({
    type: Schema.Literal("browser"),
    url: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
  }),
  Schema.Struct({
    type: Schema.Literal("terminal"),
    command: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  }),
  Schema.Struct({
    type: Schema.Literal("open_host"),
    instruction: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  }),
]);
export type ProviderSyncLogin = typeof ProviderSyncLogin.Type;

export const ProviderSyncHostPhase = Schema.Literals([
  "queued",
  "installing",
  "installed",
  "signing_in",
  "signed_in",
  "failed",
  "cancelled",
  "update_runtime",
]);
export type ProviderSyncHostPhase = typeof ProviderSyncHostPhase.Type;

export const ProviderSyncHostState = Schema.Struct({
  host: Schema.NullOr(SshHostAlias),
  phase: ProviderSyncHostPhase,
  version: Schema.NullOr(Version),
  message: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(1_024))),
  login: Schema.optionalKey(ProviderSyncLogin),
});
export type ProviderSyncHostState = typeof ProviderSyncHostState.Type;

const SyncId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const ProviderSyncState = Schema.Struct({
  syncId: SyncId,
  driver: ProviderHostSyncDriver,
  /** The version requested on every host; null installs the latest release. */
  version: Schema.NullOr(Version),
  login: Schema.Boolean,
  startedAt: IsoDateTime,
  done: Schema.Boolean,
  hosts: Schema.Array(ProviderSyncHostState),
});
export type ProviderSyncState = typeof ProviderSyncState.Type;

/** Exact release or `latest`. The strict pattern keeps it safe as an installer argument. */
export const ProviderSyncVersion = Schema.String.check(
  Schema.isPattern(
    /^(?:latest|\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z]{1,20}(?:\.[0-9A-Za-z]{1,20}){0,4})?)$/u,
  ),
);

export const ProviderSyncInput = Schema.Struct({
  driver: ProviderHostSyncDriver,
  hosts: Schema.optional(
    Schema.Array(SshHostAlias).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  ).annotate({ description: "SSH hosts to install on. Omit to install on this machine." }),
  version: Schema.optional(ProviderSyncVersion).annotate({
    description:
      'Exact version such as "0.42.0", or "latest". Omit to match the version installed on this machine, or latest when it has none.',
  }),
  login: Schema.optional(Schema.Boolean).annotate({
    description:
      "Start the provider's own sign-in on each host after installing. Defaults to true.",
  }),
});
export type ProviderSyncInput = typeof ProviderSyncInput.Type;

export const ProviderSyncResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("started"), sync: ProviderSyncState }),
  Schema.Struct({
    kind: Schema.Literal("needs_human"),
    handoff: HandoffSummary,
    next: Schema.Struct({
      after: Schema.Literal("approval"),
      call: Schema.Literal("goat_provider_sync_status"),
    }),
  }),
]);
export type ProviderSyncResult = typeof ProviderSyncResult.Type;
/** MCP success schema: HandoffSummary contains a DateTime that must encode as JSON. */
export const ProviderSyncResultJson = Schema.toCodecJson(ProviderSyncResult);

export const ProviderSyncStatusInput = Schema.Struct({
  syncId: Schema.optional(SyncId).annotate({
    description: "The syncId goat_provider_sync returned.",
  }),
  handoffId: Schema.optional(SyncId).annotate({
    description: "The approval handoffId from a needs_human result; finds the sync it started.",
  }),
});
export type ProviderSyncStatusInput = typeof ProviderSyncStatusInput.Type;
export const ProviderSyncCancelInput = Schema.Struct({ syncId: SyncId });
export type ProviderSyncCancelInput = typeof ProviderSyncCancelInput.Type;

/** Safe text only: never installer output, credentials, or sign-in URLs. */
export class ProviderHostSyncError extends Schema.TaggedError<ProviderHostSyncError>()(
  "ProviderHostSyncError",
  {
    code: Schema.Literals(["not_found", "invalid_request", "unavailable", "denied"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}
