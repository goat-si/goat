import { assert, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Registry from "../mcp/McpSessionRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as Projection from "./ProjectionStore.ts";
import { makeMemoryProviderAuthority } from "./MemoryProviderAuthority.ts";

it.effect("captured authority checks revocation and rotation without reading a projection", () => {
  const threadId = M.ThreadId.make("authority-thread");
  const providerInstanceId = M.ProviderInstanceId.make("codex");
  const initialConfig = {
    threadId,
    providerInstanceId,
    providerSessionId: "synthetic-credential",
    credentialGeneration: 1,
    environmentId: M.EnvironmentId.make("fixture"),
    endpoint: "http://127.0.0.1/mcp",
    authorizationHeader: "Bearer synthetic",
    browserToolsAvailable: false,
  };
  let config = initialConfig;
  let prepared = {
    threadId,
    providerInstanceId,
    destinationUsable: true,
    readOnly: false,
    memoryGrantCeiling: null,
  };
  let committed = { policyReady: true, enableAgentMemoryAccess: true, epoch: 1 };
  let registryGrant: "read" | "none" = "read";
  let attached = true;
  let projectionReads = 0;
  const layers = Layer.mergeAll(
    Layer.mock(Registry.McpSessionRegistry)({
      currentMemoryPolicy: () => Effect.sync(() => ({ grant: registryGrant, policyEpoch: 1 })),
    }),
    Layer.mock(Projection.ProjectionStoreV2)({
      getThread: () =>
        Effect.sync(() => {
          projectionReads++;
          return {
            providerInstanceId,
            archivedAt: null,
            deletedAt: null,
          } as M.OrchestrationV2AppThread;
        }),
    }),
    Layer.succeed(Settings.MemoryProviderCommittedPolicy, {
      read: Effect.sync(() => committed),
      subscribeRotations: Effect.die("not used"),
    }),
  );
  return Effect.gen(function* () {
    const registry = yield* Registry.McpSessionRegistry;
    const projection = yield* Projection.ProjectionStoreV2;
    const policy = yield* Settings.MemoryProviderCommittedPolicy;
    const authority = makeMemoryProviderAuthority({
      registry,
      projection,
      policy: Option.some(policy),
      readConfig: () => Effect.sync(() => config),
      prepared: () => prepared,
      attached: () => Effect.sync(() => attached),
    });
    const captured = yield* authority.currentMemoryPolicy(threadId);
    assert.equal(captured.grant, "read");
    assert.isDefined(captured.finalAuthority);
    assert.isTrue(yield* captured.finalAuthority!);
    assert.equal(projectionReads, 1);
    prepared = { ...prepared };
    assert.isTrue(yield* captured.finalAuthority!);
    prepared.readOnly = true;
    assert.isFalse(yield* captured.finalAuthority!);
    prepared.readOnly = false;
    prepared = { ...prepared, readOnly: true };
    assert.isFalse(yield* captured.finalAuthority!);
    prepared = { ...prepared, readOnly: false };
    config.credentialGeneration = 2;
    assert.isFalse(yield* captured.finalAuthority!);
    config.credentialGeneration = 1;
    config = { ...config, credentialGeneration: 2 };
    assert.isFalse(yield* captured.finalAuthority!);
    config = initialConfig;
    config = { ...config, providerSessionId: "replacement-credential" };
    assert.isFalse(yield* captured.finalAuthority!);
    config = initialConfig;
    config = { ...config, providerInstanceId: M.ProviderInstanceId.make("other") };
    assert.isFalse(yield* captured.finalAuthority!);
    config = initialConfig;
    registryGrant = "none";
    assert.isFalse(yield* captured.finalAuthority!);
    registryGrant = "read";
    committed = { ...committed, epoch: 2 };
    assert.isFalse(yield* captured.finalAuthority!);
    committed = { ...committed, epoch: 1 };
    attached = false;
    assert.isFalse(yield* captured.finalAuthority!);
    assert.equal(projectionReads, 1);
  }).pipe(Effect.provide(layers));
});
