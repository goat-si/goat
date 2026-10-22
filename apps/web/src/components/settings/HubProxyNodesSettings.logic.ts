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
  return {
    setup: node.environmentId === null && ssh,
    linked: preferred === "linked",
    reachable: node.environmentId !== null && (ssh || cloud),
  };
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
