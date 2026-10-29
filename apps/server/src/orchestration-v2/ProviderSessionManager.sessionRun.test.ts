import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/http";
import * as Layer from "effect/Layer";
import * as NetAddress from "effect/net/NetAddress";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as CommandOutputHub from "./CommandOutputHub.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const registryLayer = Layer.effect(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.__testing.make({}),
).pipe(
  Layer.provide(
    Layer.succeed(
      HttpServer.HttpServer,
      HttpServer.HttpServer.of({
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
        serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
      }),
    ),
  ),
  Layer.provide(
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("session-run-test")),
    }),
  ),
);
const dependencies = (driver: string) =>
  Layer.mergeAll(
    registryLayer,
    McpProviderSessions.layer,
    IdAllocator.layer,
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
      get: () => Effect.succeed({ driver } as never),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThread: (id) =>
        Effect.succeed({
          id,
          providerInstanceId,
          deletedAt: null,
          archivedAt: null,
          lineage: { relationshipToParent: null },
        } as never),
    }),
    Layer.mock(EventSink.EventSinkV2)({}),
    Layer.mock(CommandOutputHub.CommandOutputHub)({}),
    Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({}),
  );
const testLayer = (driver: string) =>
  ProviderSessionManager.layerWithOptions().pipe(
    Layer.provideMerge(dependencies(driver)),
    Layer.provide(NodeServices.layer),
  );

it.effect.each([
  { session: true, driver: "codex", perRun: true },
  { session: true, driver: "claudeAgent", perRun: true },
  { session: true, driver: "cursor", perRun: false },
  { session: false, driver: "codex", perRun: false },
])(
  "session=$session driver=$driver: rotates per-run credentials and preserves other reuse",
  ({ session, driver, perRun }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        const threadId = ThreadId.make(session ? "goat-bot-session:manager:1" : "ordinary-manager");
        const prepare = (run: string) =>
          manager.prepareMcpSession!({
            threadId,
            providerInstanceId,
            runId: RunId.make(run),
            memoryGrantCeiling: "none",
          });
        yield* prepare("run-a");
        const a = yield* sessions.read(threadId);
        expect(a).toBeDefined();
        expect(a?.nativeSubagentLimit).toBe(session ? 0 : undefined);
        const tokenA = a!.authorizationHeader.replace(/^Bearer\s+/, "");
        expect((yield* registry.resolve(tokenA))?.thread.runId).toBe(perRun ? "run-a" : undefined);
        yield* prepare("run-b");
        const b = yield* sessions.read(threadId);
        expect(b).toBeDefined();
        expect(b?.nativeSubagentLimit).toBe(session ? 0 : undefined);
        if (perRun) {
          expect(b!.providerSessionId).not.toBe(a!.providerSessionId);
          expect(yield* registry.resolve(tokenA)).toBeUndefined();
          expect(
            (yield* registry.resolve(b!.authorizationHeader.replace(/^Bearer\s+/, "")))?.thread
              .runId,
          ).toBe("run-b");
          yield* prepare("run-b");
          expect((yield* sessions.read(threadId))?.providerSessionId).toBe(b!.providerSessionId);
        } else expect(b!.providerSessionId).toBe(a!.providerSessionId);
      }),
    ).pipe(Effect.provide(testLayer(driver))),
);
