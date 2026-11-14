import { describe, expect, it } from "vite-plus/test";
import { RunId, TurnItemId } from "@goat/contracts";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { deriveThreadPendingBackgroundTasks } from "./threadPendingBackgroundTasks";

describe("deriveThreadPendingBackgroundTasks", () => {
  const base = makeThreadProjectionFixture();
  const run = (ordinal: number, status: string) => ({
    id: RunId.make(`run-${ordinal}`),
    ordinal,
    status,
  });
  const item = (ordinal: number, type: string, nativeId: string, input: string) => ({
    id: TurnItemId.make(`item-${nativeId}`),
    type,
    status: "running",
    title: null,
    runId: RunId.make(`run-${ordinal}`),
    nativeItemRef: { nativeId },
    input,
  });
  const projection = (overrides: object) =>
    ({ ...base, ...overrides }) as unknown as ReturnType<typeof makeThreadProjectionFixture>;

  it.each(["queued", "preparing", "running"])(
    "keeps an earlier run's background shell while a %s follow-up run has a foreground command",
    (followUpStatus) => {
      expect(
        deriveThreadPendingBackgroundTasks(
          projection({
            runs: [run(1, "completed"), run(2, followUpStatus)],
            turnItems: [
              item(1, "command_execution", "shell-1", "sleep 600"),
              item(2, "command_execution", "shell-2", "sleep 15"),
            ],
          }),
        ),
      ).toEqual([{ taskId: "shell-1", description: "sleep 600", kind: "command" }]);
    },
  );

  it("does not list a live run's child from the provider roster as background", () => {
    // The roster is not run-tied; Muse keys it by the child session id its rows carry.
    expect(
      deriveThreadPendingBackgroundTasks(
        projection({
          runs: [run(1, "completed"), run(2, "running")],
          providerThreads: [
            {
              id: "provider-thread-1",
              providerInstanceId: base.thread.providerInstanceId,
              pendingBackgroundTasks: [
                { taskId: "child-session-1", kind: "subagent" },
                { taskId: "child-session-2", kind: "subagent" },
              ],
            },
          ],
          turnItems: [
            { ...item(1, "subagent", "child-session-1", ""), prompt: "child 1" },
            { ...item(2, "subagent", "child-session-2", ""), prompt: "child 2" },
          ],
        }),
      ),
    ).toEqual([
      {
        taskId: "child-session-1",
        kind: "subagent",
        providerInstanceId: base.thread.providerInstanceId,
      },
    ]);
  });

  it("keeps an earlier run's roster-only monitor while a follow-up run executes", () => {
    // Claude completes the Monitor launch row on success; only the roster tracks the task.
    expect(
      deriveThreadPendingBackgroundTasks(
        projection({
          runs: [run(1, "completed"), run(2, "running")],
          providerThreads: [
            {
              id: "provider-thread-1",
              providerInstanceId: base.thread.providerInstanceId,
              pendingBackgroundTasks: [{ taskId: "b1htjkjev", kind: "monitor" }],
            },
          ],
          turnItems: [
            { ...item(1, "dynamic_tool", "toolu-monitor", ""), status: "completed" },
            item(2, "command_execution", "shell-2", "sleep 15"),
          ],
        }),
      ),
    ).toEqual([{ taskId: "b1htjkjev", kind: "monitor" }]);
  });

  it("keeps the provider roster while a follow-up run only waits in the queue", () => {
    expect(
      deriveThreadPendingBackgroundTasks(
        projection({
          runs: [run(1, "waiting"), run(2, "queued")],
          providerThreads: [
            {
              id: "provider-thread-1",
              providerInstanceId: base.thread.providerInstanceId,
              pendingBackgroundTasks: [{ taskId: "task-1", kind: "background_task" }],
            },
          ],
        }),
      ),
    ).toEqual([{ taskId: "task-1", kind: "background_task" }]);
  });
});
