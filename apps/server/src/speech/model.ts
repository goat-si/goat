import catalog from "./catalog.json" with { type: "json" };

export type SpeechModel = (typeof catalog.models)[number];

export const SPEECH_MODELS: readonly SpeechModel[] = catalog.models;
export const getSpeechModel = (modelId: string): SpeechModel | undefined =>
  SPEECH_MODELS.find((model) => model.id === modelId);
