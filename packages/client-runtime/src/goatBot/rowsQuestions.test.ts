import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildGoatBotTimeline,
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

describe("questions a task asks in the main chat", () => {
  const proposal = (
    revision: number,
    openQuestionIds?: ReadonlyArray<string>,
  ): GoatBotTaskCard => ({
    ...card("proposal", revision, "Waiting for your answer"),
    askInChat: true,
    ...(openQuestionIds === undefined ? {} : { openQuestionIds }),
  });
  const asked: GoatBotMessagePresentation = {
    tone: "question",
    readAt: null,
    requestKey: null,
    taskId: "proposal",
    questionId: "q-save",
    options: ["Save", "Not now"],
  };
  const optionsIn = (
    taskId: string | null,
    items: OrchestrationV2TurnItem[],
    cards: Record<string, GoatBotTaskCard>,
    messages: Record<string, GoatBotMessagePresentation> = { b1: asked },
  ) =>
    content(
      buildGoatBotTimeline({
        visibleTurnItems: rowsOf(items),
        pendingInputs: [],
        readers: readers(messages, cards),
        taskId,
      }),
    ).flatMap((row) => (row.kind === "bot" ? [[row.id, row.options] as const] : []));

  it("shows a skill proposal's question with its choices in the main chat and its own view", () => {
    const items = [
      bot("b1", "2026-10-12T12:00:00Z", "Save this as a skill? deploy-check"),
      bot("b2", "2026-10-12T12:00:01Z", "Working on it"),
      notice("n1", "2026-10-12T12:00:02Z"),
      notice("n2", "2026-10-12T12:00:03Z"),
    ];
    const cards = { n1: proposal(1, ["q-save"]), n2: card("other", 1) };
    const messages = { b1: asked, b2: { ...asked, taskId: "other", options: [] } };
    // Another task's messages stay in that task's view.
    expect(optionsIn(null, items, cards, messages)).toEqual([["b1", ["Save", "Not now"]]]);
    expect(optionsIn("proposal", items, cards, messages)).toEqual([["b1", ["Save", "Not now"]]]);
  });

  it("retires a question's choices everywhere once its task's newest card no longer has it open", () => {
    // The answer was sent from the other view, so neither view has a later message of its own.
    const items = [
      bot("b1", "2026-10-12T12:00:00Z", "Save this as a skill? deploy-check"),
      notice("n1", "2026-10-12T12:00:01Z"),
      notice("n2", "2026-10-12T12:00:05Z"),
    ];
    const cards = { n1: proposal(1, ["q-save"]), n2: proposal(2, []) };
    expect(optionsIn(null, items, cards)).toEqual([["b1", []]]);
    expect(optionsIn("proposal", items, cards)).toEqual([["b1", []]]);
  });

  it("keeps an open question's choices after the person answers a different question", () => {
    const items = [
      notice("n1", "2026-10-12T12:00:00Z"),
      bot("b1", "2026-10-12T12:00:01Z", "Save this as a skill? deploy-check"),
      user("u1", "2026-10-12T12:00:02Z", "Release"),
    ];
    expect(optionsIn(null, items, { n1: proposal(1, ["q-save"]) })).toEqual([
      ["b1", ["Save", "Not now"]],
    ]);
    // A card from a server that does not list open questions keeps the later-message rule.
    expect(optionsIn(null, items, { n1: proposal(1) })).toEqual([["b1", []]]);
  });

  it("sends a pressed answer to the question's task, and shows it in the main chat", () => {
    const items = [
      notice("n1", "2026-10-12T12:00:00Z"),
      bot("b1", "2026-10-12T12:00:01Z", "Save this as a skill? deploy-check"),
    ];
    const answerTasks = (cards: Record<string, GoatBotTaskCard>) =>
      content(
        buildGoatBotTimeline({
          visibleTurnItems: rowsOf(items),
          pendingInputs: [
            {
              clientKey: "c1",
              taskId: "proposal",
              text: "Save",
              createdAt: "2026-10-12T12:00:02Z",
              state: "sending",
              requestKey: null,
            },
          ],
          readers: readers({ b1: asked }, cards),
          taskId: null,
        }),
      ).map((row) => (row.kind === "bot" ? [row.id, row.answerTaskId ?? row.answer] : [row.id]));
    expect(answerTasks({ n1: proposal(1, ["q-save"]) })).toEqual([
      ["n1"],
      ["b1", "proposal"],
      ["pending:c1"],
    ]);
    // A server that does not name open questions may not route an answer sent to a task, and the
    // send answers the question there, so the picked choice shows inside it.
    expect(answerTasks({ n1: proposal(1) })).toEqual([["n1"], ["b1", "Save"]]);
  });

  it("shows an approval question of a known task in the main chat and closes it with the chip", () => {
    const asked: GoatBotMessagePresentation = {
      tone: "question",
      readAt: null,
      requestKey: null,
      taskId: "work",
      questionId: "approval:rm",
      options: ["Approve A1", "Deny A1"],
    };
    const items = [
      bot("b1", "2026-10-12T12:00:00Z", "work: the agent wants to run a command."),
      notice("n1", "2026-10-12T12:00:01Z"),
    ];
    const open = { n1: { ...card("work", 1), openQuestionIds: ["approval:rm"] } };
    expect(optionsIn(null, items, open, { b1: asked })).toEqual([
      ["b1", ["Approve A1", "Deny A1"]],
    ]);
    expect(optionsIn("work", items, open, { b1: asked })).toEqual([
      ["b1", ["Approve A1", "Deny A1"]],
    ]);
    const closed = { n1: { ...card("work", 2), openQuestionIds: [] } };
    expect(optionsIn(null, items, closed, { b1: asked })).toEqual([["b1", []]]);
    expect(optionsIn("work", items, closed, { b1: asked })).toEqual([["b1", []]]);
    const pending = content(
      buildGoatBotTimeline({
        visibleTurnItems: rowsOf(items),
        pendingInputs: [
          {
            clientKey: "c1",
            taskId: "work",
            text: "Approve A1",
            createdAt: "2026-10-12T12:00:02Z",
            state: "sending",
            requestKey: null,
          },
        ],
        readers: readers({ b1: asked }, open),
        taskId: null,
      }),
    ).map((row) => row.id);
    expect(pending).toContain("b1");
    expect(pending).toContain("pending:c1");
  });

  it("keeps a pressed answer, inside its question, and the reply to it in the main chat", () => {
    const work = { tone: "reply" as const, readAt: null, requestKey: null, taskId: "work" };
    const ids = content(
      buildGoatBotTimeline({
        visibleTurnItems: rowsOf([
          notice("n1", "2026-10-12T12:00:00Z"),
          bot("b1", "2026-10-12T12:00:01Z", "work: the agent wants to run a command."),
          user("u1", "2026-10-12T12:00:02Z", "Approve A1"),
          bot("b2", "2026-10-12T12:00:03Z", "Approved. I told the agent on work not to."),
          bot("b3", "2026-10-12T12:00:04Z", "Still working."),
        ]),
        pendingInputs: [],
        readers: readers(
          {
            b1: { ...asked, taskId: "work", questionId: "a1", options: ["Approve A1", "Deny A1"] },
            u1: { ...work, readAt: "2026-10-12T12:00:02Z", requestKey: "in-approve" },
            b2: { ...work, tone: "result", replyToKey: "in-approve" },
            b3: { ...work, tone: "status" },
          },
          { n1: { ...card("work", 2), openQuestionIds: [] } },
        ),
        taskId: null,
      }),
    ).map((row) => row.id);
    expect(ids).toEqual(["n1", "b1", "b2"]);
  });

  it("routes a turn's question from its chip and does not show the turn as a card", () => {
    const asked: GoatBotMessagePresentation = {
      tone: "question",
      readAt: null,
      requestKey: null,
      taskId: "turn-1",
      questionId: "pick",
      options: ["c.txt", "d.txt"],
    };
    const chip = (id: string, at: string, version: number, open: ReadonlyArray<string>) =>
      ({
        ...notice(id, at),
        ledgerTask: {
          taskId: "turn-1",
          kind: "turn",
          taskVersion: version,
          openQuestionIds: open,
        },
      }) as OrchestrationV2TurnItem;
    const shown = (items: OrchestrationV2TurnItem[]) =>
      content(
        buildGoatBotTimeline({
          visibleTurnItems: rowsOf(items),
          pendingInputs: [],
          readers: readers({ b1: asked }),
          taskId: null,
        }),
      );
    const openItems = [
      chip("n1", "2026-10-12T12:00:00Z", 1, ["pick"]),
      bot("b1", "2026-10-12T12:00:01Z", "Which file?"),
    ];
    const open = shown(openItems);
    expect(open.some((row) => row.kind === "task")).toBe(false);
    expect(open.find((row) => row.id === "b1")).toMatchObject({
      options: ["c.txt", "d.txt"],
      answerTaskId: "turn-1",
    });
    const closed = shown([...openItems, chip("n2", "2026-10-12T12:00:02Z", 2, [])]);
    expect(closed.some((row) => row.kind === "task")).toBe(false);
    expect(closed.find((row) => row.id === "b1")).toMatchObject({ options: [] });
    expect(closed.find((row) => row.id === "b1")).not.toHaveProperty("answerTaskId");
  });
});

