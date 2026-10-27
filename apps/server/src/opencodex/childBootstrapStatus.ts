import {
  type ChildReadyFailure,
  type ChildReadyNextAction,
  type ChildReadyResult,
  childReadyProofIsCurrent,
  OpenCodexChildBootstrapStatus,
  withoutUnprovenReady,
} from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

type Status = OpenCodexChildBootstrapStatus;

const TIMEOUT_MESSAGE = "A setup step timed out. Retry setup.";
const isTimeout = (failure: ChildReadyFailure | undefined) =>
  failure?.code === "purpose_expired" || failure?.code === "phase_timeout";
const actionable = (action: ChildReadyNextAction) =>
  action === "continue_setup" || action === "retry" || action === "reconnect_home";

/**
 * The one next action a status offers. A Child linked before setup existed offers
 * continue_setup; GOAT update guidance comes only from a real outdated refusal or the Child's
 * own setup, and is never actionable here.
 */
export const presentSetupAction = (recorded: Status): Status => {
  const status =
    recorded.setup === undefined
      ? recorded
      : { ...recorded, setup: withoutUnprovenReady(recorded.setup) };
  const failure = status.setup === undefined ? status.failure : status.setup.failure;
  if (isTimeout(failure) && failure !== undefined) {
    const timedOut = { ...failure, retryable: true, message: TIMEOUT_MESSAGE };
    return {
      ...status,
      reason: "setup_step_timeout",
      failure: timedOut,
      nextAction: "retry",
      actionable: true,
      ...(status.setup === undefined
        ? {}
        : { setup: { ...status.setup, failure: timedOut, nextAction: "retry" } }),
    };
  }
  if (failure?.code === "remote_outdated")
    return { ...status, nextAction: "update_goat", actionable: false };
  if ((status.state === "child" || status.state === "degraded") && status.setup === undefined)
    return { ...status, nextAction: "continue_setup", actionable: true };
  const nextAction = status.setup?.nextAction ?? status.nextAction ?? "none";
  return { ...status, nextAction, actionable: actionable(nextAction) };
};

/** A setup failure on the Home's record; membership stays, the proof never does. */
export const withSetupFailure = (
  previous: Status | undefined,
  failure: ChildReadyFailure,
): Omit<Status, "checkedAt"> => {
  const timedOut = isTimeout(failure);
  const normalized = timedOut ? { ...failure, retryable: true, message: TIMEOUT_MESSAGE } : failure;
  const nextAction: ChildReadyNextAction = timedOut
    ? "retry"
    : failure.code === "remote_outdated"
      ? "update_goat"
      : failure.code === "link_changed"
        ? "reconnect_home"
        : failure.retryable
          ? "retry"
          : "review_settings";
  const {
    setup,
    checkedAt: _checkedAt,
    ...rest
  }: Status = previous ?? {
    state: "blocked",
    checkedAt: 0,
  };
  const linked = rest.state === "child" || rest.state === "degraded";
  return {
    ...rest,
    state: linked ? rest.state : "blocked",
    ...(timedOut ? { reason: "setup_step_timeout" as const } : {}),
    ...(!linked && !timedOut && rest.reason === undefined
      ? { reason: "unreachable" as const }
      : {}),
    step: failure.step,
    failure: normalized,
    nextAction,
    actionable: actionable(nextAction),
    ...(setup === undefined
      ? {}
      : {
          setup: (({ proof: _proof, ...kept }) => ({
            ...kept,
            readiness: "invalid" as const,
            failure: normalized,
            nextAction,
          }))(setup),
        }),
  };
};

/** A recorded Ready whose 24 hours ran out reads as invalid, with no request made. */
export const withCurrentProof = (status: Status, now: number): Status => {
  const proof = status.setup?.proof;
  if (status.setup === undefined || proof === undefined || childReadyProofIsCurrent(proof, now))
    return status;
  const { proof: _proof, ...setup } = status.setup;
  return {
    ...status,
    setup: {
      ...setup,
      readiness: "invalid",
      failure: {
        code: "proof_expired",
        step: "inference_verified",
        message: "The last verification expired. Retry setup to verify again.",
        retryable: true,
      },
      nextAction: "retry",
    },
  };
};

/** What hub.device_setup answers for a finished job. */
export const setupResult = (status: Status | undefined): ChildReadyResult =>
  status?.setup !== undefined && status.failure === undefined
    ? { kind: "ok", setup: status.setup }
    : {
        kind: "error",
        failure: status?.failure ??
          status?.setup?.failure ?? {
            code: status === undefined ? "setup_approval_revoked" : "unreachable",
            step: status?.step ?? "goat_available",
            message:
              status === undefined
                ? "This machine has no standing Child setup permission."
                : (status.message ?? "Child setup did not finish."),
            retryable: status !== undefined,
          },
      };

const decodeEntries = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeStatus = Schema.decodeUnknownOption(OpenCodexChildBootstrapStatus);
const withoutUnprovenStatus = (status: Status): Status =>
  status.setup === undefined ? status : { ...status, setup: withoutUnprovenReady(status.setup) };

/**
 * Stored records, each decoded on its own: one corrupt alias shows as a storage failure and
 * keeps the others. Legacy records without setup stay valid.
 */
export const decodeStoredRecords = (text: string, now: number): Record<string, Status> => {
  const entries = Option.getOrElse(decodeEntries(text), () => ({}));
  return Object.fromEntries(
    Object.entries(entries).map(([alias, raw]): [string, Status] => [
      alias,
      Option.getOrElse(Option.map(decodeStatus(raw), withoutUnprovenStatus), () => ({
        state: "blocked" as const,
        checkedAt: now,
        reason: "unreachable" as const,
        failure: {
          code: "storage_failed" as const,
          step: "goat_available" as const,
          message: "This machine's setup record could not be read. Retry setup.",
          retryable: true,
        },
        nextAction: "retry" as const,
        actionable: true,
      })),
    ]),
  );
};
