import {
  childReadyProofIsCurrent,
  withoutUnprovenReady,
  type ChildReadyNextAction,
  type ChildReadyStep,
  type HostStatusEntry,
  type HubNode,
  type OpenCodexChildBootstrapStatus,
  type OpenCodexChildSetup,
} from "@goat/contracts";

import type { HubDevice, HubSnapshot } from "./state/hubFleet.ts";

/**
 * Settings → Hub's one device list: the machines the hub reaches (hub nodes) and the machines
 * linked to its OpenCodex (hub devices), joined by name, with the Home's progress making a cloud
 * machine its Child. Web and mobile render the same rows.
 */

export type ChildSetupReason = NonNullable<OpenCodexChildBootstrapStatus["reason"]>;
type ChildSetupStepOutcome = OpenCodexChildSetup["steps"][number]["state"];

export interface ChildSetup {
  readonly state: OpenCodexChildBootstrapStatus["state"];
  readonly tone: "progress" | "success" | "warning" | "destructive";
  /** "OpenCodex Child setup blocked: npm missing", "Linked · Codex not verified", "Ready". */
  readonly label: string;
  /** What the Home said happened, when it said. */
  readonly detail: string | null;
  readonly checkedAt: number;
  /** The SSH alias the Home's setup command takes; never a display label. */
  readonly host: string | null;
  readonly steps: ReadonlyArray<{
    readonly label: string;
    readonly outcome: ChildSetupStepOutcome;
  }>;
  readonly nextAction: ChildReadyNextAction;
  /** Whether nextAction is a command this client may send; guidance is never actionable. */
  readonly actionable: boolean;
  /** The button for an actionable nextAction. */
  readonly actionLabel: string | null;
  /** What a person does when the next step is theirs, such as updating GOAT. */
  readonly guidance: string | null;
  /** The Child's own request through Home that makes it Ready. */
  readonly proof: { readonly model: string; readonly completedAt: number } | null;
}

const CHILD_REASON_LABEL: Record<ChildSetupReason, string> = {
  home_unavailable: "the hub's OpenCodex cannot install it",
  platform_unsupported: "platform not supported",
  goat_runtime_missing: "GOAT isn't installed there yet; GOAT installs it first, then retries",
  npm_missing: "npm missing",
  install_failed: "install failed",
  ocx_unusable: "OpenCodex does not run there",
  runtime_unhealthy: "OpenCodex not answering",
  unreachable: "machine unreachable",
  link_failed: "link failed",
  consent_revoked: "turned off because the session that allowed it lost access",
  setup_step_timeout: "A setup step timed out. Retry setup.",
};

const CHILD_STATE = {
  running: { tone: "progress", label: "Setting up as OpenCodex Child" },
  child: { tone: "warning", label: "Linked · Codex not verified" },
  degraded: { tone: "warning", label: "OpenCodex Child degraded" },
  blocked: { tone: "destructive", label: "OpenCodex Child setup blocked" },
} as const satisfies Record<ChildSetup["state"], Pick<ChildSetup, "tone" | "label">>;

const CHILD_STEP_LABEL: Record<ChildReadyStep, string> = {
  goat_available: "Prepare GOAT",
  opencodex_running: "Start OpenCodex",
  link_established: "Link to Home",
  codex_installed: "Install Codex",
  instance_routed: "Route Codex through Home",
  inference_verified: "Verify a request through Home",
};

export const CHILD_STEP_OUTCOME_LABEL: Record<ChildSetupStepOutcome, string> = {
  pending: "Waiting",
  running: "In progress",
  succeeded: "Done",
  failed: "Failed",
};

/** A button label for the actions a client sends, and guidance text for the rest. */
const CHILD_NEXT_STEP_LABEL = {
  none: null,
  continue_setup: "Continue setup",
  retry: "Continue setup",
  reconnect_home: "Repair link",
  review_settings: "Review this Child's provider settings, then refresh status.",
  update_goat: "Update GOAT on Home and this Child, then refresh status.",
} as const satisfies Record<ChildReadyNextAction, string | null>;

export const CHILD_SETUP_QUOTA_NOTE =
  "Setup ends with one small request through Home, using its shared quota.";
export const CHILD_SETUP_PERMISSION_NOTE =
  "Managing this device needs permission on the selected Home.";

const SENDABLE_ACTIONS: ReadonlySet<ChildReadyNextAction> = new Set([
  "continue_setup",
  "retry",
  "reconnect_home",
]);

