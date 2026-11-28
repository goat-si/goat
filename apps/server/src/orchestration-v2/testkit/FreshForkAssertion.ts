import { assert } from "@effect/vitest";
import { CommandId, MessageId, ScheduledTaskId, type ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { OrchestratorV2Shape } from "../Orchestrator.ts";

export const assertFreshFork = Effect.fn("assertFreshFork")(function* (
  orchestrator: OrchestratorV2Shape,
  threadId: ThreadId,
) {
  const send = (scheduled: boolean) =>
    orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(scheduled ? "fresh-fork-scheduled" : "fresh-fork-send"),
      threadId,
      messageId: MessageId.make(scheduled ? "fresh-fork-scheduled" : "fresh-fork-send"),
      ...(scheduled ? { scheduledTaskId: ScheduledTaskId.make("fresh-fork-task") } : {}),
      text: "Start over",
      attachments: [],
      freshContext: true,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
  const scheduled = yield* send(true).pipe(Effect.flip);
  assert.include(String(scheduled.cause), "still being applied");
  yield* send(false);
  const fork = yield* orchestrator.getThreadProjection(threadId);
  assert.isTrue(fork.runs.at(-1)?.freshContext === true);
  assert.deepEqual(
    fork.contextTransfers
      .filter((transfer) => transfer.type === "fork")
      .map((transfer) => transfer.status),
    ["superseded"],
  );
});
