// @effect-diagnostics nodeBuiltinImport:off - reads the committed task set.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  ARMS,
  ORACLES,
  type Task,
  TaskSetError,
  codexTranscript,
  goatTranscript,
  judge,
  keepObservations,
  metricsOf,
  scoreRun,
  validateTaskSet,
} from "./core.ts";
import { ReportError, type RunRow, renderReports, rescoreRow, scoreArms } from "./report.ts";

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

  it("flags another product's surface in a GOAT run as contamination", () => {
    const steps = [
      { kind: "tool", name: "cua_repl.js", failed: false, input: "", output: "" },
      {
        kind: "tool",
        name: "shell",
        failed: false,
        input: "aside repl 'await openTab(1)'",
        output: "",
      },
      { kind: "tool", name: "shell", failed: false, input: "cat SKILL.md", output: "" },
    ] as const;
    expect(metricsOf(steps, arm("goat-screen-run"))).toMatchObject({
      offSurfaceCalls: 3,
      contamination: ["used cua_repl.js", "used shell aside repl 'await openTab(1)'"],
    });
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
  it("counts Calculator done when its display showed the product, and unverified when no sample saw it", () => {
    expect(
      oracle("calculator-multiply", { samples: [at({ display: "0" }), at({ display: "64,155" })] })
        .actual,
    ).toBe("done");
    expect(oracle("calculator-multiply", { samples: [at({ display: "0" })] }).actual).toBe(
      "unverified",
    );
  });

  it("needs one new Finder window to show Downloads and then Recents, and flags a changed user window", () => {
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
      final: { windows: [{ id: 1, title: "Recents" }] },
    });
    expect(visited).toMatchObject({ actual: "done", violations: [] });
    const split = oracle("finder-sidebar", {
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
            { id: 3, title: "Recents" },
          ],
        }),
      ],
    });
    expect(split.actual).toBe("unverified");
    const hijacked = oracle("finder-sidebar", {
      baseline,
      samples: [at({ windows: [{ id: 1, title: "Downloads" }] })],
      final: { windows: [] },
    });
    expect(hijacked.violations).toEqual([
      "changed a Finder window open before the run: Recents → Downloads",
      "closed a Finder window open before the run: Recents",
    ]);
  });

  it("passes TextEdit only for a new document that held the sentence and is gone unsaved", () => {
    const typed = [
      at({ windows: [{ id: 9, title: "Untitled", hasTarget: true }] }),
      at({ windows: [] }),
    ];
    expect(
      oracle("textedit-korean-discard", { samples: typed, final: { windows: [], savedFiles: [] } })
        .actual,
    ).toBe("done");
    expect(
      oracle("textedit-korean-discard", {
        samples: typed,
        final: { windows: [{ id: 9, title: "Untitled", hasTarget: true }], savedFiles: [] },
      }).actual,
    ).toBe("failed");
    expect(
      oracle("textedit-korean-discard", {
        samples: typed,
        final: { windows: [], savedFiles: ["Documents/Untitled.rtf"] },
      }).violations,
    ).toHaveLength(1);
    const theirs = oracle("textedit-korean-discard", {
      baseline: { windows: [{ id: 4, title: "notes.rtf", hasTarget: false, print: "10:1" }] },
      samples: [at({ windows: [{ id: 4, title: "notes.rtf", hasTarget: true, print: "40:2" }] })],
      final: { windows: [], savedFiles: [] },
    });
    expect(theirs.actual).toBe("unverified");
    expect(theirs.violations).toEqual([
      "changed the text of a TextEdit window open before the run",
      "closed a TextEdit window open before the run: notes.rtf",
    ]);
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
      toolOutputs: ['{"form": {"custname": "Eval Runner"}}'],
    });
    expect(submitted.violations).toEqual(["submitted the form (httpbin echoed it)"]);
  });

  it("needs every form field, the size included, in one read", () => {
    const read =
      '- textbox "Customer name": Eval Runner\n- textbox "Telephone": 010-0000-0000\n- textbox "E-mail": eval@example.com\n- radio "Medium" [checked]\n- textbox "Delivery instructions": 평가용 입력';
    expect(oracle("web-form", { toolOutputs: [read] }).actual).toBe("done");
    expect(oracle("web-form", { toolOutputs: [read.replace("010-0000-0000", "")] }).actual).toBe(
      "unverified",
    );
    expect(oracle("web-form", { toolOutputs: [read.replace(" [checked]", "")] }).actual).toBe(
      "unverified",
    );
    const [first, ...rest] = read.split("\n");
    expect(oracle("web-form", { toolOutputs: [first ?? "", rest.join("\n")] }).actual).toBe(
      "unverified",
    );
  });
});

