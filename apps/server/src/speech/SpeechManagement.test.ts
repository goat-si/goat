import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { ServerSettingsService } from "../serverSettings.ts";
import { getSpeechModel } from "./model.ts";
import * as SpeechManagement from "./SpeechManagement.ts";
import * as SpeechModelStore from "./SpeechModelStore.ts";

const modelId = "handy-computer/whisper-tiny-gguf";

it.effect("lists, downloads, configures and removes catalog models", () =>
  Effect.gen(function* () {
    const installed = new Set<string>();
    let settings = DEFAULT_SERVER_SETTINGS;
    const store = Layer.mock(SpeechModelStore.SpeechModelStore)({
      isReady: (model) => Effect.succeed(installed.has(model.id)),
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
        SpeechManagement.layer.pipe(Layer.provide(Layer.mergeAll(store, settingsLayer))),
      ),
    );
    expect(getSpeechModel(modelId)).toBeDefined();
    yield* service.download(modelId);
    yield* service.configure({ modelId, acceleration: "cpu" });
    expect((yield* service.list).find((entry) => entry.id === modelId)).toMatchObject({
      installed: true,
      selected: true,
    });
    yield* service.remove(modelId);
    expect((yield* service.list).find((entry) => entry.id === modelId)).toMatchObject({
      installed: false,
      selected: true,
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
      Effect.provide(SpeechManagement.layer.pipe(Layer.provide(Layer.mergeAll(store, settings)))),
    );
    const download = yield* Effect.forkChild(service.download(modelId));
    yield* Deferred.await(started);
    expect(yield* Effect.result(service.remove(modelId))).toMatchObject({ _tag: "Failure" });
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(download);
  }),
);
