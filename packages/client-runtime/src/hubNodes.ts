import type { HubNode, HubNodeRoute, HubNodesRemoveInput } from "@goat/contracts";

export const HUB_NODE_IMPORT_NOTICE =
  "Saved devices on this desktop couldn't be unlocked, so none were imported. Add your devices here.";

export function hubNodeStatusLabel(status: HubNode["status"]): string {
  return { online: "Online", offline: "Offline", unknown: "Not checked" }[status];
}

export function hubNodeLastSeenLabel(lastSeenAt: string | null, now: number): string | null {
  if (lastSeenAt === null) return null;
  const elapsed = Math.max(0, now - Date.parse(lastSeenAt));
  if (!Number.isFinite(elapsed)) return null;
  const minutes = Math.floor(elapsed / 60_000);
  const relative =
    minutes < 1
      ? "just now"
      : minutes < 60
        ? `${minutes}m ago`
        : minutes < 1440
          ? `${Math.floor(minutes / 60)}h ago`
          : `${Math.floor(minutes / 1440)}d ago`;
  return `last seen ${relative}`;
}

export function hubNodeRouteLabel(route: HubNodeRoute): string {
  switch (route.target.kind) {
    case "ssh":
      return `SSH ${route.target.alias}`;
    case "linked":
      return `GOAT ${route.target.name}`;
    case "cloud":
      return `Cloud ${route.target.alias}`;
  }
}

export function canRemoveHubNode(node: Pick<HubNode, "routes">): boolean {
  return node.routes.some((route) => route.target.kind !== "cloud");
}

export function hubNodeRemovalInput(node: HubNode): HubNodesRemoveInput {
  // A cloud route is owned by Boat; mixed nodes must remove a specific other route.
  const route = node.routes.some((route) => route.target.kind === "cloud")
    ? node.routes.find((route) => route.target.kind !== "cloud")
    : undefined;
  return { nodeId: node.nodeId, ...(route ? { routeId: route.routeId } : {}) };
}

export function isHubNodesUnsupportedError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const visited = new Set<unknown>();
  while (pending.length > 0 && visited.size < 40) {
    const value = pending.pop();
    if (value === null || value === undefined || visited.has(value)) continue;
    visited.add(value);
    if (typeof value === "string") {
      if (/^Unknown request tag: hub\.nodes\.[a-z]+$/iu.test(value)) return true;
    } else if (typeof value === "object") {
      for (const key of ["message", "reason", "cause", "defect", "error", "reasons"]) {
        if (key in value) pending.push(Reflect.get(value, key));
      }
      if (Array.isArray(value)) pending.push(...value);
    }
  }
  return false;
}
