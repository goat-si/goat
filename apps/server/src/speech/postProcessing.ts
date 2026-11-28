// @effect-diagnostics nodeBuiltinImport:off -- Cleanup uses a scratch directory, never a checkout.
import * as NodeOS from "node:os";
import { DEFAULT_SPEECH_POST_PROCESSING_PROMPT, type SpeechConfiguration } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ServerSettingsService } from "../serverSettings.ts";
import type { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { applySpeechAliases } from "./customWords.ts";
import { removeSpeechFillerWords } from "./fillerWords.ts";

export class SpeechPostProcessingError extends Schema.TaggedError<SpeechPostProcessingError>()(
  "SpeechPostProcessingError",
  { detail: Schema.String },
) {}

export interface SpeechPostProcessingServices {
  readonly settings: ServerSettingsService["Service"] | null;
  readonly textGeneration: TextGeneration["Service"] | null;
}

/** Deterministic cleanup: no provider, account, or subscription needed. */
export function finalizeLocalTranscript(
  text: string,
  config: SpeechConfiguration,
  language?: string,
): string {
  if (config.postProcessingMode === "off") return text.trim();
  return applySpeechAliases(removeSpeechFillerWords(text, language), config.customWords).trim();
}

export const postProcessTranscript = Effect.fn("SpeechPostProcessing.process")(function* (
  text: string,
  config: SpeechConfiguration,
  language: string | undefined,
  draftText: string,
  services: SpeechPostProcessingServices,
) {
  const local = finalizeLocalTranscript(text, config, language);
  if (config.postProcessingMode !== "llm" || local.length === 0) return local;
  if (!services.settings)
    return yield* new SpeechPostProcessingError({ detail: "Settings are unavailable." });
  const current = yield* services.settings.getSettings.pipe(
    Effect.mapError(() => new SpeechPostProcessingError({ detail: "Could not read settings." })),
  );
  const modelSelection = current.defaultModelSelection;
  if (modelSelection === null)
    return yield* new SpeechPostProcessingError({
      detail: "Choose a default model for AI voice cleanup, or use local cleanup.",
    });
  const generation = services.textGeneration?.generateSpeechPostProcessing;
  if (!generation)
    return yield* new SpeechPostProcessingError({
      detail: "AI voice cleanup is unavailable on this environment.",
    });
  const cleaned = yield* generation({
    cwd: NodeOS.tmpdir(),
    transcript: local,
    draftText,
    instructions: config.postProcessingInstructions.trim() || DEFAULT_SPEECH_POST_PROCESSING_PROMPT,
    ...(language ? { language } : {}),
    modelSelection,
  }).pipe(
    Effect.mapError(
      (error) =>
        new SpeechPostProcessingError({ detail: error.message || "AI voice cleanup failed." }),
    ),
  );
  return cleaned.text.length > 0 ? cleaned.text : local;
});
