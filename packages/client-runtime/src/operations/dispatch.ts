import { ORCHESTRATION_V2_WS_METHODS, type OrchestrationV2Command } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { EnvironmentRpcUnavailableError, isRpcClientError, request } from "../rpc/client.ts";

export const dispatch = (command: OrchestrationV2Command) =>
  request(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, command);

// The socket can close after the server accepted the frame but before it answered.
// The server replays an accepted commandId from its receipt, so the same command
// waits out reconnect backoff until the supervisor stops trying. The resend cap
// stops a frame that kills the socket from looping.
const MAX_LOST_TRANSPORT_RESENDS = 2;

export const dispatchMessage = Effect.fn("EnvironmentCommands.dispatchMessage")(function* (
  resendAfterSocketLoss: boolean,
  command: Extract<OrchestrationV2Command, { type: "message.dispatch" }>,
) {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const attempt = dispatch(command).pipe(
    Effect.timeoutOrElse({
      duration: "60 seconds",
      orElse: () =>
        Effect.fail(
          new EnvironmentRpcUnavailableError({
            environmentId: supervisor.target.environmentId,
            message: `${supervisor.target.label} did not confirm the message within 60 seconds.`,
          }),
        ),
    }),
  );
  if (!resendAfterSocketLoss) return yield* attempt;
  for (let resends = 0; ; resends += 1) {
    const attemptSession = yield* SubscriptionRef.get(supervisor.session);
    const exit = yield* Effect.exit(attempt);
    if (Exit.isSuccess(exit)) return exit.value;
    // Closing the session interrupts the request, which can beat the protocol error.
    const lostTransport =
      Cause.hasInterruptsOnly(exit.cause) ||
      exit.cause.reasons.some((reason) => reason._tag === "Fail" && isRpcClientError(reason.error));
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
});
