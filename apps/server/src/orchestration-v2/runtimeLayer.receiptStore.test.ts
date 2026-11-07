import { vi } from "vite-plus/test";
import { ProjectId, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import { CommandId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "goat-runtime-layer-receipt-store-",
});

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

// The smallest honest stack: the real SQL-backed stores and config, mocks only where the
// probe never reaches.
const layerTest = RuntimeLayer.layer.pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(
    CheckpointStore.layer.pipe(
      Layer.provide(
        VcsDriverRegistry.layer.pipe(
          Layer.provide(VcsProcess.layer),
          Layer.provide(layerServerConfig),
          Layer.provide(layerPlatformTest),
        ),
      ),
    ),
  ),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: () => Effect.succeed(undefined),
      listInstances: Effect.succeed([]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(GitWorkflow.GitWorkflowService)({
      pruneWorktrees: () => Effect.void,
      createWorktree: () => Effect.succeed({} as never),
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectService.ProjectService)({
      getById: () => Effect.succeed(Option.none()),
    }),
  ),
  Layer.provide(layerPlatformTest),
);

it.effect(
  "the exported runtime layer exposes the command receipt store to per-call resolution",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const buildScope = yield* Effect.scope;
        const context = yield* Layer.buildWithScope(layerTest, buildScope);
        // MCP services resolve the store per call from the ambient server context; a
        // provide-only wiring answers None here and silently disables commit certainty.
        const found = yield* Effect.serviceOption(CommandReceiptStore.CommandReceiptStoreV2).pipe(
          Effect.provide(context),
        );
        assert.isTrue(Option.isSome(found));
        if (Option.isNone(found)) return;
        const receipt = yield* found.value
          .getByCommandId(CommandId.make("cmd-never-ran"))
          .pipe(Effect.provide(context));
        assert.isTrue(Option.isNone(receipt));
      }),
    ),
);

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
// Holds model-selection planning until both racing commands have read no receipt.
let raceCapabilityGate: Effect.Effect<void> | undefined;
const raceAdapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () =>
    (raceCapabilityGate ?? Effect.void).pipe(Effect.as(CodexProviderCapabilitiesV2)),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata controls"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const raceLayerDatabase = SqlitePersistence.layerMemory;
const raceLayerTest = Layer.mergeAll(
  raceLayerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(raceLayerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "receipt-race" },
    ProviderAdapterRegistry.layerFromAdapters([raceAdapter]),
    { databaseLayer: raceLayerDatabase, runEffectWorker: false },
  ),
);

it.effect("a command id reused concurrently for two threads succeeds for only one", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadIds = [ThreadId.make("thread:race-a"), ThreadId.make("thread:race-b")];
    for (const threadId of threadIds) {
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId: ProjectId.make("project:receipt-race"),
        title: threadId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
    }

    const arrived = yield* Ref.make(0);
    const bothArrived = yield* Deferred.make<void>();
    raceCapabilityGate = Effect.gen(function* () {
      if ((yield* Ref.updateAndGet(arrived, (count) => count + 1)) === 2) {
        yield* Deferred.succeed(bothArrived, undefined);
      }
      yield* Deferred.await(bothArrived);
    });
    const setModel = (threadId: ThreadId) =>
      orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("command:shared"),
        threadId,
        modelSelection: { ...modelSelection, model: "gpt-6" },
      });
    const exits = yield* Effect.forEach(threadIds, (threadId) => Effect.exit(setModel(threadId)), {
      concurrency: "unbounded",
    }).pipe(Effect.ensuring(Effect.sync(() => (raceCapabilityGate = undefined))));

    const winner = exits.findIndex(Exit.isSuccess);
    const loser = exits.findIndex(Exit.isFailure);
    assert.isAtLeast(winner, 0);
    assert.isAtLeast(loser, 0);
    const winnerExit = exits[winner]!;
    const loserExit = exits[loser]!;
    assert.isTrue(Exit.isSuccess(winnerExit) && Exit.isFailure(loserExit));
    if (Exit.isFailure(loserExit)) {
      const error = Cause.findErrorOption(loserExit.cause);
      assert.isTrue(error._tag === "Some");
      if (error._tag === "Some") {
        assert.equal(error.value._tag, "OrchestratorCommandIdConflictError");
        if (error.value._tag === "OrchestratorCommandIdConflictError") {
          assert.equal(error.value.receiptThreadId, threadIds[winner]);
          assert.equal(error.value.commandThreadId, threadIds[loser]);
        }
      }
    }

    const models = yield* Effect.forEach(threadIds, (threadId) =>
      projections.getThreadShell(threadId).pipe(Effect.map((shell) => shell?.modelSelection.model)),
    );
    assert.equal(models[winner], "gpt-6");
    assert.equal(models[loser], "gpt-5.1-codex");

    const noOpArrived = yield* Ref.make(0);
    const bothNoOpsArrived = yield* Deferred.make<void>();
    const getThreadRecords = projections.getThreadRecords;
    using _records = vi.spyOn(projections, "getThreadRecords").mockImplementation((...args) =>
      Effect.gen(function* () {
        if ((yield* Ref.updateAndGet(noOpArrived, (count) => count + 1)) === 2) {
          yield* Deferred.succeed(bothNoOpsArrived, undefined);
        }
        yield* Deferred.await(bothNoOpsArrived);
        return yield* getThreadRecords(...args);
      }),
    );
    const closeShare = (threadId: ThreadId) =>
      orchestrator.dispatch({
        type: "thread.guest-share.close",
        commandId: CommandId.make("command:shared-noop"),
        threadId,
      });
    const noOpExits = yield* Effect.forEach(
      threadIds,
      (threadId) => Effect.exit(closeShare(threadId)),
      {
        concurrency: "unbounded",
      },
    );
    const noOpWinner = noOpExits.findIndex(Exit.isSuccess);
    const noOpLoser = noOpExits.findIndex(Exit.isFailure);
    assert.isAtLeast(noOpWinner, 0);
    assert.isAtLeast(noOpLoser, 0);
    const noOpFailure = noOpExits[noOpLoser]!;
    if (Exit.isFailure(noOpFailure)) {
      const error = Cause.findErrorOption(noOpFailure.cause);
      assert.isTrue(error._tag === "Some");
      if (error._tag === "Some") {
        assert.equal(error.value._tag, "OrchestratorCommandIdConflictError");
      }
    }
    const noOpReplay = yield* closeShare(threadIds[noOpWinner]!);
    const noOpSuccess = noOpExits[noOpWinner]!;
    if (Exit.isSuccess(noOpSuccess)) {
      assert.equal(noOpReplay.sequence, noOpSuccess.value.sequence);
      assert.deepEqual(noOpReplay.storedEvents, []);
    }

    // The winner's own thread still replays its receipt.
    const replay = yield* setModel(threadIds[winner]!);
    if (Exit.isSuccess(winnerExit)) {
      assert.equal(replay.sequence, winnerExit.value.sequence);
      assert.isAbove(replay.storedEvents.length, 0);
      assert.deepEqual(
        replay.storedEvents.map((stored) => stored.sequence),
        winnerExit.value.storedEvents.map((stored) => stored.sequence),
      );
    }
  }).pipe(Effect.provide(raceLayerTest)),
);
