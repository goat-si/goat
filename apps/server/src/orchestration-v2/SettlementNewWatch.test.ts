import { assert, it } from "@effect/vitest";
import { CommandId, EventId, MessageId, ProjectId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Orchestrator from "./Orchestrator.ts";
import * as EventSink from "./EventSink.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import {
  layerPlatformTest,
  layerServerConfig,
  modelSelection,
  layerCheckpointStoreTest,
  layerGitWorkflowTest,
  layerProjectServiceTest,
  layerTestProviderInstanceRegistry,
} from "./runtimeLayer.testkit.ts";

const layerTest = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ProjectStore.layer,
  ProjectionStore.layer,
  EffectOutbox.layer,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerProjectServiceTest),
  Layer.provide(layerPlatformTest),
);
it.layer(layerTest)("settle and new watch", (it) => {
  it.effect("keeps a pull request watch its agent started after asking to settle", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const projectId = ProjectId.make("runtime-layer-settle-then-watch-project");
      const threadId = ThreadId.make("runtime-layer-settle-then-watch-thread");

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-settle-then-watch-create"),
        threadId,
        projectId,
        title: "Settle then watch",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/runtime-layer-settle-then-watch",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-settle-then-watch-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-settle-then-watch-message"),
        text: "Settle this thread, then watch the pull request.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0];
      if (run === undefined) return yield* Effect.die(new Error("Run missing."));

      // The deferred settle `settleThread` forks for its own agent's active run.
      const settleRequest = yield* threadManagement
        .settleAfterRun({ projectId, threadId, runId: run.id })
        .pipe(Effect.forkChild);
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("runtime-layer-settle-then-watch-watch"),
        threadId,
        host: "github.com",
        repository: "goat-si/goat",
        number: 7,
        watching: true,
        link: { url: "https://github.com/goat-si/goat/pull/7", source: "agent" },
      });
      assert.isDefined((yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch);

      const now = yield* DateTime.now;
      yield* eventSink.write({
        commandId: CommandId.make("runtime-layer-settle-then-watch-completed"),
        events: [
          {
            id: EventId.make("runtime-layer-settle-then-watch-completed"),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "completed", startedAt: now, completedAt: now },
          },
        ],
      });
      yield* Fiber.join(settleRequest);

      const shell = yield* orchestrator.getThreadShell(threadId);
      assert.isDefined(shell?.pullRequests?.[0]?.watch);
      assert.isNull(shell?.settledOverride ?? null);
    }),
  );
});
