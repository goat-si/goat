import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  WS_METHODS,
  type ServerConfigStreamEvent,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { makeProviderCatalogRpc } from "./wsProviderCatalog.testkit.ts";
import { makeWorkspaceProviderFixture } from "./wsProviderFixture.testkit.ts";

function makeCatalogFixture() {
  const { provider, snapshotFor } = makeWorkspaceProviderFixture();
  const local = {
    ...provider,
    slashCommands: [{ name: "machine-command", description: "Command help" }],
    skills: [
      {
        name: "machine-skill",
        path: "/skills/machine",
        enabled: true,
        displayName: "Machine Skill",
        description: "Skill help",
      },
    ],
  };
  const registryAgent = {
    ...local,
    driver: ProviderDriverKind.make("acpRegistry"),
    instanceId: ProviderInstanceId.make("acpRegistry_test"),
  };
  return { local, registryAgent, snapshotA: snapshotFor("/a", provider.checkedAt) };
}

it.effect("on-demand catalogs keep names and labels only for providers that scan a cwd", () =>
  Effect.gen(function* () {
    const { local, registryAgent } = makeCatalogFixture();
    const client = yield* makeProviderCatalogRpc({
      providers: [local, registryAgent],
      cwdProviders: new Set([local.instanceId]),
    });
    const first = (onDemand: boolean) =>
      client[WS_METHODS.subscribeServerConfig]({
        workspaceSnapshotsOnDemand: true,
        providerCatalogsOnDemand: onDemand,
      }).pipe(Stream.runHead);
    const old = yield* first(false);
    const next = yield* first(true);
    if (
      old._tag !== "Some" ||
      old.value.type !== "snapshot" ||
      next._tag !== "Some" ||
      next.value.type !== "snapshot"
    ) {
      return yield* Effect.die("Missing config snapshot");
    }
    assert.deepEqual(old.value.config.providers[0]?.slashCommands, local.slashCommands);
    assert.deepEqual(next.value.config.providers[0]?.slashCommands, [{ name: "machine-command" }]);
    assert.deepEqual(next.value.config.providers[0]?.skills, [
      {
        name: "machine-skill",
        path: "/skills/machine",
        enabled: true,
        displayName: "Machine Skill",
      },
    ]);
    assert.deepEqual(next.value.config.providers[1]?.slashCommands, registryAgent.slashCommands);
    assert.deepEqual(next.value.config.providers[1]?.skills, registryAgent.skills);
  }).pipe(Effect.scoped),
);

it.effect("a missing cwd scan returns the machine catalog as a pending workspace snapshot", () =>
  Effect.gen(function* () {
    const { local } = makeCatalogFixture();
    const client = yield* makeProviderCatalogRpc({
      providers: [local],
      cwdProviders: new Set([local.instanceId]),
    });
    const result = yield* client[WS_METHODS.serverRefreshProviders]({
      instanceId: local.instanceId,
      cwd: "/no-scan",
      workspaceSnapshotsOnDemand: true,
      providerCatalogsOnDemand: true,
    });
    assert.deepEqual(result.providers[0]?.workspaceSnapshots, [
      {
        cwd: "/no-scan",
        checkedAt: local.checkedAt,
        slashCommands: local.slashCommands,
        slashCommandsPending: true,
        skills: local.skills,
      },
    ]);
  }).pipe(Effect.scoped),
);

it.effect("digest subscribers get lists on demand and a matching digest on the cwd reply", () =>
  Effect.gen(function* () {
    const { local, registryAgent, snapshotA } = makeCatalogFixture();
    const client = yield* makeProviderCatalogRpc({
      providers: [local, registryAgent],
      cwdProviders: new Set([local.instanceId]),
    });
    const first = yield* client[WS_METHODS.subscribeServerConfig]({
      workspaceSnapshotsOnDemand: true,
      providerStatusChanges: true,
      providerCatalogsOnDemand: true,
      providerCatalogDigests: true,
    }).pipe(Stream.runHead);
    if (first._tag !== "Some" || first.value.type !== "snapshot") {
      return yield* Effect.die("Missing config snapshot");
    }
    const [digested, full] = first.value.config.providers;
    assert.match(digested?.catalogDigest ?? "", /^[a-f0-9]{16}$/);
    assert.deepEqual(digested?.slashCommands, []);
    assert.deepEqual(digested?.skills, []);
    assert.isUndefined(full?.catalogDigest);
    assert.deepEqual(full?.skills, registryAgent.skills);

    const reply = yield* client[WS_METHODS.serverRefreshProviders]({
      instanceId: local.instanceId,
      cwd: "/a",
      workspaceSnapshotsOnDemand: true,
      providerCatalogsOnDemand: true,
      machineCatalog: true,
    });
    const [refreshed] = reply.providers;
    assert.equal(refreshed?.catalogDigest, digested?.catalogDigest);
    assert.deepEqual(refreshed?.slashCommands, [{ name: "machine-command" }]);
    assert.deepEqual(refreshed?.workspaceSnapshots, [snapshotA]);
  }).pipe(Effect.scoped),
);

