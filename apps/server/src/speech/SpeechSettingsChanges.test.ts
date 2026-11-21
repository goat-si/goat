import { expect, it } from "@effect/vitest";
import { DEFAULT_SPEECH_CONFIGURATION } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SpeechSettingsChanges from "./SpeechSettingsChanges.ts";
import { ServerSettingsService } from "../serverSettings.ts";

it.effect("coalesces a slow speech settings subscriber to the latest model", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const changes = yield* SpeechSettingsChanges.make;
      const stream = yield* changes.subscribe;
      yield* changes.publish({ ...DEFAULT_SPEECH_CONFIGURATION, modelId: "first" });
      yield* changes.publish({ ...DEFAULT_SPEECH_CONFIGURATION, modelId: "second" });
      const latest = yield* Stream.runHead(stream);
      expect(Option.getOrUndefined(latest)?.modelId).toBe("second");
      expect(Option.getOrUndefined(latest)?.revision).toBe(2);
    }),
  ),
);

it.effect("publishes committed speech settings through the bounded feed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      if (!settings.subscribeSpeechChanges) throw new Error("speech settings feed unavailable");
      const stream = yield* settings.subscribeSpeechChanges;
      yield* settings.updateSettings({
        speech: { ...DEFAULT_SPEECH_CONFIGURATION, modelId: "other" },
      });
      const latest = Option.getOrUndefined(yield* Stream.runHead(stream));
      expect(latest?.modelId).toBe("other");
      expect(latest?.revision).toBeGreaterThan(0);
    }).pipe(Effect.provide(ServerSettingsService.layerTest())),
  ),
);

it.effect("retains evidence when a model change is reverted before the subscriber reads", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const changes = yield* SpeechSettingsChanges.make;
      yield* changes.publish(DEFAULT_SPEECH_CONFIGURATION);
      const stream = yield* changes.subscribe;
      const before = yield* changes.revision;
      yield* changes.publish({ ...DEFAULT_SPEECH_CONFIGURATION, modelId: "other" });
      yield* changes.publish(DEFAULT_SPEECH_CONFIGURATION);
      const latest = Option.getOrUndefined(yield* Stream.runHead(stream));
      expect(latest?.modelId).toBe(DEFAULT_SPEECH_CONFIGURATION.modelId);
      expect(latest?.revision).toBeGreaterThan(before);
    }),
  ),
);
