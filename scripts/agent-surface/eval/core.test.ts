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
  listingMatches,
  nextUncountedRun,
  runMetrics,
  sameModel,
  schedule,
  sumMetrics,
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
  listing: null,
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
const coreArm: Arm = {
  id: "core+report",
  modelSelection: { instanceId: "i", model: "m" },
  forbidTools: [],
  forbidItemTypes: [],
  listing: { mode: "core", resident: ["goat_origin_report"] },
};

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

  it("runs a one-arm campaign as a baseline, one run per pair", () => {
    const taskSet = validateTaskSet(readJson("./tasks.json"), {
      fixtures: anyName,
      checks: anyName,
    });
    const example = readJson("./campaign.example.json") as Record<string, unknown>;
    const campaign = validateCampaign(
      {
        ...example,
        gate: "listing",
        arms: [{ ...coreArm, listing: { mode: "full" } }],
        baselineArm: "core+report",
        candidateArm: undefined,
      },
      taskSet,
      taskSet.tasks,
    );
    const steps = schedule([taskSet.tasks[0]!], campaign);
    expect(steps.map((step) => [step.pair, step.slot])).toEqual(
      Array.from({ length: campaign.pairs }, (_, pair) => [pair, 0]),
    );
    expect(() => validateCampaign({ ...example, gate: "listing" }, taskSet, taskSet.tasks)).toThrow(
      /a listing campaign states each arm's listing/,
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

  it("marks a core arm that called a GOAT tool its listing does not serve", () => {
    const metrics = runMetrics(
      [
        tool("goat.goat_describe"),
        tool("mcp__goat__goat_call"),
        tool("goat.goat_origin_report"),
        tool("other.read_file"),
        tool("mcp__goat__goat_thread_read"),
      ],
      coreArm,
    );
    expect(metrics.violations).toEqual([
      "mcp__goat__goat_thread_read is not in arm core+report's core listing",
    ]);
  });

  it("counts result bytes as the compact result, not the pretty-printed activity text", () => {
    const output = { thread: { title: "Quarterly retro notes" } };
    const text = JSON.stringify({ toolName: "goat.goat_thread_read", input: {}, output }, null, 2);
    expect(runMetrics([item("dynamic_tool", text)], callOnly).resultBytes).toBe(
      JSON.stringify(output).length,
    );
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
    ({ modelTurns: { min, max }, toolCalls: max - 1, failedToolCalls: 0 }) as RunMetrics;
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
    providerInstanceId: "i",
    model: "m",
    listing: null,
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

  it("passes only when the candidate's most turns are a third below the baseline's fewest", () => {
    const passing = [...runs("call-only", [9, 12]), ...runs("eval", [4, 6])];
    expect(summarizeTask(task, passing, arms).verdict).toBe("pass");
    // Both ends fell by a third, but the true counts could be 6 and 6.
    const overlapping = [...runs("call-only", [6, 9]), ...runs("eval", [4, 6])];
    expect(summarizeTask(task, overlapping, arms).reasons).toEqual([
      "the candidate's most turns are not a third below the baseline's fewest",
    ]);
  });

  it("needs ten successful runs per arm, not ten attempts", () => {
    const mostlyFailed = (arm: string, turns: [number, number]) =>
      Array.from({ length: 10 }, (_, pair) =>
        row(arm, pair, turns, pair === 0 ? {} : { ok: false, failures: ["oracle"] }),
      );
    const rows = [...mostlyFailed("call-only", [9, 12]), ...mostlyFailed("eval", [4, 6])];
    expect(summarizeTask(task, rows, arms).reasons).toEqual([
      "fewer than 10 successful clean runs in an arm",
    ]);
  });

  it("keeps failed runs in the rate and out of the medians, and drops contaminated runs", () => {
    const rows = [
      ...runs("call-only", [9, 12]),
      ...runs("eval", [4, 6]),
      row("eval", 10, [1, 1], { ok: false, failures: ["oracle"] }),
      row("eval", 11, [1, 1], { contamination: ["goat_eval in call-only"] }),
    ];
    const summary = summarizeTask(task, rows, arms);
    expect(summary.candidate).toMatchObject({ clean: 11, failed: 1, contaminated: 1, turnsMin: 4 });
    expect(summary.reasons).toEqual(["the candidate failed more often"]);
    expect(gate([summary]).pass).toBe(false);
  });

  it("fails the gate when the control moved", () => {
    const reduces = summarizeTask(
      task,
      [...runs("call-only", [9, 12]), ...runs("eval", [4, 6])],
      arms,
    );
    const control = { id: "t", claim: "no_gain" } as Task;
    const moved = summarizeTask(
      control,
      [...runs("call-only", [9, 12]), ...runs("eval", [4, 6])],
      arms,
    );
    const flat = summarizeTask(
      control,
      [...runs("call-only", [2, 2]), ...runs("eval", [2, 2])],
      arms,
    );
    expect(gate([reduces, moved])).toEqual({ pass: false, notPassed: ["t: suspect"] });
    expect(gate([reduces, flat]).pass).toBe(true);
  });

  it("reports a one-arm campaign without a verdict", () => {
    const summary = summarizeTask(task, runs("call-only", [3, 4]), {
      baselineArm: "call-only",
      candidateArm: null,
    });
    expect(summary).toMatchObject({ verdict: "baseline_only", candidate: null });
    expect(gate([summary]).pass).toBe(false);
  });

  describe("on a listing campaign", () => {
    const listing = { ...arms, gate: "listing" as const };
    const control = { id: "t", claim: "no_gain" } as Task;

    it("lets the control rise by one turn at each end and no more", () => {
      const verdict = (turns: [number, number]) =>
        summarizeTask(control, [...runs("call-only", [2, 2]), ...runs("eval", turns)], listing);
      expect(verdict([3, 3]).verdict).toBe("as_expected");
      expect(verdict([2, 4]).reasons).toEqual(["the candidate's median turns rose by more than 1"]);
    });

    it("fails a multi-step task whose median turns or failures rose", () => {
      const compare = (candidate: ReadonlyArray<RunRow>) =>
        summarizeTask(task, [...runs("call-only", [4, 6]), ...candidate], listing);
      expect(compare(runs("eval", [4, 6])).verdict).toBe("pass");
      expect(compare(runs("eval", [5, 6])).reasons).toEqual(["the candidate's median turns rose"]);
      const oneFailed = [
        ...runs("eval", [4, 6]),
        row("eval", 10, [4, 6], { ok: false, failures: ["oracle"] }),
      ];
      expect(compare(oneFailed).reasons).toEqual(["the candidate failed more often"]);
    });
  });
});

describe("sameModel", () => {
  const ran = { instanceId: "codex", model: "command-code/deepseek-deepseek-v4.1-flash-fast" };

  it("accepts the instance / model form the prompt lists, the joined form, and the bare id", () => {
    for (const reported of [
      "codex / command-code/deepseek-deepseek-v4.1-flash-fast",
      "codex/command-code/deepseek-deepseek-v4.1-flash-fast",
      "command-code/deepseek-deepseek-v4.1-flash-fast",
    ])
      expect(sameModel(reported, ran)).toBe(true);
  });

  it("rejects another instance or model", () => {
    expect(sameModel("claudeAgent / command-code/deepseek-deepseek-v4.1-flash-fast", ran)).toBe(
      false,
    );
    expect(sameModel("codex / gpt-6-luna", ran)).toBe(false);
  });
});

describe("failed calls", () => {
  it("records the tool, error code, and message of each failed call", () => {
    const failed = {
      ...item(
        "dynamic_tool",
        JSON.stringify({
          toolName: "goat.goat_thread_list",
          input: { search: "fx", message: "the call's own input" },
          output: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  _tag: "OrchestratorMcpFailure",
                  code: "invalid_request",
                  message: "goat_thread_list does not take search, so nothing ran.",
                }),
              },
            ],
          },
        }),
      ),
      status: "failed",
    };
    expect(runMetrics([failed], callOnly).failedCalls).toEqual([
      {
        tool: "goat.goat_thread_list",
        code: "invalid_request",
        reason: "goat_thread_list does not take search, so nothing ran.",
      },
    ]);
  });
});

