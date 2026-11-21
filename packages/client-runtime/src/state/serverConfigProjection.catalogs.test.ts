import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
} from "@goat/contracts";
import * as Option from "effect/Option";
import { expect, it } from "vite-plus/test";
import { recordFetchedWorkspaceSnapshot, withFetchedWorkspaceSnapshots } from "./server.ts";
import { applyServerConfigProjection } from "./serverConfigProjection.ts";
import { withFetchedMachineCatalogs } from "./serverProviderCatalog.ts";

const instanceId = ProviderInstanceId.make("codex");
const models: ServerProvider["models"] = [];
const wire = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-19T00:00:00.000Z",
  models,
  slashCommands: [],
  skills: [],
} as const satisfies ServerProvider;

const held = {
  ...wire,
  catalogDigest: "A",
  loadedCatalogDigest: "A",
  slashCommands: [{ name: "held-command" }],
};

const config = (provider: ServerProvider): ServerConfig =>
  ({
    providers: [provider],
    environment: { capabilities: {} },
  }) as unknown as ServerConfig;

const snapshot = (provider: ServerProvider) =>
  ({ version: 1, type: "snapshot", config: config(provider) }) as const;

it("marks a held catalog stale after a digest delta and accepts full lists from an older server", () => {
  const current = applyServerConfigProjection(Option.none(), snapshot(held));
  const { slashCommands: _commands, skills: _skills, models: _models, ...fields } = wire;
  const next = applyServerConfigProjection(current, {
    version: 1,
    type: "providerStatusChanges",
    payload: {
      instanceIds: [instanceId],
      changedInstanceIds: [instanceId],
      providers: [{ ...fields, catalogDigest: "B" }],
    },
  });
  expect(Option.getOrThrow(next).config.providers[0]).toMatchObject({
    ...held,
    catalogDigest: "B",
  });
  const legacy = { ...wire, slashCommands: [{ name: "legacy-command", description: "Help" }] };
  expect(
    Option.getOrThrow(applyServerConfigProjection(next, snapshot(legacy))).config.providers,
  ).toEqual([legacy]);
});

it("drops held lists when a provider loses its cwd capability and the wire lists are empty", () => {
  const current = applyServerConfigProjection(Option.none(), snapshot(held));
  const { slashCommands: _commands, skills: _skills, models: _models, ...fields } = wire;
  const next = applyServerConfigProjection(current, {
    version: 1,
    type: "providerStatusChanges",
    payload: { instanceIds: [instanceId], changedInstanceIds: [instanceId], providers: [fields] },
  });
  expect(Option.getOrThrow(next).config.providers).toEqual([wire]);
});

it("keeps loaded lists for the same digest and joins only a matching cwd reply", () => {
  const current = applyServerConfigProjection(Option.none(), snapshot(held));
  const same = applyServerConfigProjection(current, snapshot({ ...wire, catalogDigest: "A" }));
  expect(Option.getOrThrow(same).config.providers).toEqual([held]);

  const next = Option.getOrThrow(
    applyServerConfigProjection(same, snapshot({ ...wire, catalogDigest: "B" })),
  );
  const catalog = {
    instanceId,
    digest: "B",
    slashCommands: [{ name: "fresh-command" }],
    skills: [],
  };
  expect(withFetchedMachineCatalogs(next, [{ ...catalog, digest: "A" }])).toBe(next);
  expect(withFetchedMachineCatalogs(next, [catalog]).config.providers[0]).toMatchObject({
    catalogDigest: "B",
    loadedCatalogDigest: "B",
    slashCommands: [{ name: "fresh-command" }],
  });
});

