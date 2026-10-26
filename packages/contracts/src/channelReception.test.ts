import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ChannelReceptionAction, ChannelReceptionInput, ChannelReceptionResult } from "./index.ts";

const decode = Schema.decodeUnknownSync(ChannelReceptionResult);
const decodeAction = Schema.decodeUnknownSync(ChannelReceptionAction);

describe("reception results", () => {
  it("decodes each action the model may choose", () => {
    for (const action of [
      { type: "create_task", title: "Re-verify", instruction: "Run it again." },
      { type: "status", taskId: "task-1" },
      { type: "move_task", taskId: "task-1", host: "mini" },
      { type: "answer_question", taskId: "task-1", questionId: "q-1", answer: "Use main." },
      { type: "clarify", question: "Which project?" },
      { type: "report_only" },
    ]) {
      expect(decode({ replyText: "Okay.", action })).toEqual({ replyText: "Okay.", action });
    }
  });

  it("decodes legacy notes without quotes and accepts quotes on new results and tasks", () => {
    const legacy = {
      replyText: "Okay.",
      remember: "Reply in Korean.",
      action: { type: "report_only" },
    };
    expect(decode(legacy)).toEqual(legacy);
    expect(decode(legacy)).not.toHaveProperty("rememberQuote");
    expect(decode({ ...legacy, rememberQuote: "remember that" })).toMatchObject({
      rememberQuote: "remember that",
    });
    const action = { type: "create_task", title: "Forget a note", instruction: "Remove it." };
    expect(decodeAction(action)).toEqual(action);
    expect(decodeAction(action)).not.toHaveProperty("notesChangeRequested");
    expect(
      decodeAction({ ...action, notesChangeRequested: "forget the Korean note" }),
    ).toMatchObject({ notesChangeRequested: "forget the Korean note" });
    expect(
      decodeAction({
        ...action,
        additionalTasks: [
          { title: "Fix CI", instruction: "Fix the failing check.", projectId: "project-1" },
          { title: "Check host", instruction: "Inspect mini.", host: "mini" },
        ],
      }),
    ).toMatchObject({
      additionalTasks: [
        { title: "Fix CI", instruction: "Fix the failing check.", projectId: "project-1" },
        { title: "Check host", instruction: "Inspect mini.", host: "mini" },
      ],
    });
  });

  it("rejects actions outside the contract and empty replies", () => {
    expect(() =>
      decode({ replyText: "Okay.", action: { type: "run_shell", command: "ls" } }),
    ).toThrow();
    expect(() => decode({ replyText: "  ", action: { type: "report_only" } })).toThrow();
    expect(() =>
      decodeAction({
        type: "answer_question",
        taskId: "task-1",
      }),
    ).toThrow();
  });

  it("requires a task and a nonempty destination for a move", () => {
    for (const action of [
      { type: "move_task", taskId: "task-1" },
      { type: "move_task", host: "mini" },
      { type: "move_task", taskId: "task-1", host: "  " },
    ])
      expect(() => decodeAction(action)).toThrow();
  });

  it("reads a requested host on new work, and inputs with or without host choices", () => {
    expect(
      decodeAction({
        type: "create_task",
        title: "Build",
        instruction: "Build it.",
        host: "mac-studio",
      }),
    ).toMatchObject({ host: "mac-studio" });
    const input = {
      mode: "input",
      conversationId: "conv-1",
      originKind: "goat",
      inputText: "Build it on mac-studio",
      tail: [],
      tasks: [],
      allowedTargets: [{ projectId: "project-1", label: "goat" }],
      requester: {
        ownerId: "owner",
        principalId: "owner",
        displayName: "Jun",
        originKind: "goat",
        runtimeModeCeiling: "full-access",
        grantedScopes: ["orchestration:operate"],
      },
    };
    const decodeInput = Schema.decodeUnknownSync(ChannelReceptionInput);
    expect(decodeInput(input).allowedHosts).toBeUndefined();
    expect(decodeInput({ ...input, allowedHosts: ["mac-studio"] }).allowedHosts).toEqual([
      "mac-studio",
    ]);
  });
});
