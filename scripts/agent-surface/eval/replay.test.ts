import { expect, it } from "vite-plus/test";
import { loadServedCatalog } from "../servedCatalog.ts";
import type { JsonObject } from "./core.ts";
import { replayCases } from "./replay-cases.ts";
import { decodeReplayRun, gradeReplay, type ReplayCall, type ReplayRun } from "./replay.ts";

const call = (tool: string, input: JsonObject = {}): ReplayCall => ({ tool, input });
const dispatch = (path: string, args: JsonObject = {}): ReplayCall =>
  call("mcp__goat__goat_call", { path, args });
const run = (calls: ReadonlyArray<ReplayCall>, text = ""): ReplayRun => ({
  calls,
  text,
  stopReason: "end_turn",
});
const failed = (
  expected: Parameters<typeof gradeReplay>[0],
  sample: ReplayRun,
  listed = ["goat_call"],
) =>
  gradeReplay(expected, sample, listed)
    .filter((check) => !check.pass)
    .map((check) => check.check);
const pr = "https://github.com/example/replay-fixture/pull/124";
const threadId = "11111111-1111-4111-8111-111111111111";

const continuations: Readonly<
  Record<string, { readonly good: ReplayRun; readonly bad: ReplayRun }>
> = {
  "review-round-creates-new-task": {
    good: run([
      call("goat_task_create", {
        role: "review",
        task: "Review the cache fix; the old cache migration discarded v4 entries.",
      }),
    ]),
    bad: run([call("goat_thread_send", { threadId, message: "Review round two" })]),
  },
  "async-delegate-ends-turn": {
    good: run([call("goat_task_create", { task: "Compare cache designs", mode: "async" })]),
    bad: run([
      call("goat_task_create", { task: "Compare cache designs", mode: "async" }),
      call("goat_task_read", { taskId: "task-1" }),
      call("functions.exec_command", { cmd: "sleep 60" }),
    ]),
  },
  "delegate-uses-managed-worktree": {
    good: run([call("goat_task_create", { task: "Fix the cache", isolation: "worktree" })]),
    bad: run([
      call("Bash", { command: "git worktree add /tmp/cache-lane" }),
      call("goat_task_create", { task: "Fix the cache" }),
    ]),
  },
  "child-links-without-watching": {
    good: run(
      [call("goat_pull_request_link", { url: pr })],
      `PR ${pr}, head abcdef1234567890, checks not run`,
    ),
    bad: run([
      call("goat_pull_request_link", { url: pr }),
      call("goat_pull_request_watch", { url: pr }),
    ]),
  },
  "review-only-does-not-link-pr": {
    good: run([], "PASS: no findings."),
    bad: run([call("goat_pull_request_link", { url: pr })], "PASS: no findings."),
  },
  "thread-read-returns-link": {
    good: run(
      [call("goat_thread_read", { threadId, limit: 20 })],
      `[Thread](goat-thread://v1/${threadId})`,
    ),
    bad: run([call("goat_thread_read", { threadId, limit: 21 })], "The thread is done."),
  },
  "preview-before-render": {
    good: run([
      call("goat_html_preview", { html: "<p>Cache</p>" }),
      call("goat_html_render", { html: "<p>Cache</p>" }),
    ]),
    bad: run([
      call("goat_html_render", { html: "<p>Cache</p>" }),
      call("goat_html_preview", { html: "<p>Cache</p>" }),
    ]),
  },
};

