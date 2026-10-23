import { assert, describe, it } from "@effect/vitest";
import { ChannelTaskId } from "@goat/contracts";

import {
  channelWorkerRules,
  REMOTE_MESSAGE_CHARS,
  remoteWorkerMessage,
  skillsNamedIn,
} from "./channelWorkerBrief.ts";

const task = {
  taskId: ChannelTaskId.make("channel-task:1"),
  generation: 2,
  instruction: "Ship the release using the deploy-staging skill.",
};

describe("channel worker brief", () => {
  it("gives workers on both machines the same confirmation, progress and result rules", () => {
    const local = channelWorkerRules("local");
    const remote = channelWorkerRules("remote");
    const askFirst = (lines: ReadonlyArray<string>) =>
      lines.find((line) => line.startsWith("Before anything sent under the person's name")) ?? "";
    assert.include(askFirst(local), "waiting_input question");
    assert.include(askFirst(remote), "needs_input report");
    assert.include(remote.join("\n"), 'goat_call {path:"origin.report"} with status progress');
    assert.include(remote.join("\n"), 'goat_call {path:"thread.report_result"}');
    assert.strictEqual(local.length, remote.length);
  });

  it("carries the home machine's notes and named skills to a remote worker", () => {
    const message = remoteWorkerMessage(task, {
      notes: "- 2026-10-17: open PRs as drafts",
      skills: [{ name: "deploy-staging", text: "# Deploy staging\nRun the deploy script." }],
    });
    assert.isTrue(message.startsWith(task.instruction + "\n\n---\n"));
    assert.include(
      message,
      "<goat_bot_notes>\n- 2026-10-17: open PRs as drafts\n</goat_bot_notes>",
    );
    assert.include(message, '<goat_bot_skill name="deploy-staging">\n# Deploy staging');
    assert.include(message, "ask first");
  });

  it("leaves the context out when there is none, but says a note change must happen at home", () => {
    const plain = remoteWorkerMessage(task, { notes: "", skills: [] });
    assert.notInclude(plain, "goat_bot_notes");
    const change = remoteWorkerMessage(
      { ...task, notesChangeRequested: "forget the draft rule" },
      { notes: "", skills: [] },
    );
    assert.include(change, '"forget the draft rule"');
    assert.include(change, "still needs to be made there");
  });

  it("drops skills, then notes, to keep the message within what the remote accepts", () => {
    const context = {
      notes: "n".repeat(3_000),
      skills: [
        { name: "first", text: "f".repeat(4_000) },
        { name: "second", text: "s".repeat(4_000) },
      ],
    };
    const roomy = remoteWorkerMessage(
      { ...task, instruction: "x".repeat(REMOTE_MESSAGE_CHARS - 9_000) },
      context,
    );
    assert.isAtMost(roomy.length, REMOTE_MESSAGE_CHARS);
    assert.include(roomy, "<goat_bot_notes>");
    assert.include(roomy, 'name="first"');
    assert.notInclude(roomy, 'name="second"');

    const tooLong = remoteWorkerMessage(
      { ...task, instruction: "x".repeat(REMOTE_MESSAGE_CHARS) },
      context,
    );
    assert.notInclude(tooLong, "goat_bot");
    assert.include(tooLong, 'goat_call {path:"thread.report_result"}');
  });

  it("matches skills the instruction names as whole words", () => {
    assert.deepStrictEqual(
      skillsNamedIn("Use deploy-staging, then Review it.", [
        "deploy",
        "deploy-staging",
        "review",
        "staging",
        "a+b",
      ]),
      ["deploy-staging", "review"],
    );
    assert.deepStrictEqual(skillsNamedIn("Compute a+b now", ["a+b"]), ["a+b"]);
    assert.lengthOf(skillsNamedIn("one two three four", ["one", "two", "three", "four"]), 3);
  });
});
