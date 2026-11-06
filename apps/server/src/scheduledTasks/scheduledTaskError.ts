import * as Cause from "effect/Cause";
import { ScheduledTaskError, type ScheduledTaskId } from "@goat/contracts";

export function taskError(message: string, input?: { taskId?: ScheduledTaskId; cause?: unknown }) {
  return new ScheduledTaskError({
    message,
    ...(input?.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input?.cause === undefined ? {} : { cause: input.cause }),
  });
}

export function dispatchFailureDetails(result: import("effect/Exit").Exit<unknown, unknown>) {
  if (
    result._tag !== "Failure" ||
    !result.cause.reasons.every((reason) => reason._tag === "Fail")
  ) {
    return { dispatchEvidence: "unresolved" as const, dispatchError: null };
  }
  let failure: unknown = Cause.squash(result.cause);
  for (
    let depth = 0;
    depth < 8 && failure instanceof Error && failure.cause !== undefined;
    depth++
  ) {
    failure = failure.cause;
  }
  const message = failure instanceof Error ? failure.message : String(failure);
  return {
    dispatchEvidence: "rejected" as const,
    dispatchError:
      message.split("\n")[0]?.slice(0, 1000) || "The scheduled run could not be dispatched.",
  };
}
