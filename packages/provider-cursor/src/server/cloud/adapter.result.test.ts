import type { RunResult } from "@cursor/sdk";
import { RunId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resultTask } from "./adapter.ts";

const task = {
  taskId: "run-fixture",
  acceptedAppRunId: RunId.make("app-run-fixture"),
  source: { repository: "https://github.com/fixture/repo", branch: "feature", sha: "a".repeat(40) },
  localChangesExcluded: true,
  status: "running" as const,
  tracking: "live" as const,
  updatedAt: "2026-10-25T00:00:00.000Z",
};
const failed = (error?: RunResult["error"]): RunResult => ({
  id: "run-fixture",
  status: "error",
  ...(error === undefined ? {} : { error }),
});

describe("Cursor Cloud failed run", () => {
  it("shows the reason Cursor gave for stopping the run", () => {
    expect(
      resultTask(task, failed({ message: "You have no usage credits left.", code: "quota" })).error,
    ).toBe("Cursor stopped this run: You have no usage credits left.");
  });
  it("keeps the reason to one bounded line", () => {
    const error = resultTask(
      task,
      failed({ message: `Line one\n\nline two ${"x".repeat(600)}` }),
    ).error;
    expect(error?.startsWith("Cursor stopped this run: Line one line two x")).toBe(true);
    expect(error?.length).toBeLessThanOrEqual(300);
    expect(error).not.toContain("\n");
  });
  it("falls back to the general sentence when Cursor gave no reason", () => {
    expect(resultTask(task, failed()).error).toBe(
      "Cursor's agent hit an unexpected error before it finished.",
    );
    expect(resultTask(task, failed({ message: "   " })).error).toBe(
      "Cursor's agent hit an unexpected error before it finished.",
    );
  });
});
