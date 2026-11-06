import type { SpeechConfiguration } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
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
  }
>()("goat/speech/SpeechInference") {}

export const layer = Layer.succeed(SpeechInference, {
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
