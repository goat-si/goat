import { BotThreadRow, ChannelTaskId, EnvironmentId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import {
  acknowledgeHistoryRow,
  historyTask,
  rememberHistoryRows,
  resetHistoryTasksForTests,
} from "./botWorkHistoryStore";

const decodeRow = Schema.decodeUnknownSync(BotThreadRow);

it("keeps newer activity unread when an older acknowledgement lands", () => {
  resetHistoryTasksForTests();
  const environment = EnvironmentId.make("env");
  const taskId = ChannelTaskId.make("task");
  const row = decodeRow({
    kind: "task",
    task: { taskId, title: "Task", status: "running", updatedAt: "2026-11-13T02:00:00Z" },
    view: { taskId, pinnedAt: null, doneAt: null, readThrough: null },
    lastActivityAt: "2026-11-13T02:00:00Z",
    unread: true,
    mainMessagesSinceQuiet: 0,
  });
  rememberHistoryRows(environment, [row]);
  acknowledgeHistoryRow(environment, taskId, "2026-11-13T01:00:00Z");
  expect(historyTask(environment, taskId)?.unread).toBe(true);
  acknowledgeHistoryRow(environment, taskId, "2026-11-13T02:00:00Z");
  expect(historyTask(environment, taskId)?.unread).toBe(false);
  rememberHistoryRows(environment, [row]);
  expect(historyTask(environment, taskId)?.unread).toBe(false);
});
