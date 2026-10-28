import { describe, expect, it } from "vite-plus/test";

import { mergeVerdict, type Run } from "./merge-pr.ts";

const HEAD = "a".repeat(40);
const run = (id: number, status: string, conclusion: string | null, name?: string): Run => ({
  id,
  name,
  status,
  conclusion,
  html_url: `https://github.com/goat-si/goat/actions/runs/${id}`,
});
const result = (status: string, conclusion: string | null) =>
  run(900, status, conclusion, "goat-ci-result");
/** Each workflow run's jobs, by run id. */
const jobs =
  (byRun: Record<number, ReadonlyArray<Run>>) =>
  (workflow: Run): ReadonlyArray<Run> =>
    byRun[workflow.id] ?? [];

describe("mergeVerdict", () => {
  it("refuses a head whose newest goat-ci run is missing or still running, known failure or not (#2017)", () => {
    expect(mergeVerdict([], jobs({}), HEAD).merge).toBe(false);
    const running = [run(1, "in_progress", null)];
    expect(mergeVerdict(running, jobs({}), HEAD, "fails on dev too").merge).toBe(false);
  });

  it("refuses a failed result unless a reason is given (#2046)", () => {
    const failed = jobs({ 1: [result("completed", "failure")] });
    expect(mergeVerdict([run(1, "completed", "failure")], failed, HEAD).merge).toBe(false);
    expect(mergeVerdict([run(1, "completed", "failure")], failed, HEAD, "  ").merge).toBe(false);
    expect(
      mergeVerdict([run(1, "completed", "failure")], failed, HEAD, "same failure on dev: run 1"),
    ).toEqual({
      merge: true,
      run: result("completed", "failure"),
      knownFailure: "same failure on dev: run 1",
    });
  });

  it("reads only the newest run, so an older success cannot stand in for a newer cancelled run", () => {
    const runs = [run(1, "completed", "success"), run(2, "completed", "cancelled")];
    const byRun = jobs({
      1: [result("completed", "success")],
      2: [run(5, "completed", "skipped", "goat-scope")],
    });
    expect(mergeVerdict(runs, byRun, HEAD, "fails on dev too").merge).toBe(false);
    const rerun = jobs({
      1: [result("completed", "failure")],
      2: [result("completed", "success")],
    });
    expect(mergeVerdict(runs, rerun, HEAD).merge).toBe(true);
  });
});
