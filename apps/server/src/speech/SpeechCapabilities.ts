import { SPEECH_MODELS } from "./model.ts";

export const speechStreamingCapabilities = {
  speechStreamingV1: true,
  speechStreamingModelIds: SPEECH_MODELS.filter((model) => model.supportsStreaming).map(
    (model) => model.id,
  ),
} as const;