describe("a question the person answered", () => {
  const which: GoatBotMessagePresentation = {
    tone: "question",
    readAt: null,
    requestKey: null,
    options: ["CI fix", "Release"],
  };
  const asked = [bot("b1", "2026-10-12T12:00:01Z", "Which one?")];
  const questionRow = (
    items: OrchestrationV2TurnItem[],
    pendingInputs: GoatBotPendingInput[] = [],
    messages: Record<string, GoatBotMessagePresentation> = { b1: which },
    cards: Record<string, GoatBotTaskCard> = {},
    taskId: string | null | undefined = undefined,
  ) =>
    content(
      buildGoatBotTimeline({
        visibleTurnItems: rowsOf(items),
        pendingInputs,
        readers: readers(messages, cards),
        ...(taskId === undefined ? {} : { taskId }),
      }),
    ).find((row) => row.id === "b1");
  const pending = (
    text: string,
    state: GoatBotPendingInput["state"],
    extra: Partial<GoatBotPendingInput> = {},
  ): GoatBotPendingInput => ({
    clientKey: "c1",
    text,
    createdAt: "2026-10-12T12:00:02Z",
    state,
    requestKey: null,
    ...extra,
  });

  it("keeps the picked choice as the answer while it is on its way and after it lands", () => {
    expect(questionRow(asked, [pending("CI fix", "sending")])).toMatchObject({
      options: [],
      answer: "CI fix",
    });
    expect(questionRow([...asked, user("u1", "2026-10-12T12:00:02Z", "CI fix")])).toMatchObject({
      options: [],
      answer: "CI fix",
    });
  });

  it("takes a typed reply as the answer", () => {
    expect(
      questionRow([...asked, user("u1", "2026-10-12T12:00:02Z", "  Neither, wait for Monday ")]),
    ).toMatchObject({ options: [], answer: "Neither, wait for Monday" });
  });

  it("takes a typed reply to a question without choices, sent to its task, as the answer", () => {
    const open = { ...card("turn", 2), askInChat: true, openQuestionIds: [] };
    const routed: GoatBotMessagePresentation = {
      tone: "question",
      readAt: null,
      requestKey: null,
      taskId: "turn",
      questionId: "which-guide",
    };
    const reply = { tone: "reply" as const, readAt: null, requestKey: "in-2", taskId: "turn" };
    const items = [
      notice("n1", "2026-10-12T12:00:00Z"),
      bot("b1", "2026-10-12T12:00:01Z", "Which guide next?"),
      user("u1", "2026-10-12T12:00:02Z", "README"),
    ];
    expect(questionRow(items, [], { b1: routed, u1: reply }, { n1: open }, null)).toMatchObject({
      answer: "README",
    });
    // A status line is not a question, so a later message does not answer it.
    expect(
      questionRow(items, [], { b1: { ...routed, tone: "status" }, u1: reply }, { n1: open }, null),
    ).not.toHaveProperty("answer");
  });

  it("keeps the choices open when the answer failed to send", () => {
    const row = questionRow(asked, [pending("CI fix", "failed")]);
    expect(row).toMatchObject({ options: ["CI fix", "Release"] });
    expect(row).not.toHaveProperty("answer");
  });

  it("shows a picked choice inside the question, without a second message from the person", () => {
    const timeline = (
      items: OrchestrationV2TurnItem[],
      pendingInputs: GoatBotPendingInput[] = [],
    ) =>
      content(
        buildGoatBotTimeline({
          visibleTurnItems: rowsOf(items),
          pendingInputs,
          readers: readers({ b1: which }),
        }),
      );
    for (const rows of [
      timeline(asked, [pending("Release", "sending")]),
      timeline([...asked, user("u1", "2026-10-12T12:00:02Z", "Release")]),
    ]) {
      expect(rows.filter((row) => row.kind === "user")).toEqual([]);
      expect(rows.find((row) => row.id === "b1")).toMatchObject({
        options: [],
        choices: ["CI fix", "Release"],
        answer: "Release",
        answerIndex: 1,
      });
    }
    // A typed answer stays the person's own message, and a failed pick stays visible to retry.
    const typed = timeline([...asked, user("u1", "2026-10-12T12:00:02Z", "Neither")]);
    expect(typed.filter((row) => row.kind === "user")).toHaveLength(1);
    expect(typed.find((row) => row.id === "b1")).not.toHaveProperty("answerIndex");
    const failed = timeline(asked, [pending("Release", "failed")]);
    expect(failed.filter((row) => row.kind === "user")).toHaveLength(1);
  });

  it("shows a pick on its way in the question, and gives no older message the newest receipt", () => {
    const rows = content(
      buildGoatBotTimeline({
        visibleTurnItems: rowsOf([user("u0", "2026-10-12T12:00:00Z", "Ship it"), ...asked]),
        pendingInputs: [pending("Release", "sending")],
        readers: readers({ b1: which }),
      }),
    );
    expect(rows.find((row) => row.id === "b1")).toMatchObject({
      answerIndex: 1,
      answerSending: true,
    });
    expect(rows.filter((row) => row.kind === "user" && row.showReceipt)).toEqual([]);
  });

  it("keeps a later message that only matches a choice as the person's own message", () => {
    const rows = content(
      buildGoatBotTimeline({
        visibleTurnItems: rowsOf([
          ...asked,
          user("u1", "2026-10-12T12:00:02Z", "Neither"),
          user("u2", "2026-10-12T12:00:03Z", "Release"),
        ]),
        pendingInputs: [],
        readers: readers({ b1: which }),
      }),
    );
    expect(rows.filter((row) => row.kind === "user").map((row) => row.id)).toEqual(["u1", "u2"]);
    expect(rows.find((row) => row.id === "b1")).not.toHaveProperty("answerIndex");
  });

  it("still shows the answer after a reload, once the task closed the question", () => {
    const proposal = {
      ...card("proposal", 2, "Working"),
      askInChat: true,
      openQuestionIds: [],
    } satisfies GoatBotTaskCard;
    const routed = {
      ...which,
      taskId: "proposal",
      questionId: "q-save",
      options: ["Save", "Skip"],
    };
    const items = [
      notice("n1", "2026-10-12T12:00:00Z"),
      ...asked,
      user("u1", "2026-10-12T12:00:02Z", "Save"),
    ];
    const messages = {
      b1: routed,
      u1: {
        tone: "reply" as const,
        readAt: "2026-10-12T12:00:02Z",
        requestKey: "in-1",
        taskId: "proposal",
      },
    };
    expect(questionRow(items, [], messages, { n1: proposal }, null)).toMatchObject({
      options: [],
      answer: "Save",
    });
  });

  it("keeps a task's question open until its card closes it, though an answer was sent", () => {
    const routed = {
      ...which,
      taskId: "proposal",
      questionId: "q-save",
      options: ["Save", "Skip"],
    };
    const items = [
      notice("n1", "2026-10-12T12:00:00Z"),
      ...asked,
      user("u1", "2026-10-12T12:00:02Z", "Save"),
    ];
    const messages = {
      b1: routed,
      u1: { tone: "reply" as const, readAt: null, requestKey: "in-1", taskId: "proposal" },
    };
    const stillOpen = { ...card("proposal", 2), askInChat: true, openQuestionIds: ["q-save"] };
    const row = questionRow(items, [], messages, { n1: stillOpen }, null);
    expect(row).toMatchObject({ options: ["Save", "Skip"] });
    expect(row).not.toHaveProperty("answer");
  });

  it("does not take a message about something else as the answer to a task's open question", () => {
    const open = { ...card("proposal", 1), askInChat: true, openQuestionIds: ["q-save"] };
    const routed = {
      ...which,
      taskId: "proposal",
      questionId: "q-save",
      options: ["Save", "Skip"],
    };
    const row = questionRow(
      [notice("n1", "2026-10-12T12:00:00Z"), ...asked, user("u1", "2026-10-12T12:00:02Z", "hi")],
      [],
      { b1: routed },
      { n1: open },
      null,
    );
    expect(row).toMatchObject({ options: ["Save", "Skip"] });
    expect(row).not.toHaveProperty("answer");
  });
});

