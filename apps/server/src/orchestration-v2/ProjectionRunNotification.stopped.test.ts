import { assert, it } from "@effect/vitest";
import { RunId, ThreadId, type OrchestrationV2DomainEvent } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { notificationCompletions } from "./ProjectionRunNotification.ts";

it("does not advance the unread cursor for stopped runs", () => {
  const threadId = ThreadId.make("stopped-thread");
  const event = (status: "completed" | "interrupted" | "cancelled", time: string) =>
    ({
      type: "run.updated",
      threadId,
      payload: { id: RunId.make(status), status, completedAt: DateTime.makeUnsafe(time) },
    }) as OrchestrationV2DomainEvent;
  const completed = event("completed", "2026-01-01T11:00:00Z");
  const interrupted = event("interrupted", "2026-01-01T12:00:00Z");
  const cancelled = event("cancelled", "2026-01-01T13:00:00Z");
  assert.deepStrictEqual(
    notificationCompletions([completed, interrupted, cancelled]).get(threadId),
    DateTime.makeUnsafe("2026-01-01T11:00:00Z"),
  );
});
