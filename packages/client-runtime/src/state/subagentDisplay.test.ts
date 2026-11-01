import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@goat/contracts";
import { resolveSubagentMetadata } from "./subagentDisplay.ts";

describe("subagent model labels", () => {
  it.each([
    ["codex", "GPT-6.1-Sol", undefined, "6.1 Sol"],
    ["claudeCloud", "Claude Opus 5.5", undefined, "Opus 5.5"],
    ["opencode", "Grok 4 Pro", undefined, "Grok 4 Pro"],
    ["codex", "GPT-6.1-Sol", "Supplied label", "Supplied label"],
  ])("labels %s model %s with supplied name %s as %s", (driver, name, shortName, expected) => {
    const result = resolveSubagentMetadata({
      model: "model-slug",
      provider: {
        driver: ProviderDriverKind.make(driver),
        models: [
          {
            slug: "model-slug",
            name,
            ...(shortName ? { shortName } : {}),
            isCustom: false,
            capabilities: {},
          },
        ],
      },
    });
    expect(result.modelLabel).toBe(expected);
  });
});