it("grades each replay's good and mistaken continuation against the served full and core listings", async () => {
  const catalog = await loadServedCatalog();
  try {
    for (const mode of ["full", "core"] as const) {
      const tools = await catalog.listedAsThread(mode);
      const listed = tools.map((tool) => tool.name);
      for (const testCase of replayCases) {
        const samples = continuations[testCase.id];
        expect(samples, testCase.id).toBeDefined();
        if (!samples) throw new Error("Missing continuation for " + testCase.id);
        const throughDispatcher = (sample: ReplayRun): ReplayRun => ({
          ...sample,
          calls: sample.calls.map((entry) => {
            const path = entry.tool.startsWith("goat_")
              ? entry.tool.slice(5).replace(/_([^_]+)$/, ".$1")
              : null;
            return path ? dispatch(path, entry.input) : entry;
          }),
        });
        const good = mode === "core" ? throughDispatcher(samples.good) : samples.good;
        const bad = mode === "core" ? throughDispatcher(samples.bad) : samples.bad;
        expect(failed(testCase.expect, good, listed), `${mode}: ${testCase.id}`).toEqual([]);
        expect(failed(testCase.expect, bad, listed), `${mode}: ${testCase.id}`).not.toEqual([]);
      }
    }
  } finally {
    await catalog.dispose();
  }
});

it("does not let an unlisted, unknown, failed or foreign-server call satisfy a GOAT requirement", () => {
  const expected = { calls: [{ tool: "task.create" }] };
  expect(failed(expected, run([call("goat_task_create")]))).toContain("listed goat_task_create");
  expect(failed(expected, run([dispatch("task.typo")]))).toContain("dispatch task.typo");
  expect(failed(expected, run([{ ...dispatch("task.create"), isError: true }]))).toContain(
    "calls task.create",
  );
  expect(failed(expected, run([call("mcp__other__goat_task_create")]))).toContain(
    "calls task.create",
  );
  expect(failed({}, run([call("mcp__goat__invented_tool")]))).toContain(
    "unknown GOAT tool mcp__goat__invented_tool",
  );
  expect(failed(expected, run([call("goat_call", { path: "task.create", args: [] })]))).toContain(
    "dispatch task.create",
  );
});

it.each([
  "Bash",
  "functions.Bash",
  "exec_command",
  "functions.exec_command",
  "Monitor",
  "functions.Monitor",
])("rejects forbidden %s commands even when every other replay requirement passes", (tool) => {
  const review = replayCases.find((entry) => entry.id === "review-only-does-not-link-pr");
  const managed = replayCases.find((entry) => entry.id === "delegate-uses-managed-worktree");
  if (!review || !managed) throw new Error("Missing shell regression cases");
  const commandInput = (command: string): JsonObject =>
    tool.endsWith("exec_command") ? { cmd: command } : { command };
  expect(
    failed(review.expect, run([call(tool, commandInput("git status"))], "PASS: no findings.")),
  ).toEqual([]);
  expect(
    failed(
      review.expect,
      run([call(tool, commandInput("git push origin HEAD"))], "PASS: no findings."),
    ),
  ).toEqual(["shellMustNot /git\\s+push/"]);
  for (const command of ["git worktree add /tmp/cache-lane", "git clone ./cache /tmp/cache-lane"])
    expect(
      failed(
        managed.expect,
        run([
          dispatch("task.create", { task: "Fix the cache", isolation: "worktree" }),
          call(tool, commandInput(command)),
        ]),
      ),
    ).toEqual([
      command.startsWith("git clone")
        ? "shellMustNot /git\\s+clone/"
        : "shellMustNot /git\\s+worktree\\s+add/",
    ]);
});

it.each([
  ["until gh pr checks 124; do :; done", "\\buntil\\b[^\\n]*\\bgh (pr|run|api)\\b"],
  ["until gh run view 123; do :; done", "\\buntil\\b[^\\n]*\\bgh (pr|run|api)\\b"],
  [
    "until gh api repos/example/replay-fixture/actions/runs; do :; done",
    "\\buntil\\b[^\\n]*\\bgh (pr|run|api)\\b",
  ],
  [
    "for attempt in 1 2 3; do gh pr checks 124; done",
    "\\bfor \\w+ in [^\\n]*;\\s*do[^\\n]*\\bgh pr checks\\b",
  ],
  ["node scripts/pr-wait.mjs 124", "pr-wait"],
])("rejects child CI polling via %s while allowing a one-shot check read", (command, pattern) => {
  const child = replayCases.find((entry) => entry.id === "child-links-without-watching");
  if (!child) throw new Error("Missing child-PR regression case");
  const continuation = (command: string) =>
    run(
      [dispatch("pull_request.link", { url: pr }), call("Bash", { command })],
      `PR ${pr}, head abcdef1234567890, checks pending, reviews not requested`,
    );
  expect(failed(child.expect, continuation("gh pr checks 124"))).toEqual([]);
  expect(failed(child.expect, continuation(command))).toEqual([`shellMustNot /${pattern}/`]);
});

