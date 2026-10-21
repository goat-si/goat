import {
  connectionRoutes,
  isDesktopLocalConnectionTarget,
  type ConnectionCatalogEntry,
} from "@goat/client-runtime/connection";
import {
  hasCloudMachineAliasPrefix,
  type HubNodeImportProfile,
  type HubNodesImportInput,
} from "@goat/contracts";
import * as Option from "effect/Option";

export function* eligibleHubNodeProfiles(
  catalog: Iterable<ConnectionCatalogEntry>,
): Generator<HubNodeImportProfile> {
  for (const entry of catalog) {
    const routes = connectionRoutes(entry);
    if (
      !entry.enabled ||
      routes.some(
        ({ target }) =>
          target._tag === "PrimaryConnectionTarget" || isDesktopLocalConnectionTarget(target),
      )
    )
      continue;
    for (const route of routes) {
      const profile = Option.getOrNull(route.profile);
      if (
        profile?._tag !== "SshConnectionProfile" ||
        hasCloudMachineAliasPrefix(profile.target.alias)
      )
        continue;
      yield {
        environmentId: entry.target.environmentId,
        label: (entry.target.label.trim() || profile.target.alias).slice(0, 120),
        ssh: {
          alias: profile.target.alias,
          hostname: profile.target.hostname,
          username: profile.target.username,
          port: profile.target.port,
        },
      };
    }
  }
}

export function catalogToImportInput(
  catalog: Iterable<ConnectionCatalogEntry>,
): HubNodesImportInput {
  const profiles: HubNodeImportProfile[] = [];
  for (const profile of eligibleHubNodeProfiles(catalog)) {
    profiles.push(profile);
    if (profiles.length === 500) break;
  }
  return { source: "desktop-catalog", catalog: { state: "readable", profiles } };
}
