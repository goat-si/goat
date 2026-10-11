import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type ChannelIngestInput,
  type ChannelOutboundMessage,
  type ChannelReceptionInput,
  type ChannelReceptionResult,
  ChannelGatewayError,
  CommandId,
  EnvironmentId,
  MessageId,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TextGenerationError,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../orchestration-v2/ThreadMessageIntake.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import type { ChannelConnectionOwner } from "./ChannelIngressContext.ts";
import * as ChannelIdentityService from "./ChannelIdentityService.ts";
import * as ChannelLayers from "./ChannelLayers.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelTransport from "./ChannelTransport.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import { CHANNEL_COPY } from "./channelCopy.ts";
import { workerLaunchIdsFor } from "./channelIds.ts";
import { channelOwnerIdFor } from "./channelOwner.ts";

/**
 * D10 scenarios 1-6 for the core: the GOAT bot thread is a real orchestrator thread (whose
 * provider adapter refuses to run anything), worker threads are scripted, and the reception
 * model and Slack transport are fakes the tests control.
 */

const environmentId = EnvironmentId.make("environment:channel-test");
const ownerId = channelOwnerIdFor(environmentId);
const owner: ChannelConnectionOwner = {
  ownerId,
  principalId: "owner",
  displayName: "Owner",
  grantedScopes: ["orchestration:read", "orchestration:operate", "settings:write"],
  runtimeModeCeiling: "full-access",
};
const projectId = ProjectId.make("project:channel-work");
const scratchProjectId = ProjectId.make("project:scratch");
const botThreadId = ThreadId.make("thread:goat-bot");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-sol",
} as const;

const refusingAdapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("the GOAT bot must never start a provider session"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

/** Scripted worker threads: their runs, final assistant text, and background work. */
class WorkerWorld {
  readonly runs = new Map<string, Array<OrchestrationV2Run>>();
  readonly finalText = new Map<string, string>();
  readonly background = new Set<string>();
  readonly launches: Array<ThreadLaunch.ThreadLaunchInput> = [];
  readonly sends: Array<ThreadManagement.ThreadManagementSendInput> = [];

  addRun(threadId: ThreadId, userMessageId: MessageId) {
    const existing = this.runs.get(threadId) ?? [];
    const run = {
      id: RunId.make("run:" + threadId + ":" + (existing.length + 1)),
      threadId,
      ordinal: existing.length + 1,
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId,
      rootNodeId: null,
      activeAttemptId: null,
      status: "running",
      requestedAt: DateTime.makeUnsafe("2026-10-12T00:00:00.000Z"),
      startedAt: null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    } as unknown as OrchestrationV2Run;
    this.runs.set(threadId, [...existing, run]);
    return run;
  }

  setStatus(
    threadId: ThreadId,
    ordinal: number,
    status: OrchestrationV2Run["status"],
    text?: string,
  ) {
    const runs = this.runs.get(threadId) ?? [];
    this.runs.set(
      threadId,
      runs.map((run) =>
        run.ordinal === ordinal ? ({ ...run, status } as OrchestrationV2Run) : run,
      ),
    );
    const run = runs.find((candidate) => candidate.ordinal === ordinal);
    if (run !== undefined && text !== undefined) this.finalText.set(run.id, text);
  }

  latestRun(threadId: ThreadId) {
    return (this.runs.get(threadId) ?? []).at(-1);
  }
}

type ReceptionScript = (
  input: ChannelReceptionInput,
) => Effect.Effect<ChannelReceptionResult, TextGenerationError>;

const defaultScript: ReceptionScript = (input) => {
  const text = input.inputText ?? "";
  if (input.mode === "task_event") {
    return Effect.succeed({
      replyText: input.taskEvent?.summary ?? "",
      action: { type: "report_only" },
    });
  }
  if (text.startsWith("do:")) {
    return Effect.succeed({
      replyText: "On it.",
      action: {
        type: "create_task",
        title: text.slice(3).trim(),
        instruction: text.slice(3).trim(),
      },
    });
  }
  return Effect.succeed({ replyText: "Okay.", action: { type: "report_only" } });
};

interface SlackSend {
  readonly message: ChannelOutboundMessage;
}

function makeHarness(options: { readonly projects?: number } = {}) {
  const world = new WorkerWorld();
  const slackSent: Array<SlackSend> = [];
  const slackFailures: Array<ChannelGatewayError> = [];
  const script = { current: defaultScript };

  const layerDatabase = SqlitePersistence.layerMemory;
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "channel-scenarios" },
    ProviderAdapterRegistry.layerFromAdapters([refusingAdapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerRealThreads = ThreadManagement.layer.pipe(Layer.provide(layerOrchestrator));
  const isWorker = (threadId: ThreadId) => world.runs.has(threadId);

  const layerThreads = Layer.effect(
    ThreadManagement.ThreadManagementService,
    Effect.gen(function* () {
      const real = yield* ThreadManagement.ThreadManagementService;
      return ThreadManagement.ThreadManagementService.of({
        ...real,
        getThreadRecords: ((threadId: ThreadId, fields: never, filter: never) => {
          if (!isWorker(threadId)) return real.getThreadRecords(threadId, fields, filter);
          const runs = world.runs.get(threadId) ?? [];
          const messageRunIds = (
            filter as { readonly messageRunIds?: ReadonlyArray<string> } | undefined
          )?.messageRunIds;
          return Effect.succeed({
            thread: { id: threadId, projectId, archivedAt: null, deletedAt: null },
            runs,
            providerThreads: world.background.has(threadId)
              ? [{ pendingBackgroundTasks: [{ taskId: "background" }] }]
              : [],
            messages: runs
              .filter((run) => messageRunIds === undefined || messageRunIds.includes(run.id))
              .flatMap((run) => {
                const text = world.finalText.get(run.id);
                return text === undefined
                  ? []
                  : [{ role: "assistant", text, streaming: false, runId: run.id }];
              }),
          } as never);
        }) as typeof real.getThreadRecords,
        sendToThread: (input) => {
          if (!isWorker(input.threadId)) return real.sendToThread(input);
          world.sends.push(input);
          if (
            !(world.runs.get(input.threadId) ?? []).some(
              (run) => run.userMessageId === input.messageId,
            )
          ) {
            world.addRun(input.threadId, input.messageId);
          }
          return Effect.succeed({} as never);
        },
        delegatedTaskResultPending: () => Effect.succeed(false),
      });
    }),
  ).pipe(Layer.provide(layerRealThreads));

  const layerLaunch = Layer.mock(ThreadLaunch.ThreadLaunchService)({
    launch: (input) =>
      Effect.sync(() => {
        world.launches.push(input);
        const threadId = input.threadId ?? ThreadId.make("thread:worker:" + input.commandId);
        // Same command, same thread and run: a retried launch finds what the first one made.
        if (!world.runs.has(threadId) && input.initialMessage?.messageId !== undefined) {
          world.addRun(threadId, input.initialMessage.messageId);
        }
        return {
          threadId,
          projection: { runs: world.runs.get(threadId) ?? [] },
          resumed: false,
        } as never;
      }),
  });

  const shells = Array.from({ length: options.projects ?? 1 }, (_, index) => ({
    id: index === 0 ? projectId : ProjectId.make("project:channel-work-" + index),
    title: index === 0 ? "Channel work" : "Other work " + index,
    workspaceRoot: "/nonexistent/channel-work-" + index,
    defaultModelSelection: modelSelection,
    scripts: [],
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
  }));

  const layerExternal = Layer.mergeAll(
    Layer.mock(TextGeneration.TextGeneration)({
      generateChannelReception: (input) => script.current(input.input),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      listShells: () => Effect.succeed(shells as never),
    }),
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      getInstance: () => Effect.succeed({} as never),
    }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(environmentId),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/unused",
      ensureScratchProject: Effect.succeed({ projectId: scratchProjectId }),
    }),
    ServerSettings.layerTest({
      textGenerationModelSelection: modelSelection,
      defaultRuntimeMode: "full-access",
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-channel-scenarios-" })),
    Layer.provideMerge(NodeServices.layer),
  );

  const layerChannels = ChannelLayers.layerServices.pipe(
    Layer.provide(
      Layer.mergeAll(layerThreads, layerLaunch, layerExternal, layerDatabase, IdAllocator.layer),
    ),
  );

  const layerSlack = Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* ChannelTransport.ChannelTransportRegistry;
      yield* registry.register({
        kind: "slack",
        send: (message) => {
          const failure = slackFailures.shift();
          if (failure !== undefined) return Effect.fail(failure);
          slackSent.push({ message });
          return Effect.succeed({
            deliveryId: message.deliveryId,
            acceptedAt: "2026-10-12T00:00:01.000Z",
          });
        },
      });
    }),
  );

  const layer = layerSlack.pipe(
    Layer.provideMerge(layerChannels),
    Layer.provideMerge(layerThreads),
    Layer.provideMerge(layerOrchestrator),
    Layer.provideMerge(layerExternal),
  );
  return { layer, world, slackSent, slackFailures, script };
}

