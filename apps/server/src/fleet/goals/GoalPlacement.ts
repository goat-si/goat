import {
  OrchestratorMcpFailure,
  RunId,
  ThreadId,
  type CommandId,
  type RuntimeMode,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type {
  PlacedOutcome,
  PlacementPlacer,
  RecoveredOutcome,
} from "../admission/PlacementPlacer.ts";
import { PlacementAttemptsError } from "../admission/PlacementAttempts.ts";
import { RemoteLaunchUnconfirmed } from "./GoalRemoteWorkers.ts";

const isAttemptsError = Schema.is(PlacementAttemptsError);

/**
 * Goal worker launches under placement admission. Each goal action is one placement owner, so a
 * retry of the action resends its key and a new attempt only follows the target's "not started"
 * or a person's choice (design §11).
 */
export const goalPlacementOwner = (goalId: string, actionId: string) =>
  "goal:" + goalId + ":" + actionId;

type Placer = PlacementPlacer["Service"];
type RemoteLaunch = Parameters<Placer["placeRemote"]>[0]["launch"];

interface Launched {
  readonly host: string | null;
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
}

const launchedOf = (
  host: string | null,
  outcome: Extract<PlacedOutcome, { _tag: "Started" }>,
): Launched => ({
  host,
  threadId: ThreadId.make(outcome.threadId),
  runId: outcome.runId === null ? null : RunId.make(outcome.runId),
});

/** A definite refusal: the target's fenced row says nothing started, so the slot moves on. */
const notStarted = (where: string, message: string) =>
  new OrchestratorMcpFailure({
    code: "capacity_exceeded",
    message: where + " did not start the worker: " + message,
    mayHaveStarted: false,
  });

const unknownHere = (cause: unknown) =>
  new OrchestratorMcpFailure({
    code: "host_unavailable",
    message:
      "The placement's outcome is not known yet: " +
      (typeof cause === "object" && cause !== null && "message" in cause
        ? String(cause.message)
        : String(cause)),
    mayHaveStarted: true,
  });

export const placeRemoteWorker = <E, R>(
  placer: Placer,
  input: {
    readonly ownerKey: string;
    readonly host: string;
    readonly launch: RemoteLaunch;
    readonly authorize: Effect.Effect<RuntimeMode, E, R>;
  },
) =>
  placer.placeRemote(input).pipe(
    // A history that cannot be read proves nothing either way.
    Effect.mapError((error) =>
      isAttemptsError(error)
        ? new RemoteLaunchUnconfirmed({ host: input.host, message: error.message })
        : error,
    ),
    Effect.flatMap(
      (outcome): Effect.Effect<Launched, OrchestratorMcpFailure | RemoteLaunchUnconfirmed> =>
        outcome._tag === "Started"
          ? Effect.succeed(launchedOf(input.host, outcome))
          : outcome._tag === "NotStarted"
            ? Effect.fail(notStarted(input.host, outcome.message))
            : Effect.fail(
                new RemoteLaunchUnconfirmed({ host: input.host, message: outcome.message }),
              ),
    ),
  );

export const placeLocalWorker = <P, E>(
  placer: Placer,
  input: {
    readonly ownerKey: string;
    readonly payload: P;
    readonly launch: (commandId: CommandId, payload: P) => Effect.Effect<unknown, E>;
  },
) =>
  placer.placeLocal(input).pipe(
    Effect.mapError(unknownHere),
    Effect.flatMap((outcome): Effect.Effect<Launched, OrchestratorMcpFailure> =>
      outcome._tag === "Started"
        ? Effect.succeed(launchedOf(null, outcome))
        : outcome._tag === "NotStarted"
          ? Effect.fail(notStarted("This machine", outcome.message))
          : Effect.fail(unknownHere(outcome.message)),
    ),
  );

/**
 * What an unclear launch turned out to be, from its own key only: no title or thread-id lookup,
 * since a fenced launch can leave an idle thread with the worker's title and id.
 */
export const recoverPlacedWorker = <P, E, R, E2>(
  placer: Placer,
  input: {
    readonly ownerKey: string;
    readonly authorize: Effect.Effect<RuntimeMode, E, R>;
    readonly local: (commandId: CommandId, payload: P) => Effect.Effect<unknown, E2>;
  },
) =>
  placer.recover<P, E, R, E2>(input).pipe(
    Effect.mapError(unknownHere),
    Effect.flatMap(
      (outcome: RecoveredOutcome): Effect.Effect<Launched | null, OrchestratorMcpFailure> =>
        outcome._tag === "Started"
          ? Effect.succeed(
              launchedOf(
                outcome.attempt.targetHost === "local" ? null : outcome.attempt.targetHost,
                outcome,
              ),
            )
          : outcome._tag === "Unknown"
            ? Effect.fail(unknownHere(outcome.message))
            : Effect.succeed(null),
    ),
  );
