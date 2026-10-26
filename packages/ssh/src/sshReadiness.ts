import { waitForHttpReady as waitForHttpReadyShared } from "@goat/shared/httpReadiness";
import type * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http";

import { SshReadinessError } from "./errors.ts";

export const SSH_READY_TIMEOUT_MS = 20_000;
export const SSH_READY_PROBE_TIMEOUT_MS = 1_000;
// Ceilings for a slow link. A forwarded probe costs at least one round trip,
// which reaches ~600 ms over a phone hotspot relayed across continents.
const SSH_READY_MAX_PROBE_TIMEOUT_MS = 5_000;
const SSH_READY_MAX_TIMEOUT_MS = 60_000;

export interface SshReadinessBudget {
  /** Bound on the first forwarded probe; each timed-out probe doubles it up to 5 s. */
  readonly probeTimeoutMs: number;
  /** Overall wait for the forward to answer. */
  readonly timeoutMs: number;
}

/**
 * Readiness budget for a forward to a host whose remote launch took `launchMs`.
 * A launch is one SSH connection plus several remote round trips, so a quarter
 * of it estimates one forwarded HTTP exchange. A fast host keeps the 1 s / 20 s
 * defaults; a slow link gets longer probes and up to 60 s overall.
 */
export function sshReadinessBudget(launchMs: number): SshReadinessBudget {
  const clamp = (value: number, min: number, max: number) =>
    Math.min(max, Math.max(min, Math.ceil(Number.isFinite(value) ? value : 0)));
  return {
    probeTimeoutMs: clamp(launchMs / 4, SSH_READY_PROBE_TIMEOUT_MS, SSH_READY_MAX_PROBE_TIMEOUT_MS),
    timeoutMs: clamp(launchMs * 5, SSH_READY_TIMEOUT_MS, SSH_READY_MAX_TIMEOUT_MS),
  };
}

export const waitForHttpReady = (input: {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly probeTimeoutMs?: number;
  readonly maxProbeTimeoutMs?: number;
  readonly path?: string;
}): Effect.Effect<void, SshReadinessError, HttpClient.HttpClient> =>
  waitForHttpReadyShared({
    baseUrl: input.baseUrl,
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
    probeTimeoutMs: input.probeTimeoutMs ?? SSH_READY_PROBE_TIMEOUT_MS,
    maxProbeTimeoutMs: input.maxProbeTimeoutMs ?? SSH_READY_MAX_PROBE_TIMEOUT_MS,
    makeError: ({ requestUrl, probeTimeoutMs, cause }) => {
      if (typeof cause === "object" && cause !== null && "kind" in cause) {
        const kind = (cause as { readonly kind?: unknown }).kind;
        if (kind === "probe-timeout") {
          return new SshReadinessError({
            reason: "slow",
            message: `Backend readiness probe exceeded ${probeTimeoutMs}ms at ${requestUrl}.`,
            cause,
          });
        }
        if (kind === "overall-timeout") {
          const overall = cause as unknown as {
            readonly baseUrl: string;
            readonly timeoutMs: number;
            readonly attempts: number;
            readonly probeTimeouts: number;
            readonly otherFailures: number;
            readonly lastProbeTimeoutMs: number;
            readonly lastFailure: unknown;
          };
          // Every check timing out means requests reached a server that answered
          // too late; refused or failed checks mean nothing answered at all.
          const slow = overall.probeTimeouts > 0 && overall.otherFailures === 0;
          return new SshReadinessError({
            reason: slow ? "slow" : "unreachable",
            message: slow
              ? `Timed out waiting ${overall.timeoutMs}ms for backend readiness at ${overall.baseUrl}. The SSH tunnel is open, but the GOAT server answered none of ${overall.attempts} checks within ${overall.lastProbeTimeoutMs}ms. The network to this host is too slow (high latency); GOAT will keep retrying.`
              : `Timed out waiting ${overall.timeoutMs}ms for backend readiness at ${overall.baseUrl}. The GOAT server did not answer through the SSH tunnel; it may have stopped on the remote host.`,
            cause: overall.lastFailure,
          });
        }
      }
      return new SshReadinessError({
        reason: "unreachable",
        message: `Backend readiness probe failed at ${requestUrl}.`,
        cause,
      });
    },
  });
