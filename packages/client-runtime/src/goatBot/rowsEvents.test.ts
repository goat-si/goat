import {
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
  MessageId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { buildGoatBotTimeline, type GoatBotItemReaders, type GoatBotRow } from "./rows.ts";

const threadId = ThreadId.make("thread-bot");

function base(id: string, at: string) {
  const time = DateTime.makeUnsafe(at);
  return {
    id: TurnItemId.make(id),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed" as const,
    title: null,
    startedAt: time,
    completedAt: time,
    updatedAt: time,
  };
}

const user = (id: string, at: string, text: string) =>
  ({
    ...base(id, at),
    type: "user_message",
    messageId: MessageId.make("m-" + id),
    inputIntent: "turn_start",
    text,
    attachments: [],
    createdBy: "user",
    creationSource: "web",
  }) satisfies OrchestrationV2TurnItem;

const bot = (id: string, at: string, text: string) =>
  ({
    ...base(id, at),
    type: "assistant_message",
    messageId: MessageId.make("m-" + id),
    text,
    streaming: false,
  }) satisfies OrchestrationV2TurnItem;

function rowsOf(items: ReadonlyArray<OrchestrationV2TurnItem>): OrchestrationV2ProjectedTurnItem[] {
  return items.map((item, position) => ({
    position,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: item.id,
    item,
  }));
}

function readers(): GoatBotItemReaders {
  return { message: () => null, taskCard: () => null };
}

const content = (rows: GoatBotRow[]) => rows.filter((row) => row.kind !== "day");

describe("GOAT Bot event lines", () => {
  const event = (id: string, at: string, summary: string) =>
    ({
      ...base(id, at),
      type: "notification",
      source: { kind: "goat_bot_event" },
      outcome: "updated",
      summary,
    }) as unknown as OrchestrationV2TurnItem;
  const system = (id: string, at: string) =>
    ({
      ...base(id, at),
      type: "notification",
      source: { kind: "system" },
      outcome: "updated",
      summary: "Resumed after a restart",
    }) satisfies OrchestrationV2TurnItem;

  it("keeps the routine or task an event line names", () => {
    const subject = { kind: "routine", id: "r1", name: "Standup" };
    const line = { ...event("e1", "2026-10-12T12:00:01Z", "Routine Standup paused") } as {
      source: unknown;
    };
    line.source = { kind: "goat_bot_event", subject };
    const rows = content(
      buildGoatBotTimeline({
        visibleTurnItems: rowsOf([line as unknown as OrchestrationV2TurnItem]),
        pendingInputs: [],
        readers: readers(),
      }),
    );
    expect(rows).toMatchObject([{ kind: "event", text: "Routine Standup paused", subject }]);
  });

  it("shows a bot event as its own line between messages and ignores other system notices", () => {
    const rows = content(
      buildGoatBotTimeline({
        visibleTurnItems: rowsOf([
          user("u1", "2026-10-12T12:00:00Z", "Call yourself Scout"),
          event("e1", "2026-10-12T12:00:01Z", "Renamed to Scout"),
          system("s1", "2026-10-12T12:00:02Z"),
          bot("b1", "2026-10-12T12:00:03Z", "Done."),
        ]),
        pendingInputs: [],
        readers: readers(),
      }),
    );
    expect(rows.map((row) => [row.kind, row.id])).toEqual([
      ["user", "u1"],
      ["event", "e1"],
      ["bot", "b1"],
    ]);
    expect(rows[1]).toMatchObject({ kind: "event", text: "Renamed to Scout" });
  });

  it("leaves event lines out of a single task's view", () => {
    const rows = content(
      buildGoatBotTimeline({
        visibleTurnItems: rowsOf([event("e1", "2026-10-12T12:00:01Z", "Routine Check in paused")]),
        pendingInputs: [],
        readers: readers(),
        taskId: "task-1",
      }),
    );
    expect(rows).toEqual([]);
  });

  it("shows event lines in the main chat that leaves task messages out (taskId null, as mobile asks)", () => {
    const rows = content(
      buildGoatBotTimeline({
        visibleTurnItems: rowsOf([event("e1", "2026-10-12T12:00:01Z", "Renamed to Scout")]),
        pendingInputs: [],
        readers: readers(),
        taskId: null,
      }),
    );
    expect(rows.map((row) => [row.kind, row.id])).toEqual([["event", "e1"]]);
  });
});
