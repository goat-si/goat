import { OrchestratorMcpFailure } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

const HOST_FAN_OUT_DEADLINE_MS = 15_000;

/** Bound discovery without interrupting an SSH runtime launch or replacement. */
export const withHostFanOutDeadline = (host: string) =>
  Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
    // Launch can change the remote before the tunnel manager records its entry.
    // Let it finish after the caller leaves; capture late failures as values.
    const fiber = yield* effect.pipe(Effect.result, Effect.forkDetach);
    const result = yield* Fiber.join(fiber).pipe(
      Effect.timeoutOrElse({
        duration: HOST_FAN_OUT_DEADLINE_MS,
        orElse: () =>
          Effect.fail(
            new OrchestratorMcpFailure({
              code: "host_unavailable",
              message: `${host} exceeded the ${HOST_FAN_OUT_DEADLINE_MS / 1000}s fan-out deadline. Query it directly with host:${host}, which waits longer.`,
            }),
          ),
      }),
    );
    return yield* Effect.fromResult(result);
  });
