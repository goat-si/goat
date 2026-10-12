import {
  ChannelConversationId,
  ChannelTaskId,
  type ChannelTaskChip,
  EnvironmentId,
  OrchestrationV2TurnItemJson,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { goatBotItemReaders, presentTaskChip } from "./goatBotReaders";

const chip = (overrides: Partial<ChannelTaskChip> = {}): ChannelTaskChip => ({
  taskId: ChannelTaskId.make("task-1"),
  conversationId: ChannelConversationId.make("conv-1"),
  taskVersion: 3,
  title: "Re-verify the Opus 5.5 call",
  status: "running",
  originKind: "goat",
  requesterLabel: "Jun",
  createdAt: "2026-10-12T12:00:00.000Z",
  updatedAt: "2026-10-12T12:01:00.000Z",
  worker: { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("worker") },
  openQuestionCount: 0,
  ...overrides,
});

describe("presentTaskChip", () => {
  it("links a running task to its worker thread", () => {
    expect(presentTaskChip(chip())).toEqual({
      key: "task-1",
      revision: 3,
      title: "Re-verify the Opus 5.5 call",
      statusLabel: "Working",
      tone: "active",
      sourceLabel: "Jun",
      updatedAt: "2026-10-12T12:01:00.000Z",
      summary: null,
      attentionLabel: null,
      target: { kind: "thread", environmentId: "env", threadId: "worker" },
    });
  });

  it("explains a missing worker by how far the task got", () => {
    const { worker: _worker, ...noWorker } = chip();
    expect(presentTaskChip({ ...noWorker, status: "received" }).target).toEqual({
      kind: "none",
      label: "Not started yet",
    });
    expect(presentTaskChip({ ...noWorker, status: "failed" })).toMatchObject({
      statusLabel: "Failed",
      tone: "danger",
      target: { kind: "none", label: "No worker thread" },
    });
  });

  it("names where outside requests came from", () => {
    expect(presentTaskChip(chip({ originKind: "slack" })).sourceLabel).toBe("Slack · Jun");
    expect(presentTaskChip(chip({ originKind: "mcp" })).sourceLabel).toBe("Agent · Jun");
  });

  it("counts open questions and drops an empty summary", () => {
    expect(presentTaskChip(chip({ openQuestionCount: 1, status: "waiting_input" }))).toMatchObject({
      statusLabel: "Needs your input",
      tone: "attention",
      attentionLabel: "1 question",
    });
    expect(presentTaskChip(chip({ openQuestionCount: 3 })).attentionLabel).toBe("3 questions");
    expect(presentTaskChip(chip({ summary: "  " })).summary).toBeNull();
    expect(presentTaskChip(chip({ summary: "Found the cause" })).summary).toBe("Found the cause");
  });
});

describe("goatBotItemReaders", () => {
  const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
  const baseJson = {
    id: "item-1",
    threadId: "bot",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: "2026-10-12T12:00:00.000Z",
    completedAt: "2026-10-12T12:00:00.000Z",
    updatedAt: "2026-10-12T12:00:00.000Z",
  };
  const userJson = (channel: unknown) => ({
    ...baseJson,
    type: "user_message",
    messageId: "m-1",
    inputIntent: "turn_start",
    text: "hello",
    attachments: [],
    createdBy: "user",
    creationSource: "web",
    channel,
  });

  it("reads the read time and input id of a bot conversation message", () => {
    const item = decodeItem(
      userJson({
        conversationId: "conv-1",
        originKind: "goat",
        kind: "inbound",
        inputId: "in-1",
        inReplyToInputId: "in-0",
        readAt: "2026-10-12T12:00:02.000Z",
      }),
    );
    if (item.type !== "user_message") throw new Error("expected a user message");
    expect(goatBotItemReaders.message(item)).toEqual({
      tone: "reply",
      readAt: "2026-10-12T12:00:02.000Z",
      requestKey: "in-1",
      replyToKey: "in-0",
      clientKey: "m-1",
    });
  });

  it("treats metadata this build cannot read as a plain message", () => {
    const item = decodeItem(
      userJson({ conversationId: "conv-1", originKind: "goat", kind: "something_new" }),
    );
    if (item.type !== "user_message") throw new Error("expected a user message");
    expect(goatBotItemReaders.message(item)).toBeNull();
  });

  it("turns a notification's ledger task into a card and ignores plain notifications", () => {
    const notification = (ledgerTask: unknown) =>
      decodeItem({
        ...baseJson,
        type: "notification",
        source: { kind: "background_task" },
        outcome: "updated",
        summary: "Work updated",
        ...(ledgerTask === undefined ? {} : { ledgerTask }),
      });
    const withTask = notification(chip({ status: "completed" }));
    const plain = notification(undefined);
    const unknownStatus = notification({ ...chip(), status: "paused" });
    if (
      withTask.type !== "notification" ||
      plain.type !== "notification" ||
      unknownStatus.type !== "notification"
    ) {
      throw new Error("expected notifications");
    }
    expect(goatBotItemReaders.taskCard(withTask)).toMatchObject({
      key: "task-1",
      statusLabel: "Done",
    });
    expect(goatBotItemReaders.taskCard(plain)).toBeNull();
    expect(goatBotItemReaders.taskCard(unknownStatus)).toBeNull();
  });
});
