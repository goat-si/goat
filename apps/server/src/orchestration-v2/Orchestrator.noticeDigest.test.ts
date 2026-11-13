import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  type OrchestrationV2Notification,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { resolveSessionRun } from "../channels/channelBotSessionRuns.ts";
import { HOST_PRESSURE_MESSAGE_PREFIX } from "../fleet/pressure/pressureModel.ts";
import { finishedWake, newLaunchWatch } from "../mcp/launchWatch.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process: the active run only has to block"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const databaseLayer = SqlitePersistence.layerMemory;
const layer = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provide(databaseLayer)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "notice-digest" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer, runEffectWorker: false },
  ),
);

const supervisor = ThreadId.make("thread:supervisor");

const runEnd = (
  lane: string,
  host: string | null,
  launcherThreadId = supervisor,
  launcherRunId?: RunId,
) => {
  const watch = newLaunchWatch({
    launcherThreadId,
    ...(launcherRunId === undefined ? {} : { launcherRunId }),
    host,
    threadId: ThreadId.make(`thread:${lane}`),
    projectId: null,
    title: lane,
    incarnation: "test",
    notifyWebhook: false,
    now: 0,
  });
  const wake = finishedWake({
    watch,
    runId: RunId.make(`run:${lane}`),
    status: "completed",
    title: lane,
    branch: null,
    worktreePath: null,
    excerpt: `${lane} is done.`,
  });
  return { ...wake, messageId: wake.messageId };
};

const notice = (input: {
  readonly commandId: string;
  readonly messageId: string;
  readonly text: string;
  readonly notification: OrchestrationV2Notification;
}) => ({
  type: "message.dispatch" as const,
  commandId: CommandId.make(input.commandId),
  threadId: supervisor,
  messageId: MessageId.make(input.messageId),
  text: input.text,
  attachments: [],
  notification: input.notification,
  dispatchMode: { type: "queue_after_active" as const },
  createdBy: "agent" as const,
  creationSource: "server" as const,
});

it.effect(
  "notices that arrive during a turn wait as one turn, and a user message keeps its place",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId: supervisor,
        projectId: ProjectId.make("project:notice-digest"),
        title: "Supervisor",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("work"),
        threadId: supervisor,
        messageId: MessageId.make("message:work"),
        text: "Launch the lanes.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const laneA = runEnd("lane-a", "box-a");
      const laneB = runEnd("lane-b", null);
      for (const wake of [laneA, laneB])
        yield* orchestrator.dispatch(
          notice({
            commandId: wake.commandId,
            messageId: wake.messageId,
            text: wake.text,
            notification: wake.notification,
          }),
        );
      for (const level of ["elevated", "critical"])
        yield* orchestrator.dispatch(
          notice({
            commandId: `server:pressure:${level}`,
            messageId: `${HOST_PRESSURE_MESSAGE_PREFIX}box-a:wake:${level}`,
            text: `Resource pressure: box-a is ${level}.`,
            notification: {
              source: { kind: "monitor" },
              outcome: "updated",
              summary: `box-a is under ${level} resource pressure`,
            },
          }),
        );
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("user-follow-up"),
        threadId: supervisor,
        messageId: MessageId.make("message:user-follow-up"),
        text: "Then summarise.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      const later = runEnd("lane-c", "box-b");
      yield* orchestrator.dispatch(
        notice({
          commandId: later.commandId,
          messageId: later.messageId,
          text: later.text,
          notification: later.notification,
        }),
      );

      const projection = yield* store.getThreadProjection(supervisor);
      const queued = queuedRunsInDeliveryOrder(projection).map((run) =>
        projection.messages.find((message) => message.id === run.userMessageId)!,
      );
      // Run ends share one turn; pressure follows the current model, so it waits apart, and its
      // newer level replaces the older. The user message and the notice after it keep their places.
      expect(queued.map((message) => message.id)).toEqual([
        laneA.messageId,
        `${HOST_PRESSURE_MESSAGE_PREFIX}box-a:wake:elevated`,
        "message:user-follow-up",
        later.messageId,
      ]);
      const [runEnds, pressure, , last] = queued;
      expect(runEnds!.text).toContain('<notices count="2">');
      expect(runEnds!.text).toContain("lane-a is done.");
      expect(runEnds!.text).toContain("lane-b is done.");
      expect(runEnds!.notification?.source.kind).toBe("background_task");
      expect(runEnds!.notification?.summary).toMatch(/^2 notices · /);
      // The newer level stays in its own block: the turn's message id still names the older one.
      expect(pressure!.text).toContain("Resource pressure: box-a is critical.");
      expect(pressure!.text).not.toContain("elevated");
      expect(last!.text).toBe(later.text);
    }).pipe(Effect.provide(layer)),
);
it.effect("command notices each wait as their own turn and keep the run they report on", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId: supervisor,
      projectId: ProjectId.make("project:notice-digest"),
      title: "Supervisor",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("work"),
      threadId: supervisor,
      messageId: MessageId.make("message:work"),
      text: "Run the commands in the background.",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const commandEnd = (key: string, run: string) =>
      notice({
        commandId: "command-" + key,
        messageId: "message:command-" + key,
        text: "Command " + key + " ended.",
        notification: {
          source: { kind: "command" },
          outcome: "completed",
          summary: "Command " + key + " ended",
          aboutRunId: RunId.make(run),
        },
      });
    yield* orchestrator.dispatch(commandEnd("a1", "run:logistics"));
    yield* orchestrator.dispatch(commandEnd("a2", "run:logistics"));
    yield* orchestrator.dispatch(commandEnd("b", "run:question-a"));

    const projection = yield* store.getThreadProjection(supervisor);
    const queued = queuedRunsInDeliveryOrder(projection).map((run) =>
      projection.messages.find((message) => message.id === run.userMessageId)!,
    );
    expect(queued.map((message) => message.id)).toEqual([
      "message:command-a1",
      "message:command-a2",
      "message:command-b",
    ]);
    expect(queued.map((message) => message.notification?.aboutRunId)).toEqual([
      "run:logistics",
      "run:logistics",
      "run:question-a",
    ]);
  }).pipe(Effect.provide(layer)),
);
it.effect("a stored command notice belongs to the task whose run started the command", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId: supervisor,
      projectId: ProjectId.make("project:notice-digest"),
      title: "Supervisor",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("logistics"),
      threadId: supervisor,
      messageId: MessageId.make("message:logistics"),
      text: "Plan the logistics.",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const started = (yield* store.getThreadProjection(supervisor)).runs[0]!;
    yield* sql`INSERT INTO channel_bot_session_runs
      (thread_id, message_id, task_id, task_generation, kind, created_at)
      VALUES (${supervisor}, 'message:logistics', 'task:logistics', 1, 'task', '1970-01-01T00:00:00.000Z')`;
    yield* orchestrator.dispatch(
      notice({
        commandId: "command-ended",
        messageId: "message:command-ended",
        text: "Command ended.",
        notification: {
          source: { kind: "command" },
          outcome: "completed",
          summary: "Command ended",
          aboutRunId: started.id,
        },
      }),
    );
    const projection = yield* store.getThreadProjection(supervisor);
    const noticeRun = projection.runs.find((run) => run.userMessageId === "message:command-ended")!;
    const owner = yield* resolveSessionRun(sql, supervisor, projection, noticeRun.id);
    expect(owner?.task_id).toBe("task:logistics");
  }).pipe(Effect.provide(Layer.merge(layer, databaseLayer))),
);

