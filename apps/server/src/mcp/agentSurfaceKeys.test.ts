import { expect, it } from "@effect/vitest";
import type { AgentSurfaceEntry } from "@goat/contracts/agentSurface";
import { isKeyedWrite } from "@goat/contracts/agentSurface/resolve";
import { Tool } from "effect/ai";

import { entries, toolkits } from "./agentSurface.testkit.ts";

type Entry = (typeof entries)[number];
const reasonOf = (entry: AgentSurfaceEntry) => entry.idempotencyReason;
const inputProperties = (entry: Entry) => {
  const tools: Record<string, Tool.Any> = toolkits[entry.schemaRefs.toolkit].tools;
  const tool = tools[entry.schemaRefs.tool];
  expect(tool, entry.path).toBeDefined();
  return (Tool.getJsonSchema(tool!) as { readonly properties?: object }).properties ?? {};
};

it("takes clientRequestId on every write the registry says GOAT deduplicates", () => {
  const keyed = entries.filter((entry) => isKeyedWrite(entry));
  expect(keyed.length).toBeGreaterThan(0);
  for (const entry of keyed)
    expect(inputProperties(entry), entry.path).toHaveProperty("clientRequestId");
});

it("records why a write that takes its own clientRequestId keeps that key out of GOAT's store", () => {
  for (const entry of entries) {
    if (entry.effect === "read" || isKeyedWrite(entry)) continue;
    if ("clientRequestId" in inputProperties(entry))
      expect(reasonOf(entry), entry.path).toBeTruthy();
  }
});
