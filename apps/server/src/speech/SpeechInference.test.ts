import { expect, it } from "@effect/vitest";
import { DEFAULT_SPEECH_CONFIGURATION } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

const native = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("./native.ts", () => ({ loadNativeSpeechModel: native.load }));
import * as SpeechInference from "./SpeechInference.ts";

it.effect("releases an unsupported native model and reports that streaming is unavailable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      native.load.mockReset();
      const dispose = vi.fn(async () => {});
      native.load.mockResolvedValue({ supportsStreaming: false, dispose });
      const inference = yield* SpeechInference.SpeechInference;
      const result = yield* Effect.result(
        Effect.scoped(inference.openStream("fixture", DEFAULT_SPEECH_CONFIGURATION)),
      );
      expect(result).toMatchObject({ _tag: "Failure", failure: { code: "unsupported" } });
      expect(dispose).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(SpeechInference.layer)),
  ),
);

it.effect("interrupts native model loading after fifteen seconds", () =>
  Effect.scoped(
    Effect.gen(function* () {
      native.load.mockReset();
      const entered = Promise.withResolvers<AbortSignal>();
      const done = yield* Deferred.make<void>();
      native.load.mockImplementation((_path: string, signal: AbortSignal) => {
        entered.resolve(signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      });
      const inference = yield* SpeechInference.SpeechInference;
      const loading = yield* Effect.scoped(
        inference.openStream("fixture", DEFAULT_SPEECH_CONFIGURATION),
      ).pipe(Effect.result, Effect.ensuring(Deferred.succeed(done, undefined)), Effect.forkChild);
      const signal = yield* Effect.promise(() => entered.promise);
      yield* TestClock.adjust("15 seconds");
      expect(yield* Deferred.isDone(done)).toBe(true);
      expect((yield* Fiber.join(loading))._tag).toBe("Failure");
      expect(signal.aborted).toBe(true);
    }).pipe(Effect.provide(SpeechInference.layer)),
  ),
);
