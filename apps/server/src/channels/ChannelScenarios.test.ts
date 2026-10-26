import { assert, describe, it } from "@effect/vitest";
import {
  CHANNEL_HOST_WORKSPACE_LABEL,
  type AuthEnvironmentScope,
  type ChannelIngestInput,
  type ChannelReceptionInput,
  ChannelTaskEvent,
  ChannelTaskId,
  type ThreadResultReport,
  ChannelGatewayError,
  CommandId,
  EnvironmentId,
  ChannelReceptionId,
  ChannelQuestionId,
  ChannelTaskEventId,
  MessageId,
  NodeId,
  RuntimeRequestId,
  ScheduledTaskId,
  ThreadId,
  TextGenerationError,
  type ThreadPullRequestLink,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { splitStandingInstructions } from "@goat/shared/standingInstructions";

import * as ServerSettings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import { currentMemoryAccess } from "../memory/MemoryAccess.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../orchestration-v2/ThreadMessageIntake.ts";
import * as ChannelBotDirectory from "./ChannelBotDirectory.ts";
import * as ChannelBotRegistry from "./ChannelBotRegistry.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelDispatcher from "./ChannelDispatcher.ts";
import * as ChannelIdentityService from "./ChannelIdentityService.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelTransport from "./ChannelTransport.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import { CHANNEL_COPY } from "./channelCopy.ts";
import { channelBotFilesFor } from "./channelBotNotes.ts";
import {
  answerForwardIdsFor,
  botLaunchIdsFor,
  deliveryIdFor,
  inputIdFor,
  taskEventIdFor,
  workerLaunchIdsFor,
} from "./channelIds.ts";
import { commitTransition } from "./channelTaskWrites.ts";

import {
  botMessages,
  botThreadId,
  defaultScript,
  environmentId,
  goatInput,
  latestCard,
  linkSlackUser,
  makeHarness,
  makeRuntime,
  modelSelection,
  onlyTask,
  owner,
  ownerId,
  projectId,
  resultsTo,
  rpcContext,
  setupBot,
  scratchProjectId,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

const decodeTaskEventJson = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelTaskEvent));
const decodeTaskEventJsonEffect = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ChannelTaskEvent),
);

/** Relink through the real one-time code path, keeping the transport's grants unchanged. */
const linkMemoryUser = (
  memoryScopes: ReadonlyArray<AuthEnvironmentScope>,
  key = memoryScopes.join("-"),
) =>
  Effect.gen(function* () {
    const identities = yield* ChannelIdentityService.ChannelIdentityService;
    const gateway = yield* ChannelGateway.ChannelGateway;
    const { code } = yield* identities.createLink(
      {
        connectionId: "slack-1",
        runtimeModeCeiling: "auto-accept-edits",
        grantedScopes: [...owner.grantedScopes, ...memoryScopes],
      },
      { ...owner, grantedScopes: [...owner.grantedScopes, "memory:read", "memory:write"] },
    );
    yield* gateway.linkIdentity(
      {
        connectionId: "slack-1",
        externalActorId: "U1",
        code,
        idempotencyKey: "memory-link-" + key,
        replyAddress: slackInput("", "unused").replyAddress,
      },
      slackMemoryContext,
    );
  });

const slackMemoryContext = {
  ...slackContext,
  grantedScopes: [
    ...owner.grantedScopes,
    "memory:read",
    "memory:write",
  ] satisfies AuthEnvironmentScope[],
};

const notesFileExists = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  return yield* fs.exists(channelBotFilesFor(path, config.stateDir).notes);
});

/**
 * D10 scenarios 1-6 for the core: the GOAT bot thread is a real orchestrator thread (whose
 * provider adapter refuses to run anything), worker threads are scripted, and the reception
 * model and Slack transport are fakes the tests control. The harness lives in testkit/ChannelHarness.ts.
 */

