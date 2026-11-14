import {
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
  OrchestrationV2TurnItemJson,
  ThreadId,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { goatBotItemReaders } from "./readers.ts";
import { buildGoatBotTimeline, type GoatBotPendingInput, type GoatBotRow } from "./rows.ts";

const decode = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const at = (second: number) => "2026-10-12T12:00:" + String(second).padStart(2, "0") + ".000Z";
const meta = { conversationId: "conv-1", originKind: "goat" };

const item = (raw: Record<string, unknown>) =>
  decode({
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
    startedAt: raw.at,
    completedAt: raw.at,
    updatedAt: raw.at,
    ...raw,
  });

/** The task's card: which questions are open and, from servers that record it, who answered. */
const card = (
  taskId: string,
  version: number,
  openQuestionIds: ReadonlyArray<string>,
  answeredQuestions?: ReadonlyArray<{ questionId: string; inputId?: string }>,
) =>
  item({
    id: "card-" + taskId + "-" + version,
    at: at(0),
    type: "notification",
    source: { kind: "background_task" },
    outcome: "updated",
    summary: "Task updated",
    ledgerTask: {
      taskId,
      kind: "work",
      conversationId: "conv-1",
      taskVersion: version,
      title: "Build",
      status: openQuestionIds.length > 0 ? "waiting_input" : "running",
      originKind: "goat",
      requesterLabel: "Jun",
      createdAt: at(0),
      updatedAt: at(0),
      openQuestionCount: openQuestionIds.length,
      openQuestionIds,
      ...(answeredQuestions === undefined ? {} : { answeredQuestions }),
    },
  });

const question = (
  id: string,
  second: number,
  taskId: string,
  questionId: string,
  kind: "task" | null = "task",
) =>
  item({
    id,
    at: at(second),
    type: "assistant_message",
    messageId: "m-" + id,
    text: "Which cache should the build use?",
    streaming: false,
    channel: {
      ...meta,
      kind: "question",
      taskId,
      questionId,
      options: ["Keep", "Clear"],
      ...(kind === null ? {} : { questionKind: kind }),
    },
  });

const person = (
  id: string,
  second: number,
  text: string,
  fields: { taskId?: string; answersQuestionId?: string | null } = {},
) =>
  item({
    id,
    at: at(second),
    type: "user_message",
    messageId: "m-" + id,
    inputIntent: "turn_start",
    text,
    attachments: [],
    createdBy: "user",
    creationSource: "web",
    channel: {
      ...meta,
      kind: "inbound",
      inputId: "in-" + id,
      clientMessageId: "c-" + id,
      ...fields,
    },
  });

const sending = (
  clientKey: string,
  second: number,
  text: string,
  questionId: string,
  state: GoatBotPendingInput["state"] = "sending",
): GoatBotPendingInput => ({
  clientKey,
  text,
  createdAt: at(second),
  state,
  requestKey: null,
  taskId: "task-1",
  questionId,
});

const rowsOf = (
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): OrchestrationV2ProjectedTurnItem[] =>
  items.map((each, position) => ({
    position,
    visibility: "local",
    sourceThreadId: ThreadId.make("thread-bot"),
    sourceItemId: each.id,
    item: each,
  }));

const chat = (
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  pendingInputs: GoatBotPendingInput[] = [],
) =>
  buildGoatBotTimeline({
    visibleTurnItems: rowsOf(items),
    pendingInputs,
    readers: goatBotItemReaders,
    taskId: null,
    knownTaskIds: ["task-1", "task-2"],
    conversationOnly: true,
    answerReferences: true,
  }).filter((row) => row.kind !== "day");

const ids = (rows: GoatBotRow[]) => rows.map((row) => row.id);
const bot = (rows: GoatBotRow[], id: string) => rows.find((row) => row.id === id);

describe("a task question's answer comes from what the server recorded", () => {
  it("folds the recorded pick into the question, and shows recorded typed words as the answer", () => {
    const picked = chat([
      card("task-1", 2, [], [{ questionId: "q1", inputId: "in-u1" }]),
      question("b1", 1, "task-1", "q1"),
      person("u1", 2, "Clear", { taskId: "task-1", answersQuestionId: "q1" }),
    ]);
    expect(ids(picked)).toEqual(["b1"]);
    expect(bot(picked, "b1")).toMatchObject({
      options: [],
      answer: "Clear",
      answerIndex: 1,
      answerInputRowId: "u1",
    });

    const typed = chat([
      card("task-1", 2, [], [{ questionId: "q1", inputId: "in-u1" }]),
      question("b1", 1, "task-1", "q1"),
      person("u1", 2, "Use the staging cache", { taskId: "task-1", answersQuestionId: "q1" }),
    ]);
    expect(ids(typed)).toEqual(["b1", "u1"]);
    expect(bot(typed, "b1")).toMatchObject({ answer: "Use the staging cache" });
    expect(bot(typed, "b1")).not.toHaveProperty("answerIndex");
  });

  it("shows a pick still on its way in the question, and keeps the choices when it failed", () => {
    const on = chat(
      [card("task-1", 1, ["q1"]), question("b1", 1, "task-1", "q1")],
      [sending("k", 2, "Keep", "q1")],
    );
    expect(ids(on)).toEqual(["b1"]);
    expect(bot(on, "b1")).toMatchObject({
      answer: "Keep",
      answerIndex: 0,
      answerSending: true,
      answerInputRowId: "pending:k",
    });

    const failed = chat(
      [card("task-1", 1, ["q1"]), question("b1", 1, "task-1", "q1")],
      [sending("k", 2, "Keep", "q1", "failed")],
    );
    expect(ids(failed)).toEqual(["b1", "pending:k"]);
    expect(bot(failed, "b1")).toMatchObject({ options: ["Keep", "Clear"] });
    expect(bot(failed, "b1")).not.toHaveProperty("answer");
  });

  it("shows a sent pick the server has not recorded (refused, or not told yet) as a plain message", () => {
    const rows = chat([
      card("task-1", 2, ["q1"], []),
      question("b1", 1, "task-1", "q1"),
      person("u1", 2, "Keep", { taskId: "task-1", answersQuestionId: "q1" }),
    ]);
    expect(ids(rows)).toEqual(["b1", "u1"]);
    expect(bot(rows, "b1")).toMatchObject({ options: ["Keep", "Clear"] });
    expect(bot(rows, "b1")).not.toHaveProperty("answer");
  });

  it("never takes a pick for another question: queued before a re-ask, or for another task", () => {
    const reasked = chat(
      [
        card("task-1", 3, ["q2"], [{ questionId: "q1", inputId: "in-u1" }]),
        question("b1", 1, "task-1", "q1"),
        person("u1", 2, "Keep", { taskId: "task-1", answersQuestionId: "q1" }),
        question("b2", 10, "task-1", "q2"),
      ],
      [sending("late", 5, "Clear", "q1")],
    );
    expect(bot(reasked, "b1")).toMatchObject({ answer: "Keep", answerIndex: 0 });
    expect(bot(reasked, "b2")).toMatchObject({ options: ["Keep", "Clear"] });
    expect(bot(reasked, "b2")).not.toHaveProperty("answer");

    const otherTask = chat(
      [
        card("task-1", 1, ["q1"]),
        card("task-2", 1, ["q9"]),
        question("b1", 1, "task-1", "q1"),
        question("b9", 2, "task-2", "q9"),
      ],
      [{ ...sending("k", 3, "Keep", "q9"), taskId: "task-2" }],
    );
    expect(bot(otherTask, "b1")).toMatchObject({ options: ["Keep", "Clear"] });
    expect(bot(otherTask, "b1")).not.toHaveProperty("answer");
    expect(bot(otherTask, "b9")).toMatchObject({ answer: "Keep", answerSending: true });
  });

  it("keeps a later message to the task out of the chat, whatever its words", () => {
    const rows = chat([
      card("task-1", 2, [], [{ questionId: "q1", inputId: "in-u1" }]),
      question("b1", 1, "task-1", "q1"),
      person("u1", 2, "Use staging", { taskId: "task-1", answersQuestionId: "q1" }),
      person("u2", 30, "Clear", { taskId: "task-1" }),
    ]);
    expect(ids(rows)).toEqual(["b1", "u1"]);
    expect(bot(rows, "b1")).toMatchObject({ answer: "Use staging" });
  });

  it("never lets an older question without a record take a new question's answer", () => {
    // A legacy question (no record) offering the same choice comes after the new one.
    const items = [
      card("task-1", 2, [], [{ questionId: "q1", inputId: "in-u1" }]),
      question("b1", 1, "task-1", "q1"),
      question("b0", 2, "task-2", "legacy", null),
      person("u1", 3, "Keep", { taskId: "task-1" }),
    ];
    const decided = chat(items);
    expect(bot(decided, "b1")).toMatchObject({ answer: "Keep", answerIndex: 0 });
    expect(bot(decided, "b0")).not.toHaveProperty("answer");
    const stillSending = chat(items.slice(1, 3), [sending("k", 3, "Keep", "q1")]);
    expect(bot(stillSending, "b0")).not.toHaveProperty("answer");
    expect(bot(stillSending, "b1")).toMatchObject({ answer: "Keep", answerSending: true });
  });
});

describe("a task question whose card has not arrived", () => {
  it("still names its task and question, so a pick answers it and no other", () => {
    // Two tasks offer the same choice; neither card has reached the chat yet.
    const rows = chat([question("bA", 1, "task-1", "qA"), question("bB", 2, "task-2", "qB")]);
    expect(bot(rows, "bA")).toMatchObject({ answerTaskId: "task-1", answerQuestionId: "qA" });
    expect(bot(rows, "bB")).toMatchObject({ answerTaskId: "task-2", answerQuestionId: "qB" });
  });

  it("shows a send the server already took as a plain message until its record says more", () => {
    const rows = chat(
      [card("task-1", 1, ["q1"]), question("b1", 1, "task-1", "q1")],
      [sending("k", 2, "Keep", "q1", "accepted")],
    );
    expect(ids(rows)).toEqual(["b1", "pending:k"]);
    expect(bot(rows, "b1")).not.toHaveProperty("answer");
  });
});

/** The bot's reply to one of the person's messages. */
const replyTo = (id: string, second: number, text: string, inputId: string) =>
  item({
    id,
    at: at(second),
    type: "assistant_message",
    messageId: "m-" + id,
    text,
    streaming: false,
    channel: { ...meta, kind: "reply", inReplyToInputId: inputId },
  });

describe("an answer the server refused stays what the person said", () => {
  it.each([
    { label: "a pick", text: "Keep" },
    { label: "typed words", text: "Use the staging cache" },
  ])("keeps $label sent to a question closed elsewhere, with the refusal after it", ({ text }) => {
    // Answered on another channel first: the card names an input this chat never saw.
    const rows = chat([
      card("task-1", 2, [], [{ questionId: "q1", inputId: "in-slack" }]),
      question("b1", 1, "task-1", "q1"),
      person("u1", 3, text, { taskId: "task-1", answersQuestionId: null }),
      replyTo("r1", 4, "That question was already answered.", "in-u1"),
    ]);
    expect(ids(rows)).toEqual(["b1", "u1", "r1"]);
    expect(bot(rows, "b1")).not.toHaveProperty("answer");
  });

  it("never folds a refused pick into an earlier question that offers the same choice", () => {
    const rows = chat([
      question("b0", 1, "task-2", "legacy", null),
      card("task-1", 2, [], [{ questionId: "q1", inputId: "in-slack" }]),
      question("b1", 2, "task-1", "q1"),
      person("u1", 3, "Keep", { taskId: "task-1", answersQuestionId: null }),
    ]);
    expect(ids(rows)).toEqual(["b0", "b1", "u1"]);
    expect(bot(rows, "b0")).toMatchObject({ options: ["Keep", "Clear"] });
    expect(bot(rows, "b0")).not.toHaveProperty("answer");
  });

  it("keeps a message with no verdict, as an older server stores it, as before", () => {
    const rows = chat([
      card("task-1", 2, [], [{ questionId: "q1", inputId: "in-slack" }]),
      question("b1", 1, "task-1", "q1"),
      person("u1", 3, "Use the staging cache", { taskId: "task-1" }),
    ]);
    expect(ids(rows)).toEqual(["b1"]);
  });
});

describe("the card's record of who answered wins over the message's own claim", () => {
  it("shows a second claim on a question the card says another message answered as a plain message", () => {
    const rows = chat([
      card("task-1", 2, [], [{ questionId: "q1", inputId: "in-u1" }]),
      question("b1", 1, "task-1", "q1"),
      person("u1", 2, "Keep", { taskId: "task-1", answersQuestionId: "q1" }),
      person("u2", 3, "Clear", { taskId: "task-1", answersQuestionId: "q1" }),
    ]);
    expect(ids(rows)).toEqual(["b1", "u2"]);
    expect(bot(rows, "b1")).toMatchObject({ answer: "Keep", answerIndex: 0 });
  });

  it("folds a message recorded as refused when the card names it as the answer", () => {
    const rows = chat([
      card("task-1", 2, [], [{ questionId: "q1", inputId: "in-u1" }]),
      question("b1", 1, "task-1", "q1"),
      person("u1", 2, "Keep", { taskId: "task-1", answersQuestionId: null }),
    ]);
    expect(ids(rows)).toEqual(["b1"]);
    expect(bot(rows, "b1")).toMatchObject({ answer: "Keep", answerIndex: 0 });
  });
});

/** A task's own view of the same thread, without the task's card that leads it. */
const taskView = (
  taskId: string,
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  pendingInputs: GoatBotPendingInput[] = [],
) =>
  buildGoatBotTimeline({
    visibleTurnItems: rowsOf(items),
    pendingInputs,
    readers: goatBotItemReaders,
    taskId,
    knownTaskIds: ["task-1", "task-2"],
    conversationOnly: true,
    answerReferences: true,
  }).filter((row) => row.kind !== "day" && row.kind !== "task");

describe("a task's own view answers its questions by reference (#2977)", () => {
  it("names the task and question on its question, so a pick there sends both", () => {
    const rows = taskView("task-1", [card("task-1", 1, ["q1"]), question("b1", 1, "task-1", "q1")]);
    expect(bot(rows, "b1")).toMatchObject({ answerTaskId: "task-1", answerQuestionId: "q1" });
  });

  it("keeps a refused pick as what the person said, even while the question stays open", () => {
    const rows = taskView("task-1", [
      card("task-1", 2, ["q1"], []),
      question("b1", 1, "task-1", "q1"),
      person("u1", 2, "Keep", { taskId: "task-1", answersQuestionId: null }),
    ]);
    expect(ids(rows)).toEqual(["b1", "u1"]);
    expect(bot(rows, "b1")).toMatchObject({ options: ["Keep", "Clear"] });
    expect(bot(rows, "b1")).not.toHaveProperty("answer");
  });

  it("folds the recorded answer and the pick still on its way, and leaves other tasks out", () => {
    const recorded = taskView("task-1", [
      card("task-1", 2, [], [{ questionId: "q1", inputId: "in-u1" }]),
      question("b1", 1, "task-1", "q1"),
      person("u1", 2, "Clear", { taskId: "task-1", answersQuestionId: "q1" }),
      question("b9", 3, "task-2", "q9"),
      person("u9", 4, "Keep", { taskId: "task-2", answersQuestionId: "q9" }),
    ]);
    expect(ids(recorded)).toEqual(["b1"]);
    expect(bot(recorded, "b1")).toMatchObject({ answer: "Clear", answerIndex: 1 });

    const sendingNow = taskView(
      "task-1",
      [card("task-1", 1, ["q1"]), question("b1", 1, "task-1", "q1")],
      [sending("k", 2, "Keep", "q1")],
    );
    expect(ids(sendingNow)).toEqual(["b1"]);
    expect(bot(sendingNow, "b1")).toMatchObject({ answer: "Keep", answerSending: true });
  });

  it("leaves approvals and questions without a task record to the older matching", () => {
    const rows = taskView("task-1", [
      card("task-1", 1, ["legacy"]),
      question("b0", 1, "task-1", "legacy", null),
      person("u1", 2, "Keep", { taskId: "task-1" }),
    ]);
    expect(bot(rows, "b0")).not.toHaveProperty("answerQuestionId");
    expect(bot(rows, "b0")).toMatchObject({ answer: "Keep", answerIndex: 0 });
  });
});
