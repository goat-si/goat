import type * as AcpSchema from "effect-acp/schema";

export function availableModels(
  configOptionsFor: (modelId: string) => ReadonlyArray<AcpSchema.SessionConfigOption>,
) {
  return [
    { value: "default", name: "Auto" },
    { value: "composer-2", name: "Composer 2" },
    { value: "gpt-5.4", name: "GPT-5.4" },
    { value: "claude-opus-4-6", name: "Opus 4.6" },
  ].map((model) => ({ ...model, configOptions: configOptionsFor(model.value) }));
}
