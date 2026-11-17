import type { EnvironmentConnectionPresentation } from "@goat/client-runtime/connection";
import type { EnvironmentId } from "@goat/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentPresentations } from "../../state/presentation";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { isPrimaryAuthGateAuthenticated } from "./auth";
import { isSameOriginBrowserPrimary } from "./httpLayer";

interface PrimaryConnection {
  readonly environmentId: EnvironmentId;
  readonly connection: Pick<EnvironmentConnectionPresentation, "phase" | "failure"> | null;
}

export interface PrimarySessionCheck {
  readonly subscribe: (listener: () => void) => () => void;
  /** True once this tab's own server said its session is gone, until the tab connects again. */
  readonly revoked: () => boolean;
}

/**
 * Holds the connection's verdict that this cookie tab's session ended. Retry clears the failure
 * for its attempt, so this keeps the tab refused until it connects; a reload or pairing resets it.
 */
export function createPrimarySessionCheck(sources: {
  readonly primary: () => PrimaryConnection | null;
  readonly subscribePrimary: (listener: () => void) => () => void;
  /** Whether this tab is a browser signed in to its own server by cookie. */
  readonly eligible: () => boolean;
}): PrimarySessionCheck {
  const listeners = new Set<() => void>();
  let started = false;
  let endedFor: EnvironmentId | null = null;
  const revoked = () => endedFor !== null && endedFor === sources.primary()?.environmentId;
  const follow = () => {
    const before = revoked();
    const primary = sources.primary();
    const failure = primary?.connection?.failure;
    if (primary?.connection?.phase === "connected") endedFor = null;
    else if (
      primary !== null &&
      failure?.kind === "blocked" &&
      failure.reason === "authentication" &&
      sources.eligible()
    )
      endedFor = primary.environmentId;
    if (revoked() !== before) for (const listener of listeners) listener();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      // The first reader starts it; it then follows for the tab's life so no connect is missed.
      if (!started) {
        started = true;
        sources.subscribePrimary(follow);
        follow();
      }
      return () => {
        listeners.delete(listener);
      };
    },
    revoked,
  };
}

const primaryConnectionAtom = Atom.make((get): PrimaryConnection | null => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return null;
  return {
    environmentId,
    connection:
      get(environmentPresentations.presentationsAtom).get(environmentId)?.connection ?? null,
  };
}).pipe(Atom.withLabel("primary-environment:connection"));

export const primarySessionCheck = createPrimarySessionCheck({
  primary: () => appAtomRegistry.get(primaryConnectionAtom),
  subscribePrimary: (listener) => appAtomRegistry.subscribe(primaryConnectionAtom, listener),
  // Desktop and other origins sign in by bearer or send no cookie, so only a cookie tab is held.
  eligible: () => isSameOriginBrowserPrimary() && isPrimaryAuthGateAuthenticated(),
});
