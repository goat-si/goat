import type { RunResult } from "@cursor/sdk";
import { RunId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";
import { shouldRetryCursorRun } from "./adapter.ts";

const task = {
  taskId: "run-fixture",
  acceptedAppRunId: RunId.make("app-run-fixture"),
  source: { repository: "https://github.com/fixture/repo", branch: "feature", sha: "a".repeat(40) },
  localChangesExcluded: true,
  status: "running" as const,
  tracking: "live" as const,
  updatedAt: "2026-10-25T00:00:00.000Z",
};

describe("Cursor Cloud automatic retry", () => {
  // RunError.code is optional; a refusal can explain itself only in its message.
  it.each<{ name: string; message: string; retry: boolean }>([
    {
      name: "an unexpected stop",
      message: "The agent stopped because of an unexpected error.",
      retry: true,
    },
    {
      name: "a billing refusal without a code",
      message: "You have no usage credits left. Update your billing plan to continue.",
      retry: false,
    },
    {
      name: "a sign-in refusal without a code",
      message: "Authentication required. Sign in to Cursor again.",
      retry: false,
    },
  ])("decides whether to retry $name from the message alone", ({ message, retry }) => {
    const result: RunResult = { id: "run-fixture", status: "error", error: { message } };
    expect(shouldRetryCursorRun(task, result, false)).toBe(retry);
  });
});
