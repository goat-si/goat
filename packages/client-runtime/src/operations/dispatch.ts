import { ORCHESTRATION_V2_WS_METHODS, type OrchestrationV2Command } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import {
  currentSession,
  EnvironmentRpcUnavailableError,
  isRpcClientError,
  request,
  requestInSession,
} from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";

export const dispatch = (command: OrchestrationV2Command) =>
  request(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, command);

// The socket can close after the server accepted the frame but before it answered.
// The server replays an accepted commandId from its receipt, so the same command
// waits out reconnect backoff until the supervisor stops trying. The resend cap
// stops a frame that kills the socket from looping.
const MAX_LOST_TRANSPORT_RESENDS = 2;
// The supervisor clears a dead session as soon as the socket's failure reaches pending
// requests, so a session still current and connected after this grace is a live one whose
// reply was lost (a frame the client could not parse), and the same command goes again on it.
const SAME_SESSION_RESEND_GRACE = Duration.seconds(5);
const MESSAGE_ATTEMPT_WAIT_BOUND_NANOS = Duration.toNanosUnsafe(Duration.seconds(60));
// Past this the person gets the draft back instead of a send that never ends.
const LOST_MESSAGE_WAIT_BOUND_NANOS = Duration.toNanosUnsafe(Duration.minutes(10));

export const dispatchMessage = Effect.fn("EnvironmentCommands.dispatchMessage")(function* (
  resendAfterSocketLoss: boolean,
  command: Extract<OrchestrationV2Command, { type: "message.dispatch" }>,
) {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const unconfirmed = new EnvironmentRpcUnavailableError({
    environmentId: supervisor.target.environmentId,
    message: `${supervisor.target.label} did not confirm the message within 10 minutes. It may not have been sent.`,
  });
  // Pinned: the session the frame went out on is the one a replacement is compared with.
  let attemptSession = Option.none<RpcSession>();
  const send = currentSession().pipe(
    Effect.tap((session) =>
      Effect.sync(() => {
        attemptSession = Option.some(session);
      }),
    ),
    Effect.flatMap((session) =>
      requestInSession(session, ORCHESTRATION_V2_WS_METHODS.dispatchCommand, command),
    ),
  );
  const attempt = send.pipe(
    Effect.timeoutOrElse({
      duration: Duration.nanos(MESSAGE_ATTEMPT_WAIT_BOUND_NANOS),
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
  let deadline: bigint | undefined;
  for (let resends = 0; ; resends += 1) {
    attemptSession = Option.none();
    const remaining =
      deadline === undefined ? undefined : deadline - (yield* Clock.monotonicTimeNanos);
    if (remaining !== undefined && remaining <= 0n) return yield* unconfirmed;
    const exit = yield* Effect.exit(
      remaining !== undefined && remaining <= MESSAGE_ATTEMPT_WAIT_BOUND_NANOS
        ? send.pipe(
            Effect.timeoutOrElse({
              duration: Duration.nanos(remaining),
              orElse: () => Effect.fail(unconfirmed),
            }),
          )
        : attempt,
    );
    if (Exit.isSuccess(exit)) return exit.value;
    // Closing the session interrupts the request, which can beat the protocol error.
    const lostTransport =
      Cause.hasInterruptsOnly(exit.cause) ||
      exit.cause.reasons.some((reason) => reason._tag === "Fail" && isRpcClientError(reason.error));
    if (!lostTransport || resends >= MAX_LOST_TRANSPORT_RESENDS) return yield* exit;
    const now = yield* Clock.monotonicTimeNanos;
    deadline ??= now + LOST_MESSAGE_WAIT_BOUND_NANOS;
    const replacement = yield* Effect.raceAllFirst([
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
      Effect.sleep(SAME_SESSION_RESEND_GRACE).pipe(
        Effect.andThen(
          Effect.all([
            SubscriptionRef.get(supervisor.session),
            SubscriptionRef.get(supervisor.state),
          ]),
        ),
        Effect.flatMap(([session, state]) =>
          Option.isSome(session) &&
          Option.isSome(attemptSession) &&
          session.value === attemptSession.value &&
          state.phase === "connected"
            ? Effect.succeedSome(session)
            : Effect.never,
        ),
      ),
    ]).pipe(Effect.timeoutOption(Duration.nanos(deadline > now ? deadline - now : 0n)));
    if (Option.isNone(replacement)) return yield* unconfirmed;
    if (Option.isNone(replacement.value)) return yield* exit;
  }
});
