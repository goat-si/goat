import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  isModelSelectionProviderEnabled,
  resolveMemoryModelSelection,
  resolveReviewGuideModelSelection,
  resolveSourceControlWriterModelSelection,
} from "./serverSettings.ts";

const api = ProviderInstanceId.make("api-fixture");
const settings = {
  ...DEFAULT_SERVER_SETTINGS,
  textGenerators: {
    [api]: {
      kind: "openaiCompatible" as const,
      baseUrl: "https://model.example/v1",
      apiKey: "",
      enabled: true,
    },
  },
  textGenerationModelSelection: { instanceId: api, model: "test" },
};

describe("API text generation selection", () => {
  it("keeps memory and review-guide work on a coding provider", () => {
    expect(resolveMemoryModelSelection(settings, undefined).instanceId).toBe("codex");
    expect(resolveReviewGuideModelSelection(settings, undefined, null).instanceId).toBe("codex");
  });
  it("uses an enabled API for the source-control writer and rejects prototype keys", () => {
    const chosen = {
      ...settings,
      sourceControlWriterModelSelection: settings.textGenerationModelSelection,
    };
    expect(resolveSourceControlWriterModelSelection(chosen, [], null)).toEqual(
      settings.textGenerationModelSelection,
    );
    expect(
      isModelSelectionProviderEnabled(
        { ...settings, textGenerators: {} },
        { instanceId: ProviderInstanceId.make("constructor"), model: "x" },
      ),
    ).toBe(false);
    const disabled = {
      ...chosen,
      textGenerationModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "fallback",
      },
      textGenerators: { [api]: { ...settings.textGenerators[api]!, enabled: false } },
    };
    expect(resolveSourceControlWriterModelSelection(disabled, undefined, null)).toEqual(
      disabled.textGenerationModelSelection,
    );
  });
});
