/**
 * GOAT Bot's work queue as a person sees it: each task is a work item whose state comes from the
 * task and from whether its outcome reached the requester, shown with its worker runs, which are
 * separate records. An item is done only when its outcome was delivered.
 *
 * @module channelWorkQueue
 */
import type { ChannelTask, ChannelWorkerRun } from "@goat/contracts";

export type WorkItemState =
  | "queued"
  | "in progress"
  | "waiting on you"
  | "result not sent yet"
  | "result not delivered"
  | "completed"
  | "failed"
  | "cancelled";

/** At most this many open items answer a "what's pending" read. */
const PENDING_ITEM_LIMIT = 20;

/**
 * The item state of a task, given the delivery state of its newest outcome message (undefined
 * when none was written yet). Finished work is only completed, failed or cancelled once that
 * message was delivered; until then it is still open.
 */
export const workItemState = (task: ChannelTask, delivery: string | undefined): WorkItemState => {
  switch (task.status) {
    case "received":
    case "dispatching":
      return "queued";
    case "running":
      return "in progress";
    case "waiting_input":
      return "waiting on you";
    case "completed":
    case "failed":
    case "cancelled":
      if (delivery === "delivered") return task.status;
      // Given up, or unknown after a crash mid-send: open until someone sees it.
      if (delivery === "failed" || delivery === "ambiguous") return "result not delivered";
      return "result not sent yet";
  }
};

export const isOpenItem = (state: WorkItemState) =>
  state !== "completed" && state !== "failed" && state !== "cancelled";

const age = (from: string, now: number) => {
  const minutes = Math.max(0, Math.round((now - Date.parse(from)) / 60_000));
  if (minutes < 60) return minutes + " min";
  const hours = Math.round(minutes / 60);
  return hours < 48 ? hours + " h" : Math.round(hours / 24) + " d";
};

/** "What's pending", newest first: each open item, its state and age, then its runs. */
export const pendingDigest = (
  items: ReadonlyArray<{
    readonly task: ChannelTask;
    readonly state: WorkItemState;
    readonly runs: ReadonlyArray<ChannelWorkerRun>;
    /** Why a queued item has not started, such as waiting for a free worker. */
    readonly note?: string | undefined;
  }>,
  now: number,
) => {
  const all = items
    .filter((item) => isOpenItem(item.state))
    .toSorted((left, right) => right.task.createdAt.localeCompare(left.task.createdAt));
  const open = all.slice(0, PENDING_ITEM_LIMIT);
  if (open.length === 0) return "Nothing is pending.";
  const more = all.length - open.length;
  return open
    .map((item) => {
      const host = item.task.worker?.host ?? item.task.host;
      const runs =
        item.runs.length === 0
          ? host === undefined
            ? []
            : ["  worker on " + host + " (its runs are reported there)"]
          : item.runs.map(
              (run, index) =>
                "  run " +
                (index + 1) +
                ": " +
                run.status +
                (run.endedAt === undefined ? ", for " + age(run.startedAt, now) : ""),
            );
      return [
        "- " +
          item.task.title +
          " [" +
          item.state +
          "] for " +
          item.task.requester.displayName +
          ", asked " +
          age(item.task.createdAt, now) +
          " ago (task " +
          item.task.taskId +
          ")",
        ...(item.note === undefined ? [] : ["  " + item.note]),
        ...item.task.openQuestions.map(
          (question) => "  waiting for an answer to: " + question.text,
        ),
        ...runs,
      ].join("\n");
    })
    .concat(more > 0 ? ["…and " + more + " older open items not listed."] : [])
    .join("\n");
};