it("rejects asking an isolated child to create an unmanaged worktree or clone", () => {
  const managed = replayCases.find((entry) => entry.id === "delegate-uses-managed-worktree");
  if (!managed) throw new Error("Missing managed-worktree regression case");
  for (const tool of ["goat_task_create", "mcp__goat__goat_call"]) {
    const delegate = (task: string) => {
      const args = { isolation: "worktree", task };
      return tool === "goat_task_create" ? call(tool, args) : dispatch("task.create", args);
    };
    const listed = ["goat_call", "goat_task_create"];
    expect(failed(managed.expect, run([delegate("Fix the cache")]), listed)).toEqual([]);
    for (const command of [
      "git worktree add /tmp/cache-child",
      "git clone ./cache /tmp/cache-child",
    ])
      expect(
        failed(
          managed.expect,
          run([delegate(`Fix the cache; first run ${command} and work there`)]),
          listed,
        ),
      ).toEqual(["callsMustNot task.create"]);
  }
});

it("matches provider options in either wire form and refuses string numbers or missing arguments", () => {
  const expected = {
    calls: [
      {
        tool: "task.create",
        args: { "target.options.reasoningEffort": "high", timeoutMs: ">=60000" },
      },
    ],
  };
  for (const options of [{ reasoningEffort: "high" }, [{ id: "reasoningEffort", value: "high" }]]) {
    expect(
      failed(expected, run([dispatch("task.create", { target: { options }, timeoutMs: 60000 })])),
    ).toEqual([]);
    expect(
      failed(expected, run([dispatch("task.create", { target: { options }, timeoutMs: "60000" })])),
    ).toContain("calls task.create");
  }
  expect(failed(expected, run([dispatch("task.create")]))).toContain("calls task.create");
});

it("requires ordered repeated calls, counts duplicates and rejects unfinished continuations", () => {
  const expected = {
    order: ["html.preview", "html.render", "html.preview"],
    maxCalls: { "html.render": 1 },
  };
  const calls = [dispatch("html.preview"), dispatch("html.render"), dispatch("html.preview")];
  expect(failed(expected, run(calls))).toEqual([]);
  expect(failed(expected, run(calls.slice(0, 2)))).toContain(
    "order html.preview > html.render > html.preview",
  );
  expect(failed(expected, run([...calls, dispatch("html.render")]))).toContain(
    "maxCalls html.render <= 1",
  );
  expect(
    failed(
      { endsTurnAfter: "task.create" },
      { ...run([dispatch("task.create")]), stopReason: "max_steps" },
    ),
  ).toEqual(["endsTurnAfter task.create", "completed"]);
});

it("refuses malformed traces instead of reporting a pass", () => {
  for (const raw of [
    null,
    {},
    { calls: [], text: "", stopReason: "unknown" },
    { calls: [], text: "", stopReason: ["end_turn"] },
    { calls: [{ tool: "goat_call", input: null }], text: "", stopReason: "end_turn" },
    {
      calls: [{ tool: "goat_call", input: {}, isError: "false" }],
      text: "",
      stopReason: "end_turn",
    },
  ])
    expect(() => decodeReplayRun(raw)).toThrow();
  expect(decodeReplayRun(run([dispatch("thread.read", { threadId })]))).toEqual(
    run([dispatch("thread.read", { threadId })]),
  );
});