function currentProof(setup: OpenCodexChildSetup, checkedAt: number) {
  const proof = setup.proof;
  return proof !== undefined &&
    setup.attribution === "home_zero_local_accounts" &&
    proof.operationId === setup.operationId &&
    proof.destinationEnvironmentId === setup.destinationEnvironmentId &&
    proof.homeEnvironmentId === setup.homeEnvironmentId &&
    proof.instanceId === setup.instanceId &&
    childReadyProofIsCurrent(proof, checkedAt)
    ? { model: proof.model, completedAt: proof.completedAt }
    : null;
}

/**
 * One machine's progress from linked to Ready. `current` is false when the latest status read
 * failed: a Ready shown then could be stale, so it is withheld with any action until a refresh.
 */
function presentChildReadiness(
  status: OpenCodexChildBootstrapStatus | undefined,
  host: string | null = null,
  current = true,
): ChildSetup | null {
  if (status === undefined) return null;
  const setup = status.setup === undefined ? undefined : withoutUnprovenReady(status.setup);
  // Nested setup supersedes the outer recovery fields an older record carried.
  const failure = setup === undefined ? status.failure : setup.failure;
  const proposed =
    setup?.nextAction ??
    status.nextAction ??
    (status.state === "child" || status.state === "degraded" ? "continue_setup" : "none");
  // Update guidance needs the typed refusal or nested setup; a bare outer field proves nothing.
  const nextAction: ChildReadyNextAction = !current
    ? "none"
    : failure?.code === "remote_outdated"
      ? "update_goat"
      : proposed === "update_goat" && setup === undefined
        ? "none"
        : proposed;
  const actionable =
    SENDABLE_ACTIONS.has(nextAction) && (setup !== undefined || status.actionable !== false);
  const steps = setup?.steps ?? [];
  const failed = failure !== undefined || steps.some((step) => step.state === "failed");
  const proof =
    current &&
    status.state === "child" &&
    setup?.readiness === "ready" &&
    !failed &&
    steps.every((step) => step.state === "succeeded")
      ? currentProof(setup, status.checkedAt)
      : null;
  const running = steps.find((step) => step.state === "running");
  const moving =
    status.state === "running" || running !== undefined || setup?.readiness === "verifying";
  const base = CHILD_STATE[status.state];
  const reason = status.reason === undefined ? null : CHILD_REASON_LABEL[status.reason];
  return {
    state: status.state,
    tone: !current
      ? "warning"
      : proof !== null
        ? "success"
        : failed
          ? "destructive"
          : moving
            ? "progress"
            : base.tone,
    label: !current
      ? "Setup status unavailable. Refresh status."
      : proof !== null
        ? "Ready"
        : running !== undefined
          ? `${CHILD_STEP_LABEL[running.step]}…`
          : reason === null
            ? base.label
            : `${base.label}: ${reason}`,
    detail: failure?.message.trim() || status.message?.trim() || null,
    checkedAt: status.checkedAt,
    host,
    steps: steps.map((step) => ({ label: CHILD_STEP_LABEL[step.step], outcome: step.state })),
    nextAction,
    actionable,
    actionLabel: actionable ? CHILD_NEXT_STEP_LABEL[nextAction] : null,
    guidance: SENDABLE_ACTIONS.has(nextAction) ? null : CHILD_NEXT_STEP_LABEL[nextAction],
    proof,
  };
}

/** Fleet's unfinished-setup alert: null once the machine is linked, verified or not. */
export function presentChildSetup(status: OpenCodexChildBootstrapStatus | undefined) {
  const setup = presentChildReadiness(status);
  if (setup === null || setup.state === "child" || setup.tone === "success") return null;
  return { ...setup, tone: setup.tone };
}

/** The SSH host alias the switch writes to, and whether it is on. */
export interface ChildOptIn {
  readonly host: string;
  readonly enabled: boolean;
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
  readonly childOptIn: ChildOptIn | null;
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
  /** False after a failed status read, so an older Ready is not shown as current. */
  readonly statusCurrent?: boolean;
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
    const childSetup = presentChildReadiness(
      entry.opencodexChild,
      entry.host,
      input.statusCurrent ?? true,
    );
    const childOptIn =
      entry.opencodexChildOptIn === undefined
        ? null
        : { host: entry.host, enabled: entry.opencodexChildOptIn };
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

export function connectHubProxySaveError(
  requested: boolean,
  saved: boolean | undefined,
): string | null {
  return requested === (saved ?? false)
    ? null
    : "Update GOAT on the hub to allow GOAT Connect devices to reach hub devices.";
}
