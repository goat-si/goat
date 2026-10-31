import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { Union } from "./BrowserOriginGrants.ts";

export class BrowserClaimManifestUnavailable extends Schema.TaggedError<BrowserClaimManifestUnavailable>()(
  "BrowserClaimManifestUnavailable",
  { cause: Schema.Defect() },
) {}

export class BrowserClaimManifest extends Context.Service<
  BrowserClaimManifest,
  {
    readonly publish: (union: Union) => Effect.Effect<string, Error>;
    readonly readConfig: Effect.Effect<unknown, Error>;
    /** Restarts the driver when it would not confirm a narrower manifest; false without one. */
    readonly fence?: Effect.Effect<boolean>;
    readonly install: (
      publish: (union: Union) => Effect.Effect<string, Error>,
      readConfig: Effect.Effect<unknown, Error>,
      fence?: Effect.Effect<void>,
    ) => Effect.Effect<void>;
  }
>()("goat/preview/BrowserClaimManifest") {}

export const layer = Layer.effect(
  BrowserClaimManifest,
  Effect.sync(() => {
    let writer: ((union: Union) => Effect.Effect<string, Error>) | undefined;
    let reader: Effect.Effect<unknown, Error> | undefined;
    let fencer: Effect.Effect<void> | undefined;
    return {
      publish: Effect.fn("BrowserClaimManifest.publish")((union: Union) =>
        Effect.suspend(() =>
          writer
            ? writer(union)
            : Effect.fail(
                new BrowserClaimManifestUnavailable({ cause: "Driver manifest is unavailable." }),
              ),
        ),
      ),
      readConfig: Effect.suspend(
        () =>
          reader ??
          Effect.fail(
            new BrowserClaimManifestUnavailable({ cause: "Driver configuration is unavailable." }),
          ),
      ),
      fence: Effect.suspend(() => (fencer ? fencer.pipe(Effect.as(true)) : Effect.succeed(false))),
      install: (publish, readConfig, fence) =>
        Effect.sync(() => {
          writer = publish;
          reader = readConfig;
          fencer = fence;
        }),
    };
  }),
);
