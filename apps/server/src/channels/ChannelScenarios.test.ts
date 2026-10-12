import { assert, describe, it } from "@effect/vitest";
import {
  type ChannelIngestInput,
  ChannelGatewayError,
  CommandId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadMessageIntake from "../orchestration-v2/ThreadMessageIntake.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import { CHANNEL_COPY } from "./channelCopy.ts";
import { deliveryIdFor, workerLaunchIdsFor } from "./channelIds.ts";

import {
  botMessages,
  botThreadId,
  defaultScript,
  goatInput,
  linkSlackUser,
  makeHarness,
  onlyTask,
  owner,
  ownerId,
  projectId,
  resultsTo,
  rpcContext,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

/**
 * D10 scenarios 1-6 for the core: the GOAT bot thread is a real orchestrator thread (whose
 * provider adapter refuses to run anything), worker threads are scripted, and the reception
 * model and Slack transport are fakes the tests control. The harness lives in testkit/ChannelHarness.ts.
 */

describe("GOAT bot boundary (scenario 6)", () => {
  it.effect(
    "records bot input and replies without any provider run, and refuses coding turns",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const receipt = yield* gateway.ingest(goatInput("hello", "client-1"), rpcContext);
        assert.isDefined(receipt.timelineSequence);
        yield* runtime.drain;
        const records = yield* botMessages;
        assert.deepStrictEqual(records.runs, []);
        const texts = records.messages.map((message) => [message.role, message.text]);
        assert.deepStrictEqual(texts, [
          ["user", "hello"],
          ["assistant", "Okay."],
        ]);
        const reply = records.messages.find((message) => message.role === "assistant");
        assert.strictEqual(reply?.channel?.inReplyToInputId, receipt.inputId);
        assert.isNull(reply?.runId ?? null);
        // Reception's read time lands on the bot's copy of the user message.
        const input = records.messages.find((message) => message.role === "user");
        assert.isDefined(input?.channel?.readAt);

        // A legacy coding-turn dispatch to the bot is refused by the orchestrator.
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const refused = yield* Effect.flip(
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("legacy-send"),
            threadId: botThreadId,
            messageId: MessageId.make("legacy-message"),
            text: "run a coding turn",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          }),
        );
        assert.strictEqual(refused._tag, "OrchestratorChannelBotThreadError");

        // The same legacy dispatch through client intake becomes channel input instead.
        const viaIntake = yield* ThreadMessageIntake.dispatchCommand(
          {
            type: "message.dispatch",
            commandId: CommandId.make("old-client-send"),
            threadId: botThreadId,
            messageId: MessageId.make("old-client-message"),
            text: "from an old client",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          },
          owner,
        );
        assert.deepStrictEqual(viaIntake.storedEvents, []);
        assert.isAbove(viaIntake.sequence, 0);
        yield* runtime.drain;
        const after = yield* botMessages;
        assert.deepStrictEqual(after.runs, []);
        assert.strictEqual(
          after.messages.filter((message) => message.role === "assistant").length,
          2,
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("keeps a newer task chip when an older one arrives late", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(goatInput("do: check the build", "client-2"), rpcContext);
      yield* runtime.drain;
      const records = yield* botMessages;
      const chips = records.turnItems.flatMap((item) =>
        item.type === "notification" && item.ledgerTask !== undefined ? [item] : [],
      );
      assert.strictEqual(chips.length, 1);
      const chip = chips[0]!;
      // Received, then dispatching, then running: the item shows the newest version.
      assert.strictEqual(chip.ledgerTask?.status, "running");
      assert.isDefined(chip.ledgerTask?.worker);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "channel.timeline.record",
        commandId: CommandId.make("stale-chip"),
        threadId: botThreadId,
        record: {
          recordKey: "task-chip:" + chip.ledgerTask!.taskId,
          entry: {
            type: "task_chip",
            chip: { ...chip.ledgerTask!, taskVersion: 1, status: "received" },
          },
        },
      });
      const after = yield* botMessages;
      const latest = after.turnItems.find((item) => item.id === chip.id);
      assert.strictEqual(
        latest?.type === "notification" ? latest.ledgerTask?.status : undefined,
        "running",
      );
      assert.deepStrictEqual(after.runs, []);
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("concurrent input (scenario 1)", () => {
  it.effect("answers other inputs while one reception's model call is held", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gate = yield* Deferred.make<void>();
      harness.script.current = (input) =>
        input.inputText === "slow one"
          ? Deferred.await(gate).pipe(
              Effect.as({ replyText: "Slow answer.", action: { type: "report_only" } }),
            )
          : defaultScript(input);
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const slow = yield* gateway.ingest(goatInput("slow one", "client-a"), rpcContext);
      const second = yield* gateway.ingest(goatInput("do: second job", "client-b"), rpcContext);
      const slack = yield* gateway.ingest(
        slackInput("do: slack job", "Ev1", "1760000000.000500"),
        slackContext,
      );
      yield* ledger.claimOwnership({
        token: runtime.ownerToken,
        now: "2026-10-12T00:00:00.000Z",
        staleBefore: "2026-10-11T00:00:00.000Z",
      });
      yield* runtime.runPass;
      yield* runtime.settle([second.inputId, slack.inputId]);
      // Deliver what those two committed while the first is still waiting on its model.
      yield* runtime.runPass;
      yield* runtime.runPass;

      const slackReply = harness.slackSent.find(
        (send) => send.message.inReplyToInputId === slack.inputId,
      );
      assert.strictEqual(slackReply?.message.text, "On it.");
      assert.strictEqual(slackReply?.message.mentionActorId, "U1");
      const records = yield* botMessages;
      const replies = records.messages.filter((message) => message.role === "assistant");
      assert.deepStrictEqual(
        replies.map((message) => message.channel?.inReplyToInputId),
        [second.inputId],
      );
      const held = yield* ledger.getInput(slow.inputId);
      assert.strictEqual(held?.snapshot.state, "processing");
      // Two tasks, one per request, each with its own worker thread.
      const tasks = yield* ledger.listTasks({ ownerId, limit: 10 });
      assert.strictEqual(tasks.tasks.length, 2);
      assert.strictEqual(new Set(tasks.tasks.map((task) => task.worker?.threadId)).size, 2);

      yield* Deferred.succeed(gate, undefined);
      yield* runtime.drain;
      const after = yield* botMessages;
      const afterReplies = after.messages.filter((message) => message.role === "assistant");
      assert.deepStrictEqual(
        afterReplies.map((message) => message.channel?.inReplyToInputId).toSorted(),
        [second.inputId, slow.inputId].toSorted(),
      );
      assert.notStrictEqual(
        (yield* ledger.getInput(slow.inputId))?.snapshot.receptionId,
        (yield* ledger.getInput(second.inputId))?.snapshot.receptionId,
      );
      // Slack input never shows up in the bot as a message; its task appears as a chip.
      assert.isFalse(after.messages.some((message) => message.text === "do: slack job"));
      assert.deepStrictEqual(after.runs, []);
    }).pipe(Effect.provide(harness.layer));
  });
});

