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
      linkedFrom: () => Effect.undefined,
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
    const recommended = (yield* service.list).find(
      (entry) => entry.id === "handy-computer/parakeet-unified-en-0.6b-gguf",
    );
    expect(recommended?.recommended).toBe(true);
    expect(recommended).toMatchObject({ benchmark: { cpu: 2.15, accelerated: 1.19 } });
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

const linked = "handy-computer/parakeet-unified-en-0.6b-gguf";
// The store links `linked` from "/models" and finds nothing anywhere else; every
// model reports an origin, as a dangling link does once its file is gone.
const linkHarness = Effect.fn("test.linkHarness")(function* () {
  const installed = new Set([modelId]);
  let settings = {
    ...DEFAULT_SERVER_SETTINGS,
    speech: { ...DEFAULT_SERVER_SETTINGS.speech, modelId },
  };
  const store = Layer.mock(SpeechModelStore.SpeechModelStore)({
    linkedFrom: () => Effect.succeed("/elsewhere/model.gguf"),
    isReady: (model) => Effect.succeed(installed.has(model.id)),
    link: (_models, source) =>
      Effect.sync(() => {
        if (source !== "/models") return [];
        installed.add(linked);
        return [linked];
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
          Layer.mergeAll(store, settingsLayer, Layer.mock(SpeechInference.SpeechInference)({})),
        ),
      ),
    ),
  );
  return { service, installed, selected: () => settings.speech.modelId };
});

it.effect("link fails when no catalog model file is found at the path", () =>
  Effect.gen(function* () {
    const { service, selected } = yield* linkHarness();
    expect(yield* Effect.result(service.link("/empty"))).toMatchObject({
      _tag: "Failure",
      failure: { operation: "link", cause: SpeechManagement.NO_LINKABLE_MODEL },
    });
    expect(selected()).toBe(modelId);
  }),
);

it.effect("link keeps a working selection and replaces one that is not ready", () =>
  Effect.gen(function* () {
    const { service, installed, selected } = yield* linkHarness();
    yield* service.link("/models");
    expect(selected()).toBe(modelId);
    installed.delete(modelId);
    yield* service.link("/models");
    expect(selected()).toBe(linked);
  }),
);

it.effect("lists a model's link origin only while the model is ready", () =>
  Effect.gen(function* () {
    const { service, installed } = yield* linkHarness();
    installed.delete(modelId);
    yield* service.link("/models");
    const listed = yield* service.list;
    expect(listed.find((entry) => entry.id === modelId)).not.toHaveProperty("linkedFrom");
    expect(listed.find((entry) => entry.id === linked)).toHaveProperty(
      "linkedFrom",
      "/elsewhere/model.gguf",
    );
  }),
);
