import {
  ChatAttachmentId,
  EnvironmentId,
  MessageId,
  MemoryId,
  MemorySpaceId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
  OrchestrationV2TurnItemJson,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildGoatBotTimeline,
  goatBotConversationPreview,
  goatBotReplyingSince,
  type GoatBotItemReaders,
  type GoatBotMessagePresentation,
  type GoatBotPendingInput,
  type GoatBotRow,
  type GoatBotTaskCard,
} from "./rows.ts";
import { goatBotItemReaders } from "./readers.ts";

const decodeTurnItem = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
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

function preview(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  lastVisitedAt: string | null = null,
  active = false,
  cards: Record<string, GoatBotTaskCard> = {},
) {
  return goatBotConversationPreview({
    rows: buildGoatBotTimeline({
      visibleTurnItems: rowsOf(items),
      pendingInputs: [],
      readers: readers({}, cards),
    }),
    lastVisitedAt,
    active,
  });
}

describe("goatBotConversationPreview", () => {
  const first = "2026-10-12T12:00:00Z";
  const visit = "2026-10-12T12:02:00Z";
  const answer = "2026-10-12T12:03:00Z";

  it("has no preview for an empty conversation", () => {
    expect(preview([])).toBeNull();
  });

  it("previews a Markdown reply or message as plain text", () => {
    expect(
      preview([bot("b", answer, "## Done\n\n**Merged** [#42](https://x.test/42)")])?.text,
    ).toBe("Done Merged #42");
    expect(preview([user("u", first, "fix `rows.ts`\n- please")])?.text).toBe(
      "You: fix rows.ts please",
    );
  });

  it("shows the latest user message without making it unread", () => {
    expect(preview([user("u", first, "Hello")])).toEqual({
      text: "You: Hello",
      at: "2026-10-12T12:00:00.000Z",
      unread: false,
    });
  });

  it("marks a bot reply unread for a never-visited thread, except while open", () => {
    const items = [bot("b", answer, "On it")];
    expect(preview(items)).toMatchObject({ text: "On it", unread: true });
    expect(preview(items, null, true)).toMatchObject({ unread: false });
  });

  it("clears a reply on visit and marks the next reply unread", () => {
    const closed = [user("u", first, "Hi"), bot("b1", "2026-10-12T12:01:00Z", "Hello")];
    expect(preview(closed, first)?.unread).toBe(true);
    expect(preview(closed, visit)?.unread).toBe(false);
    expect(preview([...closed, bot("b2", answer, "Again")], visit)).toMatchObject({
      text: "Again",
      unread: true,
    });
  });

  it("previews a card revision after visit even when a user message is displayed last", () => {
    const initial = card("task", 1, "Working");
    const revised = { ...card("task", 2, "Done"), updatedAt: answer };
    const items = [notice("n1", first), user("u", visit, "Thanks"), notice("n2", answer)];
    expect(preview(items, visit, false, { n1: initial, n2: revised })).toEqual({
      text: "Done: Task task",
      at: answer,
      unread: true,
    });
    expect(preview([notice("n1", first)], null, false, { n1: revised })).toEqual({
      text: "Done: Task task",
      at: answer,
      unread: true,
    });
  });

  it("recomputes the correct latest row and unread state across 75 visible items", () => {
    const at = (seconds: number) =>
      DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(first), { seconds }));
    const items = Array.from({ length: 75 }, (_, index) =>
      index % 2 === 0
        ? user(`u${index}`, at(index), `User ${index}`)
        : bot(`b${index}`, at(index), `Bot ${index}`),
    );
    expect(preview(items, at(73))).toEqual({
      text: "You: User 74",
      at: at(74),
      unread: false,
    });
    expect(preview(items, at(72))?.unread).toBe(true);
  });
});

