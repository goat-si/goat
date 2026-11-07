import {
  EventId,
  MessageId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadTextAppendDecoder, makeThreadTextAppendEncoder } from "./threadTextAppend.ts";

const threadId = ThreadId.make("thread:text-append");
const at = DateTime.makeUnsafe("2026-11-01T00:00:00.000Z");

const assistantItem = (
  sequence: number,
  text: string,
  options: { readonly omitted?: boolean; readonly streaming?: boolean } = {},
): OrchestrationV2ThreadStreamItem => ({
  kind: "event",
  sequence,
  event: {
    id: EventId.make(`event-${sequence}`),
    type: "turn-item.updated",
    threadId,
    occurredAt: at,
    payload: {
      id: TurnItemId.make("item"),
      type: "assistant_message",
      messageId: MessageId.make("message"),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running",
      title: null,
      startedAt: at,
      completedAt: null,
      updatedAt: at,
      text,
      ...(options.omitted === true ? { textOmitted: true as const } : {}),
      streaming: options.streaming ?? true,
    } satisfies OrchestrationV2TurnItem,
  },
});

describe("thread text appends", () => {
  it("resolves every item to the text the server sent, and appends only plain prefix growth", () => {
    const sent = [
      assistantItem(1, "Hel"),
      assistantItem(2, "Hello"),
      assistantItem(3, "", { omitted: true }),
      assistantItem(4, "Hello, w"),
      assistantItem(5, "Hello, world"),
      assistantItem(6, "Goodbye"),
      assistantItem(7, "Goodbye!", { streaming: false }),
      assistantItem(8, "Goodbye!!"),
    ];
    const encode = makeThreadTextAppendEncoder();
    const decode = makeThreadTextAppendDecoder();
    const wire = sent.map(encode);

    expect(wire.map((item) => item.kind)).toEqual([
      "event",
      "text-append",
      "event",
      "event",
      "text-append",
      "event",
      "text-append",
      "event",
    ]);
    expect(wire.map(decode)).toEqual(sent);
  });

  it("rejects an append whose offset is not the length of the text this side holds", () => {
    const encode = makeThreadTextAppendEncoder();
    const [, append] = [assistantItem(1, "Hel"), assistantItem(2, "Hello")].map(encode);
    expect(append?.kind).toBe("text-append");

    const missed = makeThreadTextAppendDecoder();
    expect(append === undefined ? undefined : missed(append)).toBeNull();

    const stale = makeThreadTextAppendDecoder();
    stale(assistantItem(1, "He"));
    expect(append === undefined ? undefined : stale(append)).toBeNull();
  });
});
