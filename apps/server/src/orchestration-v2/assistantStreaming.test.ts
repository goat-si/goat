import { describe, expect, it } from "vite-plus/test";
import { makeAssistantStreamingFilter, splitBufferedAssistantText } from "./assistantStreaming.ts";
import {
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import { sealAssistantTextEvent } from "./Adapters/AssistantTextBoundary.ts";

const assistantEvent = (text: string): ProviderAdapter.ProviderAdapterV2Event => ({
  type: "turn_item.updated",
  driver: ProviderDriverKind.make("codex"),
  turnItem: {
    id: TurnItemId.make("receipt"),
    threadId: ThreadId.make("goat-bot-session:test:1"),
    runId: RunId.make("run"),
    nodeId: NodeId.make("node"),
    providerThreadId: ProviderThreadId.make("provider-thread"),
    providerTurnId: ProviderTurnId.make("provider-turn"),
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "running",
    title: null,
    startedAt: DateTime.makeUnsafe(0),
    completedAt: null,
    updatedAt: DateTime.makeUnsafe(0),
    type: "assistant_message",
    messageId: MessageId.make("receipt-message"),
    text,
    streaming: true,
  },
});

it.each(["paragraph", "turn"] as const)(
  "passes only the first receipt line before the %s gate",
  (mode) => {
    const filter = makeAssistantStreamingFilter(mode, { receiptLine: true });
    const opening = assistantEvent("Checking\nPartial body");
    expect(filter(assistantEvent("Check"), 0)).toBeNull();
    const first = filter(opening, 1);
    expect(first).toMatchObject({
      turnItem: { text: "Checking\n", streaming: true, completedAt: null },
    });
    expect(filter(assistantEvent("Checking\nPartial body more"), 2)).toBeNull();
    expect(makeAssistantStreamingFilter(mode)(opening, 1)).toBeNull();
  },
);

it.each(["paragraph", "turn"] as const)(
  "passes a tool-sealed receipt without completing it in %s mode",
  (mode) => {
    const filter = makeAssistantStreamingFilter(mode, { receiptLine: true });
    expect(filter(assistantEvent("Checking"), 0)).toBeNull();
    expect(filter(sealAssistantTextEvent(assistantEvent("Checking")), 1)).toMatchObject({
      turnItem: { text: "Checking", streaming: true, completedAt: null },
    });
    expect(filter(assistantEvent("Checking more"), 500)).toBeNull();
  },
);

it.each(["paragraph", "turn"] as const)("nested text cannot consume the %s receipt", (mode) => {
  const filter = makeAssistantStreamingFilter(mode, { receiptLine: true });
  const event = assistantEvent("Nested\n");
  if (event.type !== "turn_item.updated") throw new Error("Expected text item.");
  expect(filter({ ...event, turnItem: { ...event.turnItem, runId: null } }, 0)).toBeNull();
  expect(filter(assistantEvent("Root\n"), 1)).toMatchObject({ turnItem: { text: "Root\n" } });
});

describe("V2 assistant streaming", () => {
  it("keeps code fences intact", () => {
    expect(splitBufferedAssistantText("Intro\n\n```ts\nx()\n\n")).toEqual({
      ready: "Intro\n\n",
      rest: "```ts\nx()\n\n",
    });
    expect(splitBufferedAssistantText("```ts\nx()\n```\nrest")).toEqual({
      ready: "```ts\nx()\n```\n",
      rest: "rest",
    });
  });
});

it("holds a streamed section heading until its content has a boundary", () => {
  expect(splitBufferedAssistantText("Intro\n\n## Results\n\n")).toEqual({
    ready: "Intro\n\n",
    rest: "## Results\n\n",
  });
  expect(splitBufferedAssistantText("**Results**\n\nBody\n\nNext")).toEqual({
    ready: "**Results**\n\nBody\n\n",
    rest: "Next",
  });
});
