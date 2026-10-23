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
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
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

const runEnd = (lane: string, host: string | null) => {
  const watch = newLaunchWatch({
    launcherThreadId: supervisor,
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
      expect(pressure!.text).toBe("Resource pressure: box-a is critical.");
      expect(last!.text).toBe(later.text);
    }).pipe(Effect.provide(layer)),
);
