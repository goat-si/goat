/**
 * Stops, at a person's request, the Codex turn no run owns that holds a thread's next start.
 * The hold opens only once Codex confirms the turn ended, as it would when the turn ends itself.
 *
 * @module CodexHeldTurnStop
 */
import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2StopHeldTurnResult,
  ThreadId,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";

import type * as Detached from "./CodexDetachedAppServerLive.ts";
import { CodexDetachedAppServerError } from "./CodexDetachedAppServer.ts";
import { buildCodexInitializeParams } from "./CodexProvider.ts";
import {
  readGoalReleaseStatus,
  type CodexSurvivors,
  type CodexInstanceRecordKey,
  type CodexStopObligation,
} from "./CodexSurvivors.ts";

type Outcome = OrchestrationV2StopHeldTurnResult["outcome"];
const isDetachedError = Schema.is(CodexDetachedAppServerError);

/**
 * Whether a run of the thread recorded this Codex turn. Recovery fences a run's own turn without a
 * survivor binding when it cannot match the turn to one process, so a missing binding is not enough.
 */
export const nativeTurnOwnedByRun = (
  turns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "nativeTurnRef">>,
  nativeTurnId: string,
) => turns.some((turn) => turn.nativeTurnRef?.nativeId === nativeTurnId);

/**
 * Stops the named turn when it still holds the thread as a turn no run owns. Its stop fence and
 * the goal block of its native thread (the goal is paused by then) go in one write, so no polling
 * worker sees the thread free while admission would still refuse it; a wake follows.
 */
export const stopHeldTurn = Effect.fn("CodexHeldTurnStop.stopHeldTurn")(function* <E, F>(input: {
  readonly survivors: Pick<
    CodexSurvivors["Service"],
    "list" | "getStopObligations" | "getGoalBlocks" | "clearStopObligation"
  >;
  /** True when a run owns the turn; such a turn stops with its run, never from here. */
  readonly ownedByRun: (nativeTurnId: string) => Effect.Effect<boolean, F>;
  /** Clears the stop fence and its native thread's goal block in one write, without a wake. */
  readonly release: (
    record: CodexInstanceRecordKey,
    turn: CodexStopObligation,
  ) => Effect.Effect<void, CodexDetachedAppServerError>;
  readonly threadId: ThreadId;
  readonly nativeTurnId: string;
  /** True once Codex reports the turn ended; fails without stopping it when its goal stays active. */
  readonly stop: (
    record: CodexInstanceRecordKey,
    turn: CodexStopObligation,
  ) => Effect.Effect<boolean, E>;
}) {
  const survivorTurn = (yield* input.survivors.list).some(
    (binding) => binding.threadId === input.threadId && binding.nativeTurnId === input.nativeTurnId,
  );
  const held = (yield* input.survivors.getStopObligations(input.threadId)).find(
    ({ block }) => block.nativeTurnId === input.nativeTurnId,
  );
  // A turn that survived a restart, or any other run's turn, stops with its run.
  if (held === undefined || survivorTurn || (yield* input.ownedByRun(input.nativeTurnId)))
    return "none" satisfies Outcome;
  // Admission would still refuse the message for that goal, so this stop could not release it.
  if (
    (yield* input.survivors.getGoalBlocks(input.threadId)).some(
      ({ block }) => block.nativeThreadId !== held.block.nativeThreadId,
    )
  )
    return yield* new CodexDetachedAppServerError({
      detail:
        "Another Codex goal on this thread also holds it, so stopping this turn would not let the message start.",
    });
  if (!(yield* input.stop(held.record, held.block))) return "stopping" satisfies Outcome;
  yield* input.release(held.record, held.block);
  yield* input.survivors.clearStopObligation(held.record, held.block);
  return "stopped" satisfies Outcome;
});

/**
 * Pauses the thread's goal so Codex starts no continuation, interrupts the turn, and waits briefly
 * for Codex to report its end. A goal Codex will not pause leaves the turn running.
 */
export const stopTurnOnClient = Effect.fn("CodexHeldTurnStop.stopTurnOnClient")(function* (
  client: CodexClient.CodexAppServerClient["Service"],
  turn: CodexStopObligation,
) {
  const ended = yield* Deferred.make<void>();
  yield* client.handleServerNotification("turn/completed", (event) =>
    event.threadId === turn.nativeThreadId &&
    event.turn.id === turn.nativeTurnId &&
    event.turn.status !== "inProgress"
      ? Deferred.succeed(ended, undefined).pipe(Effect.asVoid)
      : Effect.void,
  );
  yield* client.request("thread/resume", { threadId: turn.nativeThreadId, excludeTurns: true });
  const goal = readGoalReleaseStatus(
    client.request("thread/goal/get", { threadId: turn.nativeThreadId }),
  );
  if ((yield* goal) === "goal") {
    yield* client
      .request("thread/goal/set", { threadId: turn.nativeThreadId, status: "paused" })
      .pipe(Effect.ignore);
    if ((yield* goal) === "goal")
      return yield* new CodexDetachedAppServerError({
        detail: "Codex would not pause this thread's goal, so GOAT left the turn running.",
      });
  }
  yield* client.request("turn/interrupt", {
    threadId: turn.nativeThreadId,
    turnId: turn.nativeTurnId,
  });
  const confirmed = yield* Effect.gen(function* () {
    const page = yield* client.request("thread/turns/list", {
      threadId: turn.nativeThreadId,
      limit: 100,
    });
    const listed = page.data.find((entry) => entry.id === turn.nativeTurnId);
    if (listed === undefined || listed.status === "inProgress") yield* Deferred.await(ended);
    return true;
  }).pipe(Effect.timeoutOption("5 seconds"));
  return Option.getOrElse(confirmed, () => false);
});

export const stopTurnOnRecord = Effect.fn("CodexHeldTurnStop.stopTurnOnRecord")(
  function* (
    detached: Detached.CodexDetachedAppServers["Service"],
    record: CodexInstanceRecordKey,
    turn: CodexStopObligation,
  ) {
    const existing = yield* detached.connectExisting(record.instanceId, record.recordName);
    const context = yield* Layer.build(CodexClient.layerMessageChannel(existing.channel));
    const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
      Effect.provide(context),
    );
    yield* client.setRequestGuard(() =>
      Effect.fail(
        CodexErrors.CodexAppServerRequestError.invalidRequest(
          "GOAT is stopping a Codex turn on this thread.",
        ),
      ),
    );
    yield* client.request("initialize", buildCodexInitializeParams());
    yield* client.notify("initialized", undefined);
    return yield* stopTurnOnClient(client, turn);
  },
  (effect) =>
    effect.pipe(
      Effect.scoped,
      // Each request to a live but unresponsive app-server could wait forever.
      Effect.timeoutOption("30 seconds"),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new CodexDetachedAppServerError({
                detail: "Codex did not answer within 30 seconds; the turn may still be running.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
      Effect.mapError((cause) =>
        isDetachedError(cause)
          ? cause
          : new CodexDetachedAppServerError({ detail: "Codex did not take the stop.", cause }),
      ),
    ),
);
