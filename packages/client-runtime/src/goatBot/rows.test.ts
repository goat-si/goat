import {
  EnvironmentId,
  MessageId,
  MemoryId,
  MemorySpaceId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildGoatBotTimeline,
  goatBotReplyingSince,
  type GoatBotItemReaders,
  type GoatBotMessagePresentation,
  type GoatBotPendingInput,
  type GoatBotRow,
  type GoatBotTaskCard,
} from "./rows.ts";

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
    messageId: MessageId.make(`m-${id}`),
    inputIntent: "turn_start",
    text,
    attachments: [],
    createdBy: "user",
    creationSource: "web",
  }) satisfies OrchestrationV2TurnItem;

const bot = (id: string, at: string, text: string, streaming = false) =>
  ({
    ...base(id, at),
    type: "assistant_message",
    messageId: MessageId.make(`m-${id}`),
    text,
    streaming,
  }) satisfies OrchestrationV2TurnItem;

const notice = (id: string, at: string) =>
  ({
    ...base(id, at),
    type: "notification",
    source: { kind: "background_task" },
    outcome: "updated",
    summary: "Work updated",
  }) satisfies OrchestrationV2TurnItem;

const reasoning = (id: string, at: string) =>
  ({
    ...base(id, at),
    type: "reasoning",
    text: "thinking",
    streaming: false,
  }) satisfies OrchestrationV2TurnItem;

