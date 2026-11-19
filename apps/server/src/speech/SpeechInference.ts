import type { SpeechConfiguration } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { loadNativeSpeechModel } from "./native.ts";

export class SpeechInferenceError extends Schema.TaggedError<SpeechInferenceError>()(
  "SpeechInferenceError",
  { cause: Schema.Defect() },
) {}

export class SpeechInference extends Context.Service<
  SpeechInference,
  {
    readonly transcribe: (
      path: string,
      pcm: Uint8Array,
      config: SpeechConfiguration,
      language?: string,
    ) => Effect.Effect<string, SpeechInferenceError | import("effect/Cause").TimeoutError>;
    readonly openStream: (
      path: string,
      config: SpeechConfiguration,
      language?: string,
    ) => Effect.Effect<
      {
        readonly feed: (
          pcm: Float32Array,
        ) => Effect.Effect<
          {
            readonly revision: number;
            readonly text: { readonly committed: string; readonly tentative: string } | null;
          },
          SpeechInferenceError
        >;
        readonly finish: Effect.Effect<string, SpeechInferenceError>;
      },
      SpeechInferenceError | import("effect/Cause").TimeoutError,
      Scope.Scope
    >;
  }
>()("goat/speech/SpeechInference") {}

export const layer = Layer.succeed(SpeechInference, {
  openStream: Effect.fn("SpeechInference.openStream")((path, config, language) =>
    Effect.acquireRelease(
      Effect.tryPromise({
        try: async (signal) => {
          const controller = new AbortController();
          const abort = () => controller.abort();
          signal.addEventListener("abort", abort, { once: true });
          let worker: Awaited<ReturnType<typeof loadNativeSpeechModel>> | undefined;
          try {
            worker = await loadNativeSpeechModel(
              path,
              controller.signal,
              undefined,
              config.acceleration,
            );
            if (!worker.supportsStreaming)
              throw new Error("The selected speech model does not support streaming.");
            await worker.begin(language);
            signal.throwIfAborted();
            return { worker, controller };
          } catch (error) {
            controller.abort();
            if (worker) await worker.dispose();
            throw error;
          } finally {
            signal.removeEventListener("abort", abort);
          }
        },
        catch: (cause) => new SpeechInferenceError({ cause }),
      }).pipe(Effect.timeout("15 seconds")),
      ({ worker, controller }) =>
        Effect.promise(async () => {
          controller.abort();
          await worker.dispose();
        }),
      { interruptible: true },
    ).pipe(
      Effect.map(({ worker }) => ({
        feed: (pcm: Float32Array) =>
          Effect.tryPromise({
            try: () => worker.feed(pcm),
            catch: (cause) => new SpeechInferenceError({ cause }),
          }),
        finish: Effect.tryPromise({
          try: () => worker.finish(),
          catch: (cause) => new SpeechInferenceError({ cause }),
        }),
      })),
    ),
  ),
  transcribe: Effect.fn("SpeechInference.transcribe")((path, pcm, config, language) =>
    Effect.tryPromise({
      try: async (signal) => {
        const worker = await loadNativeSpeechModel(path, signal, undefined, config.acceleration);
        try {
          return await worker.transcribeWav(pcm, language);
        } finally {
          await worker.dispose();
        }
      },
      catch: (cause) => new SpeechInferenceError({ cause }),
    }).pipe(Effect.timeout("120 seconds")),
  ),
});
