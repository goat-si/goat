/**
 * Whether a channel task's worker thread may still act after its task ended: a run that has not
 * ended, background work, a cloud task, a pending native request, or a live subagent. A retry and
 * the notes guard both wait for this before treating the worker as stopped.
 */
import type { ChannelTask } from "@goat/contracts";
import { derivePendingBackgroundWork } from "@goat/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { workerLaunchIdsFor } from "./channelIds.ts";
import {
  ENDED_RUN_STATUSES,
  isThreadMissing,
  STOP_LAUNCH_GRACE_MS,
} from "./channelWorkerObservation.ts";

const LIVE_SUBAGENT = new Set(["idle", "pending", "running", "waiting"]);

export const makeWorkerLive = (
  threads: ThreadManagement.ThreadManagementService["Service"],
  spanName: string,
) =>
  Effect.fn(spanName)(function* (task: ChannelTask) {
    const threadId =
      task.worker?.threadId ?? workerLaunchIdsFor(task.taskId, task.generation).threadId;
    const read = yield* threads
      .getThreadRecords(
        threadId,
        ["runs", "providerThreads", "turnItems", "subagents", "runtimeRequests"],
        { turnItemStatuses: ["pending", "running", "waiting"] },
      )
      .pipe(Effect.result);
    if (read._tag === "Failure") {
      if (!isThreadMissing(read.failure)) return true;
      // Never claimed for a launch: there is no thread to wait for.
      if (task.target === undefined) return false;
      // A launch still in flight lands on this id; the same grace a stop waits.
      const endedAt = Date.parse(task.completedAt ?? task.updatedAt);
      return DateTime.toEpochMillis(yield* DateTime.now) - endedAt <= STOP_LAUNCH_GRACE_MS;
    }
    const records = read.success;
    const runs = records.runs;
    const latestRun = runs.findLast((run) => run.status !== "queued");
    const background =
      latestRun !== undefined &&
      derivePendingBackgroundWork({
        latestRun,
        providerThreads: records.providerThreads,
        turnItems: records.turnItems,
        activeProviderThreadId: records.thread.activeProviderThreadId,
        runs,
      }).length > 0;
    const cloud = records.providerThreads.some(
      (thread) =>
        thread.cloudTask?.status === "running" || thread.cloudTask?.status === "submitting",
    );
    return (
      runs.some((run) => !ENDED_RUN_STATUSES.has(run.status)) ||
      background ||
      cloud ||
      records.runtimeRequests.some((request) => request.status === "pending") ||
      records.subagents.some(
        (child) =>
          LIVE_SUBAGENT.has(child.status) ||
          child.completionDelivery?.state === "pending" ||
          child.completionDelivery?.state === "claimed",
      )
    );
  });
