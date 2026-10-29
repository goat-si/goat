import { composerThreadHosts } from "@goat/client-runtime/composerThreadItems";
import type { EnvironmentId } from "@goat/contracts";
import { useThreadShells } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";

export function useThreadContextHosts(environmentId: EnvironmentId | null) {
  const shells = useThreadShells();
  const snapshot = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.hubNodesLive({ environmentId, input: {} }),
  ).data;
  if (!snapshot || snapshot.hubEnvironmentId !== environmentId)
    return new Map<EnvironmentId, string>();
  const sshHosts = new Map<EnvironmentId, string>();
  for (const node of snapshot.nodes) {
    if (node.environmentId === null || node.status === "offline") continue;
    const route = node.routes.find(
      (candidate) => candidate.target.kind === "ssh" && candidate.status === "online",
    );
    if (route?.target.kind === "ssh") sshHosts.set(node.environmentId, route.target.alias);
  }
  return composerThreadHosts({
    nodes: snapshot.nodes,
    mounted: new Set(shells.map((shell) => shell.environmentId)),
    sshHosts,
  });
}
