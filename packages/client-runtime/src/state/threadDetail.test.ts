import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { v2Now, v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";
import type { ThreadStructureVisibleTurnItem } from "./models.ts";
import {
  createEnvironmentThreadDetailAtoms,
  deriveWorkspaceMutationId,
  sameThreadStructure,
} from "./threadDetail.ts";
import { mergeOlderHistoryIntoProjection } from "./threadHistoryMerge.ts";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "./threadState.ts";

const later = DateTime.makeUnsafe("2026-06-20T00:00:01.000Z");

const assistant: OrchestrationV2TurnItem = {
  id: TurnItemId.make("item-assistant"),
  threadId: v2ThreadId,
  runId: RunId.make("run-1"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "running",
  title: null,
  startedAt: v2Now,
  completedAt: null,
  updatedAt: v2Now,
  type: "assistant_message",
  messageId: MessageId.make("message-assistant"),
  text: "Hel",
  streaming: true,
};

function withItem(item: OrchestrationV2TurnItem, updatedAt = v2Now) {
  return {
    ...v2Projection,
    turnItems: [item],
    visibleTurnItems: [
      {
        position: 0,
        visibility: "local" as const,
        sourceThreadId: v2ThreadId,
        sourceItemId: item.id,
        item,
      },
    ],
    updatedAt,
  };
}

function withRows(items: ReadonlyArray<OrchestrationV2TurnItem>): OrchestrationV2ThreadProjection {
  return {
    ...v2Projection,
    turnItems: items,
    visibleTurnItems: items.map((item, position) => ({
      position,
      visibility: "local" as const,
      sourceThreadId: v2ThreadId,
      sourceItemId: item.id,
      item,
    })),
  };
}

// Reducer copies of a counted array stay counted, so every streamed input counts its reads.
function countSlotReads() {
  const counter = { reads: 0 };
  class CountedRows<T> extends Array<T> {
    constructor(length = 0) {
      super(length);
      return new Proxy(this, {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/.test(key)) counter.reads++;
          return Reflect.get(target, key, receiver);
        },
      });
    }
  }
  return { counter, CountedRows };
}

const longConversation = (length: number) => {
  const message = (index: number) => ({
    ...assistant,
    id: TurnItemId.make(`item-${index}`),
    messageId: MessageId.make(`message-${index}`),
    ordinal: index,
  });
  const streaming = message(length - 1);
  const rows = [
    ...Array.from({ length: length - 1 }, (_, index) => ({
      ...message(index),
      text: "Done",
      status: "completed" as const,
      streaming: false,
    })),
    streaming,
  ];
  return { streaming, rows };
};

describe("sameThreadStructure", () => {
  const before = withItem(assistant);

  it("holds through streamed text", () => {
    const next = withItem({ ...assistant, text: "Hello", updatedAt: later }, later);
    expect(sameThreadStructure(before, next)).toBe(true);
  });

  it("sees the item finish streaming", () => {
    const next = withItem({ ...assistant, text: "Hello", streaming: false, status: "completed" });
    expect(sameThreadStructure(before, next)).toBe(false);
  });

  it("sees a new item", () => {
    const next = { ...before, turnItems: [assistant, { ...assistant, id: TurnItemId.make("b") }] };
    expect(sameThreadStructure(before, next)).toBe(false);
  });

  it("sees other fields change on a streaming item", () => {
    const next = withItem({ ...assistant, text: "Hello", title: "Answer" });
    expect(sameThreadStructure(before, next)).toBe(false);
  });

  it("holds through a visit mark", () => {
    const thread = { ...before.thread, lastVisitedAt: later, updatedAt: later };
    expect(sameThreadStructure(before, { ...before, thread })).toBe(true);
  });

  it("sees other thread changes", () => {
    const thread = { ...before.thread, title: "Renamed" };
    expect(sameThreadStructure(before, { ...before, thread })).toBe(false);
  });

  it("sees changes outside the turn items", () => {
    expect(sameThreadStructure(before, { ...before, runs: [] })).toBe(false);
  });
});

