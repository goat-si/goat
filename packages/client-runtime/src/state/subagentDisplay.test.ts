import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@goat/contracts";
import { resolveSubagentMetadata, subagentDetailPreview } from "./subagentDisplay.ts";

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

describe("subagentDetailPreview", () => {
  it("prefers progress for live work and results for settled work", () => {
    const details = { progress: "Reading files", result: "Found two\n  problems" };
    expect(subagentDetailPreview({ ...details, status: "running" })).toBe("Reading files");
    expect(subagentDetailPreview({ ...details, status: "completed" })).toBe("Found two problems");
    expect(
      subagentDetailPreview({ status: "failed", progress: "Last progress", result: " " }),
    ).toBe("Last progress");
    expect(subagentDetailPreview({ status: "pending" })).toBeNull();
  });
});

it.each([279, 280, 281])("preserves the preview boundary at %i characters", (length) => {
  const result = "x".repeat(length);
  expect(subagentDetailPreview({ status: "completed", result })).toBe(
    length > 280 ? "x".repeat(280) + "…" : result,
  );
});

it("normalizes Unicode whitespace and ignores a large hidden suffix", () => {
  const progress = " \u00a0Reading\tfiles\n" + "x".repeat(1_000_000);
  expect(subagentDetailPreview({ status: "running", progress })).toBe(
    "Reading files " + "x".repeat(266) + "…",
  );
  expect(
    subagentDetailPreview({ status: "completed", result: "x".repeat(280) + " \n\u2028" }),
  ).toBe("x".repeat(280));
  expect(subagentDetailPreview({ status: "completed", result: "x".repeat(279) + " \n y" })).toBe(
    "x".repeat(279) + "…",
  );
  expect(
    subagentDetailPreview({ status: "running", progress: "\uFEFF\u2029", result: " Done " }),
  ).toBe("Done");
  expect(subagentDetailPreview({ status: "failed", result: "x".repeat(279) + "😀" })).toBe(
    "x".repeat(279) + "\uD83D…",
  );
});
