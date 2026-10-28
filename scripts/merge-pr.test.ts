import { describe, expect, it } from "vite-plus/test";

import { governingRuns, mergeVerdict, sameEvidence, type Run } from "./merge-pr.ts";

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
  attempt = 1,
): Run => ({
  id,
  event: kind === "all" || kind === "quick" ? "workflow_dispatch" : "pull_request",
  display_title: titles[kind],
  created_at: `2026-10-28T00:${String(id).padStart(2, "0")}:00Z`,
  run_attempt: attempt,
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
const verdict = (
  runs: ReadonlyArray<Run>,
  byRun: Record<number, ReadonlyArray<Run>>,
  knownFailure?: string,
) =>
  mergeVerdict(governingRuns(runs, PR), (workflow) => byRun[workflow.id] ?? [], HEAD, knownFailure);

describe("mergeVerdict", () => {
  it("refuses a head whose goat-ci run is missing or still running, known failure or not (#2017)", () => {
    expect(verdict([], {}).merge).toBe(false);
    // A manual run alone skips the screenshot gate and may stand in for a skipped PR run.
    expect(verdict([run(1, "completed", "success", "all")], { 1: [result("success")] }).merge).toBe(
      false,
    );
    expect(verdict([run(1, "in_progress", null)], {}, "fails on dev too").merge).toBe(false);
  });

  it("refuses a failed result unless a reason is given (#2046)", () => {
    const failed = { 1: [result("failure")] };
    expect(verdict([run(1, "completed", "failure")], failed).merge).toBe(false);
    expect(verdict([run(1, "completed", "failure")], failed, "  ").merge).toBe(false);
    expect(verdict([run(1, "completed", "failure")], failed, "same failure on dev").merge).toBe(
      true,
    );
  });

  it("reads the newest real run, so an older success cannot stand in for a newer cancelled run", () => {
    const runs = [run(1, "completed", "success"), run(2, "completed", "cancelled")];
    expect(verdict(runs, { 1: [result("success")] }, "fails on dev too").merge).toBe(false);
    expect(verdict(runs, { 1: [result("failure")], 2: [result("success")] }).merge).toBe(true);
  });

  it("does not let a partial manual lane or an ignored event's republished success govern", () => {
    const quick = [run(1, "completed", "failure"), run(2, "completed", "success", "quick")];
    expect(verdict(quick, { 1: [result("failure")], 2: [result("success")] }).merge).toBe(false);
    const ignored = [run(1, "completed", "failure"), run(3, "completed", "success", "ignored")];
    expect(verdict(ignored, { 1: [result("failure")], 3: [result("success")] }).merge).toBe(false);
    // A re-run keeps its run id, so the governing run is still the real one, now running.
    const rerunning = [
      run(1, "in_progress", null, "pr", 2),
      run(3, "completed", "success", "ignored"),
    ];
    expect(verdict(rerunning, { 3: [result("success")] }).merge).toBe(false);
  });

  it("keeps a failed full run in force until a later full run passes", () => {
    const byRun = {
      1: [result("success")],
      2: [result("failure")],
      3: [result("success")],
      4: [result("success")],
    };
    const narrowerAfter = [
      run(1, "completed", "success"),
      run(2, "completed", "failure", "all"),
      run(3, "completed", "success"),
    ];
    expect(verdict(narrowerAfter, byRun).merge).toBe(false);
    expect(verdict([...narrowerAfter, run(4, "completed", "success", "all")], byRun).merge).toBe(
      true,
    );
  });
});

describe("sameEvidence", () => {
  it("notices a run that started or re-ran after the jobs were read", () => {
    const before = governingRuns([run(1, "completed", "success")], PR);
    expect(sameEvidence(before, governingRuns([run(1, "completed", "success")], PR))).toBe(true);
    const newer = [run(1, "completed", "success"), run(2, "queued", null)];
    expect(sameEvidence(before, governingRuns(newer, PR))).toBe(false);
    expect(sameEvidence(before, governingRuns([run(1, "in_progress", null, "pr", 2)], PR))).toBe(
      false,
    );
    const full = [run(1, "completed", "success"), run(2, "queued", null, "all")];
    expect(sameEvidence(before, governingRuns(full, PR))).toBe(false);
  });
});
