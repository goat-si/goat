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
      { type: "answer_question", taskId: "task-1", questionId: "q-1", answer: "Use main." },
      { type: "clarify", question: "Which project?" },
      { type: "report_only" },
    ]) {
      expect(decode({ replyText: "Okay.", action })).toEqual({ replyText: "Okay.", action });
    }
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
