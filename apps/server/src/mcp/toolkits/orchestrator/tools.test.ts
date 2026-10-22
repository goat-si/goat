import { assert, describe, it } from "@effect/vitest";
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
