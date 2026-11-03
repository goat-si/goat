import type { ServerSettings } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

export type CuaCommittedPolicy =
  | { readonly _tag: "unavailable" }
  | {
      readonly _tag: "committed";
      readonly enableCua: boolean;
      readonly blockedBrowserHosts: ReadonlyArray<string>;
    };

export const makeCuaCommittedPolicy = Effect.gen(function* () {
  const ref = yield* Ref.make<CuaCommittedPolicy>({ _tag: "unavailable" });
  return {
    read: Ref.get(ref),
    unavailable: Ref.set(ref, { _tag: "unavailable" }),
    publish: (settings: ServerSettings, parseFailure: Option.Option<unknown>) =>
      Ref.set(
        ref,
        Option.isSome(parseFailure)
          ? { _tag: "unavailable" }
          : {
              _tag: "committed",
              enableCua: settings.enableCua,
              blockedBrowserHosts: settings.blockedBrowserHosts,
            },
      ),
    loaded: <E, R>(
      load: Effect.Effect<{ settings: ServerSettings; parseFailure: Option.Option<unknown> }, E, R>,
    ) =>
      load.pipe(
        Effect.tap(({ settings, parseFailure }) =>
          Ref.set(
            ref,
            Option.isSome(parseFailure)
              ? { _tag: "unavailable" }
              : {
                  _tag: "committed",
                  enableCua: settings.enableCua,
                  blockedBrowserHosts: settings.blockedBrowserHosts,
                },
          ),
        ),
        Effect.tapError(() => Ref.set(ref, { _tag: "unavailable" })),
      ),
  };
});
