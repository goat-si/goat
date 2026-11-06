import * as Schema from "effect/Schema";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import type {
  EnvironmentAuthenticatedAuth,
  EnvironmentVoiceHttpErrors,
} from "./environmentHttp.ts";
import * as Speech from "./speech.ts";
import * as Voice from "./voice.ts";

export function makeEnvironmentSpeechHttpApi(
  auth: typeof EnvironmentAuthenticatedAuth,
  errors: typeof EnvironmentVoiceHttpErrors,
) {
  const headers = Schema.Struct({
    authorization: Schema.optionalKey(Schema.String),
    dpop: Schema.optionalKey(Schema.String),
  });
  const voiceEndpoint = <P extends Schema.Top, S extends Schema.Top>(payload: P, success: S) => ({
    headers,
    payload,
    success,
    error: errors,
  });
  return HttpApiGroup.make("environmentSpeech")
    .add(
      HttpApiEndpoint.get("configuration", "/api/voice/environment/configure", {
        headers: headers,
        success: Speech.SpeechConfiguration,
        error: errors,
      }),
    )
    .add(
      HttpApiEndpoint.get("models", "/api/voice/environment/models", {
        headers: headers,
        success: Speech.SpeechModelList,
        error: errors,
      }),
    )
    .add(
      HttpApiEndpoint.post(
        "download",
        "/api/voice/environment/models/download",
        voiceEndpoint(Speech.SpeechModelRequest, Speech.SpeechMutationResult),
      ),
    )
    .add(
      HttpApiEndpoint.post(
        "remove",
        "/api/voice/environment/models/remove",
        voiceEndpoint(Speech.SpeechModelRequest, Speech.SpeechMutationResult),
      ),
    )
    .add(
      HttpApiEndpoint.post(
        "configure",
        "/api/voice/environment/configure",
        voiceEndpoint(Speech.SpeechConfiguration, Speech.SpeechMutationResult),
      ),
    )
    .add(
      HttpApiEndpoint.post(
        "transcribe",
        "/api/voice/environment/transcribe",
        voiceEndpoint(Voice.VoiceTranscriptionInput, Voice.VoiceTranscriptionResult),
      ),
    )
    .middleware(auth);
}
