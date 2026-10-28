import type { RelayManagedEndpointOrigin } from "@goat/contracts/relay";
export function formatOriginService(origin: RelayManagedEndpointOrigin): string {
  const host = origin.localHttpHost.includes(":")
    ? `[${origin.localHttpHost.replace(/^\[(.*)\]$/u, "$1")}]`
    : origin.localHttpHost;
  return `http://${host}:${origin.localHttpPort}`;
}

export function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/\.$/u, "")
    .replace(/^\[(.*)\]$/u, "$1");
}

export function isLoopbackOrigin(origin: RelayManagedEndpointOrigin): boolean {
  const hostname = normalizeHostname(origin.localHttpHost);
  return (
    (hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost") &&
    Number.isInteger(origin.localHttpPort) &&
    origin.localHttpPort > 0 &&
    origin.localHttpPort <= 65_535
  );
}

export function isManagedEndpointNotFound(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) {
    return false;
  }
  if ("_tag" in cause && (cause._tag === "NotFound" || cause._tag === "TunnelNotFound")) {
    return true;
  }
  if ("status" in cause && cause.status === 404) {
    return true;
  }
  return "cause" in cause && isManagedEndpointNotFound(cause.cause);
}

/**
 * Cloudflare refuses to delete a tunnel while a connector is still attached,
 * either one that has not finished draining or another runtime still serving
 * the tunnel.
 */
export function isManagedEndpointTunnelInUse(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) {
    return false;
  }
  if (
    "message" in cause &&
    typeof cause.message === "string" &&
    cause.message.includes("has active connections")
  ) {
    return true;
  }
  return "cause" in cause && isManagedEndpointTunnelInUse(cause.cause);
}
