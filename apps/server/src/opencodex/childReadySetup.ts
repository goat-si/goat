import {
  type ChildReadyDevice,
  type ChildReadyFailure,
  ChildReadyFailureCode,
  type ChildReadyNextAction,
  type ChildReadyStep,
  type OpenCodexChildSetup,
  type OpenCodexInventorySnapshot,
} from "@goat/contracts";
import * as Schema from "effect/Schema";

/** A Child setup step's typed refusal; prepare answers it as data so its code crosses the wire. */
export class ChildStepError extends Schema.TaggedError<ChildStepError>()("ChildStepError", {
  code: ChildReadyFailureCode,
  step: Schema.String,
}) {}

const MESSAGES: Partial<Record<ChildReadyFailure["code"], string>> = {
  installation_failed: "The install did not finish on this Child. Retry setup.",
  startup_failed: "OpenCodex could not be started on this Child.",
  ocx_unusable: "Another OpenCodex is selected on this Child. Resolve that executable, then retry.",
  platform_unsupported: "This Child's platform is not supported.",
  instance_changed:
    "The bootstrap Codex instance was changed on this Child; GOAT kept your change.",
  instance_busy: "Codex on this Child is busy. Retry setup later.",
  stale_configuration: "Settings changed on this Child during setup. Retry setup.",
  link_changed: "This Child is no longer linked to this Home. Reconnect it, then retry.",
  catalog_sync_failed: "The Home's model catalog could not be written on this Child.",
  route_unverified: "Codex on this Child could not be verified on its Home route.",
  probe_unsupported: "This Codex cannot run a tool-free check request.",
  probe_failed: "The check request through Home did not complete.",
  probe_timeout: "The check request through Home timed out. Retry setup.",
  attribution_unproven:
    "Update OpenCodex on this Child to a release that attests local credentials and link continuity, then retry verification.",
  proof_expired: "The last verification expired. Retry setup to verify again.",
  storage_failed: "Setup records on this Child could not be saved.",
  interrupted:
    "A previous check may have completed without being recorded. Retry setup to verify again.",
  purpose_expired: "A setup step timed out. Retry setup.",
  phase_timeout: "A setup step timed out. Retry setup.",
};
const RETRYABLE: ReadonlySet<string> = new Set([
  "installation_failed",
  "startup_failed",
  "instance_busy",
  "stale_configuration",
  "probe_timeout",
  "storage_failed",
  "interrupted",
  "unreachable",
  "purpose_expired",
  "phase_timeout",
  "proof_expired",
]);

export const failureFor = (
  code: ChildReadyFailure["code"],
  step: ChildReadyStep,
): ChildReadyFailure => ({
  code,
  step,
  message: MESSAGES[code] ?? "Child setup stopped.",
  retryable: RETRYABLE.has(code),
});

export const childError = (code: ChildReadyFailure["code"], step: ChildReadyStep) =>
  new ChildStepError({ code, step });

/** One next action per failure: GOAT update only after a real outdated refusal. */
const nextActionFor = (failure: ChildReadyFailure | undefined): ChildReadyNextAction =>
  failure === undefined
    ? "none"
    : failure.code === "remote_outdated"
      ? "update_goat"
      : failure.code === "link_changed"
        ? "reconnect_home"
        : failure.retryable
          ? "retry"
          : "review_settings";

const ORDER: ReadonlyArray<ChildReadyStep> = [
  "goat_available",
  "opencodex_running",
  "link_established",
  "codex_installed",
  "instance_routed",
  "inference_verified",
];

/** The ordered six-step record: everything before `step` succeeded, `step` has `state`. */
export const stepStates = (
  step: ChildReadyStep,
  state: "running" | "succeeded" | "failed",
): OpenCodexChildSetup["steps"] =>
  ORDER.map((name, index) => {
    const at = ORDER.indexOf(step);
    return {
      step: name,
      state: index < at ? "succeeded" : index === at ? state : "pending",
    };
  });

/** The setup record with its failure and action applied; a failure always drops the proof. */
export const withFailure = (
  setup: OpenCodexChildSetup,
  failure: ChildReadyFailure,
): OpenCodexChildSetup => {
  const { proof: _proof, ...rest } = setup;
  return {
    ...rest,
    steps: stepStates(failure.step, "failed"),
    readiness: "invalid",
    attribution: "unproven",
    failure,
    nextAction: nextActionFor(failure),
  };
};

/**
 * The device as this Child sees it now: the selected ocx (never a listener's own claim), and a
 * connection role read from live health. Healthy needs a selected executable whose version the
 * listener reports too; a missing role is unknown, never standalone.
 */
export const deviceFromSnapshot = (
  snapshot: OpenCodexInventorySnapshot,
  platform: string,
  arch: string,
): { readonly device: ChildReadyDevice; readonly healthy: boolean } => {
  const selected = snapshot.binaries[0];
  const ocx: ChildReadyDevice["ocx"] =
    selected === undefined || snapshot.ownership === "none"
      ? { path: null, version: null, ownership: "missing" }
      : { path: selected.path, version: selected.version, ownership: snapshot.ownership };
  const observed = snapshot.runtime.healthy ? snapshot.parityEvidence?.healthRole : undefined;
  const role: ChildReadyDevice["connection"]["role"] =
    observed === "standalone" || observed === "hub" || observed === "client" ? observed : "unknown";
  const linkId = role === "client" ? snapshot.parityEvidence?.childLinkId : undefined;
  return {
    device: {
      platform,
      arch,
      ocx,
      connection: { role, ...(linkId === undefined ? {} : { linkId }) },
    },
    healthy:
      ocx.path !== null &&
      snapshot.runtime.healthy &&
      snapshot.runtime.version === ocx.version &&
      role !== "unknown",
  };
};
