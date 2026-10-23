import { expect, it } from "@effect/vitest";

import { DESCRIPTION_BUDGET, DESCRIPTIONS_OVER_BUDGET } from "./descriptionBudget.ts";
import { type AgentSurfaceEntry, agentSurfaceRegistry } from "./registry.ts";

const entries: ReadonlyArray<AgentSurfaceEntry & { readonly path: string }> =
  Object.values(agentSurfaceRegistry);

it("keeps every description within the budget, and a recorded longer one at its recorded length", () => {
  const off = entries.flatMap((entry) => {
    const length = entry.description.length;
    const recorded = DESCRIPTIONS_OVER_BUDGET[entry.path];
    if (recorded === undefined)
      return length > DESCRIPTION_BUDGET
        ? [`${entry.path}: ${length} > ${DESCRIPTION_BUDGET}`]
        : [];
    // A shorter description lowers its record, so the freed length cannot be spent again.
    return length === recorded ? [] : [`${entry.path}: ${length}, recorded ${recorded}`];
  });
  expect(off).toEqual([]);
});

it("drops a recorded description from the over-budget list once it fits or its path is gone", () => {
  const stale = Object.keys(DESCRIPTIONS_OVER_BUDGET).filter((path) => {
    const entry = entries.find((candidate) => candidate.path === path);
    return entry === undefined || entry.description.length <= DESCRIPTION_BUDGET;
  });
  expect(stale).toEqual([]);
});

it("fits the budget once an entry has a guide to hold the rest", () => {
  const unmoved = entries
    .filter((entry) => entry.guide !== undefined && entry.path in DESCRIPTIONS_OVER_BUDGET)
    .map((entry) => entry.path);
  expect(unmoved).toEqual([]);
});
