import { describe, expect, it } from "vite-plus/test";

import { mergeVerdict, type Run } from "./merge-pr.ts";

const PR = 7;
const HEAD = "a".repeat(40);
const titles = {
  pr: "fix: something (#7)",
  ignored: "fix: something (#7, ignored event)",
  all: "goat-ci all on fix/something",
  quick: "goat-ci quick on fix/something",
};
const run = (
  id: number,
  status: string,
  conclusion: string | null,
  kind: keyof typeof titles = "pr",
): Run => ({
  id,
  event: kind === "all" || kind === "quick" ? "workflow_dispatch" : "pull_request",
  display_title: titles[kind],
  status,
  conclusion,
  html_url: `https://github.com/goat-si/goat/actions/runs/${id}`,
});
const result = (conclusion: string | null, status = "completed"): Run => ({
  id: 900,
  name: "goat-ci-result",
  status,
  conclusion,
  html_url: "https://github.com/goat-si/goat/actions/runs/1/job/900",
});
/** Each workflow run's jobs, by run id. */
const jobs =
  (byRun: Record<number, ReadonlyArray<Run>>) =>
  (workflow: Run): ReadonlyArray<Run> =>
    byRun[workflow.id] ?? [];
const verdict = (
  runs: ReadonlyArray<Run>,
  byRun: Record<number, ReadonlyArray<Run>>,
  knownFailure?: string,
) => mergeVerdict(runs, jobs(byRun), PR, HEAD, knownFailure);

describe("mergeVerdict", () => {
  it("refuses a head whose goat-ci run is missing or still running, known failure or not (#2017)", () => {
    expect(verdict([], {}).merge).toBe(false);
    expect(verdict([run(1, "in_progress", null)], {}, "fails on dev too").merge).toBe(false);
  });

  it("refuses a failed result unless a reason is given (#2046)", () => {
    const failed = { 1: [result("failure")] };
    expect(verdict([run(1, "completed", "failure")], failed).merge).toBe(false);
    expect(verdict([run(1, "completed", "failure")], failed, "  ").merge).toBe(false);
    expect(verdict([run(1, "completed", "failure")], failed, "same failure on dev: run 1")).toEqual(
      {
        merge: true,
        run: result("failure"),
        knownFailure: "same failure on dev: run 1",
      },
    );
  });

  it("reads only the newest run, so an older success cannot stand in for a newer cancelled run", () => {
    const runs = [run(1, "completed", "success"), run(2, "completed", "cancelled")];
    expect(verdict(runs, { 1: [result("success")] }, "fails on dev too").merge).toBe(false);
    expect(verdict(runs, { 1: [result("failure")], 2: [result("success")] }).merge).toBe(true);
  });

  it("does not let a partial manual lane replace a failed pull request run", () => {
    const runs = [run(1, "completed", "failure"), run(2, "completed", "success", "quick")];
    expect(verdict(runs, { 1: [result("failure")], 2: [result("success")] }).merge).toBe(false);
    const full = [run(1, "completed", "failure"), run(2, "completed", "success", "all")];
    expect(verdict(full, { 1: [result("failure")], 2: [result("success")] }).merge).toBe(true);
  });

  it("does not let an ignored event's republished success hide newer or re-running evidence", () => {
    const failedFull = [
      run(1, "completed", "success"),
      run(2, "completed", "failure", "all"),
      run(3, "completed", "success", "ignored"),
    ];
    const byRun = { 1: [result("success")], 2: [result("failure")], 3: [result("success")] };
    expect(verdict(failedFull, byRun).merge).toBe(false);
    // A re-run keeps its run id, so the governing run is still the newest real one.
    const rerunning = [run(1, "in_progress", null), run(3, "completed", "success", "ignored")];
    expect(verdict(rerunning, byRun).merge).toBe(false);
  });
});
