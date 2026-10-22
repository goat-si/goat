import { expect, it } from "@effect/vitest";

import { PermissionCapability } from "../permissionProfiles.ts";
import { type AgentSurfaceEntry, agentSurfaceRegistry } from "./registry.ts";

const entries: ReadonlyArray<AgentSurfaceEntry & { readonly path: string }> =
  Object.values(agentSurfaceRegistry);
const declarable: ReadonlyArray<string> = [...PermissionCapability.literals, "none"];

it("declares the goatclaw capability every write needs, with a reason when it needs none", () => {
  for (const entry of entries) {
    if (entry.effect === "read") {
      expect(entry.capability, entry.path).toBeUndefined();
      continue;
    }
    expect(declarable, entry.path).toContain(entry.capability);
    if (entry.capability === "none")
      expect(entry.capabilityReason?.trim(), entry.path).toBeTruthy();
    else expect(entry.capabilityReason, entry.path).toBeUndefined();
  }
});