it("a changed digest retires the cwd snapshot while loading a digest preserves it", () => {
  const cwd = "/workspace";
  const workspaceSnapshot = { cwd, checkedAt: wire.checkedAt, slashCommands: [], skills: [] };
  const old = { ...wire, catalogDigest: "A" };
  const fetched = recordFetchedWorkspaceSnapshot(
    [],
    { instanceId, cwd, fresh: false },
    [{ ...wire, workspaceSnapshots: [workspaceSnapshot] }],
    old,
  );
  const configWith = (provider: ServerProvider) => {
    const base = config(provider);
    return {
      ...base,
      environment: {
        ...base.environment,
        capabilities: { providerWorkspaceSnapshotsOnDemand: true, repositoryIdentity: false },
      },
    };
  };
  expect(
    withFetchedWorkspaceSnapshots(configWith(held), fetched).providers[0]?.workspaceSnapshots,
  ).toEqual([workspaceSnapshot]);
  expect(
    withFetchedWorkspaceSnapshots(configWith({ ...held, catalogDigest: "B" }), fetched).providers[0]
      ?.workspaceSnapshots,
  ).toBeUndefined();
});

it.each([
  ["installed state", { installed: false }],
  ["reported version", { version: "2.0.0" }],
  ["installed CLI version", { installedVersion: "2.0.0" }],
] as const)(
  "uses the cwd reply's %s even when the machine digest is unchanged",
  (_label, change) => {
    const cwd = "/workspace";
    const old = { ...wire, catalogDigest: "A", installedVersion: "1.0.0" };
    const updated = { ...old, ...change };
    const configWith = (provider: ServerProvider) => {
      const base = config(provider);
      return {
        ...base,
        environment: {
          ...base.environment,
          capabilities: { providerWorkspaceSnapshotsOnDemand: true, repositoryIdentity: false },
        },
      };
    };
    const target = { instanceId, cwd, fresh: false };
    const before = {
      cwd,
      checkedAt: wire.checkedAt,
      slashCommands: [{ name: "before" }],
      skills: [],
    };
    const after = { ...before, slashCommands: [{ name: "after" }] };
    const fetched = recordFetchedWorkspaceSnapshot(
      [],
      target,
      [{ ...old, workspaceSnapshots: [before] }],
      old,
    );
    expect(
      withFetchedWorkspaceSnapshots(configWith(old), fetched).providers[0]?.workspaceSnapshots,
    ).toEqual([before]);
    expect(
      withFetchedWorkspaceSnapshots(configWith(updated), fetched).providers[0]?.workspaceSnapshots,
    ).toBeUndefined();

    // The RPC can report the installation change before the config stream does.
    const refreshed = recordFetchedWorkspaceSnapshot(
      fetched,
      target,
      [{ ...updated, workspaceSnapshots: [after] }],
      old,
    );
    expect(
      withFetchedWorkspaceSnapshots(configWith(old), refreshed).providers[0]?.workspaceSnapshots,
    ).toBeUndefined();
    expect(
      withFetchedWorkspaceSnapshots(configWith(updated), refreshed).providers[0]
        ?.workspaceSnapshots,
    ).toEqual([after]);
  },
);

it("drops a fetched workspace snapshot when the server rescan revision changes", () => {
  const cwd = "/workspace";
  const before = { cwd, checkedAt: wire.checkedAt, slashCommands: [], skills: [] };
  const fetched = recordFetchedWorkspaceSnapshot(
    [],
    { instanceId, cwd, fresh: false },
    [{ ...wire, workspaceSnapshots: [before] }],
    wire,
  );
  const configWith = (provider: ServerProvider) => ({
    ...config(provider),
    environment: {
      ...config(provider).environment,
      capabilities: { providerWorkspaceSnapshotsOnDemand: true, repositoryIdentity: false },
    },
  });
  expect(
    withFetchedWorkspaceSnapshots(configWith(wire), fetched).providers[0]?.workspaceSnapshots,
  ).toEqual([before]);
  expect(
    withFetchedWorkspaceSnapshots(
      configWith({ ...wire, workspaceRescannedAt: "2026-11-20T00:00:00.000Z" }),
      fetched,
    ).providers[0]?.workspaceSnapshots,
  ).toBeUndefined();
});
