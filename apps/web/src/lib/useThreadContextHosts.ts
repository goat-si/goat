import { useAtomValue } from "@effect/atom-react";
import { composerThreadHosts } from "@goat/client-runtime/composerThreadItems";
import type { EnvironmentId } from "@goat/contracts";
import { environmentCatalog } from "~/connection/catalog";
import { environmentThreadShells } from "~/state/threads";
import { Atom } from "effect/reactivity";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { resolveThreadContextRoute } from "./threadContextRoute";

const EMPTY_MOUNTED: ReadonlySet<EnvironmentId> = new Set<EnvironmentId>();
const EMPTY_THREAD_ENVIRONMENTS = Atom.make(EMPTY_MOUNTED);

export function useThreadContextHosts(environmentId: EnvironmentId, active = true) {
  const entries = useAtomValue(environmentCatalog.catalogValueAtom).entries;
  const mounted = useAtomValue(
    active ? environmentThreadShells.threadEnvironmentIdsAtom : EMPTY_THREAD_ENVIRONMENTS,
  );
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
    mounted,
    sshHosts,
  });
}
