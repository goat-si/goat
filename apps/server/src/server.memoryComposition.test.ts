import { expect, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import { listedToolName, resolveAgentSurfaceEntry } from "@goat/contracts/agentSurface/resolve";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/ai";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Fixture from "./mcp/toolkits/memory/handlers.testkit.ts";
import * as McpToolAccessTestkit from "./mcp/McpToolAccess.testkit.ts";
import * as Sync from "./memory/MemorySyncService.ts";
import * as MemoryService from "./memory/MemoryService.ts";
import * as Snapshot from "./memory/MemorySnapshot.ts";
import * as Projection from "./orchestration-v2/ProjectionStore.ts";
import * as Identity from "./environment/ServerEnvironment.ts";
import * as Settings from "./serverSettings.ts";
import {
  layerMemoryToolkits,
  MemorySourceReadBinding,
  layerMemorySourceReadBinding,
  layerMemoryHubAdministration,
  layerMemorySnapshot,
} from "./server.ts";

it.effect(
  "the application registers the nine core tools and three administration tools on one MCP server",
  () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const names = server.tools.map(({ tool }) => tool.name);
      expect(names.sort()).toEqual(
        [...M.MEMORY_MCP_TOOLS, ...M.MEMORY_ADMINISTRATION_MCP_TOOLS]
          .map((name) => listedToolName(resolveAgentSurfaceEntry(name)!))
          .sort(),
      );
      expect(new Set(names).size).toBe(12);
      const result = yield* Fixture.call(
        "memory_hub_disable",
        { requestId: M.MemoryOperationId.make(Fixture.id(30)), expectedVersion: 3 },
        Fixture.scope(["settings:write"]),
      );
      expect(result.result.isError).not.toBe(true);
      expect(result.body).toEqual({ settings: { mode: "disabled" }, version: 4 });
    }).pipe(
      Effect.provide(
        layerMemoryToolkits.pipe(
          Layer.provide(Fixture.core),
          Layer.provide(Layer.mock(Settings.ServerSettingsService)({})),
          Layer.provide(
            Layer.mock(Sync.MemorySyncService)({
              updateHubSettings: (input, permit) =>
                permit.pipe(
                  Effect.as({
                    view: {
                      members: [],
                      settings: { mode: "disabled" },
                      version: input.expectedVersion + 1,
                    },
                    credential: null,
                  }),
                ),
            }),
          ),
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
);

it.effect("disable forwards CAS and the live permit to Sync and returns a noncredential view", () =>
  Effect.gen(function* () {
    let calls = 0;
    const sync = Layer.mock(Sync.MemorySyncService)({
      updateHubSettings: (input, permit) =>
        Effect.gen(function* () {
          yield* permit;
          expect(input).toEqual({
            requestId: M.MemoryOperationId.make(Fixture.id(31)),
            expectedVersion: 7,
            action: "configure",
            settings: { mode: "disabled" },
          });
          calls++;
          return {
            view: { members: [], settings: { mode: "disabled" }, version: 8 },
            credential: null,
          };
        }),
    });
    yield* Effect.gen(function* () {
      const service = yield* Settings.MemoryHubAdministration;
      const input = { requestId: M.MemoryOperationId.make(Fixture.id(31)), expectedVersion: 7 };
      expect(
        (yield* Effect.flip(
          service.disableHub(
            input,
            Effect.fail(new MemoryService.MemoryAccessError({ code: "unavailable" })),
          ),
        )).code,
      ).toBe("unavailable");
      expect(calls).toBe(0);
      expect(yield* service.disableHub(input, Effect.void)).toEqual({
        settings: { mode: "disabled" },
        version: 8,
      });
      expect(calls).toBe(1);
    }).pipe(Effect.provide(layerMemoryHubAdministration.pipe(Layer.provide(sync))));
  }),
);

it.effect("two consumers of the application Snapshot layer observe the same instance", () =>
  Effect.gen(function* () {
    const instances = new Set<Snapshot.MemorySnapshot["Service"]>();
    const first = Layer.effectDiscard(
      Effect.gen(function* () {
        const snapshot = yield* Snapshot.MemorySnapshot;
        instances.add(snapshot);
        expect(
          yield* snapshot.forThread(
            M.ThreadId.make("fixture-thread"),
            { grant: "none", policyEpoch: 0 },
            Effect.succeed({ grant: "none", policyEpoch: 0 }),
          ),
        ).toBeUndefined();
      }),
    );
    const second = Layer.effectDiscard(
      Effect.gen(function* () {
        const snapshot = yield* Snapshot.MemorySnapshot;
        instances.add(snapshot);
        yield* snapshot.invalidate(M.ThreadId.make("fixture-thread"));
      }),
    );
    yield* Effect.void.pipe(
      Effect.provide(
        Layer.merge(
          first.pipe(Layer.provide(layerMemorySnapshot)),
          second.pipe(Layer.provide(layerMemorySnapshot)),
        ).pipe(
          Layer.provide(Fixture.core),
          Layer.provide(
            Layer.mock(Sync.MemorySyncService)({
              readLocalReadiness: () =>
                Effect.succeed({ memorySpaceId: null, bootstrap: "unbound" }),
            }),
          ),
          Layer.provide(Layer.mock(Projection.ProjectionStoreV2)({})),
          Layer.provide(
            Layer.succeed(Identity.ServerEnvironmentIdentity, {
              getEnvironmentId: Effect.succeed(M.EnvironmentId.make("fixture-owner")),
            }),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
    expect(instances.size).toBe(1);
  }),
);

it.effect("import and source relay share the application late-bound Sync instance", () =>
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const binding = yield* MemorySourceReadBinding;
      expect((yield* binding.importSync.readLocalReadiness().pipe(Effect.flip))._tag).toBe(
        "MemoryHubError",
      );
      const sync = yield* Sync.MemorySyncService;
      yield* binding.bind(sync);
      expect(yield* binding.importSync.readLocalReadiness()).toEqual({
        memorySpaceId: null,
        bootstrap: "unbound",
      });
      yield* binding.importSync.requireBootstrap(M.MemorySpaceId.make(Fixture.id(50)));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerMemorySourceReadBinding,
          Layer.mock(Sync.MemorySyncService)({
            readLocalReadiness: () => Effect.succeed({ memorySpaceId: null, bootstrap: "unbound" }),
            requireBootstrap: () => Effect.void,
          }),
        ),
      ),
    );
  }),
);
