import type { SpeechConfiguration, ValidatedVoiceWav } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { getSpeechModel, SPEECH_MODELS } from "./model.ts";
import * as SpeechModelStore from "./SpeechModelStore.ts";
import * as SpeechInference from "./SpeechInference.ts";
import { postProcessTranscript } from "./postProcessing.ts";

export class SpeechManagementError extends Schema.TaggedError<SpeechManagementError>()(
  "SpeechManagementError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}
const isManagementError = Schema.is(SpeechManagementError);
export const NO_LINKABLE_MODEL = "No voice model file was found at that path.";

export class SpeechManagement extends Context.Service<
  SpeechManagement,
  {
    readonly configuration: Effect.Effect<SpeechConfiguration, SpeechManagementError>;
    readonly configurationRevision: Effect.Effect<number, SpeechManagementError>;
    readonly configurationChanges: Effect.Effect<
      import("effect/Stream").Stream<SpeechConfiguration & { readonly revision: number }>,
      SpeechManagementError,
      Scope.Scope
    >;
    readonly list: Effect.Effect<
      ReadonlyArray<{
        id: string;
        name: string;
        description: string;
        size: number;
        installed: boolean;
        selected: boolean;
        linkedFrom?: string;
        recommended: boolean;
        benchmark: { cpu: number | null; accelerated: number | null };
      }>,
      SpeechManagementError
    >;
    readonly download: (id: string) => Effect.Effect<void, SpeechManagementError>;
    readonly link: (path: string) => Effect.Effect<void, SpeechManagementError>;
    readonly remove: (id: string) => Effect.Effect<void, SpeechManagementError>;
    readonly configure: (config: SpeechConfiguration) => Effect.Effect<void, SpeechManagementError>;
    readonly transcribe: (
      audio: ValidatedVoiceWav,
      language?: string,
    ) => Effect.Effect<string, SpeechManagementError>;
    readonly startStream: (language?: string) => Effect.Effect<
      {
        readonly feed: (pcm: Float32Array) => Effect.Effect<
          {
            readonly revision: number;
            readonly text: { readonly committed: string; readonly tentative: string } | null;
          },
          SpeechInference.SpeechInferenceError
        >;
        readonly finish: Effect.Effect<string, SpeechInference.SpeechInferenceError>;
        readonly configuration: SpeechConfiguration;
      },
      SpeechManagementError,
      Scope.Scope
    >;
  }
>()("goat/speech/SpeechManagement") {}

const make = Effect.gen(function* () {
  const store = yield* SpeechModelStore.SpeechModelStore;
  const settings = yield* ServerSettingsService;
  const inference = yield* SpeechInference.SpeechInference;
  const textGeneration = yield* Effect.serviceOption(TextGeneration);
  const gate = yield* Semaphore.make(1);
  const failure = (operation: string, cause: unknown) =>
    new SpeechManagementError({ operation, cause });
  const finalize = (
    text: string,
    config: import("@goat/contracts").SpeechConfiguration,
    language?: string,
  ) =>
    postProcessTranscript(text, config, language, "", {
      settings,
      textGeneration: Option.getOrNull(textGeneration),
    });
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
    configuration: settings.getSettings.pipe(
      Effect.map((current) => current.speech),
      Effect.mapError((error) => failure("configuration", error)),
    ),
    configurationRevision: Effect.suspend(
      () =>
        settings.speechChangesRevision ??
        Effect.logError("Speech settings change tracking is unavailable.").pipe(
          Effect.andThen(
            Effect.fail(failure("stream", "Speech settings change tracking is unavailable.")),
          ),
        ),
    ),
    configurationChanges: Effect.suspend(
      () =>
        settings.subscribeSpeechChanges ??
        Effect.logError("Speech settings change tracking is unavailable.").pipe(
          Effect.andThen(
            Effect.fail(failure("stream", "Speech settings change tracking is unavailable.")),
          ),
        ),
    ),
    list: Effect.gen(function* () {
      const current = yield* settings.getSettings;
      return yield* Effect.forEach(
        SPEECH_MODELS,
        (model) =>
          Effect.all([store.isReady(model), store.linkedFrom(model)]).pipe(
            Effect.map(([installed, linkedFrom]) => ({
              id: model.id,
              name: model.name,
              description: model.description,
              size: model.size,
              installed,
              selected: model.id === current.speech.modelId,
              // A dangling link still names its origin, so only a ready model shows it.
              ...(installed && linkedFrom !== undefined ? { linkedFrom } : {}),
              recommended: model.recommended,
              benchmark: model.benchmark.secondsPer30s,
              languages: model.languages,
              accuracy: Object.fromEntries(
                Object.entries(model.benchmark.accuracy).map(([language, value]) => [
                  language,
                  value.errorPercent,
                ]),
              ),
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
    link: Effect.fn("SpeechManagement.link")((path) =>
      exclusive(
        "link",
        Effect.gen(function* () {
          const [first] = yield* store.link(SPEECH_MODELS, path);
          if (first === undefined) return yield* failure("link", NO_LINKABLE_MODEL);
          const current = yield* settings.getSettings;
          const selected = getSpeechModel(current.speech.modelId);
          if (selected === undefined || !(yield* store.isReady(selected)))
            yield* settings.updateSettings({ speech: { ...current.speech, modelId: first } });
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
    transcribe: Effect.fn("SpeechManagement.transcribe")((audio, language) =>
      exclusive(
        "transcribe",
        Effect.gen(function* () {
          const config = (yield* settings.getSettings).speech;
          const model = yield* definition(config.modelId);
          const path = yield* store.installedPath(model);
          if (path === undefined)
            return yield* failure("transcribe", "The selected speech model is not installed.");
          const transcript = yield* inference.transcribe(
            path,
            audio.bytes.subarray(audio.dataOffset, audio.dataOffset + audio.dataBytes),
            config,
            language,
          );
          return yield* finalize(transcript, config, language).pipe(
            Effect.mapError((error) => failure("post-processing", error)),
          );
        }),
      ),
    ),
    startStream: Effect.fn("SpeechManagement.startStream")((language) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          const stream = yield* Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Semaphore.takeIfAvailable(gate, 1).pipe(
                Effect.flatMap((acquired) =>
                  acquired ? Effect.void : Effect.fail(failure("stream", "Speech is busy.")),
                ),
              ),
              () => Semaphore.release(gate, 1),
            );
            const config = (yield* settings.getSettings.pipe(
              Effect.mapError((error) => failure("stream", error)),
            )).speech;
            const model = yield* definition(config.modelId);
            const path = yield* store
              .installedPath(model)
              .pipe(Effect.mapError((error) => failure("stream", error)));
            if (path === undefined)
              return yield* failure("stream", "The selected speech model is not installed.");
            const worker = yield* inference
              .openStream(path, config, language)
              .pipe(Effect.mapError((error) => failure("stream", error)));
            return {
              ...worker,
              configuration: config,
              finish: worker.finish.pipe(
                Effect.flatMap((text) =>
                  finalize(text, config, language).pipe(
                    Effect.mapError(
                      (error) => new SpeechInference.SpeechInferenceError({ cause: error }),
                    ),
                  ),
                ),
                Effect.scoped,
              ),
            };
          }).pipe(
            Scope.provide(scope),
            Effect.onError(() => Scope.close(scope, Exit.void)),
          );
          return { scope, stream };
        }),
        ({ scope }) => Scope.close(scope, Exit.void),
        { interruptible: true },
      ).pipe(Effect.map(({ stream }) => stream)),
    ),
  });
});

export const layer = Layer.effect(SpeechManagement, make);
