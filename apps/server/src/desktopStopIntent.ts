import { DesktopStopIntent } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "./config.ts";

export class DesktopStopIntentReader extends Context.Service<
  DesktopStopIntentReader,
  {
    /** Reads at shutdown and caches a found or terminal result; a missing file can be retried. */
    readonly atShutdown: Effect.Effect<Option.Option<DesktopStopIntent>>;
  }
>()("goat/desktopStopIntent/DesktopStopIntentReader") {}

const decodeIntent = Schema.decodeUnknownOption(Schema.fromJsonString(DesktopStopIntent));

export const layerNone = Layer.succeed(DesktopStopIntentReader, { atShutdown: Effect.succeedNone });

export const layer = (path: string | undefined, pid: number) =>
  path === undefined
    ? layerNone
    : Layer.effect(
        DesktopStopIntentReader,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const semaphore = yield* Semaphore.make(1);
          let cached: Option.Option<Option.Option<DesktopStopIntent>> = Option.none();
          const read = Effect.fn("DesktopStopIntentReader.atShutdown")(() =>
            semaphore.withPermits(1)(
              Effect.gen(function* () {
                if (Option.isSome(cached)) return cached.value;
                const contents = yield* fs.readFileString(path).pipe(
                  Effect.asSome,
                  Effect.catch((error) =>
                    (error.reason._tag === "NotFound"
                      ? Effect.void
                      : Effect.logWarning("Failed to read desktop stop intent", { cause: error })
                    ).pipe(Effect.as(Option.none<string>())),
                  ),
                );
                if (Option.isNone(contents)) return Option.none<DesktopStopIntent>();
                const decoded = decodeIntent(contents.value);
                const result = Option.filter(decoded, (intent) => intent.pid === pid);
                yield* fs.remove(path).pipe(Effect.ignore);
                cached = Option.some(result);
                return result;
              }).pipe(Effect.uninterruptible),
            ),
          );
          return { atShutdown: read() };
        }),
      );

export const layerFromServerConfig = Layer.unwrap(
  Effect.map(ServerConfig.ServerConfig, (config) =>
    layer(config.desktopStopIntentPath, process.pid),
  ),
);
