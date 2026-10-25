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
  consent_revoked: "turned off because the session that allowed it lost access",
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
  /**
   * Whether the hub joins this SSH host as its Child after each successful setup. Null when the
   * hub does not offer it for the host: a cloud machine, a host GOAT did not set up, or an older hub.
   */
  readonly childOptIn: boolean | null;
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
  const labelled = (name: string) =>
    byRoute.has(name) ? undefined : (byLabel.get(name) ?? undefined);

  // Route aliases claim devices before any label does, whatever order the devices come in.
  const deviceOf = new Map<HubNode, HubDevice>();
  const devices = input.snapshot?.devices ?? [];
  for (const device of devices) {
    const node = byRoute.get(device.alias);
    if (node !== undefined && !deviceOf.has(node)) deviceOf.set(node, device);
  }
  const placed = new Set(deviceOf.values());
  for (const device of devices) {
    if (placed.has(device)) continue;
    const node = labelled(device.alias);
    if (node !== undefined && !deviceOf.has(node)) {
      deviceOf.set(node, device);
      placed.add(device);
    }
  }

  const rows: HubDeviceRow[] = nodes.map((node) => ({
    key: `node:${node.nodeId}`,
    label: node.label,
    node,
    device: deviceOf.get(node) ?? null,
    childSetup: null,
    childOptIn: null,
  }));
  for (const device of devices) {
    if (!placed.has(device))
      rows.push({
        key: `device:${device.alias}`,
        label: device.alias,
        node: null,
        device,
        childSetup: null,
        childOptIn: null,
      });
  }

  // Each host's setup belongs to exactly one row, by the same rule: route, unique label, device.
  const rowOf = (host: string) => {
    const node = byRoute.get(host) ?? labelled(host);
    if (node !== undefined) return rows.findIndex((row) => row.node === node);
    return rows.findIndex((row) => row.node === null && row.device?.alias === host);
  };
  for (const entry of input.hosts) {
    if (entry.host === null) continue;
    const childSetup = presentChildSetup(entry.opencodexChild);
    const childOptIn = entry.opencodexChildOptIn ?? null;
    if (childSetup === null && childOptIn === null) continue;
    const index = rowOf(entry.host);
    const row = rows[index];
    if (index === -1)
      rows.push({
        key: `setup:${entry.host}`,
        label: entry.host,
        node: null,
        device: null,
        childSetup,
        childOptIn,
      });
    else if (row !== undefined)
      rows[index] = {
        ...row,
        childSetup: row.childSetup ?? childSetup,
        childOptIn: row.childOptIn ?? childOptIn,
      };
  }
  return rows;
}

/**
 * Checks a saved cloud auto-join switch against what the hub answered. An older hub has no switch:
 * its answer decodes as on, which is true there, since it always joins its cloud machines.
 */
export function cloudAutoJoinSaveError(requested: boolean, saved: boolean): string | null {
  return requested === saved
    ? null
    : "This hub runs an older GOAT that always joins its cloud machines. Update GOAT there to turn this off.";
}
