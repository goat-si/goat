import type {
  EnvironmentId,
  HubNode,
  HubNodeNotice,
  HubNodeRoute,
  HubNodesSnapshot,
} from "@goat/contracts";
import type { LinkedHost } from "../linkedHosts/LinkedHosts.ts";
import type { CloudMachineService } from "../cloudMachines/CloudMachineService.ts";
import type { Registration, RouteState } from "./HubNodeRepository.ts";
import type * as Effect from "effect/Effect";

type CloudCatalog = Effect.Success<CloudMachineService["Service"]["catalog"]>;

export function mergeHubNodes(input: {
  readonly hubEnvironmentId: EnvironmentId;
  readonly registrations: ReadonlyArray<Registration>;
  readonly linked: ReadonlyArray<LinkedHost>;
  readonly cloud: CloudCatalog;
  readonly routeState: ReadonlyArray<RouteState>;
  readonly notices: ReadonlyArray<HubNodeNotice>;
}): HubNodesSnapshot {
  const states = new Map(input.routeState.map((row) => [row.routeId, row]));
  const groups = new Map<
    string,
    Array<{
      route: HubNodeRoute;
      environmentId: EnvironmentId | null;
      label: string | null;
      registration?: Registration;
    }>
  >();
  const add = (
    routeId: string,
    source: HubNodeRoute["source"],
    target: HubNodeRoute["target"],
    identity: EnvironmentId | null,
    label: string | null,
    registration?: Registration,
  ) => {
    const cached = states.get(routeId);
    // A relink can reuse a name for another environment; its old probe no longer describes it.
    const state =
      source === "linked-host" && cached?.environmentId !== identity ? undefined : cached;
    const environmentId = source === "linked-host" ? identity : (state?.environmentId ?? identity);
    if (environmentId === input.hubEnvironmentId) return;
    const key = environmentId ?? `route:${routeId}`;
    const group = groups.get(key) ?? [];
    group.push({
      route: {
        routeId,
        source,
        target,
        status: state?.status ?? "unknown",
        checkedAt: state?.checkedAt ?? null,
        lastSeenAt: state?.lastSeenAt ?? null,
        lastError: state?.lastError ?? null,
      },
      environmentId,
      label,
      ...(registration ? { registration } : {}),
    });
    groups.set(key, group);
  };
  for (const row of input.registrations)
    add(row.routeId, "registered", row.target, row.environmentId, row.label, row);
  for (const row of input.linked)
    add(
      `linked:${row.name}`,
      "linked-host",
      {
        kind: "linked",
        name: row.name,
        baseUrl: row.baseUrl,
        access: row.access,
        expiresAt: row.expiresAt,
      },
      row.environmentId as EnvironmentId,
      row.label,
    );
  for (const row of input.cloud)
    add(
      `cloud:${row.alias}`,
      "cloud-machine",
      { kind: "cloud", alias: row.alias },
      null,
      row.label,
    );
  const rank = { ssh: 0, linked: 1, cloud: 2 };
  const nodes: HubNode[] = [];
  for (const [nodeId, group] of groups) {
    group.sort(
      (a, b) =>
        rank[a.route.target.kind] - rank[b.route.target.kind] ||
        a.route.routeId.localeCompare(b.route.routeId),
    );
    const first = group[0]!;
    const routes = group.map(({ route }) => route);
    const registration = group
      .flatMap((row) => (row.registration ? [row.registration] : []))
      .toSorted(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.routeId.localeCompare(b.routeId),
      )[0];
    const fallback =
      first.route.target.kind === "linked" ? first.route.target.name : first.route.target.alias;
    nodes.push({
      nodeId,
      environmentId: first.environmentId,
      label: group.find((row) => row.label)?.label ?? fallback,
      kind: first.route.target.kind,
      routes,
      status: routes.some((route) => route.status === "online")
        ? "online"
        : routes.every((route) => route.checkedAt !== null && route.status === "offline")
          ? "offline"
          : "unknown",
      lastSeenAt:
        routes
          .flatMap((route) => (route.lastSeenAt ? [route.lastSeenAt] : []))
          .sort()
          .at(-1) ?? null,
      addedBy: registration?.addedBy ?? null,
    });
  }
  nodes.sort((a, b) => a.label.localeCompare(b.label) || a.nodeId.localeCompare(b.nodeId));
  return { hubEnvironmentId: input.hubEnvironmentId, nodes, notices: input.notices };
}
