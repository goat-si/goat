import type { EnvironmentId, HostStatusEntry } from "@goat/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { fleetHostReportsAtom } from "~/state/fleetHostMetrics";

import {
  recordHostSamples,
  recordLastSeen,
  type FleetHostRead,
  type HostHistory,
  type HostLastSeen,
} from "./fleetTelemetry";

export interface FleetConsoleTelemetry {
  /** Each environment's answer, as the graph's heat reads it. */
  readonly reports: ReadonlyMap<EnvironmentId, ReadonlyArray<HostStatusEntry>>;
  readonly history: HostHistory;
  readonly lastSeen: HostLastSeen;
  readonly loading: boolean;
  /** Environments whose latest read failed. */
  readonly failed: ReadonlyArray<EnvironmentId>;
  /** Newest sample time the hosts reported; 0 before the first answer. */
  readonly sampledAt: number;
  /** When this client last received an answer, for ages that must not trust host clocks. */
  readonly observedAt: number;
}

/*
 * Sparkline history and last-seen times outlive the reads, which stop when the Fleet page
 * closes. Recording is idempotent (a repeated sample adds nothing) and bounded, so
 * recomputing the atom cannot grow them.
 */
let hostHistory: HostHistory = new Map();
let hostLastSeen: HostLastSeen = new Map();

/**
 * The console's view of the Fleet's shared host-status reads. It adds no read or
 * refresh of its own: FleetPage's heat (useFleetHostMetrics) mounts and refreshes
 * the same per-environment atoms, so the graph and the console share one poller.
 */
export const fleetConsoleTelemetryAtom = Atom.make((get): FleetConsoleTelemetry => {
  const { reports, sources } = get(fleetHostReportsAtom);
  const failed: EnvironmentId[] = [];
  let loading = false;
  for (const { environmentId, atom } of sources) {
    const result = get(atom);
    // The primary has two reads, its own and the fan-out; it is one unreadable environment.
    if (AsyncResult.isFailure(result)) {
      if (!failed.includes(environmentId)) failed.push(environmentId);
    } else if (AsyncResult.isInitial(result)) loading = true;
  }
  const reads: FleetHostRead[] = [...reports].map(([environmentId, hosts]) => ({
    environmentId,
    hosts,
  }));
  // The atom recomputes once per settled read, so now is when this client received it.
  const now = Date.now();
  hostHistory = recordHostSamples(hostHistory, reads, now);
  hostLastSeen = recordLastSeen(hostLastSeen, reads, now);
  const previous = Option.getOrNull(get.self<FleetConsoleTelemetry>());
  if (
    previous !== null &&
    previous.loading === loading &&
    previous.history === hostHistory &&
    previous.lastSeen === hostLastSeen &&
    previous.failed.join("\n") === failed.join("\n") &&
    previous.reports.size === reports.size &&
    [...reports].every(([environmentId, hosts]) => previous.reports.get(environmentId) === hosts)
  ) {
    return previous;
  }
  const sampledAt = reads.reduce(
    (newest, { hosts }) =>
      hosts.reduce((latest, entry) => Math.max(latest, entry.metrics?.sampledAt ?? 0), newest),
    0,
  );
  return {
    reports,
    history: hostHistory,
    lastSeen: hostLastSeen,
    loading,
    failed,
    sampledAt,
    observedAt: now,
  };
}).pipe(Atom.withLabel("fleet-console-telemetry"));
