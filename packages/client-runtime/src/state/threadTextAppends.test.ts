import {
  EventId,
  MessageId,
  ThreadId,
  type OrchestrationV2ThreadStreamItem,
} from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { resolveThreadTextAppends } from "./threadTextAppends.ts";

const threadId = ThreadId.make("thread:text-appends");
const at = DateTime.makeUnsafe("2026-11-01T00:00:00.000Z");

const message = (
  kind: "event" | "text-append",
  sequence: number,
  text: string,
): OrchestrationV2ThreadStreamItem => {
  const event = {
    id: EventId.make(`event-${sequence}`),
    type: "message.updated" as const,
    threadId,
    occurredAt: at,
    payload: {
      id: MessageId.make("message"),
      threadId,
      runId: null,
      nodeId: null,
      createdBy: "agent" as const,
      creationSource: "provider" as const,
      role: "assistant" as const,
      text,
      attachments: [],
      streaming: true,
      createdAt: at,
      updatedAt: at,
    },
  };
  return kind === "event"
    ? { kind, sequence, event }
    : { kind, sequence, offset: "Hel".length, event };
};

describe("resolveThreadTextAppends", () => {
  it.effect("hands the thread state whole entities rebuilt from appends", () =>
    Effect.gen(function* () {
      const items = yield* resolveThreadTextAppends(
        threadId,
        Stream.make(message("event", 1, "Hel"), message("text-append", 2, "lo")),
      ).pipe(Stream.runCollect);
      expect(Array.from(items)).toEqual([message("event", 1, "Hel"), message("event", 2, "Hello")]);
    }),
  );

  it.effect("fails the subscription with an expected error when an append misses its text", () =>
    Effect.gen(function* () {
      const result = yield* resolveThreadTextAppends(
        threadId,
        Stream.make(message("event", 1, "He"), message("text-append", 2, "lo")),
      ).pipe(Stream.runCollect, Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("OrchestrationV2GetThreadProjectionError");
      }
    }),
  );
});
