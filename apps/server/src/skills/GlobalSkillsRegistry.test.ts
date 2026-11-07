import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@goat/contracts";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@goat/provider-core/server/maintenanceResolver";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";

const provider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  status: "ready",
  enabled: true,
  installed: true,
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  version: "1",
  models: [],
  slashCommands: [],
  skills: [{ name: "goat:one", path: "/provider/one", enabled: true }],
} satisfies ServerProvider;

const instance = {
  instanceId: provider.instanceId,
  driverKind: provider.driver,
  continuationIdentity: { driverKind: provider.driver, continuationKey: "codex" },
  displayName: undefined,
  enabled: true,
  snapshot: {
    getSnapshot: Effect.succeed(provider),
    refresh: Effect.succeed(provider),
    streamChanges: Stream.empty,
    resolveMaintenance: () =>
      Effect.succeed(
        makeManualOnlyProviderMaintenanceCapabilities({
          provider: provider.driver,
          packageName: null,
        }),
      ),
    applyUsageLimits: () => Effect.void,
  },
  snapshotForCwd: () => Effect.succeed(provider),
  orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

describe("global skill provider publication", () => {
  it.effect("rescans external additions and removals into machine and workspace snapshots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const changes = yield* PubSub.unbounded<void>();
      const settingsChanges = yield* PubSub.unbounded<typeof DEFAULT_SERVER_SETTINGS>();
      const settings = yield* Ref.make(DEFAULT_SERVER_SETTINGS);
      const serviceLayer = Layer.mergeAll(
        Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
          getInstance: (id) => Effect.succeed(id === instance.instanceId ? instance : undefined),
          listInstances: Effect.succeed([instance]),
          listUnavailable: Effect.succeed([]),
          streamChanges: Stream.empty,
          subscribeChanges: PubSub.subscribe(changes),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Ref.get(settings),
          streamChanges: Stream.fromPubSub(settingsChanges),
          subscribeChanges: PubSub.subscribe(settingsChanges).pipe(
            Effect.map(Stream.fromSubscription),
          ),
        }),
        ModelManifest.layerTest,
        ProviderLatestVersions.layer,
      );
      yield* Effect.gen(function* () {
        const registry = yield* ProviderRegistry.ProviderRegistry;
        yield* registry.refreshWorkspaceSnapshot({
          instanceId: instance.instanceId,
          cwd: "/fixture",
        });
        let snapshot = (yield* registry.getProviders)[0];
        expect(snapshot?.skills).toEqual([]);
        expect(snapshot?.workspaceSnapshots?.[0]?.skills).toEqual([]);
        yield* fs.makeDirectory(path.join(config.globalSkillsDir, "one"), { recursive: true });
        yield* fs.writeFileString(
          path.join(config.globalSkillsDir, "one", "SKILL.md"),
          "New skill",
        );
        const pull = yield* Stream.toPull(registry.streamChanges);
        const rescan = registry.rescanGlobalSkills ?? Effect.die("missing rescan");
        const [added] = yield* Effect.all([pull, rescan], { concurrency: 2 });
        expect(added[0]?.[0]?.skills[0]?.name).toBe("goat:one");
        snapshot = (yield* registry.getProviders)[0];
        expect(snapshot?.skills[0]?.scope).toBe("goat");
        expect(snapshot?.workspaceSnapshots?.[0]?.skills[0]?.scope).toBe("goat");
        const disabled = { ...DEFAULT_SERVER_SETTINGS, disabledGlobalSkills: ["goat:one"] };
        yield* Ref.set(settings, disabled);
        const [updated] = yield* Effect.all([pull, PubSub.publish(settingsChanges, disabled)], {
          concurrency: 2,
        });
        expect(updated[0]?.[0]?.skills[0]?.enabled).toBe(false);
        expect(updated[0]?.[0]?.workspaceSnapshots?.[0]?.skills[0]?.enabled).toBe(false);
        yield* fs.remove(path.join(config.globalSkillsDir, "one"), { recursive: true });
        const [removed] = yield* Effect.all([pull, rescan], {
          concurrency: 2,
        });
        expect(removed[0]?.[0]?.skills).toEqual([]);
        expect((yield* registry.getProviders)[0]?.workspaceSnapshots?.[0]?.skills).toEqual([]);
      }).pipe(
        Effect.provide(ProviderRegistry.layer.pipe(Layer.provide(serviceLayer))),
        Effect.scoped,
      );
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "goat-global-registry-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
      Effect.scoped,
    ),
  );
});
