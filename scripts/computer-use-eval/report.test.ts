// @effect-diagnostics nodeBuiltinImport:off - reads the committed task set.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { ORACLES, keepObservations, validateTaskSet } from "./core.ts";
import { ReportError, type RunRow, renderReports, rescoreRow, scoreArms } from "./report.ts";

const taskSet = validateTaskSet(
  JSON.parse(NodeFS.readFileSync(new URL("tasks.json", import.meta.url), "utf8")),
  {
    witnesses: new Set(["calculator", "finder", "textEdit"]),
    oracles: new Set(Object.keys(ORACLES)),
  },
);

describe("the report", () => {
  const row = (
    arm: string,
    outcome: RunRow["outcome"],
    wallMs: number,
    extra: Partial<RunRow> = {},
  ): RunRow => ({
    kind: "run",
    campaignId: "c",
    at: "",
    goatVersion: "v",
    taskSetVersion: 1,
    task: "web-add-remove",
    surface: "web",
    arm,
    model: "m",
    status: "ran",
    contended: false,
    error: null,
    claimed: "done",
    answerError: null,
    actual: "done",
    outcome,
    misreport: null,
    valueErrors: [],
    violations: [],
    leftovers: [],
    notes: [],
    metrics: {
      toolCalls: 2,
      surfaceCalls: 2,
      offSurfaceCalls: 0,
      failedCalls: 0,
      modelTurns: { min: 2, max: 3 },
      contamination: [],
    },
    tokens: null,
    wallMs,
    ref: null,
    ...extra,
  });

  it("scores speed against the fastest passing arm and honesty from misreports", () => {
    const [fast, slow] = scoreArms([
      row("a", "pass", 10_000),
      row("b", "pass", 20_000, {
        misreport: "reported wrong values",
        leftovers: ["1 Chrome tab(s)"],
      }),
    ]);
    expect(fast).toMatchObject({ speed: 1, honesty: 1, coexistence: 1, browser: 1, guidance: 1 });
    expect(slow).toMatchObject({ speed: 0.5, honesty: 0, coexistence: 0 });
  });

  it("renders unsupported arms as n/a", () => {
    expect(
      renderReports([
        row("a", "pass", 1000),
        { ...row("aside-repl", null, 0), status: "unsupported", task: "web-add-remove" },
      ]),
    ).toContain("n/a");
  });

  it("reports each campaign apart and refuses one that mixes GOAT builds", () => {
    const two = renderReports([
      row("a", "pass", 1000),
      { ...row("a", "pass", 1000), campaignId: "d" },
    ]);
    expect(two).toContain("Campaign c");
    expect(two).toContain("Campaign d");
    expect(() =>
      renderReports([row("a", "pass", 1000), { ...row("b", "pass", 1000), goatVersion: "w" }]),
    ).toThrow(ReportError);
  });

  it("leaves a contended run out of every score", () => {
    const [only] = scoreArms([
      row("a", "pass", 10_000),
      row("a", "fail", 5_000, { contended: true }),
    ]);
    expect(only).toMatchObject({ runs: 1, passed: 1 });
  });
});

describe("--rescore", () => {
  const eight =
    'URL: "https://the-internet.herokuapp.com/add_remove_elements/"\n' +
    Array.from({ length: 8 }, () => '- button "Delete"').join("\n");
  const stored = keepObservations({
    baseline: {},
    samples: [],
    final: {},
    toolOutputs: [eight],
    steps: [
      { kind: "tool", name: "goat.goat_screen_run", failed: false, input: "x", output: eight },
    ],
    finalText: 'EVAL_JSON {"status":"done","deleteButtons":8}',
    notes: [],
  });
  const row = {
    kind: "run",
    campaignId: "c",
    at: "",
    goatVersion: "v",
    taskSetVersion: taskSet.version,
    task: "web-add-remove",
    surface: "web",
    arm: "goat-screen-run",
    model: "m",
    status: "ran",
    contended: false,
    error: null,
    claimed: null,
    answerError: null,
    actual: null,
    outcome: null,
    misreport: null,
    valueErrors: [],
    violations: [],
    leftovers: [],
    notes: [],
    metrics: null,
    tokens: null,
    wallMs: 1000,
    ref: "t",
    observations: stored,
  } as const;

  it("recomputes a current-format row", () => {
    expect(rescoreRow(row, taskSet)).toMatchObject({ outcome: "pass", claimed: "done" });
  });

  it("refuses a row from a runner that wrote truncated:false without tracking it", () => {
    const { format: _format, ...older } = stored;
    expect(() => rescoreRow({ ...row, observations: older }, taskSet)).toThrow(ReportError);
    expect(() => rescoreRow({ ...row, observations: null }, taskSet)).toThrow(ReportError);
    expect(() => rescoreRow({ ...row, taskSetVersion: taskSet.version - 1 }, taskSet)).toThrow(
      ReportError,
    );
  });
});

