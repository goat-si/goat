import {
  CHILD_SETUP_PHASE_MS,
  type ChildReadyDeviceResult,
  type ChildReadyFailure,
  type ChildReadyProof,
  childReadyProofIsCurrent,
  type OpenCodexChildBootstrapStatus,
  type OpenCodexChildSetup,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

import { toChildReadyFailure } from "./ChildReadyDispatch.ts";

type Status = OpenCodexChildBootstrapStatus;

/** How long one Child confirmation of a recorded Ready stands before status asks again. */
export const READY_CHECK_TTL_MS = 30_000;

interface Verdict {
  readonly operationId: string;
  readonly at: number;
  readonly failure: ChildReadyFailure | undefined;
}

const unconfirmed: ChildReadyFailure = {
  code: "route_unverified",
  step: "inference_verified",
  message: "The Child did not confirm its last verification. Retry setup to verify again.",
  retryable: true,
};

/** Why the Child's own fresh status does not hold the exact proof this Home recorded. */
export const confirmationFailure = (
  recorded: ChildReadyProof,
  answer: ChildReadyDeviceResult,
  now: number,
): ChildReadyFailure | undefined => {
  const setup = answer.setup;
  if (setup !== undefined && setup.readiness !== "ready" && setup.failure !== undefined)
    return setup.failure;
  if (
    !answer.healthy ||
    answer.device.connection.role !== "client" ||
    answer.device.connection.linkId !== recorded.linkId
  )
    return {
      code: "link_changed",
      step: "link_established",
      message: "The Child is no longer linked to this Home link.",
      retryable: false,
    };
  const proof = setup?.proof;
  return setup?.readiness === "ready" &&
    proof !== undefined &&
    proof.operationId === recorded.operationId &&
    proof.linkId === recorded.linkId &&
    proof.completedAt === recorded.completedAt &&
    childReadyProofIsCurrent(proof, now)
    ? undefined
    : unconfirmed;
};

/** A Ready the Child did not confirm reads as linked and unverified, with why; never Ready. */
export const withUnverifiedReady = (status: Status, failure: ChildReadyFailure): Status => {
  if (status.setup === undefined) return status;
  const { proof: _proof, ...setup } = status.setup;
  return {
    ...status,
    setup: { ...setup, readiness: "linked", attribution: "unproven", failure, nextAction: "retry" },
  };
};

/**
 * Status shows Ready only while a fresh, non-billed Child status read confirms the recorded
 * proof. Each verdict stands for READY_CHECK_TTL_MS per machine and proof, concurrent readers
 * share one read, and the read is bounded by the status phase.
 */
export const makeReadyVerifier = <E>(
  read: (alias: string, setup: OpenCodexChildSetup) => Effect.Effect<ChildReadyDeviceResult, E>,
  scope: Scope.Scope,
) => {
  const verdicts = new Map<string, Verdict>();
  const inflight = new Map<string, Fiber.Fiber<Verdict>>();
  const check = Effect.fn("ChildReadyVerification.check")(function* (
    alias: string,
    setup: OpenCodexChildSetup,
    proof: ChildReadyProof,
  ) {
    const pending = inflight.get(alias);
    if (pending !== undefined) return yield* Fiber.join(pending);
    const fiber = yield* read(alias, setup).pipe(
      Effect.timeoutOption(Duration.millis(CHILD_SETUP_PHASE_MS.status)),
      Effect.result,
      Effect.flatMap((answer) =>
        Effect.map(Clock.currentTimeMillis, (at): Verdict => ({
          operationId: proof.operationId,
          at,
          failure:
            answer._tag === "Failure"
              ? toChildReadyFailure(answer.failure, "link_established")
              : Option.isNone(answer.success)
                ? toChildReadyFailure(undefined, "link_established")
                : confirmationFailure(proof, answer.success.value, at),
        })),
      ),
      Effect.tap((verdict) => Effect.sync(() => verdicts.set(alias, verdict))),
      Effect.ensuring(Effect.sync(() => inflight.delete(alias))),
      Effect.forkIn(scope, { startImmediately: false }),
    );
    inflight.set(alias, fiber);
    return yield* Fiber.join(fiber);
  });
  return Effect.fn("ChildReadyVerification.present")(function* (alias: string, status: Status) {
    const setup = status.setup;
    const proof = setup?.proof;
    if (setup === undefined || proof === undefined || setup.readiness !== "ready") return status;
    const now = yield* Clock.currentTimeMillis;
    const cached = verdicts.get(alias);
    const verdict =
      cached !== undefined &&
      cached.operationId === proof.operationId &&
      now - cached.at < READY_CHECK_TTL_MS
        ? cached
        : yield* check(alias, setup, proof);
    return verdict.failure === undefined ? status : withUnverifiedReady(status, verdict.failure);
  });
};
