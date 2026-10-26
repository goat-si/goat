import { describe, expect, it } from "vite-plus/test";

import type { WorkLogPresentationEntry } from "@goat/client-runtime/work-log/presentation";

import { workEntryRowLabel } from "./threadActivity";

const command: WorkLogPresentationEntry = {
  id: "command",
  createdAt: "2026-01-01T00:00:01Z",
  label: "Ran command",
  tone: "tool",
  itemType: "command_execution",
  command: "/bin/zsh -lc 'npm test'",
};

describe("mobile command row labels", () => {
  it.each([
    ["completed", "Ran npm test"],
    ["inProgress", "Running npm test"],
    ["failed", "Failed npm test"],
    ["stopped", "Stopped npm test"],
  ] as const)("a %s command reads as %j, like the web timeline", (status, label) => {
    expect(workEntryRowLabel({ ...command, toolLifecycleStatus: status })).toBe(label);
  });
});
