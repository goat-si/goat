import type * as EffectAcpSchema from "effect-acp/compat";

export const modelOptions = [
  { value: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
  { value: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
  { value: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
  { value: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)" },
  { value: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)" },
  { value: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)" },
  { value: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)" },
  { value: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash (Medium)" },
  { value: "gemini-3.6-flash-low", name: "Gemini 3.6 Flash (Low)" },
  { value: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)" },
  { value: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
];

export const modelConfig = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "gemini-3.7-flash-high",
  options: modelOptions,
} satisfies EffectAcpSchema.SessionConfigOption;

export const sessionSetupResult = {
  sessionId: "session-1",
  models: {
    currentModelId: "gemini-3.7-flash-high",
    availableModels: modelOptions.map((option) => ({ modelId: option.value, name: option.name })),
  },
  configOptions: [
    modelConfig,
    {
      id: "mode",
      name: "Session Mode",
      category: "mode",
      type: "select",
      currentValue: "default",
      options: [
        { value: "default", name: "Default" },
        { value: "yolo", name: "YOLO" },
      ],
    },
  ],
} satisfies EffectAcpSchema.NewSessionResponse;