it.effect(
  "an omitted machine refresh reply still refreshes and a cwd reply still carries the workspace",
  () =>
    Effect.gen(function* () {
      const { local, snapshotA } = makeCatalogFixture();
      let refreshes = 0;
      const client = yield* makeProviderCatalogRpc({
        providers: [local],
        cwdProviders: new Set([local.instanceId]),
        recordRefresh: () => {
          refreshes++;
        },
      });
      const refresh = client[WS_METHODS.serverRefreshProviders];
      assert.deepEqual((yield* refresh({})).providers, [local]);
      assert.deepEqual(yield* refresh({ omitProviders: true }), { providers: [] });
      assert.equal(refreshes, 2);
      const cwd = yield* refresh({
        instanceId: local.instanceId,
        cwd: "/a",
        workspaceSnapshotsOnDemand: true,
        omitProviders: true,
      });
      assert.deepEqual(cwd.providers[0]?.workspaceSnapshots, [snapshotA]);
    }).pipe(Effect.scoped),
);

it.effect("an omitted provider reply requires the same authorization as a full reply", () =>
  Effect.gen(function* () {
    const { local } = makeCatalogFixture();
    let refreshes = 0;
    const client = yield* makeProviderCatalogRpc({
      providers: [local],
      cwdProviders: new Set([local.instanceId]),
      scopes: [],
      recordRefresh: () => {
        refreshes++;
      },
    });
    const denied = yield* client[WS_METHODS.serverRefreshProviders]({ omitProviders: true }).pipe(
      Effect.flip,
    );
    assert.equal(denied._tag, "EnvironmentAuthorizationError");
    assert.equal(refreshes, 0);
  }).pipe(Effect.scoped),
);

it.effect(
  "the initial config, live provider update and cwd reply agree after quota projection",
  () =>
    Effect.gen(function* () {
      const { local } = makeCatalogFixture();
      const observedUpdate = yield* Deferred.make<void>();
      const events = yield* Queue.unbounded<ServerConfigStreamEvent>();
      const live = { ...local, status: "warning" as const };
      const client = yield* makeProviderCatalogRpc({
        providers: [local],
        cwdProviders: new Set([local.instanceId]),
        providerChanges: Stream.make([live]).pipe(
          Stream.tap(() => Deferred.succeed(observedUpdate, undefined)),
          (updates) => Stream.concat(updates, Stream.never),
        ),
        projectProviders: (providers) =>
          Effect.succeed(
            providers.map((provider) => ({
              ...provider,
              usageLimits: { checkedAt: local.checkedAt, windows: [] },
            })),
          ),
      });
      yield* client[WS_METHODS.subscribeServerConfig]({
        workspaceSnapshotsOnDemand: true,
        providerCatalogsOnDemand: true,
        providerCatalogDigests: true,
        usageLimitsCommand: true,
      }).pipe(
        Stream.filter(
          (event) =>
            event.type === "snapshot" ||
            (event.type === "providerStatuses" && event.payload.providers[0]?.status === "warning"),
        ),
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const initial = yield* Queue.take(events);
      if (initial.type !== "snapshot") return yield* Effect.die("Missing initial config");
      yield* Deferred.await(observedUpdate);
      yield* TestClock.adjust("1 second");
      const updated = yield* Queue.take(events);
      if (updated.type !== "providerStatuses") return yield* Effect.die("Missing provider update");

      const reply = yield* client[WS_METHODS.serverRefreshProviders]({
        instanceId: local.instanceId,
        cwd: "/a",
        workspaceSnapshotsOnDemand: true,
        providerCatalogsOnDemand: true,
        machineCatalog: true,
        usageLimitsCommand: true,
      });
      assert.include(
        reply.providers[0]?.slashCommands.map((command) => command.name) ?? [],
        "usage-limits",
      );
      assert.equal(initial.config.providers[0]?.catalogDigest, reply.providers[0]?.catalogDigest);
      assert.equal(updated.payload.providers[0]?.catalogDigest, reply.providers[0]?.catalogDigest);
    }).pipe(Effect.scoped),
);