describe("a run that answers in a follow-up run", () => {
  it("costs every counted run", () => {
    const launched = runMetrics(
      [item("user_message"), tool("goat.delegate_task"), item("assistant_message")],
      callOnly,
    );
    const followUp = runMetrics(
      [
        item("notification"),
        tool("goat.task_status"),
        tool("goat.task_status"),
        item("assistant_message"),
      ],
      callOnly,
    );
    expect(sumMetrics([launched, followUp])).toMatchObject({
      toolCalls: 3,
      modelTurns: { min: 4, max: 5 },
    });
  });
});

describe("listingMatches", () => {
  const meta = ["goat_describe", "goat_call"];
  const withLaunch = { mode: "core" as const, resident: ["goat_thread_launch"] };

  it("takes a core listing only when it is exactly the core tools and the arm's residents", () => {
    expect(listingMatches(withLaunch, [...meta, "goat_thread_launch"], [])).toBe(true);
    // Plain core passing for core plus a resident would measure the wrong arm.
    expect(listingMatches(withLaunch, meta, [])).toBe(false);
    expect(
      listingMatches(withLaunch, [...meta, "goat_thread_launch", "goat_thread_read"], []),
    ).toBe(false);
  });

  it("takes a full listing only when it holds more than any core arm of the campaign lists", () => {
    const residents = ["goat_thread_launch"];
    expect(listingMatches({ mode: "full" }, [...meta, "goat_thread_launch"], residents)).toBe(
      false,
    );
    expect(
      listingMatches(
        { mode: "full" },
        [...meta, "goat_thread_launch", "goat_thread_read"],
        residents,
      ),
    ).toBe(true);
  });
});

describe("nextUncountedRun", () => {
  it("takes the earliest uncounted run when two ended between looks", () => {
    const runs = [
      { runId: "run-3", ordinal: 3 },
      { runId: "run-1", ordinal: 1 },
      { runId: "run-2", ordinal: 2 },
    ];
    expect(nextUncountedRun(runs, new Set(["run-1"]))).toBe("run-2");
    expect(nextUncountedRun(runs, new Set(["run-1", "run-2", "run-3"]))).toBeNull();
  });
});