describe("lastVisitedAtAtom", () => {
  it("follows a visit mark the quiet thread holds through", () => {
    const projection = withItem(assistant);
    const state = Atom.make(
      AsyncResult.success({ ...EMPTY_ENVIRONMENT_THREAD_STATE, data: Option.some(projection) }),
    );
    const details = createEnvironmentThreadDetailAtoms(() => state);
    const ref = { environmentId: EnvironmentId.make("env"), threadId: v2ThreadId };
    const registry = AtomRegistry.make();
    const unmountQuiet = registry.mount(details.quietThreadAtom(ref));
    const unmountVisit = registry.mount(details.lastVisitedAtAtom(ref));
    const quietBefore = registry.get(details.quietThreadAtom(ref));

    const visited = { ...projection, thread: { ...projection.thread, lastVisitedAt: later } };
    registry.set(
      state,
      AsyncResult.success({ ...EMPTY_ENVIRONMENT_THREAD_STATE, data: Option.some(visited) }),
    );

    expect(registry.get(details.quietThreadAtom(ref))).toBe(quietBefore);
    expect(registry.get(details.lastVisitedAtAtom(ref))).toBe(later);
    unmountQuiet();
    unmountVisit();
    registry.dispose();
  });
});

describe("quietThreadAtom", () => {
  const ref = { environmentId: EnvironmentId.make("environment-1"), threadId: v2ThreadId };

  function setup(initial: OrchestrationV2ThreadProjection) {
    const stateAtom = Atom.make(
      AsyncResult.success({ ...EMPTY_ENVIRONMENT_THREAD_STATE, data: Option.some(initial) }),
    );
    const quietAtom = createEnvironmentThreadDetailAtoms(() => stateAtom).quietThreadAtom(ref);
    const registry = AtomRegistry.make();
    registry.mount(quietAtom);
    return {
      read: () => registry.get(quietAtom),
      [Symbol.dispose]: () => registry.dispose(),
      push: (projection: OrchestrationV2ThreadProjection | null) =>
        registry.set(
          stateAtom,
          AsyncResult.success({
            ...EMPTY_ENVIRONMENT_THREAD_STATE,
            data: Option.fromNullishOr(projection),
          }),
        ),
    };
  }

  it("keeps the same value through streamed text", () => {
    const thread = setup(withItem(assistant));
    const first = thread.read();
    thread.push(withItem({ ...assistant, text: "Hello", updatedAt: later }, later));
    thread.push(withItem({ ...assistant, text: "Hello there", updatedAt: later }, later));
    expect(thread.read()).toBe(first);
  });

  it("passes a structure change on", () => {
    const thread = setup(withItem(assistant));
    const first = thread.read();
    thread.push(withItem({ ...assistant, text: "Hello", updatedAt: later }, later));
    thread.push(withItem({ ...assistant, text: "Hello", status: "completed", streaming: false }));
    const next = thread.read();
    expect(next).not.toBe(first);
    expect(next?.projection.turnItems[0]).toMatchObject({ status: "completed", streaming: false });
  });

  it("discards structure held before the thread resets", () => {
    const initial = withItem(assistant);
    using thread = setup(initial);
    const first = thread.read();
    thread.push(replaceItem(initial, { ...assistant, text: "Hello" }));
    expect(thread.read()).toBe(first);
    thread.push(null);
    expect(thread.read()).toBeNull();
    const reset = withItem({ ...assistant, title: "Restored", text: "New snapshot" });
    thread.push(reset);
    expect(thread.read()).not.toBe(first);
    expect(thread.read()?.projection.turnItems[0]).toMatchObject({ title: "Restored" });
    thread.push(replaceItem(reset, { ...assistant, title: "Restored", text: "More text" }));
    expect(thread.read()?.projection.turnItems[0]).toMatchObject({ title: "Restored" });
  });

  it("leaves out the fields that streaming moves", () => {
    const thread = setup(withItem(assistant));
    const projection = thread.read()?.projection;
    expect(projection).not.toHaveProperty("updatedAt");
    expect(projection?.thread).not.toHaveProperty("updatedAt");
    expect(projection?.thread).not.toHaveProperty("lastVisitedAt");
    expect(projection?.turnItems[0]).not.toHaveProperty("text");
    expect(projection?.turnItems[0]).not.toHaveProperty("updatedAt");
    expect(projection?.visibleTurnItems[0]?.item).not.toHaveProperty("text");
    expect(projection?.visibleTurnItems[0]?.item).toMatchObject({
      messageId: assistant.messageId,
      streaming: true,
    });
  });
});

