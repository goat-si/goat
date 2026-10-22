import { assert, describe, expect, it } from "@effect/vitest";
import { Tool } from "effect/ai";
import { ProjectToolkit } from "../project/tools.ts";
import { OrchestratorToolkit } from "./tools.ts";

describe("orchestrator MCP tool guidance", () => {
  it("describes GOAT thread links on each reader and launcher tool", () => {
    for (const tool of [
      OrchestratorToolkit.tools.goat_thread_list,
      OrchestratorToolkit.tools.goat_thread_read,
      ProjectToolkit.tools.goat_thread_launch,
    ]) {
      assert.include(tool.description ?? "", "[title](goat-thread://v1/<threadId>)");
      assert.notInclude(tool.description ?? "", "t3-thread://");
    }
  });
});

// Oversized page sizes clamp on decode, so the schema has no `maximum`; Codex also drops
// bounds from its TypeScript view. The description is the only place a model sees a limit.
it("states goat_thread_read page size limits in the parameter descriptions", () => {
  const schema = Tool.getJsonSchema(OrchestratorToolkit.tools.goat_thread_read) as {
    readonly properties: Readonly<Record<string, { readonly description?: string }>>;
  };
  const limits = { limit: "100", runLimit: "50", maxCharsPerItem: "50000" };
  for (const [name, maximum] of Object.entries(limits)) {
    expect(schema.properties[name]?.description, name).toContain(maximum);
  }
});