/** The single ledger task, for tests that create exactly one. */
describe("duplicates and restarts (scenario 2)", () => {
  it.effect("keeps one input per idempotency key and refuses changed content under it", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const first = yield* gateway.ingest(slackInput("do: once", "Ev7"), slackContext);
      const again = yield* gateway.ingest(slackInput("do: once", "Ev7"), slackContext);
      assert.strictEqual(again.inputId, first.inputId);
      assert.isTrue(again.duplicate);
      const conflict = yield* Effect.flip(
        gateway.ingest(slackInput("do: twice", "Ev7"), slackContext),
      );
      assert.strictEqual(conflict.reason, "idempotency_conflict");
      yield* runtime.drain;
      yield* gateway.ingest(slackInput("do: once", "Ev7"), slackContext);
      yield* runtime.drain;
      assert.strictEqual(
        (yield* ChannelLedger.ChannelLedger.pipe(
          Effect.flatMap((l) => l.listTasks({ ownerId, limit: 10 })),
        )).tasks.length,
        1,
      );
      assert.strictEqual(
        resultsTo(harness.slackSent, "receipt").filter(
          (s) => s.message.inReplyToInputId === first.inputId,
        ).length,
        1,
      );
      assert.strictEqual(harness.world.launches.length, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("recovers each crash point without a second worker, reply, or result", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* ledger.claimOwnership({
        token: runtime.ownerToken,
        now: "2026-10-12T00:00:00.000Z",
        staleBefore: "2026-10-11T00:00:00.000Z",
      });

      // accept -> reception: a pass began reading and died; the next pass answers once.
      const accepted = yield* gateway.ingest(slackInput("do: crash test", "Ev8"), slackContext);
      yield* ledger.beginReception({
        owner: runtime.ownerToken,
        inputId: accepted.inputId,
        receptionId: "channel-reception:dead" as never,
        readAt: "2026-10-12T00:00:00.000Z",
      });
      // claim -> launch: the launch of the claimed task is re-run under the same ids.
      harness.script.current = defaultScript;
      yield* runtime.drain;
      const task = yield* onlyTask;
      const ids = workerLaunchIdsFor(task.taskId, 1);
      assert.strictEqual(task.worker?.threadId, ids.threadId);
      // launch -> bind: running the launch again lands on the same thread and run.
      yield* runtime.drain;
      assert.strictEqual(new Set(harness.world.launches.map((launch) => launch.commandId)).size, 1);
      assert.strictEqual(harness.world.runs.get(ids.threadId)?.length, 1);

      // completion -> outbox: the run finishes; the result goes out once across extra passes.
      harness.world.setStatus(ids.threadId, 1, "completed", "Latency is 1.2s.");
      yield* runtime.drain;
      yield* runtime.drain;
      const results = resultsTo(harness.slackSent, "result");
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0]?.message.mentionActorId, "U1");
      assert.strictEqual((yield* onlyTask).status, "completed");
      assert.strictEqual(
        resultsTo(harness.slackSent, "receipt").filter(
          (s) => s.message.inReplyToInputId === accepted.inputId,
        ).length,
        1,
      );
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("delivery (scenario 3)", () => {
  it.effect("retries what certainly did not arrive and never repeats what may have", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      // The link notice goes out first.
      yield* runtime.drain;
      harness.slackSent.length = 0;

      harness.slackFailures.push(
        new ChannelGatewayError({
          reason: "delivery_failed",
          deliveryOutcome: "not_sent",
          deliveryErrorCode: "rate_limited",
          retryAfterSeconds: 1,
        }),
      );
      const rateLimited = yield* gateway.ingest(
        slackInput("status?", "Ev20", "1760000000.000020"),
        slackContext,
      );
      yield* runtime.drain;
      assert.strictEqual(harness.slackSent.length, 0);
      const pending = yield* ledger.getInput(rateLimited.inputId);
      assert.strictEqual(pending?.snapshot.state, "replied");

      harness.slackFailures.push(
        new ChannelGatewayError({
          reason: "delivery_failed",
          deliveryOutcome: "unknown",
          deliveryErrorCode: "timeout",
        }),
      );
      yield* gateway.ingest(slackInput("status again?", "Ev21", "1760000000.000021"), slackContext);
      harness.slackFailures.push(
        new ChannelGatewayError({
          reason: "delivery_failed",
          deliveryOutcome: "not_sent",
          deliveryErrorCode: "token_revoked",
        }),
      );
      yield* gateway.ingest(slackInput("and again?", "Ev22", "1760000000.000022"), slackContext);
      yield* runtime.drain;
      // The timed-out send is not repeated; the revoked token fails without retry.
      assert.strictEqual(harness.slackSent.length, 0);
      // After Retry-After, only the rate-limited reply goes out, to its original thread.
      yield* TestClock.adjust(Duration.seconds(2));
      yield* runtime.drain;
      assert.deepStrictEqual(
        harness.slackSent.map((send) => send.message.inReplyToInputId),
        [rateLimited.inputId],
      );
      const destination = harness.slackSent[0]?.message.destination;
      assert.strictEqual(
        destination?.kind === "slack" ? destination.rootTs : undefined,
        "1760000000.000020",
      );
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("who may do what (scenario 4)", () => {
  it.effect("answers unlinked Slack users with a link notice and starts no work", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const result = yield* gateway.ingest(
        slackInput("do: something", "Ev30", "1760000000.000030", "U9"),
        slackContext,
      );
      assert.strictEqual(result.state, "rejected");
      yield* runtime.drain;
      assert.deepStrictEqual(
        harness.slackSent.map((send) => [send.message.text, send.message.mentionActorId]),
        [[CHANNEL_COPY.unlinkedInput, "U9"]],
      );
      assert.strictEqual(harness.world.launches.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "lets a linked user work only within the lower of the connection and link ceilings",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        yield* linkSlackUser();
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        yield* gateway.ingest(slackInput("do: careful work", "Ev31"), {
          ...slackContext,
          runtimeModeCeiling: "full-access",
        });
        yield* runtime.drain;
        const task = yield* onlyTask;
        // The link was created with auto-accept-edits, below the connection's full-access.
        assert.strictEqual(task.requester.runtimeModeCeiling, "auto-accept-edits");
        assert.strictEqual(harness.world.launches[0]?.runtimeMode, "auto-accept-edits");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "refuses new work from agents and reports from threads that do not own the task",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const mcpInput: ChannelIngestInput = {
          kind: "mcp",
          connectionId: "mcp",
          conversationKey: "default",
          externalMessageId: "req-1",
          idempotencyKey: "req-1",
          actor: { senderThreadId: ThreadId.make("thread:some-agent") },
          replyAddress: {
            kind: "mcp",
            connectionId: "mcp",
            requestNamespace: "ns-1",
            conversationKey: "default",
          },
          text: "do: agent wants work",
          attachments: [],
          receivedAt: "2026-10-12T00:00:00.000Z",
          intent: "message",
        };
        const agent = yield* gateway.ingest(mcpInput, {
          ...owner,
          principalId: "mcp:ns-1",
          grantedScopes: ["orchestration:read"],
          caller: { type: "mcp", requestNamespace: "ns-1" },
        });
        // A caller cannot claim another namespace's conversation.
        const spoofed = yield* Effect.flip(
          gateway.ingest(
            { ...mcpInput, idempotencyKey: "req-2" },
            {
              ...owner,
              caller: { type: "mcp", requestNamespace: "ns-other" },
            },
          ),
        );
        assert.strictEqual(spoofed.reason, "forbidden");
        yield* runtime.drain;
        assert.strictEqual((yield* ledger.listTasks({ ownerId, limit: 10 })).tasks.length, 0);
        assert.strictEqual(
          (yield* ledger.getInput(agent.inputId))?.snapshot.reply?.text,
          CHANNEL_COPY.agentCannotCreateWork,
        );

        yield* gateway.ingest(goatInput("do: owner work", "client-30"), rpcContext);
        yield* runtime.drain;
        const task = yield* onlyTask;
        const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
        const forged = yield* Effect.flip(
          reports.report(
            {
              taskId: task.taskId,
              eventId: "event-forged" as never,
              generation: 1,
              status: "completed",
              summary: "done",
            },
            ThreadId.make("thread:not-the-worker"),
          ),
        );
        assert.strictEqual(forged.reason, "forbidden");
        const stale = yield* Effect.flip(
          reports.report(
            {
              taskId: task.taskId,
              eventId: "event-stale" as never,
              generation: 2,
              status: "running",
              summary: "x",
            },
            task.worker?.threadId,
          ),
        );
        assert.strictEqual(stale.reason, "forbidden");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "keeps MCP callers' conversations and retries apart and returns each its own reply",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const ledger = yield* ChannelLedger.ChannelLedger;
        // Two agents use the same default conversation and the same client request id.
        const agentInput = (namespace: string): ChannelIngestInput => ({
          kind: "mcp",
          connectionId: "mcp",
          conversationKey: "default",
          externalMessageId: "req-1",
          idempotencyKey: "req-1",
          actor: {},
          replyAddress: {
            kind: "mcp",
            connectionId: "mcp",
            requestNamespace: namespace,
            conversationKey: "default",
          },
          text: "How is the release going?",
          attachments: [],
          receivedAt: "2026-10-12T00:00:00.000Z",
          intent: "message",
        });
        const agentContext = (namespace: string) => ({
          ...owner,
          principalId: "mcp:" + namespace,
          grantedScopes: ["orchestration:read" as const],
          caller: { type: "mcp" as const, requestNamespace: namespace },
        });
        const first = yield* gateway.ingest(agentInput("ns-a"), agentContext("ns-a"));
        const second = yield* gateway.ingest(agentInput("ns-b"), agentContext("ns-b"));
        assert.isFalse(second.duplicate);
        assert.notStrictEqual(second.inputId, first.inputId);
        assert.notStrictEqual(second.conversationId, first.conversationId);
        const retried = yield* gateway.ingest(agentInput("ns-a"), agentContext("ns-a"));
        assert.isTrue(retried.duplicate);
        assert.strictEqual(retried.inputId, first.inputId);

        yield* runtime.drain;
        // Each agent reads its own reply; another namespace cannot see it, the owner can.
        const reply = yield* gateway.getInput(first.inputId, agentContext("ns-a"));
        assert.strictEqual(reply.reply?.text, "Okay.");
        assert.strictEqual(reply.state, "replied");
        const hidden = yield* Effect.flip(gateway.getInput(first.inputId, agentContext("ns-b")));
        assert.strictEqual(hidden.reason, "not_found");
        assert.strictEqual(
          (yield* gateway.getInput(first.inputId, rpcContext)).inputId,
          first.inputId,
        );
        // The reply's delivery lands in the ledger mailbox instead of failing for want of an adapter.
        for (const input of [first, second]) {
          assert.strictEqual(
            yield* ledger.getDeliveryState(deliveryIdFor("reply:" + input.inputId)),
            "delivered",
          );
        }
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("asks instead of guessing when the project is not clear", () => {
    const harness = makeHarness({ projects: 2 });
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(slackInput("do: which repo?", "Ev40"), slackContext);
      yield* runtime.drain;
      const task = yield* onlyTask;
      assert.strictEqual(task.status, "waiting_input");
      assert.strictEqual(harness.world.launches.length, 0);
      const question = resultsTo(harness.slackSent, "question")[0];
      assert.include(question?.message.text ?? "", "Which project should I use?");
      // The answer names a project; the dispatcher launches there.
      harness.script.current = (input) =>
        input.mode === "input"
          ? Effect.succeed({
              replyText: "Thanks.",
              action: {
                type: "answer_question",
                taskId: task.taskId,
                questionId: task.openQuestions[0]!.questionId,
                answer: "Channel work",
              },
            })
          : defaultScript(input);
      yield* gateway.ingest(slackInput("Channel work", "Ev41"), slackContext);
      yield* runtime.drain;
      assert.strictEqual(harness.world.launches.length, 1);
      assert.strictEqual(harness.world.launches[0]?.projectId, projectId);
      assert.strictEqual((yield* onlyTask).status, "running");
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("completion (scenario 5)", () => {
  const startTask = () =>
    Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(slackInput("do: the job", "Ev50"), slackContext);
      yield* runtime.drain;
      const task = yield* onlyTask;
      return { task, threadId: task.worker!.threadId, runtime };
    });

  it.effect("reports failure for an interrupted run and never success", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { threadId, runtime } = yield* startTask();
      harness.world.setStatus(threadId, 1, "interrupted");
      yield* runtime.drain;
      assert.strictEqual((yield* onlyTask).status, "failed");
      assert.strictEqual(resultsTo(harness.slackSent, "result").length, 0);
      assert.strictEqual(resultsTo(harness.slackSent, "failure").length, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "waits for background work and for the run before an explicit completion counts",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const { task, threadId, runtime } = yield* startTask();
        const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
        yield* reports.report(
          {
            taskId: task.taskId,
            eventId: "event-proposed" as never,
            generation: 1,
            status: "completed",
            summary: "All done.",
          },
          threadId,
        );
        yield* runtime.drain;
        assert.strictEqual((yield* onlyTask).status, "running");
        // The run ends while background work is still going: held, not completed.
        harness.world.background.add(threadId);
        harness.world.setStatus(threadId, 1, "completed");
        yield* runtime.drain;
        assert.strictEqual((yield* onlyTask).status, "running");
        // Background work ends without a new run; the next pass completes the task.
        harness.world.background.delete(threadId);
        yield* runtime.drain;
        const done = yield* onlyTask;
        assert.strictEqual(done.status, "completed");
        assert.strictEqual(done.resultSummary, "All done.");
        assert.strictEqual(resultsTo(harness.slackSent, "result").length, 1);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("does not complete on the old run while an answer is on its way to the worker", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { task, threadId, runtime } = yield* startTask();
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* reports.report(
        {
          taskId: task.taskId,
          eventId: "event-question" as never,
          generation: 1,
          status: "waiting_input",
          summary: "Need input",
          question: "Use staging or prod?",
        },
        threadId,
      );
      harness.world.setStatus(threadId, 1, "completed", "Waiting for an answer.");
      yield* runtime.drain;
      const waiting = yield* onlyTask;
      assert.strictEqual(waiting.status, "waiting_input");
      assert.strictEqual(
        resultsTo(harness.slackSent, "question")[0]?.message.text,
        "Use staging or prod?",
      );

      // The answer arrives; until the run it starts finishes, the old completed run counts for nothing.
      yield* gateway.ingest(
        {
          ...slackInput("staging", "Ev51"),
          intent: "answer",
          taskId: task.taskId,
          questionId: waiting.openQuestions[0]!.questionId,
        },
        slackContext,
      );
      yield* runtime.drain;
      assert.strictEqual(harness.world.sends.length, 1);
      const answerRun = harness.world.latestRun(threadId)!;
      assert.strictEqual(answerRun.ordinal, 2);
      assert.strictEqual((yield* onlyTask).status, "running");
      assert.strictEqual(resultsTo(harness.slackSent, "result").length, 0);

      harness.world.setStatus(threadId, 2, "completed", "Deployed to staging.");
      yield* runtime.drain;
      const done = yield* onlyTask;
      assert.strictEqual(done.status, "completed");
      assert.strictEqual(done.resultSummary, "Deployed to staging.");
      assert.strictEqual(done.worker?.runId, answerRun.id);
      yield* runtime.drain;
      assert.strictEqual(resultsTo(harness.slackSent, "result").length, 1);
    }).pipe(Effect.provide(harness.layer));
  });
});
