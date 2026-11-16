import type { EnvironmentId } from "@goat/contracts";
import { useSyncExternalStore } from "react";

import { primarySessionCheck } from "~/environments/primary/sessionCheck";
import {
  readEnvironment,
  readPrimaryEnvironmentId,
  useEnvironment,
  usePrimaryEnvironmentId,
} from "~/state/environments";

const ignore = () => () => {};
const notRevoked = () => false;

/**
 * Whether this client may still read the computer: it is in the app's list, its connection is not
 * blocked for authentication or permission (in any phase), and, for this tab's own server, the
 * server has not said this tab's session is gone. Mobile applies the same rule.
 */
export function useGoatBotComputerReadable(environmentId: EnvironmentId | null): boolean {
  const presentation = useEnvironment(environmentId);
  const primaryId = usePrimaryEnvironmentId();
  const ownServer = environmentId !== null && primaryId === environmentId;
  const revoked = useSyncExternalStore(
    ownServer ? primarySessionCheck.subscribe : ignore,
    ownServer ? primarySessionCheck.revoked : notRevoked,
  );
  return readableFrom(presentation, revoked);
}

/** The same rule read from the store now, for a press the screen has not caught up with. */
export function readGoatBotComputerReadable(environmentId: EnvironmentId): boolean {
  const ownServer = readPrimaryEnvironmentId() === environmentId;
  return readableFrom(readEnvironment(environmentId), ownServer && primarySessionCheck.revoked());
}

function readableFrom(presentation: ReturnType<typeof readEnvironment>, revoked: boolean): boolean {
  if (presentation === null) return false;
  const reason = presentation.connection.failure?.reason;
  if (reason === "authentication" || reason === "permission") return false;
  return !revoked;
}
