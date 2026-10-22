// @effect-diagnostics nodeBuiltinImport:off - reads the committed task set and example campaign.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  type Arm,
  CampaignError,
  type RunMetrics,
  type RunRow,
  type Task,
  type TimelineItem,
  extractAnswer,
  gate,
  runMetrics,
  schedule,
  summarizeTask,
  validateCampaign,
  validateTaskSet,
} from "./core.ts";

const readJson = (name: string): unknown =>
  JSON.parse(NodeFS.readFileSync(new URL(name, import.meta.url), "utf8"));
const anyName = { has: () => true } as unknown as ReadonlySet<string>;
const callOnly: Arm = {
  id: "call-only",
  modelSelection: { instanceId: "i", model: "m" },
  forbidTools: ["goat_eval"],
  forbidItemTypes: ["command_execution"],
};
const item = (
  type: string,
  text: string | null = null,
  itemId = "turn-item:" + type,
): TimelineItem => ({
  itemId,
  type,
  status: "completed",
  text,
  textTruncated: false,
});
const tool = (name: string) => item("dynamic_tool", JSON.stringify({ toolName: name, input: {} }));

describe("the committed task set", () => {
  it("validates with the example campaign and alternates who goes first", () => {
    const taskSet = validateTaskSet(readJson("./tasks.json"), {
      fixtures: anyName,
      checks: anyName,
    });
    const campaign = validateCampaign(readJson("./campaign.example.json"), taskSet, taskSet.tasks);
    const steps = schedule(taskSet.tasks, campaign);
    for (const task of taskSet.tasks) {
      const leads = steps.filter((step) => step.taskId === task.id && step.slot === 0);
      expect(leads.filter((step) => step.armId === "call-only")).toHaveLength(campaign.pairs / 2);
    }
  });

  it("refuses an automatic task whose check the runner cannot evaluate", () => {
    const raw = readJson("./tasks.json");
    expect(() =>
      validateTaskSet(raw, { fixtures: anyName, checks: new Set(["answerTitle"]) }),
    ).toThrow(/wait-running: no implementation for answerMatchesFixtureThreads/);
  });

  it("refuses a set without a control", () => {
    const raw = readJson("./tasks.json") as { version: number; tasks: Array<Task> };
    const withoutControl = { ...raw, tasks: raw.tasks.filter((task) => task.claim !== "no_gain") };
    expect(() => validateTaskSet(withoutControl, { fixtures: anyName, checks: anyName })).toThrow(
      CampaignError,
    );
  });
});

describe("runMetrics", () => {
  it("bounds model turns by tool rounds and tool calls", () => {
    const metrics = runMetrics(
      [
        item("user_message"),
        item(
          "command_execution",
          "$ Preparing workspace",
          "turn-item:provider:x:native-item:workspace-preparation:run",
        ),
        tool("goat.goat_thread_list"),
        tool("goat.goat_thread_wait"),
        item("assistant_message"),
        tool("goat.goat_thread_wait"),
        item("subagent"),
        item("assistant_message"),
      ],
      callOnly,
    );
    expect(metrics).toMatchObject({
      toolCalls: 3,
      toolRounds: 2,
      modelTurns: { min: 3, max: 4 },
      subagents: 1,
      violations: [],
    });
  });

  it("marks a run that used what its arm forbids, or something it cannot classify", () => {
    const metrics = runMetrics(
      [
        tool("goat.goat_eval"),
        item("dynamic_tool", "{}"),
        item("command_execution"),
        item("new_kind"),
      ],
      callOnly,
    );
    expect(metrics.violations).toEqual([
      "goat.goat_eval is not available to arm call-only",
      "a tool call with no readable name",
      "command_execution is not available to arm call-only",
      "unclassified item type new_kind",
    ]);
  });
});

describe("extractAnswer", () => {
  it("takes exactly one EVAL_JSON line and accepts falsy values", () => {
    expect(extractAnswer('done\nEVAL_JSON {"count":0,"ready":false}', ["count", "ready"])).toEqual({
      ok: true,
      value: { count: 0, ready: false },
    });
    expect(extractAnswer("EVAL_JSON {}\nEVAL_JSON {}", ["a"]).ok).toBe(false);
    expect(extractAnswer('EVAL_JSON {"a":1}', ["a", "b"])).toEqual({
      ok: false,
      why: "the answer has no b",
    });
  });
});

describe("summarizeTask", () => {
  const task = { id: "t", claim: "reduces" } as Task;
  const arms = { baselineArm: "call-only", candidateArm: "eval" };
  const metrics = (min: number, max: number) =>
    ({ modelTurns: { min, max }, toolCalls: max - 1 }) as RunMetrics;
  const row = (
    arm: string,
    pair: number,
    turns: [number, number],
    extra: Partial<RunRow> = {},
  ): RunRow => ({
    kind: "run",
    campaignId: "c",
    taskSetVersion: 1,
    task: "t",
    arm,
    pair,
    slot: pair % 2 === (arm === "eval" ? 1 : 0) ? 0 : 1,
    threadId: null,
    ok: true,
    failures: [],
    contamination: [],
    metrics: metrics(...turns),
    wallMs: null,
    at: "",
    ...extra,
  });
  const runs = (arm: string, turns: [number, number]) =>
    Array.from({ length: 10 }, (_, pair) => row(arm, pair, turns));

  it("passes only when both bounds fall by a third and failures do not rise", () => {
    const passing = [...runs("call-only", [6, 9]), ...runs("eval", [4, 6])];
    expect(summarizeTask(task, passing, arms).verdict).toBe("pass");
    const upperOnly = [...runs("call-only", [6, 9]), ...runs("eval", [5, 6])];
    expect(summarizeTask(task, upperOnly, arms).reasons).toEqual([
      "model turns did not fall by a third at both bounds",
    ]);
  });

  it("keeps failed runs in the rate and out of the medians, and drops contaminated runs", () => {
    const rows = [
      ...runs("call-only", [6, 9]),
      ...runs("eval", [4, 6]),
      row("eval", 10, [1, 1], { ok: false, failures: ["oracle"] }),
      row("eval", 11, [1, 1], { contamination: ["goat_eval in call-only"] }),
    ];
    const summary = summarizeTask(task, rows, arms);
    expect(summary.candidate).toMatchObject({ clean: 11, failed: 1, contaminated: 1, turnsMin: 4 });
    expect(summary.reasons).toEqual(["the candidate failed more often"]);
    expect(gate([summary]).pass).toBe(false);
  });
});
