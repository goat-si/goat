import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  encodeMonoPcm16Wav,
  validateCanonicalVoiceWav,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { ServerSettingsService } from "../serverSettings.ts";
import { getSpeechModel } from "./model.ts";
import * as SpeechManagement from "./SpeechManagement.ts";
import * as SpeechModelStore from "./SpeechModelStore.ts";
import * as SpeechInference from "./SpeechInference.ts";

const modelId = "handy-computer/whisper-tiny-gguf";

it.effect("lists, downloads, configures and removes catalog models", () =>
  Effect.gen(function* () {
    const installed = new Set<string>();
    let settings = DEFAULT_SERVER_SETTINGS;
    const store = Layer.mock(SpeechModelStore.SpeechModelStore)({
      isReady: (model) => Effect.succeed(installed.has(model.id)),
      installedPath: (model) =>
        Effect.succeed(installed.has(model.id) ? model.filename : undefined),
      download: (model) =>
        Effect.sync(() => {
          installed.add(model.id);
          return model.filename;
        }),
      remove: (model) =>
        Effect.sync(() => {
          installed.delete(model.id);
        }),
    });
    const settingsLayer = Layer.mock(ServerSettingsService)({
      getSettings: Effect.sync(() => settings),
      updateSettings: (patch) =>
        Effect.sync(() => {
          if (patch.speech) settings = { ...settings, speech: patch.speech };
          return settings;
        }),
    });
    const service = yield* SpeechManagement.SpeechManagement.pipe(
      Effect.provide(
        SpeechManagement.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              store,
              settingsLayer,
              Layer.succeed(SpeechInference.SpeechInference, {
                transcribe: (_path, _pcm, _config, language) => Effect.succeed(language ?? "none"),
              }),
            ),
          ),
        ),
      ),
    );
    expect(getSpeechModel(modelId)).toBeDefined();
    yield* service.download(modelId);
    yield* service.configure({ modelId, acceleration: "cpu" });
    expect((yield* service.list).find((entry) => entry.id === modelId)).toMatchObject({
      installed: true,
      selected: true,
    });
    const encoded = encodeMonoPcm16Wav([new Float32Array(24_000)], 24_000);
    if (!encoded) throw new Error("invalid fixture");
    const audio = validateCanonicalVoiceWav(encoded.bytes);
    if (!audio.ok) throw new Error("invalid fixture");
    expect(yield* service.transcribe(audio.value, "en")).toBe("en");
    yield* service.remove(modelId);
    expect((yield* service.list).find((entry) => entry.id === modelId)).toMatchObject({
      installed: false,
      selected: true,
    });
    expect(yield* Effect.result(service.transcribe(audio.value, "en"))).toMatchObject({
      _tag: "Failure",
      failure: { operation: "transcribe", cause: "The selected speech model is not installed." },
    });
    expect(yield* Effect.result(service.download("unknown"))).toMatchObject({ _tag: "Failure" });
  }),
);

it.effect("rejects concurrent model mutations without queuing", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const store = Layer.mock(SpeechModelStore.SpeechModelStore)({
      download: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as("installed"),
        ),
      remove: () => Effect.void,
    });
    const settings = Layer.mock(ServerSettingsService)({
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    });
    const service = yield* SpeechManagement.SpeechManagement.pipe(
      Effect.provide(
        SpeechManagement.layer.pipe(
          Layer.provide(
            Layer.mergeAll(store, settings, Layer.mock(SpeechInference.SpeechInference)({})),
          ),
        ),
      ),
    );
    const download = yield* Effect.forkChild(service.download(modelId));
    yield* Deferred.await(started);
    expect(yield* Effect.result(service.remove(modelId))).toMatchObject({ _tag: "Failure" });
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(download);
  }),
);
