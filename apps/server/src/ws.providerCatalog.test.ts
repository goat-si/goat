import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, WS_METHODS } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { makeProviderCatalogRpc } from "./wsProviderCatalog.testkit.ts";
import { makeWorkspaceProviderFixture } from "./wsProviderFixture.testkit.ts";

function makeCatalogFixture() {
  const { provider } = makeWorkspaceProviderFixture();
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
  return { local, registryAgent };
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
