import { describe, expect, it } from "@effect/vitest";
import type { OpenCodexInventorySnapshot } from "@goat/contracts";

import { fleetSnapshot } from "./parity.testkit.ts";
import { type OpenCodexUpdateMember, planOpenCodexUpdate } from "./opencodexUpdatePlan.ts";

type Alias = "mac-studio" | "macmini-ts" | "lidge-ts";

const snapshot = (
  alias: "home" | Alias,
  overrides: {
    version?: string;
    ownership?: OpenCodexInventorySnapshot["ownership"];
    healthy?: boolean;
    service?: OpenCodexInventorySnapshot["service"];
  } = {},
): OpenCodexInventorySnapshot => {
  const base = fleetSnapshot(alias);
  return {
    ...base,
    ownership: overrides.ownership ?? "managed",
    service: overrides.service ?? {
      available: true,
      installed: true,
      running: true,
      backend: "launchd",
    },
    runtime: {
      ...base.runtime,
      ...(overrides.version === undefined ? {} : { version: overrides.version }),
      healthy: overrides.healthy ?? true,
    },
    parityEvidence: { ...base.parityEvidence!, startedAt: 1, processId: 100 },
  };
};
const member = (
  alias: "home" | Alias,
  overrides: Parameters<typeof snapshot>[1] & { runningTurns?: number | undefined } = {},
): OpenCodexUpdateMember => ({
  alias: alias === "home" ? null : alias,
  snapshot: snapshot(alias, overrides),
  runningTurns: "runningTurns" in overrides ? overrides.runningTurns : 0,
});

