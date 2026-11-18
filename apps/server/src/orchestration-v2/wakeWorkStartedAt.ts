import {
  orchestrationV2RunWorkStartedAt,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type RunId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";

export function wakeWorkStartedAt(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "subagents">,
  trigger: Pick<
    OrchestrationV2ConversationMessage,
    "createdBy" | "creationSource" | "senderThreadId"
  > & {
    readonly notification?: unknown;
    readonly delegatedCompletion?: unknown;
    readonly restartContinuationOfRunId?: RunId | undefined;
  },
  delivery: "immediate" | "automatic-queue" | "explicit-queue" = "immediate",
): Pick<OrchestrationV2Run, "workStartedAt"> {
  if (
    trigger.notification === undefined &&
    trigger.delegatedCompletion === undefined &&
    trigger.restartContinuationOfRunId === undefined &&
    !(
      trigger.createdBy === "agent" &&
      trigger.creationSource === "mcp" &&
      trigger.senderThreadId !== undefined &&
      (delivery === "automatic-queue" ||
        (delivery === "immediate" &&
          projection.subagents.some(
            (subagent) =>
              subagent.origin === "app_owned" && subagent.childThreadId === trigger.senderThreadId,
          )))
    )
  ) {
    return {};
  }
  const previous = projection.runs
    .flatMap((run) => (run.startedAt === null ? [] : [{ run, startedAt: run.startedAt }]))
    .toSorted(
      (left, right) =>
        DateTime.Order(right.startedAt, left.startedAt) || right.run.ordinal - left.run.ordinal,
    )[0]?.run;
  return previous === undefined ? {} : { workStartedAt: orchestrationV2RunWorkStartedAt(previous) };
}
