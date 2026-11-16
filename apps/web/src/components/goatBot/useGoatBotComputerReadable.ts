import type { EnvironmentId } from "@goat/contracts";
import { useSyncExternalStore } from "react";

import { primarySessionCheck } from "~/environments/primary/sessionCheck";
import {
  type EnvironmentPresentation,
  readEnvironment,
  readPrimaryEnvironmentId,
  useEnvironment,
  usePrimaryEnvironmentId,
} from "~/state/environments";

const ignore = () => () => {};
const notRevoked = () => false;

/**
 * Whether this client may still read the computer: it is in the app's list and has not refused this
 * device. Mobile's gate also closes during a start-over and after a denied bot-list read.
 */
export function useGoatBotComputerReadable(environmentId: EnvironmentId | null): boolean {
  const { presentation, revoked } = useAccess(environmentId);
  return readableFrom(presentation, revoked);
}

/**
 * Whether the computer is in the app's list and refused this device: its connection is blocked for
 * authentication or permission (in any phase), or, for this tab's own server, the server said this
 * tab's session is gone. A computer removed from the app is not a refusal.
 */
export function useGoatBotComputerRefused(environmentId: EnvironmentId | null): boolean {
  const { presentation, revoked } = useAccess(environmentId);
  return refusedFrom(presentation, revoked);
}

/** The same rule read from the store now, for a press the screen has not caught up with. */
export function readGoatBotComputerReadable(environmentId: EnvironmentId): boolean {
  const ownServer = readPrimaryEnvironmentId() === environmentId;
  return readableFrom(readEnvironment(environmentId), ownServer && primarySessionCheck.revoked());
}

/** How a listed computer refused this device; "session-ended" when this browser can reload back in. */
export type GoatBotRefusal = "refused" | "session-ended";

/** The listed computers that refused this device, by the same rule, for GOAT Bot's availability. */
export function useGoatBotRefusals(
  environments: ReadonlyArray<EnvironmentPresentation>,
  primaryEnvironmentId: EnvironmentId | null,
): ReadonlyMap<EnvironmentId, GoatBotRefusal> {
  const revoked = usePrimarySessionRevoked(primaryEnvironmentId !== null);
  const refused = new Map<EnvironmentId, GoatBotRefusal>();
  for (const presentation of environments) {
    const held = presentation.environmentId === primaryEnvironmentId && revoked;
    if (!refusedFrom(presentation, held)) continue;
    // The follower holds only a cookie tab's ended session, through Retry's cleared failure.
    const ended = held || presentation.connection.failure?.sessionEnded === true;
    refused.set(presentation.environmentId, ended ? "session-ended" : "refused");
  }
  return refused;
}

function useAccess(environmentId: EnvironmentId | null) {
  const presentation = useEnvironment(environmentId);
  const primaryId = usePrimaryEnvironmentId();
  const ownServer = environmentId !== null && primaryId === environmentId;
  const revoked = usePrimarySessionRevoked(ownServer);
  return { presentation, revoked };
}

function usePrimarySessionRevoked(ownServer: boolean): boolean {
  return useSyncExternalStore(
    ownServer ? primarySessionCheck.subscribe : ignore,
    ownServer ? primarySessionCheck.revoked : notRevoked,
  );
}

type Presentation = ReturnType<typeof readEnvironment>;

function readableFrom(presentation: Presentation, revoked: boolean): boolean {
  return presentation !== null && !refusedFrom(presentation, revoked);
}

function refusedFrom(presentation: Presentation, revoked: boolean): boolean {
  if (presentation === null) return false;
  const reason = presentation.connection.failure?.reason;
  return reason === "authentication" || reason === "permission" || revoked;
}
