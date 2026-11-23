import { Session, type OpenCodeClient } from "@opencode/client/effect";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type * as Semaphore from "effect/Semaphore";
import type { ActiveTurn, ThreadState, TurnTerminal } from "./adapterState.ts";
import * as OpenCode2Client from "./OpenCode2Client.ts";
import { ACTIVE_CHECK_TIMEOUT } from "./connectionConstants.ts";

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
