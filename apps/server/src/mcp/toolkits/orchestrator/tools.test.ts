import { assert, describe, expect, it } from "@effect/vitest";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { Tool } from "effect/ai";
import { OrchestratorToolkit } from "./tools.ts";

describe("orchestrator MCP tool guidance", () => {
  it("describes GOAT thread links in each reader and launcher tool's guide", () => {
    for (const path of ["thread.list", "thread.read", "thread.launch"] as const) {
      const { description, guide } = agentSurfaceRegistry[path];
      assert.include(guide ?? "", "[title](goat-thread://v1/<threadId>)");
      assert.notInclude(`${description} ${guide ?? ""}`, "t3-thread://");
    }
  });

  it("keeps the launch watch opt-out guidance in goat_thread_launch's guide", () => {
    expect(agentSurfaceRegistry["thread.launch"].guide).toContain(
      'notifyOnCompletion:false or goat_thread_unwatch stops run-end and host-outage reports. Only local user-input questions still arrive. SSH-host questions then need goat_thread_wait({host}) or goat_pending_request_list({scope:"launched", hosts}). Approvals are no longer reported; check goat_thread_read or tell the user the thread may be waiting.',
    );
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
