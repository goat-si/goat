import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as M from "./index.ts";
import { agentSurfaceRegistry } from "./agentSurface/registry.ts";
import { resolveAgentSurfaceEntry } from "./agentSurface/resolve.ts";

// Fields from a04d30a61b, with the strict parse options of memory.ts's struct.
const legacySettingsView = Schema.Struct({
  enabled: Schema.Boolean,
  hub: Schema.Struct({
    mode: Schema.Literals(["disabled", "hub", "member"]),
    version: M.NonNegativeInt,
  }),
  model: Schema.Struct({ selection: M.MemoryModelSelection, automatic: Schema.Boolean }),
});
const decodeLegacyView = Schema.decodeUnknownSync(legacySettingsView, {
  onExcessProperty: "error",
});
const encodeLegacyView = Schema.encodeSync(legacySettingsView, { onExcessProperty: "error" });
const decodeAvailabilityView = Schema.decodeUnknownSync(M.MemorySettingsViewWithAvailability);
const encodeAvailabilityView = Schema.encodeSync(M.MemorySettingsViewWithAvailability);
const encodeSettingsView = Schema.encodeSync(M.MemorySettingsView);

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

it("decodes the legacy memory settings view in both directions", () => {
  const legacyValue = decodeLegacyView({
    enabled: true,
    hub: { mode: "disabled", version: 0 },
    model: { selection: { instanceId: "codex", model: "gpt-6-luna" }, automatic: true },
  });
  const modernValue = decodeAvailabilityView(encodeLegacyView(legacyValue));
  expect(modernValue).toEqual(legacyValue);
  expect(decodeLegacyView(encodeSettingsView(modernValue))).toEqual(legacyValue);
  const unavailable = { ...modernValue, modelAvailable: false };
  const optedIn = encodeAvailabilityView(unavailable);
  expect(decodeAvailabilityView(optedIn)).toEqual(unavailable);
  expect(() => decodeLegacyView(optedIn)).toThrow("Expected no excess property");
});
