import { describe, expect, it } from "vite-plus/test";

import { type Arm, type RunRow, type TaskSet, gate, summarizeTask } from "./core.ts";
import { checkRows, requiredTasks } from "./rows.ts";

const arm = (id: string, mode: "full" | "core"): Arm => ({
  id,
  modelSelection: { instanceId: "codex", model: "m" },
  forbidTools: [],
  forbidItemTypes: [],
  listing: mode === "full" ? { mode } : { mode, resident: [] },
});
const arms = [arm("full", "full"), arm("core", "core")] as const;
const paired = { arms, candidateArm: "core", baselineArm: "full", gate: "listing" as const };
const row = (armId: "full" | "core", pair: number, extra: Partial<RunRow> = {}): RunRow => ({
  kind: "run",
  campaignId: "c1",
  taskSetVersion: 3,
  task: "multi",
  arm: armId,
  providerInstanceId: "codex",
  model: "m",
  listing: armId === "full" ? { mode: "full" } : { mode: "core", resident: [] },
  pair,
  slot: 0,
  threadId: armId + pair,
  ok: true,
  failures: [],
  contamination: [],
  metrics: {
    toolCalls: 2,
    toolRounds: 1,
    modelTurns: { min: 2, max: 3 },
    failedToolCalls: 0,
    failedCalls: [],
    subagents: 0,
    humanSteps: 0,
    resultBytes: 10,
    resultTruncated: false,
    violations: [],
  },
  wallMs: 1,
  at: "",
  ...extra,
});
const both = (campaignOf: (pair: number) => string) =>
  Array.from({ length: 10 }, (_, pair) => [
    row("full", pair, { campaignId: campaignOf(pair) }),
    row("core", pair, { campaignId: campaignOf(pair) }),
  ]).flat();

describe("checkRows", () => {
  it("refuses a verdict from rows of two campaigns, which were never paired", () => {
    expect(() =>
      checkRows(
        both((pair) => (pair < 5 ? "c1" : "c2")),
        paired,
      ),
    ).toThrow(/a verdict comes from one paired campaign/);
    expect(
      checkRows(
        both(() => "c1"),
        paired,
      ).campaignIds,
    ).toEqual(["c1"]);
  });

  it("lets a reference report pool campaigns of one arm", () => {
    const reference = { arms: [arms[0]] as const, candidateArm: null };
    const rows = [row("full", 0, { campaignId: "c1" }), row("full", 1, { campaignId: "c2" })];
    expect(checkRows(rows, reference).campaignIds).toEqual(["c1", "c2"]);
  });

  it("refuses the same run twice and a row that ran something its arm does not state", () => {
    const rows = both(() => "c1");
    expect(() => checkRows([...rows, rows[0]!], paired)).toThrow(/appears twice/);
    expect(() => checkRows([row("core", 0, { model: "other" })], paired)).toThrow(
      /did not run what arm core states/,
    );
  });
});

describe("requiredTasks", () => {
  it("keeps a listing verdict from passing when an automatic task has no rows", () => {
    const taskSet: TaskSet = {
      version: 3,
      tasks: [
        { id: "control", claim: "no_gain", manual: false } as TaskSet["tasks"][number],
        { id: "multi", claim: "reduces", manual: false } as TaskSet["tasks"][number],
        { id: "by-hand", claim: "reduces", manual: true } as TaskSet["tasks"][number],
      ],
    };
    const rows = both(() => "c1");
    const summaries = requiredTasks(taskSet, "listing").map((task) =>
      summarizeTask(task, rows, paired),
    );
    expect(summaries.map((summary) => [summary.task, summary.verdict])).toEqual([
      ["control", "not_run"],
      ["multi", "pass"],
    ]);
    expect(gate(summaries).pass).toBe(false);
  });
});
