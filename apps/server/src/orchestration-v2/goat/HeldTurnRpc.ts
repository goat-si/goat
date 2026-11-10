/**
 * The person-facing stop of a Codex turn no run owns that holds a thread's next start.
 *
 * @module HeldTurnRpc
 */
import {
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2StopHeldTurnError,
  type OrchestrationV2StopHeldTurnInput,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { CodexDetachedAppServerError } from "../../provider/CodexDetachedAppServer.ts";
import * as Detached from "../../provider/CodexDetachedAppServerLive.ts";
import {
  nativeTurnOwnedByRun,
  stopHeldTurn,
  stopTurnOnRecord,
} from "../../provider/CodexHeldTurnStop.ts";
import { CodexSurvivors } from "../../provider/CodexSurvivors.ts";
import * as Orchestrator from "../Orchestrator.ts";

const isDetachedError = Schema.is(CodexDetachedAppServerError);

export const heldTurnRpcHandlers = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  // Without Codex process tracking, no Codex turn can hold a start.
  const survivors = yield* Effect.serviceOption(CodexSurvivors);
  const detached = yield* Effect.serviceOption(Detached.CodexDetachedAppServers);
  return {
    [ORCHESTRATION_V2_WS_METHODS.stopHeldTurn]: (input: OrchestrationV2StopHeldTurnInput) =>
      (Option.isNone(survivors) || Option.isNone(detached)
        ? Effect.succeed("none" as const)
        : stopHeldTurn({
            survivors: survivors.value,
            ownedByRun: (nativeTurnId) =>
              orchestrator
                .getThreadRecords(input.threadId, ["providerTurns"])
                .pipe(
                  Effect.map(({ providerTurns }) =>
                    nativeTurnOwnedByRun(providerTurns, nativeTurnId),
                  ),
                ),
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
              ...(isDetachedError(cause) ? { detail: cause.detail } : {}),
              cause,
            }),
        ),
      ),
  };
});