describe("timelineVisibleTurnItemsAtom", () => {
  const ref = { environmentId: EnvironmentId.make("environment-1"), threadId: v2ThreadId };

  function setup(initial: OrchestrationV2ThreadProjection) {
    const stateAtom = Atom.make(
      AsyncResult.success({ ...EMPTY_ENVIRONMENT_THREAD_STATE, data: Option.some(initial) }),
    );
    const timelineAtom = createEnvironmentThreadDetailAtoms(
      () => stateAtom,
    ).timelineVisibleTurnItemsAtom(ref);
    const registry = AtomRegistry.make();
    registry.mount(timelineAtom);
    return {
      read: () => registry.get(timelineAtom),
      [Symbol.dispose]: () => registry.dispose(),
      push: (projection: OrchestrationV2ThreadProjection) =>
        registry.set(
          stateAtom,
          AsyncResult.success({ ...EMPTY_ENVIRONMENT_THREAD_STATE, data: Option.some(projection) }),
        ),
    };
  }

  it("holds through streamed assistant text while the message reads its own text", () => {
    const stateAtom = Atom.make(
      AsyncResult.success({
        ...EMPTY_ENVIRONMENT_THREAD_STATE,
        data: Option.some<OrchestrationV2ThreadProjection>(withItem(assistant)),
      }),
    );
    const details = createEnvironmentThreadDetailAtoms(() => stateAtom);
    const timelineAtom = details.timelineVisibleTurnItemsAtom(ref);
    const textAtom = details.assistantMessageTextAtom(ref, assistant.id);
    const registry = AtomRegistry.make();
    registry.mount(timelineAtom);
    registry.mount(textAtom);
    const push = (item: OrchestrationV2TurnItem) =>
      registry.set(
        stateAtom,
        AsyncResult.success({
          ...EMPTY_ENVIRONMENT_THREAD_STATE,
          data: Option.some(withItem(item, later)),
        }),
      );
    const first = registry.get(timelineAtom);

    push({ ...assistant, text: "Hello", updatedAt: later });
    expect(registry.get(timelineAtom)).toBe(first);
    expect(registry.get(textAtom)).toBe("Hello");

    push({ ...assistant, text: "Hello", streaming: false, status: "completed" });
    expect(registry.get(timelineAtom)[0]?.item).toMatchObject({ text: "Hello", streaming: false });
    registry.dispose();
  });

  it("compares one row per consecutive streamed token in a long conversation", () => {
    const { counter, CountedRows } = countSlotReads();
    const { streaming, rows } = longConversation(200);
    const initial = withRows(rows);
    let projection: OrchestrationV2ThreadProjection = {
      ...initial,
      visibleTurnItems: CountedRows.from(initial.visibleTurnItems),
    };
    using timeline = setup(projection);
    const held = timeline.read();
    const readsPerToken: number[] = [];
    const heldPerToken: boolean[] = [];

    for (let token = 1; token <= 20; token++) {
      projection = replaceItem(projection, {
        ...streaming,
        text: `Hel${"l".repeat(token)}`,
        updatedAt: later,
      });
      counter.reads = 0;
      timeline.push(projection);
      heldPerToken.push(timeline.read() === held);
      readsPerToken.push(counter.reads);
    }

    expect(heldPerToken).toEqual(Array.from({ length: 20 }, () => true));
    // Each reader of the input touches only the replaced row, whatever the conversation's length.
    expect(readsPerToken).toEqual(Array.from({ length: 20 }, () => readsPerToken[0]));
    // The reducer's copies must inherit the counting array, or every token would read as 0.
    expect(readsPerToken[0]).toBeGreaterThan(0);
    expect(readsPerToken[0]).toBeLessThanOrEqual(8);
  });

  it("delivers a structure change on the update it arrives, after held tokens", () => {
    const reasoning: OrchestrationV2TurnItem = {
      ...assistant,
      id: TurnItemId.make("reasoning"),
      type: "reasoning",
      ordinal: 1,
    };
    const message = { ...assistant, ordinal: 2 };
    const second = {
      ...assistant,
      id: TurnItemId.make("item-second"),
      messageId: MessageId.make("message-second"),
      ordinal: 3,
    };
    let projection = withRows([reasoning, message]);
    using timeline = setup(projection);
    const step = (item: OrchestrationV2TurnItem) => {
      projection = replaceItem(projection, item);
      timeline.push(projection);
      return timeline.read();
    };
    const tokens = (item: typeof message, texts: ReadonlyArray<string>) => {
      const before = timeline.read();
      for (const text of texts) {
        expect(step({ ...item, text, updatedAt: later })).toBe(before);
      }
    };

    tokens(message, ["Hello", "Hello the", "Hello there"]);
    const afterReasoning = step({ ...reasoning, text: "Thinking", updatedAt: later });
    expect(afterReasoning[0]?.item).toMatchObject({ type: "reasoning", text: "Thinking" });

    tokens(message, ["Hello there,", "Hello there, I"]);
    expect(timeline.read()).toBe(afterReasoning);
    const afterNewItem = step(second);
    expect(afterNewItem.map((row) => row.item.id)).toEqual([reasoning.id, message.id, second.id]);

    tokens(second, ["And", "And then"]);
    const finished = step({
      ...message,
      text: "Hello there, I",
      status: "completed",
      streaming: false,
    });
    expect(finished).not.toBe(afterNewItem);
    expect(finished[1]?.item).toMatchObject({ status: "completed", streaming: false });

    // A resync replaces every array, so no hint relates it to the previous input.
    tokens(second, ["And then more"]);
    const resync = (next: OrchestrationV2ThreadProjection) => {
      projection = { ...next, visibleTurnItems: next.visibleTurnItems.slice() };
      timeline.push(projection);
      return timeline.read();
    };
    expect(resync(replaceItem(projection, { ...second, text: "Resynced", updatedAt: later }))).toBe(
      finished,
    );
    const restored = resync(replaceItem(projection, { ...reasoning, title: "Restored" }));
    expect(restored).not.toBe(finished);
    expect(restored[0]?.item).toMatchObject({ title: "Restored" });
  });
});

