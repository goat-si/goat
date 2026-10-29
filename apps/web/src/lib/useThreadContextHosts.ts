import { useAtomValue } from "@effect/atom-react";
import { composerThreadHosts } from "@goat/client-runtime/composerThreadItems";
import type { EnvironmentId } from "@goat/contracts";
import { environmentCatalog } from "~/connection/catalog";
import { useThreadShells } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { resolveThreadContextRoute } from "./threadContextRoute";

export function useThreadContextHosts(environmentId: EnvironmentId, active = true) {
  const entries = useAtomValue(environmentCatalog.catalogValueAtom).entries;
  const shells = useThreadShells(active);
  const snapshot = useEnvironmentQuery(
    active ? serverEnvironment.hubNodesLive({ environmentId, input: {} }) : null,
  ).data;
  if (!snapshot || snapshot.hubEnvironmentId !== environmentId)
    return new Map<EnvironmentId, string>();
  const sshHosts = new Map<EnvironmentId, string>();
  for (const id of entries.keys()) {
    const route = resolveThreadContextRoute({
      agentEnvironmentId: environmentId,
      threadEnvironmentId: id,
      entries,
      isDesktopRenderer: window.desktopBridge !== undefined,
    });
    if (route.kind === "ssh") sshHosts.set(id, route.host);
  }
  return composerThreadHosts({
    nodes: snapshot.nodes,
    mounted: new Set(shells.map((shell) => shell.environmentId)),
    sshHosts,
  });
}
