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
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { it as effectIt, assert } from "@effect/vitest";
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

effectIt.effect("publishes an idle paragraph but waits while its text keeps growing", () =>
  Effect.gen(function* () {
    const filter = makeAssistantStreamingFilter("paragraph");
    const now = Clock.currentTimeMillis;
    assert.isNull(filter(assistantEvent("One"), yield* now));
    yield* TestClock.adjust("600 millis");
    assert.isNull(filter(assistantEvent("One more"), yield* now));
    yield* TestClock.adjust("600 millis");
    assert.deepEqual(filter.takeIdleFlushes(yield* now), []);
    yield* TestClock.adjust("200 millis");
    assert.deepEqual(filter.takeIdleFlushes(yield* now), [assistantEvent("One more")]);
  }),
);

it("never reopens a finalized snapshot when an old idle deadline fires", () => {
  const filter = makeAssistantStreamingFilter("paragraph");
  const pending = assistantEvent("Partial");
  expect(filter(pending, 0)).toBeNull();
  if (pending.type !== "turn_item.updated") throw new Error("Expected assistant item");
  const final = {
    ...pending,
    turnItem: { ...pending.turnItem, text: "Finished", streaming: false },
  };
  expect(filter(final, 400)).toEqual(final);
  expect(filter.takeIdleFlushes(800)).toEqual([]);
});

it("preserves receipt gating and only releases the remainder in paragraph mode", () => {
  const filter = makeAssistantStreamingFilter("paragraph", { receiptLine: true });
  expect(filter(assistantEvent("Receiving"), 0)).toBeNull();
  expect(filter.takeIdleFlushes(800)).toEqual([]);
  expect(filter(assistantEvent("Receiving\nWorking"), 900)).toMatchObject({
    turnItem: { text: "Receiving\n" },
  });
  expect(filter.takeIdleFlushes(1700)).toMatchObject([
    { turnItem: { text: "Receiving\nWorking" } },
  ]);
  const turn = makeAssistantStreamingFilter("turn", { receiptLine: true });
  turn(assistantEvent("Receiving\nWorking"), 0);
  expect(turn.takeIdleFlushes(5000)).toEqual([]);
});

it("does not shrink a snapshot after an idle flush and still permits rewrites", () => {
  const filter = makeAssistantStreamingFilter("paragraph");
  expect(filter(assistantEvent("First\n\nunfinished"), 0)).toMatchObject({
    turnItem: { text: "First\n\n" },
  });
  filter.takeIdleFlushes(800);
  expect(filter(assistantEvent("First\n\nunfinished more"), 1300)).toBeNull();
  expect(filter.takeIdleFlushes(2100)).toMatchObject([
    { turnItem: { text: "First\n\nunfinished more" } },
  ]);
  expect(filter(assistantEvent("Rewritten\n\n"), 2600)).toMatchObject({
    turnItem: { text: "Rewritten\n\n" },
  });
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
