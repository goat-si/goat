import { EnvironmentId, ThreadId, type CloudRunSummary } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupCloudAgentRuns } from "./fleetCloudAgents.ts";

const run = (overrides: Partial<CloudRunSummary>): CloudRunSummary => ({
  threadId: ThreadId.make("thread:a"),
  provider: "cursorCloud",
  instanceId: "cursorCloud" as CloudRunSummary["instanceId"],
  title: "Run",
  status: "running",
  tracking: "polled",
  repository: "https://github.com/goat-si/goat",
  registered: false,
  updatedAt: "2026-10-20T00:00:00.000Z",
  ...overrides,
});

describe("groupCloudAgentRuns", () => {
  it("groups runs per provider with their holder and launcher, running first", () => {
    const groups = groupCloudAgentRuns([
      {
        environmentId: EnvironmentId.make("macmini"),
        label: "macmini",
        runs: [
          run({
            threadId: ThreadId.make("thread:done"),
            status: "succeeded",
            updatedAt: "2026-10-20T02:00:00.000Z",
          }),
          run({ threadId: ThreadId.make("thread:live"), launchedBy: "Grok Bot", registered: true }),
          run({
            threadId: ThreadId.make("thread:link"),
            tracking: "link-only",
            provider: "devinCloud",
          }),
        ],
      },
      {
        environmentId: EnvironmentId.make("studio"),
        label: "mac-studio",
        runs: [run({ threadId: ThreadId.make("thread:claude"), provider: "claudeCloud" })],
      },
    ]);
    expect(groups.map((group) => [group.kind, group.label, group.running])).toEqual([
      ["cloud-agent", "Claude Cloud", 1],
      ["cloud-agent", "Cursor Cloud", 1],
      ["cloud-agent", "Devin Cloud", 0],
    ]);
    expect(
      groups[1]!.runs.map((entry) => [
        entry.ref.threadId,
        entry.state,
        entry.launchedBy,
        entry.holder,
      ]),
    ).toEqual([
      ["thread:live", "running", "Grok Bot", "macmini"],
      ["thread:done", "finished", "GOAT", "macmini"],
    ]);
    expect(groups[2]!.runs[0]).toMatchObject({ state: "link-only", repository: "goat-si/goat" });
    expect(groups[0]!.runs[0]!.holder).toBe("mac-studio");
  });

  it("draws nothing without cloud runs", () => {
    expect(
      groupCloudAgentRuns([{ environmentId: EnvironmentId.make("x"), label: "x", runs: [] }]),
    ).toEqual([]);
  });
});
