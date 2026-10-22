import { ChannelQuestionId, ChannelTaskId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { singleQuestionChoice } from "./channelDecisionChoices.ts";

const question = (id: string, options: ReadonlyArray<string>) => ({
  taskId: ChannelTaskId.make("task-" + id),
  questionId: ChannelQuestionId.make("question-" + id),
  options,
});

describe("singleQuestionChoice", () => {
  it("answers the one open question that offers the picked label", () => {
    const deploy = question("deploy", ["배포", "보류"]);
    const repo = question("repo", ["goat", "goat-si"]);
    // A Hangul label typed on a Mac arrives decomposed and with stray spaces.
    expect(singleQuestionChoice(" 배포 ".normalize("NFD"), [repo, deploy])).toEqual({
      taskId: deploy.taskId,
      questionId: deploy.questionId,
      answer: "배포",
    });
    expect(singleQuestionChoice("GOAT-SI", [repo, deploy])?.answer).toBe("goat-si");
  });

  it("leaves a label two open questions offer, or none does, to the model", () => {
    const first = question("first", ["Yes", "No"]);
    const second = question("second", ["Yes", "Later"]);
    expect(singleQuestionChoice("yes", [first, second])).toBeUndefined();
    expect(singleQuestionChoice("Maybe", [first, second])).toBeUndefined();
    expect(singleQuestionChoice("later", [first, second])?.questionId).toBe(second.questionId);
  });
});
