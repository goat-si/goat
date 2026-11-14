import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { ClaudeAgentSdkQueryRunnerError } from "./ClaudeAdapterV2.ts";

export const interruptUnlessClosed = Effect.fn("ClaudeAdapter.interruptUnlessClosed")(
  function* (input: {
    readonly closed: Deferred.Deferred<void>;
    readonly interrupt: Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
    readonly close: Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
  }) {
    if (yield* Deferred.isDone(input.closed)) return;
    yield* input.interrupt.pipe(
      Effect.timeoutOption("10 seconds"),
      Effect.catch((error) =>
        Deferred.isDone(input.closed).pipe(
          Effect.flatMap((closed) => (closed ? Effect.void : Effect.fail(error))),
        ),
      ),
    );
    yield* input.close.pipe(Effect.ignore);
  },
);
