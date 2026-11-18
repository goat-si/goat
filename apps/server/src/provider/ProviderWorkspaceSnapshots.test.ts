import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, ServerProvider } from "@goat/contracts";
import type {
  ProviderInstance,
  ProviderWorkspaceSnapshot,
} from "@goat/provider-core/server/driver";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@goat/provider-core/server/maintenanceResolver";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import { COMPACT_SLASH_COMMAND } from "@goat/provider-core/server/snapshotProbe";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const decodeServerProvider = Schema.decodeSync(ServerProvider);

const encodeServerProvider = Schema.encodeSync(ServerProvider);

describe("ProviderRegistry", () => {
  describe("ProviderRegistry.layer", () => {
    it("marks folder catalogs pending when a machine refresh changes the machine models", () => {
      const machineModel = {
        slug: "opencode/big-pickle",
        name: "Big Pickle",
        isCustom: false,
        capabilities: null,
      } satisfies ServerProvider["models"][number];
      const projectModel = { ...machineModel, slug: "uni/medium-gpt", name: "Medium GPT" };
      const addedModel = { ...machineModel, slug: "opencode/new", name: "New" };
      const provider = {
        instanceId: ProviderInstanceId.make("opencode"),
        driver: ProviderDriverKind.make("opencode"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        checkedAt: "2026-03-25T00:00:00.000Z",
        version: "2.0.0",
        models: [machineModel],
        slashCommands: [],
        skills: [],
      } satisfies ServerProvider;
      const withCatalog = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        ProviderRegistry.upsertProviderWorkspaceSnapshot(provider, "/project", {
          ...provider,
          workspaceModels: [machineModel, projectModel],
        }),
        "/plain",
        provider,
      );

      const unchanged = ProviderRegistry.mergeProviderSnapshot(withCatalog, provider);
      assert.deepStrictEqual(
        unchanged.workspaceSnapshots?.map((snapshot) => snapshot.cwd),
        ["/project", "/plain"],
      );
      const changed = ProviderRegistry.mergeProviderSnapshot(withCatalog, {
        ...provider,
        models: [machineModel, addedModel],
      });
      assert.deepStrictEqual(
        changed.workspaceSnapshots?.map(({ cwd, models, modelsPending }) => ({
          cwd,
          models,
          modelsPending,
        })),
        [
          { cwd: "/project", models: [projectModel], modelsPending: true },
          // Its folder may define a model the machine catalog just dropped.
          { cwd: "/plain", models: undefined, modelsPending: true },
        ],
      );
    });

    it("keeps only the folder models that differ from the machine catalog", () => {
      const model = (slug: string, name = slug) =>
        ({
          slug,
          name,
          isCustom: false,
          capabilities: null,
        }) satisfies ServerProvider["models"][number];
      const provider = {
        instanceId: ProviderInstanceId.make("opencode"),
        driver: ProviderDriverKind.make("opencode"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        checkedAt: "2026-03-25T00:00:00.000Z",
        version: "2.0.0",
        models: [model("a"), model("b"), model("c")],
        slashCommands: [],
        skills: [],
      } satisfies ServerProvider;
      const snapshotOf = (workspaceModels: ServerProvider["models"]) =>
        ProviderRegistry.upsertProviderWorkspaceSnapshot(provider, "/project", {
          ...provider,
          workspaceModels,
        }).workspaceSnapshots?.[0];

      const differing = snapshotOf([model("a"), model("b", "B for this project"), model("d")]);
      assert.deepStrictEqual(differing?.models, [model("b", "B for this project"), model("d")]);
      assert.deepStrictEqual(differing?.removedModels, ["c"]);
      const reordered = snapshotOf([model("c"), model("b"), model("a")]);
      assert.strictEqual(reordered?.models, undefined);
      assert.strictEqual(reordered?.removedModels, undefined);
    });

    it("stores workspace skills, commands and options without changing machine metadata", () => {
      const provider = {
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        checkedAt: "2026-03-25T00:00:00.000Z",
        version: "1.0.0",
        models: [],
        slashCommands: [{ name: "global" }],
        skills: [{ name: "global", path: "/global/SKILL.md", enabled: true }],
      } satisfies ServerProvider;
      const projectModels = [
        { slug: "project-model", name: "Project Model", isCustom: false, capabilities: null },
      ] satisfies ServerProvider["models"];
      const scopedSnapshot = {
        ...provider,
        checkedAt: "2026-03-25T00:01:00.000Z",
        slashCommands: [{ name: "project" }],
        skills: [{ name: "project", path: "/project/SKILL.md", enabled: true }],
        workspaceModels: projectModels,
        optionDescriptors: [
          {
            id: "agent",
            label: "Agent",
            type: "select",
            options: [{ id: "readonly", label: "Readonly" }],
          },
        ],
      } satisfies ProviderWorkspaceSnapshot;

      const result = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        provider,
        "/project",
        scopedSnapshot,
      );

      assert.deepStrictEqual(result.slashCommands, provider.slashCommands);
      assert.deepStrictEqual(result.skills, provider.skills);
      assert.strictEqual(result.models, provider.models);
      const decoded = decodeServerProvider(encodeServerProvider(result));
      assert.deepStrictEqual(decoded.workspaceSnapshots, [
        {
          cwd: "/project",
          checkedAt: scopedSnapshot.checkedAt,
          slashCommands: scopedSnapshot.slashCommands,
          skills: scopedSnapshot.skills,
          optionDescriptors: scopedSnapshot.optionDescriptors,
          models: projectModels,
        },
      ]);

      const pendingSnapshot = {
        ...scopedSnapshot,
        slashCommands: [COMPACT_SLASH_COMMAND],
        slashCommandsPending: true,
        workspaceModelsPending: true,
      } satisfies ProviderWorkspaceSnapshot;
      const partial = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        result,
        "/project",
        pendingSnapshot,
      );
      assert.deepStrictEqual(partial.workspaceSnapshots?.[0]?.slashCommands, [{ name: "project" }]);
      assert.strictEqual(partial.workspaceSnapshots?.[0]?.slashCommandsPending, true);
      assert.deepStrictEqual(partial.workspaceSnapshots?.[0]?.models, projectModels);
      assert.strictEqual(partial.workspaceSnapshots?.[0]?.modelsPending, true);
      const otherProject = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        partial,
        "/other-project",
        pendingSnapshot,
      );
      assert.deepStrictEqual(otherProject.workspaceSnapshots?.[1]?.slashCommands, [
        COMPACT_SLASH_COMMAND,
      ]);
      const recovered = ProviderRegistry.upsertProviderWorkspaceSnapshot(partial, "/project", {
        ...scopedSnapshot,
        slashCommands: [COMPACT_SLASH_COMMAND, { name: "replacement" }],
      });
      assert.deepStrictEqual(recovered.workspaceSnapshots?.[0]?.slashCommands, [
        COMPACT_SLASH_COMMAND,
        { name: "replacement" },
      ]);
      assert.strictEqual(recovered.workspaceSnapshots?.[0]?.slashCommandsPending, undefined);
      assert.deepStrictEqual(recovered.workspaceSnapshots?.[0]?.models, projectModels);
      assert.strictEqual(recovered.workspaceSnapshots?.[0]?.modelsPending, undefined);
      const withoutModels = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        recovered,
        "/project",
        { ...scopedSnapshot, workspaceModels: undefined },
      );
      assert.strictEqual(withoutModels.workspaceSnapshots?.[0]?.models, undefined);

      const { optionDescriptors, ...failedSnapshot } = scopedSnapshot;
      const firstFailure = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        provider,
        "/project",
        failedSnapshot,
      );
      assert.strictEqual(
        Object.hasOwn(firstFailure.workspaceSnapshots![0]!, "optionDescriptors"),
        false,
      );
      const failedOtherProject = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        recovered,
        "/other-project",
        failedSnapshot,
      );
      assert.strictEqual(
        Object.hasOwn(failedOtherProject.workspaceSnapshots![1]!, "optionDescriptors"),
        false,
      );

      for (const clearedDescriptors of [[], [{ ...optionDescriptors[0]!, options: [] }]]) {
        const cleared = ProviderRegistry.upsertProviderWorkspaceSnapshot(recovered, "/project", {
          ...scopedSnapshot,
          optionDescriptors: clearedDescriptors,
        });
        assert.deepStrictEqual(
          cleared.workspaceSnapshots?.[0]?.optionDescriptors,
          clearedDescriptors,
        );
      }

      const failedRefresh = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        failedOtherProject,
        "/project",
        failedSnapshot,
      );
      assert.deepStrictEqual(
        failedRefresh.workspaceSnapshots?.[1]?.optionDescriptors,
        optionDescriptors,
      );
    });
  });
});

