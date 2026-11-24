import { describe, expect, it } from "vite-plus/test";

import type { OrchestrationV2TurnItem } from "@goat/contracts";
import { buildThreadFeed, deriveThreadFeedPresentation } from "./threadActivity";
import { base, projected, userMessage } from "./threadActivity.testkit";

import type { WorkLogPresentationEntry } from "@goat/client-runtime/work-log/presentation";

import { workEntryRowLabel } from "./workEntryRowLabel";

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

it("labels a running command without command text by its status", () => {
  const item: OrchestrationV2TurnItem = {
    ...base("commandless", "2026-06-20T00:00:02.000Z", 1),
    type: "command_execution",
    title: "Ran command",
    status: "running",
    completedAt: null,
    runId: null,
    input: "",
  };
  const feed = buildThreadFeed([
    projected({ ...userMessage(), runId: null }, 0),
    projected(item, 1),
  ]);
  const activity = feed.flatMap((entry) =>
    entry.type === "activity-group" ? entry.activities : [],
  )[0]!;
  expect(workEntryRowLabel(activity.workEntry)).toBe("Running command");
  const presented = deriveThreadFeedPresentation(
    feed,
    null,
    new Set(),
    new Set(),
    "2026-06-20T00:00:01.000Z",
    true,
  );
  expect(presented.find((entry) => entry.type === "activity-group")).toMatchObject({
    activities: [{ live: true, groupStandIn: { label: "Running command" } }],
  });
});
