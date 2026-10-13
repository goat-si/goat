import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class ServerDrainingError extends Schema.TaggedError<ServerDrainingError>()(
  "ServerDrainingError",
  {},
) {
  override get message(): string {
    return "The server is restarting for an update. Retry after it reconnects.";
  }
}

export class RuntimeAdmission extends Context.Service<
  RuntimeAdmission,
  {
    readonly beginDrain: Effect.Effect<void>;
    readonly resume: Effect.Effect<void>;
    readonly inFlight: Effect.Effect<number>;
    readonly admit: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
      options?: { readonly continuation: boolean },
    ) => Effect.Effect<A, E | ServerDrainingError, R>;
  }
>()("goat/runtimeAdmission") {}

const make = Effect.sync(() => {
  let draining = false;
  let inFlight = 0;
  return RuntimeAdmission.of({
    beginDrain: Effect.sync(() => {
      draining = true;
    }),
    resume: Effect.sync(() => {
      draining = false;
    }),
    inFlight: Effect.sync(() => inFlight),
    admit: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
      options?: { readonly continuation: boolean },
    ) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend<A, E | ServerDrainingError, R>(() => {
          if (draining && options?.continuation !== true)
            return Effect.fail(new ServerDrainingError({}));
          inFlight++;
          return restore(effect).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                inFlight--;
              }),
            ),
          );
        }),
      ),
  });
});

export const layer = Layer.effect(RuntimeAdmission, make);