const command = (id: string, at: string) =>
  ({
    ...base(id, at),
    type: "command_execution",
    input: "ls",
    output: "",
    exitCode: 0,
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

function card(key: string, revision: number, statusLabel = "Working"): GoatBotTaskCard {
  return {
    key,
    revision,
    updatedAt: "2026-10-12T12:01:00Z",
    title: `Task ${key}`,
    statusLabel,
    tone: "active",
    sourceLabel: null,
    summary: null,
    attentionLabel: null,
    pullRequests: [],
    target: {
      kind: "thread",
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make(`worker-${key}`),
    },
  };
}

function readers(
  messages: Record<string, GoatBotMessagePresentation> = {},
  cards: Record<string, GoatBotTaskCard> = {},
): GoatBotItemReaders {
  return {
    message: (item) => messages[item.id] ?? null,
    taskCard: (item) => cards[item.id] ?? null,
  };
}

const content = (rows: GoatBotRow[]) => rows.filter((row) => row.kind !== "day");

describe("buildGoatBotTimeline", () => {
  it("keeps only the conversation and work cards, hiding tool calls and reasoning", () => {
    const rows = buildGoatBotTimeline({
      visibleTurnItems: rowsOf([
        user("u1", "2026-10-12T12:00:00Z", "Fix the flaky test"),
        reasoning("r1", "2026-10-12T12:00:01Z"),
        command("c1", "2026-10-12T12:00:02Z"),
        bot("b1", "2026-10-12T12:00:03Z", "On it."),
        notice("n-plain", "2026-10-12T12:00:04Z"),
        notice("n-task", "2026-10-12T12:00:05Z"),
      ]),
      pendingInputs: [],
      readers: readers({}, { "n-task": card("t1", 1) }),
    });
    expect(content(rows).map((row) => [row.kind, row.id])).toEqual([
      ["user", "u1"],
      ["bot", "b1"],
      ["task", "n-task"],
    ]);
  });

  it("marks a message read only once GOAT Bot started reading it", () => {
    const rows = buildGoatBotTimeline({
      visibleTurnItems: rowsOf([
        user("u1", "2026-10-12T12:00:00Z", "first"),
        user("u2", "2026-10-12T12:00:10Z", "second"),
      ]),
      pendingInputs: [],
      readers: readers({
        u1: { tone: "reply", readAt: "2026-10-12T12:00:01Z", requestKey: "in-1" },
      }),
    });
    expect(content(rows).map((row) => (row.kind === "user" ? row.delivery : null))).toEqual([
      { state: "read", readAt: "2026-10-12T12:00:01Z" },
      { state: "sent" },
    ]);
  });

  it("shows one card per piece of work at its first place with the newest revision", () => {
    const rows = buildGoatBotTimeline({
      visibleTurnItems: rowsOf([
        notice("n1", "2026-10-12T12:00:00Z"),
        bot("b1", "2026-10-12T12:00:01Z", "Started."),
        notice("n2", "2026-10-12T12:00:02Z"),
        notice("n3", "2026-10-12T12:00:03Z"),
      ]),
      pendingInputs: [],
      readers: readers(
        {},
        { n1: card("t1", 2, "Working"), n2: card("t1", 3, "Done"), n3: card("t1", 1, "Received") },
      ),
    });
    const tasks = content(rows).filter((row) => row.kind === "task");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: "n1", card: { revision: 3, statusLabel: "Done" } });
  });

  it("drops a pending message once the server row with the same request key arrives", () => {
    const pending: GoatBotPendingInput[] = [
      {
        clientKey: "k1",
        text: "hello",
        createdAt: "2026-10-12T12:00:00Z",
        state: "sending",
        requestKey: "in-1",
      },
      {
        clientKey: "k2",
        text: "again",
        createdAt: "2026-10-12T12:00:01Z",
        state: "sending",
        requestKey: null,
      },
      {
        clientKey: "k3",
        text: "lost",
        createdAt: "2026-10-12T12:00:02Z",
        state: "failed",
        requestKey: null,
      },
    ];
    const rows = buildGoatBotTimeline({
      visibleTurnItems: rowsOf([user("u1", "2026-10-12T12:00:00Z", "hello")]),
      pendingInputs: pending,
      readers: readers({ u1: { tone: "reply", readAt: null, requestKey: "in-1" } }),
    });
    expect(
      content(rows).map((row) => [row.id, row.kind === "user" ? row.delivery.state : null]),
    ).toEqual([
      ["u1", "sent"],
      ["pending:k2", "sending"],
      ["pending:k3", "failed"],
    ]);
  });

  it("keeps one bubble when a retry after a lost response is accepted as the same input", () => {
    // The first attempt committed but its response was lost; the retry reused the key and
    // the server answered with the same input, so the pending entry now carries its key.
    const rows = buildGoatBotTimeline({
      visibleTurnItems: rowsOf([user("u1", "2026-10-12T12:00:00Z", "ship it")]),
      pendingInputs: [
        {
          clientKey: "k1",
          text: "ship it",
          createdAt: "2026-10-12T12:00:00Z",
          state: "sending",
          requestKey: "in-1",
        },
      ],
      readers: readers({ u1: { tone: "reply", readAt: null, requestKey: "in-1" } }),
    });
    expect(content(rows).filter((row) => row.kind === "user")).toHaveLength(1);
  });

  it("starts a new day row when the local date changes", () => {
    const rows = buildGoatBotTimeline({
      visibleTurnItems: rowsOf([
        user("u1", "2026-10-10T12:00:00Z", "yesterday"),
        user("u2", "2026-10-12T12:00:00Z", "today"),
      ]),
      pendingInputs: [],
      readers: readers(),
    });
    expect(rows.map((row) => row.kind)).toEqual(["day", "user", "day", "user"]);
  });

  it("groups consecutive messages from one side within five minutes", () => {
    const rows = buildGoatBotTimeline({
      visibleTurnItems: rowsOf([
        user("u1", "2026-10-12T12:00:00Z", "a"),
        user("u2", "2026-10-12T12:01:00Z", "b"),
        bot("b1", "2026-10-12T12:01:30Z", "c"),
        notice("n1", "2026-10-12T12:01:40Z"),
        user("u3", "2026-10-12T12:02:00Z", "d"),
        user("u4", "2026-10-12T12:09:00Z", "e"),
      ]),
      pendingInputs: [],
      readers: readers({}, { n1: card("t1", 1) }),
    });
    expect(content(rows).map((row) => [row.id, row.firstInGroup])).toEqual([
      ["u1", true],
      ["u2", false],
      ["b1", true],
      ["n1", false],
      ["u3", true],
      ["u4", true],
    ]);
  });

  it("takes the bot's tone from its message and skips a reply that has not started", () => {
    const rows = buildGoatBotTimeline({
      visibleTurnItems: rowsOf([
        bot("b0", "2026-10-12T12:00:00Z", "", true),
        bot("b1", "2026-10-12T12:00:01Z", "The worker failed."),
      ]),
      pendingInputs: [],
      readers: readers({ b1: { tone: "failure", readAt: null, requestKey: null } }),
    });
    expect(content(rows)).toMatchObject([{ id: "b1", kind: "bot", tone: "failure" }]);
  });

  it("offers a question's choices only until the user sends something", () => {
    const question = {
      tone: "question",
      readAt: null,
      requestKey: null,
      options: ["CI fix", "Release"],
    } as const;
    const asked = [
      user("u1", "2026-10-12T12:00:00Z", "how is it going"),
      bot("b1", "2026-10-12T12:00:01Z", "Which one?"),
    ];
    const options = (pendingInputs: GoatBotPendingInput[], extra: OrchestrationV2TurnItem[] = []) =>
      content(
        buildGoatBotTimeline({
          visibleTurnItems: rowsOf([...asked, ...extra]),
          pendingInputs,
          readers: readers({ b1: question }),
        }),
      ).flatMap((row) => (row.kind === "bot" ? [row.options] : []));

    expect(options([])).toEqual([["CI fix", "Release"]]);
    // A send still on its way already answers the question.
    expect(
      options([
        {
          clientKey: "c1",
          text: "CI fix",
          createdAt: "2026-10-12T12:00:02Z",
          state: "sending",
          requestKey: null,
        },
      ]),
    ).toEqual([[]]);
    expect(options([], [user("u2", "2026-10-12T12:00:03Z", "Release")])).toEqual([[]]);
  });
});

