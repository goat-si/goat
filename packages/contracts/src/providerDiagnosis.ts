/**
 * Read-only provider diagnosis: why a provider instance cannot run, and the
 * next step for each reason, naming whether an agent or a person takes it.
 *
 * Shared by the `goat_provider_diagnose` MCP tool and `goat provider diagnose`.
 * Never carries credential values, environment values, tokens, or sign-in URLs.
 */
import * as Schema from "effect/Schema";

import { SshHostAlias, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/** Who takes the next step. A person is needed whenever the step widens access or signs in. */
export const ProviderDiagnosisActor = Schema.Literals(["agent", "human"]);
export type ProviderDiagnosisActor = typeof ProviderDiagnosisActor.Type;

/** The handoff kind a person would finish (see docs/internals/agent-surface.md, Handoffs). */
export const ProviderDiagnosisHandoffKind = Schema.Literals([
  "approval",
  "terminal",
  "oauth",
  "device_code",
]);
export type ProviderDiagnosisHandoffKind = typeof ProviderDiagnosisHandoffKind.Type;

export const ProviderDiagnosisFix = Schema.Struct({
  actor: ProviderDiagnosisActor,
  /** One plain sentence saying what to do now. */
  instruction: TrimmedNonEmptyString,
  /** Agent surface path that performs or starts this step, such as `provider.setup`. */
  path: Schema.optionalKey(TrimmedNonEmptyString),
  handoff: Schema.optionalKey(ProviderDiagnosisHandoffKind),
  /** A command the person runs in a terminal on the environment's machine. */
  command: Schema.optionalKey(TrimmedNonEmptyString),
  /**
   * The GOAT tool call that applies this fix. A caller allowed to manage providers makes it
   * directly; any other thread agent gets an approval card from it.
   */
  call: Schema.optionalKey(
    Schema.Struct({
      tool: TrimmedNonEmptyString,
      arguments: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
});
export type ProviderDiagnosisFix = typeof ProviderDiagnosisFix.Type;

export const ProviderDiagnosisCheckStatus = Schema.Literals([
  "pass",
  "fail",
  "warn",
  "unknown",
  "skipped",
]);
export type ProviderDiagnosisCheckStatus = typeof ProviderDiagnosisCheckStatus.Type;

export const ProviderDiagnosisReason = Schema.Literals([
  "instance_missing",
  "driver_unavailable",
  "disabled",
  "sibling_missing",
  "sibling_invalid",
  "sibling_not_ready",
  "forbidden_environment",
  "executable_missing",
  "version_unsupported",
  "cloud_unsupported",
  "not_signed_in",
  "wrong_sign_in",
  "not_checked",
  "provider_error",
  "probe_failed",
  "repository_missing",
  "repository_unsupported",
  "repository_access_unverified",
]);
export type ProviderDiagnosisReason = typeof ProviderDiagnosisReason.Type;

export const ProviderDiagnosisCheck = Schema.Struct({
  /** What was checked: instance, enabled, sibling, environment, executable, version, auth, cloud, readiness, repository, opencodex_route. */
  id: TrimmedNonEmptyString,
  status: ProviderDiagnosisCheckStatus,
  reason: Schema.optionalKey(ProviderDiagnosisReason),
  summary: TrimmedNonEmptyString,
  fix: Schema.optionalKey(ProviderDiagnosisFix),
});
export type ProviderDiagnosisCheck = typeof ProviderDiagnosisCheck.Type;

export const ProviderDiagnosis = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  /** False when settings have no entry and the driver runs no default instance. */
  configured: Schema.Boolean,
  /** No check failed. Warnings and unknowns do not block. */
  ready: Schema.Boolean,
  checks: Schema.Array(ProviderDiagnosisCheck),
});
export type ProviderDiagnosis = typeof ProviderDiagnosis.Type;

export const ProviderDiagnoseInput = Schema.Struct({
  instanceId: Schema.optional(ProviderInstanceId).annotate({
    description: "Diagnose one provider instance. Omit to diagnose every instance.",
  }),
  driver: Schema.optional(ProviderDriverKind).annotate({
    description:
      "Diagnose every instance of one driver, such as claudeCloud or devinCloud. A cloud driver with no instance is still diagnosed so the result says how to add one.",
  }),
  cwd: Schema.optional(TrimmedNonEmptyString).annotate({
    description:
      "Absolute project folder. When set, cloud providers also check that the folder has a repository remote they can reach.",
  }),
});
export type ProviderDiagnoseInput = typeof ProviderDiagnoseInput.Type;

export const ProviderDiagnoseResult = Schema.Struct({
  /** Where the checks ran: inside the GOAT server, or in a `goat` CLI process with its own environment. */
  checkedBy: Schema.Literals(["server", "cli"]),
  diagnoses: Schema.Array(ProviderDiagnosis),
});
export type ProviderDiagnoseResult = typeof ProviderDiagnoseResult.Type;

/** Transport wrapper; remove host before invoking the destination's local diagnosis. */
export const ProviderDiagnoseOnHostInput = Schema.Struct({
  ...ProviderDiagnoseInput.fields,
  host: Schema.optional(SshHostAlias),
});
export type ProviderDiagnoseOnHostInput = typeof ProviderDiagnoseOnHostInput.Type;

export const ProviderDiagnoseOnHostResult = Schema.Struct({
  ...ProviderDiagnoseResult.fields,
  host: Schema.optional(SshHostAlias),
});
export type ProviderDiagnoseOnHostResult = typeof ProviderDiagnoseOnHostResult.Type;
