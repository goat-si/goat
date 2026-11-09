import {
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadFeed, workEntryRowLabel } from "./threadActivity";

const threadId = ThreadId.make("thread-1");
const runId = RunId.make("run-1");

function base(id: string, updatedAt: string, ordinal: number) {
  const timestamp = DateTime.makeUnsafe(updatedAt);
  return {
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp,
  };
}

function projected(
  item: OrchestrationV2TurnItem,
  position: number,
): OrchestrationV2ProjectedTurnItem {
  return { position, visibility: "local", sourceThreadId: threadId, sourceItemId: item.id, item };
}

const userMessage = (): OrchestrationV2TurnItem => ({
  ...base("item-user", "2026-06-20T00:00:01.000Z", 0),
  type: "user_message",
  messageId: MessageId.make("message-user"),
  createdBy: "user",
  creationSource: "mobile",
  inputIntent: "turn_start",
  text: "Run checks",
  attachments: [],
});

const providerError = (
  status: "running" | "completed" | "interrupted" | "failed",
  retry: { attempt: number; maxAttempts: number; retryDelayMs: number } | null,
): OrchestrationV2TurnItem => ({
  ...base("item-retry", "2026-06-20T00:00:02.000Z", 1),
  type: "error",
  status,
  completedAt: status === "running" ? null : DateTime.makeUnsafe("2026-06-20T00:00:02.000Z"),
  failure: {
    class: "provider_error",
    message: "Claude API overloaded.",
    code: "api_error_529",
    retryable: true,
  },
  ...(retry === null ? {} : { retry }),
});

function onlyActivity(item: OrchestrationV2TurnItem) {
  const [activity] = buildThreadFeed([projected(userMessage(), 0), projected(item, 1)]).flatMap(
    (entry) => (entry.type === "activity-group" ? entry.activities : []),
  );
  if (activity === undefined) throw new Error("Expected a work activity");
  return activity;
}

describe("provider retry rows", () => {
  it("shows a running retry with its attempt and delay", () => {
    const activity = onlyActivity(
      providerError("running", { attempt: 2, maxAttempts: 10, retryDelayMs: 1_500 }),
    );
    expect(activity.summary).toBe("Retrying provider (2/10)");
    expect(activity.detail).toBe("Claude API overloaded. Retrying in 1.5s.");
    expect(workEntryRowLabel(activity.workEntry)).toBe("Retrying provider (2/10)");
    expect(workEntryRowLabel(activity.workEntry, true)).toBe(
      "Claude API overloaded. Retrying in 1.5s.",
    );
  });

  it("shows a retry that recovered", () => {
    const activity = onlyActivity(
      providerError("completed", { attempt: 2, maxAttempts: 10, retryDelayMs: 1_500 }),
    );
    expect(activity.summary).toBe("Provider recovered (2/10 retries)");
    expect(activity.detail).toBe("Claude API overloaded.");
    expect(workEntryRowLabel(activity.workEntry)).toBe("Provider recovered (2/10 retries)");
  });

  it("shows a retry that stopped", () => {
    const activity = onlyActivity(
      providerError("interrupted", { attempt: 2, maxAttempts: 10, retryDelayMs: 1_500 }),
    );
    expect(activity.summary).toBe("Provider retry stopped (2/10)");
    expect(workEntryRowLabel(activity.workEntry)).toBe("Provider retry stopped (2/10)");
  });

  it("counts the attempts a failed retry chain used", () => {
    const activity = onlyActivity(
      providerError("failed", { attempt: 10, maxAttempts: 10, retryDelayMs: 1_500 }),
    );
    expect(activity.summary).toBe("Provider error after 10/10 retries");
    expect(workEntryRowLabel(activity.workEntry)).toBe("Provider error after 10/10 retries");
  });

  it("keeps a plain provider failure on its message", () => {
    const activity = onlyActivity(providerError("failed", null));
    expect(activity.summary).toBe("Provider error");
    expect(workEntryRowLabel(activity.workEntry)).toBe("Claude API overloaded.");
  });
});
