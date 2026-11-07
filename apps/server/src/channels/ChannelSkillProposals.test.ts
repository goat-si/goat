import { assert, describe, it } from "@effect/vitest";
import {
  type ChannelReceptionInput,
  type ChannelSkillProposal,
  type ChannelTask,
  ChannelTaskEventId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as HostProcess from "@goat/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import { channelBotFilesFor } from "./channelBotNotes.ts";
import { makeSkillProposalAnswers } from "./channelSkillProposals.ts";
import { mayAnswerTask, skillFileText } from "./channelSkillProposalText.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import {
  botMessages,
  defaultScript,
  goatInput,
  linkSlackUser,
  makeHarness,
  owner,
  ownerId,
  rpcContext,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

const proposal: ChannelSkillProposal = {
  name: "deploy-check",
  summary: "Check a deploy before Monday",
  text: "# Deploy check\n\n1. Open the pipeline.\n2. Compare the released tag.",
};
const BODY = "Compare the released tag";

const harnessCapturing = () => {
  const harness = makeHarness();
  const inputs: Array<ChannelReceptionInput> = [];
  harness.script.current = (input) => {
    inputs.push(input);
    // The open-work and work reads are the other way a pass can see a question's text.
    if (input.mode === "input" && input.inputText === "what is open?" && input.readsAllowed)
      return Effect.succeed({
        replyText: "Checking.",
        action: {
          type: "read",
          reads: [
            { kind: "pending", query: "open" },
            { kind: "work", query: "deploy" },
          ],
        },
      });
    return defaultScript(input);
  };
  return { harness, inputs };
};

const skillsDir = Effect.gen(function* () {
  const path = yield* Path.Path;
  return channelBotFilesFor(path, (yield* ServerConfig.ServerConfig).stateDir).skills;
});

const allTasks = Effect.gen(function* () {
  const ledger = yield* ChannelLedger.ChannelLedger;
  return (yield* ledger.listTasks({ ownerId, limit: 20 })).tasks;
});

const proposalTask = Effect.map(allTasks, (tasks) =>
  tasks.find((task) => task.skillProposal !== undefined),
);

const send = (text: string, key: string) =>
  Effect.gen(function* () {
    yield* (yield* ChannelGateway.ChannelGateway).ingest(goatInput(text, key), rpcContext);
    yield* (yield* ChannelRuntime.ChannelRuntime).drain;
  });

/** A GOAT app task whose worker finishes with `skillProposal`; the next drain asks about it. */
const finishWith = <R = never>(
  harness: ReturnType<typeof makeHarness>,
  skillProposal: ChannelSkillProposal = proposal,
  start: Effect.Effect<void, never, R> | undefined = undefined,
) =>
  Effect.gen(function* () {
    yield* setupBot;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    if (start === undefined) yield* send("do: check the deploy", "source");
    else yield* start;
    const [source] = yield* allTasks;
    assert.isDefined(source?.worker);
    const threadId = source!.worker!.threadId;
    yield* (yield* ChannelWorkerReports.ChannelWorkerReports).report(
      {
        taskId: source!.taskId,
        eventId: ChannelTaskEventId.make("completed-with-skill"),
        generation: source!.generation,
        status: "completed",
        summary: "Checked the deploy.",
        skillProposal,
      },
      threadId,
    );
    harness.world.setStatus(threadId, 1, "completed", "Checked the deploy.");
    yield* (yield* ChannelWorkerReports.ChannelWorkerReports).reconcile(runtime.ownerToken);
    yield* runtime.drain;
    return source!;
  });

const completions = (taskId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly type: string }>`
      SELECT type FROM channel_task_events WHERE task_id = ${taskId} AND type = 'task.completed'`;
  });

