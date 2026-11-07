import { assert, describe, it } from "@effect/vitest";
import { ChannelInputId, ChannelTaskId } from "@goat/contracts";

import { NOTES_REPLACED_RULE } from "./channelBotNotes.ts";
import { EMPTY_NOTES } from "./channelBotNotesRecall.ts";
import { GOAT_BOT_SESSION_RULES } from "./channelBotSessionBrief.ts";

import {
  channelWorkerRules,
  GOAT_BOT_READ_ONLY_RULE,
  GOAT_BOT_SUPERVISOR_RULE,
  PERSONAL_DATA_RULE,
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
  it("keeps every bot and worker out of personal data the person did not ask about", () => {
    for (const brief of [
      workerInstruction(task, files),
      turnInstruction(task, files, false),
      remoteWorkerMessage(task, { notes: EMPTY_NOTES, skills: [] }),
      GOAT_BOT_SESSION_RULES,
    ])
      assert.include(brief, PERSONAL_DATA_RULE);
    // The read-only rule no longer invites reading anywhere on the machine.
    assert.notInclude(GOAT_BOT_READ_ONLY_RULE, "files anywhere on this machine");
  });

  it("reads mail and messages only through a connected connector, never around a missing one", () => {
    for (const brief of [
      workerInstruction(task, files),
      turnInstruction(task, files, false),
      remoteWorkerMessage(task, { notes: EMPTY_NOTES, skills: [] }),
      GOAT_BOT_SESSION_RULES,
    ]) {
      assert.include(brief, "only through a connector already connected for that account");
      assert.include(brief, "say the person needs to connect one first");
      assert.include(brief, "no signed-in browser session, no other CLI or app, no files on disk");
      assert.include(brief, "no updating, installing, or signing in to a tool to get there");
    }
    // A bot turn changes no tool's state, whatever the request.
    assert.include(
      turnInstruction(task, files, false),
      "no updating, installing, or signing in to apps, CLIs, browsers, or extensions",
    );
  });

  it("tells agents that read the notes file which of two lines wins", () => {
    assert.include(workerInstruction(task, files), NOTES_REPLACED_RULE);
    assert.include(turnInstruction(task, files, false), NOTES_REPLACED_RULE);
  });

  it("lets a turn edit only the notes file, and only when the person asked to change a note", () => {
    const plain = turnInstruction(task, files, true);
    assert.include(plain, "Otherwise leave the notes file unchanged.");
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

  describe("notes changes from a GOAT Bot turn", () => {
    const request = { ...task, originInputId: ChannelInputId.make("channel-input:origin") };

    it("names the request's input so the turn can say which request a notes change is for", () => {
      assert.include(turnInstruction(request, files, false), "Request input: channel-input:origin");
    });

    it("worker briefs carry no request input line", () => {
      assert.notInclude(workerInstruction(request, files), "Request input:");
      assert.notInclude(
        remoteWorkerMessage(request, { notes: EMPTY_NOTES, skills: [] }),
        "Request input:",
      );
    });

    it("the notes rule covers follow-ups sent during the turn", () => {
      const brief = turnInstruction(request, files, false);
      assert.include(brief, 'goat_call {path:"channel.notes_change"}');
      assert.include(brief, "or a follow-up GOAT sends you while you work on it");
      assert.notInclude(brief, "Leave the notes file unchanged; this message did not ask");
    });

    it("a session turn is told not to copy personal data into the notes", () => {
      assert.include(
        turnInstruction(request, files, false),
        "Never put data you read under the personal data rule into the notes",
      );
    });

    // A tidy grant once carried out a forget GOAT had refused, read from the recent conversation.
    it("a granted turn makes only its own change and hands any other notes request to GOAT now", () => {
      const granted = turnInstruction(
        { ...request, notesChangeRequested: "tidy my notes" },
        files,
        false,
      );
      assert.include(granted, "Never carry out any other notes request yourself");
      assert.include(granted, "the recent conversation");
      assert.include(granted, "GOAT already refused");
      assert.include(
        granted,
        'call goat_call {path:"channel.notes_change"} for it right away instead of waiting',
      );
      assert.notInclude(granted, "waits until this one ends");
    });

    it("a turn without a grant never acts on a notes request it only sees in the recent conversation", () => {
      assert.include(
        turnInstruction(request, files, false),
        "A notes request you only see in the recent conversation was already answered",
      );
    });

    it("a granted worker makes only its own change and sends other notes requests back", () => {
      const granted = workerInstruction(
        { ...request, notesChangeRequested: "tidy my notes" },
        files,
      );
      assert.include(granted, "Never carry out any other notes request yourself");
      assert.include(granted, "ask for it again once this task ends");
    });
  });
});
