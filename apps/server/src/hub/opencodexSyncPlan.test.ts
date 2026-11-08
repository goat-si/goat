import { expect, it } from "@effect/vitest";
import type { OpenCodexInventorySnapshot } from "@goat/contracts";

import { planCoordinator } from "./opencodexSyncPlan.ts";

const notInstalled = (slow: boolean): OpenCodexInventorySnapshot => ({
  installed: false,
  binaries: [],
  ownership: "none",
  service: { available: false },
  runtime: { port: 10100, healthy: false, ready: false },
  link: { role: "none", available: false, links: [], childSettingsApplied: null },
  ...(slow ? { slow: true as const } : {}),
});

it("a machine whose ocx did not answer in time is skipped as unreachable, not missing", () => {
  expect(
    planCoordinator({ alias: null, snapshot: notInstalled(true), runningTurns: 0 }).member,
  ).toMatchObject({ state: "skipped", reason: "unreachable" });
  expect(
    planCoordinator({ alias: null, snapshot: notInstalled(false), runningTurns: 0 }).member,
  ).toMatchObject({ state: "skipped", reason: "not-installed" });
});
