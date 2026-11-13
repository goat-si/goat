import { rememberHistoryRows } from "./botWorkHistoryStore.test-support";
import { BotId, BotThreadRow, ChannelTaskId, EnvironmentId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import {
  historyTask,
  resetHistoryTasksForTests,
  updateHistoryView,
  beginHistoryRead,
  finishHistoryRead,
  historyScope,
  historyResult,
  syncHistoryCurrent,
} from "./botWorkHistoryStore";

const decode = Schema.decodeUnknownSync(BotThreadRow);
const env = EnvironmentId.make("round3");
const row = (id: string) =>
  decode({
    kind: "task",
    task: { taskId: id, title: id, status: "completed", updatedAt: "2026-11-13T00:00:00Z" },
    view: { taskId: id, pinnedAt: null, doneAt: null, readThrough: null },
    lastActivityAt: "2026-11-13T00:00:00Z",
    unread: false,
    mainMessagesSinceQuiet: 0,
  });

it("a late history page does not undo a pinned view", () => {
  resetHistoryTasksForTests();
  const task = row("late");
  if (task.kind !== "task") throw new Error("task fixture");
  rememberHistoryRows(env, [task]);
  const token = beginHistoryRead(env, null);
  if (!token) throw new Error("Expected a history request");
  updateHistoryView(env, task.task.taskId, { ...task.view, pinnedAt: "2026-11-13T01:00:00Z" });
  finishHistoryRead(env, null, token, [{ rows: [task], mainMessageCount: 0, history: {} }], true);
  expect(historyTask(env, task.task.taskId)?.view.pinnedAt).toBe("2026-11-13T01:00:00Z");
});

it("keeps hidden task state after other history is read", () => {
  resetHistoryTasksForTests();
  const task = row("hidden");
  if (task.kind !== "task") throw new Error("task fixture");
  rememberHistoryRows(env, [task]);
  updateHistoryView(env, task.task.taskId, { ...task.view, pinnedAt: "2026-11-13T01:00:00Z" });
  rememberHistoryRows(
    env,
    Array.from({ length: 500 }, (_, index) => row(`other-${index}`)),
  );
  expect(historyTask(env, task.task.taskId)?.view.pinnedAt).toBe("2026-11-13T01:00:00Z");
});

it("keeps the first 500 tasks when a history page crosses the bound", () => {
  resetHistoryTasksForTests();
  const items = Array.from({ length: 501 }, (_, index) => row(`item-${index}`));
  rememberHistoryRows(env, items);
  expect(historyTask(env, ChannelTaskId.make("item-0"))?.task.title).toBe("item-0");
  expect(historyTask(env, ChannelTaskId.make("item-499"))?.task.title).toBe("item-499");
  expect(historyTask(env, ChannelTaskId.make("item-500"))).toBeUndefined();
});

it("drops cached history when a later answer has no history marker", () => {
  resetHistoryTasksForTests();
  const task = row("downgrade");
  if (task.kind !== "task") throw new Error("task fixture");
  rememberHistoryRows(env, [task]);
  const token = beginHistoryRead(env, null);
  if (!token) throw new Error("Expected a history request");
  finishHistoryRead(env, null, token, [], false);
  expect(historyTask(env, task.task.taskId)).toBeUndefined();
});

it("keeps separate bot walks and invalidates a page from an older list revision", () => {
  resetHistoryTasksForTests();
  const member = BotId.make("member");
  syncHistoryCurrent(env, null, 1, []);
  syncHistoryCurrent(env, member, 1, []);
  const stale = beginHistoryRead(env, null);
  const other = beginHistoryRead(env, member);
  if (!stale || !other) throw new Error("Expected both reads");
  syncHistoryCurrent(env, null, 2, []);
  finishHistoryRead(
    env,
    null,
    stale,
    [{ rows: [row("stale")], mainMessageCount: 0, history: {} }],
    true,
  );
  finishHistoryRead(
    env,
    member,
    other,
    [{ rows: [row("member")], mainMessageCount: 0, history: {} }],
    true,
  );
  const main = historyScope(env, null);
  const memberScope = historyScope(env, member);
  if (!main || !memberScope) throw new Error("Expected both scopes");
  expect(historyResult(main).rows).toEqual([]);
  expect(historyResult(memberScope).rows).toHaveLength(1);
});
