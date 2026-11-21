import { expect, it } from "@effect/vitest";
import { DEFAULT_SPEECH_CONFIGURATION } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerSettingsService } from "../serverSettings.ts";
import * as SpeechInference from "./SpeechInference.ts";
import * as SpeechManagement from "./SpeechManagement.ts";
import * as SpeechModelStore from "./SpeechModelStore.ts";
import * as SpeechStreamConnection from "./SpeechStreamConnection.ts";

it.effect("admits only one live model across different websocket connections", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const layer = SpeechManagement.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerSettingsService.layerTest({ speech: DEFAULT_SPEECH_CONFIGURATION }),
            Layer.mock(SpeechModelStore.SpeechModelStore)({
              installedPath: () => Effect.succeed("fixture.gguf"),
            }),
            Layer.mock(SpeechInference.SpeechInference)({
              openStream: () =>
                Effect.succeed({
                  feed: () => Effect.succeed({ revision: 0, text: null }),
                  finish: Effect.succeed(""),
                }),
            }),
          ),
        ),
      );
      const manager = yield* SpeechManagement.SpeechManagement.pipe(Effect.provide(layer));
      yield* Effect.gen(function* () {
        const first = yield* SpeechStreamConnection.make;
        const second = yield* SpeechStreamConnection.make;
        const { streamId } = yield* first.start();
        expect(yield* Effect.result(second.start())).toMatchObject({
          _tag: "Failure",
          failure: { code: "busy" },
        });
        yield* first.cancel(streamId);
        expect(yield* Effect.result(second.start())).toMatchObject({ _tag: "Success" });
      }).pipe(Effect.provideService(SpeechManagement.SpeechManagement, manager));
    }),
  ),
);