describe("a long chat of questions", () => {
  it("gives each of hundreds of questions its own reply, in the chat and per task", () => {
    const start = Date.parse("2026-10-12T12:00:00Z");
    let clock = 0;
    const at = () => DateTime.formatIso(DateTime.makeUnsafe(start + clock++ * 1_000));
    const closed = (key: string): GoatBotTaskCard => ({
      ...card(key, 1, "Waiting for your answer"),
      // The cards closed their questions after the last reply came back.
      updatedAt: "2026-10-13T00:00:00Z",
      askInChat: true,
      openQuestionIds: [],
    });
    const question = (taskId: string | null, questionId: string): GoatBotMessagePresentation => ({
      tone: "question",
      readAt: null,
      requestKey: null,
      taskId,
      questionId,
      options: ["Yes", "No"],
    });
    const sentTo = (taskId: string): GoatBotMessagePresentation => ({
      tone: "reply",
      readAt: null,
      requestKey: null,
      taskId,
    });
    const items: OrchestrationV2TurnItem[] = [notice("na", at()), notice("nb", at())];
    const messages: Record<string, GoatBotMessagePresentation> = {};
    const expected: Array<readonly [string, ReadonlyArray<string>, string | undefined]> = [];
    const rounds = 200;
    for (let round = 0; round < rounds; round++) {
      // Two tasks ask, the chat asks, then the replies come back in another order.
      items.push(bot(`qa${round}`, at(), `A asks ${round}`));
      messages[`qa${round}`] = question("a", `qa${round}`);
      items.push(bot(`qb${round}`, at(), `B asks ${round}`));
      messages[`qb${round}`] = question("b", `qb${round}`);
      items.push(bot(`qc${round}`, at(), `Chat asks ${round}`));
      messages[`qc${round}`] = question(null, `qc${round}`);
      if (round === rounds - 1) {
        expected.push([`qa${round}`, [], undefined], [`qb${round}`, [], undefined]);
        expected.push([`qc${round}`, ["Yes", "No"], undefined]);
        continue;
      }
      items.push(user(`uc${round}`, at(), `chat ${round}`));
      items.push(user(`ub${round}`, at(), `b ${round}`));
      messages[`ub${round}`] = sentTo("b");
      items.push(user(`ua${round}`, at(), `a ${round}`));
      messages[`ua${round}`] = sentTo("a");
      expected.push([`qa${round}`, [], `a ${round}`], [`qb${round}`, [], `b ${round}`]);
      expected.push([`qc${round}`, [], `chat ${round}`]);
    }
    const rows = content(
      buildGoatBotTimeline({
        visibleTurnItems: rowsOf(items),
        pendingInputs: [],
        readers: readers(messages, { na: closed("a"), nb: closed("b") }),
        taskId: null,
      }),
    );
    expect(
      rows.flatMap((row) => (row.kind === "bot" ? [[row.id, row.options, row.answer]] : [])),
    ).toEqual(expected);
  });
});