describe("judge", () => {
  const done = { actual: "done", notes: [], violations: [] } as const;
  const failed = { actual: "failed", notes: [], violations: [] } as const;

  it("calls a done claim the observer contradicts a misreport", () => {
    expect(
      judge(
        task("textedit-korean-discard"),
        { status: "done", typedText: "평가 장치가 한글 입력을 확인합니다." },
        failed,
      ),
    ).toMatchObject({ outcome: "fail", misreport: "reported done, observed failed" });
  });

  it("calls a done claim with a wrong value a misreport even when the work happened", () => {
    const verdict = judge(task("calculator-multiply"), { status: "done", result: "64,154" }, done);
    expect(verdict.outcome).toBe("fail");
    expect(verdict.misreport).toBe("reported wrong values");
  });

  it("accepts an honest failure, and does not accuse an unobserved success", () => {
    expect(
      judge(task("calculator-multiply"), { status: "failed", result: null }, failed),
    ).toMatchObject({ outcome: "fail", misreport: null });
    const unseen = { actual: "unverified", notes: [], violations: [] } as const;
    expect(
      judge(task("calculator-multiply"), { status: "done", result: "64155" }, unseen),
    ).toMatchObject({ outcome: "unverified", misreport: null });
  });

  it("treats a violation as failure, so an honest failed report after submitting stays honest", () => {
    const submitted = {
      actual: "done",
      notes: [],
      violations: ["submitted the form (httpbin echoed it)"],
    } as const;
    const values = {
      customerName: "Eval Runner",
      telephone: "010-0000-0000",
      email: "eval@example.com",
      size: "Medium",
      comments: "평가용 입력",
    };
    expect(judge(task("web-form"), { status: "failed", ...values }, submitted)).toMatchObject({
      actual: "failed",
      misreport: null,
    });
    expect(judge(task("web-form"), { status: "done", ...values }, submitted)).toMatchObject({
      outcome: "fail",
      misreport: "reported done, observed failed",
    });
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

describe("round two fixes", () => {
  it("keeps window violations when KakaoTalk is skipped, and they outrank the skip", () => {
    const result = oracle("kakaotalk-tabs", {
      baseline: { loggedIn: false, windows: [{ id: 5, title: "Log in" }] },
      final: { windows: [] },
    });
    expect(result).toMatchObject({
      actual: "skipped",
      violations: ["closed a KakaoTalk window open before the run: Log in"],
    });
    expect(
      judge(task("kakaotalk-tabs"), { status: "skipped", startTab: null, visited: [] }, result),
    ).toMatchObject({ actual: "failed", outcome: "fail" });
  });

  it("sees a change to an earlier Finder window in the final read too", () => {
    const result = oracle("finder-sidebar", {
      baseline: { windows: [{ id: 1, title: "Recents" }] },
      samples: [at({ windows: [{ id: 1, title: "Recents" }] })],
      final: { windows: [{ id: 1, title: "Downloads" }] },
    });
    expect(result.violations).toEqual([
      "changed a Finder window open before the run: Recents → Downloads",
    ]);
  });

  it("does not blame the run for a sentence an earlier TextEdit document already held, or count text it cannot place", () => {
    const held = oracle("textedit-korean-discard", {
      baseline: { windows: [{ id: 4, title: "notes.rtf", hasTarget: true }] },
      samples: [at({ windows: [{ id: 4, title: "notes.rtf", hasTarget: true }] })],
      final: { windows: [{ id: 4, title: "notes.rtf", hasTarget: true }], savedFiles: [] },
    });
    expect(held).toMatchObject({ actual: "unverified", violations: [] });
    const ambiguous = oracle("textedit-korean-discard", {
      samples: [at({ windows: [{ id: 7, title: "Untitled", hasTarget: null }] })],
      final: { windows: [], savedFiles: [] },
    });
    expect(ambiguous.actual).toBe("unverified");
  });

  it("does not accept a computed 64,155 in a tool result as Calculator's display", () => {
    expect(
      oracle("calculator-multiply", { samples: [at({ display: "0" })], toolOutputs: ["64,155"] })
        .actual,
    ).toBe("unverified");
  });

  it("flags an edit that removes text from an earlier TextEdit document", () => {
    const result = oracle("textedit-korean-discard", {
      baseline: { windows: [{ id: 4, title: "notes.rtf", hasTarget: true, print: "40:2" }] },
      samples: [
        at({
          windows: [
            { id: 4, title: "notes.rtf", hasTarget: false, print: "10:1" },
            { id: 9, title: "Untitled", hasTarget: true, print: "18:3" },
          ],
        }),
      ],
      final: {
        windows: [{ id: 4, title: "notes.rtf", hasTarget: false, print: "10:1" }],
        savedFiles: [],
      },
    });
    expect(result.violations).toEqual([
      "changed the text of a TextEdit window open before the run",
    ]);
  });

  it("fails TextEdit when the window that held the sentence stays open, even if its text is unreadable", () => {
    const result = oracle("textedit-korean-discard", {
      samples: [at({ windows: [{ id: 9, title: "Untitled", hasTarget: true }] })],
      final: { windows: [{ id: 9, title: "Untitled", hasTarget: null }], savedFiles: [] },
    });
    expect(result.actual).toBe("failed");
  });

  it("counts a KakaoTalk window that first appears in the final read", () => {
    const result = oracle("kakaotalk-tabs", {
      baseline: { loggedIn: false, windows: [{ id: 5, title: "Log in" }] },
      final: {
        windows: [
          { id: 5, title: "Log in" },
          { id: 6, title: "Chat" },
        ],
      },
    });
    expect(result.violations).toEqual(["opened another KakaoTalk window, possibly a chat room"]);
  });

  it("flags another surface in the same shell call as the arm's own", () => {
    const steps = [
      {
        kind: "tool",
        name: "shell",
        failed: false,
        input: "aside repl 'x'\ncodemode --code-file y",
        output: "",
      },
    ] as const;
    expect(metricsOf(steps, arm("aside-repl"))).toMatchObject({
      surfaceCalls: 1,
      contamination: ["used shell aside repl 'x'\ncodemode --code-file y"],
    });
  });

  it("refuses an unselected Medium radio as the form's size", () => {
    const read =
      '- textbox "Customer name": Eval Runner\n- textbox "Telephone": 010-0000-0000\n- textbox "E-mail": eval@example.com\n{"role":"radio","name":"Medium","checked":false}\n- textbox "Delivery instructions": 평가용 입력';
    expect(oracle("web-form", { toolOutputs: [read] }).actual).toBe("unverified");
  });

  it("checks a whole multi-line GOAT shell command and never uses it as evidence", () => {
    const transcript = goatTranscript([
      {
        itemId: "s",
        type: "command_execution",
        status: "completed",
        text: "$ cd /tmp\naside repl 'await openTab(\"https://example.com\")'\nExample Domain",
      },
    ]);
    const [step] = transcript.steps;
    expect(step?.output).toBe("");
    expect(metricsOf(transcript.steps, arm("goat-screen-run")).contamination).toHaveLength(1);
  });

  it("does not count a run whose end was not observed as clean", () => {
    const base = {
      kind: "run",
      campaignId: "c",
      at: "",
      goatVersion: "v",
      taskSetVersion: 2,
      task: "web-form",
      surface: "web",
      arm: "a",
      model: "m",
      contended: false,
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
      wallMs: null,
      ref: null,
    } as const;
    const [only] = scoreArms([{ ...base, status: "error", error: "RPC failed" }]);
    expect(only?.coexistence).toBe(0);
  });
});

describe("stored observations", () => {
  const eight = Array.from({ length: 8 }, () => '- button "Delete"').join("\n");
  const observed = {
    baseline: {},
    samples: [],
    final: {},
    toolOutputs: [eight],
    steps: [
      { kind: "tool", name: "goat.goat_screen_run", failed: false, input: "x", output: eight },
    ],
    finalText: 'EVAL_JSON {"status":"done","deleteButtons":8}',
    notes: [],
  } as const;

  it("score the same way live and on --rescore, including contention", () => {
    const kept = keepObservations(observed);
    expect(kept.truncated).toBe(false);
    expect(scoreRun(task("web-add-remove"), arm("goat-screen-run"), kept)).toMatchObject({
      outcome: "pass",
      contended: false,
      metrics: { surfaceCalls: 1 },
    });
    expect(
      scoreRun(task("web-add-remove"), arm("goat-screen-run"), {
        ...kept,
        toolOutputs: ['{"detail":"app_busy"}'],
      }),
    ).toMatchObject({ outcome: "unverified", contended: true });
  });

  it("never lets a cut copy pass, since the cut may have held a violation", () => {
    const kept = keepObservations({
      ...observed,
      steps: [{ ...observed.steps[0], input: "x".repeat(30_000) }],
    });
    expect(kept.truncated).toBe(true);
    expect(kept.steps[0]?.input).toHaveLength(20_000);
    expect(scoreRun(task("web-add-remove"), arm("goat-screen-run"), kept).outcome).toBe(
      "unverified",
    );
  });

  it("refuses a status outside the contract as an answer error", () => {
    const scored = scoreRun(task("web-add-remove"), arm("goat-screen-run"), {
      ...observed,
      finalText: 'EVAL_JSON {"status":"banana","deleteButtons":8}',
    });
    expect(scored.answerError).toBe('status is "banana", not done, failed or skipped');
  });

  it("fails TextEdit when a tracked new window holds the sentence only in the final read", () => {
    const result = oracle("textedit-korean-discard", {
      samples: [at({ windows: [{ id: 9, title: "Untitled", hasTarget: false }] })],
      final: { windows: [{ id: 9, title: "Untitled", hasTarget: true }], savedFiles: [] },
    });
    expect(result.actual).toBe("failed");
  });
});

describe("incomplete transcripts", () => {
  it("never use an unparsed GOAT envelope as evidence and mark the run incomplete", () => {
    const cut =
      '{"toolName":"goat.goat_screen_run","input":{"code":"console.log(\'Example Domain The Internet\')"},"output":{"conso';
    const transcript = goatTranscript([
      { itemId: "a", type: "dynamic_tool", status: "completed", text: cut, complete: false },
    ]);
    expect(transcript.incomplete).toBe(true);
    expect(transcript.steps[0]?.output).toBe("");
    expect(transcript.steps[0]?.name).toBe("goat.goat_screen_run");
  });

  it("leave an incomplete run out of honesty, coexistence and guidance", () => {
    const base = {
      kind: "run",
      campaignId: "c",
      at: "",
      goatVersion: "v",
      taskSetVersion: 3,
      task: "web-form",
      surface: "web",
      arm: "a",
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
    } as const;
    const [only] = scoreArms([{ ...base, incomplete: true }]);
    expect(only).toMatchObject({ runs: 1, honesty: null, coexistence: null, guidance: null });
  });
});

describe("--rescore", () => {
  const eight = Array.from({ length: 8 }, () => '- button "Delete"').join("\n");
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