describe("planOpenCodexUpdate", () => {
  it("moves a managed pair Home first, then each Child", () => {
    const plan = planOpenCodexUpdate({
      home: member("home", { version: "2.89.0" }),
      children: [
        member("mac-studio", { version: "2.86.0" }),
        member("macmini-ts", { version: "2.83.0" }),
      ],
      targetVersion: "2.90.0",
      failedTargets: {},
    });
    expect(plan).toMatchObject({ decision: "update", reason: "eligible", targetVersion: "2.90.0" });
    expect(plan.steps).toEqual([
      { alias: null, fromVersion: "2.89.0" },
      { alias: "mac-studio", fromVersion: "2.86.0" },
      { alias: "macmini-ts", fromVersion: "2.83.0" },
    ]);
  });

  it("never updates because of drift alone", () => {
    const plan = planOpenCodexUpdate({
      home: member("home", { version: "2.89.0" }),
      children: [member("mac-studio", { version: "2.89.0" })],
      targetVersion: "2.89.0",
      failedTargets: {},
    });
    expect(plan).toMatchObject({ decision: "none", reason: "up-to-date", steps: [] });

    // Drift between adopted installs only advises; nothing is replaced.
    const adopted = planOpenCodexUpdate({
      home: member("home", { version: "2.89.0", ownership: "adopted" }),
      children: [member("macmini-ts", { version: "2.83.0", ownership: "adopted" })],
      targetVersion: "2.89.0",
      failedTargets: {},
    });
    expect(adopted).toMatchObject({ decision: "none", reason: "advice-only", steps: [] });
    expect(adopted.advisories).toEqual([
      { alias: "macmini-ts", version: "2.83.0", targetVersion: "2.89.0" },
    ]);
  });

  it("holds the Home while a Child cannot follow it", () => {
    for (const blocker of [
      member("mac-studio", { version: "2.86.0", ownership: "adopted" }),
      member("mac-studio", { version: "2.86.0", healthy: false }),
      member("mac-studio", { version: "2.86.0-preview.1" }),
      // OCX-10 absent: a restart's effect on the service is unknown.
      member("mac-studio", { version: "2.86.0", service: { available: false } }),
    ]) {
      const plan = planOpenCodexUpdate({
        home: member("home", { version: "2.89.0" }),
        children: [blocker, member("macmini-ts", { version: "2.83.0" })],
        targetVersion: "2.90.0",
        failedTargets: {},
      });
      expect(plan).toMatchObject({
        decision: "wait",
        reason: "child-cannot-follow",
        waitingOn: ["mac-studio"],
        steps: [],
      });
    }
    // A Child whose last move to this target rolled back cannot follow either.
    expect(
      planOpenCodexUpdate({
        home: member("home", { version: "2.89.0" }),
        children: [member("mac-studio", { version: "2.86.0" })],
        targetVersion: "2.90.0",
        failedTargets: { "mac-studio": "2.90.0" },
      }),
    ).toMatchObject({ decision: "wait", reason: "child-cannot-follow" });
  });

  it("keeps a Child from running ahead of its Home", () => {
    const plan = planOpenCodexUpdate({
      home: member("home", { version: "2.89.0", ownership: "adopted" }),
      children: [member("mac-studio", { version: "2.86.0" })],
      targetVersion: "2.90.0",
      failedTargets: {},
    });
    expect(plan).toMatchObject({ decision: "none", reason: "home-behind", steps: [] });
    expect(plan.advisories).toEqual([{ alias: null, version: "2.89.0", targetVersion: "2.90.0" }]);

    // Once the Home is already on the target, a managed Child catches up alone.
    expect(
      planOpenCodexUpdate({
        home: member("home", { version: "2.90.0", ownership: "adopted" }),
        children: [
          member("mac-studio", { version: "2.86.0" }),
          member("lidge-ts", { version: "2.83.0", runningTurns: 2 }),
        ],
        targetVersion: "2.90.0",
        failedTargets: {},
      }),
    ).toMatchObject({
      decision: "wait",
      reason: "busy",
      waitingOn: ["lidge-ts"],
    });
  });

  it("waits for the whole pair when the Home moves", () => {
    for (const runningTurns of [1, undefined]) {
      expect(
        planOpenCodexUpdate({
          home: member("home", { version: "2.89.0" }),
          children: [
            member("mac-studio", { version: "2.90.0", ownership: "adopted", runningTurns }),
          ],
          targetVersion: "2.90.0",
          failedTargets: {},
        }),
      ).toMatchObject({ decision: "wait", reason: "busy", waitingOn: ["mac-studio"] });
    }
  });

  it("never retries a rolled-back target or follows a preview", () => {
    expect(
      planOpenCodexUpdate({
        home: member("home", { version: "2.89.0" }),
        children: [],
        targetVersion: "2.90.0",
        failedTargets: { "": "2.90.0" },
      }),
    ).toMatchObject({ decision: "none", reason: "previous-failure" });
    expect(
      planOpenCodexUpdate({
        home: member("home", { version: "2.89.0" }),
        children: [],
        targetVersion: "2.91.0",
        failedTargets: { "": "2.90.0" },
      }),
    ).toMatchObject({ decision: "update", steps: [{ alias: null, fromVersion: "2.89.0" }] });
    expect(
      planOpenCodexUpdate({
        home: member("home", {
          version: "2.89.0",
          service: { available: true, installed: true, running: false },
        }),
        children: [],
        targetVersion: "2.90.0",
        failedTargets: {},
      }),
    ).toMatchObject({ decision: "none", reason: "service-unknown" });
    const noUptime = member("home", { version: "2.89.0" });
    expect(
      planOpenCodexUpdate({
        home: {
          ...noUptime,
          snapshot: { ...noUptime.snapshot!, parityEvidence: { observedAt: 0 } },
        },
        children: [],
        targetVersion: "2.90.0",
        failedTargets: {},
      }),
    ).toMatchObject({ decision: "none", reason: "restart-unobservable" });
    expect(
      planOpenCodexUpdate({
        home: member("home", { version: "2.89.0" }),
        children: [],
        targetVersion: "2.90.0-preview.1",
        failedTargets: {},
      }),
    ).toMatchObject({ decision: "none", reason: "no-target" });
    expect(
      planOpenCodexUpdate({
        home: member("home", { version: "2.89.0-preview.3" }),
        children: [],
        targetVersion: "2.90.0",
        failedTargets: {},
      }),
    ).toMatchObject({ decision: "none", reason: "unpublished-version" });
  });
});
