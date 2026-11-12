import { describe, expect, it } from "vite-plus/test";
import {
  followsCurrentConversation,
  isBufferedProviderNotification,
  queueTailModelSelection,
  queuedRunModelSelection,
} from "./NotificationMailbox.ts";

describe("queued model selection", () => {
  it("uses delivery order while excluding current-conversation notices", () => {
    const original = { instanceId: "codex", model: "original" };
    const picked = {
      instanceId: "other-provider",
      model: "picked",
      options: [{ id: "effort", value: "high" }],
    };
    const later = { instanceId: "codex", model: "later" };
    const monitor = {
      id: "monitor",
      createdBy: "agent",
      creationSource: "server",
      notification: { source: { kind: "monitor" } },
    };
    const completion = {
      id: "completion",
      delegatedCompletion: { parentRunId: "parent", generation: 1, taskIds: ["child"] },
    };
    const projection = {
      thread: { modelSelection: original },
      messages: [{ id: "pick" }, monitor, completion, { id: "other" }],
      runs: [
        {
          status: "queued",
          ordinal: 1,
          queuePosition: 3,
          userMessageId: "pick",
          modelSelection: picked,
        },
        {
          status: "queued",
          ordinal: 2,
          queuePosition: 4,
          userMessageId: "monitor",
          modelSelection: original,
        },
        {
          status: "queued",
          ordinal: 3,
          queuePosition: 5,
          userMessageId: "completion",
          modelSelection: original,
        },
        {
          status: "queued",
          ordinal: 4,
          queuePosition: 2,
          userMessageId: "other",
          modelSelection: later,
        },
      ],
    } as never;
    expect(queueTailModelSelection(projection)).toEqual(picked);
    expect(followsCurrentConversation(monitor as never)).toBe(true);
    expect(followsCurrentConversation(completion as never)).toBe(true);
    const run = { userMessageId: "monitor", modelSelection: picked } as never;
    expect(queuedRunModelSelection(projection, run)).toEqual(original);
  });

  it("keeps provider-origin buffered notifications tied to their provider", () => {
    const buffered = {
      createdBy: "agent",
      creationSource: "provider",
      notification: { source: { kind: "monitor" } },
    } as never;
    expect(isBufferedProviderNotification(buffered)).toBe(true);
    expect(followsCurrentConversation(buffered)).toBe(false);
  });
});
