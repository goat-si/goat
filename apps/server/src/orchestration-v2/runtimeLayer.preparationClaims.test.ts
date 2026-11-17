import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId } from "@goat/contracts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import { makeProviderFailure } from "@goat/provider-core/server/failure";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectEnrichment from "../project/ProjectEnrichmentService.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { CommitGuard } from "./goat/CommitGuard.ts";
import { makeOrphanProbe, orphanRun, runStatus } from "./goat/PreparationOrphans.testkit.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import {
  layerCheckpointStoreTest,
  layerGitWorkflowTest,
  layerPlatformTest,
  layerServerConfig,
  layerTestProviderInstanceRegistry,
  seedProject,
} from "./runtimeLayer.testkit.ts";
import { modelSelection, projectId } from "./testkit/threadLaunchInput.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

type Probe = Effect.Success<typeof makeOrphanProbe>;

// The server's own composition of the launch service, its claims and the check, the check stepped;
// mocks only for what an orphaned root run never reaches.
const layerServer = (probe: Probe) =>
  Layer.mergeAll(
    RuntimeLayer.layer.pipe(Layer.provide(RuntimeLayer.layerProjectService)),
    RuntimeLayer.layerPreparation(probe.layer),
  ).pipe(
    Layer.provideMerge(ProjectStore.layer),
    Layer.provide(
      Layer.mergeAll(
        WorktreeSetupTracker.layer,
        ProviderRegistryMock.layer(),
        Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
        Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({}),
        Layer.mock(TerminalManager.TerminalManager)({}),
        Layer.mock(TextGeneration.TextGeneration)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(WorkspacePaths.WorkspacePaths)({}),
      ),
    ),
    Layer.provide(McpSessionRegistryTestkit.layer),
    Layer.provide(McpProviderSessions.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(layerCheckpointStoreTest),
    Layer.provide(layerServerConfig),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(layerTestProviderInstanceRegistry),
    Layer.provide(layerGitWorkflowTest),
    Layer.provide(layerPlatformTest),
    Layer.provideMerge(NodeServices.layer),
  );

const seed = seedProject({
  projectId,
  title: "Project",
  workspaceRoot: "/repo",
  defaultModelSelection: modelSelection,
  createdAt: "2026-06-20T00:00:00.000Z",
});

it.effect(
  "on the server's wiring, the launch service's pending mark waits for the lock a dispatch on its thread commits under",
  () =>
    Effect.gen(function* () {
      const probe = yield* makeOrphanProbe;
      yield* Effect.gen(function* () {
        yield* seed;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const { threadId, runId } = yield* orphanRun("server-lock");
        const inCommit = yield* Deferred.make<void>();
        const letGo = yield* Deferred.make<void>();
        const order = yield* Ref.make<ReadonlyArray<string>>([]);
        const dispatching = yield* threads
          .dispatch({
            type: "prepared-run.fail",
            commandId: CommandId.make("command:server-lock:fail"),
            threadId,
            runId,
            failure: makeProviderFailure({ message: "Held inside its commit." }),
          })
          .pipe(
            Effect.provideService(
              CommitGuard,
              () => () =>
                Deferred.succeed(inCommit, undefined).pipe(Effect.andThen(Deferred.await(letGo))),
            ),
            Effect.forkChild({ startImmediately: true }),
          );
        yield* Deferred.await(inCommit);
        const marking = yield* Effect.scoped(
          launches
            .preparationPending(threadId)
            .pipe(Effect.andThen(Ref.update(order, (entries) => [...entries, "mark recorded"]))),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Ref.update(order, (entries) => [...entries, "commit released"]);
        yield* Deferred.succeed(letGo, undefined);
        yield* Fiber.join(dispatching);
        yield* Fiber.join(marking);
        assert.deepEqual(yield* Ref.get(order), ["commit released", "mark recorded"]);
      }).pipe(Effect.provide(layerServer(probe)));
    }),
);

it.effect(
  "on the server's wiring, the check leaves a run alone while the launch service's mark is held, and fails it after",
  () =>
    Effect.gen(function* () {
      const probe = yield* makeOrphanProbe;
      yield* Effect.gen(function* () {
        yield* seed;
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const { threadId, runId } = yield* orphanRun("server-claims");
        const marked = yield* Scope.make();
        yield* launches.preparationPending(threadId).pipe(Scope.provide(marked));
        for (let pass = 1; pass <= 5; pass++) assert.equal(yield* probe.pass, "read");
        assert.equal(yield* runStatus(threadId, runId), "preparing");
        assert.equal(yield* probe.failCount, 0);

        yield* Scope.close(marked, Exit.void);
        for (let pass = 1; pass <= 3; pass++) assert.equal(yield* probe.pass, "read");
        assert.equal(yield* probe.pass, "read");
        assert.equal(yield* probe.failed, runId);
        assert.equal(yield* runStatus(threadId, runId), "failed");
      }).pipe(Effect.provide(layerServer(probe)));
    }),
);
