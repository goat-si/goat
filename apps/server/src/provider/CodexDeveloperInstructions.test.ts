import * as NodeAssert from "node:assert/strict";

import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { listedToolName } from "@goat/contracts/agentSurface/resolve";
import {
  GOAT_ORCHESTRATION_INSTRUCTIONS,
  GOAT_ORCHESTRATION_SECTIONS,
} from "@goat/provider-core/server/orchestrationInstructions";
import { GOAT_DEVELOPMENT_INSTRUCTIONS } from "@goat/provider-core/server/developmentInstructions";
import { describe, it } from "vite-plus/test";

import {
  buildCodexAdditionalContext,
  buildCodexDevelopmentContext,
  CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES,
} from "./CodexDeveloperInstructions.ts";

describe("buildCodexAdditionalContext", () => {
  describe.each([
    { model: "custom-model", modelName: "Custom 🦊 Model", reasoningEffort: "xhigh" },
  ])("with runtime $model", (runtime) => {
    it.each([
      undefined,
      false,
      true,
      { browser: false, device: false },
      { browser: true, device: false },
      { browser: false, device: true },
      { browser: true, device: true },
      { browser: true, device: true, computerUse: true },
    ])("keeps every entry within Codex's per-entry cap with tools %j", (availability) => {
      const context = buildCodexAdditionalContext(runtime, availability);

      for (const [key, entry] of Object.entries(context)) {
        // Codex counts ceil(UTF-8 bytes / 4) tokens, excluding keys and wrappers.
        const bytes = Buffer.byteLength(entry.value, "utf8");
        const limit = CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES;
        NodeAssert.ok(
          bytes <= limit,
          `${key}: ${bytes} UTF-8 bytes exceeds Codex's ${limit}-byte per-entry cap by ${bytes - limit} bytes; split the instructions into separate entries to avoid silent truncation`,
        );
      }
    });
  });

  it("delivers all orchestration sections in authored order when keys are sorted", () => {
    const context = buildCodexAdditionalContext({
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });
    NodeAssert.ok(Object.keys(context).every((key) => key.startsWith("goat_code_")));
    const sections = Object.keys(context)
      .filter((key) => key.startsWith("goat_code_orchestration_"))
      .sort()
      .map((key) => context[key]!);

    NodeAssert.deepEqual(
      sections,
      GOAT_ORCHESTRATION_SECTIONS.map((value) => ({ kind: "application", value })),
    );
    NodeAssert.equal(
      sections.map((entry) => entry.value).join("\n\n"),
      GOAT_ORCHESTRATION_INSTRUCTIONS.trim(),
    );
  });

  it("delivers the development discipline even when GOAT tools are unavailable", () => {
    const context = buildCodexDevelopmentContext();
    NodeAssert.deepEqual(context.goat_code_development, {
      kind: "application",
      value: GOAT_DEVELOPMENT_INSTRUCTIONS,
    });
  });

  it("names only tools and paths the GOAT registry has", () => {
    const entries = Object.values(agentSurfaceRegistry);
    const listed = new Set(entries.map(listedToolName));
    const paths = new Set<string>(entries.map((entry) => entry.path));
    const context = buildCodexAdditionalContext(
      { model: "gpt-5.3-codex", reasoningEffort: "high" },
      { browser: true, device: true, computerUse: true },
    );
    for (const [key, entry] of Object.entries(context)) {
      for (const name of entry.value.match(/\bgoat_[a-z_]+\b/g) ?? []) {
        NodeAssert.ok(listed.has(name), `${key} names ${name}, which no GOAT tool is listed as`);
      }
      // Any quoted resource.verb is meant as a path, so a misspelled resource fails too.
      // `tools.<name>` is Codex code mode's tool namespace, not a GOAT path.
      for (const [, path] of entry.value.matchAll(/`((?!tools\.)[a-z_]+\.[a-z_]+)`/g)) {
        NodeAssert.ok(paths.has(path!), `${key} names ${path}, which is not a GOAT path`);
      }
    }
  });
});

describe("Codex runtime context", () => {
  it("describes GOAT Markdown media support in the runtime context", () => {
    {
      const instructions = runtimeInstructions({
        model: "gpt-5.3-codex",
        reasoningEffort: "high",
      });
      NodeAssert.match(
        instructions,
        /<runtime_info>.*Markdown can embed images and videos by absolute file path\.<\/runtime_info>/,
      );
    }
  });

  it("flattens multiline metadata into single-line runtime info", () => {
    const instructions = runtimeInstructions({
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    });

    NodeAssert.match(instructions, /as gpt 5\.3 codex with high effort reasoning effort/);
    NodeAssert.doesNotMatch(instructions, /<runtime_info>[^<]*\n/);
  });
});

describe("Codex orchestration context", () => {
  it("routes native subagents within the provider and GOAT tasks with model options", () => {
    const orchestration = Object.entries(buildCodexAdditionalContext({ model: "gpt-6.1-sol" }))
      .filter(([key]) => key.startsWith("goat_code_orchestration_"))
      .map(([, entry]) => entry.value)
      .join("\n");

    NodeAssert.ok(
      orchestration.includes(
        "Use native subagents only for same-provider work here without model options",
      ),
    );
    NodeAssert.ok(
      orchestration.includes("otherwise `task.create` with the options in its `target`"),
    );
    NodeAssert.ok(
      orchestration.includes(
        "Each review round needs a new task with the brief, prior findings, and open objections",
      ),
    );
    NodeAssert.ok(!orchestration.includes("inheritedOptions"));
    NodeAssert.ok(!orchestration.includes("Prefer native"));
    // The ACP terminal fallback is ACP-only; Codex agents never need it.
    NodeAssert.ok(!orchestration.includes("acp-mcp-call"));
  });
});

function runtimeInstructions(runtime: Parameters<typeof buildCodexAdditionalContext>[0]) {
  return buildCodexAdditionalContext(runtime).goat_code_runtime!.value;
}
