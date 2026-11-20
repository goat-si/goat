import type { ProviderInstanceId, ServerProvider } from "@goat/contracts";
import type { ServerConfigProjection } from "./serverConfigProjection.ts";

export interface FetchedMachineCatalog {
  readonly instanceId: ProviderInstanceId;
  readonly digest: string;
  readonly slashCommands: ServerProvider["slashCommands"];
  readonly skills: ServerProvider["skills"];
}

export function withHeldProviderCatalogs(
  previous: ReadonlyArray<ServerProvider> | undefined,
  next: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> {
  if (previous === undefined || !next.some((provider) => provider.catalogDigest !== undefined)) {
    return next;
  }
  const held = new Map(previous.map((provider) => [provider.instanceId, provider]));
  return next.map((provider) => {
    if (provider.catalogDigest === undefined || provider.loadedCatalogDigest !== undefined) {
      return provider;
    }
    const catalog = held.get(provider.instanceId);
    return catalog === undefined
      ? provider
      : {
          ...provider,
          slashCommands: catalog.slashCommands,
          skills: catalog.skills,
          ...(catalog.loadedCatalogDigest === undefined
            ? {}
            : { loadedCatalogDigest: catalog.loadedCatalogDigest }),
        };
  });
}

// The server diffs against the lists it sent, so held lists cannot be its delta base.
export function wireProviderCatalogs(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> {
  if (!providers.some((provider) => provider.catalogDigest !== undefined)) return providers;
  return providers.map((provider) => {
    if (provider.catalogDigest === undefined) return provider;
    const { loadedCatalogDigest: _loaded, ...rest } = provider;
    return { ...rest, slashCommands: [], skills: [] };
  });
}

export function withFetchedMachineCatalogs(
  projection: ServerConfigProjection,
  catalogs: ReadonlyArray<FetchedMachineCatalog>,
): ServerConfigProjection {
  if (catalogs.length === 0) return projection;
  let changed = false;
  const providers = projection.config.providers.map((provider) => {
    const catalog = catalogs.find((entry) => entry.instanceId === provider.instanceId);
    if (
      catalog === undefined ||
      catalog.digest !== provider.catalogDigest ||
      provider.loadedCatalogDigest === catalog.digest
    ) {
      return provider;
    }
    changed = true;
    return {
      ...provider,
      slashCommands: catalog.slashCommands,
      skills: catalog.skills,
      loadedCatalogDigest: catalog.digest,
    };
  });
  return changed ? { ...projection, config: { ...projection.config, providers } } : projection;
}
