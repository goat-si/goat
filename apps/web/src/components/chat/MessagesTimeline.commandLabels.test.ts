import { describe, expect, it } from "vite-plus/test";

import type { WorkLogEntry } from "../../session-logic";
import { deriveMessagesTimelineRows, workEntryDisplayLabel } from "./MessagesTimeline.logic";

describe("command row labels", () => {
  const command: WorkLogEntry = {
    id: "command",
    createdAt: "2026-01-01T00:00:01Z",
    label: "Ran command",
    tone: "tool",
    itemType: "command_execution",
    command: "/bin/zsh -lc 'npm test'",
  };

  it.each([
    ["completed", "Ran npm test"],
    ["inProgress", "Running npm test"],
    ["failed", "Failed npm test"],
  ] as const)("a %s command reads as %j, like Codex", (status, label) => {
    expect(workEntryDisplayLabel({ ...command, toolLifecycleStatus: status }, undefined)).toBe(
      label,
    );
  });

  it("a lone finished command row carries the verb", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "lone-command",
          kind: "work",
          createdAt: "2026-01-01T00:00:01Z",
          entry: { ...command, toolLifecycleStatus: "completed" },
        },
      ],
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(rows[0]).toMatchObject({ kind: "work", displayLabel: "Ran npm test" });
  });
});
