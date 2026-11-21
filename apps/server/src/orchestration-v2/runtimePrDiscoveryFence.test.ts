import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import {
  layerCheckpointStoreTest,
  layerServerConfig,
  layerTestProviderInstanceRegistry,
  layerGitWorkflowTest,
  layerProjectServiceTest,
  layerPlatformTest,
  modelSelection,
  seedProject,
} from "./runtimeLayer.testkit.ts";

const layerTest = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  EventStore.layer,
  ProjectStore.layer,
  ProjectionStore.layer,
  EffectOutbox.layer,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provideMerge(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerProjectServiceTest),
  Layer.provide(layerPlatformTest),
);
it.layer(layerTest)("PR discovery fence", (it) => {
  it.effect("accepts branch discovery after unrelated events while fencing replacements", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("discovery-fence-project");
      const threadId = ThreadId.make("discovery-fence-thread");
      yield* seedProject({
        projectId,
        title: "PR discovery",
        workspaceRoot: "/workspace/discovery",
        defaultModelSelection: null,
        createdAt: "2026-09-17T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("discovery-create"),
        threadId,
        projectId,
        title: "Discovery",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "feature",
        worktreePath: null,
      });
      const snapshot = yield* orchestrator.getShellSnapshot();
      yield* orchestrator.dispatch({
        type: "thread.visit",
        commandId: CommandId.make("discovery-visit"),
        threadId,
        visitedAt: "2026-09-17T00:01:00.000Z",
      });
      const pullRequest = {
        projectId,
        repository: "owner/repository",
        number: 24,
        url: "https://github.com/owner/repository/pull/24",
      };
      const expected = {
        workspaceRoot: "/workspace/discovery",
        branch: "feature",
        worktreePath: null,
        linkedPullRequest: null,
        branchPullRequest: null,
      };
      yield* orchestrator.dispatch({
        type: "thread.pull-request.sync",
        commandId: CommandId.make("discovery-sync"),
        threadId,
        projectId,
        snapshotSequence: snapshot.snapshotSequence,
        expected,
        branchPullRequest: pullRequest,
      });
      assert.deepEqual(
        (yield* orchestrator.getThreadProjection(threadId)).thread.branchPullRequest,
        pullRequest,
      );
      const replacement = yield* orchestrator
        .dispatch({
          type: "thread.pull-request.sync",
          commandId: CommandId.make("discovery-replacement"),
          threadId,
          projectId,
          snapshotSequence: snapshot.snapshotSequence,
          expected: { ...expected, branchPullRequest: pullRequest },
          branchPullRequest: pullRequest,
          linkedPullRequest: pullRequest,
        })
        .pipe(Effect.flip);
      assert.instanceOf(replacement, Orchestrator.OrchestratorDispatchError);
    }),
  );
});