describe("GOAT Bot skill proposals", () => {
  it.effect(
    "asks the GOAT app requester once with the whole text, shows models only the first line, and saves on Save",
    () => {
      const { harness, inputs } = harnessCapturing();
      return Effect.gen(function* () {
        const source = yield* finishWith(harness);
        const asked = yield* proposalTask;
        assert.strictEqual(asked?.status, "waiting_input");
        assert.isUndefined(asked?.worker);
        const question = asked!.openQuestions[0]!;
        assert.deepStrictEqual(question.options, ["Save", "Not now"]);
        assert.isTrue(
          question.text.startsWith(
            "Save this as a skill? deploy-check: Check a deploy before Monday",
          ),
        );
        assert.include(question.text, BODY);
        const shown = (yield* botMessages).messages.map((message) => message.text).join("\n");
        assert.include(shown, BODY);

        // A message while the question is open: every pass and read sees the first line only.
        const launches = harness.world.launches.length;
        yield* send("what is open?", "while-open");
        assert.isDefined(inputs.at(-1)?.readResults);
        const seen = JSON.stringify(inputs.slice(-2));
        assert.include(seen, "Save this as a skill? deploy-check");
        assert.notInclude(seen, BODY);

        yield* send("Save", "save");
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const saved = yield* fs.readFileString(path.join(yield* skillsDir, "deploy-check.md"));
        assert.isTrue(saved.startsWith(proposal.text + "\n\n---\nProposed by GOAT Bot after "));
        assert.include(saved, "after check the deploy on ");
        assert.include(saved, "; approved by ");
        const done = yield* proposalTask;
        assert.strictEqual(done?.status, "completed");
        assert.strictEqual(done?.resultSummary, "Saved the skill deploy-check.");
        assert.lengthOf(yield* completions(source.taskId), 1);
        // Never a worker: no claim, no launch.
        assert.strictEqual(harness.world.launches.length, launches);
        const sql = yield* SqlClient.SqlClient;
        const claimed = yield* sql`SELECT 1 FROM channel_task_events
          WHERE task_id = ${done!.taskId} AND type = 'task.dispatch.claimed'`;
        assert.lengthOf(claimed, 0);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("refuses an answer that is neither choice and writes nothing on Not now", () => {
    const { harness } = harnessCapturing();
    harness.script.current = (input) => {
      const asking = input.tasks.find((task) => task.openQuestions.length > 0);
      return input.mode === "input" && input.inputText === "later, maybe" && asking !== undefined
        ? Effect.succeed({
            replyText: "Noted.",
            action: {
              type: "answer_question",
              taskId: asking.taskId,
              questionId: asking.openQuestions[0]!.questionId,
              answer: "later, maybe",
            },
          })
        : defaultScript(input);
    };
    return Effect.gen(function* () {
      yield* finishWith(harness);
      const task = (yield* proposalTask)!;
      yield* send("later, maybe", "off-card");
      assert.strictEqual((yield* proposalTask)?.status, "waiting_input");
      const shown = (yield* botMessages).messages.map((message) => message.text).join("\n");
      assert.include(shown, "Answer Save or Not now.");
      yield* send("Not now", "decline");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      assert.isFalse(yield* fs.exists(path.join(yield* skillsDir, "deploy-check.md")));
      const done = yield* proposalTask;
      assert.strictEqual(done?.taskId, task.taskId);
      assert.strictEqual(done?.status, "completed");
      assert.strictEqual(done?.resultSummary, "Not saved.");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("offers nothing for Slack work, a secret-like text, or a name already saved", () => {
    const slack = makeHarness();
    const fromSlack = Effect.gen(function* () {
      yield* finishWith(
        slack,
        proposal,
        Effect.gen(function* () {
          yield* linkSlackUser();
          yield* (yield* ChannelGateway.ChannelGateway).ingest(
            slackInput("do: check the deploy", "slack-source"),
            slackContext,
          );
          yield* (yield* ChannelRuntime.ChannelRuntime).drain;
        }).pipe(Effect.orDie),
      );
      assert.isUndefined(yield* proposalTask);
    }).pipe(Effect.provide(slack.layer));

    const secret = makeHarness();
    const withSecret = Effect.gen(function* () {
      yield* finishWith(secret, {
        ...proposal,
        text: "Use ghp_" + "a".repeat(36) + " to log in.",
      });
      assert.isUndefined(yield* proposalTask);
    }).pipe(Effect.provide(secret.layer));

    const taken = makeHarness();
    const nameTaken = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* skillsDir;
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.writeFileString(path.join(dir, "deploy-check.md"), "# Mine\n");
      yield* finishWith(taken);
      assert.isUndefined(yield* proposalTask);
    }).pipe(Effect.provide(taken.layer));

    return Effect.all([fromSlack, withSecret, nameTaken], { discard: true });
  });

  it.effect("lets only the requester answer a proposal", () =>
    Effect.sync(() => {
      const requester = {
        ownerId: "owner",
        principalId: "owner",
        displayName: "Jun",
        originKind: "goat" as const,
        runtimeModeCeiling: "approval-required" as const,
        grantedScopes: ["orchestration:operate" as const],
      };
      const task = { requester, skillProposal: { ...proposal } } as unknown as ChannelTask;
      assert.isTrue(mayAnswerTask(requester, task));
      assert.isFalse(mayAnswerTask({ ...requester, principalId: "teammate" }, task));
      assert.isTrue(
        mayAnswerTask(
          { ...requester, principalId: "teammate" },
          { ...task, skillProposal: undefined },
        ),
      );
    }),
  );

  it.effect(
    "a save resumed after the proposal settled as taken writes nothing, even once the other file is gone",
    () => {
      const { harness } = harnessCapturing();
      return Effect.gen(function* () {
        yield* finishWith(harness);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* skillsDir;
        yield* fs.makeDirectory(dir, { recursive: true });
        const target = path.join(dir, "deploy-check.md");
        yield* fs.writeFileString(target, "# Someone else's skill\n");
        const ledger = yield* ChannelLedger.ChannelLedger;
        const asked = (yield* proposalTask)!;
        yield* send("Save", "save-taken");
        const done = yield* proposalTask;
        assert.strictEqual(
          done?.resultSummary,
          "A skill named deploy-check already exists, so nothing was saved.",
        );
        assert.strictEqual(yield* fs.readFileString(target), "# Someone else's skill\n");
        yield* fs.remove(target);
        // The snapshot an earlier attempt held: answered, still received.
        const stale = (yield* ledger.getTask(asked.taskId))!;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const proposals = yield* makeSkillProposalAnswers;
        yield* proposals.advance(
          {
            ...stale,
            task: {
              ...stale.task,
              status: "received",
              openQuestions: [],
              version: asked.version + 1,
            },
          },
          runtime.ownerToken,
        );
        assert.isFalse(yield* fs.exists(target));
        assert.lengthOf(yield* completions(asked.taskId), 1);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "two saves at once write one file and one completion; a foreign owner writes nothing",
    () => {
      const { harness } = harnessCapturing();
      return Effect.gen(function* () {
        yield* finishWith(harness);
        const asked = (yield* proposalTask)!;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const proposals = yield* makeSkillProposalAnswers;
        // The recorded Save, committed directly so no runtime pass settles it first.
        const stored = (yield* commitTransition(
          ledger,
          (yield* ledger.getTask(asked.taskId))!,
          {
            type: "task.question.answered",
            payload: { questionId: asked.openQuestions[0]!.questionId, answer: "Save" },
          },
          { owner: runtime.ownerToken },
        ))!;
        assert.strictEqual(stored.status, "received");
        const current = (yield* ledger.getTask(asked.taskId))!;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const target = path.join(yield* skillsDir, "deploy-check.md");
        const foreign = yield* Effect.flip(proposals.advance(current, "another-process"));
        assert.strictEqual(foreign.reason, "ownership_lost");
        assert.isFalse(yield* fs.exists(target));
        yield* Effect.all(
          [
            proposals.advance(current, runtime.ownerToken),
            proposals.advance(current, runtime.ownerToken),
          ],
          { concurrency: 2, discard: true },
        );
        assert.isTrue(yield* fs.exists(target));
        assert.lengthOf(yield* completions(asked.taskId), 1);
        const leftovers = (yield* fs.readDirectory(yield* skillsDir)).filter((name) =>
          name.endsWith(".tmp"),
        );
        assert.deepStrictEqual(leftovers, []);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "a save whose record rolled back after the link is finished as saved on the next pass",
    () => {
      const { harness } = harnessCapturing();
      return Effect.gen(function* () {
        yield* finishWith(harness);
        const asked = (yield* proposalTask)!;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        yield* commitTransition(
          ledger,
          (yield* ledger.getTask(asked.taskId))!,
          {
            type: "task.question.answered",
            payload: { questionId: asked.openQuestions[0]!.questionId, answer: "Save" },
          },
          { owner: runtime.ownerToken },
        );
        // What a link followed by a failed commit leaves: the approved file, the task still received.
        const [answer] = yield* ledger.recentAnswers(asked.taskId, 1);
        const expected = skillFileText({
          taskId: asked.taskId,
          proposal: asked.skillProposal!,
          approvedAt: answer!.occurredAt,
        });
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* skillsDir;
        yield* fs.makeDirectory(dir, { recursive: true });
        const target = path.join(dir, "deploy-check.md");
        yield* fs.writeFileString(target, expected);
        // A stop cannot strand it: an answered proposal only completes.
        assert.strictEqual((yield* ledger.getTask(asked.taskId))?.task.status, "received");
        assert.isUndefined(
          yield* commitTransition(
            ledger,
            (yield* ledger.getTask(asked.taskId))!,
            { type: "task.cancelled", payload: {} },
            { owner: runtime.ownerToken },
          ),
        );
        yield* runtime.drain;
        const done = yield* proposalTask;
        assert.strictEqual(done?.status, "completed");
        assert.strictEqual(done?.resultSummary, "Saved the skill deploy-check.");
        assert.strictEqual(yield* fs.readFileString(target), expected);
        assert.lengthOf(yield* completions(asked.taskId), 1);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "a retry that cannot write its temp file still reports the save an earlier link left",
    () => {
      const { harness } = harnessCapturing();
      return Effect.gen(function* () {
        yield* finishWith(harness);
        const asked = (yield* proposalTask)!;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        yield* commitTransition(
          ledger,
          (yield* ledger.getTask(asked.taskId))!,
          {
            type: "task.question.answered",
            payload: { questionId: asked.openQuestions[0]!.questionId, answer: "Save" },
          },
          { owner: runtime.ownerToken },
        );
        const [answer] = yield* ledger.recentAnswers(asked.taskId, 1);
        const expected = skillFileText({
          taskId: asked.taskId,
          proposal: asked.skillProposal!,
          approvedAt: answer!.occurredAt,
        });
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* skillsDir;
        yield* fs.makeDirectory(dir, { recursive: true });
        const target = path.join(dir, "deploy-check.md");
        yield* fs.writeFileString(target, expected);
        // The runtime's first save attempt's temp path, taken, so its exclusive write fails.
        const firstTemp =
          ".deploy-check.md." +
          asked.taskId.replace(":", "-") +
          "." +
          runtime.ownerToken.toLowerCase().replace(/[^a-z0-9]+/gu, "-") +
          "-0.tmp";
        yield* fs.makeDirectory(path.join(dir, firstTemp));
        yield* runtime.drain;
        const done = yield* proposalTask;
        assert.strictEqual(done?.resultSummary, "Saved the skill deploy-check.");
        assert.strictEqual(yield* fs.readFileString(target), expected);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  // Permissions cannot hide a file from Windows or from root.
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32" || process.getuid?.() === 0)(
    "a save that cannot read the file at its path settles nothing until it can",
    () => {
      const { harness } = harnessCapturing();
      return Effect.gen(function* () {
        yield* finishWith(harness);
        const asked = (yield* proposalTask)!;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        yield* commitTransition(
          ledger,
          (yield* ledger.getTask(asked.taskId))!,
          {
            type: "task.question.answered",
            payload: { questionId: asked.openQuestions[0]!.questionId, answer: "Save" },
          },
          { owner: runtime.ownerToken },
        );
        const [answer] = yield* ledger.recentAnswers(asked.taskId, 1);
        const expected = skillFileText({
          taskId: asked.taskId,
          proposal: asked.skillProposal!,
          approvedAt: answer!.occurredAt,
        });
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* skillsDir;
        yield* fs.makeDirectory(dir, { recursive: true });
        const target = path.join(dir, "deploy-check.md");
        // An earlier link left the approved file, now unreadable.
        yield* fs.writeFileString(target, expected);
        yield* fs.chmod(target, 0o000);
        yield* runtime.drain;
        assert.strictEqual((yield* proposalTask)?.status, "received");
        assert.lengthOf(yield* completions(asked.taskId), 0);
        yield* fs.chmod(target, 0o644);
        yield* runtime.drain;
        assert.strictEqual((yield* proposalTask)?.resultSummary, "Saved the skill deploy-check.");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  const chipsOf = (taskId: string) =>
    Effect.map(botMessages, (records) =>
      records.turnItems.flatMap((item) =>
        item.type === "notification" && item.ledgerTask?.taskId === taskId ? [item.ledgerTask] : [],
      ),
    );

  it.effect.each([
    ["Save", "session"],
    ["Not now", "session"],
    ["Save", "reception"],
  ] as const)(
    "%s pressed in the proposal's own task view answers it once (%s routing), and its card asks in the chat",
    ([answer, routing]) => {
      const { harness } = harnessCapturing();
      return Effect.gen(function* () {
        yield* finishWith(harness);
        const asked = (yield* proposalTask)!;
        const questionId = asked.openQuestions[0]!.questionId;
        const card = (yield* chipsOf(asked.taskId)).at(-1);
        assert.isTrue(card?.askInChat);
        assert.deepStrictEqual(card?.openQuestionIds, [questionId]);
        // The question's message names its question, so a client can retire its buttons.
        const questionMeta = (yield* botMessages).turnItems.flatMap((item) =>
          item.type === "assistant_message" && item.channel?.taskId === asked.taskId
            ? [item.channel]
            : [],
        );
        assert.deepStrictEqual(
          questionMeta.map((meta) => [meta.questionId, meta.options]),
          [[questionId, ["Save", "Not now"]]],
        );
        if (routing === "reception")
          yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
            goatBotSessionRouting: "reception",
          });
        yield* (yield* ChannelGateway.ChannelGateway).ingest(
          { ...goatInput(answer, "task-view-" + answer), taskId: asked.taskId },
          rpcContext,
        );
        yield* (yield* ChannelRuntime.ChannelRuntime).drain;
        const shown = (yield* botMessages).messages.map((message) => message.text);
        assert.notInclude(shown, "That task isn't available here. Send it in the main chat.");
        const done = yield* proposalTask;
        assert.strictEqual(done?.status, "completed");
        assert.strictEqual(
          done?.resultSummary,
          answer === "Save" ? "Saved the skill deploy-check." : "Not saved.",
        );
        assert.lengthOf(yield* completions(done!.taskId), 1);
        assert.deepStrictEqual((yield* chipsOf(asked.taskId)).at(-1)?.openQuestionIds, []);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        assert.strictEqual(
          yield* fs.exists(path.join(yield* skillsDir, "deploy-check.md")),
          answer === "Save",
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("a teammate's Save in the proposal's task view is refused and saves nothing", () => {
    const { harness } = harnessCapturing();
    return Effect.gen(function* () {
      yield* finishWith(harness);
      const asked = (yield* proposalTask)!;
      yield* (yield* ChannelGateway.ChannelGateway).ingest(
        { ...goatInput("Save", "teammate-save"), taskId: asked.taskId },
        { ...rpcContext, principalId: "teammate", displayName: "Teammate" },
      );
      yield* (yield* ChannelRuntime.ChannelRuntime).drain;
      assert.strictEqual((yield* proposalTask)?.status, "waiting_input");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      assert.isFalse(yield* fs.exists(path.join(yield* skillsDir, "deploy-check.md")));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("an agent's Save naming the proposal task does not answer it", () => {
    const { harness } = harnessCapturing();
    return Effect.gen(function* () {
      yield* finishWith(harness);
      const asked = (yield* proposalTask)!;
      yield* (yield* ChannelGateway.ChannelGateway).ingest(
        {
          kind: "mcp",
          connectionId: "mcp",
          conversationKey: "default",
          externalMessageId: "agent-save",
          idempotencyKey: "agent-save",
          actor: { senderThreadId: ThreadId.make("thread:some-agent") },
          replyAddress: {
            kind: "mcp",
            connectionId: "mcp",
            requestNamespace: "ns-1",
            conversationKey: "default",
          },
          text: "Save",
          taskId: asked.taskId,
          attachments: [],
          receivedAt: "2026-10-12T00:00:00.000Z",
          intent: "message",
        },
        {
          ...owner,
          principalId: "mcp:ns-1",
          grantedScopes: ["orchestration:read", "orchestration:operate"],
          caller: { type: "mcp", requestNamespace: "ns-1" },
        },
      );
      yield* (yield* ChannelRuntime.ChannelRuntime).drain;
      assert.strictEqual((yield* proposalTask)?.status, "waiting_input");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      assert.isFalse(yield* fs.exists(path.join(yield* skillsDir, "deploy-check.md")));
    }).pipe(Effect.provide(harness.layer));
  });
});
