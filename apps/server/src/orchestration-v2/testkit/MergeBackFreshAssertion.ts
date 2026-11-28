import { assert } from "@effect/vitest";
import { CommandId, MessageId, type ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { OrchestratorV2Shape } from "../Orchestrator.ts";

export const assertMergeBackFreshMessage = Effect.fn("assertMergeBackFreshMessage")(function* (
  orchestrator: OrchestratorV2Shape,
  threadId: ThreadId,
) {
  const result = yield* orchestrator
    .dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("runtime-layer-merge-fresh-message"),
      threadId,
      messageId: MessageId.make("runtime-layer-merge-fresh-message"),
      text: "Start over",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      freshContext: true,
      createdBy: "user",
      creationSource: "web",
    })
    .pipe(Effect.flip);
  assert.include(
    String(result.cause),
    "Send a message without /clear to apply the merged context first.",
  );
});
