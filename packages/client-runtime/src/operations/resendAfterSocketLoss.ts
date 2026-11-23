import type { OrchestrationV2Command } from "@goat/contracts";
import { dispatch } from "./dispatch.ts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { isRpcClientError } from "../rpc/client.ts";

const MAX_LOST_TRANSPORT_RESENDS = 2;

export const resendAfterSocketLoss = Effect.fn("EnvironmentCommands.resendAfterSocketLoss")(
  function* <A, E, R>(attempt: Effect.Effect<A, E, R>) {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    for (let resends = 0; ; resends += 1) {
      const attemptSession = yield* SubscriptionRef.get(supervisor.session);
      const exit = yield* Effect.exit(attempt);
      if (Exit.isSuccess(exit)) return exit.value;
      // Closing the session interrupts the request, which can beat the protocol error.
      const lostTransport =
        Cause.hasInterruptsOnly(exit.cause) ||
        exit.cause.reasons.some(
          (reason) => reason._tag === "Fail" && isRpcClientError(reason.error),
        );
      if (!lostTransport || resends >= MAX_LOST_TRANSPORT_RESENDS) return yield* exit;
      const replacement = yield* Effect.raceFirst(
        SubscriptionRef.changes(supervisor.session).pipe(
          Stream.filter(
            (session) =>
              Option.isSome(session) &&
              !(Option.isSome(attemptSession) && session.value === attemptSession.value),
          ),
          Stream.runHead,
        ),
        SubscriptionRef.changes(supervisor.state).pipe(
          Stream.filter((state) => state.phase === "available" || state.phase === "blocked"),
          Stream.runHead,
          Effect.as(Option.none()),
        ),
      );
      if (Option.isNone(replacement)) return yield* exit;
    }
  },
);

export const dispatchResending = (command: OrchestrationV2Command) =>
  resendAfterSocketLoss(dispatch(command));
