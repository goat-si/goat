import type { HostStatusEntry, HubNode, OpenCodexChildBootstrapStatus } from "@goat/contracts";

import type { HubDevice, HubSnapshot } from "./state/hubFleet.ts";

/**
 * Settings → Hub's one device list: the machines the hub reaches (hub nodes) and the machines
 * linked to its OpenCodex (hub devices), joined by name, with the Home's progress making a cloud
 * machine its Child. Web and mobile render the same rows.
 */

export type ChildSetupReason = NonNullable<OpenCodexChildBootstrapStatus["reason"]>;

export interface ChildSetup {
  readonly state: Exclude<OpenCodexChildBootstrapStatus["state"], "child">;
  readonly tone: "progress" | "warning" | "destructive";
  /** "OpenCodex Child setup blocked: npm missing". */
  readonly label: string;
  /** What the Home said happened, when it said. */
  readonly detail: string | null;
  readonly checkedAt: number;
}

const CHILD_REASON_LABEL: Record<ChildSetupReason, string> = {
  home_unavailable: "the hub's OpenCodex cannot install it",
  platform_unsupported: "platform not supported",
  npm_missing: "npm missing",
  install_failed: "install failed",
  ocx_unusable: "OpenCodex does not run there",
  runtime_unhealthy: "OpenCodex not answering",
  unreachable: "machine unreachable",
  link_failed: "link failed",
};

const CHILD_STATE = {
  running: { tone: "progress", label: "Setting up as OpenCodex Child" },
  degraded: { tone: "warning", label: "OpenCodex Child degraded" },
  blocked: { tone: "destructive", label: "OpenCodex Child setup blocked" },
} as const satisfies Record<ChildSetup["state"], Pick<ChildSetup, "tone" | "label">>;

/** Null once the machine is a Child, and for hosts whose Home never set one up or predates it. */
export function presentChildSetup(
  status: OpenCodexChildBootstrapStatus | undefined,
): ChildSetup | null {
  if (status === undefined || status.state === "child") return null;
  const { tone, label } = CHILD_STATE[status.state];
  const reason = status.reason === undefined ? null : CHILD_REASON_LABEL[status.reason];
  return {
    state: status.state,
    tone,
    label: reason === null ? label : `${label}: ${reason}`,
    detail: status.message?.trim() || null,
    checkedAt: status.checkedAt,
  };
}

export interface HubDeviceRow {
  readonly key: string;
  readonly label: string;
  /** The hub's own record of the machine; null when only OpenCodex or host status names it. */
  readonly node: HubNode | null;
  /** The machine as the hub's OpenCodex sees it; null when it is not linked or not read. */
  readonly device: HubDevice | null;
  readonly childSetup: ChildSetup | null;
}

function routeNames(node: HubNode): ReadonlyArray<string> {
  return node.routes.map((route) =>
    route.target.kind === "linked" ? route.target.name : route.target.alias,
  );
}

/**
 * One row per machine. A route's SSH or cloud alias or link name matches first; a node's label
 * matches only when no route and no other node claims that name, so a label that happens to equal
 * another machine's alias never merges two machines. Hub nodes keep the server's order, then
 * OpenCodex-only devices, then machines only the Home's setup record names.
 */
export function hubDeviceList(input: {
  readonly nodes: ReadonlyArray<HubNode> | null;
  readonly snapshot: HubSnapshot | null;
  readonly hosts: ReadonlyArray<HostStatusEntry>;
}): ReadonlyArray<HubDeviceRow> {
  const nodes = input.nodes ?? [];
  const byRoute = new Map<string, HubNode>();
  for (const node of nodes) {
    for (const name of routeNames(node)) if (!byRoute.has(name)) byRoute.set(name, node);
  }
  const byLabel = new Map<string, HubNode | null>();
  for (const node of nodes) byLabel.set(node.label, byLabel.has(node.label) ? null : node);
  const nodeNamed = (name: string) =>
    byRoute.get(name) ?? (byRoute.has(name) ? undefined : (byLabel.get(name) ?? undefined));

  const setupByHost = new Map<string, OpenCodexChildBootstrapStatus>();
  for (const entry of input.hosts) {
    if (entry.host !== null && entry.opencodexChild !== undefined)
      setupByHost.set(entry.host, entry.opencodexChild);
  }
  const claimedHosts = new Set<string>();
  const childSetupFor = (names: ReadonlyArray<string>) => {
    for (const name of names) claimedHosts.add(name);
    const name = names.find((candidate) => setupByHost.has(candidate));
    return name === undefined ? null : presentChildSetup(setupByHost.get(name));
  };

  const deviceOf = new Map<HubNode, HubDevice>();
  const unmatched: HubDevice[] = [];
  for (const device of input.snapshot?.devices ?? []) {
    const node = nodeNamed(device.alias);
    if (node === undefined || deviceOf.has(node)) unmatched.push(device);
    else deviceOf.set(node, device);
  }

  const rows: HubDeviceRow[] = nodes.map((node) => {
    const device = deviceOf.get(node) ?? null;
    return {
      key: `node:${node.nodeId}`,
      label: node.label,
      node,
      device,
      childSetup: childSetupFor([
        ...routeNames(node),
        node.label,
        ...(device === null ? [] : [device.alias]),
      ]),
    };
  });
  for (const device of unmatched) {
    rows.push({
      key: `device:${device.alias}`,
      label: device.alias,
      node: null,
      device,
      childSetup: childSetupFor([device.alias]),
    });
  }
  for (const [host, status] of setupByHost) {
    const childSetup = claimedHosts.has(host) ? null : presentChildSetup(status);
    if (childSetup !== null)
      rows.push({ key: `setup:${host}`, label: host, node: null, device: null, childSetup });
  }
  return rows;
}
