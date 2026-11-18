import type { ProviderInstanceId, ServerProvider } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { ProviderInstanceRegistry } from "./provider/ProviderInstanceRegistry.ts";

export function withoutWorkspaceSnapshots(providers: ReadonlyArray<ServerProvider>) {
  return providers.map(({ workspaceSnapshots: _workspaceSnapshots, ...provider }) => provider);
}

export type ProviderConfigProjection = (
  providers: ReadonlyArray<ServerProvider>,
) => Effect.Effect<ReadonlyArray<ServerProvider>>;

export function makeProviderConfigProjection(
  input: {
    readonly workspaceSnapshotsOnDemand?: boolean;
    readonly providerCatalogsOnDemand?: boolean;
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
      return withoutWorkspaceSnapshots(providers).map((provider) =>
        catalogs.has(provider.instanceId)
          ? {
              ...provider,
              slashCommands: provider.slashCommands.map(({ name }) => ({ name })),
              skills: provider.skills.map(
                ({ description: _d, shortDescription: _s, ...skill }) => skill,
              ),
            }
          : provider,
      );
    });
}

export function workspaceProviderReply(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId,
  cwd: string,
  catalogOnDemand: boolean,
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
