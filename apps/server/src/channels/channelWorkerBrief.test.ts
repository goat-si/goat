import { assert, describe, it } from "@effect/vitest";
import { ChannelTaskId } from "@goat/contracts";

import { NOTES_REPLACED_RULE } from "./channelBotNotes.ts";
import { EMPTY_NOTES } from "./channelBotNotesRecall.ts";

import {
  channelWorkerRules,
  GOAT_BOT_READ_ONLY_RULE,
  GOAT_BOT_SUPERVISOR_RULE,
  REMOTE_MESSAGE_CHARS,
  remoteWorkerMessage,
  skillsNamedIn,
  turnInstruction,
  workerInstruction,
} from "./channelWorkerBrief.ts";

const task = {
  taskId: ChannelTaskId.make("channel-task:1"),
  generation: 2,
  instruction: "Ship the release using the deploy-staging skill.",
};
const files = {
  dir: "/bot",
  notes: "/bot/memory.md",
  skills: "/bot/skills",
  scratch: "/bot/scratch",
  artifacts: "/bot/artifacts",
};

describe("channel worker brief", () => {
  it("tells agents that read the notes file which of two lines wins", () => {
    assert.include(workerInstruction(task, files), NOTES_REPLACED_RULE);
    assert.include(turnInstruction(task, files, false), NOTES_REPLACED_RULE);
  });

  it("lets a turn edit only the notes file, and only when the person asked to change a note", () => {
    const plain = turnInstruction(task, files, true);
    assert.include(plain, "Leave the notes file unchanged");
    assert.notInclude(plain, "Exception to the read-only rule");
    const asked = turnInstruction(
      { ...task, notesChangeRequested: "forget the draft rule" },
      files,
      true,
    );
    const exception = asked.indexOf("Exception to the read-only rule above");
    assert.isAbove(exception, asked.indexOf(GOAT_BOT_READ_ONLY_RULE));
    assert.isAbove(exception, asked.indexOf(GOAT_BOT_SUPERVISOR_RULE));
    assert.include(asked.slice(exception), files.notes);
    assert.notInclude(asked, "Leave the notes file unchanged");
  });

  it("gives workers on both machines the same confirmation, progress and result rules", () => {
    const local = channelWorkerRules("local");
    const remote = channelWorkerRules("remote");
    const askFirst = (lines: ReadonlyArray<string>) =>
      lines.find((line) => line.startsWith("Before anything sent under the person's name")) ?? "";
    assert.include(askFirst(local), "waiting_input question");
    assert.include(askFirst(remote), "needs_input report");
    assert.include(
      local.join("\n"),
      'goat_call {path:"channel.task_report"} with status "running" and milestone true',
    );
    assert.include(remote.join("\n"), 'goat_call {path:"origin.report"} with status progress');
    assert.include(remote.join("\n"), 'goat_call {path:"thread.report_result"}');
    assert.strictEqual(local.length, remote.length);
  });

  it("carries the home machine's notes and named skills to a remote worker", () => {
    const message = remoteWorkerMessage(task, {
      notes: { ...EMPTY_NOTES, standing: "- 2026-10-17: open PRs as drafts" },
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
    const plain = remoteWorkerMessage(task, { notes: EMPTY_NOTES, skills: [] });
    assert.notInclude(plain, "goat_bot_notes");
    const change = remoteWorkerMessage(
      { ...task, notesChangeRequested: "forget the draft rule" },
      { notes: EMPTY_NOTES, skills: [] },
    );
    assert.include(change, '"forget the draft rule"');
    assert.include(change, "still needs to be made there");
  });

  it("drops skills, then notes, to keep the message within what the remote accepts", () => {
    const context = {
      notes: { ...EMPTY_NOTES, standing: "n".repeat(3_000) },
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

  it.each([false, true])(
    "tells a bot turn its final message is the whole answer, not a short summary (supervisor: %s)",
    (supervisor) => {
      const brief = turnInstruction(task, files, supervisor);
      assert.include(brief, "Your final message is your answer to the person");
      assert.include(brief, "as long as the content needs");
      assert.notInclude(brief, "short summary");
      assert.notInclude(brief, "short and outcome first");
      // GOAT drops lines with these prefixes before delivery, so verification must be prose.
      assert.include(brief, "never start a line with NOT RUN:");
      assert.notInclude(brief, "NOT RUN line");
      if (supervisor)
        assert.include(
          brief,
          'ask the person through goat_call {path:"decision.request"} for a merge manager',
        );
    },
  );

  it("keeps asking coding workers for a short summary for their card", () => {
    assert.include(workerInstruction(task, files), "a short summary");
  });
});
