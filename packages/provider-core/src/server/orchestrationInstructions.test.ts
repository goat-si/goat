import { assert, describe, it } from "@effect/vitest";
import { GOAT_DEVELOPMENT_INSTRUCTIONS } from "./developmentInstructions.ts";
import {
  GOAT_BROWSER_TOOL_INSTRUCTIONS,
  GOAT_ORCHESTRATION_INSTRUCTIONS,
  GOAT_ORCHESTRATION_SECTIONS,
  goatAcpPromptWithInstructions,
  goatOrchestrationPromptForFirstRun,
  goatOrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

/**
 * The always-injected GOAT text an agent with GOAT MCP and the browser pays on every turn. This
 * is the one place the number lives (aside-codemode ADR-0001). It sits above the current size so
 * the next line is a judgment, not a test failure: does an agent without it reach a wrong
 * conclusion, or only earn a refusal that names the right call? Only the first belongs.
 */
const ALWAYS_INJECTED_BUDGET_BYTES = 5_632;

const bytes = (text: string) => new TextEncoder().encode(text).length;

describe("GOAT provider instructions", () => {
  it("instructs every provider to write GOAT thread links", () => {
    assert.include(GOAT_ORCHESTRATION_INSTRUCTIONS, "[title](goat-thread://v1/<threadId>)");
    assert.notInclude(GOAT_ORCHESTRATION_INSTRUCTIONS, "t3-thread://");
  });

  it("routes extra checkouts and child lanes through GOAT-managed worktrees", () => {
    assert.include(GOAT_ORCHESTRATION_INSTRUCTIONS, "GOAT-managed worktrees");
    assert.include(GOAT_ORCHESTRATION_INSTRUCTIONS, "`worktree.handoff`");
    assert.include(GOAT_ORCHESTRATION_INSTRUCTIONS, '`workspaceStrategy:{type:"worktree"}`');
    assert.include(GOAT_ORCHESTRATION_INSTRUCTIONS, '`isolation:"worktree"`');
    assert.include(GOAT_ORCHESTRATION_INSTRUCTIONS, "Do not create ad-hoc worktrees or clones");
  });

  it("keeps the always-injected text within its budget", () => {
    const injected = bytes(goatOrchestrationSystemPrompt(true) + GOAT_BROWSER_TOOL_INSTRUCTIONS);
    assert.isAtMost(
      injected,
      ALWAYS_INJECTED_BUDGET_BYTES,
      `always-injected GOAT instructions are ${injected} bytes; move what an error or goat_describe can say out of them`,
    );
  });

  it("keeps every section under Codex's per-entry limit", () => {
    for (const section of [...GOAT_ORCHESTRATION_SECTIONS, GOAT_DEVELOPMENT_INSTRUCTIONS]) {
      assert.isBelow(bytes(section), 4000);
    }
  });

  it("gives every agent the development discipline and only GOAT MCP agents the orchestration", () => {
    const orchestration = GOAT_ORCHESTRATION_INSTRUCTIONS.trim();
    const prompts = (hasGoatMcp: boolean) => [
      goatOrchestrationSystemPrompt(hasGoatMcp),
      goatOrchestrationPromptForFirstRun({ prompt: "Fix it.", runOrdinal: 1, hasGoatMcp }),
      goatAcpPromptWithInstructions({
        prompt: "Fix it.",
        state: { interactionMode: "default", hasGoatMcp },
      }),
    ];
    for (const prompt of prompts(false)) {
      assert.include(prompt, GOAT_DEVELOPMENT_INSTRUCTIONS);
      assert.notInclude(prompt, orchestration);
    }
    for (const prompt of prompts(true)) {
      assert.include(prompt, GOAT_DEVELOPMENT_INSTRUCTIONS);
      assert.include(prompt, orchestration);
    }
    assert.equal(
      goatOrchestrationPromptForFirstRun({ prompt: "Fix it.", runOrdinal: 2, hasGoatMcp: false }),
      "Fix it.",
    );
    assert.equal(
      goatOrchestrationPromptForFirstRun({ prompt: "/review", runOrdinal: 1, hasGoatMcp: false }),
      "/review",
    );
  });
});
