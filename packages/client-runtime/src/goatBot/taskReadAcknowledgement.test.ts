import { ChannelTaskId, EnvironmentId } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  acknowledgeTaskRead,
  resetTaskReadAcknowledgementsForTests,
  TASK_READ_ACKNOWLEDGED_LIMIT,
  taskReadAccepted,
  type TaskReadUpdate,
} from "./taskReadAcknowledgement.ts";

const at = "2026-11-09T00:00:00.000Z";
const later = "2026-11-09T01:00:00.000Z";

/** Resets the shared record and returns an update that answers Success unless told otherwise. */
function setup() {
  resetTaskReadAcknowledgementsForTests();
  return vi.fn<TaskReadUpdate>(async () => ({ _tag: "Success" }));
}

const ack = (update: TaskReadUpdate, taskId: string, readThrough = at, environmentId = "env") =>
  acknowledgeTaskRead({
    environmentId: EnvironmentId.make(environmentId),
    taskId: ChannelTaskId.make(taskId),
    readThrough,
    update,
  });

describe("acknowledgeTaskRead", () => {
  it("tells a skip for an accepted activity from a skip for one still in flight", async () => {
    const update = setup();
    const accepted = (readThrough: string) =>
      taskReadAccepted(EnvironmentId.make("env"), ChannelTaskId.make("task"), readThrough);
    let land = (_result: { _tag: string }) => {};
    update.mockImplementationOnce(() => new Promise((resolve) => (land = resolve)));
    const first = ack(update, "task", later);
    expect(accepted(later)).toBe(false);
    land({ _tag: "Success" });
    await first;
    expect(accepted(later)).toBe(true);
    expect(accepted(at)).toBe(true);
    expect(accepted("2026-11-09T02:00:00.000Z")).toBe(false);
    expect(accepted("not a time")).toBe(false);
  });

  it("sends a task's activity once while that request is in flight", async () => {
    const update = setup();
    let land = (_result: { _tag: string }) => {};
    update.mockImplementationOnce(() => new Promise((resolve) => (land = resolve)));
    const first = ack(update, "task");
    expect(await ack(update, "task")).toBe("skipped");
    land({ _tag: "Success" });
    expect(await first).toBe("accepted");
    expect(update).toHaveBeenCalledOnce();
  });

  it("skips an activity at or below one already accepted, and sends newer activity", async () => {
    const update = setup();
    expect(await ack(update, "task", later)).toBe("accepted");
    expect(await ack(update, "task", later)).toBe("skipped");
    expect(await ack(update, "task", at)).toBe("skipped");
    expect(await ack(update, "task", "2026-11-09T02:00:00.000Z")).toBe("accepted");
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("compares instants rather than the lexical order of timezone offsets", async () => {
    const update = setup();
    expect(await ack(update, "equal", "2026-11-13T01:00:00Z")).toBe("accepted");
    expect(await ack(update, "equal", "2026-11-13T10:00:00+09:00")).toBe("skipped");
    expect(await ack(update, "older", "2026-11-13T05:00:00Z")).toBe("accepted");
    expect(await ack(update, "older", "2026-11-13T09:00:00+09:00")).toBe("skipped");
    expect(await ack(update, "newer", "2026-11-13T13:00:00+09:00")).toBe("accepted");
    expect(await ack(update, "newer", "2026-11-13T05:00:00Z")).toBe("accepted");
    expect(update).toHaveBeenCalledTimes(4);
  });

  it("frees the request after a failure without retrying, so a later call sends again", async () => {
    const update = setup();
    update.mockResolvedValueOnce({ _tag: "Failure" });
    expect(await ack(update, "task")).toBe("failed");
    expect(update).toHaveBeenCalledOnce();
    expect(await ack(update, "task")).toBe("accepted");
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("treats a rejected update as a failure", async () => {
    const update = setup();
    update.mockRejectedValueOnce(new Error("socket closed"));
    expect(await ack(update, "task")).toBe("failed");
  });

  it("keeps ids apart when they would join into the same text", async () => {
    const update = setup();
    expect(await ack(update, "c", at, "a|b")).toBe("accepted");
    expect(await ack(update, "b|c", at, "a")).toBe("accepted");
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("never remembers an activity that is not a time", async () => {
    const update = setup();
    expect(await ack(update, "task", "not a date")).toBe("accepted");
    expect(await ack(update, "task", "not a date")).toBe("accepted");
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("retains exactly 500 acknowledged tasks and evicts the first of 501", async () => {
    const update = setup();
    expect(TASK_READ_ACKNOWLEDGED_LIMIT).toBe(500);
    for (let index = 1; index <= 501; index += 1)
      expect(await ack(update, `task-${index}`)).toBe("accepted");
    for (let index = 2; index <= 501; index += 1)
      expect(await ack(update, `task-${index}`)).toBe("skipped");
    expect(await ack(update, "task-1")).toBe("accepted");
    expect(update).toHaveBeenCalledTimes(502);
  });
});
