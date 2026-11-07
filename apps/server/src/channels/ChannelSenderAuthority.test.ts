import { assert, describe, it } from "@effect/vitest";
import type { AuthEnvironmentScope, ChannelReceptionInput, ChannelTaskId } from "@goat/contracts";
import { ChannelQuestionId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as ChannelDispatcher from "./ChannelDispatcher.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelIdentityService from "./ChannelIdentityService.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import { taskIdFor, turnSteerIdsFor } from "./channelIds.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import { sessionHarness } from "./ChannelBotSession.testkit.ts";
import {
  defaultScript,
  makeHarness,
  owner,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

const ROOT = "1760000000.000900";
const transport = {
  ...slackContext,
  grantedScopes: [...slackContext.grantedScopes, "memory:read", "memory:write"],
} satisfies typeof slackContext;

/** Links a Slack user with these extra scopes; the creator holds memory so the link keeps them. */
const link = (user: string, principalId: string, scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  Effect.gen(function* () {
    const identities = yield* ChannelIdentityService.ChannelIdentityService;
    const { code } = yield* identities.createLink(
      {
        connectionId: "slack-1",
        runtimeModeCeiling: "auto-accept-edits",
        grantedScopes: ["orchestration:read", "orchestration:operate", ...scopes],
      },
      {
        ...owner,
        principalId,
        displayName: principalId,
        grantedScopes: [...owner.grantedScopes, "memory:read", "memory:write"],
      },
    );
    yield* (yield* ChannelGateway.ChannelGateway).linkIdentity(
      {
        connectionId: "slack-1",
        externalActorId: user,
        code,
        idempotencyKey: "link-" + user,
        replyAddress: slackInput("", "unused").replyAddress,
      },
      slackContext,
    );
  });

const narrow = (user: string, scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql`UPDATE channel_identities SET granted_scopes_json = ${JSON.stringify(scopes)} WHERE connection_id = 'slack-1' AND external_actor_id = ${user}`,
  );

/** One Slack message in the task's thread, read by reception; nothing is forwarded yet. */
const say = (user: string, text: string, key: string) =>
  Effect.gen(function* () {
    const gateway = yield* ChannelGateway.ChannelGateway;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    yield* runtime.drain;
    const ingested = yield* gateway.ingest(slackInput(text, key, ROOT, user), transport);
    yield* (yield* ChannelReceptionService.ChannelReceptionService).receive(
      ingested.inputId,
      runtime.ownerToken,
    );
    return ingested.inputId;
  });

const forwardAll = Effect.gen(function* () {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const runtime = yield* ChannelRuntime.ChannelRuntime;
  const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
  for (const pending of yield* ledger.listPendingForwards(10))
    yield* dispatcher.forward(pending, runtime.ownerToken);
});

const start = (text: string, key: string) =>
  Effect.gen(function* () {
    const inputId = yield* say("U2", text, key);
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const taskId = taskIdFor(inputId, 0);
    yield* (yield* ChannelDispatcher.ChannelDispatcher).dispatch(taskId, runtime.ownerToken);
    return (yield* (yield* ChannelLedger.ChannelLedger).getTask(taskId))!;
  });

const task = (taskId: ChannelTaskId) =>
  Effect.flatMap(ChannelLedger.ChannelLedger, (ledger) => ledger.getTask(taskId)).pipe(
    Effect.map((stored) => stored!.task),
  );

const notices = (taskId: ChannelTaskId) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql<{
        readonly message_json: string;
      }>`SELECT message_json FROM channel_outbox WHERE task_id = ${taskId} AND cause_key LIKE 'sender-refused:%'`,
  );

/** "do:" starts work on a local worker; "more:<task> text" follows it up; "answer:<task> <question> text" answers. */
const localScript = (input: ChannelReceptionInput) => {
  const text = input.inputText ?? "";
  if (input.mode === "input" && text.startsWith("more:"))
    return Effect.succeed({
      replyText: "Passing that on.",
      action: { type: "follow_up" as const, taskId: text.slice(5).split(" ")[0] as ChannelTaskId },
    });
  if (input.mode === "input" && text.startsWith("answer:")) {
    const [taskId, questionId, ...answer] = text.slice(7).split(" ");
    return Effect.succeed({
      replyText: "Passing that on.",
      action: {
        type: "answer_question" as const,
        taskId: taskId as ChannelTaskId,
        questionId: questionId as never,
        answer: answer.join(" "),
      },
    });
  }
  return defaultScript(input);
};

const harnesses = {
  session: () => ({ harness: sessionHarness(), opening: "look: check the disk" }),
  local: () => {
    const harness = makeHarness();
    harness.script.current = localScript;
    return { harness, opening: "do: check the disk" };
  },
};

describe.each(["session", "local"] as const)("a %s worker's delivery from someone else", (kind) => {
  it.effect("drops a follow-up whose sender lost access after it was accepted", () => {
    const { harness, opening } = harnesses[kind]();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* link("U2", "teammate", ["memory:read"]);
      yield* link("U1", "colleague", ["memory:read"]);
      const stored = yield* start(opening, "start");
      assert.strictEqual(stored.task.status, "running");
      yield* say("U1", "more:" + stored.task.taskId + " colleague note", "follow");
      yield* narrow("U1", ["orchestration:read", "orchestration:operate"]);
      yield* forwardAll;
      assert.isFalse(harness.world.sends.some((send) => send.text.includes("colleague note")));
      assert.lengthOf(yield* notices(stored.task.taskId), 1);
      assert.strictEqual((yield* task(stored.task.taskId)).status, "running");
      assert.lengthOf(yield* (yield* ChannelLedger.ChannelLedger).listPendingForwards(10), 0);
      // Processing again posts nothing more.
      yield* forwardAll;
      assert.lengthOf(yield* notices(stored.task.taskId), 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("asks again when an answer's sender lost access after it was accepted", () => {
    const { harness, opening } = harnesses[kind]();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* link("U2", "teammate", ["memory:read"]);
      yield* link("U1", "colleague", ["memory:read"]);
      const stored = yield* start(opening, "start");
      const ledger = yield* ChannelLedger.ChannelLedger;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const questionId = ChannelQuestionId.make("question:disk");
      yield* commitTransition(
        ledger,
        (yield* ledger.getTask(stored.task.taskId))!,
        {
          type: "task.question.opened",
          payload: {
            question: { questionId, text: "Which disk?", askedAt: "2026-10-12T00:00:00.000Z" },
          },
        },
        { owner: runtime.ownerToken },
      );
      yield* say("U1", "answer:" + stored.task.taskId + " " + questionId + " sda", "answer");
      assert.lengthOf((yield* task(stored.task.taskId)).openQuestions, 0);
      yield* narrow("U1", ["orchestration:read", "orchestration:operate"]);
      yield* forwardAll;
      assert.isFalse(harness.world.sends.some((send) => send.text.includes("sda")));
      const asked = (yield* task(stored.task.taskId)).openQuestions;
      assert.lengthOf(asked, 1);
      assert.include(asked[0]!.text, "colleague");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("delivers the requester's own follow-up after they lost memory", () => {
    const { harness, opening } = harnesses[kind]();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* link("U2", "teammate", ["memory:read"]);
      const stored = yield* start(opening, "start");
      yield* say("U2", "more:" + stored.task.taskId + " own note", "own");
      yield* narrow("U2", ["orchestration:read", "orchestration:operate"]);
      yield* forwardAll;
      assert.isTrue(harness.world.sends.some((send) => send.text.includes("own note")));
      assert.lengthOf(yield* notices(stored.task.taskId), 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "delivers a still-allowed colleague's follow-up and an event stored without a sender",
    () => {
      const { harness, opening } = harnesses[kind]();
      return Effect.gen(function* () {
        yield* setupBot;
        yield* link("U2", "teammate", ["memory:read"]);
        yield* link("U1", "colleague", ["memory:read"]);
        const stored = yield* start(opening, "start");
        yield* say("U1", "more:" + stored.task.taskId + " allowed note", "allowed");
        yield* forwardAll;
        assert.isTrue(harness.world.sends.some((send) => send.text.includes("allowed note")));
        // A follow-up recorded before senders were stored, as a pending forward at upgrade.
        const ledger = yield* ChannelLedger.ChannelLedger;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const inputId = yield* say("U2", "hello", "old-input");
        yield* commitTransition(
          ledger,
          (yield* ledger.getTask(stored.task.taskId))!,
          {
            type: "task.followup.received",
            payload: {
              inputId,
              text: "old note",
              from: "colleague",
              generation: stored.task.generation,
            },
          },
          {
            owner: runtime.ownerToken,
            actor: "user",
            forward: true,
            pendingAnswerMessageId: turnSteerIdsFor(inputId).messageId,
          },
        );
        yield* narrow("U1", ["orchestration:read", "orchestration:operate"]);
        yield* forwardAll;
        assert.isTrue(harness.world.sends.some((send) => send.text.includes("old note")));
      }).pipe(Effect.provide(harness.layer));
    },
  );
});

describe("a local worker's follow-up", () => {
  it.effect("steers only the running run it checked, never whichever run is current", () => {
    const { harness, opening } = harnesses.local();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* link("U2", "teammate", ["memory:read"]);
      const stored = yield* start(opening, "start");
      const threadId = stored.task.worker!.threadId;
      const [run] = harness.world.runs.get(threadId)!;
      yield* say("U2", "more:" + stored.task.taskId + " pinned note", "pinned");
      yield* forwardAll;
      const send = harness.world.sends.find((entry) => entry.text.includes("pinned note"));
      assert.strictEqual(send?.mode, "steer");
      assert.strictEqual(send?.targetRunId, run!.id);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "queues instead of steering a run that holds more memory than the requester now has",
    () => {
      const { harness, opening } = harnesses.local();
      return Effect.gen(function* () {
        yield* setupBot;
        yield* link("U2", "teammate", ["memory:read", "memory:write"]);
        const stored = yield* start(opening, "start");
        const threadId = stored.task.worker!.threadId;
        const [run] = harness.world.runs.get(threadId)!;
        harness.world.runs.set(threadId, [{ ...run!, memoryGrantCeiling: "read_write" }]);
        yield* narrow("U2", ["orchestration:read", "orchestration:operate", "memory:read"]);
        yield* say("U2", "more:" + stored.task.taskId + " lowered note", "lowered");
        yield* forwardAll;
        const send = harness.world.sends.find((entry) => entry.text.includes("lowered note"));
        assert.strictEqual(send?.mode, "queue");
      }).pipe(Effect.provide(harness.layer));
    },
  );
});
