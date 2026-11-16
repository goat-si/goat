import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@goat/contracts";
import { type ProviderInstance } from "@goat/provider-core/server/driver";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@goat/provider-core/server/maintenanceResolver";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ModelManifest from "./ModelManifest.ts";
import * as ServerConfig from "../config.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

it.layer(Layer.mergeAll(NodeServices.layer, ProviderLatestVersions.layer, ModelManifest.layerTest))(
  "workspace scan directory",
  (it) => {
    it.effect("scans scanCwd and keys the workspace snapshot by cwd", () =>
      Effect.gen(function* () {
        const driver = ProviderDriverKind.make("codex");
        const instanceId = ProviderInstanceId.make("codex");
        const provider = {
          instanceId,
          driver,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-06-10T00:00:00.000Z",
          version: "1.0.0",
          models: [],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const scannedDirectories = yield* Ref.make<ReadonlyArray<string>>([]);
        const instance: ProviderInstance = {
          instanceId,
          driverKind: driver,
          continuationIdentity: { driverKind: driver, continuationKey: "codex:instance:codex" },
          displayName: undefined,
          enabled: true,
          snapshot: {
            resolveMaintenance: () =>
              Effect.succeed(
                makeManualOnlyProviderMaintenanceCapabilities({
                  provider: driver,
                  packageName: null,
                }),
              ),
            getSnapshot: Effect.succeed(provider),
            refresh: Effect.succeed(provider),
            streamChanges: Stream.empty,
            applyUsageLimits: () => Effect.void,
          },
          snapshotForCwd: (directory) =>
            Ref.update(scannedDirectories, (directories) => [...directories, directory]).pipe(
              Effect.as({
                ...provider,
                skills: [{ name: "finalize", path: `${directory}/finalize`, enabled: true }],
              }),
            ),
          orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        };
        const layerInstanceRegistry = Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          {
            getInstance: (requestedId) =>
              Effect.succeed(requestedId === instanceId ? instance : undefined),
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
          },
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const runtimeServices = yield* Layer.build(
          ProviderRegistry.layer.pipe(
            Layer.provideMerge(layerInstanceRegistry),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "goat-provider-registry-scan-cwd-",
              }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const providers = yield* registry.refreshWorkspaceSnapshot({
            instanceId,
            cwd: "/worktree",
            scanCwd: "/project",
          });
          assert.deepStrictEqual(yield* Ref.get(scannedDirectories), ["/project"]);
          assert.deepStrictEqual(
            providers[0]?.workspaceSnapshots
              ?.find((snapshot) => snapshot.cwd === "/worktree")
              ?.skills?.map((skill) => skill.path),
            ["/project/finalize"],
          );
        }).pipe(Effect.provide(runtimeServices));
      }),
    );
  },
);
