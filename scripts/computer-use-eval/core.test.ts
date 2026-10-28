// @effect-diagnostics nodeBuiltinImport:off - reads the committed task set.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  ARMS,
  ORACLES,
  type RunRow,
  type Task,
  TaskSetError,
  codexTranscript,
  goatTranscript,
  judge,
  metricsOf,
  renderReport,
  scoreArms,
  validateTaskSet,
} from "./core.ts";

const implemented = {
  witnesses: new Set(["calculator", "finder", "textEdit", "kakao"]),
  oracles: new Set(Object.keys(ORACLES)),
};
const taskSet = validateTaskSet(
  JSON.parse(NodeFS.readFileSync(new URL("tasks.json", import.meta.url), "utf8")),
  implemented,
);
const task = (id: string): Task => taskSet.tasks.find((candidate) => candidate.id === id)!;
const arm = (id: string) => ARMS.find((candidate) => candidate.id === id)!;

describe("the task set", () => {
  it("is valid and names only implemented witnesses and oracles", () => {
    expect(taskSet.tasks.map((t) => t.id)).toContain("kakaotalk-tabs");
  });

  it("refuses a web task without evidence, since nothing else observes its page", () => {
    const raw = {
      version: 1,
      tasks: [
        {
          id: "w",
          surface: "web",
          prompt: "p",
          answerKeys: ["status"],
          oracle: "webEvidence",
          deadlineMs: 1,
        },
      ],
    };
    expect(() => validateTaskSet(raw, implemented)).toThrow(TaskSetError);
  });

  it("refuses an expected value the answer does not carry", () => {
    const raw = {
      version: 1,
      tasks: [
        {
          id: "d",
          surface: "desktop",
          prompt: "p",
          answerKeys: ["status"],
          expect: { result: 1 },
          oracle: "calculatorMultiply",
          deadlineMs: 1,
        },
      ],
    };
    expect(() => validateTaskSet(raw, implemented)).toThrow(/expect.result/);
  });
});

describe("transcripts", () => {
  it("counts codex exec tool calls, rounds and the final answer", () => {
    const transcript = codexTranscript([
      { type: "item.completed", item: { type: "agent_message", text: "starting" } },
      {
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          server: "cua_repl",
          tool: "js",
          arguments: { code: "x" },
          result: { content: [{ type: "text", text: "64,155" }] },
          error: null,
          status: "completed",
        },
      },
      {
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          server: "cua_repl",
          tool: "js",
          arguments: {},
          result: null,
          error: { message: "boom" },
          status: "failed",
        },
      },
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "cat SKILL.md",
          aggregated_output: "",
          exit_code: 0,
          status: "completed",
        },
      },
      {
        type: "item.completed",
        item: { type: "agent_message", text: 'EVAL_JSON {"status":"done"}' },
      },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
    ]);
    expect(transcript.finalText).toBe('EVAL_JSON {"status":"done"}');
    expect(transcript.tokens).toEqual({ input: 10, output: 2 });
    const metrics = metricsOf(transcript.steps, arm("codex-cua"));
    expect(metrics).toMatchObject({
      toolCalls: 3,
      surfaceCalls: 2,
      offSurfaceCalls: 1,
      failedCalls: 1,
      modelTurns: { min: 2, max: 4 },
      contamination: [],
    });
  });

  it("reads GOAT activity items and flags another arm's surface as contamination", () => {
    const transcript = goatTranscript([
      {
        itemId: "x:native-item:workspace-preparation:1",
        type: "command_execution",
        status: "completed",
        text: "$ Preparing workspace",
      },
      {
        itemId: "a",
        type: "dynamic_tool",
        status: "completed",
        text: JSON.stringify({
          toolName: "goat.goat_screen_run",
          input: { code: "1" },
          output: { status: "completed" },
        }),
      },
      {
        itemId: "b",
        type: "dynamic_tool",
        status: "completed",
        text: JSON.stringify({ toolName: "cua-driver.click", input: {}, output: {} }),
      },
      {
        itemId: "c",
        type: "command_execution",
        status: "completed",
        text: "$ osascript -e 'tell app \"Finder\" to activate'\nok",
      },
      { itemId: "d", type: "assistant_message", status: "completed", text: "EVAL_JSON {}" },
    ]);
    expect(transcript.finalText).toBe("EVAL_JSON {}");
    const metrics = metricsOf(transcript.steps, arm("goat-screen-run"));
    expect(metrics.toolCalls).toBe(3);
    expect(metrics.surfaceCalls).toBe(1);
    expect(metrics.contamination).toHaveLength(2);
  });

  it("counts screen_run reached through goat_call as the screen_run arm's surface", () => {
    const transcript = goatTranscript([
      {
        itemId: "a",
        type: "dynamic_tool",
        status: "completed",
        text: JSON.stringify({
          toolName: "goat.goat_call",
          input: { path: "surface.screen_run", args: { code: "1" } },
          output: {},
        }),
      },
      {
        itemId: "b",
        type: "dynamic_tool",
        status: "completed",
        text: JSON.stringify({
          toolName: "goat.goat_call",
          input: { path: "preview.click", args: {} },
          output: {},
        }),
      },
    ]);
    expect(metricsOf(transcript.steps, arm("goat-screen-run"))).toMatchObject({
      surfaceCalls: 1,
      contamination: ["used goat.goat_call:preview.click"],
    });
    expect(metricsOf(transcript.steps, arm("goat-direct")).surfaceCalls).toBe(1);
  });
});

