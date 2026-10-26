import { isLoopbackHost } from "@goat/shared/preview";

import type { ConnectionCatalogEntry, ConnectionTarget } from "./model.ts";
import { connectionRoutes, routeHttpBaseUrl } from "./routes.ts";

/**
 * How long this device's own GOAT server may stay silent before a request or socket gives up on
 * it. The process is local, so silence means a busy event loop, not a lost network: a remote
 * host's 10-15 s deadlines tore down a healthy connection during a maintenance pass and then
 * backed off for minutes after the server had recovered. A hung process still surfaces.
 */
export const LOOPBACK_SILENCE_TIMEOUT_MS = 60_000;

const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 300_000;
/** Retries against this device's own server stay quick: nothing on the network needs to settle. */
const LOOPBACK_RETRY_MAX_DELAY_MS = 5_000;

export function isLoopbackHttpBaseUrl(httpBaseUrl: string): boolean {
  try {
    return isLoopbackHost(new URL(httpBaseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * A connection to this device's own server. An SSH forward also listens on loopback, but its
 * silence can be a lost network, so it keeps the remote budgets.
 */
export function isLocalServerConnection(target: ConnectionTarget, httpBaseUrl: string): boolean {
  return target._tag !== "SshConnectionTarget" && isLoopbackHttpBaseUrl(httpBaseUrl);
}

/** Every route of the entry reaches this device's own server. */
export function isLoopbackEntry(entry: ConnectionCatalogEntry): boolean {
  return connectionRoutes(entry).every((route) => {
    const httpBaseUrl = routeHttpBaseUrl(route);
    return httpBaseUrl !== null && isLocalServerConnection(route.target, httpBaseUrl);
  });
}

/** A setup or silence budget, raised to the local allowance for this device's own server. */
export function loopbackBudgetMs(loopback: boolean, remoteBudgetMs: number): number {
  return loopback ? Math.max(remoteBudgetMs, LOOPBACK_SILENCE_TIMEOUT_MS) : remoteBudgetMs;
}

/** Jittered exponential backoff, capped low for this device's own server. */
export function retryDelayMs(failureCount: number, random: number, loopback = false): number {
  const step =
    Number.isNaN(failureCount) || failureCount <= 0
      ? 0
      : failureCount >= 9
        ? 9
        : Math.trunc(failureCount);
  const clampedRandom = Number.isNaN(random) ? 0 : Math.min(1, Math.max(0, random));
  const ceiling = Math.min(
    loopback ? LOOPBACK_RETRY_MAX_DELAY_MS : RETRY_MAX_DELAY_MS,
    RETRY_BASE_DELAY_MS * 2 ** (step + 1),
  );
  return Math.round(ceiling / 2 + (ceiling / 2) * clampedRandom);
}
