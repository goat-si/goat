import { ChannelTaskId, EnvironmentId } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  acknowledgeTaskRead,
  resetTaskReadAcknowledgementsForTests,
  TASK_READ_ACKNOWLEDGED_LIMIT,
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

  it("forgets the oldest task once more than the limit are remembered", async () => {
    const update = setup();
    for (let index = 0; index <= TASK_READ_ACKNOWLEDGED_LIMIT; index += 1)
      await ack(update, `task-${index}`);
    expect(update).toHaveBeenCalledTimes(TASK_READ_ACKNOWLEDGED_LIMIT + 1);
    // task-0 was dropped, so it is sent again (dropping task-1 in turn); task-2 is still remembered.
    expect(await ack(update, "task-0")).toBe("accepted");
    expect(await ack(update, "task-2")).toBe("skipped");
  });
});
