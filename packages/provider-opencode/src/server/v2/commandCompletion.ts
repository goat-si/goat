import { Session, type OpenCodeClient } from "@opencode/client/effect";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as Semaphore from "effect/Semaphore";
import type { ActiveTurn, ThreadState, TurnTerminal } from "./adapterState.ts";
import * as OpenCode2Client from "./OpenCode2Client.ts";
import { ACTIVE_CHECK_TIMEOUT } from "./connectionConstants.ts";

export const runOpenCode2Command = Effect.fn("OpenCode2Adapter.runOpenCode2Command")(function* <
  E,
  R,
>(input: {
  sessionId: string;
  commandStarts: Map<string, Deferred.Deferred<void>>;
  sessionScope: Scope.Scope;
  run: Effect.Effect<unknown, E, R>;
  onSubmitted?: Effect.Effect<void> | undefined;
}) {
  // The reply waits for the whole execution, which may wait on a question this turn must answer.
  const commandStart = yield* Deferred.make<void>();
  input.commandStarts.set(input.sessionId, commandStart);
  const reply = yield* input.run.pipe(
    Effect.tapCause((cause) =>
      Deferred.isDoneUnsafe(commandStart)
        ? Effect.logWarning("OpenCode command failed after it started.", cause)
        : Effect.void,
    ),
    Effect.exit,
    Effect.ensuring(
      Effect.sync(() => {
        if (input.commandStarts.get(input.sessionId) === commandStart) {
          input.commandStarts.delete(input.sessionId);
        }
      }),
    ),
    Effect.forkIn(input.sessionScope),
  );
  const replied = yield* Effect.raceFirst(
    Fiber.join(reply).pipe(Effect.asSome),
    Deferred.await(commandStart).pipe(Effect.as(Option.none())),
  );
  // Once started, the execution's events own the turn.
  if (Option.isNone(replied)) {
    if (input.onSubmitted !== undefined) yield* input.onSubmitted;
    return true;
  }
  yield* replied.value;
  if (input.onSubmitted !== undefined) yield* input.onSubmitted;
  return false;
});

export const finishIdleCommand = Effect.fn("OpenCode2Adapter.finishIdleCommand")(function* (input: {
  client: OpenCodeClient;
  sessionId: string;
  before: string | null;
  state: ThreadState;
  turn: ActiveTurn;
  busy: ReadonlySet<string>;
  lock: Semaphore.Semaphore;
  end: (state: ThreadState, turn: ActiveTurn, terminal: TurnTerminal) => Effect.Effect<void>;
}) {
  const idle = () => input.state.active === input.turn && !input.busy.has(input.sessionId);
  if (!idle()) return;
  const active = yield* input.client.session
    .active()
    .pipe(Effect.timeout(ACTIVE_CHECK_TIMEOUT), Effect.option);
  if (active._tag === "None")
    return yield* Effect.logWarning("Could not check whether an OpenCode command started.");
  if (input.sessionId in active.value) return;
  const ran = yield* OpenCode2Client.paginate(
    { sessionID: Session.ID.make(input.sessionId), order: "desc" as const, limit: 1 },
    input.client.message.list,
  ).pipe(
    Stream.takeWhile((message) => message.id !== input.before),
    Stream.filter(
      (message) =>
        message.type === "user" || message.type === "assistant" || message.type === "idle",
    ),
    Stream.runHead,
    Effect.timeout(ACTIVE_CHECK_TIMEOUT),
    Effect.option,
  );
  if (ran._tag === "None")
    return yield* Effect.logWarning("Could not check whether an OpenCode command ran.");
  if (ran.value._tag === "None")
    yield* input.lock.withPermit(
      Effect.suspend(() =>
        idle()
          ? input.end(input.state, input.turn, {
              status: input.turn.interrupted ? "interrupted" : "completed",
            })
          : Effect.void,
      ),
    );
});
