import { expect, it } from "@effect/vitest";

import { DESCRIPTION_BUDGET, DESCRIPTIONS_OVER_BUDGET } from "./descriptionBudget.ts";
import { agentSurfaceRegistry } from "./registry.ts";

const entries = Object.values(agentSurfaceRegistry);

it("keeps every description within the budget, and a recorded longer one from growing", () => {
  const grown = entries.flatMap((entry) => {
    const allowed = DESCRIPTIONS_OVER_BUDGET[entry.path] ?? DESCRIPTION_BUDGET;
    return entry.description.length > allowed
      ? [`${entry.path}: ${entry.description.length} > ${allowed}`]
      : [];
  });
  expect(grown).toEqual([]);
});

it("drops a recorded description from the over-budget list once it fits or its path is gone", () => {
  const stale = Object.keys(DESCRIPTIONS_OVER_BUDGET).filter((path) => {
    const entry = entries.find((candidate) => candidate.path === path);
    return entry === undefined || entry.description.length <= DESCRIPTION_BUDGET;
  });
  expect(stale).toEqual([]);
});
