import { describe, expect, it } from "vite-plus/test";
import { modelShortName, resolveModelShortName } from "./modelShortName.ts";

describe("modelShortName", () => {
  it.each([
    ["Claude Opus 5.5", ["Claude "], "Opus 5.5"],
    ["GPT-6.1-Sol", ["GPT-"], "6.1 Sol"],
    ["GPT 6.0 Astra", ["GPT-", "GPT "], "6.0 Astra"],
    ["Grok 4 Pro", [], undefined],
    ["Claude Opus 5.5", [], "Opus 5.5"],
    ["NVIDIA: Nemotron 3 Super", [], "Nemotron 3 Super"],
    ["GPT-5.5", ["GPT-"], undefined],
    ["Gemini 3.1 Pro", ["Gemini "], "3.1 Pro"],
    ["Gemini 3.1 Pro", [], undefined],
    ["GPT-6.1-mini", [], undefined],
    ["Claude ", ["Claude "], undefined],
    ["Unknown Model", [], undefined],
  ] as const)("derives %s with families %j as %s", (name, families, expected) => {
    expect(modelShortName(name, families)).toBe(expected);
  });

  it.each([
    ["codex", "GPT-6.1-Sol", "6.1 Sol"],
    ["claudeAgent", "Claude Opus 5.5", "Opus 5.5"],
    ["claudeCloud", "Claude Opus 5.5", "Opus 5.5"],
    ["grok", "Grok 4 Pro", "4 Pro"],
    ["cursor", "Grok 4 Pro", "4 Pro"],
    ["cursorCloud", "Grok 4 Pro", "4 Pro"],
    ["antigravity", "Gemini 3.1 Pro", "3.1 Pro"],
    ["muse", "Muse 1 Pro", "1 Pro"],
    ["opencode", "Grok 4 Pro", undefined],
    ["pi", "Gemini 3.1 Pro", undefined],
    ["acpRegistry", "GPT-5.5", undefined],
    ["devinCloud", "Grok 4 Pro", undefined],
    [undefined, "Claude Opus 5.5", "Opus 5.5"],
  ])("resolves %s model %s as %s", (driver, name, expected) => {
    expect(resolveModelShortName({ name }, driver)).toBe(expected);
  });

  it("preserves a supplied short name ahead of the derived label", () => {
    expect(resolveModelShortName({ name: "GPT-6.1-Sol", shortName: "Chosen label" }, "codex")).toBe(
      "Chosen label",
    );
  });
});
