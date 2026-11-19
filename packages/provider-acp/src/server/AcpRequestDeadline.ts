import { makeFiniteRequestGuard } from "@goat/provider-core/server/finiteProviderRequest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as EffectAcpErrors from "effect-acp/errors";
import type { AcpSessionRequestLogEvent } from "./AcpSessionRuntime.ts";

export const makeAcpRequestRunner = Effect.fn("AcpRequestDeadline.make")(function* (options: {
  readonly scope: Scope.Closeable;
  readonly onStderr: boolean;
  readonly stderrFailure: Deferred.Deferred<never, EffectAcpErrors.AcpError>;
  readonly terminated: (error: EffectAcpErrors.AcpError) => Effect.Effect<void>;
  readonly enrich: (error: EffectAcpErrors.AcpError) => Effect.Effect<EffectAcpErrors.AcpError>;
  readonly log: (event: AcpSessionRequestLogEvent) => Effect.Effect<void>;
}) {
  const requestGuard = yield* makeFiniteRequestGuard({
    duration: (method) => {
      switch (method) {
        case "initialize":
          return "60 seconds";
        case "session/new":
        case "session/resume":
        case "session/fork":
          return "90 seconds";
        case "session/set_config_option":
        case "session/set_mode":
        case "session/set_model":
        case "session/list":
        case "session/close":
          return "30 seconds";
        default:
          return undefined;
      }
    },
    error: (method) =>
      new EffectAcpErrors.AcpTransportError({
        detail: "The ACP provider did not answer a finite request before its deadline.",
        cause: { category: "request-deadline", method },
      }),
  });
  yield* requestGuard.terminated.pipe(
    Effect.tap(options.terminated),
    Effect.ensuring(Scope.close(options.scope, Exit.void).pipe(Effect.forkDetach, Effect.asVoid)),
    Effect.forkIn(options.scope),
  );
  return Effect.fn("AcpSessionRuntime.runLoggedRequest")(function <A>(
    method: string,
    payload: unknown,
    effect: Effect.Effect<A, EffectAcpErrors.AcpError>,
  ) {
    return options.log({ method, payload, status: "started" }).pipe(
      Effect.flatMap(() =>
        requestGuard
          .request(
            method,
            options.onStderr
              ? Effect.raceFirst(effect, Deferred.await(options.stderrFailure))
              : effect,
          )
          .pipe(
            Effect.catch((error) => options.enrich(error).pipe(Effect.flatMap(Effect.fail))),
            Effect.tap((result) => options.log({ method, payload, status: "succeeded", result })),
            Effect.onError((cause) => options.log({ method, payload, status: "failed", cause })),
          ),
      ),
    );
  });
});
