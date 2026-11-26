import {
  container,
  renderWork,
  reset,
  state,
  taskChanges,
  WorkWithChip,
} from "./mobileBotWorkTestHarness";
import { BotThreadRow, ChannelTaskId, EnvironmentId, ThreadId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import React, { act } from "react";
import { expect, it, vi } from "vite-plus/test";
import { appAtomRegistry } from "../../state/atom-registry";
import MobileBotApprovals from "./MobileBotApprovals";

const decodeRow = Schema.decodeUnknownSync(BotThreadRow);

it.each(["ready", "failed"])("shows chipless approvals with a %s Work list", async (list) => {
  reset();
  state.readApprovalAtoms = true;
  state.lookupCapable = true;
  const taskId = ChannelTaskId.make("task");
  const environmentId = EnvironmentId.make("env");
  const at = "2026-11-04T10:00:00.000Z";
  const worker = { environmentId, threadId: ThreadId.make("worker") };
  const row = decodeRow({
    kind: "task",
    task: { taskId, title: "Review", status: "running", updatedAt: at },
    view: { taskId, pinnedAt: null, doneAt: null, readThrough: null },
    lastActivityAt: at,
    unread: false,
    mainMessagesSinceQuiet: 0,
    worker,
  });
  const request = (requestId: string, threadId: ThreadId) => ({
    kind: "approval",
    since: at,
    approval: { requestId, threadId },
  });
  const serveApprovals = (...needsYou: ReturnType<typeof request>[]) =>
    state.lookup.mockResolvedValue(
      AsyncResult.success({
        task: { state: "known", row },
        attemptEvidence: { summary: "Checking the release manifest." },
        approvalObservation: {
          worker,
          needsYou,
        },
        codingRows: [],
        remoteWork: [],
        launchesTruncated: false,
        partial: false,
      }),
    );
  const workerApproval = request("request", worker.threadId);
  serveApprovals(workerApproval);
  appAtomRegistry.set(
    taskChanges,
    AsyncResult.success({ subscription: 1, value: { revision: 0 } }),
  );
  const onOpenThread = vi.fn();
  const renderTask = () =>
    renderWork(
      <WorkWithChip
        visible
        taskId={taskId}
        onOpenTask={() => {}}
        onOpenThread={onOpenThread}
        renderTaskApprovals={(taskObservation) => (
          <MobileBotApprovals
            environmentId={environmentId}
            threadId={ThreadId.make("bot")}
            taskId={taskId}
            chips={new Map()}
            taskObservation={taskObservation}
            onOpenThread={onOpenThread}
          />
        )}
      />,
    );
  await renderTask();
  expect(state.lookup).not.toHaveBeenCalled();
  Object.assign(
    state.task,
    list === "failed"
      ? { isPending: false, error: "Unreadable task view" }
      : { isPending: false, isSuccess: true, data: { rows: [row] } },
  );
  await renderTask();
  expect(container.textContent).toContain("1 waiting");
  expect(container.textContent).toContain("Latest update Checking the release manifest.");
  expect(container.textContent).not.toContain("Worker report missing");
  const link = container.querySelector<HTMLButtonElement>(
    '[aria-label="Open worker · Waiting worker"]',
  );
  expect(link).not.toBeNull();
  await act(async () => link?.click());
  expect(onOpenThread).toHaveBeenCalledWith({ environmentId, id: worker.threadId });
  serveApprovals(workerApproval, request("new-request", ThreadId.make("child")));
  await act(async () =>
    appAtomRegistry.set(
      taskChanges,
      AsyncResult.success({ subscription: 1, value: { revision: 1 } }),
    ),
  );
  expect(container.textContent).toContain("2 waiting");

  serveApprovals();
  await act(async () =>
    appAtomRegistry.set(
      taskChanges,
      AsyncResult.success({ subscription: 1, value: { revision: 2 } }),
    ),
  );
  expect(container.textContent).not.toContain("waiting");
  expect(container.querySelector('[aria-label="Open worker · Waiting worker"]')).toBeNull();
});

it("refreshes an open task's required results after a silent task change", async () => {
  reset();
  state.readApprovalAtoms = true;
  state.lookupCapable = true;
  state.snoozeCapable = true;
  const taskId = ChannelTaskId.make("task");
  const at = "2026-11-04T10:00:00.000Z";
  const row = decodeRow({
    kind: "task",
    task: { taskId, title: "Review", status: "running", updatedAt: at },
    view: { taskId, pinnedAt: null, doneAt: null, readThrough: null },
    lastActivityAt: at,
    unread: false,
    mainMessagesSinceQuiet: 0,
  });
  if (row.kind !== "task") throw new Error("expected a task");
  const result = (summary: string, state: "pending" | "accepted", updatedAt = row.task.updatedAt) =>
    AsyncResult.success({
      task: { state: "known", row: { ...row, task: { ...row.task, updatedAt } } },
      attemptEvidence: { summary },
      requiredDeliverables: [{ id: "build", criterion: "Build passes", attempt: 1, state }],
      codingRows: [],
      remoteWork: [],
      launchesTruncated: false,
      partial: false,
    });
  state.lookup.mockResolvedValue(result("Before", "pending"));
  Object.assign(state.task, { isPending: false, isSuccess: true, data: { rows: [row] } });
  appAtomRegistry.set(
    taskChanges,
    AsyncResult.success({ subscription: 1, value: { revision: 0 } }),
  );
  await renderWork(
    <WorkWithChip visible taskId={taskId} onOpenTask={() => {}} onOpenThread={() => {}} />,
  );
  expect(container.textContent).toContain("Before");
  state.lookup.mockResolvedValue(result("After", "accepted", "2026-11-04T10:01:00.000Z"));
  await act(async () =>
    appAtomRegistry.set(
      taskChanges,
      AsyncResult.success({ subscription: 1, value: { revision: 1 } }),
    ),
  );
  expect(container.textContent).toContain("After");
  expect(container.textContent).toContain("1/1");
});
