import type { ConnectionCatalogEntry } from "@goat/client-runtime/connection";
import type { HubNode } from "@goat/contracts";
import { eligibleHubNodeProfiles } from "../desktop/hubNodesImport.logic";

export function savedHubNodeProfiles(
  catalog: Iterable<ConnectionCatalogEntry>,
  nodes: readonly HubNode[],
) {
  const registered = new Set(nodes.map((node) => node.environmentId));
  return Array.from(eligibleHubNodeProfiles(catalog)).filter(
    (profile) => !registered.has(profile.environmentId),
  );
}

export {
  canRemoveHubNode,
  hubNodeLastSeenLabel,
  hubNodeRemovalInput,
  hubNodeRouteLabel,
  hubNodeStatusLabel,
  isHubNodesUnsupportedError,
} from "@goat/client-runtime/hub-nodes";
