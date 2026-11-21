// @effect-diagnostics-next-line nodeBuiltinImport:off -- The digest is part of a synchronous projection.
import * as NodeCrypto from "node:crypto";
import type {
  ProviderInstanceId,
  ServerProvider,
  UsageLimitSourceSnapshots,
} from "@goat/contracts";
import { withUsageLimitsCommands } from "@goat/shared/usageLimits";
import * as Effect from "effect/Effect";
import type { ProviderInstanceRegistry } from "./provider/ProviderInstanceRegistry.ts";
import type { UsageLimitSources } from "./usage/UsageLimitSources.ts";

function withoutWorkspaceSnapshots(providers: ReadonlyArray<ServerProvider>) {
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

export function makeProviderReplyProjection(
  quotaProjection: UsageLimitSources["Service"]["projectProviders"],
) {
  return (
    catalogProjection: ProviderConfigProjection = Effect.succeed,
    sources?: Effect.Effect<UsageLimitSourceSnapshots>,
  ): ProviderConfigProjection =>
    (providers) =>
      quotaProjection(providers).pipe(
        Effect.flatMap((projected) =>
          sources === undefined
            ? catalogProjection(projected)
            : sources.pipe(
                Effect.flatMap((current) =>
                  catalogProjection(withUsageLimitsCommands(projected, current)),
                ),
              ),
        ),
      );
}

export function makeProviderRefreshProjection(
  input: {
    readonly instanceId?: ProviderInstanceId | undefined;
    readonly cwd?: string | undefined;
    readonly workspaceSnapshotsOnDemand?: boolean | undefined;
    readonly providerCatalogsOnDemand?: boolean | undefined;
    readonly machineCatalog?: boolean | undefined;
  },
  getInstance: ProviderInstanceRegistry["Service"]["getInstance"],
): ProviderConfigProjection {
  if (!input.workspaceSnapshotsOnDemand) return Effect.succeed;
  const { instanceId, cwd } = input;
  if (instanceId === undefined || cwd === undefined) {
    return (providers) => Effect.succeed(withoutWorkspaceSnapshots(providers));
  }
  const catalogOnDemand = input.providerCatalogsOnDemand
    ? getInstance(instanceId).pipe(Effect.map((instance) => instance?.snapshotForCwd !== undefined))
    : Effect.succeed(false);
  return (providers) =>
    catalogOnDemand.pipe(
      Effect.map((scanCatalog) =>
        workspaceProviderReply(
          providers,
          instanceId,
          cwd,
          scanCatalog,
          input.machineCatalog === true,
        ),
      ),
    );
}

export function makeProviderConfigProjection(
  input: {
    readonly workspaceSnapshotsOnDemand?: boolean | undefined;
    readonly providerCatalogsOnDemand?: boolean | undefined;
    readonly providerCatalogDigests?: boolean | undefined;
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

function workspaceProviderReply(
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
