import { composerThreadHosts } from "@goat/client-runtime/composerThreadItems";
import type { EnvironmentId } from "@goat/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { environmentThreadShells } from "../state/threads";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";

const EMPTY_MOUNTED: ReadonlySet<EnvironmentId> = new Set<EnvironmentId>();
const EMPTY_THREAD_ENVIRONMENTS = Atom.make(EMPTY_MOUNTED);

export function useThreadContextHosts(environmentId: EnvironmentId | null) {
  const mounted = useAtomValue(
    environmentId === null
      ? EMPTY_THREAD_ENVIRONMENTS
      : environmentThreadShells.threadEnvironmentIdsAtom,
  );
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
    mounted,
    sshHosts,
  });
}
