import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateState,
  type ServerProviderVersionAdvisoryStatus,
} from "@goat/contracts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@goat/provider-core/server/maintenanceResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as ModelManifest from "./ModelManifest.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");

const codexUpdateSnapshot = (advisory: ServerProviderVersionAdvisoryStatus) =>
  ({
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
    versionAdvisory: {
      status: advisory,
      currentVersion: "1.0.0",
      latestVersion: advisory === "unknown" ? null : advisory === "current" ? "1.0.0" : "2.0.0",
      updateCommand: null,
      canUpdate: true,
      checkedAt: "2026-06-10T00:00:00.000Z",
      message: null,
    },
  }) as const satisfies ServerProvider;

const makeUpdateState = (status: ServerProviderUpdateState["status"]) =>
  ({
    status,
    startedAt: "2026-06-10T00:00:00.000Z",
    finishedAt: status === "queued" || status === "running" ? null : "2026-06-10T00:01:00.000Z",
    message: `update ${status}`,
    output: null,
  }) satisfies ServerProviderUpdateState;

// One Codex instance whose probe returns whatever `snapshot` currently holds.
const registryOverSnapshot = (snapshot: Ref.Ref<ServerProvider>) => {
  const instance = {
    instanceId,
    driverKind: driver,
    continuationIdentity: { driverKind: driver, continuationKey: "codex:instance:codex" },
    displayName: undefined,
    enabled: true,
    snapshot: {
      resolveMaintenance: () =>
        Effect.succeed(
          makeManualOnlyProviderMaintenanceCapabilities({ provider: driver, packageName: null }),
        ),
      getSnapshot: Ref.get(snapshot),
      refresh: Ref.get(snapshot),
      streamChanges: Stream.empty,
      applyUsageLimits: () => Effect.void,
    },
    orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
    textGeneration: {} as ProviderInstance["textGeneration"],
  } satisfies ProviderInstance;
  const layerInstanceRegistry = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
    getInstance: (id) => Effect.succeed(id === instance.instanceId ? instance : undefined),
    listInstances: Effect.succeed([instance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
  });
  return ProviderRegistry.layer.pipe(
    Layer.provide(layerInstanceRegistry),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "goat-provider-registry-update-state-" }),
    ),
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, ProviderLatestVersions.layer, ModelManifest.layerTest),
    ),
  );
};

describe("ProviderRegistry update results across refreshes", () => {
  it.effect.each([
    { status: "unchanged", advisory: "current", retired: true },
    { status: "failed", advisory: "current", retired: true },
    { status: "unchanged", advisory: "behind_latest", retired: false },
    { status: "failed", advisory: "behind_latest", retired: false },
    // The probe publishes `unknown` until the latest-version check lands.
    { status: "unchanged", advisory: "unknown", retired: false },
    { status: "queued", advisory: "current", retired: false },
    { status: "running", advisory: "current", retired: false },
    { status: "succeeded", advisory: "current", retired: false },
    { status: "failed", advisory: "unknown", retired: false },
  ] as const)(
    "a $status update result is retired: $retired when a refresh reports the provider $advisory",
    ({ status, advisory, retired }) =>
      Effect.gen(function* () {
        const snapshot = yield* Ref.make<ServerProvider>(codexUpdateSnapshot("behind_latest"));
        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const state = makeUpdateState(status);
          yield* registry.setProviderMaintenanceActionState({
            instanceId,
            action: "update",
            state,
          });
          yield* Ref.set(snapshot, codexUpdateSnapshot(advisory));

          const [refreshed] = yield* registry.refresh(driver);

          expect(refreshed?.updateState).toEqual(retired ? undefined : state);
        }).pipe(Effect.provide(registryOverSnapshot(snapshot)), Effect.scoped);
      }),
  );

  it.effect.each(["failed", "unchanged"] as const)(
    "keeps a %s recommended-version install after a current refresh",
    (status) =>
      Effect.gen(function* () {
        const snapshot = yield* Ref.make<ServerProvider>(codexUpdateSnapshot("current"));
        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const state = makeUpdateState(status);
          yield* registry.setProviderMaintenanceActionState({
            instanceId,
            action: "update",
            state,
            targetVersion: "0.9.0",
          });
          const [refreshed] = yield* registry.refresh(driver);
          expect(refreshed?.updateState).toEqual(state);
        }).pipe(Effect.provide(registryOverSnapshot(snapshot)), Effect.scoped);
      }),
  );
});
