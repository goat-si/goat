import type { EnvironmentId } from "@goat/contracts";
import type { Atom, AtomRegistry } from "effect/reactivity";

import { serverEnvironment } from "./server";

/** Each read samples CPU for 200ms and asks every SSH host; quota refresh is capped server-side. */
export const HOST_STATUS_REFRESH_MS = 15_000;

/**
 * An environment's host-status read: that machine plus every SSH host it holds
 * open, or that machine alone when `local`. Settings' Hosts section, the Fleet
 * graph, and the Fleet console all read through these atoms, so views asking the
 * same question share one answer and its refresh.
 */
export function hostStatusAtom(
  environmentId: EnvironmentId,
  options?: { readonly local?: boolean },
) {
  return serverEnvironment.hostStatus({
    environmentId,
    input: options?.local === true ? { local: true } : {},
  });
}

const lastRefreshedAt = new WeakMap<Atom.Atom<unknown>, number>();

/**
 * Refreshes a host-status read unless another view already did this period, so
 * Settings and Fleet open together still read each environment once per period.
 */
export function refreshHostStatus(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<unknown>,
  now = Date.now(),
): void {
  const last = lastRefreshedAt.get(atom);
  // A second short of the period lets a view whose timer fires just early still lead.
  if (last !== undefined && now - last < HOST_STATUS_REFRESH_MS - 1_000) return;
  lastRefreshedAt.set(atom, now);
  registry.refresh(atom);
}
