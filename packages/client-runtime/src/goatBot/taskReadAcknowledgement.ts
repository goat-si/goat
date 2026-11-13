import type { ChannelTaskId, EnvironmentId } from "@goat/contracts";

/** Tasks whose acknowledged activity is remembered; a forgotten one costs one harmless resend. */
export const TASK_READ_ACKNOWLEDGED_LIMIT = 500;

/** Sends one acknowledgement; any result other than Success counts as a failure. */
export type TaskReadUpdate = (value: {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly taskId: ChannelTaskId; readonly readThrough: string };
}) => Promise<{ readonly _tag: string }>;

/** skipped: already in flight or already accepted, so nothing was sent. */
export type TaskReadAcknowledgementOutcome = "skipped" | "accepted" | "failed";

/** Requests on their way, by environment, task and activity, for every open view. */
const inFlight = new Set<string>();
/** By environment and task, the newest activity time the server accepted, oldest task first. */
const accepted = new Map<string, number>();

// JSON arrays keep ids apart whatever characters they contain.
const taskKey = (environmentId: EnvironmentId, taskId: ChannelTaskId) =>
  JSON.stringify([environmentId, taskId]);
const requestKey = (environmentId: EnvironmentId, taskId: ChannelTaskId, readThrough: string) =>
  JSON.stringify([environmentId, taskId, readThrough]);

function remember(task: string, at: number) {
  const known = accepted.get(task);
  if (known !== undefined && at <= known) return;
  accepted.delete(task);
  accepted.set(task, at);
  if (accepted.size > TASK_READ_ACKNOWLEDGED_LIMIT) {
    const oldest = accepted.keys().next().value;
    if (oldest !== undefined) accepted.delete(oldest);
  }
}

/**
 * Acknowledges a task's activity once while in flight and never again once accepted, for every
 * view on this client. A failure frees the request and is not retried here; the caller decides
 * whether a later trigger sends again. An activity that is not a time is never remembered.
 */
export function acknowledgeTaskRead({
  environmentId,
  taskId,
  readThrough,
  update,
}: {
  readonly environmentId: EnvironmentId;
  readonly taskId: ChannelTaskId;
  readonly readThrough: string;
  readonly update: TaskReadUpdate;
}): Promise<TaskReadAcknowledgementOutcome> {
  const key = requestKey(environmentId, taskId, readThrough);
  const at = Date.parse(readThrough);
  const known = accepted.get(taskKey(environmentId, taskId));
  if (inFlight.has(key) || (Number.isFinite(at) && known !== undefined && at <= known))
    return Promise.resolve("skipped");
  inFlight.add(key);
  return (
    update({ environmentId, input: { taskId, readThrough } })
      .then((result) => result._tag === "Success")
      // The command reports its own failures; a failure here only frees the request.
      .catch(() => false)
      .then((ok): TaskReadAcknowledgementOutcome => {
        inFlight.delete(key);
        if (!ok) return "failed";
        if (Number.isFinite(at)) remember(taskKey(environmentId, taskId), at);
        return "accepted";
      })
  );
}

export function resetTaskReadAcknowledgementsForTests() {
  inFlight.clear();
  accepted.clear();
}
