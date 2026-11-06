import type { SpeechConfiguration } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ServerSettingsService } from "../serverSettings.ts";
import { getSpeechModel, SPEECH_MODELS } from "./model.ts";
import * as SpeechModelStore from "./SpeechModelStore.ts";

export class SpeechManagementError extends Schema.TaggedError<SpeechManagementError>()(
  "SpeechManagementError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}
const isManagementError = Schema.is(SpeechManagementError);

export class SpeechManagement extends Context.Service<
  SpeechManagement,
  {
    readonly list: Effect.Effect<
      ReadonlyArray<{
        id: string;
        name: string;
        description: string;
        size: number;
        installed: boolean;
        selected: boolean;
      }>,
      SpeechManagementError
    >;
    readonly download: (id: string) => Effect.Effect<void, SpeechManagementError>;
    readonly remove: (id: string) => Effect.Effect<void, SpeechManagementError>;
    readonly configure: (config: SpeechConfiguration) => Effect.Effect<void, SpeechManagementError>;
  }
>()("goat/speech/SpeechManagement") {}

const make = Effect.gen(function* () {
  const store = yield* SpeechModelStore.SpeechModelStore;
  const settings = yield* ServerSettingsService;
  const gate = yield* Semaphore.make(1);
  const failure = (operation: string, cause: unknown) =>
    new SpeechManagementError({ operation, cause });
  const definition = (id: string) => {
    const model = getSpeechModel(id);
    return model ? Effect.succeed(model) : Effect.fail(failure("model", "Unknown model."));
  };
  const exclusive = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      gate.withPermitsIfAvailable(1),
      Effect.flatMap((result) =>
        Effect.fromOption(result).pipe(
          Effect.mapError(() => failure(operation, "Speech is busy.")),
        ),
      ),
      Effect.mapError((error) => (isManagementError(error) ? error : failure(operation, error))),
    );
  return SpeechManagement.of({
    list: Effect.gen(function* () {
      const current = yield* settings.getSettings;
      return yield* Effect.forEach(
        SPEECH_MODELS,
        (model) =>
          store.isReady(model).pipe(
            Effect.map((installed) => ({
              id: model.id,
              name: model.name,
              description: model.description,
              size: model.size,
              installed,
              selected: model.id === current.speech.modelId,
            })),
          ),
        { concurrency: 4 },
      );
    }).pipe(Effect.mapError((error) => failure("list", error))),
    download: Effect.fn("SpeechManagement.download")((id) =>
      exclusive(
        "download",
        Effect.gen(function* () {
          const model = yield* definition(id);
          yield* store.download(model).pipe(Effect.timeout("30 minutes"));
        }),
      ),
    ),
    remove: Effect.fn("SpeechManagement.remove")((id) =>
      exclusive(
        "remove",
        Effect.gen(function* () {
          const model = yield* definition(id);
          yield* store.remove(model);
        }),
      ),
    ),
    configure: Effect.fn("SpeechManagement.configure")((config) =>
      exclusive(
        "configure",
        Effect.gen(function* () {
          yield* definition(config.modelId);
          yield* settings.updateSettings({ speech: config });
        }),
      ),
    ),
  });
});

export const layer = Layer.effect(SpeechManagement, make);
