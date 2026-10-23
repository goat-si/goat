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
import * as Snapshot from "./memory/MemorySnapshot.ts";
import * as Projection from "./orchestration-v2/ProjectionStore.ts";
import * as Identity from "./environment/ServerEnvironment.ts";
import * as Settings from "./serverSettings.ts";
import {
  layerMemoryToolkits,
  MemorySourceReadBinding,
  layerMemorySourceReadBinding,
  layerMemorySnapshot,
} from "./server.ts";

// The application's own memory toolkits, over a Sync that only answers hub settings updates.
const servedMemoryToolkits = (sync: Layer.Layer<Sync.MemorySyncService>) =>
  layerMemoryToolkits.pipe(
    Layer.provide(Fixture.core),
    Layer.provide(Layer.mock(Settings.ServerSettingsService)({})),
    Layer.provide(sync),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
    Layer.provide(NodeServices.layer),
  );

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
        servedMemoryToolkits(
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
      ),
    ),
);

it.effect(
  "served disable forwards CAS and the live permit to Sync and returns a noncredential view",
  () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = [];
      const sync = Layer.mock(Sync.MemorySyncService)({
        updateHubSettings: (input, permit) =>
          Effect.gen(function* () {
            yield* permit;
            calls.push(input);
            return {
              view: { members: [], settings: { mode: "disabled" }, version: 8 },
              credential: null,
            };
          }),
      });
      yield* Effect.gen(function* () {
        const input = { requestId: M.MemoryOperationId.make(Fixture.id(31)), expectedVersion: 7 };
        expect((yield* Fixture.call("memory_hub_disable", input)).body).toMatchObject({
          code: "unavailable",
        });
        expect(calls).toEqual([]);
        const result = yield* Fixture.call(
          "memory_hub_disable",
          input,
          Fixture.scope(["settings:write"]),
        );
        expect(result.body).toEqual({ settings: { mode: "disabled" }, version: 8 });
        expect(calls).toEqual([{ ...input, action: "configure", settings: { mode: "disabled" } }]);
      }).pipe(Effect.provide(servedMemoryToolkits(sync)));
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
