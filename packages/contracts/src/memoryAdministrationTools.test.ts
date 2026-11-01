import { expect, it } from "@effect/vitest";
import * as M from "./index.ts";
import { agentSurfaceRegistry } from "./agentSurface/registry.ts";
import { resolveAgentSurfaceEntry } from "./agentSurface/resolve.ts";

it("lists all memory administration tools", () => {
  expect(M.MEMORY_ADMINISTRATION_MCP_TOOLS).toEqual([
    "goat_memory_binding_read",
    "goat_memory_hub_diagnostics",
    "goat_memory_hub_reconcile",
    "goat_memory_report_attempts_reset",
    "memory_hub_disable",
    "memory_settings_get",
    "memory_settings_update",
  ]);
});

it("keeps binding changes with a person in Settings", () => {
  expect(resolveAgentSurfaceEntry("memory.binding_update")).toBeUndefined();
  expect(agentSurfaceRegistry["memory.binding_read"].guide).toContain(
    "Only a person can change project bindings in Settings",
  );
});