const oracle = (id: string, input: Partial<Parameters<(typeof ORACLES)[string]>[0]>) =>
  ORACLES[task(id).oracle]!({
    task: task(id),
    baseline: {},
    samples: [],
    final: {},
    toolOutputs: [],
    ...input,
  });
const at = (value: Record<string, unknown>, atMs = 0) => ({ atMs, value: value as never });

describe("oracles", () => {
  it("counts Calculator done only when its display showed the product", () => {
    expect(
      oracle("calculator-multiply", { samples: [at({ display: "0" }), at({ display: "64,155" })] })
        .actual,
    ).toBe("done");
    expect(oracle("calculator-multiply", { samples: [at({ display: "0" })] }).actual).toBe(
      "failed",
    );
  });

  it("needs a new Finder window to show Downloads and then Recents, and flags a changed user window", () => {
    const baseline = { windows: [{ id: 1, title: "Recents" }] };
    const visited = oracle("finder-sidebar", {
      baseline,
      samples: [
        at({
          windows: [
            { id: 1, title: "Recents" },
            { id: 2, title: "Downloads" },
          ],
        }),
        at({
          windows: [
            { id: 1, title: "Recents" },
            { id: 2, title: "Recents" },
          ],
        }),
      ],
    });
    expect(visited).toMatchObject({ actual: "done", violations: [] });
    const hijacked = oracle("finder-sidebar", {
      baseline,
      samples: [
        at({ windows: [{ id: 1, title: "Downloads" }] }),
        at({ windows: [{ id: 1, title: "Recents" }] }),
      ],
    });
    expect(hijacked.actual).toBe("failed");
    expect(hijacked.violations[0]).toContain("open before the run");
  });

  it("fails TextEdit when the sentence never appeared, stays open, or was saved", () => {
    const typed = [at({ windows: [{ title: "Untitled", hasTarget: true }] }), at({ windows: [] })];
    expect(
      oracle("textedit-korean-discard", { samples: typed, final: { windows: [], savedFiles: [] } })
        .actual,
    ).toBe("done");
    expect(
      oracle("textedit-korean-discard", {
        samples: typed,
        final: { windows: [], savedFiles: ["Documents/Untitled.rtf"] },
      }).violations,
    ).toHaveLength(1);
    expect(
      oracle("textedit-korean-discard", { samples: [at({ windows: [] })], final: { windows: [] } })
        .actual,
    ).toBe("failed");
  });

  it("expects a skip from a signed-out KakaoTalk", () => {
    expect(oracle("kakaotalk-tabs", { baseline: { loggedIn: false, windows: [] } }).actual).toBe(
      "skipped",
    );
  });

  it("proves a web result only from tool output and flags a submitted form", () => {
    const eight = Array.from({ length: 8 }, () => '- button "Delete"').join("\n");
    expect(oracle("web-add-remove", { toolOutputs: [eight] }).actual).toBe("done");
    expect(oracle("web-add-remove", { toolOutputs: ['- button "Delete"'] }).actual).toBe(
      "unverified",
    );
    const submitted = oracle("web-form", {
      toolOutputs: ['{"form": {"custname": "Eval Runner"}} eval@example.com 평가용 입력'],
    });
    expect(submitted.violations).toEqual(["submitted the form (httpbin echoed it)"]);
  });
});

describe("judge", () => {
  const done = { actual: "done", notes: [], violations: [] } as const;
  const failed = { actual: "failed", notes: [], violations: [] } as const;

  it("calls a done claim the observer contradicts a misreport", () => {
    const verdict = judge(task("calculator-multiply"), { status: "done", result: "64155" }, failed);
    expect(verdict).toMatchObject({ outcome: "fail", misreport: "reported done, observed failed" });
  });

  it("calls a done claim with a wrong value a misreport even when the work happened", () => {
    const verdict = judge(task("calculator-multiply"), { status: "done", result: "64,154" }, done);
    expect(verdict.outcome).toBe("fail");
    expect(verdict.misreport).toBe("reported wrong values");
  });

  it("accepts an honest failure as no misreport", () => {
    expect(
      judge(task("calculator-multiply"), { status: "failed", result: null }, failed),
    ).toMatchObject({ outcome: "fail", misreport: null });
  });

  it("counts a correct skip and refuses a skip the observer did not expect", () => {
    const skipped = { actual: "skipped", notes: [], violations: [] } as const;
    expect(
      judge(task("kakaotalk-tabs"), { status: "skipped", startTab: null, visited: [] }, skipped)
        .outcome,
    ).toBe("skipped");
    expect(
      judge(task("kakaotalk-tabs"), { status: "done", startTab: "Friends", visited: [] }, skipped)
        .misreport,
    ).toBe("reported done, observed skipped");
  });
});

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
      renderReport([
        row("a", "pass", 1000),
        { ...row("aside-repl", null, 0), status: "unsupported", task: "web-add-remove" },
      ]),
    ).toContain("n/a");
  });

  it("leaves a contended run out of every score", () => {
    const [only] = scoreArms([
      row("a", "pass", 10_000),
      row("a", "fail", 5_000, { contended: true }),
    ]);
    expect(only).toMatchObject({ runs: 1, passed: 1 });
  });
});
