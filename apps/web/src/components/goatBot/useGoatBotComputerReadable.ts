import type { EnvironmentId } from "@goat/contracts";
import { useSyncExternalStore } from "react";

import { primarySessionCheck } from "~/environments/primary/sessionCheck";
import { useEnvironment, usePrimaryEnvironmentId } from "~/state/environments";

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
  if (presentation === null) return false;
  const reason = presentation.connection.failure?.reason;
  if (reason === "authentication" || reason === "permission") return false;
  return !revoked;
}