describe("GOAT bot boundary (scenario 6)", () => {
  const starSummary =
    "OpenCodex has 17.8k stars: https://github.com/example/opencodex\nNOT RUN: separate tests.";
  const trailers = ["NOT RUN:", "Reported tests:", "GOAT check:"];

  it.effect("shows a GOAT Bot task's result once, on its card, without agent trailers", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(goatInput("do: count the stars", "stars-goat"), rpcContext);
      yield* runtime.drain;
      const task = yield* onlyTask;
      harness.world.setStatus(task.worker!.threadId, 1, "completed", starSummary);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const texts = (yield* botMessages).messages.map((message) => message.text).join("\n");
      assert.notInclude(texts, "17.8k");
      for (const trailer of trailers) assert.notInclude(texts, trailer);
      const card = yield* latestCard;
      assert.strictEqual(card?.status, "completed");
      assert.include(card?.summary ?? "", "17.8k stars");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("sends a Slack result as prose and leaves the bot's card as its only result", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(slackInput("do: count the stars", "stars-slack"), slackContext);
      yield* runtime.drain;
      const task = yield* onlyTask;
      harness.world.setStatus(task.worker!.threadId, 1, "completed", starSummary);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const results = resultsTo(harness.slackSent, "result");
      assert.lengthOf(results, 1);
      const text = results[0]!.message.text;
      assert.include(text, "17.8k stars: https://github.com/example/opencodex");
      for (const trailer of trailers) assert.notMatch(text, new RegExp("^" + trailer, "mu"));
      const texts = (yield* botMessages).messages.map((message) => message.text).join("\n");
      assert.notInclude(texts, "17.8k");
      assert.include((yield* latestCard)?.summary ?? "", "17.8k stars");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "refuses MCP and scheduled direct sends without bot run events or provider effects",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const events = yield* EventSink.EventSinkV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const effects = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* gateway.ingest(goatInput("do: inspect the build", "boundary-chip"), rpcContext);
        yield* runtime.drain;
        // The scheduler retains the task's creation source and marks the dispatch with its task ID.
        for (const source of ["mcp", "schedule"] as const) {
          const commandId = CommandId.make("bot-direct-" + source);
          const before = yield* events.latestSequence();
          const error = yield* Effect.flip(
            threads.sendToThread({
              projectId: scratchProjectId,
              threadId: botThreadId,
              commandId,
              messageId: MessageId.make("bot-direct-message-" + source),
              text: "do: bypass reception",
              attachments: [],
              mode: "queue",
              createdBy: source === "mcp" ? "agent" : "user",
              creationSource: source === "mcp" ? "mcp" : "web",
              ...(source === "schedule"
                ? { scheduledTaskId: ScheduledTaskId.make("schedule:bot") }
                : {}),
            }),
          );
          assert.strictEqual(error._tag, "OrchestratorChannelBotThreadError");
          assert.strictEqual(yield* events.latestSequence(), before);
          assert.deepStrictEqual(
            yield* Stream.runCollect(events.readByCommandId({ commandId })),
            [],
          );
          assert.deepStrictEqual(yield* outbox.listByCommandId(commandId), []);
        }
        const highWater = yield* events.latestSequence({ threadId: botThreadId });
        const stored = yield* events.stream({ threadId: botThreadId }).pipe(
          Stream.takeUntil((event) => event.sequence === highWater),
          Stream.runCollect,
        );
        assert.isFalse(
          stored.some(
            ({ event }) => event.type.startsWith("run.") || event.type.startsWith("provider-turn."),
          ),
        );
        for (const commandId of new Set(
          stored.flatMap((event) => (event.commandId ? [event.commandId] : [])),
        )) {
          assert.isFalse(
            (yield* outbox.listByCommandId(commandId)).some(
              (effect) => effect.request.type === "provider-turn.start",
            ),
          );
        }
        yield* effects.drain();
        assert.deepStrictEqual(harness.providerCalls, []);
        const records = yield* botMessages;
        assert.deepStrictEqual(records.runs, []);
        assert.isTrue(records.messages.some((message) => message.role === "assistant"));
        assert.isTrue(
          records.turnItems.some(
            (item) => item.type === "notification" && item.ledgerTask !== undefined,
          ),
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );
  it.effect("starts a new bot after the bot thread is deleted and keeps it", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const bots = yield* ChannelBotRegistry.ChannelBotRegistry;
      const directory = yield* ChannelBotDirectory.ChannelBotDirectory;
      // An archived bot is still the bot; unarchiving brings it back.
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-goat-bot"),
        threadId: botThreadId,
      });
      assert.strictEqual((yield* bots.ensure({}, owner)).threadId, botThreadId);
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-goat-bot"),
        threadId: botThreadId,
      });
      const replaced = yield* bots.ensure({}, owner);
      assert.notStrictEqual(replaced.threadId, botThreadId);
      assert.strictEqual(replaced.environmentId, environmentId);
      assert.strictEqual((yield* bots.ensure({}, owner)).threadId, replaced.threadId);
      assert.isTrue(yield* directory.isBotThread(replaced.threadId));
      assert.isFalse(yield* directory.isBotThread(botThreadId));
      assert.strictEqual(
        harness.world.launches.filter((launch) => launch.threadId === replaced.threadId).length,
        1,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("reads the bot and its waiting count across channels without creating the bot", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const bots = yield* ChannelBotRegistry.ChannelBotRegistry;
      // Before any ensure there is no bot, and asking does not make one.
      assert.deepStrictEqual(yield* bots.status(owner), { bot: null, waitingCount: 0 });
      assert.lengthOf(harness.world.launches, 0);

      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* gateway.ingest(goatInput("do: goat question", "status-goat"), rpcContext);
      yield* gateway.ingest(slackInput("do: slack question", "status-slack"), slackContext);
      yield* runtime.drain;
      const { tasks } = yield* ledger.listTasks({ ownerId, limit: 10 });
      assert.lengthOf(tasks, 2);
      for (const task of tasks) {
        yield* reports.report(
          {
            taskId: task.taskId,
            eventId: ChannelTaskEventId.make("status-question-" + task.taskId),
            generation: task.generation,
            status: "waiting_input",
            summary: "Choose",
            question: "Which one?",
          },
          task.worker!.threadId,
        );
      }
      yield* runtime.drain;

      // Both channels contribute to the owner's waiting count.
      assert.strictEqual(yield* ledger.countWaitingTasks(ownerId), 2);
      assert.deepStrictEqual(yield* bots.status(owner), {
        bot: { environmentId, projectId: scratchProjectId, threadId: botThreadId },
        waitingCount: 2,
      });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("visiting the bot thread marks waiting tasks read until a new one asks", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-12T00:00:00.000Z"));
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const bots = yield* ChannelBotRegistry.ChannelBotRegistry;
      yield* gateway.ingest(goatInput("do: first question", "read-first"), rpcContext);
      yield* gateway.ingest(goatInput("do: second question", "read-second"), rpcContext);
      yield* runtime.drain;
      const { tasks } = yield* ledger.listTasks({ ownerId, limit: 10 });
      assert.lengthOf(tasks, 2);
      const ask = (task: (typeof tasks)[number], eventId: string) =>
        reports.report(
          {
            taskId: task.taskId,
            eventId: ChannelTaskEventId.make(eventId),
            generation: task.generation,
            status: "waiting_input",
            summary: "Choose",
            question: `Which one? (${eventId})`,
          },
          task.worker!.threadId,
        );
      for (const task of tasks) yield* ask(task, "read-question-" + task.taskId);
      yield* runtime.drain;
      assert.strictEqual((yield* bots.status(owner)).waitingCount, 2);

      // Mark all as read is the sidebar's thread.visit, sent to the bot thread.
      yield* orchestrator.dispatch({
        type: "thread.visit",
        commandId: CommandId.make("visit-goat-bot"),
        threadId: botThreadId,
        visitedAt: "2026-10-12T00:01:00.000Z",
      });
      assert.strictEqual((yield* bots.status(owner)).waitingCount, 0);
      // The tasks still wait; only the badge treats them as read.
      assert.strictEqual(yield* ledger.countWaitingTasks(ownerId), 2);

      yield* TestClock.setTime(Date.parse("2026-10-12T00:02:00.000Z"));
      yield* gateway.ingest(goatInput("do: later question", "read-later"), rpcContext);
      yield* runtime.drain;
      const later = (yield* ledger.listTasks({ ownerId, limit: 10 })).tasks.find(
        (task) => !tasks.some((earlier) => earlier.taskId === task.taskId),
      );
      yield* ask(later!, "read-question-later");
      yield* runtime.drain;
      assert.strictEqual((yield* bots.status(owner)).waitingCount, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps work started from a deleted bot reporting to its replacement", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const bots = yield* ChannelBotRegistry.ChannelBotRegistry;
      yield* gateway.ingest(goatInput("do: outlive the bot", "replaced-work"), rpcContext);
      yield* runtime.drain;
      const task = yield* onlyTask;
      const workerThreadId = task.worker!.threadId;
      yield* reports.report(
        {
          taskId: task.taskId,
          eventId: ChannelTaskEventId.make("replaced-question"),
          generation: task.generation,
          status: "waiting_input",
          summary: "Choose",
          question: "Staging or production?",
        },
        workerThreadId,
      );
      harness.world.setStatus(workerThreadId, 1, "completed");
      yield* runtime.drain;
      const waiting = yield* onlyTask;

      // The bot thread is deleted; the next ensure starts its replacement.
      const nextBotId = botLaunchIdsFor(ownerId, botThreadId).threadId;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-next-bot"),
        threadId: nextBotId,
        projectId: scratchProjectId,
        title: "GOAT bot",
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "system",
        creationSource: "server",
      });
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-first-bot"),
        threadId: botThreadId,
      });
      assert.strictEqual((yield* bots.ensure({}, owner)).threadId, nextBotId);

      // A plain reply in the new bot answers the question: reception still sees the task there.
      const questionId = waiting.openQuestions[0]!.questionId;
      harness.script.current = (input) =>
        input.mode === "input" &&
        input.tasks.some((seen) =>
          seen.openQuestions.some((question) => question.questionId === questionId),
        )
          ? Effect.succeed({
              replyText: "Passing that on.",
              action: {
                type: "answer_question",
                taskId: task.taskId,
                questionId,
                answer: input.inputText ?? "",
              },
            })
          : defaultScript(input);
      yield* gateway.ingest(
        {
          ...goatInput("staging", "replaced-answer"),
          conversationKey: nextBotId,
          replyAddress: { kind: "goat", environmentId, threadId: nextBotId },
        },
        rpcContext,
      );
      yield* runtime.drain;
      assert.strictEqual(harness.world.sends.length, 1);
      harness.world.setStatus(workerThreadId, 2, "completed", "Shipped to staging.");
      yield* runtime.drain;
      yield* runtime.drain;
      assert.strictEqual((yield* onlyTask).status, "completed");
      // The task's card in the replacement bot carries the result.
      const next = yield* orchestrator.getThreadRecords(nextBotId, ["turnItems"]);
      assert.isTrue(
        next.turnItems.some(
          (item) =>
            item.type === "notification" &&
            item.ledgerTask?.status === "completed" &&
            item.ledgerTask.summary === "Shipped to staging.",
        ),
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("replays a delivery recorded in a deleted bot into its replacement", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const bots = yield* ChannelBotRegistry.ChannelBotRegistry;
      const registry = yield* ChannelTransport.ChannelTransportRegistry;
      const input = yield* gateway.ingest(goatInput("hello", "replayed-reply"), rpcContext);
      yield* runtime.drain;
      const nextBotId = botLaunchIdsFor(ownerId, botThreadId).threadId;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-replay-bot"),
        threadId: nextBotId,
        projectId: scratchProjectId,
        title: "GOAT bot",
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "system",
        creationSource: "server",
      });
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-replay-bot"),
        threadId: botThreadId,
      });
      assert.strictEqual((yield* bots.ensure({}, owner)).threadId, nextBotId);
      // The process died after recording the reply but before the outbox heard back; the retry
      // goes to the replacement and must not collide with the old record's command.
      const transport = Option.getOrThrow(yield* registry.resolve("goat"));
      yield* transport.send({
        deliveryId: deliveryIdFor("reply:" + input.inputId),
        destination: { kind: "goat", environmentId, threadId: botThreadId },
        kind: "receipt",
        text: "Okay.",
        inReplyToInputId: input.inputId,
      });
      const next = yield* orchestrator.getThreadRecords(nextBotId, ["messages"]);
      assert.isTrue(
        next.messages.some(
          (message) =>
            message.role === "assistant" && message.channel?.inReplyToInputId === input.inputId,
        ),
      );
    }).pipe(Effect.provide(harness.layer));
  });

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

  it.effect(
    "offers a clarifying question's choices as buttons in the bot and as a list in Slack",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        yield* linkSlackUser();
        const seenThreads: Array<ReadonlyArray<string>> = [];
        harness.script.current = (input) => {
          if (input.mode !== "input") return defaultScript(input);
          seenThreads.push((input.recentThreads ?? []).map((thread) => thread.title));
          return Effect.succeed({
            replyText: "Which one?",
            action: { type: "clarify", question: "Which one?", options: ["CI fix", "Release"] },
          });
        };
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const receipt = yield* gateway.ingest(goatInput("how is it going", "client-q"), rpcContext);
        yield* runtime.drain;
        const reply = (yield* botMessages).messages.find(
          (message) =>
            message.role === "assistant" && message.channel?.inReplyToInputId === receipt.inputId,
        );
        assert.strictEqual(reply?.text, "Which one?");
        assert.strictEqual(reply?.channel?.kind, "question");
        assert.deepStrictEqual(reply?.channel?.options, ["CI fix", "Release"]);
        // The bot never lists its own thread as one to pick.
        assert.isDefined(seenThreads[0]);
        assert.notInclude(seenThreads[0] ?? [], "GOAT bot");

        yield* gateway.ingest(slackInput("how is it going", "Ev-q"), slackContext);
        yield* runtime.drain;
        const question = resultsTo(harness.slackSent, "question")[0];
        assert.strictEqual(question?.message.text, "Which one?\n1. CI fix\n2. Release");
        assert.deepStrictEqual(question?.message.options, ["CI fix", "Release"]);
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
  const claim = Effect.gen(function* () {
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const ledger = yield* ChannelLedger.ChannelLedger;
    yield* ledger.claimOwnership({
      token: runtime.ownerToken,
      now: "2026-10-12T00:00:00.000Z",
      staleBefore: "2026-10-11T00:00:00.000Z",
    });
    return runtime;
  });

  it.effect("reads one conversation in order while other conversations proceed", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gate = yield* Deferred.make<void>();
      const tasksSeenBySecond: Array<number> = [];
      harness.script.current = (input) => {
        if (input.inputText === "do: slow job") {
          return Deferred.await(gate).pipe(Effect.andThen(defaultScript(input)));
        }
        if (input.inputText === "and add tests") tasksSeenBySecond.push(input.tasks.length);
        return defaultScript(input);
      };
      const gateway = yield* ChannelGateway.ChannelGateway;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const slow = yield* gateway.ingest(goatInput("do: slow job", "client-a"), rpcContext);
      const second = yield* gateway.ingest(goatInput("and add tests", "client-b"), rpcContext);
      const slack = yield* gateway.ingest(
        slackInput("do: slack job", "Ev1", "1760000000.000500"),
        slackContext,
      );
      const runtime = yield* claim;
      yield* runtime.runPass;
      yield* runtime.settle([slack.inputId]);
      // Deliver what the Slack thread committed while the bot conversation waits on its model.
      yield* runtime.runPass;
      yield* runtime.runPass;

      const slackReply = harness.slackSent.find(
        (send) => send.message.inReplyToInputId === slack.inputId,
      );
      assert.strictEqual(slackReply?.message.text, "On it.");
      assert.strictEqual((yield* ledger.getInput(slow.inputId))?.snapshot.state, "processing");
      // The later message in the same conversation has not been read yet.
      assert.strictEqual((yield* ledger.getInput(second.inputId))?.snapshot.state, "accepted");
      assert.deepStrictEqual(tasksSeenBySecond, []);

      yield* Deferred.succeed(gate, undefined);
      yield* runtime.drain;
      const after = yield* botMessages;
      const replies = after.messages.filter((message) => message.role === "assistant");
      assert.deepStrictEqual(
        replies.map((message) => message.channel?.inReplyToInputId),
        [slow.inputId, second.inputId],
      );
      // The follow-up was read after the task its previous message created.
      assert.deepStrictEqual(tasksSeenBySecond, [1]);
      assert.deepStrictEqual(after.runs, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("answers each sender in their own Slack thread when messages arrive together", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser("U1");
      yield* linkSlackUser("U2");
      const gateway = yield* ChannelGateway.ChannelGateway;
      const sent = [
        { text: "first in A", key: "EvA1", rootTs: "1760000000.000100", user: "U1" },
        { text: "first in B", key: "EvB1", rootTs: "1760000000.000200", user: "U2" },
        { text: "second in A", key: "EvA2", rootTs: "1760000000.000100", user: "U2" },
        { text: "second in B", key: "EvB2", rootTs: "1760000000.000200", user: "U1" },
      ];
      const inputs = [];
      for (const message of sent) {
        const receipt = yield* gateway.ingest(
          slackInput(message.text, message.key, message.rootTs, message.user),
          slackContext,
        );
        inputs.push({ ...message, inputId: receipt.inputId });
      }
      // A Slack retry of one of them is the same input, not a fifth.
      const retried = yield* gateway.ingest(
        slackInput("first in B", "EvB1", "1760000000.000200", "U2"),
        slackContext,
      );
      assert.strictEqual(retried.inputId, inputs[1]!.inputId);

      const runtime = yield* claim;
      yield* runtime.drain;

      for (const input of inputs) {
        const replies = harness.slackSent.filter(
          (send) => send.message.inReplyToInputId === input.inputId,
        );
        assert.strictEqual(replies.length, 1, input.text);
        const reply = replies[0]!.message;
        assert.deepStrictEqual(
          reply.destination,
          {
            kind: "slack",
            connectionId: "slack-1",
            teamId: "T1",
            channelId: "C1",
            rootTs: input.rootTs,
          },
          input.text,
        );
        assert.strictEqual(reply.mentionActorId, input.user, input.text);
      }
      // Within a thread, replies go out in the order the messages arrived.
      const order = (rootTs: string) =>
        harness.slackSent
          .filter(
            (send) =>
              send.message.destination.kind === "slack" &&
              send.message.destination.rootTs === rootTs &&
              send.message.inReplyToInputId !== undefined,
          )
          .map((send) => send.message.inReplyToInputId);
      assert.deepStrictEqual(order("1760000000.000100"), [inputs[0]!.inputId, inputs[2]!.inputId]);
      assert.deepStrictEqual(order("1760000000.000200"), [inputs[1]!.inputId, inputs[3]!.inputId]);
    }).pipe(Effect.provide(harness.layer));
  });
});

