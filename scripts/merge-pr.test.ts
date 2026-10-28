import { describe, expect, it } from "vite-plus/test";

import { mergeVerdict, type CheckRun } from "./merge-pr.ts";

const HEAD = "a".repeat(40);
const run = (id: number, status: string, conclusion: string | null): CheckRun => ({
  id,
  status,
  conclusion,
  html_url: `https://github.com/goat-si/goat/runs/${id}`,
});

describe("mergeVerdict", () => {
  it("refuses a head whose goat-ci-result is still running or missing, known failure or not (#2017)", () => {
    expect(mergeVerdict([run(1, "in_progress", null)], HEAD).merge).toBe(false);
    expect(mergeVerdict([run(1, "queued", null)], HEAD, "fails on dev too").merge).toBe(false);
    expect(mergeVerdict([], HEAD).merge).toBe(false);
  });

  it("refuses a failed or cancelled head unless a reason is given (#2046)", () => {
    expect(mergeVerdict([run(1, "completed", "failure")], HEAD).merge).toBe(false);
    expect(mergeVerdict([run(1, "completed", "cancelled")], HEAD, "  ").merge).toBe(false);
    expect(
      mergeVerdict([run(1, "completed", "failure")], HEAD, "same failure on dev: run 1"),
    ).toEqual({
      merge: true,
      run: run(1, "completed", "failure"),
      knownFailure: "same failure on dev: run 1",
    });
  });

  it("follows the newest run on the head, as GitHub's required check does", () => {
    const passedAfterRerun = [run(1, "completed", "failure"), run(3, "completed", "success")];
    expect(mergeVerdict(passedAfterRerun, HEAD).merge).toBe(true);
    const newerRunPending = [run(3, "completed", "success"), run(4, "in_progress", null)];
    expect(mergeVerdict(newerRunPending, HEAD).merge).toBe(false);
  });
});
