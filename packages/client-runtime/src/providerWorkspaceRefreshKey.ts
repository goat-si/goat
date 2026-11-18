import type { ServerProvider } from "@goat/contracts";

type CatalogSource = Pick<
  ServerProvider,
  "catalogDigest" | "installed" | "version" | "installedVersion"
>;

export function providerWorkspaceRefreshKey(
  provider: CatalogSource | undefined,
  reply?: CatalogSource,
): string | undefined {
  if (provider === undefined) return undefined;
  const { installed, version, installedVersion } = reply ?? provider;
  return JSON.stringify({
    catalogDigest: reply?.catalogDigest ?? provider.catalogDigest,
    installed,
    version,
    installedVersion,
  });
}