const setupBot = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const ledger = yield* ChannelLedger.ChannelLedger;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-goat-bot"),
    threadId: botThreadId,
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
  yield* ledger.setBotIfAbsent({
    ownerId,
    bot: { environmentId, projectId: scratchProjectId, threadId: botThreadId },
    now: "2026-10-12T00:00:00.000Z",
  });
});

const goatInput = (text: string, key: string): ChannelIngestInput => ({
  kind: "goat",
  connectionId: "goat",
  conversationKey: botThreadId,
  externalMessageId: key,
  idempotencyKey: key,
  actor: {},
  replyAddress: { kind: "goat", environmentId, threadId: botThreadId },
  text,
  attachments: [],
  receivedAt: "2026-10-12T00:00:00.000Z",
  intent: "message",
});

const slackInput = (
  text: string,
  key: string,
  rootTs = "1760000000.000100",
  user = "U1",
): ChannelIngestInput => ({
  kind: "slack",
  connectionId: "slack-1",
  conversationKey: "T1:C1:" + rootTs,
  externalMessageId: key,
  idempotencyKey: "T1:" + key,
  actor: { externalActorId: user, displayName: "Slack user" },
  replyAddress: { kind: "slack", connectionId: "slack-1", teamId: "T1", channelId: "C1", rootTs },
  text,
  attachments: [],
  receivedAt: "2026-10-12T00:00:00.000Z",
  intent: "message",
});

const rpcContext = { ...owner, caller: { type: "rpc" as const } };
const slackContext = {
  ...owner,
  caller: { type: "transport" as const, kind: "slack" as const, connectionId: "slack-1" },
};

/** Links Slack user U1 the way a person would: a code from GOAT, sent to the bot. */
const linkSlackUser = (user = "U1") =>
  Effect.gen(function* () {
    const identities = yield* ChannelIdentityService.ChannelIdentityService;
    const gateway = yield* ChannelGateway.ChannelGateway;
    const { code } = yield* identities.createLink(
      { connectionId: "slack-1", runtimeModeCeiling: "auto-accept-edits" },
      owner,
    );
    yield* gateway.linkIdentity(
      {
        connectionId: "slack-1",
        externalActorId: user,
        code,
        idempotencyKey: "link-" + user,
        replyAddress: {
          kind: "slack",
          connectionId: "slack-1",
          teamId: "T1",
          channelId: "D1",
          rootTs: "1",
        },
      },
      slackContext,
    );
  });

const botMessages = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const records = yield* threads.getThreadRecords(botThreadId, ["messages", "runs", "turnItems"]);
  return records;
});

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
const onlyTask = Effect.gen(function* () {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const page = yield* ledger.listTasks({ ownerId, limit: 10 });
  assert.strictEqual(page.tasks.length, 1);
  return page.tasks[0]!;
});

const resultsTo = (sent: ReadonlyArray<SlackSend>, kind: ChannelOutboundMessage["kind"]) =>
  sent.filter((send) => send.message.kind === kind);

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
