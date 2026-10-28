/**
 * What can make a passing readiness check stop speaking for this Mac, and the check's own
 * capture of a GOAT window through the helper (readiness-ui audit F4, F5).
 *
 * A check proves capture and the tree once; that proof used to last until a later check failed.
 * Sleep, a locked screen and a new helper generation each change what macOS will let the helper
 * do without any check failing (ScreenCaptureKit has no shareable display while the panel sleeps,
 * Apple Developer Forums thread 827059), so each drops the proof. On macOS GOAT runs the check
 * again itself before the next agent start; only missing grants still need a person.
 *
 * @module readinessProof
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";

import type { CaptureCheckOutcome } from "./ComputerUseHelper.ts";

/** The power and session events that void a readiness proof, from Electron's powerMonitor. */
export type ProofResetEvent = "resume" | "unlock-screen";
const PROOF_RESET_EVENTS: ReadonlyArray<ProofResetEvent> = ["resume", "unlock-screen"];

/** The slice of ElectronPowerMonitor readiness listens to; tests raise the events themselves. */
export interface ProofResetSource {
  readonly on: (
    event: ProofResetEvent,
    listener: () => void,
  ) => Effect.Effect<void, never, Scope.Scope>;
  /** Told once each event's proof reset has been applied; tests wait on it. */
  readonly handled?: () => void;
}

export const PROOF_RESET_DETAIL: Readonly<Record<ProofResetEvent | "generation", string>> = {
  resume: "This Mac woke from sleep since capture and the tree were last proven.",
  "unlock-screen": "The screen was locked since capture and the tree were last proven.",
  generation: "GOAT Computer Use was updated since capture and the tree were last proven.",
};

/**
 * Why a proof is gone and what renews it: on macOS GOAT's own check before the next agent start,
 * elsewhere a person's check.
 */
export const proofLostDetail = (why: string, platform: NodeJS.Platform) =>
  `${why} ${
    platform === "darwin"
      ? "GOAT proves them again by itself the next time it starts its helper."
      : "Run the readiness check again."
  }`;

/**
 * The automatic check's bound. A passing check takes about two seconds; the server waits 30
 * seconds for the whole start, so a hung check still leaves the agent's own start time to run.
 */
export const REPROVE_TIMEOUT = Duration.seconds(8);

/**
 * Applies reset to each event, one at a time, for as long as the scope lives. Electron can raise
 * one resume twice (electron/electron#24803, #44252); dropping a proof is idempotent, so a repeat
 * costs nothing. Listeners only queue: the reset itself runs on this scope's fiber.
 */
export const resetProofOn = Effect.fn("DesktopCuaDriver.resetProofOn")(function* (
  source: ProofResetSource,
  reset: (event: ProofResetEvent) => Effect.Effect<void>,
) {
  const events = yield* Queue.unbounded<ProofResetEvent>();
  yield* Effect.forEach(
    PROOF_RESET_EVENTS,
    (event) => source.on(event, () => Queue.offerUnsafe(events, event)),
    { discard: true },
  );
  yield* Effect.forever(
    Queue.take(events).pipe(
      Effect.flatMap((event) =>
        reset(event).pipe(Effect.ensuring(Effect.sync(() => source.handled?.()))),
      ),
    ),
  ).pipe(Effect.forkScoped);
});

/** The capture step's failure text for the helper's own capture, or undefined when it pictured. */
export function captureCheckFailure(outcome: CaptureCheckOutcome, helperName: string) {
  return outcome.kind === "pictured"
    ? undefined
    : `${helperName} could not capture a window the way the live picture does: ${outcome.reason}.`;
}