/** The single ledger task, for tests that create exactly one. */
describe("duplicates and restarts (scenario 2)", () => {
  const now = "2026-10-12T00:00:00.000Z";
  const claimFirstOwner = Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(now));
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const ledger = yield* ChannelLedger.ChannelLedger;
    assert.isTrue(
      yield* ledger.claimOwnership({
        token: runtime.ownerToken,
        now,
        staleBefore: "2026-10-11T23:59:30.000Z",
      }),
    );
    return runtime;
  });
  const takeOver = (first: ChannelRuntime.ChannelRuntime["Service"]) =>
    Effect.gen(function* () {
      const second = yield* makeRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      assert.notStrictEqual(second.ownerToken, first.ownerToken);
      assert.isFalse(
        yield* ledger.claimOwnership({
          token: second.ownerToken,
          now,
          staleBefore: "2026-10-11T23:59:30.000Z",
        }),
      );
      yield* TestClock.adjust(Duration.seconds(31));
      assert.isTrue(
        yield* ledger.claimOwnership({
          token: second.ownerToken,
          now: "2026-10-12T00:00:31.000Z",
          staleBefore: "2026-10-12T00:00:01.000Z",
        }),
      );
      yield* second.recover;
      return second;
    });

  it.effect("a new owner finishes a processing input once and fences the old reception", () => {
    const harness = makeHarness();
    return Effect.scoped(
      Effect.gen(function* () {
        yield* setupBot;
        yield* linkSlackUser();
        const first = yield* claimFirstOwner;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const input = yield* gateway.ingest(
          slackInput("do: recover reception", "restart-input"),
          slackContext,
        );
        const receptionId = ChannelReceptionId.make("reception:old-owner");
        yield* ledger.beginReception({
          owner: first.ownerToken,
          inputId: input.inputId,
          receptionId,
          readAt: now,
        });
        assert.strictEqual((yield* ledger.getInput(input.inputId))?.snapshot.state, "processing");
        const second = yield* takeOver(first);
        yield* second.drain;
        yield* second.drain;
        const stored = yield* ledger.getInput(input.inputId);
        assert.strictEqual(stored?.snapshot.state, "replied");
        assert.notStrictEqual(stored?.snapshot.receptionId, receptionId);
        const late = yield* Effect.flip(
          ledger.completeReception({
            owner: first.ownerToken,
            inputId: input.inputId,
            receptionId,
            replyText: "Late answer",
            decision: { replyText: "Late answer", action: { type: "report_only" } },
            deliveries: [],
            now: "2026-10-12T00:00:31.000Z",
          }),
        );
        assert.strictEqual(late.reason, "ownership_lost");
        assert.strictEqual((yield* ledger.listTasks({ ownerId, limit: 10 })).tasks.length, 1);
        assert.strictEqual(harness.world.launches.length, 1);
        assert.strictEqual(
          resultsTo(harness.slackSent, "receipt").filter(
            (send) => send.message.inReplyToInputId === input.inputId,
          ).length,
          1,
        );
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect.each(["before launch", "after launch acceptance"] as const)(
    "a new owner recovers dispatching %s with one durable worker run",
    (crashPoint) => {
      const harness = makeHarness({ realWorkerLaunch: true });
      return Effect.scoped(
        Effect.gen(function* () {
          yield* setupBot;
          yield* linkMemoryUser(["memory:read"]);
          const first = yield* claimFirstOwner;
          const gateway = yield* ChannelGateway.ChannelGateway;
          const ledger = yield* ChannelLedger.ChannelLedger;
          const reception = yield* ChannelReceptionService.ChannelReceptionService;
          const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
          const input = yield* gateway.ingest(
            slackInput("do: recover dispatch", "restart-launch"),
            slackMemoryContext,
          );
          yield* reception.receive(input.inputId, first.ownerToken);
          const task = yield* onlyTask;
          const stored = (yield* ledger.getTask(task.taskId))!;
          yield* commitTransition(
            ledger,
            stored,
            {
              type: "task.dispatch.claimed",
              payload: {
                generation: task.generation,
                target: {
                  memoryGrantCeiling: "read",
                  environmentId,
                  projectId,
                  modelSelection,
                  runtimeMode: "auto-accept-edits",
                  interactionMode: "default",
                  workspaceStrategy: { type: "root" },
                },
                leaseExpiresAt: now,
              },
            },
            { owner: first.ownerToken },
          );
          // A restart must reuse the captured target even after the identity loses memory.
          yield* linkMemoryUser([]);
          const ids = workerLaunchIdsFor(task.taskId, task.generation);
          if (crashPoint === "after launch acceptance") {
            const accepted = yield* Deferred.make<void>();
            harness.launch.afterAccepted = () =>
              Deferred.succeed(accepted, undefined).pipe(Effect.andThen(Effect.never));
            const interrupted = yield* dispatcher
              .dispatch(task.taskId, first.ownerToken)
              .pipe(Effect.forkScoped);
            yield* Deferred.await(accepted);
            yield* Fiber.interrupt(interrupted);
            harness.launch.afterAccepted = () => Effect.void;
            assert.strictEqual(harness.world.launches.length, 1);
            assert.strictEqual(
              (yield* (yield* Orchestrator.OrchestratorV2).getThreadRecords(ids.threadId, ["runs"]))
                .runs.length,
              1,
            );
          }
          assert.strictEqual((yield* onlyTask).status, "dispatching");
          assert.isUndefined((yield* onlyTask).worker);
          const second = yield* takeOver(first);
          yield* second.drain;
          yield* second.drain;
          const bound = yield* onlyTask;
          assert.strictEqual(bound.status, "running");
          assert.strictEqual(bound.target?.memoryGrantCeiling, "read");
          assert.strictEqual(bound.worker?.threadId, ids.threadId);
          assert.strictEqual(harness.world.launches.length, crashPoint === "before launch" ? 1 : 2);
          for (const launch of harness.world.launches) {
            assert.strictEqual(launch.initialMessage?.memoryGrantCeiling, "read");
            assert.strictEqual(launch.commandId, ids.commandId);
            assert.strictEqual(launch.threadId, ids.threadId);
            assert.strictEqual(launch.initialMessage?.messageId, ids.messageId);
          }
          const records = yield* (yield* Orchestrator.OrchestratorV2).getThreadRecords(
            ids.threadId,
            ["runs", "messages"],
          );
          assert.strictEqual(records.runs.length, 1);
          assert.strictEqual(records.runs[0]?.memoryGrantCeiling, "read");
          assert.strictEqual(records.runs[0]?.userMessageId, ids.messageId);
          assert.strictEqual(bound.worker?.runId, records.runs[0]?.id);
          assert.strictEqual(
            records.messages.filter((message) => message.id === ids.messageId).length,
            1,
          );
        }),
      ).pipe(Effect.provide(harness.layer));
    },
  );
  it.effect("a new owner narrates a persisted completion once", () => {
    const harness = makeHarness();
    return Effect.scoped(
      Effect.gen(function* () {
        yield* setupBot;
        yield* linkSlackUser();
        const first = yield* claimFirstOwner;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
        yield* gateway.ingest(slackInput("do: recover result", "restart-result"), slackContext);
        yield* first.drain;
        const task = yield* onlyTask;
        harness.world.setStatus(task.worker!.threadId, 1, "completed", "Recovered result.");
        yield* reports.reconcile(first.ownerToken);
        assert.strictEqual(
          (yield* ledger.listPendingNarrations(50)).filter(
            (pending) => pending.event.type === "task.completed",
          ).length,
          1,
        );
        assert.strictEqual(resultsTo(harness.slackSent, "result").length, 0);
        const second = yield* takeOver(first);
        yield* second.drain;
        yield* second.drain;
        assert.deepStrictEqual(yield* ledger.listPendingNarrations(50), []);
        assert.strictEqual(resultsTo(harness.slackSent, "result").length, 1);
        assert.strictEqual(
          resultsTo(harness.slackSent, "result")[0]?.message.text,
          "Done: recover result\nRecovered result.\n\nVerification: the agent reported no tests; GOAT's own check is pending.",
        );
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "a new owner replays an accepted answer forward with the same IDs and one answer run",
    () => {
      const harness = makeHarness();
      return Effect.scoped(
        Effect.gen(function* () {
          yield* setupBot;
          yield* linkSlackUser();
          const first = yield* claimFirstOwner;
          const gateway = yield* ChannelGateway.ChannelGateway;
          const ledger = yield* ChannelLedger.ChannelLedger;
          const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
          const reception = yield* ChannelReceptionService.ChannelReceptionService;
          const threads = yield* ThreadManagement.ThreadManagementService;
          yield* gateway.ingest(slackInput("do: recover answer", "restart-question"), slackContext);
          yield* first.drain;
          const task = yield* onlyTask;
          yield* reports.report(
            {
              taskId: task.taskId,
              eventId: ChannelTaskEventId.make("restart-question"),
              generation: 1,
              status: "waiting_input",
              summary: "Choose",
              question: "Where?",
            },
            task.worker!.threadId,
          );
          harness.world.setStatus(task.worker!.threadId, 1, "completed");
          yield* first.drain;
          const waiting = yield* onlyTask;
          const answer = yield* gateway.ingest(
            {
              ...slackInput("staging", "restart-answer"),
              intent: "answer",
              taskId: task.taskId,
              questionId: waiting.openQuestions[0]!.questionId,
            },
            slackContext,
          );
          yield* reception.receive(answer.inputId, first.ownerToken);
          const [pending] = yield* ledger.listPendingForwards(50);
          assert.isDefined(pending);
          const ids = answerForwardIdsFor(pending!.event.eventId);
          // Worker accepted the send; the old process died before completeForward committed.
          yield* threads.sendToThread({
            projectId,
            threadId: task.worker!.threadId,
            commandId: ids.commandId,
            messageId: ids.messageId,
            text: "Answer from Owner: staging",
            attachments: [],
            mode: "queue",
            createdBy: "user",
            creationSource: "server",
          });
          assert.strictEqual((yield* ledger.listPendingForwards(50)).length, 1);
          const second = yield* takeOver(first);
          yield* second.drain;
          yield* second.drain;
          assert.deepStrictEqual(yield* ledger.listPendingForwards(50), []);
          assert.strictEqual(harness.world.sends.length, 2);
          for (const send of harness.world.sends) {
            assert.strictEqual(send.commandId, ids.commandId);
            assert.strictEqual(send.messageId, ids.messageId);
          }
          assert.strictEqual(
            harness.world.runs
              .get(task.worker!.threadId)
              ?.filter((run) => run.userMessageId === ids.messageId).length,
            1,
          );
          assert.strictEqual(
            (yield* onlyTask).worker?.runId,
            harness.world.latestRun(task.worker!.threadId)?.id,
          );
          assert.strictEqual(resultsTo(harness.slackSent, "result").length, 0);
        }),
      ).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "a new owner's background acquisition settles in-flight Slack and GOAT deliveries",
    () => {
      const harness = makeHarness();
      return Effect.scoped(
        Effect.gen(function* () {
          yield* setupBot;
          yield* linkSlackUser();
          const first = yield* claimFirstOwner;
          yield* first.drain;
          harness.slackSent.length = 0;
          const ledger = yield* ChannelLedger.ChannelLedger;
          const gateway = yield* ChannelGateway.ChannelGateway;
          const reception = yield* ChannelReceptionService.ChannelReceptionService;
          const slack = yield* gateway.ingest(
            slackInput("Slack interrupted", "restart-delivery-slack"),
            slackContext,
          );
          const goat = yield* gateway.ingest(
            goatInput("GOAT interrupted", "restart-delivery-goat"),
            rpcContext,
          );
          yield* reception.receive(slack.inputId, first.ownerToken);
          yield* reception.receive(goat.inputId, first.ownerToken);
          const claimed = yield* ledger.claimDueDeliveries({
            owner: first.ownerToken,
            now,
            limit: 50,
          });
          assert.strictEqual(claimed.length, 2);
          const slackDelivery = deliveryIdFor("reply:" + slack.inputId);
          const goatDelivery = deliveryIdFor("reply:" + goat.inputId);
          assert.strictEqual(yield* ledger.getDeliveryState(slackDelivery), "delivering");
          assert.strictEqual(yield* ledger.getDeliveryState(goatDelivery), "delivering");
          const second = yield* makeRuntime;
          assert.notStrictEqual(second.ownerToken, first.ownerToken);
          yield* TestClock.adjust(Duration.seconds(31));
          const recovered = yield* Deferred.make<void>();
          // Observe recovery's completion, while the real background layer acquires ownership.
          yield* Layer.build(
            ChannelRuntime.layerBackground.pipe(
              Layer.provide(
                Layer.succeed(ChannelRuntime.ChannelRuntime, {
                  ...second,
                  runPass: Effect.succeed(0),
                  recover: second.recover.pipe(
                    Effect.tap(() => Deferred.succeed(recovered, undefined)),
                  ),
                }),
              ),
            ),
          );
          yield* Deferred.await(recovered);
          yield* second.drain;
          yield* second.drain;
          assert.strictEqual(yield* ledger.getDeliveryState(slackDelivery), "ambiguous");
          assert.strictEqual(yield* ledger.getDeliveryState(goatDelivery), "delivered");
          assert.strictEqual(harness.slackSent.length, 0);
          assert.strictEqual(
            (yield* botMessages).messages.filter(
              (message) =>
                message.role === "assistant" && message.channel?.inReplyToInputId === goat.inputId,
            ).length,
            1,
          );
        }),
      ).pipe(Effect.provide(harness.layer));
    },
  );
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

describe("what a channel worker is told", () => {
  it.effect("starts a worker on this machine with the project's standing instructions", () => {
    const harness = makeHarness({
      settingsLayer: ServerSettings.layerTest({
        textGenerationModelSelection: modelSelection,
        defaultRuntimeMode: "full-access",
        standingInstructions: "Open pull requests as drafts.",
      }).pipe(Layer.orDie),
    });
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(goatInput("do: tidy the docs", "standing-local"), rpcContext);
      yield* runtime.drain;
      assert.strictEqual(harness.world.launches.length, 1);
      const first = splitStandingInstructions(
        harness.world.launches[0]?.initialMessage?.text ?? "",
      );
      // The same versioned block goat_thread_launch writes, so clients show it collapsed.
      assert.strictEqual(first.block?.text, "Open pull requests as drafts.");
      assert.isTrue(first.text.startsWith("tidy the docs\n"));
      assert.include(first.text, "ask first: show the draft or plan in a waiting_input question.");
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("where channel work runs", () => {
  it.effect(
    "moves work off an account at its limit to another signed-in account of that provider",
    () => {
      const harness = makeHarness({
        providerInstances: [
          {
            instanceId: "codex",
            displayName: "Codex",
            weeklyUsedPercent: 100,
            resetsAt: "2099-01-01T00:00:00.000Z",
          },
          { instanceId: "codex-work", displayName: "Codex (work)", weeklyUsedPercent: 20 },
        ],
      });
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        yield* gateway.ingest(goatInput("do: busy work", "placement-local"), rpcContext);
        yield* runtime.drain;
        assert.strictEqual(harness.world.launches[0]?.modelSelection.instanceId, "codex-work");
        assert.strictEqual(harness.world.launches[0]?.modelSelection.model, modelSelection.model);
        const reason = "Codex (work) · 20% weekly used · Codex at usage limit";
        assert.strictEqual((yield* onlyTask).target?.placementReason, reason);
        const chip = (yield* botMessages).turnItems
          .flatMap((item) => (item.type === "notification" ? [item] : []))
          .flatMap((item) => (item.ledgerTask === undefined ? [] : [item.ledgerTask]))
          .at(-1);
        assert.strictEqual(chip?.placementReason, reason);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("keeps the configured account when it has room, and says how much it used", () => {
    const harness = makeHarness({
      providerInstances: [
        { instanceId: "codex", displayName: "Codex", weeklyUsedPercent: 30 },
        { instanceId: "codex-work", displayName: "Codex (work)", weeklyUsedPercent: 30 },
      ],
    });
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(goatInput("do: light work", "placement-tie"), rpcContext);
      yield* runtime.drain;
      assert.strictEqual(harness.world.launches[0]?.modelSelection.instanceId, "codex");
      assert.strictEqual((yield* onlyTask).target?.placementReason, "Codex · 30% weekly used");
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
  it.effect.each(["connection", "identity"] as const)(
    "starts no Slack work when the %s ceiling removes orchestration:operate",
    (lower) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const identities = yield* ChannelIdentityService.ChannelIdentityService;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const connection = {
          ...slackContext,
          grantedScopes:
            lower === "connection"
              ? ["orchestration:read" as const, "settings:write" as const]
              : owner.grantedScopes,
        };
        const { code } = yield* identities.createLink(
          {
            connectionId: "slack-1",
            runtimeModeCeiling: "auto-accept-edits",
            grantedScopes:
              lower === "identity"
                ? ["orchestration:read"]
                : ["orchestration:read", "orchestration:operate"],
          },
          owner,
        );
        yield* gateway.linkIdentity(
          {
            connectionId: "slack-1",
            externalActorId: "U1",
            code,
            idempotencyKey: "scope-link",
            replyAddress: slackInput("", "unused").replyAddress,
          },
          connection,
        );
        const input = yield* gateway.ingest(
          slackInput("do: forbidden work", "scope-work"),
          connection,
        );
        yield* runtime.drain;
        assert.deepStrictEqual((yield* ledger.getInput(input.inputId))?.requester?.grantedScopes, [
          "orchestration:read",
        ]);
        assert.strictEqual((yield* ledger.listTasks({ ownerId, limit: 10 })).tasks.length, 0);
        assert.strictEqual(harness.world.launches.length, 0);
        assert.strictEqual(harness.world.runs.size, 0);
      }).pipe(Effect.provide(harness.layer));
    },
  );
  it.effect("refuses an answer from someone who could not run the task", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser("U1");
      const gateway = yield* ChannelGateway.ChannelGateway;
      const identities = yield* ChannelIdentityService.ChannelIdentityService;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      // A colleague in the same Slack thread who may only read.
      const { code } = yield* identities.createLink(
        {
          connectionId: "slack-1",
          runtimeModeCeiling: "auto-accept-edits",
          grantedScopes: ["orchestration:read"],
        },
        owner,
      );
      yield* gateway.linkIdentity(
        {
          connectionId: "slack-1",
          externalActorId: "U2",
          code,
          idempotencyKey: "link-U2",
          replyAddress: slackInput("", "unused").replyAddress,
        },
        slackContext,
      );
      yield* gateway.ingest(slackInput("do: ship the fix", "answer-scope"), slackContext);
      yield* runtime.drain;
      const task = yield* onlyTask;
      yield* reports.report(
        {
          taskId: task.taskId,
          eventId: ChannelTaskEventId.make("answer-scope-question"),
          generation: task.generation,
          status: "waiting_input",
          summary: "Choose",
          question: "Staging or production?",
        },
        task.worker!.threadId,
      );
      harness.world.setStatus(task.worker!.threadId, 1, "completed");
      yield* runtime.drain;
      const waiting = yield* onlyTask;
      const answer = yield* gateway.ingest(
        {
          ...slackInput("production", "answer-scope-U2", undefined, "U2"),
          intent: "answer",
          taskId: task.taskId,
          questionId: waiting.openQuestions[0]!.questionId,
        },
        slackContext,
      );
      yield* runtime.drain;
      const after = yield* onlyTask;
      assert.strictEqual(after.status, "waiting_input");
      assert.deepStrictEqual(after.openQuestions, waiting.openQuestions);
      assert.strictEqual(harness.world.sends.length, 0);
      assert.strictEqual(
        (yield* ledger.getInput(answer.inputId))?.snapshot.reply?.text,
        CHANNEL_COPY.answerNotAllowed,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("refuses an answer from someone unlinked after sending it", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser("U1");
      const gateway = yield* ChannelGateway.ChannelGateway;
      const identities = yield* ChannelIdentityService.ChannelIdentityService;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(slackInput("do: ship the fix", "unlinked-answer"), slackContext);
      yield* runtime.drain;
      const task = yield* onlyTask;
      yield* reports.report(
        {
          taskId: task.taskId,
          eventId: ChannelTaskEventId.make("unlinked-answer-question"),
          generation: task.generation,
          status: "waiting_input",
          summary: "Choose",
          question: "Staging or production?",
        },
        task.worker!.threadId,
      );
      harness.world.setStatus(task.worker!.threadId, 1, "completed");
      yield* runtime.drain;
      const waiting = yield* onlyTask;
      yield* gateway.ingest(
        {
          ...slackInput("production", "unlinked-answer-reply"),
          intent: "answer",
          taskId: task.taskId,
          questionId: waiting.openQuestions[0]!.questionId,
        },
        slackContext,
      );
      // The link goes away before reception reads the answer.
      yield* identities.unlink({ connectionId: "slack-1", externalActorId: "U1" });
      yield* runtime.drain;
      const after = yield* onlyTask;
      assert.strictEqual(after.status, "waiting_input");
      assert.deepStrictEqual(after.openQuestions, waiting.openQuestions);
      assert.strictEqual(harness.world.sends.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

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

  it.effect("MCP input cannot move work through reception", () => {
    const harness = makeHarness();
    harness.script.current = (input) =>
      input.mode === "input"
        ? Effect.succeed({
            replyText: "Moving it.",
            action: { type: "move_task", taskId: ChannelTaskId.make("task-1"), host: "mini" },
          })
        : defaultScript(input);
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const receipt = yield* gateway.ingest(
        {
          kind: "mcp",
          connectionId: "mcp",
          conversationKey: "default",
          externalMessageId: "move-1",
          idempotencyKey: "move-1",
          actor: { senderThreadId: ThreadId.make("thread:some-agent") },
          replyAddress: {
            kind: "mcp",
            connectionId: "mcp",
            requestNamespace: "move-ns",
            conversationKey: "default",
          },
          text: "continue on mini",
          attachments: [],
          receivedAt: "2026-10-12T00:00:00.000Z",
          intent: "message",
        },
        {
          ...owner,
          principalId: "mcp:move-ns",
          grantedScopes: ["orchestration:read", "orchestration:operate"],
          caller: { type: "mcp", requestNamespace: "move-ns" },
        },
      );
      yield* runtime.drain;
      const input = yield* ledger.getInput(receipt.inputId);
      assert.strictEqual(input?.snapshot.reply?.text, CHANNEL_COPY.agentCannotMoveWork);
      assert.strictEqual((yield* ledger.listTasks({ ownerId, limit: 10 })).tasks.length, 0);
      assert.strictEqual(harness.world.launches.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

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
          grantedScopes: ["orchestration:read", "orchestration:operate"],
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
        assert.strictEqual(harness.world.launches.length, 0);
        assert.deepStrictEqual((yield* ledger.getInput(agent.inputId))?.requester?.grantedScopes, [
          "orchestration:read",
          "orchestration:operate",
        ]);
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

  it.effect("words a project question from real projects, not the model's options", () => {
    const harness = makeHarness({ projects: 2 });
    harness.script.current = (input) =>
      input.mode === "input"
        ? Effect.succeed({
            replyText: "Which project? goat-si, jun, or developer?",
            action: {
              type: "clarify" as const,
              question: "Which project? goat-si, jun, or developer?",
              options: ["goat-si", "jun", "developer"],
              about: "project" as const,
            },
          })
        : defaultScript(input);
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const receipt = yield* gateway.ingest(
        goatInput("fix the flaky test", "project-q"),
        rpcContext,
      );
      yield* runtime.drain;
      const reply = (yield* ledger.getInput(receipt.inputId))?.snapshot.reply?.text ?? "";
      assert.include(reply, "Which project should I use?");
      assert.notInclude(reply, "goat-si");
      assert.strictEqual(harness.world.launches.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

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
      // Slack reads the choices as a numbered list; the GOAT bot shows them as buttons.
      assert.match(question?.message.text ?? "", /\n\d+\. Channel work(?:\n|$)/);
      assert.match(question?.message.text ?? "", /\n\d+\. Other work 1(?:\n|$)/);
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

  it.effect("offers this machine and runs host-level work in the bot's workspace", () => {
    const harness = makeHarness({ projects: 2, botWorkspace: true });
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(slackInput("do: which repo?", "Ev42"), slackContext);
      yield* runtime.drain;
      const question = resultsTo(harness.slackSent, "question")[0];
      assert.isTrue(
        (question?.message.text ?? "")
          .split("\n")
          .some((line) => /^\d+\. /.test(line) && line.endsWith(CHANNEL_HOST_WORKSPACE_LABEL)),
      );
      // Picking this machine runs the work at the root of the bot's own workspace.
      const task = yield* onlyTask;
      harness.script.current = (input) =>
        input.mode === "input"
          ? Effect.succeed({
              replyText: "Thanks.",
              action: {
                type: "answer_question",
                taskId: task.taskId,
                questionId: task.openQuestions[0]!.questionId,
                answer: CHANNEL_HOST_WORKSPACE_LABEL,
              },
            })
          : defaultScript(input);
      yield* gateway.ingest(slackInput(CHANNEL_HOST_WORKSPACE_LABEL, "Ev43"), slackContext);
      yield* runtime.drain;
      assert.strictEqual(harness.world.launches.length, 1);
      assert.strictEqual(harness.world.launches[0]?.projectId, scratchProjectId);
      assert.deepStrictEqual(harness.world.launches[0]?.workspaceStrategy, { type: "root" });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("answers from host facts and keeps notes the person asks it to remember", () => {
    const harness = makeHarness();
    const seen: Array<ChannelReceptionInput> = [];
    harness.script.current = (input) => {
      seen.push(input);
      return input.inputText === "Always reply in Korean, remember that"
        ? Effect.succeed({
            replyText: "I'll keep that.",
            action: { type: "report_only" as const },
            remember: "Reply in Korean.",
            rememberQuote: "remember that",
          })
        : defaultScript(input);
    };
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const receipt = yield* gateway.ingest(
        goatInput("Always reply in Korean, remember that", "notes-1"),
        rpcContext,
      );
      yield* runtime.drain;
      yield* gateway.ingest(goatInput("what machine is this?", "notes-2"), rpcContext);
      yield* runtime.drain;
      const later = seen.find((input) => input.inputText === "what machine is this?");
      assert.include(later?.notes ?? "", "Reply in Korean. (asked in " + receipt.inputId + ")");
      assert.include((later?.hostFacts ?? []).map((fact) => fact.value).join("\n"), "test-machine");
      assert.strictEqual(harness.world.launches.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });
  it.effect("keeps the failure reason when the answer after a read fails", () => {
    const harness = makeHarness();
    const passes: Array<boolean | undefined> = [];
    harness.script.current = (input) => {
      if (input.mode !== "input") return defaultScript(input);
      passes.push(input.readsAllowed);
      return input.readsAllowed === true
        ? Effect.succeed({
            replyText: "",
            action: {
              type: "read" as const,
              reads: [{ kind: "memory" as const, query: "deploy" }],
            },
          })
        : Effect.fail(
            new TextGenerationError({
              operation: "generateChannelReception",
              detail: "Codex CLI request timed out.",
            }),
          );
    };
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const receipt = yield* gateway.ingest(
        goatInput("what did I deploy?", "read-fail"),
        rpcContext,
      );
      yield* runtime.drain;
      assert.deepStrictEqual(passes, [true, false]);
      assert.deepStrictEqual((yield* ledger.getInput(receipt.inputId))?.snapshot.failure, {
        reason: "reception_failed",
        message: CHANNEL_COPY.receptionFailedBecause.timeout,
      });
      assert.strictEqual(harness.world.launches.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect.each([
    {
      kind: "schema_rejected",
      detail:
        'Codex CLI command failed: {"error":{"message":"Invalid schema for response_format \'codex_output_schema\'","code":"invalid_json_schema"},"status":400}',
    },
    { kind: "unavailable", detail: "This provider does not support channel reception." },
  ] as const)("tells the person reception failed because of $kind", ({ kind, detail }) => {
    const harness = makeHarness();
    harness.script.current = (input) =>
      input.mode === "input"
        ? Effect.fail(new TextGenerationError({ operation: "generateChannelReception", detail }))
        : defaultScript(input);
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const receipt = yield* gateway.ingest(
        goatInput("what machine is this?", "fail-1"),
        rpcContext,
      );
      yield* runtime.drain;
      const failure = (yield* ledger.getInput(receipt.inputId))?.snapshot.failure;
      assert.deepStrictEqual(failure, {
        reason: "reception_failed",
        message: CHANNEL_COPY.receptionFailedBecause[kind],
      });
      // Provider output stays in the server log.
      assert.notInclude(failure?.message ?? "", detail);
      assert.strictEqual(harness.world.launches.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("channel worker memory grants", () => {
  it.effect.each([
    { scopes: [], ceiling: "none", readOnly: false, access: "none" },
    { scopes: ["memory:write"], ceiling: "none", readOnly: false, access: "none" },
    { scopes: ["memory:read"], ceiling: "read", readOnly: false, access: "read" },
    {
      scopes: ["memory:read", "memory:write"],
      ceiling: "read_write",
      readOnly: false,
      access: "read_write",
    },
    {
      scopes: ["memory:read", "memory:write"],
      ceiling: "read_write",
      readOnly: true,
      access: "read",
    },
  ] as const)(
    "persists $ceiling from GOAT scopes $scopes (read-only destination: $readOnly)",
    ({ scopes, ceiling, readOnly, access }) => {
      const harness = makeHarness({ realWorkerLaunch: true });
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        yield* gateway.ingest(goatInput("do: use the available memory", "memory-local"), {
          ...rpcContext,
          grantedScopes: [...owner.grantedScopes, ...scopes],
        });
        yield* runtime.drain;
        const task = yield* onlyTask;
        assert.strictEqual(task.status, "running");
        assert.strictEqual(
          task.target?.memoryGrantCeiling,
          ceiling === "none" ? undefined : ceiling,
        );
        assert.lengthOf(harness.world.launches, 1);
        const initial = harness.world.launches[0]!.initialMessage!;
        if (ceiling === "none") {
          assert.notProperty(task.target!, "memoryGrantCeiling");
          assert.notProperty(initial, "memoryGrantCeiling");
        } else {
          assert.strictEqual(initial.memoryGrantCeiling, ceiling);
        }
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const records = yield* orchestrator.getThreadRecords(task.worker!.threadId, ["runs"]);
        assert.lengthOf(records.runs, 1);
        assert.strictEqual(records.runs[0]!.memoryGrantCeiling, ceiling);
        assert.deepStrictEqual(
          currentMemoryAccess({
            enableAgentMemoryAccess: true,
            policyReady: true,
            readOnly,
            memoryGrantCeiling: records.runs[0]!.memoryGrantCeiling,
          }),
          { access, reason: readOnly ? "read_only_destination" : "ceiling" },
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect.each(["read", "none", "removed"] as const)(
    "intersects a Slack intake snapshot with a link changed to %s before dispatch",
    (change) => {
      const harness = makeHarness({ realWorkerLaunch: true });
      return Effect.gen(function* () {
        yield* setupBot;
        yield* linkMemoryUser(["memory:read", "memory:write"]);
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        yield* runtime.drain;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const receipt = yield* gateway.ingest(
          slackInput("do: use memory after intake", "memory-slack"),
          slackMemoryContext,
        );
        assert.include(
          (yield* ledger.getInput(receipt.inputId))!.requester!.grantedScopes,
          "memory:write",
        );
        // The task keeps the intake snapshot; dispatch must consult the current identity as well.
        yield* (yield* ChannelReceptionService.ChannelReceptionService).receive(
          receipt.inputId,
          runtime.ownerToken,
        );
        if (change === "removed") {
          yield* (yield* ChannelIdentityService.ChannelIdentityService).unlink({
            connectionId: "slack-1",
            externalActorId: "U1",
          });
        } else {
          yield* linkMemoryUser(change === "read" ? ["memory:read"] : []);
        }
        yield* runtime.drain;
        const task = yield* onlyTask;
        assert.include(task.requester.grantedScopes, "memory:write");
        if (change === "removed") {
          assert.strictEqual(task.status, "failed");
          assert.isUndefined(task.target);
          assert.lengthOf(harness.world.launches, 0);
          return;
        }
        assert.strictEqual(task.status, "running");
        const expected = change === "read" ? "read" : undefined;
        assert.strictEqual(task.target?.memoryGrantCeiling, expected);
        assert.strictEqual(harness.world.launches[0]?.initialMessage?.memoryGrantCeiling, expected);
        const records = yield* (yield* Orchestrator.OrchestratorV2).getThreadRecords(
          task.worker!.threadId,
          ["runs"],
        );
        assert.strictEqual(records.runs[0]?.memoryGrantCeiling, expected ?? "none");
      }).pipe(Effect.provide(harness.layer));
    },
  );
  it.effect.each(["read", "none"] as const)(
    "does not widen a stored %s ceiling when a Slack link is widened and the target is chosen again",
    (ceiling) => {
      const harness = makeHarness({ realWorkerLaunch: true });
      return Effect.gen(function* () {
        yield* setupBot;
        yield* linkMemoryUser(["memory:read", "memory:write"]);
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        yield* runtime.drain;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const receipt = yield* gateway.ingest(
          slackInput("do: pick a target again", "rechoose-memory"),
          slackMemoryContext,
        );
        yield* (yield* ChannelReceptionService.ChannelReceptionService).receive(
          receipt.inputId,
          runtime.ownerToken,
        );
        yield* linkMemoryUser(ceiling === "read" ? ["memory:read"] : []);
        const task = yield* onlyTask;
        const accepted = yield* Deferred.make<void>();
        harness.launch.afterAccepted = () =>
          Deferred.succeed(accepted, undefined).pipe(Effect.andThen(Effect.never));
        const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
        const launching = yield* dispatcher
          .dispatch(task.taskId, runtime.ownerToken)
          .pipe(Effect.forkScoped);
        yield* Deferred.await(accepted);
        yield* Fiber.interrupt(launching);
        harness.launch.afterAccepted = () => Effect.void;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const claimed = (yield* ledger.getTask(task.taskId))!;
        assert.strictEqual(claimed.task.status, "dispatching");
        assert.isUndefined(claimed.task.worker);
        assert.strictEqual(
          claimed.task.target?.memoryGrantCeiling,
          ceiling === "none" ? undefined : ceiling,
        );
        const questionId = ChannelQuestionId.make("question:rechoose-memory");
        yield* commitTransition(
          ledger,
          claimed,
          {
            type: "task.question.opened",
            payload: {
              question: {
                questionId,
                text: "Use this project?",
                askedAt: "2026-10-12T00:00:00.000Z",
              },
            },
          },
          { owner: runtime.ownerToken },
        );
        yield* linkMemoryUser(["memory:read", "memory:write"], "widened");
        assert.include(
          (yield* ledger.findIdentity({ connectionId: "slack-1", externalActorId: "U1" }))!
            .grantedScopes,
          "memory:write",
        );
        yield* commitTransition(
          ledger,
          (yield* ledger.getTask(task.taskId))!,
          {
            type: "task.question.answered",
            payload: { questionId, answer: "Use this project" },
          },
          { owner: runtime.ownerToken, actor: "user" },
        );
        assert.strictEqual((yield* onlyTask).status, "received");
        yield* dispatcher.dispatch(task.taskId, runtime.ownerToken);
        const rebound = yield* onlyTask;
        assert.strictEqual(rebound.status, "running");
        assert.strictEqual(
          rebound.target?.memoryGrantCeiling,
          ceiling === "none" ? undefined : ceiling,
        );
        assert.lengthOf(harness.world.launches, 2);
        for (const launch of harness.world.launches)
          assert.strictEqual(
            launch.initialMessage?.memoryGrantCeiling,
            ceiling === "none" ? undefined : ceiling,
          );
        const records = yield* (yield* Orchestrator.OrchestratorV2).getThreadRecords(
          rebound.worker!.threadId,
          ["runs"],
        );
        assert.lengthOf(records.runs, 1);
        assert.strictEqual(records.runs[0]!.memoryGrantCeiling, ceiling);
      }).pipe(Effect.provide(harness.layer));
    },
  );
});

describe("notes require a request in the current input", () => {
  it.effect.each(["missing quote", "earlier message only", "absent quote", "MCP input"] as const)(
    "saves no note for %s",
    (scenario) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        if (scenario === "earlier message only") {
          yield* gateway.ingest(
            goatInput("Always reply in Korean, remember that", "earlier-note"),
            rpcContext,
          );
          yield* runtime.drain;
        }
        let sawEarlierRequest = false;
        harness.script.current = (input) => {
          sawEarlierRequest = input.tail.some((entry) => entry.text.includes("remember that"));
          return Effect.succeed({
            replyText: "Okay.",
            action: { type: "report_only" },
            remember: "Reply in Korean.",
            ...(scenario === "missing quote" ? {} : { rememberQuote: "remember that" }),
          });
        };
        if (scenario === "MCP input") {
          yield* gateway.ingest(
            {
              kind: "mcp",
              connectionId: "mcp",
              conversationKey: "default",
              externalMessageId: "agent-note",
              idempotencyKey: "agent-note",
              actor: { senderThreadId: ThreadId.make("thread:note-agent") },
              replyAddress: {
                kind: "mcp",
                connectionId: "mcp",
                requestNamespace: "note-ns",
                conversationKey: "default",
              },
              text: "Always reply in Korean, remember that",
              attachments: [],
              receivedAt: "2026-10-12T00:00:00.000Z",
              intent: "message",
            },
            {
              ...owner,
              principalId: "mcp:note-ns",
              caller: { type: "mcp", requestNamespace: "note-ns" },
            },
          );
        } else {
          yield* gateway.ingest(
            goatInput(
              scenario === "missing quote"
                ? "Always reply in Korean, remember that"
                : "What machine is this?",
              "unasked-note",
            ),
            rpcContext,
          );
        }
        yield* runtime.drain;
        if (scenario === "earlier message only") assert.isTrue(sawEarlierRequest);
        assert.isFalse(yield* notesFileExists);
        assert.lengthOf(harness.world.launches, 0);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "repeats reception after an uncommitted reply without duplicating the input note",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        yield* runtime.drain;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const receipt = yield* gateway.ingest(
          goatInput("Always reply in Korean, remember that", "superseded-note"),
          rpcContext,
        );
        const newerId = ChannelReceptionId.make("reception:newer-note-pass");
        harness.script.current = () =>
          Effect.gen(function* () {
            // Same owner, newer reception id: the old pass's completeReception returns false.
            yield* ledger
              .beginReception({
                owner: runtime.ownerToken,
                inputId: receipt.inputId,
                receptionId: newerId,
                readAt: "2026-10-12T00:00:00.000Z",
              })
              .pipe(Effect.orDie);
            return {
              replyText: "I'll remember.",
              action: { type: "report_only" as const },
              remember: "Reply in Korean.",
              rememberQuote: "remember that",
            };
          });
        yield* (yield* ChannelReceptionService.ChannelReceptionService).receive(
          receipt.inputId,
          runtime.ownerToken,
        );
        const stored = (yield* ledger.getInput(receipt.inputId))!;
        assert.strictEqual(stored.snapshot.receptionId, newerId);
        assert.strictEqual(stored.snapshot.state, "processing");
        assert.isUndefined(stored.snapshot.reply);
        // A note is saved before reply completion; retrying this input must not append another.
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const files = channelBotFilesFor(path, (yield* ServerConfig.ServerConfig).stateDir);
        const firstNotes = yield* fs.readFileString(files.notes);
        const marker = " (asked in " + receipt.inputId + ")";
        assert.strictEqual(
          firstNotes.split("\n").filter((line) => line.includes(marker)).length,
          1,
        );
        harness.script.current = () =>
          Effect.succeed({
            replyText: "I'll remember.",
            action: { type: "report_only" },
            remember: "Reply in Korean.",
            rememberQuote: "remember that",
          });
        yield* (yield* ChannelReceptionService.ChannelReceptionService).receive(
          receipt.inputId,
          runtime.ownerToken,
        );
        assert.strictEqual((yield* ledger.getInput(receipt.inputId))!.snapshot.state, "replied");
        assert.strictEqual(yield* fs.readFileString(files.notes), firstNotes);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect.each(["quoted", "unquoted", "missing"] as const)(
    "records a %s request to change notes and gives the worker the corresponding permission",
    (scenario) => {
      const harness = makeHarness();
      const quote = scenario === "unquoted" ? "forget the English note" : "forget the Korean note";
      harness.script.current = (input) =>
        input.mode === "input"
          ? Effect.succeed({
              replyText: "On it.",
              action: {
                type: "create_task",
                title: "Forget a note",
                instruction: "Remove the requested note.",
                ...(scenario === "missing" ? {} : { notesChangeRequested: quote }),
              },
            })
          : defaultScript(input);
      return Effect.gen(function* () {
        yield* setupBot;
        yield* (yield* ChannelGateway.ChannelGateway).ingest(
          goatInput("Please forget the Korean note", "change-note"),
          rpcContext,
        );
        yield* (yield* ChannelRuntime.ChannelRuntime).drain;
        const task = yield* onlyTask;
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          event_json: string;
        }>`SELECT event_json FROM channel_task_events WHERE task_id = ${task.taskId} AND type = 'task.created'`;
        assert.lengthOf(rows, 1);
        const created = yield* decodeTaskEventJsonEffect(rows[0]!.event_json);
        assert.strictEqual(created.type, "task.created");
        if (created.type !== "task.created") return yield* Effect.die("expected task.created");
        const instruction = harness.world.launches[0]!.initialMessage!.text;
        if (scenario === "quoted") {
          assert.strictEqual(task.notesChangeRequested, quote);
          assert.strictEqual(created.payload.notesChangeRequested, quote);
          assert.include(instruction, JSON.stringify(quote));
          assert.include(instruction, "Edit the notes file only to make that change.");
          assert.notInclude(instruction, "Leave the notes file unchanged");
        } else {
          assert.notProperty(task, "notesChangeRequested");
          assert.notProperty(created.payload, "notesChangeRequested");
          assert.include(
            instruction,
            "Leave the notes file unchanged; this task did not ask to change a note.",
          );
          assert.notInclude(instruction, "Edit the notes file only");
        }
        assert.isFalse(yield* notesFileExists);
      }).pipe(
        Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
      );
    },
  );
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

  // WorkerWorld scripts runs, but result reports use the harness's migrated database,
  // the same row goat_thread_report_result writes through ThreadResultService.report.
  const storeReport = (harness: ReturnType<typeof makeHarness>, report: ThreadResultReport) =>
    Effect.gen(function* () {
      const task = yield* onlyTask;
      const threadId = task.worker!.threadId;
      const run = harness.world.latestRun(threadId)!;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO thread_run_results (thread_id, run_id, report_json, reported_at)
        VALUES (${threadId}, ${run.id}, ${JSON.stringify(report)}, ${"2026-10-12T00:00:00.000Z"})
      `;
    });

  const taskEvents = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ event_json: string }>`
      SELECT event_json FROM channel_task_events ORDER BY sequence
    `;
    return rows.map((row) => decodeTaskEventJson(row.event_json));
  });

  it.effect.each([
    { outcome: "failed", reason: "reported_outcome" },
    { outcome: "cancelled", reason: "reported_cancelled" },
  ] as const)("fails a cleanly completed run reported as $outcome", ({ outcome, reason }) => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { threadId, runtime } = yield* startTask();
      yield* storeReport(harness, { outcome, summary: "  Could not deploy.  " });
      // A report alone is not a terminal run.
      yield* runtime.drain;
      assert.strictEqual((yield* onlyTask).status, "running");
      harness.world.setStatus(threadId, 1, "completed", "Everything worked.");
      yield* runtime.drain;
      assert.strictEqual((yield* onlyTask).status, "failed");
      assert.strictEqual((yield* onlyTask).resultSummary, "Could not deploy.");
      const failures = (yield* taskEvents).filter((event) => event.type === "task.failed");
      assert.strictEqual(failures.length, 1);
      assert.strictEqual(failures[0]!.payload.reason, reason);
      assert.isFalse(
        (yield* taskEvents).some(
          (event) => event.type === "task.completed" || event.type === "task.cancelled",
        ),
      );
      assert.strictEqual(resultsTo(harness.slackSent, "failure").length, 1);
      assert.strictEqual(resultsTo(harness.slackSent, "result").length, 0);
    }).pipe(Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))));
  });

  it.effect.each([
    { summary: "  Which deployment target?  ", question: "Which deployment target?" },
    {
      summary: undefined,
      question:
        "The worker reported that it is blocked without giving a reason. How should it continue?",
    },
  ])(
    "asks about a blocked result and resumes the same task ($summary)",
    ({ summary, question }) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const { task, threadId, runtime } = yield* startTask();
        yield* storeReport(harness, {
          outcome: "blocked",
          ...(summary === undefined ? {} : { summary }),
        });
        harness.world.setStatus(threadId, 1, "completed", "Done.");
        yield* runtime.drain;
        const waiting = yield* onlyTask;
        assert.strictEqual(waiting.status, "waiting_input");
        assert.strictEqual(waiting.openQuestions.length, 1);
        assert.strictEqual(waiting.openQuestions[0]!.text, question);
        assert.strictEqual(resultsTo(harness.slackSent, "question")[0]?.message.text, question);
        assert.strictEqual(resultsTo(harness.slackSent, "result").length, 0);
        const gateway = yield* ChannelGateway.ChannelGateway;
        yield* gateway.ingest(
          {
            ...slackInput("staging", "reported-blocked-answer"),
            intent: "answer",
            taskId: task.taskId,
            questionId: waiting.openQuestions[0]!.questionId,
          },
          slackContext,
        );
        yield* runtime.drain;
        const resumed = yield* onlyTask;
        const nextRun = harness.world.latestRun(threadId)!;
        assert.strictEqual(resumed.taskId, task.taskId);
        assert.strictEqual(resumed.generation, task.generation);
        assert.strictEqual(resumed.status, "running");
        assert.deepStrictEqual(resumed.openQuestions, []);
        assert.strictEqual(resumed.worker?.threadId, threadId);
        assert.strictEqual(resumed.worker?.runId, nextRun.id);
        assert.strictEqual(nextRun.ordinal, 2);
        assert.strictEqual(harness.world.launches.length, 1);
        assert.strictEqual(harness.world.sends.length, 1);
        harness.world.setStatus(threadId, 2, "completed", "Deployed to staging.");
        yield* runtime.drain;
        const done = yield* onlyTask;
        assert.strictEqual(done.status, "completed");
        assert.strictEqual(done.resultSummary, "Deployed to staging.");
        assert.strictEqual(done.completionReport, "missing");
      }).pipe(
        Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
      );
    },
  );

  it.effect.each(["present", "missing"] as const)(
    "records completion report %s in the event, task and bot chip",
    (report) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const { task, threadId, runtime } = yield* startTask();
        if (report === "present")
          yield* storeReport(harness, {
            outcome: "succeeded",
            summary: "  Deployment verified.  ",
          });
        harness.world.setStatus(threadId, 1, "completed", "Last assistant message.");
        yield* runtime.drain;
        yield* runtime.drain;
        const done = yield* onlyTask;
        const summary = report === "present" ? "Deployment verified." : "Last assistant message.";
        assert.strictEqual(done.status, "completed");
        assert.strictEqual(done.resultSummary, summary);
        assert.strictEqual(done.completionReport, report);
        const completions = (yield* taskEvents).filter((event) => event.type === "task.completed");
        assert.strictEqual(completions.length, 1);
        assert.strictEqual(completions[0]!.payload.report, report);
        assert.strictEqual(completions[0]!.payload.summary, summary);
        const records = yield* botMessages;
        const chips = records.turnItems.flatMap((item) =>
          item.type === "notification" && item.ledgerTask?.taskId === task.taskId
            ? [item.ledgerTask]
            : [],
        );
        assert.strictEqual(chips.at(-1)?.status, "completed");
        assert.strictEqual(chips.at(-1)?.completionReport, report);
        assert.strictEqual(resultsTo(harness.slackSent, "result").length, 1);
      }).pipe(
        Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
      );
    },
  );

  it.effect.each(["failed", "cancelled"] as const)(
    "keeps run-level %s authoritative over a succeeded report",
    (status) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const { threadId, runtime } = yield* startTask();
        yield* storeReport(harness, { outcome: "succeeded", summary: "Claimed success." });
        harness.world.setStatus(threadId, 1, status);
        yield* runtime.drain;
        assert.strictEqual((yield* onlyTask).status, status);
        const events = yield* taskEvents;
        if (status === "failed") {
          const failure = events.find((event) => event.type === "task.failed");
          assert.strictEqual(failure?.payload.reason, "failed");
        } else {
          assert.isTrue(events.some((event) => event.type === "task.cancelled"));
        }
        assert.isFalse(events.some((event) => event.type === "task.completed"));
      }).pipe(
        Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
      );
    },
  );
  it.effect("holds a finished worker for its PR watch and keeps the PR after completion", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { task, threadId, runtime } = yield* startTask();
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const link: ThreadPullRequestLink = {
        host: "github.com",
        repository: "goat-si/goat",
        number: 123,
        url: "https://github.com/goat-si/goat/pull/123",
        source: "created",
        linkedAt: "2026-10-12T00:00:00.000Z",
        snapshot: null,
        stack: null,
      };
      harness.world.pullRequests.set(threadId, [
        {
          ...link,
          watch: {
            startedAt: link.linkedAt,
            headSha: null,
            failedChecks: [],
            passed: false,
            passedChecks: [],
            remarksThrough: link.linkedAt,
            remarkIds: [],
            conflicting: false,
            wakes: 0,
          },
        },
      ]);
      harness.world.setStatus(threadId, 1, "completed", "Opened the pull request.");

      yield* reports.reconcile(runtime.ownerToken);
      const held = yield* ledger.getTask(task.taskId);
      assert.strictEqual(held?.task.status, "running");
      assert.strictEqual(held?.completionHold, "background");
      assert.deepStrictEqual(held?.task.observed, {
        result: { runId: task.worker!.runId!, observedCheckPending: true },
        pullRequests: [{ repository: link.repository, number: 123, url: link.url, watching: true }],
        needsYou: [],
      });
      assert.lengthOf(resultsTo(harness.slackSent, "result"), 0);

      harness.world.pullRequests.set(threadId, [link]);
      yield* reports.reconcile(runtime.ownerToken);
      const done = yield* ledger.getTask(task.taskId);
      assert.strictEqual(done?.task.status, "completed");
      assert.isUndefined(done?.completionHold);
      assert.deepStrictEqual(done?.task.observed, {
        result: { runId: task.worker!.runId!, observedCheckPending: true },
        pullRequests: [
          { repository: link.repository, number: 123, url: link.url, watching: false },
        ],
        needsYou: [],
      });
      yield* runtime.drain;
      assert.lengthOf(resultsTo(harness.slackSent, "result"), 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("counts a running worker's pending approval and clears it when resolved", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { threadId, runtime } = yield* startTask();
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const since = "2026-10-12T00:01:00.000Z";
      const request = {
        id: RuntimeRequestId.make("approval:channel-worker"),
        nodeId: NodeId.make("node:channel-worker"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "command" as const,
        status: "pending" as const,
        responseCapability: { type: "message" as const },
        createdAt: DateTime.makeUnsafe(since),
        resolvedAt: null,
      };
      assert.strictEqual(yield* ledger.countWaitingTasks(ownerId), 0);
      harness.world.runtimeRequests.set(threadId, [request]);
      yield* reports.reconcile(runtime.ownerToken);
      const pending = yield* onlyTask;
      assert.strictEqual(pending.status, "running");
      assert.deepStrictEqual(pending.observed?.needsYou, [
        { kind: "approval", since, approval: { requestId: request.id, threadId } },
      ]);
      assert.strictEqual(yield* ledger.countWaitingTasks(ownerId), 1);

      harness.world.runtimeRequests.set(threadId, [
        {
          ...request,
          status: "resolved",
          resolvedAt: DateTime.makeUnsafe("2026-10-12T00:02:00.000Z"),
        },
      ]);
      yield* reports.reconcile(runtime.ownerToken);
      const resolved = yield* onlyTask;
      assert.strictEqual(resolved.status, "running");
      assert.deepStrictEqual(resolved.observed?.needsYou, []);
      assert.strictEqual(yield* ledger.countWaitingTasks(ownerId), 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("arms usage-limit recovery once and rebinds to the continuation run", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-12T00:00:00.000Z"));
      const { task, threadId, runtime } = yield* startTask();
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const resetAt = "2026-10-12T01:00:00.000Z";
      const runId = task.worker!.runId!;
      harness.world.setStatus(threadId, 1, "failed");
      harness.world.shells.set(threadId, {
        latestRunId: runId,
        lastErrorClass: "usage_limit",
        usageLimitResetAt: resetAt,
      });
      yield* reports.reconcile(runtime.ownerToken);
      const waiting = yield* onlyTask;
      assert.strictEqual(waiting.status, "running");
      assert.deepStrictEqual(waiting.observed, {
        pullRequests: [],
        needsYou: [],
        usageLimitResetAt: resetAt,
      });
      assert.strictEqual(yield* ledger.countWaitingTasks(ownerId), 0);
      assert.deepStrictEqual(harness.world.commands, [
        {
          type: "thread.metadata.update",
          commandId: CommandId.make(`channel-limit-arm:${threadId}:${runId}:1791766800000`),
          threadId,
          limitRecovery: { runId, resetAt, autoResume: true, snooze: false },
        },
      ]);

      assert.strictEqual(yield* reports.reconcile(runtime.ownerToken), 0);
      const unchanged = yield* onlyTask;
      assert.strictEqual(unchanged.version, waiting.version);
      assert.deepStrictEqual(unchanged.observed, waiting.observed);
      assert.lengthOf(harness.world.commands, 1);
      assert.isFalse(yield* ledger.hasTaskEvent(taskEventIdFor(task.taskId, waiting.version + 1)));

      const continuation = harness.world.addRun(threadId, MessageId.make("limit-continuation"));
      yield* reports.reconcile(runtime.ownerToken);
      const resumed = yield* onlyTask;
      assert.strictEqual(resumed.status, "running");
      assert.strictEqual(resumed.worker?.runId, continuation.id);
      assert.isAbove(resumed.version, waiting.version);
      assert.deepStrictEqual(resumed.observed, { pullRequests: [], needsYou: [] });
      assert.lengthOf(harness.world.commands, 1);
      assert.lengthOf(resultsTo(harness.slackSent, "failure"), 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps a usage-limited worker running and asks for help when no reset is known", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const since = "2026-10-12T00:00:00.000Z";
      yield* TestClock.setTime(Date.parse(since));
      const { task, threadId, runtime } = yield* startTask();
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const ledger = yield* ChannelLedger.ChannelLedger;
      harness.world.setStatus(threadId, 1, "failed");
      harness.world.shells.set(threadId, {
        latestRunId: task.worker!.runId!,
        lastErrorClass: "usage_limit",
      });
      yield* reports.reconcile(runtime.ownerToken);
      const waiting = yield* onlyTask;
      assert.strictEqual(waiting.status, "running");
      assert.deepStrictEqual(waiting.observed, {
        pullRequests: [],
        needsYou: [{ kind: "usage_limit", since }],
      });
      assert.strictEqual(yield* ledger.countWaitingTasks(ownerId), 1);
      assert.lengthOf(harness.world.commands, 0);
      yield* runtime.drain;
      assert.lengthOf(resultsTo(harness.slackSent, "failure"), 0);
      assert.lengthOf(resultsTo(harness.slackSent, "result"), 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "arms recovery for a usage-limited run even when follow-ups were queued or cancelled behind it",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-10-12T00:00:00.000Z"));
        const { task, threadId, runtime } = yield* startTask();
        const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
        const resetAt = "2026-10-12T01:00:00.000Z";
        const limitedRunId = task.worker!.runId!;
        harness.world.setStatus(threadId, 1, "failed");
        // A follow-up cancelled before it started never ran, so it does not hide the limit.
        const skipped = harness.world.addRun(threadId, MessageId.make("cancelled-follow-up"));
        harness.world.setStatus(threadId, skipped.ordinal, "cancelled");
        const queued = harness.world.addRun(threadId, MessageId.make("queued-follow-up"));
        harness.world.setStatus(threadId, queued.ordinal, "queued");
        // The shell names the run that blocks the queue, as the projection does.
        harness.world.shells.set(threadId, {
          latestRunId: limitedRunId,
          lastErrorClass: "usage_limit",
          usageLimitResetAt: resetAt,
        });
        yield* reports.reconcile(runtime.ownerToken);
        yield* reports.reconcile(runtime.ownerToken);
        const waiting = yield* onlyTask;
        assert.strictEqual(waiting.status, "running");
        assert.strictEqual(waiting.worker?.runId, queued.id);
        assert.deepStrictEqual(waiting.observed, {
          pullRequests: [],
          needsYou: [],
          usageLimitResetAt: resetAt,
        });
        assert.lengthOf(harness.world.commands, 1);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("decides nothing about a failed run while its thread cannot be read", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { task, threadId, runtime } = yield* startTask();
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      harness.world.setStatus(threadId, 1, "failed");
      harness.world.shells.set(threadId, {
        latestRunId: task.worker!.runId!,
        lastErrorClass: "usage_limit",
      });
      harness.world.shellFailures.add(threadId);
      yield* reports.reconcile(runtime.ownerToken);
      assert.strictEqual((yield* onlyTask).status, "running");
      harness.world.shellFailures.delete(threadId);
      yield* reports.reconcile(runtime.ownerToken);
      const paused = yield* onlyTask;
      assert.strictEqual(paused.status, "running");
      assert.deepStrictEqual(
        paused.observed?.needsYou.map((item) => item.kind),
        ["usage_limit"],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps a usage limit on the person when recovery cannot be armed", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-12T00:00:00.000Z"));
      const { task, threadId, runtime } = yield* startTask();
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const resetAt = "2026-10-12T01:00:00.000Z";
      harness.world.setStatus(threadId, 1, "failed");
      harness.world.shells.set(threadId, {
        latestRunId: task.worker!.runId!,
        lastErrorClass: "usage_limit",
        usageLimitResetAt: resetAt,
      });
      harness.world.dispatchFailures.add(threadId);
      yield* reports.reconcile(runtime.ownerToken);
      const refused = yield* onlyTask;
      assert.strictEqual(refused.status, "running");
      assert.strictEqual(refused.observed?.usageLimitResetAt, resetAt);
      assert.deepStrictEqual(
        refused.observed?.needsYou.map((item) => item.kind),
        ["usage_limit"],
      );
      harness.world.dispatchFailures.delete(threadId);
      yield* reports.reconcile(runtime.ownerToken);
      const armed = yield* onlyTask;
      assert.deepStrictEqual(armed.observed?.needsYou, []);
      assert.lengthOf(harness.world.commands, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect.each(["failed", "cancelled"] as const)(
    "ends a task waiting for an answer when its worker run %s",
    (status) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const { task, threadId, runtime } = yield* startTask();
        const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
        yield* reports.report(
          {
            taskId: task.taskId,
            eventId: ChannelTaskEventId.make("question-before-" + status),
            generation: task.generation,
            status: "waiting_input",
            summary: "Need a decision",
            question: "Staging or production?",
          },
          threadId,
        );
        harness.world.setStatus(threadId, 1, status);
        yield* runtime.drain;
        yield* runtime.drain;
        assert.strictEqual((yield* onlyTask).status, status);
        assert.strictEqual(resultsTo(harness.slackSent, "result").length, 0);
        assert.strictEqual(resultsTo(harness.slackSent, "failure").length, 1);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "words a result with the requester's own message, not only the worker's summary",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        yield* linkSlackUser();
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const seen: Array<ReadonlyArray<string>> = [];
        harness.script.current = (input) => {
          if (input.mode === "task_event") seen.push(input.tail.map((entry) => entry.text));
          return defaultScript(input);
        };
        yield* gateway.ingest(
          slackInput("do: notes.txt 파일을 만들어 줘", "Ev-language"),
          slackContext,
        );
        yield* runtime.drain;
        const task = yield* onlyTask;
        harness.world.setStatus(task.worker!.threadId, 1, "completed", "Created notes.txt.");
        yield* runtime.drain;
        yield* runtime.drain;
        // The worker reported in English; the requester's Korean words travel with the update.
        assert.deepStrictEqual(seen, [["do: notes.txt 파일을 만들어 줘"]]);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("ends a waiting task when a newer run on its worker fails", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { task, threadId, runtime } = yield* startTask();
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* reports.report(
        {
          taskId: task.taskId,
          eventId: ChannelTaskEventId.make("question-before-newer-run"),
          generation: task.generation,
          status: "waiting_input",
          summary: "Need a decision",
          question: "Staging or production?",
        },
        threadId,
      );
      harness.world.setStatus(threadId, 1, "completed");
      yield* runtime.drain;
      // Someone works in the worker thread directly while the question is open, and it fails.
      harness.world.addRun(threadId, MessageId.make("typed-in-the-worker"));
      harness.world.setStatus(threadId, 2, "failed");
      yield* runtime.drain;
      yield* runtime.drain;
      assert.strictEqual((yield* onlyTask).status, "failed");
      assert.strictEqual(resultsTo(harness.slackSent, "result").length, 0);
      assert.strictEqual(resultsTo(harness.slackSent, "failure").length, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("asks again instead of forwarding an answer to a worker raised above the task", () => {
    const harness = makeHarness({ realWorkerLaunch: true });
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* gateway.ingest(slackInput("do: careful work", "raised-work"), slackContext);
      yield* runtime.drain;
      yield* runtime.drain;
      const task = yield* onlyTask;
      const threadId = task.worker!.threadId;
      yield* reports.report(
        {
          taskId: task.taskId,
          eventId: ChannelTaskEventId.make("raised-question"),
          generation: task.generation,
          status: "waiting_input",
          summary: "Need a decision",
          question: "Staging or production?",
        },
        threadId,
      );
      const waiting = yield* onlyTask;
      // Someone raises the worker above the requester's auto-accept-edits ceiling.
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("raise-worker"),
        threadId,
        runtimeMode: "full-access",
      });
      const runsBefore = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs.length;
      yield* gateway.ingest(
        {
          ...slackInput("production", "raised-answer"),
          intent: "answer",
          taskId: task.taskId,
          questionId: waiting.openQuestions[0]!.questionId,
        },
        slackContext,
      );
      yield* runtime.drain;
      const after = yield* onlyTask;
      assert.strictEqual(after.status, "waiting_input");
      assert.strictEqual(after.openQuestions.length, 1);
      assert.include(after.openQuestions[0]!.text, "full-access");
      assert.deepStrictEqual(yield* ledger.listPendingForwards(50), []);
      assert.strictEqual(
        (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs.length,
        runsBefore,
      );
      assert.include(
        resultsTo(harness.slackSent, "question").at(-1)?.message.text ?? "",
        "full-access",
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "refuses a completed report from the wrong generation without recording a completion",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const { task, threadId, runtime } = yield* startTask();
        const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const eventId = ChannelTaskEventId.make("wrong-generation-completed");
        const error = yield* Effect.flip(
          reports.report(
            {
              taskId: task.taskId,
              eventId,
              generation: task.generation + 1,
              status: "completed",
              summary: "False success",
            },
            threadId,
          ),
        );
        assert.strictEqual(error.reason, "forbidden");
        yield* runtime.drain;
        const current = yield* onlyTask;
        assert.strictEqual(current.status, "running");
        assert.strictEqual(current.version, task.version);
        assert.isUndefined(current.proposedCompletion);
        assert.isFalse(yield* ledger.hasTaskEvent(eventId));
        assert.isFalse(yield* ledger.hasTaskEvent(taskEventIdFor(task.taskId, task.version + 1)));
        assert.strictEqual(resultsTo(harness.slackSent, "result").length, 0);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("delivers only failure when a proposed completion's worker run fails", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { task, threadId, runtime } = yield* startTask();
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* reports.report(
        {
          taskId: task.taskId,
          eventId: ChannelTaskEventId.make("completed-before-failure"),
          generation: task.generation,
          status: "completed",
          summary: "All done",
        },
        threadId,
      );
      assert.isDefined((yield* onlyTask).proposedCompletion);
      harness.world.setStatus(threadId, 1, "failed", "This is not a successful result.");
      yield* runtime.drain;
      yield* runtime.drain;
      const failed = yield* onlyTask;
      assert.strictEqual(failed.status, "failed");
      assert.strictEqual(failed.resultSummary, "The coding thread ended with failed.");
      assert.strictEqual(resultsTo(harness.slackSent, "result").length, 0);
      assert.strictEqual(resultsTo(harness.slackSent, "failure").length, 1);
      assert.strictEqual(resultsTo(harness.slackSent, "failure")[0]?.message.taskId, task.taskId);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps an open question when the worker reports completed and its run finishes", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { task, threadId, runtime } = yield* startTask();
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* reports.report(
        {
          taskId: task.taskId,
          eventId: ChannelTaskEventId.make("open-before-completed"),
          generation: task.generation,
          status: "waiting_input",
          summary: "Need a decision",
          question: "Staging or production?",
        },
        threadId,
      );
      const waiting = yield* onlyTask;
      const proposalId = ChannelTaskEventId.make("completed-with-open-question");
      yield* reports.report(
        {
          taskId: task.taskId,
          eventId: proposalId,
          generation: task.generation,
          status: "completed",
          summary: "Pretend done",
        },
        threadId,
      );
      harness.world.setStatus(threadId, 1, "completed", "Pretend done");
      yield* runtime.drain;
      yield* runtime.drain;
      const current = yield* onlyTask;
      assert.strictEqual(current.status, "waiting_input");
      assert.deepStrictEqual(current.openQuestions, waiting.openQuestions);
      assert.strictEqual(current.version, waiting.version + 1);
      assert.isFalse(yield* ledger.hasTaskEvent(proposalId));
      assert.deepStrictEqual(current.observed?.result, {
        runId: current.worker!.runId!,
        observedCheckPending: true,
      });
      yield* runtime.drain;
      assert.strictEqual((yield* onlyTask).version, current.version);
      assert.strictEqual(resultsTo(harness.slackSent, "result").length, 0);
      assert.strictEqual(resultsTo(harness.slackSent, "question").length, 1);
    }).pipe(Effect.provide(harness.layer));
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

const otherHomeId = EnvironmentId.make("environment:other-home");
const homeClaim = (environmentId: EnvironmentId, claimedAt = 1) => ({
  environmentId,
  claimedAt,
  claimId: "home-" + claimedAt,
});
const homeMcpContext = {
  ...rpcContext,
  principalId: "mcp:home-test",
  caller: { type: "mcp" as const, requestNamespace: "home-test" },
};
const homeMcpInput = (key: string): ChannelIngestInput => ({
  kind: "mcp",
  connectionId: "mcp",
  conversationKey: "default",
  externalMessageId: key,
  idempotencyKey: key,
  actor: {},
  replyAddress: {
    kind: "mcp",
    connectionId: "mcp",
    requestNamespace: "home-test",
    conversationKey: "default",
  },
  text: "How is work going?",
  attachments: [],
  receivedAt: "2026-10-13T00:00:00.000Z",
  intent: "message",
});

describe("GOAT Bot home", () => {
  it.effect.each(["unset", "self", "other"] as const)(
    "gates ensure, GOAT and MCP input when home is %s",
    (home) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const settings = yield* ServerSettings.ServerSettingsService;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const bots = yield* ChannelBotRegistry.ChannelBotRegistry;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const previous = yield* gateway.ingest(homeMcpInput("previous"), homeMcpContext);
        if (home !== "unset")
          yield* settings.updateSettings({
            goatBotHome: homeClaim(home === "self" ? environmentId : otherHomeId),
          });
        if (home === "other") {
          const pending = yield* ledger.listPendingInputs(100);
          for (const effect of [
            bots.ensure({}, owner).pipe(Effect.asVoid),
            gateway.ingest(goatInput("hello", "home-goat"), rpcContext).pipe(Effect.asVoid),
            gateway.ingest(homeMcpInput("home-mcp"), homeMcpContext).pipe(Effect.asVoid),
          ]) {
            const error = yield* Effect.flip(effect);
            assert.strictEqual(error.reason, "not_home");
            assert.strictEqual(error.homeEnvironmentId, otherHomeId);
          }
          assert.deepStrictEqual(yield* ledger.listPendingInputs(100), pending);
          for (const input of [
            { kind: "goat" as const, connectionId: "goat", idempotencyKey: "home-goat" },
            {
              kind: "mcp" as const,
              connectionId: "mcp",
              idempotencyKey: JSON.stringify(["home-test", "home-mcp"]),
            },
          ]) {
            assert.isUndefined(yield* ledger.getInput(inputIdFor({ ...input, ownerId })));
          }
          assert.strictEqual(
            (yield* gateway.getInput(previous.inputId, homeMcpContext)).inputId,
            previous.inputId,
          );
          // Moving back makes the same service eligible without rebuilding it.
          yield* settings.updateSettings({ goatBotHome: homeClaim(environmentId, 2) });
        }
        assert.strictEqual((yield* bots.ensure({}, owner)).environmentId, environmentId);
        assert.strictEqual(
          (yield* gateway.ingest(goatInput("hello", "home-goat"), rpcContext)).state,
          "accepted",
        );
        assert.strictEqual(
          (yield* gateway.ingest(homeMcpInput("home-mcp"), homeMcpContext)).state,
          "accepted",
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("closes pending inputs with a fenced failure reply after moving home", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      let receptionCalls = 0;
      harness.script.current = (input) => {
        receptionCalls++;
        return defaultScript(input);
      };
      const gateway = yield* ChannelGateway.ChannelGateway;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const settings = yield* ServerSettings.ServerSettingsService;
      const goat = yield* gateway.ingest(goatInput("do: pending", "pending-home"), rpcContext);
      const mcp = yield* gateway.ingest(homeMcpInput("pending-home"), homeMcpContext);
      yield* settings.updateSettings({ goatBotHome: homeClaim(otherHomeId) });
      // Slack ingress is unaffected; reception still closes its pending message.
      const slack = yield* gateway.ingest(slackInput("pending", "pending-home"), slackContext);
      yield* runtime.drain;
      assert.strictEqual(receptionCalls, 0);
      for (const receipt of [goat, mcp, slack]) {
        const stored = (yield* ledger.getInput(receipt.inputId))!;
        assert.strictEqual(stored.snapshot.state, "replied");
        assert.strictEqual(stored.snapshot.failure?.message, CHANNEL_COPY.botMoved);
        assert.isDefined(stored.snapshot.readAt);
      }
      const messages = (yield* botMessages).messages.filter(
        (message) => message.channel?.inReplyToInputId === goat.inputId,
      );
      assert.strictEqual(messages.length, 1);
      assert.strictEqual(messages[0]?.channel?.kind, "failure");
      assert.strictEqual(messages[0]?.text, CHANNEL_COPY.botMoved);
      const slackFailures = resultsTo(harness.slackSent, "failure");
      assert.strictEqual(slackFailures.length, 1);
      assert.strictEqual(slackFailures[0]?.message.inReplyToInputId, slack.inputId);
      yield* runtime.drain;
      assert.strictEqual(resultsTo(harness.slackSent, "failure").length, 1);
      assert.deepStrictEqual((yield* ledger.listTasks({ ownerId, limit: 10 })).tasks, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("lets reception and worker reports finish after home moves", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      harness.script.current = (input) =>
        input.mode === "input"
          ? Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(defaultScript(input)),
            )
          : defaultScript(input);
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const settings = yield* ServerSettings.ServerSettingsService;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const receipt = yield* gateway.ingest(
        goatInput("do: already started", "started-home"),
        rpcContext,
      );
      const draining = yield* runtime.drain.pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* settings.updateSettings({ goatBotHome: homeClaim(otherHomeId) });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(draining);
      const task = yield* onlyTask;
      assert.strictEqual((yield* gateway.getInput(receipt.inputId, rpcContext)).state, "replied");
      yield* reports.report(
        {
          taskId: task.taskId,
          eventId: ChannelTaskEventId.make("report-after-home-move"),
          generation: task.generation,
          status: "completed",
          summary: "Finished on the original machine.",
        },
        task.worker!.threadId,
      );
      yield* runtime.drain;
      assert.isDefined((yield* onlyTask).proposedCompletion);
      harness.world.setStatus(
        task.worker!.threadId,
        1,
        "completed",
        "Finished on the original machine.",
      );
      yield* runtime.drain;
      assert.strictEqual((yield* onlyTask).status, "completed");
      assert.strictEqual((yield* latestCard)?.summary, "Finished on the original machine.");
    }).pipe(Effect.provide(harness.layer));
  });
});
