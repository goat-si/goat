import * as Layer from "effect/Layer";
import * as VoiceTranscription from "../voiceTranscription.ts";
import * as SpeechHttp from "./http.ts";
import * as SpeechManagement from "./SpeechManagement.ts";
import * as SpeechInference from "./SpeechInference.ts";
import * as SpeechModelStore from "./SpeechModelStore.ts";

export const layerManagement = SpeechManagement.layer.pipe(
  Layer.provide(SpeechModelStore.layer),
  Layer.provide(SpeechInference.layer),
);
export const layer = Layer.mergeAll(VoiceTranscription.layer, SpeechHttp.layerHttp);