describe("buildGoatBotTimeline", () => {
  it("keeps turn receipts in main and isolates replies to known tasks", () => {
    const at = "2026-10-12T12:00:00Z";
    const meta = (taskId: string): GoatBotMessagePresentation => ({
      tone: "reply",
      readAt: null,
      requestKey: null,
      taskId,
    });
    const input = {
      visibleTurnItems: rowsOf([
        user("hello", at, "hello"),
        bot("receipt", at, "Hello"),
        bot("task-reply", at, "Working"),
        notice("chip", at),
      ]),
      pendingInputs: [],
      readers: readers(
        { receipt: meta("channel-task:in1:0"), "task-reply": meta("real-task") },
        { chip: card("real-task", 1) },
      ),
    };
    expect(content(buildGoatBotTimeline({ ...input, taskId: null })).map((row) => row.id)).toEqual([
      "hello",
      "receipt",
      "chip",
    ]);
    expect(
      content(buildGoatBotTimeline({ ...input, taskId: "real-task" })).map((row) => row.id),
    ).toEqual(["task-reply", "chip"]);
  });

  it("hides a task reply known only from the task roster", () => {
    const at = "2026-10-12T12:00:00Z";
    const input = {
      visibleTurnItems: rowsOf([bot("reply", at, "Working")]),
      pendingInputs: [],
      readers: readers({
        reply: { tone: "reply", readAt: null, requestKey: null, taskId: "task" },
      }),
      knownTaskIds: ["task"],
    };
    expect(content(buildGoatBotTimeline({ ...input, taskId: null }))).toEqual([]);
    expect(
      content(buildGoatBotTimeline({ ...input, taskId: "task" })).map((row) => row.id),
    ).toEqual(["reply"]);
  });

  it("clears task pending input when its committed rejection has no task tag", () => {
    const at = "2026-10-12T12:00:00Z";
    const rows = buildGoatBotTimeline({
      visibleTurnItems: rowsOf([user("rejected", at, "hello")]),
      pendingInputs: [
        {
          clientKey: "client",
          taskId: "task",
          text: "hello",
          createdAt: at,
          state: "accepted",
          requestKey: "request",
        },
      ],
      readers: readers({ rejected: { tone: "reply", readAt: null, requestKey: "request" } }),
      taskId: "task",
    });
    expect(content(rows)).toEqual([]);
  });
  it("isolates task messages and pending sends while keeping task references in main", () => {
    const at = "2026-10-12T12:00:00Z";
    const metadata = (taskId: string): GoatBotMessagePresentation => ({
      tone: "reply",
      readAt: null,
      requestKey: null,
      taskId,
    });
    const input = {
      visibleTurnItems: rowsOf([
        user("main", at, "main"),
        user("one", at, "one"),
        bot("two", at, "two"),
        notice("chip-one", at),
        notice("chip-two", at),
      ]),
      pendingInputs: [
        {
          clientKey: "pending-main",
          text: "main pending",
          createdAt: at,
          state: "queued" as const,
          requestKey: null,
        },
        {
          clientKey: "pending-one",
          text: "one pending",
          createdAt: at,
          state: "queued" as const,
          requestKey: null,
          taskId: "one",
        },
      ],
      readers: readers(
        { one: metadata("one"), two: metadata("two") },
        {
          "chip-one": card("one", 1),
          "chip-two": card("two", 1),
        },
      ),
    };
    expect(content(buildGoatBotTimeline({ ...input, taskId: null })).map((row) => row.id)).toEqual([
      "main",
      "chip-one",
      "chip-two",
      "pending:pending-main",
    ]);
    expect(content(buildGoatBotTimeline({ ...input, taskId: "one" })).map((row) => row.id)).toEqual(
      ["one", "chip-one", "pending:pending-one"],
    );
    expect(content(buildGoatBotTimeline({ ...input, taskId: "two" })).map((row) => row.id)).toEqual(
      ["two", "chip-two"],
    );
  });
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
      { state: "delivered" },
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
      ["u1", "delivered"],
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

  it("replaces a pending bubble when its echo arrives before the send returns", () => {
    const item = decodeTurnItem({
      id: "item-1",
      threadId: "thread-bot",
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
      type: "user_message",
      messageId: "m-1",
      inputIntent: "turn_start",
      text: "hello",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      channel: {
        conversationId: "conv-1",
        originKind: "goat",
        kind: "inbound",
        inputId: "in-1",
        clientMessageId: "client-1",
      },
    });
    if (item.type !== "user_message") throw new Error("expected a user message");
    const rows = buildGoatBotTimeline({
      visibleTurnItems: rowsOf([item]),
      pendingInputs: [
        {
          clientKey: "client-1",
          text: "hello",
          createdAt: "2026-10-12T12:00:00Z",
          state: "sending",
          requestKey: null,
        },
      ],
      readers: goatBotItemReaders,
    });
    expect(
      content(rows)
        .filter((row) => row.kind === "user")
        .map((row) => row.id),
    ).toEqual(["item-1"]);
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

  it("marks first, middle, last and single bubbles and groups task cards with bot replies", () => {
    const rows = buildGoatBotTimeline({
      visibleTurnItems: rowsOf([
        user("u1", "2026-10-12T12:00:00Z", "a"),
        user("u2", "2026-10-12T12:01:00Z", "b"),
        user("u3", "2026-10-12T12:02:00Z", "c"),
        bot("b1", "2026-10-12T12:03:00Z", "Working"),
        notice("n1", "2026-10-12T12:04:00Z"),
        user("u4", "2026-10-12T12:10:00Z", "later"),
      ]),
      pendingInputs: [],
      readers: readers({}, { n1: card("task", 1) }),
    });
    expect(content(rows).map((row) => [row.id, row.groupPosition])).toEqual([
      ["u1", "first"],
      ["u2", "middle"],
      ["u3", "last"],
      ["b1", "first"],
      ["n1", "last"],
      ["u4", "single"],
    ]);
    expect(
      content(rows).flatMap((row) => (row.kind === "user" && row.showReceipt ? [row.id] : [])),
    ).toEqual(["u4"]);
  });

  it("adds a time stamp after fifteen quiet minutes while five-minute pauses only split groups", () => {
    const rows = buildGoatBotTimeline({
      visibleTurnItems: rowsOf([
        user("u1", "2026-10-12T12:00:00Z", "a"),
        user("u2", "2026-10-12T12:06:00Z", "b"),
        user("u3", "2026-10-12T12:20:59Z", "c"),
        user("u4", "2026-10-12T12:35:59Z", "d"),
      ]),
      pendingInputs: [],
      readers: readers(),
    });
    expect(rows.map((row) => row.kind)).toEqual(["day", "user", "user", "user", "day", "user"]);
    expect(content(rows).map((row) => row.groupPosition)).toEqual([
      "single",
      "single",
      "single",
      "single",
    ]);
  });

  it("distinguishes queued and accepted pending sends from committed delivery", () => {
    const rows = buildGoatBotTimeline({
      visibleTurnItems: rowsOf([user("u1", "2026-10-12T12:00:00Z", "committed")]),
      pendingInputs: [
        {
          clientKey: "q",
          text: "wait",
          createdAt: "2026-10-12T12:00:01Z",
          state: "queued",
          requestKey: null,
        },
        {
          clientKey: "a",
          text: "accepted",
          createdAt: "2026-10-12T12:00:02Z",
          state: "accepted",
          requestKey: "accepted",
        },
      ],
      readers: readers(),
    });
    expect(content(rows).map((row) => (row.kind === "user" ? row.delivery.state : null))).toEqual([
      "delivered",
      "queued",
      "sent",
    ]);
    expect(
      content(rows).flatMap((row) => (row.kind === "user" && row.showReceipt ? [row.id] : [])),
    ).toEqual(["pending:a"]);
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

  it("marks a direct reply as non-proactive and splits a later work result into a new group", () => {
    const rows = content(
      buildGoatBotTimeline({
        visibleTurnItems: rowsOf([
          user("u1", "2026-10-12T12:00:00Z", "Fix the test"),
          bot("b1", "2026-10-12T12:00:01Z", "On it."),
          bot("b2", "2026-10-12T12:02:00Z", "The test is fixed."),
        ]),
        pendingInputs: [],
        readers: readers({
          u1: { tone: "reply", readAt: null, requestKey: "request-1" },
          b1: { tone: "status", readAt: null, requestKey: null, replyToKey: "request-1" },
          b2: { tone: "result", readAt: null, requestKey: null },
        }),
      }),
    );
    expect(rows[1]).toMatchObject({ kind: "bot", proactive: false, groupPosition: "single" });
    expect(rows[2]).toMatchObject({ kind: "bot", proactive: true, groupPosition: "single" });
  });

  it("groups consecutive proactive updates and excludes failure replies", () => {
    const rows = content(
      buildGoatBotTimeline({
        visibleTurnItems: rowsOf([
          bot("b1", "2026-10-12T12:00:00Z", "Status"),
          bot("b2", "2026-10-12T12:01:00Z", "Result"),
          bot("b3", "2026-10-12T12:02:00Z", "Failed"),
        ]),
        pendingInputs: [],
        readers: readers({
          b1: { tone: "status", readAt: null, requestKey: null },
          b2: { tone: "result", readAt: null, requestKey: null },
          b3: { tone: "failure", readAt: null, requestKey: null },
        }),
      }),
    );
    expect(rows.map((row) => row.kind === "bot" && [row.proactive, row.groupPosition])).toEqual([
      [true, "first"],
      [true, "middle"],
      [false, "last"],
    ]);
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

  it("identifies the folded input as it changes from pending to committed", () => {
    const presentation = {
      tone: "question",
      readAt: null,
      requestKey: null,
      options: ["Keep", "Change"],
    } as const;
    const question = bot("q", "2026-10-12T12:00:00Z", "Which option?");
    const pending = content(
      buildGoatBotTimeline({
        visibleTurnItems: rowsOf([question]),
        pendingInputs: [
          {
            clientKey: "local",
            text: "Keep",
            createdAt: "2026-10-12T12:00:01Z",
            state: "sending",
            requestKey: null,
          },
        ],
        readers: readers({ q: presentation }),
      }),
    );
    expect(pending).toMatchObject([
      { kind: "bot", answer: "Keep", answerInputRowId: "pending:local" },
    ]);
    const committed = content(
      buildGoatBotTimeline({
        visibleTurnItems: rowsOf([question, user("committed", "2026-10-12T12:00:01Z", "Keep")]),
        pendingInputs: [],
        readers: readers({ q: presentation }),
      }),
    );
    expect(committed).toMatchObject([
      { kind: "bot", answer: "Keep", answerInputRowId: "committed" },
    ]);
  });
});

describe("goatBotReplyingSince", () => {
  it("quotes the prompt only when a reply answers something other than the latest message", () => {
    const reply = (replyToKey: string): GoatBotMessagePresentation => ({
      tone: "reply",
      readAt: null,
      requestKey: null,
      replyToKey,
    });
    const asked = (requestKey: string): GoatBotMessagePresentation => ({
      tone: "reply",
      readAt: "2026-10-12T12:00:01Z",
      requestKey,
    });
    const quotes = content(
      buildGoatBotTimeline({
        visibleTurnItems: rowsOf([
          user("u1", "2026-10-12T12:00:00Z", "list the folders"),
          bot("b1", "2026-10-12T12:00:02Z", "On it."),
          bot("b2", "2026-10-12T12:00:04Z", "Here they are."),
          user("u2", "2026-10-12T12:00:05Z", "and count docs"),
          bot("b3", "2026-10-12T12:00:06Z", "Also: the folder list is final."),
          // After a reply about the older prompt, one about the newest needs its quote again.
          bot("b4", "2026-10-12T12:00:07Z", "There are 49 docs."),
        ]),
        pendingInputs: [],
        readers: readers({
          u1: asked("in-1"),
          b1: reply("in-1"),
          b2: reply("in-1"),
          u2: asked("in-2"),
          b3: reply("in-1"),
          b4: reply("in-2"),
        }),
      }),
    ).flatMap((row) => (row.kind === "bot" ? [row.replyTo] : []));
    expect(quotes).toEqual([null, null, "list the folders", "and count docs"]);
  });

  it("leaves a reply to the previous prompt unquoted while the next send is pending, then quotes it once that send commits first", () => {
    const presented = {
      u1: { tone: "reply", readAt: null, requestKey: "in-1" },
      u2: { tone: "reply", readAt: null, requestKey: "in-2" },
      b1: { tone: "reply", readAt: null, requestKey: null, replyToKey: "in-1" },
    } satisfies Record<string, GoatBotMessagePresentation>;
    const whilePending = content(
      buildGoatBotTimeline({
        visibleTurnItems: rowsOf([
          user("u1", "2026-10-12T12:00:00Z", "first"),
          bot("b1", "2026-10-12T12:00:03Z", "About the first."),
        ]),
        pendingInputs: [
          {
            clientKey: "k2",
            text: "second",
            createdAt: "2026-10-12T12:00:02Z",
            state: "sending",
            requestKey: null,
          },
        ],
        readers: readers(presented),
      }),
    );
    // Pending sends sit below every committed row, so the reply still follows its prompt.
    expect(whilePending.map((row) => row.id)).toEqual(["u1", "b1", "pending:k2"]);
    expect(whilePending[1]).toMatchObject({ kind: "bot", replyTo: null });
    const committed = content(
      buildGoatBotTimeline({
        visibleTurnItems: rowsOf([
          user("u1", "2026-10-12T12:00:00Z", "first"),
          user("u2", "2026-10-12T12:00:02Z", "second"),
          bot("b1", "2026-10-12T12:00:03Z", "About the first."),
        ]),
        pendingInputs: [],
        readers: readers(presented),
      }),
    );
    expect(committed[2]).toMatchObject({ kind: "bot", replyTo: "first" });
  });

  it("keeps the prompt unquoted across task cards and event lines about the same request", () => {
    const reply = (replyToKey: string): GoatBotMessagePresentation => ({
      tone: "reply",
      readAt: null,
      requestKey: null,
      replyToKey,
    });
    const event = {
      ...notice("e1", "2026-10-12T12:00:04Z"),
      source: { kind: "goat_bot_event" },
    } as unknown as OrchestrationV2TurnItem;
    const quotes = content(
      buildGoatBotTimeline({
        visibleTurnItems: rowsOf([
          user("u1", "2026-10-12T12:00:00Z", "count the docs"),
          bot("b1", "2026-10-12T12:00:01Z", "Starting a task."),
          notice("n1", "2026-10-12T12:00:02Z"),
          bot("b2", "2026-10-12T12:00:03Z", "It is running."),
          event,
          bot("b3", "2026-10-12T12:00:05Z", "There are 49 docs."),
        ]),
        pendingInputs: [],
        readers: readers(
          {
            u1: { tone: "reply", readAt: "2026-10-12T12:00:01Z", requestKey: "in-1" },
            b1: reply("in-1"),
            b2: reply("in-1"),
            b3: reply("in-1"),
          },
          { n1: card("t1", 1) },
        ),
      }),
    ).flatMap((row) => (row.kind === "bot" ? [row.replyTo] : []));
    expect(quotes).toEqual([null, null, null]);
  });

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

describe("attachments on the person's messages", () => {
  it("shows a photo sent without text, sent and pending, and previews it by name", () => {
    const photo = {
      type: "image" as const,
      id: ChatAttachmentId.make("thread-bot-1"),
      name: "photo.png",
      mimeType: "image/png",
      sizeBytes: 3,
    };
    const rows = content(
      buildGoatBotTimeline({
        visibleTurnItems: rowsOf([
          { ...user("u", "2026-10-12T12:00:00Z", ""), attachments: [photo] },
        ]),
        pendingInputs: [
          {
            clientKey: "k",
            text: "",
            attachments: [{ id: "draft-1", type: "file", name: "log.txt" }],
            createdAt: "2026-10-12T12:00:01Z",
            state: "sending",
            requestKey: null,
          },
        ],
        readers: readers(),
      }),
    );
    expect(rows.map((row) => row.kind === "user" && row.attachments)).toEqual([
      [{ id: "thread-bot-1", type: "image", name: "photo.png" }],
      [{ id: "draft-1", type: "file", name: "log.txt" }],
    ]);
    expect(goatBotConversationPreview({ rows, lastVisitedAt: null, active: true })?.text).toBe(
      "You: log.txt",
    );
  });
});

it("splits a quoted user reply into its quote and message", () => {
  const rows = buildGoatBotTimeline({
    visibleTurnItems: rowsOf([
      user("quoted", "2026-10-12T12:00:00Z", "answer\n\n> first\n> second"),
    ]),
    pendingInputs: [],
    readers: readers(),
  });
  expect(content(rows)).toMatchObject([
    { kind: "user", quote: "first\nsecond", reply: "answer", text: "answer\n\n> first\n> second" },
  ]);
});
