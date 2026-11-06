import {
  AuthVoiceManageScope,
  base64ToUint8Array,
  EnvironmentHttpApi,
  SpeechConfiguration,
  SpeechModelRequest,
  validateCanonicalVoiceWav,
  VOICE_PREWARM_MAX_REQUEST_BODY_BYTES,
  VOICE_TRANSCRIPTION_MAX_REQUEST_BODY_BYTES,
  VoiceTranscriptionInput,
  VoiceTranscriptionUpstreamError,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { requireEnvironmentScope } from "../auth/http.ts";
import * as VoiceTranscription from "../voiceTranscription.ts";
import * as SpeechInference from "./SpeechInference.ts";
import * as SpeechManagement from "./SpeechManagement.ts";
import * as SpeechModelStore from "./SpeechModelStore.ts";

const decodeModel = Schema.decodeEffect(Schema.fromJsonString(SpeechModelRequest));
const decodeConfig = Schema.decodeEffect(Schema.fromJsonString(SpeechConfiguration));
const decodeAudio = Schema.decodeEffect(Schema.fromJsonString(VoiceTranscriptionInput));
const unavailable = (error: SpeechManagement.SpeechManagementError) => {
  const message =
    error.cause === "The selected speech model is not installed." ||
    error.cause === "Speech is busy." ||
    error.cause === "Unknown model."
      ? error.cause
      : "Environment speech could not be completed.";
  return new VoiceTranscriptionUpstreamError({
    code: "voice-backend-unavailable",
    retryable:
      message === "Speech is busy." || message === "Environment speech could not be completed.",
    message,
  });
};
const mapError = <A, R>(effect: Effect.Effect<A, SpeechManagement.SpeechManagementError, R>) =>
  effect.pipe(Effect.mapError(unavailable));

export const layerHttp = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "environmentSpeech",
  Effect.fnUntraced(function* (handlers) {
    const speech = yield* SpeechManagement.SpeechManagement;
    const audioGate = yield* Semaphore.make(1);
    return handlers
      .handle(
        "models",
        Effect.fn("speech.http.models")(function* () {
          yield* requireEnvironmentScope(AuthVoiceManageScope);
          return { models: yield* mapError(speech.list) };
        }),
      )
      .handle(
        "configuration",
        Effect.fn("speech.http.configuration")(function* () {
          yield* requireEnvironmentScope(AuthVoiceManageScope);
          return yield* mapError(speech.configuration);
        }),
      )
      .handleRaw(
        "download",
        Effect.fn("speech.http.download")(function* ({ request }) {
          yield* requireEnvironmentScope(AuthVoiceManageScope);
          const body = yield* VoiceTranscription.readBoundedJsonRequestBody(
            request,
            VOICE_PREWARM_MAX_REQUEST_BODY_BYTES,
          );
          const input = yield* decodeModel(body).pipe(
            Effect.mapError(VoiceTranscription.invalidAudio),
          );
          yield* mapError(speech.download(input.modelId));
          return { ok: true as const };
        }),
      )
      .handleRaw(
        "remove",
        Effect.fn("speech.http.remove")(function* ({ request }) {
          yield* requireEnvironmentScope(AuthVoiceManageScope);
          const body = yield* VoiceTranscription.readBoundedJsonRequestBody(
            request,
            VOICE_PREWARM_MAX_REQUEST_BODY_BYTES,
          );
          const input = yield* decodeModel(body).pipe(
            Effect.mapError(VoiceTranscription.invalidAudio),
          );
          yield* mapError(speech.remove(input.modelId));
          return { ok: true as const };
        }),
      )
      .handleRaw(
        "configure",
        Effect.fn("speech.http.configure")(function* ({ request }) {
          yield* requireEnvironmentScope(AuthVoiceManageScope);
          const body = yield* VoiceTranscription.readBoundedJsonRequestBody(
            request,
            VOICE_PREWARM_MAX_REQUEST_BODY_BYTES,
          );
          const input = yield* decodeConfig(body).pipe(
            Effect.mapError(VoiceTranscription.invalidAudio),
          );
          yield* mapError(speech.configure(input));
          return { ok: true as const };
        }),
      )
      .handleRaw(
        "transcribe",
        Effect.fn("speech.http.transcribe")(function* ({ request }) {
          yield* VoiceTranscription.authorize;
          return yield* Effect.gen(function* () {
            const body = yield* VoiceTranscription.readBoundedJsonRequestBody(
              request,
              VOICE_TRANSCRIPTION_MAX_REQUEST_BODY_BYTES,
            );
            const input = yield* decodeAudio(body).pipe(
              Effect.mapError(VoiceTranscription.invalidAudio),
            );
            const bytes = base64ToUint8Array(input.audioBase64);
            if (!bytes) return yield* VoiceTranscription.invalidAudio();
            const audio = validateCanonicalVoiceWav(bytes, input.durationMs);
            if (!audio.ok) return yield* VoiceTranscription.invalidAudio();
            const language = input.locale?.split("-")[0];
            return { text: yield* mapError(speech.transcribe(audio.value, language)) };
          }).pipe(
            audioGate.withPermitsIfAvailable(1),
            Effect.flatMap((result) =>
              Effect.fromOption(result).pipe(
                Effect.mapError(() =>
                  unavailable(
                    new SpeechManagement.SpeechManagementError({
                      operation: "transcribe",
                      cause: "Speech is busy.",
                    }),
                  ),
                ),
              ),
            ),
          );
        }),
      );
  }),
);

export const layer = layerHttp.pipe(
  Layer.provide(
    SpeechManagement.layer.pipe(
      Layer.provide(SpeechModelStore.layer),
      Layer.provide(SpeechInference.layer),
    ),
  ),
);