/** A supervisor thread whose first turn runs, so every later message queues behind it. */
const heldSupervisor = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-stamped"),
    threadId: supervisor,
    projectId: ProjectId.make("project:notice-digest"),
    title: "Supervisor",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("work-stamped"),
    threadId: supervisor,
    messageId: MessageId.make("message:work-stamped"),
    text: "Work",
    attachments: [],
    modelSelection,
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  return orchestrator;
});

const queuedIds = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const projection = yield* store.getThreadProjection(supervisor);
  return queuedRunsInDeliveryOrder(projection).map((run) =>
    projection.messages.find((message) => message.id === run.userMessageId)!,
  );
});

const stampedLauncher = ThreadId.make("goat-bot-session:test");

it.effect(
  "regression: a launching run's later wake queues behind a user message queued after its earlier wake",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* heldSupervisor;
      const first = runEnd("stamped-a1", null, stampedLauncher, RunId.make("run:owner-a"));
      const later = runEnd("stamped-a2", null, stampedLauncher, RunId.make("run:owner-a"));
      yield* orchestrator.dispatch(notice(first));
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("between"),
        threadId: supervisor,
        messageId: MessageId.make("message:between"),
        text: "Stop that work.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch(notice(later));
      const queued = yield* queuedIds;
      expect(queued.map((message) => message.id)).toEqual([
        first.messageId,
        "message:between",
        later.messageId,
      ]);
      expect(queued[0]!.text).not.toContain(later.messageId);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "contract: another notice kind queued between two wakes of one launching run is no barrier to folding",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* heldSupervisor;
      const first = runEnd("stamped-a1", null, stampedLauncher, RunId.make("run:owner-a"));
      const later = runEnd("stamped-a2", null, stampedLauncher, RunId.make("run:owner-a"));
      const pressure = HOST_PRESSURE_MESSAGE_PREFIX + "box-a:wake:elevated";
      yield* orchestrator.dispatch(notice(first));
      yield* orchestrator.dispatch(
        notice({
          commandId: "server:pressure:between",
          messageId: pressure,
          text: "Resource pressure: box-a is elevated.",
          notification: {
            source: { kind: "monitor" },
            outcome: "updated",
            summary: "box-a is under elevated resource pressure",
          },
        }),
      );
      yield* orchestrator.dispatch(notice(later));
      const queued = yield* queuedIds;
      expect(queued.map((message) => message.id)).toEqual([first.messageId, pressure]);
      expect(queued[0]!.text).toContain(later.messageId);
    }).pipe(Effect.provide(layer)),
);
