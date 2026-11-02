import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  applyArgs,
  applyOutcome,
  OCX_CONTRACT,
  orchestratedPlanOf,
  planArgs,
  probeContracts,
} from "./ocxContracts.ts";

const plan = {
  schema: "ocx.update.plan/1",
  currentVersion: "1.0.0",
  targetVersion: "1.1.0",
  installer: "external",
  canApply: true,
  planToken: "abcdefghijklmnop",
  updateInFlight: false,
  mutationBoundMs: 900_000,
  servingPath: null,
  cliPath: "/bin/ocx",
};

it.effect("distinguishes known contracts from failures and legacy ocx", () =>
  Effect.sync(() => {
    expect(probeContracts({ code: 64, stdout: "" })).toEqual({
      kind: "known",
      contracts: new Set(),
    });
    expect(
      probeContracts({
        code: 0,
        stdout: JSON.stringify({ contracts: [OCX_CONTRACT.syncHomeFanout], extra: true }),
      }),
    ).toEqual({ kind: "known", contracts: new Set([OCX_CONTRACT.syncHomeFanout]) });
    expect(probeContracts({ code: 0, stdout: JSON.stringify({ contracts: [] }) })).toEqual({
      kind: "known",
      contracts: new Set(),
    });
    for (const value of [
      undefined,
      { code: 1, stdout: "" },
      { code: 0, stdout: "{" },
      { code: 0, stdout: '{"contracts":[1]}' },
      { code: 0, stdout: '{"contracts":[]}', timedOut: true },
    ])
      expect(probeContracts(value)).toEqual({ kind: "unknown" });
  }),
);

it.effect("requires complete bounded orchestrated plans", () =>
  Effect.sync(() => {
    expect(orchestratedPlanOf(JSON.stringify(plan)).kind).toBe("plan");
    for (const changes of [
      { planToken: undefined },
      { planToken: "bad" },
      { updateInFlight: undefined },
      { mutationBoundMs: undefined },
      { mutationBoundMs: 0 },
    ])
      expect(orchestratedPlanOf(JSON.stringify({ ...plan, ...changes })).kind).toBe("legacy");
    for (const value of [
      "{",
      JSON.stringify({ ...plan, schema: "other" }),
      JSON.stringify({ ...plan, cliPath: 1 }),
    ])
      expect(orchestratedPlanOf(value)).toEqual({ kind: "unknown" });
  }),
);

it.effect("classifies apply results conservatively and constructs bounded arguments", () =>
  Effect.sync(() => {
    const result = JSON.stringify({
      schema: "ocx.update.result/1",
      applied: true,
      toVersion: "1.1.0",
      healthy: true,
      rolledBack: false,
    });
    expect(applyOutcome(0, false, result, "1.1.0")).toBe("applied");
    expect(
      applyOutcome(0, false, result.replace('true,"toVersion"', 'false,"toVersion"'), "1.1.0"),
    ).toBe("applied");
    expect(applyOutcome(10, false, "", "1.1.0")).toBe("refused");
    expect(applyOutcome(11, false, "", "1.1.0")).toBe("rolled-back");
    expect(applyOutcome(0, true, result, "1.1.0")).toBe("uncertain");
    expect(applyOutcome(0, false, result, "1.2.0")).toBe("uncertain");
    expect(applyOutcome(0, false, "{", "1.1.0")).toBe("uncertain");
    expect(applyArgs("1.1.0", "abcdefghijklmnop", 123)).toEqual([
      "update",
      "--yes",
      "--json",
      "--version",
      "1.1.0",
      "--expect-plan",
      "abcdefghijklmnop",
      "--not-after",
      "123",
    ]);
    expect(planArgs("1.1.0")).toEqual(["update", "--plan", "--json", "--version", "1.1.0"]);
    expect(() => planArgs("1.1.0;bad")).toThrow();
  }),
);
