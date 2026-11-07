import * as Layer from "effect/Layer";
import * as VoiceTranscription from "../voiceTranscription.ts";
import * as SpeechHttp from "./http.ts";

export const layer = Layer.mergeAll(VoiceTranscription.layer, SpeechHttp.layer);