describe("assistantMessageTextAtom", () => {
  const ref = { environmentId: EnvironmentId.make("environment-1"), threadId: v2ThreadId };

  function setup(initial: OrchestrationV2ThreadProjection) {
    const stateAtom = Atom.make(
      AsyncResult.success({ ...EMPTY_ENVIRONMENT_THREAD_STATE, data: Option.some(initial) }),
    );
    const details = createEnvironmentThreadDetailAtoms(() => stateAtom);
    const registry = AtomRegistry.make();
    return {
      text: (itemId: string) => {
        const atom = details.assistantMessageTextAtom(ref, itemId);
        registry.mount(atom);
        return () => registry.get(atom);
      },
      [Symbol.dispose]: () => registry.dispose(),
      push: (projection: OrchestrationV2ThreadProjection) =>
        registry.set(
          stateAtom,
          AsyncResult.success({ ...EMPTY_ENVIRONMENT_THREAD_STATE, data: Option.some(projection) }),
        ),
    };
  }

  it("reads a bounded number of rows per token for the streaming last row of a long conversation", () => {
    const { counter, CountedRows } = countSlotReads();
    const { streaming, rows } = longConversation(200);
    const initial = withRows(rows);
    let projection: OrchestrationV2ThreadProjection = {
      ...initial,
      visibleTurnItems: CountedRows.from(initial.visibleTurnItems),
    };
    // Only this row's text atom is mounted, so every counted read belongs to it and its inputs.
    using thread = setup(projection);
    const text = thread.text(streaming.id);
    const readsPerToken: number[] = [];
    const textPerToken: Array<string | null> = [];

    for (let token = 1; token <= 20; token++) {
      projection = replaceItem(projection, {
        ...streaming,
        text: `Hel${"l".repeat(token)}`,
        updatedAt: later,
      });
      counter.reads = 0;
      thread.push(projection);
      textPerToken.push(text());
      readsPerToken.push(counter.reads);
    }

    expect(textPerToken).toEqual(
      Array.from({ length: 20 }, (_, index) => `Hel${"l".repeat(index + 1)}`),
    );
    // The reducer's copies must inherit the counting array, or every token would read as 0.
    expect(readsPerToken[0]).toBeGreaterThan(0);
    expect(readsPerToken).toEqual(Array.from({ length: 20 }, () => readsPerToken[0]));
    expect(readsPerToken[0]).toBeLessThanOrEqual(8);
  });

  it("returns the text of any assistant row and null for a missing or non-assistant row", () => {
    const reasoning: OrchestrationV2TurnItem = {
      ...assistant,
      id: TurnItemId.make("reasoning"),
      type: "reasoning",
      ordinal: 1,
    };
    const finished: OrchestrationV2TurnItem = {
      ...assistant,
      id: TurnItemId.make("finished"),
      messageId: MessageId.make("message-finished"),
      ordinal: 2,
      text: "Earlier answer",
      status: "completed",
      streaming: false,
    };
    const first = {
      ...assistant,
      id: TurnItemId.make("first"),
      messageId: MessageId.make("message-first"),
      ordinal: 3,
    };
    const second = {
      ...assistant,
      id: TurnItemId.make("second"),
      messageId: MessageId.make("message-second"),
      ordinal: 4,
      text: "Wor",
    };
    let projection = withRows([reasoning, finished, first, second]);
    using thread = setup(projection);
    const firstText = thread.text(first.id);
    const secondText = thread.text(second.id);
    const finishedText = thread.text(finished.id);
    const reasoningText = thread.text(reasoning.id);
    const missingText = thread.text("missing");

    // Two rows stream at once and the earlier, not last, one moves.
    projection = replaceItem(projection, { ...first, text: "Hello", updatedAt: later });
    thread.push(projection);

    expect(firstText()).toBe("Hello");
    expect(secondText()).toBe("Wor");
    expect(finishedText()).toBe("Earlier answer");
    expect(reasoningText()).toBeNull();
    expect(missingText()).toBeNull();
  });

  it("returns the newest row's text when a fork's inherited row shares the streaming row's id", () => {
    const shared = TurnItemId.make("shared");
    const inherited: OrchestrationV2TurnItem = {
      ...assistant,
      id: shared,
      ordinal: 1,
      text: "Parent's finished answer",
      status: "completed",
      streaming: false,
    };
    const local: OrchestrationV2TurnItem = { ...assistant, id: shared, ordinal: 2, text: "Live" };
    const parent = ThreadId.make("thread-parent");
    const projection: OrchestrationV2ThreadProjection = {
      ...v2Projection,
      turnItems: [local],
      visibleTurnItems: [
        {
          position: 0,
          visibility: "inherited",
          sourceThreadId: parent,
          sourceItemId: shared,
          item: inherited,
        },
        {
          position: 1,
          visibility: "local",
          sourceThreadId: v2ThreadId,
          sourceItemId: shared,
          item: local,
        },
      ],
    };
    using thread = setup(projection);

    expect(thread.text(shared)()).toBe("Live");
  });
});

