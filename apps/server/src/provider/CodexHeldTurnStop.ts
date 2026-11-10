/**
 * Stops, at a person's request, the Codex turns no run owns that hold a thread's next start.
 * The hold opens only once Codex confirms a turn ended, as it would when the turn ends itself.
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
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";

import * as Detached from "./CodexDetachedAppServerLive.ts";
import { CodexDetachedAppServerError } from "./CodexDetachedAppServer.ts";
import { buildCodexInitializeParams } from "./CodexProvider.ts";
import {
  CodexSurvivors,
  type CodexInstanceRecordKey,
  type CodexStopObligation,
} from "./CodexSurvivors.ts";

type Outcome = OrchestrationV2StopHeldTurnResult["outcome"];

/** Stops each held turn and clears its fence once the turn is confirmed ended. */
export const stopHeldTurns = Effect.fn("CodexHeldTurnStop.stopHeldTurns")(function* <E>(input: {
  readonly survivors: Pick<CodexSurvivors["Service"], "getStopObligations" | "clearStopObligation">;
  readonly threadId: ThreadId;
  /** True once Codex reports the turn ended. */
  readonly stop: (
    record: CodexInstanceRecordKey,
    turn: CodexStopObligation,
  ) => Effect.Effect<boolean, E>;
}) {
  const held = yield* input.survivors.getStopObligations(input.threadId);
  if (held.length === 0) return "none" satisfies Outcome;
  let pending = 0;
  for (const { record, block } of held) {
    if (yield* input.stop(record, block)) yield* input.survivors.clearStopObligation(record, block);
    else pending += 1;
  }
  return pending === 0 ? ("stopped" satisfies Outcome) : ("stopping" satisfies Outcome);
});

/**
 * Pauses the turn's goal so Codex starts no continuation, interrupts the turn, and waits briefly
 * for Codex to report its end.
 */
export const interruptHeldTurn = Effect.fn("CodexHeldTurnStop.interruptHeldTurn")(
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
    const ended = yield* Deferred.make<void>();
    yield* client.handleServerNotification("turn/completed", (event) =>
      event.threadId === turn.nativeThreadId &&
      event.turn.id === turn.nativeTurnId &&
      event.turn.status !== "inProgress"
        ? Deferred.succeed(ended, undefined).pipe(Effect.asVoid)
        : Effect.void,
    );
    yield* client.request("thread/resume", { threadId: turn.nativeThreadId, excludeTurns: true });
    yield* client
      .request("thread/goal/set", { threadId: turn.nativeThreadId, status: "paused" })
      .pipe(Effect.ignore);
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
  },
  (effect) =>
    effect.pipe(
      Effect.scoped,
      Effect.mapError(
        (cause) =>
          new CodexDetachedAppServerError({ detail: "Could not stop the Codex turn.", cause }),
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
        : stopHeldTurns({
            survivors: survivors.value,
            threadId: input.threadId,
            stop: (record, turn) => interruptHeldTurn(detached.value, record, turn),
          })
      ).pipe(
        Effect.map((outcome) => ({ outcome })),
        Effect.mapError(
          (cause) => new OrchestrationV2StopHeldTurnError({ threadId: input.threadId, cause }),
        ),
      ),
  };
});
