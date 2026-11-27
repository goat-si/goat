import type * as AcpSchema from "effect-acp/schema";

const enabled = process.env.GOAT_ACP_ANTIGRAVITY_THOUGHT_LEVEL === "1";
const resumeLevel = process.env.GOAT_ACP_RESUME_THOUGHT_LEVEL;
let currentLevel = "high";

export const antigravityThoughtLevelOption = (
  currentModelId: string,
): ReadonlyArray<AcpSchema.SessionConfigOption> =>
  enabled
    ? [
        {
          configId: "thought_level",
          name: "Thinking Level",
          category: "thought_level",
          type: "select" as const,
          currentValue: currentLevel,
          options:
            currentModelId === "gemini-test-high"
              ? [
                  { value: "low", name: "Low" },
                  { value: "medium", name: "Medium" },
                  { value: "high", name: "High" },
                ]
              : [
                  { value: "low", name: "Low" },
                  { value: "medium", name: "Medium" },
                  { value: "high", name: "High" },
                  { value: "xhigh", name: "Extra" },
                ],
        },
      ]
    : [];

export const applyAntigravityResumeThoughtLevel = (): void => {
  if (resumeLevel) {
    currentLevel = resumeLevel;
  }
};

export const onAntigravityModelSelected = (modelId: string): void => {
  if (enabled) {
    currentLevel = modelId === "gemini-test-high" ? "medium" : "high";
  }
};

export const setAntigravityThoughtLevel = (level: string): void => {
  currentLevel = level;
};
