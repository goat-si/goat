/**
 * Stops, at a person's request, the Codex turn no run owns that holds a thread's next start.
 * The hold opens only once Codex confirms the turn ended, as it would when the turn ends itself.
 *
 * @module CodexHeldTurnStop
 */
import {
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2StopHeldTurnError,
  type OrchestrationV2StopHeldTurnInput,
  type OrchestrationV2StopHeldTurnResult,
  type ThreadId,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";

import * as Detached from "./CodexDetachedAppServerLive.ts";
import { CodexDetachedAppServerError } from "./CodexDetachedAppServer.ts";
import { buildCodexInitializeParams } from "./CodexProvider.ts";
import {
  CodexSurvivors,
  readGoalReleaseStatus,
  type CodexInstanceRecordKey,
  type CodexStopObligation,
} from "./CodexSurvivors.ts";

type Outcome = OrchestrationV2StopHeldTurnResult["outcome"];
const isDetachedError = Schema.is(CodexDetachedAppServerError);

/**
 * Stops the named turn when it still holds the thread as a turn no run owns. Its stop fence and
 * the goal block of its native thread (the goal is paused by then) go in one write, so no polling
 * worker sees the thread free while admission would still refuse it; a wake follows.
 */
export const stopHeldTurn = Effect.fn("CodexHeldTurnStop.stopHeldTurn")(function* <E>(input: {
  readonly survivors: Pick<
    CodexSurvivors["Service"],
    "list" | "getStopObligations" | "clearStopObligation"
  >;
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
  // A turn that survived a restart belongs to a run and stops with it.
  if (held === undefined || survivorTurn) return "none" satisfies Outcome;
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

const stopTurnOnRecord = Effect.fn("CodexHeldTurnStop.stopTurnOnRecord")(
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
      Effect.mapError((cause) =>
        isDetachedError(cause)
          ? cause
          : new CodexDetachedAppServerError({ detail: "Codex did not take the stop.", cause }),
      ),
    ),
);

export const heldTurnRpcHandlers = Effect.gen(function* () {
  // Without Codex process tracking, no Codex turn can hold a start.
  const survivors = yield* Effect.serviceOption(CodexSurvivors);
  const detached = yield* Effect.serviceOption(Detached.CodexDetachedAppServers);
  return {
    [ORCHESTRATION_V2_WS_METHODS.stopHeldTurn]: (input: OrchestrationV2StopHeldTurnInput) =>
      (Option.isNone(survivors) || Option.isNone(detached)
        ? Effect.succeed<Outcome>("none")
        : stopHeldTurn({
            survivors: survivors.value,
            release: (record, turn) =>
              detached.value.clearStopObligation(record, turn, true).pipe(Effect.asVoid),
            threadId: input.threadId,
            nativeTurnId: input.nativeTurnId,
            stop: (record, turn) => stopTurnOnRecord(detached.value, record, turn),
          })
      ).pipe(
        Effect.map((outcome) => ({ outcome })),
        Effect.mapError(
          (cause) =>
            new OrchestrationV2StopHeldTurnError({
              threadId: input.threadId,
              detail: cause.detail,
              cause,
            }),
        ),
      ),
  };
});