it("only compares replaced entries in a streamed reducer delta", () => {
  const size = 100;
  let slotReads = 0;
  const countReads = <T>(items: ReadonlyArray<T>): ReadonlyArray<T> =>
    new Proxy(items, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) slotReads++;
        return Reflect.get(target, key, receiver);
      },
    });
  const items = Array.from({ length: size }, (_, index) => ({
    ...assistant,
    id: TurnItemId.make(`item-${index}`),
    ordinal: index,
  }));
  const before = {
    ...v2Projection,
    turnItems: countReads(items),
    visibleTurnItems: countReads(
      items.map((item, position) => ({
        item,
        position,
        visibility: "local" as const,
        sourceThreadId: v2ThreadId,
        sourceItemId: item.id,
      })),
    ),
  };
  const next = applyOrchestrationV2ProjectionEvent(before, {
    id: EventId.make("text-delta"),
    type: "turn-item.updated",
    threadId: v2ThreadId,
    occurredAt: later,
    payload: { ...items.at(-1)!, text: "Hello", updatedAt: later },
  });
  slotReads = 0;

  expect(sameThreadStructure(before, next!)).toBe(true);
  expect(slotReads).toBeLessThanOrEqual(2);
});

describe("derived thread state through a streamed message", () => {
  const ref = { environmentId: EnvironmentId.make("environment-1"), threadId: v2ThreadId };
  const runId = RunId.make("run-1");
  const streamed: OrchestrationV2ConversationMessage = {
    id: MessageId.make("message-assistant"),
    threadId: v2ThreadId,
    runId,
    nodeId: null,
    role: "assistant",
    text: "Hel",
    attachments: [],
    streaming: true,
    createdBy: "agent",
    creationSource: "provider",
    createdAt: v2Now,
    updatedAt: v2Now,
  };
  const queuedMessage: OrchestrationV2ConversationMessage = {
    ...streamed,
    id: MessageId.make("message-queued"),
    runId: RunId.make("run-2"),
    role: "user",
    text: "Then run the tests",
    streaming: false,
    createdBy: "user",
    creationSource: "mobile",
  };
  const queuedRun: OrchestrationV2Run = {
    id: RunId.make("run-2"),
    threadId: v2ThreadId,
    ordinal: 2,
    providerInstanceId: v2Projection.thread.providerInstanceId,
    modelSelection: v2Projection.thread.modelSelection,
    providerThreadId: null,
    userMessageId: queuedMessage.id,
    rootNodeId: null,
    activeAttemptId: null,
    status: "queued",
    requestedAt: v2Now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const checkpoint = (ordinal: number): OrchestrationV2Checkpoint => ({
    id: CheckpointId.make(`checkpoint-${ordinal}`),
    threadId: v2ThreadId,
    scopeId: CheckpointScopeId.make("scope"),
    runId,
    nodeId: NodeId.make("node"),
    parentCheckpointId: null,
    ordinalWithinScope: ordinal,
    appRunOrdinal: ordinal,
    ref: CheckpointRef.make(`refs/t3/checkpoint-${ordinal}`),
    status: "ready",
    files: [],
    capturedAt: v2Now,
  });
  const initial: OrchestrationV2ThreadProjection = {
    ...v2Projection,
    runs: [queuedRun],
    messages: [streamed, queuedMessage],
    checkpoints: [checkpoint(1)],
  };

  function setup() {
    const stateAtom = Atom.make(
      AsyncResult.success({ ...EMPTY_ENVIRONMENT_THREAD_STATE, data: Option.some(initial) }),
    );
    const details = createEnvironmentThreadDetailAtoms(() => stateAtom);
    const queue = details.queueWorkflowAtom(ref);
    const checkpoints = details.checkpointSummariesAtom(ref);
    const registry = AtomRegistry.make();
    registry.mount(queue);
    registry.mount(checkpoints);
    let projection = initial;
    return {
      queue: () => registry.get(queue),
      checkpoints: () => registry.get(checkpoints),
      apply: (event: Parameters<typeof applyOrchestrationV2ProjectionEvent>[1]) => {
        projection = applyOrchestrationV2ProjectionEvent(projection, event)!;
        registry.set(
          stateAtom,
          AsyncResult.success({ ...EMPTY_ENVIRONMENT_THREAD_STATE, data: Option.some(projection) }),
        );
      },
      [Symbol.dispose]: () => registry.dispose(),
    };
  }

  const messageUpdated = (message: OrchestrationV2ConversationMessage) => ({
    id: EventId.make(`event-${message.id}-${message.text.length}`),
    type: "message.updated" as const,
    threadId: v2ThreadId,
    occurredAt: later,
    payload: message,
  });

  it("keeps the queue workflow through streamed text and follows a queued message edit", () => {
    using thread = setup();
    const first = thread.queue();
    thread.apply(messageUpdated({ ...streamed, text: "Hello", updatedAt: later }));
    thread.apply(messageUpdated({ ...streamed, text: "Hello there", updatedAt: later }));
    expect(thread.queue()).toBe(first);

    thread.apply(messageUpdated({ ...queuedMessage, text: "Then run lint", updatedAt: later }));
    expect(thread.queue()?.queuedRuns.map((queued) => queued.text)).toEqual(["Then run lint"]);
  });

  it("keeps checkpoint summaries through streamed text and follows new assistant messages and checkpoints", () => {
    using thread = setup();
    const first = thread.checkpoints();
    thread.apply(messageUpdated({ ...streamed, text: "Hello", updatedAt: later }));
    thread.apply(messageUpdated({ ...streamed, text: "Hello there", updatedAt: later }));
    expect(thread.checkpoints()).toBe(first);

    const followUp = { ...streamed, id: MessageId.make("message-follow-up"), text: "Done" };
    thread.apply(messageUpdated(followUp));
    expect(thread.checkpoints().map((summary) => summary.assistantMessageId)).toEqual([
      followUp.id,
    ]);

    thread.apply({
      id: EventId.make("checkpoint-2"),
      type: "checkpoint.captured",
      threadId: v2ThreadId,
      occurredAt: later,
      payload: checkpoint(2),
    });
    expect(thread.checkpoints().map((summary) => summary.checkpointTurnCount)).toEqual([1, 2]);
  });
});

function replaceItem(projection: OrchestrationV2ThreadProjection, item: OrchestrationV2TurnItem) {
  return applyOrchestrationV2ProjectionEvent(projection, {
    id: EventId.make(`event-${item.id}`),
    type: "turn-item.updated",
    threadId: v2ThreadId,
    occurredAt: item.updatedAt,
    payload: item,
  })!;
}

it("matches full structure comparisons across streamed, batched, and reordered updates", () => {
  const message = { ...assistant, ordinal: 2 };
  const reasoning = {
    ...assistant,
    id: TurnItemId.make("reasoning"),
    type: "reasoning" as const,
    ordinal: 1,
  };
  const initial = mergeOlderHistoryIntoProjection(withItem(message), [
    withItem(reasoning).visibleTurnItems[0]!,
  ]);
  const updates = [
    { ...message, text: "Hello", updatedAt: later },
    { ...reasoning, text: "Thinking", updatedAt: later },
    { ...reasoning, text: "Done", status: "completed" as const, streaming: false },
    { ...message, text: "Hello there", updatedAt: later },
    { ...message, text: "Hello there", ordinal: 0 },
    { ...message, text: "More text", ordinal: 0 },
    { ...message, text: "More text", ordinal: 2 },
    { ...message, text: "More text", runId: RunId.make("another-run") },
  ];
  const projections = [initial];
  const withoutHints = (projection: OrchestrationV2ThreadProjection) => ({
    ...projection,
    turnItems: projection.turnItems.slice(),
    visibleTurnItems: projection.visibleTurnItems.slice(),
  });
  const consecutive: boolean[] = [];
  for (const item of updates) {
    const previous = projections.at(-1)!;
    const next = replaceItem(previous, item);
    consecutive.push(sameThreadStructure(previous, next));
    // All earlier snapshots include readers that skip one or several updates in a batch.
    for (const before of projections) {
      expect(sameThreadStructure(before, next)).toBe(
        sameThreadStructure(withoutHints(before), withoutHints(next)),
      );
    }
    projections.push(next);
  }

  // A resumed snapshot can reuse item ids while changing a different row.
  const snapshot = withoutHints(projections[1]!);
  const resumed = replaceItem(snapshot, { ...reasoning, title: "Restored reasoning" });
  const sibling = replaceItem(initial, { ...message, text: "Another stream" });
  const reconnected = replaceItem(resumed, { ...message, text: "Resumed stream" });
  for (const before of [initial, sibling, projections[1]!, resumed]) {
    expect(sameThreadStructure(before, reconnected)).toBe(
      sameThreadStructure(withoutHints(before), withoutHints(reconnected)),
    );
  }
  expect(sameThreadStructure(sibling, reconnected)).toBe(false);
  expect(sameThreadStructure(resumed, reconnected)).toBe(true);

  expect(consecutive).toEqual([true, true, false, true, false, true, false, false]);
  expect(sameThreadStructure(initial, projections[4]!)).toBe(false);
  expect(projections[5]!.visibleTurnItems.map((row) => [row.item.id, row.position])).toEqual([
    [assistant.id, 0],
    [reasoning.id, 1],
  ]);
  expect(projections[7]!.visibleTurnItems.map((row) => [row.item.id, row.position])).toEqual([
    [reasoning.id, 0],
    [assistant.id, 1],
  ]);
});

describe("deriveWorkspaceMutationId", () => {
  const item = (id: string, type: string, status: string) =>
    ({
      item: { id: TurnItemId.make(id), type, status },
    }) as unknown as ThreadStructureVisibleTurnItem;

  it("keys on the latest finished command or file change and the latest checkpoint", () => {
    expect(
      deriveWorkspaceMutationId(
        [
          item("edit", "file_change", "completed"),
          item("reply", "assistant_message", "completed"),
          item("command", "command_execution", "running"),
        ],
        "2026-01-01T00:00:00.000Z",
      ),
    ).toBe(JSON.stringify(["edit", "2026-01-01T00:00:00.000Z"]));
    expect(
      deriveWorkspaceMutationId(
        [item("edit", "file_change", "completed"), item("mcp", "dynamic_tool", "completed")],
        null,
      ),
    ).toBe(JSON.stringify(["mcp", null]));
  });

  it("is null before anything could have touched the workspace", () => {
    expect(deriveWorkspaceMutationId([item("reply", "assistant_message", "completed")], null)).toBe(
      null,
    );
  });
});