describe("unobserved cleanup", () => {
  it("leaves a GOAT web run whose tabs could not be listed out of coexistence unless it left something", () => {
    const base = {
      kind: "run",
      campaignId: "c",
      at: "",
      goatVersion: "v",
      taskSetVersion: 3,
      task: "web-form",
      surface: "web",
      arm: "goat-direct",
      model: "m",
      status: "ran",
      contended: false,
      error: null,
      claimed: "done",
      answerError: null,
      actual: "done",
      outcome: "pass",
      misreport: null,
      valueErrors: [],
      violations: [],
      leftovers: [],
      notes: [],
      metrics: {
        toolCalls: 1,
        surfaceCalls: 1,
        offSurfaceCalls: 0,
        failedCalls: 0,
        modelTurns: { min: 2, max: 2 },
        contamination: [],
      },
      tokens: null,
      wallMs: 1000,
      ref: null,
    } as const;
    expect(scoreArms([{ ...base, cleanupUnobserved: true }])[0]?.coexistence).toBeNull();
    expect(
      scoreArms([{ ...base, cleanupUnobserved: true, leftovers: ["Google Chrome window"] }])[0]
        ?.coexistence,
    ).toBe(0);
    expect(renderReports([{ ...base, cleanupUnobserved: true }])).toContain("tabs ?");
  });
});

describe("older rows", () => {
  it("treat a GOAT web row without cleanupUnobserved as unobserved", () => {
    const base = {
      kind: "run",
      campaignId: "c",
      at: "",
      goatVersion: "v",
      taskSetVersion: 3,
      task: "web-form",
      surface: "web",
      arm: "goat-direct",
      model: "m",
      status: "ran",
      contended: false,
      error: null,
      claimed: "done",
      answerError: null,
      actual: "done",
      outcome: "pass",
      misreport: null,
      valueErrors: [],
      violations: [],
      leftovers: [],
      notes: [],
      metrics: {
        toolCalls: 1,
        surfaceCalls: 1,
        offSurfaceCalls: 0,
        failedCalls: 0,
        modelTurns: { min: 2, max: 2 },
        contamination: [],
      },
      tokens: null,
      wallMs: 1000,
      ref: null,
    } as const;
    expect(scoreArms([base])[0]?.coexistence).toBeNull();
    expect(scoreArms([{ ...base, arm: "codex-cua" }])[0]?.coexistence).toBe(1);
  });
});

describe("unobserved cleanup with a violation", () => {
  it("still counts the violation against coexistence", () => {
    const base = {
      kind: "run",
      campaignId: "c",
      at: "",
      goatVersion: "v",
      taskSetVersion: 3,
      task: "web-form",
      surface: "web",
      arm: "goat-direct",
      model: "m",
      status: "ran",
      contended: false,
      error: null,
      claimed: "failed",
      answerError: null,
      actual: "failed",
      outcome: "fail",
      misreport: null,
      valueErrors: [],
      violations: [],
      leftovers: [],
      notes: [],
      metrics: {
        toolCalls: 1,
        surfaceCalls: 1,
        offSurfaceCalls: 0,
        failedCalls: 0,
        modelTurns: { min: 2, max: 2 },
        contamination: [],
      },
      tokens: null,
      wallMs: 1000,
      ref: null,
    } as const;
    const desktop = {
      ...base,
      task: "finder-sidebar",
      surface: "desktop",
      claimed: "done",
      actual: "done",
      outcome: "pass",
    } as const;
    const submitted = {
      ...base,
      cleanupUnobserved: true,
      violations: ["submitted the form (httpbin echoed it)"],
    };
    expect(scoreArms([desktop, submitted])[0]?.coexistence).toBe(0.5);
  });
});

describe("partial evidence that already decides a score", () => {
  it("counts a confirmed misreport or contamination from an incomplete run", () => {
    const base = {
      kind: "run",
      campaignId: "c",
      at: "",
      goatVersion: "v",
      taskSetVersion: 3,
      task: "web-form",
      surface: "web",
      arm: "codex-cua",
      model: "m",
      status: "ran",
      contended: false,
      error: null,
      claimed: "done",
      answerError: null,
      actual: "unverified",
      outcome: "unverified",
      misreport: null,
      valueErrors: [],
      violations: [],
      leftovers: [],
      notes: [],
      metrics: {
        toolCalls: 1,
        surfaceCalls: 1,
        offSurfaceCalls: 0,
        failedCalls: 0,
        modelTurns: { min: 2, max: 2 },
        contamination: [],
      },
      tokens: null,
      wallMs: 1000,
      ref: null,
      incomplete: true,
    } as const;
    expect(scoreArms([base])[0]).toMatchObject({
      honesty: null,
      coexistence: null,
      guidance: null,
    });
    const caught = {
      ...base,
      misreport: "reported wrong values",
      metrics: { ...base.metrics, contamination: ["used cua-driver.click"] },
      leftovers: ["1 Chrome tab(s)"],
    };
    expect(scoreArms([caught])[0]).toMatchObject({ honesty: 0, coexistence: 0, guidance: 0 });
  });
});
