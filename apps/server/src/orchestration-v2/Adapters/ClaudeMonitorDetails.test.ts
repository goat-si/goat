import { expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { makeClaudeTaskLaunches } from "./ClaudeBackgroundTasks.ts";

it("retains a Monitor launch command for its background task", () => {
  const launches = makeClaudeTaskLaunches();
  const startedAt = DateTime.makeUnsafe("2026-11-20T00:00:00.000Z");
  launches.remember("task", "tool", {
    toolName: "Monitor",
    classification: { itemType: "tool" },
    input: { type: "record", value: { command: "tail -f output.log" } },
    startedAt,
  });
  expect(launches.get("task")).toEqual({
    nativeItemId: "tool",
    command: "tail -f output.log",
    startedAt: "2026-11-20T00:00:00.000Z",
  });
});
