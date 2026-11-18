// @effect-diagnostics-next-line nodeBuiltinImport:off -- The digest is part of a synchronous projection.
import * as NodeCrypto from "node:crypto";
import type { ProviderInstanceId, ServerProvider } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { ProviderInstanceRegistry } from "./provider/ProviderInstanceRegistry.ts";

export function withoutWorkspaceSnapshots(providers: ReadonlyArray<ServerProvider>) {
  return providers.map(({ workspaceSnapshots: _workspaceSnapshots, ...provider }) => provider);
}

function machineCatalogNames(provider: ServerProvider) {
  return {
    slashCommands: provider.slashCommands.map(({ name }) => ({ name })),
    skills: provider.skills.map(({ description: _d, shortDescription: _s, ...skill }) => skill),
  };
}

function machineCatalogDigest(provider: ServerProvider) {
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify([provider.slashCommands, provider.skills]))
    .digest("hex")
    .slice(0, 16);
}

export type ProviderConfigProjection = (
  providers: ReadonlyArray<ServerProvider>,
) => Effect.Effect<ReadonlyArray<ServerProvider>>;

export function makeProviderConfigProjection(
  input: {
    readonly workspaceSnapshotsOnDemand?: boolean;
    readonly providerCatalogsOnDemand?: boolean;
    readonly providerCatalogDigests?: boolean;
  },
  instances: ProviderInstanceRegistry["Service"]["listInstances"],
): ProviderConfigProjection {
  if (!input.workspaceSnapshotsOnDemand) return Effect.succeed;
  if (!input.providerCatalogsOnDemand) {
    return (providers) => Effect.succeed(withoutWorkspaceSnapshots(providers));
  }
  return (providers) =>
    Effect.map(instances, (current) => {
      const catalogs = new Set(
        current
          .filter((instance) => instance.snapshotForCwd !== undefined)
          .map((instance) => instance.instanceId),
      );
      return withoutWorkspaceSnapshots(providers).map((provider) => {
        if (!catalogs.has(provider.instanceId)) return provider;
        return input.providerCatalogDigests
          ? {
              ...provider,
              slashCommands: [],
              skills: [],
              catalogDigest: machineCatalogDigest(provider),
            }
          : { ...provider, ...machineCatalogNames(provider) };
      });
    });
}

export function workspaceProviderReply(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId,
  cwd: string,
  catalogOnDemand: boolean,
  includeMachineCatalog: boolean,
) {
  return providers
    .filter((provider) => provider.instanceId === instanceId)
    .map((provider) => {
      const snapshots = (provider.workspaceSnapshots ?? []).filter(
        (snapshot) => snapshot.cwd === cwd,
      );
      return {
        ...provider,
        models: [],
        slashCommands: [],
        skills: [],
        ...(catalogOnDemand && includeMachineCatalog
          ? { ...machineCatalogNames(provider), catalogDigest: machineCatalogDigest(provider) }
          : {}),
        workspaceSnapshots:
          snapshots.length > 0 || !catalogOnDemand
            ? snapshots
            : [
                {
                  cwd,
                  checkedAt: provider.checkedAt,
                  slashCommands: provider.slashCommands,
                  slashCommandsPending: true,
                  skills: provider.skills,
                },
              ],
      };
    });
}