describe("goatBotReplyingSince", () => {
  const read = (requestKey: string, readAt: string): GoatBotMessagePresentation => ({
    tone: "reply",
    readAt,
    requestKey,
  });
  const reply = (replyToKey: string): GoatBotMessagePresentation => ({
    tone: "reply",
    readAt: null,
    requestKey: null,
    replyToKey,
  });

  it("is replying from when the newest message was read until its reply lands", () => {
    const items = [
      user("u1", "2026-10-12T12:00:00Z", "hi"),
      bot("b1", "2026-10-12T12:00:02Z", "Hello!"),
      // A finished task reports in while the next message is still being read.
      bot("b2", "2026-10-12T12:00:05Z", "Done: earlier work"),
      user("u2", "2026-10-12T12:00:04Z", "how is opencodex going?"),
    ];
    const messages = {
      u1: read("in-1", "2026-10-12T12:00:01Z"),
      b1: reply("in-1"),
      u2: read("in-2", "2026-10-12T12:00:04Z"),
    };
    expect(
      goatBotReplyingSince({ visibleTurnItems: rowsOf(items), readers: readers(messages) }),
    ).toBe("2026-10-12T12:00:04Z");
    expect(
      goatBotReplyingSince({
        visibleTurnItems: rowsOf([...items, bot("b3", "2026-10-12T12:00:09Z", "Starting.")]),
        readers: readers({ ...messages, b3: reply("in-2") }),
      }),
    ).toBeNull();
  });

  it("is not replying before GOAT Bot reads the message", () => {
    expect(
      goatBotReplyingSince({
        visibleTurnItems: rowsOf([user("u1", "2026-10-12T12:00:00Z", "hi")]),
        readers: readers(),
      }),
    ).toBeNull();
  });
});

describe("memory report rows", () => {
  it("preserves a report target when later messages retire question options", () => {
    const memory = {
      environmentId: EnvironmentId.make("remote-owner"),
      memorySpaceId: MemorySpaceId.make("00000000-0000-4000-8000-000000000001"),
      memoryId: MemoryId.make("00000000-0000-4000-8000-000000000002"),
    };
    const result = content(
      buildGoatBotTimeline({
        visibleTurnItems: rowsOf([
          bot("b", "2026-10-12T12:00:00Z", "Report"),
          user("u", "2026-10-12T12:00:01Z", "Thanks"),
        ]),
        pendingInputs: [],
        readers: readers({
          b: { tone: "result", readAt: null, requestKey: null, options: ["Yes"], memory },
        }),
      }),
    );
    expect(result[0]).toMatchObject({ kind: "bot", memory, options: [] });
    expect(result[1]).not.toHaveProperty("memory");
  });
});
