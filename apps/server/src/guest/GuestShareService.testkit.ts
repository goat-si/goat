import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { assert } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CloudManagedEndpointRuntime } from "../cloud/ManagedEndpointRuntime.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandOutputHub from "../orchestration-v2/CommandOutputHub.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ResourceCleanupService from "../orchestration-v2/ResourceCleanupService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GuestShareService from "./GuestShareService.ts";

export const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for guest shares"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestration = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "guest-share-service" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

// The Connect hostname the fake tunnel reports. Tests set it to null to simulate an unlink.
export const hostname = Ref.makeUnsafe<string | null>("env.t3.test");
const layerConnect = Layer.mock(CloudManagedEndpointRuntime)({
  inspectConnector: Effect.map(Ref.get(hostname), (value) => ({
    pid: 1,
    readyConnections: 1,
    hostname: value,
    protocol: "http2",
  })),
});
const layerProviders = Layer.mock(ProviderRegistry.ProviderRegistry)({
  getProviders: Effect.succeed([]),
});
const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "goat-guest-share-" });
// The real cleanup also closes terminals and previews; these tests only need the files gone.
const layerCleanup = Layer.effect(
  ResourceCleanupService.ResourceCleanupService,
  Effect.gen(function* () {
    const { attachmentsDir } = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    return {
      cleanupScheduledTasks: () => Effect.void,
      cleanupTerminals: () => Effect.void,
      cleanupPreviews: () => Effect.void,
      cleanupDevices: () => Effect.void,
      cleanupAttachments: (attachmentIds) =>
        Effect.forEach(
          attachmentIds,
          (attachmentId) => {
            const path = resolveAttachmentPathById({ attachmentsDir, attachmentId });
            return path === null ? Effect.void : fileSystem.remove(path).pipe(Effect.orDie);
          },
          { discard: true },
        ),
    };
  }),
).pipe(
  Layer.provide(layerConfig),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
export class RecordedAnalytics extends Context.Service<
  RecordedAnalytics,
  Ref.Ref<ReadonlyArray<Readonly<Record<string, unknown>>>>
>()("goat/guest/GuestShareService.testkit/RecordedAnalytics") {}
const layerAnalytics = Layer.effectContext(
  Effect.gen(function* () {
    const recorded = yield* Ref.make<ReadonlyArray<Readonly<Record<string, unknown>>>>([]);
    return Context.make(RecordedAnalytics, recorded).pipe(
      Context.add(
        AnalyticsService.AnalyticsService,
        AnalyticsService.AnalyticsService.of({
          record: (event, properties) =>
            Ref.update(recorded, (events) => [...events, { event, ...properties }]),
          flush: Effect.void,
          recordOwners: () => Effect.void,
        }),
      ),
    );
  }),
);
export const makeLayerTest = (guestService = GuestShareService.layer) =>
  guestService.pipe(
    Layer.provideMerge(
      CommandOutputHub.layer.pipe(
        Layer.provideMerge(layerOrchestration.pipe(Layer.provide(layerCleanup))),
      ),
    ),
    Layer.provide(layerProviders),
    Layer.provideMerge(ServerSettings.layerTest({ guestSharingEnabled: true })),
    Layer.provide(layerConnect),
    Layer.provideMerge(layerAnalytics),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(DocumentText.layer),
    Layer.provideMerge(layerConfig),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

export const layerTest = makeLayerTest();

export const threadId = ThreadId.make("thread:guest-share-service");

export const shareThreadFor = Effect.fn(function* (threadId: ThreadId) {
  yield* Ref.set(hostname, "env.t3.test");
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${threadId}`),
    threadId,
    projectId: ProjectId.make("project:guest-share-service"),
    title: "Review me",
    modelSelection: { instanceId, model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  const guestShares = yield* GuestShareService.GuestShareService;
  const { url } = yield* guestShares.create({ threadId });
  assert.isTrue(url.startsWith("https://env.t3.test/guest#"));
  const credential = url.slice(url.indexOf("#") + 1);
  return { orchestrator, guestShares, credential };
});
export const shareThread = shareThreadFor(threadId);

export const joinedGuest = Effect.gen(function* () {
  const shared = yield* shareThread;
  const { token: session, shareId } = yield* shared.guestShares.redeem({
    credential: shared.credential,
    name: "Sam",
  });
  return { ...shared, session, shareId };
});
