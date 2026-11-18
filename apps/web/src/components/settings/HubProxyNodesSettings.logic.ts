import type { HubNode, ServerConfig } from "@goat/contracts";

export function canShowHubProxySettings(
  config: Pick<ServerConfig, "environment"> | null,
  canChange: boolean,
) {
  return config?.environment.capabilities.hubProxy === true && canChange;
}

export function hubProxyNodeActions(node: HubNode) {
  // The hub proxies through the preferred route only, so that route decides what applies.
  const preferred = node.routes[0]?.target.kind;
  const ssh = preferred === "ssh";
  const cloud = preferred === "cloud";
  // The hub never installs GOAT on a machine it lists only because Pen does.
  const pen = node.routes[0]?.pen !== undefined;
  return {
    setup: node.environmentId === null && ssh && !pen,
    linked: preferred === "linked",
    reachable: node.environmentId !== null && (ssh || cloud),
  };
}

/** What to say about a Pen member the hub lists but cannot open, or null. */
export function hubProxyPenNotice(node: HubNode): string | null {
  return node.routes[0]?.pen !== undefined && node.environmentId === null
    ? "Pen member, GOAT not set up. Install GOAT on it, or add it here as an SSH host to set it up."
    : null;
}

export function hubProxyFailureMessage(error: unknown, fallback: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "detail" in error &&
    typeof error.detail === "string" &&
    error.detail.length > 0
  )
    return error.detail;
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}
