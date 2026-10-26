import { describe, expect, it } from "@effect/vitest";
import { ChannelConversationId, ChannelTaskId, type ChannelReceptionInput } from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  buildChannelReceptionPrompt,
  ChannelReceptionModelOutput,
  toChannelReceptionResult,
} from "./channelReceptionPrompt.ts";

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
  clarifyAbout: "other",
  reads: [],
  remember: "",
  rememberQuote: "",
  notesChangeRequested: "",
  additionalTasks: [],
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
        additionalTasks: [
          {
            title: "  Fix CI  ",
            instruction: "  Re-run and fix failing suite.  ",
            projectId: " project-2 ",
            host: " mini ",
          },
          { title: "  ", instruction: "ignored", projectId: "", host: "" },
        ],
      }),
    ).toEqual({
      replyText: "Okay.",
      action: {
        type: "create_task",
        title: "Forget a note",
        instruction: "Remove it.",
        notesChangeRequested: "forget the Korean note",
        additionalTasks: [
          {
            title: "Fix CI",
            instruction: "Re-run and fix failing suite.",
            projectId: "project-2",
            host: "mini",
          },
        ],
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

describe("channel reception project questions and other machines", () => {
  it("marks a clarify about a project so the server can word it", () => {
    expect(
      convert({
        action: "clarify",
        question: "Which project?",
        options: [],
        clarifyAbout: "project",
      }),
    ).toEqual({
      replyText: "Okay.",
      action: { type: "clarify", question: "Which project?", about: "project" },
    });
    expect(
      convert({ action: "clarify", question: "Which task?", options: [], clarifyAbout: "other" })
        .action,
    ).toEqual({ type: "clarify", question: "Which task?" });
  });
});

describe("channel reception reads", () => {
  it("keeps at most three non-empty reads and refuses a read with none", () => {
    const result = convert({
      action: "read",
      reads: [
        { kind: "work", query: " #457 " },
        { kind: "memory", query: "  " },
        { kind: "thread", query: "login" },
        { kind: "conversation", query: "score" },
        { kind: "memory", query: "deploys" },
      ],
    });
    expect(result.action).toEqual({
      type: "read",
      reads: [
        { kind: "work", query: "#457" },
        { kind: "thread", query: "login" },
        { kind: "conversation", query: "score" },
      ],
    });
    expect(
      Option.isNone(
        toChannelReceptionResult({
          ...emptyOutput,
          action: "read",
          reads: [{ kind: "work", query: "" }],
        }),
      ),
    ).toBe(true);
  });

  it("accepts a read with an empty reply, since that reply is never shown", () => {
    const result = convert({
      replyText: "",
      action: "read",
      reads: [{ kind: "memory", query: "deploys" }],
    });
    expect(result.action.type).toBe("read");
    expect(result.replyText).toBe("Looking that up.");
  });

  it("offers reading only on the first pass and shows results as records", () => {
    const input = {
      mode: "input",
      conversationId: ChannelConversationId.make("conversation:1"),
      originKind: "goat",
      inputText: "did it merge?",
      tail: [],
      tasks: [],
      allowedTargets: [],
      journal: "- 2026-10-12 00:00 Done: ship it",
      requester: {
        ownerId: "owner",
        principalId: "owner",
        displayName: "Owner",
        originKind: "goat",
        runtimeModeCeiling: "full-access",
        grantedScopes: [],
      },
    } satisfies ChannelReceptionInput;
    const first = buildChannelReceptionPrompt({ ...input, readsAllowed: true }).prompt;
    expect(first).toContain("- read: look things up before answering");
    expect(first).toContain("Done: ship it");
    const second = buildChannelReceptionPrompt({
      ...input,
      readsAllowed: false,
      readResults: [{ kind: "work", query: "#123", text: "goat-si/goat#123 (merged)" }],
    }).prompt;
    expect(second).not.toContain("- read: look things up before answering");
    expect(second).toContain("[work: #123]\ngoat-si/goat#123 (merged)");
  });
});

describe("channel reception language", () => {
  const input = {
    mode: "input",
    conversationId: ChannelConversationId.make("conversation:1"),
    originKind: "goat",
    inputText: "Create a file named approval-demo.txt containing the word hello.",
    tail: [],
    tasks: [],
    allowedTargets: [],
    requester: {
      ownerId: "owner",
      principalId: "owner",
      displayName: "Owner",
      originKind: "goat",
      runtimeModeCeiling: "full-access",
      grantedScopes: [],
    },
  } satisfies ChannelReceptionInput;

  it("names the script of an English message so the reply and title cannot default to another language", () => {
    const prompt = buildChannelReceptionPrompt(input).prompt;
    expect(prompt).toContain("Latin-script language");
    expect(prompt).toContain("replyText, title, question, and instruction");
    expect(prompt).toContain("Do not write them in Chinese");
    expect(prompt.endsWith("another language.")).toBe(true);
  });

  it("names Korean, Japanese, and Chinese from the person's own words", () => {
    expect(
      buildChannelReceptionPrompt({ ...input, inputText: "승인 데모 파일을 만들어 줘" }).prompt,
    ).toContain("The person's words are in Korean.");
    expect(
      buildChannelReceptionPrompt({ ...input, inputText: "このマシンにファイルを作って" }).prompt,
    ).toContain("The person's words are in Japanese.");
    expect(
      buildChannelReceptionPrompt({ ...input, inputText: "在这台机器上创建文件" }).prompt,
    ).toContain("The person's words are in Chinese.");
  });

  it("keeps a task update in the person's language when the update itself is in another", () => {
    const prompt = buildChannelReceptionPrompt({
      ...input,
      mode: "task_event",
      inputText: undefined,
      taskEvent: {
        taskId: ChannelTaskId.make("task:1"),
        type: "task.completed",
        summary: "已创建 approval-demo.txt",
      },
      tail: [
        {
          role: "user",
          text: "Create a file named approval-demo.txt containing the word hello.",
          at: "2026-10-20T00:00:00.000Z",
        },
      ],
    }).prompt;
    expect(prompt).toContain("Latin-script language");
    expect(prompt).toContain("Say only what the update says happened.");
  });
});

describe("channel reception turns", () => {
  it("turns run_turn into a turn with its title, instruction and quoted note change", () => {
    const result = convert({
      action: "run_turn",
      title: "Check the disk",
      instruction: "Find what fills the disk.",
      notesChangeRequested: " forget the Friday rule ",
    });
    expect(result.action).toEqual({
      type: "run_turn",
      title: "Check the disk",
      instruction: "Find what fills the disk.",
      notesChangeRequested: "forget the Friday rule",
    });
    expect(Option.isNone(toChannelReceptionResult({ ...emptyOutput, action: "run_turn" }))).toBe(
      true,
    );
  });
});

describe("channel reception follow-ups", () => {
  it("turns follow_up into the task it joins", () => {
    expect(convert({ action: "follow_up", taskId: "task:1" }).action).toEqual({
      type: "follow_up",
      taskId: "task:1",
    });
  });
});
