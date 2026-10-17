import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ChannelReceptionModelOutput, toChannelReceptionResult } from "./channelReceptionPrompt.ts";

const emptyOutput = {
  replyText: "Okay.",
  action: "report_only",
  title: "",
  instruction: "",
  projectId: "",
  host: "",
  taskId: "",
  questionId: "",
  answer: "",
  question: "",
  options: [],
  remember: "",
  rememberQuote: "",
  notesChangeRequested: "",
} satisfies ChannelReceptionModelOutput;

const decodeModelOutput = Schema.decodeUnknownSync(ChannelReceptionModelOutput);

const convert = (overrides: Partial<ChannelReceptionModelOutput>) =>
  Option.getOrThrow(toChannelReceptionResult({ ...emptyOutput, ...overrides }));

describe("channel reception note request conversion", () => {
  it("decodes and converts a move with its destination, rejecting missing fields", () => {
    const output = { ...emptyOutput, action: "move_task", taskId: "task-1", host: " mini " };
    const decoded = decodeModelOutput(output);
    expect(Option.getOrThrow(toChannelReceptionResult(decoded))).toEqual({
      replyText: "Okay.",
      action: { type: "move_task", taskId: "task-1", host: "mini" },
    });
    expect(toChannelReceptionResult({ ...decoded, host: " " })).toEqual(Option.none());
    expect(toChannelReceptionResult({ ...decoded, taskId: "" })).toEqual(Option.none());
  });

  it("requires both new keys in the flat structured output", () => {
    expect(decodeModelOutput(emptyOutput)).toEqual(emptyOutput);
    const { rememberQuote: _quote, ...noQuote } = emptyOutput;
    const { notesChangeRequested: _change, ...noChange } = emptyOutput;
    expect(() => decodeModelOutput(noQuote)).toThrow();
    expect(() => decodeModelOutput(noChange)).toThrow();
  });

  it("only attaches a trimmed rememberQuote when there is a note to remember", () => {
    expect(convert({ remember: " Reply in Korean. ", rememberQuote: " remember that " })).toEqual({
      replyText: "Okay.",
      action: { type: "report_only" },
      remember: "Reply in Korean.",
      rememberQuote: "remember that",
    });
    expect(convert({ remember: " \n ", rememberQuote: "remember that" })).toEqual({
      replyText: "Okay.",
      action: { type: "report_only" },
    });
    expect(convert({ remember: "Reply in Korean.", rememberQuote: " \n " })).toEqual({
      replyText: "Okay.",
      action: { type: "report_only" },
      remember: "Reply in Korean.",
    });
  });

  it("puts notesChangeRequested only on create_task and omits empty strings", () => {
    expect(
      convert({
        action: "create_task",
        title: "Forget a note",
        instruction: "Remove it.",
        notesChangeRequested: " forget the Korean note ",
      }),
    ).toEqual({
      replyText: "Okay.",
      action: {
        type: "create_task",
        title: "Forget a note",
        instruction: "Remove it.",
        notesChangeRequested: "forget the Korean note",
      },
    });
    expect(
      convert({
        action: "create_task",
        title: "Build",
        instruction: "Build it.",
        notesChangeRequested: " \n ",
      }),
    ).toEqual({
      replyText: "Okay.",
      action: { type: "create_task", title: "Build", instruction: "Build it." },
    });
    for (const action of [
      "report_only",
      "status",
      "answer_question",
      "clarify",
      "move_task",
    ] as const) {
      const result = convert({
        action,
        notesChangeRequested: "forget the Korean note",
        taskId: "task-1",
        host: "mini",
        questionId: "question-1",
        answer: "staging",
        question: "Which project?",
      });
      expect(result).not.toHaveProperty("notesChangeRequested");
      expect(result.action).not.toHaveProperty("notesChangeRequested");
      expect(result).not.toHaveProperty("rememberQuote");
      expect(result).not.toHaveProperty("remember");
    }
  });
});