it.layer(Layer.mergeAll(NodeServices.layer, ModelManifest.layerTest, ProviderLatestVersions.layer))(
  "ProviderRegistry workspace models",
  (it) => {
    it.effect("rescans a folder whose model catalog could not be read before its TTL", () =>
      Effect.gen(function* () {
        const driver = ProviderDriverKind.make("opencode");
        const instanceId = ProviderInstanceId.make("opencode");
        const machineModel = {
          slug: "opencode/big-pickle",
          name: "Big Pickle",
          isCustom: false,
          capabilities: null,
        } satisfies ServerProvider["models"][number];
        const projectModel = { ...machineModel, slug: "uni/medium-gpt", name: "Medium GPT" };
        const provider = {
          instanceId,
          driver,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-06-10T00:00:00.000Z",
          version: "2.0.0",
          models: [machineModel],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const machineProvider = yield* Ref.make<ServerProvider>(provider);
        const scanResult = yield* Ref.make<ProviderWorkspaceSnapshot>({
          ...provider,
          slashCommandsPending: false,
          workspaceModelsPending: true,
        });
        const instance: ProviderInstance = {
          instanceId,
          driverKind: driver,
          continuationIdentity: {
            driverKind: driver,
            continuationKey: "opencode:instance:opencode",
          },
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
            getSnapshot: Ref.get(machineProvider),
            refresh: Ref.get(machineProvider),
            streamChanges: Stream.empty,
            applyUsageLimits: () => Effect.void,
          },
          snapshotForCwd: () => Ref.get(scanResult),
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
                prefix: "goat-provider-registry-pending-workspace-models-",
              }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const workspaceOf = Effect.map(
            registry.getProviders,
            (providers) => providers[0]?.workspaceSnapshots?.[0],
          );
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/project" });
          const unread = yield* workspaceOf;
          assert.strictEqual(unread?.models, undefined);
          assert.strictEqual(unread?.modelsPending, true);

          const workspaceModels = [machineModel, projectModel];
          yield* Ref.set(scanResult, { ...provider, slashCommandsPending: false, workspaceModels });
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/project" });
          const recovered = yield* workspaceOf;
          assert.deepStrictEqual(recovered?.models, [projectModel]);
          assert.strictEqual(recovered?.modelsPending, undefined);

          // A fresh refresh whose machine models change still publishes the folder read it ran.
          const addedModel = { ...machineModel, slug: "opencode/new", name: "New" };
          const nextWorkspaceModels = [machineModel, addedModel, projectModel];
          yield* Ref.set(machineProvider, { ...provider, models: [machineModel, addedModel] });
          yield* Ref.set(scanResult, {
            ...provider,
            slashCommandsPending: false,
            workspaceModels: nextWorkspaceModels,
          });
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/project", fresh: true });
          const rescanned = yield* workspaceOf;
          assert.deepStrictEqual(rescanned?.models, [projectModel]);
          assert.strictEqual(rescanned?.modelsPending, undefined);
        }).pipe(Effect.provide(runtimeServices));
      }),
    );
  },
);
