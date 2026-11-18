import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@goat/contracts";
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
    const providers = [
      {
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        version: null,
        checkedAt: "2026-11-17T00:00:00.000Z",
        models: [],
        slashCommands: [],
        skills: [],
      },
    ] satisfies ServerProvider[];
    expect(resolveMemoryModelSelection(settings, providers, 0)?.instanceId).toBe("codex");
    expect(resolveReviewGuideModelSelection(settings, providers, null, 0)?.instanceId).toBe(
      "codex",
    );
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
