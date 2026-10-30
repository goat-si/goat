import {
  AuthHubProxyScope,
  type AuthEnvironmentScope,
  type AuthSessionState,
} from "@goat/contracts";

import { usePrimarySessionState } from "~/environments/primary";
import { usePrimaryEnvironment } from "~/state/environments";

/**
 * The hub owner's session may grant hub access to a new pairing while the hub is on. The server
 * checks both again when it issues the pairing.
 */
function useHubAccessGrantable(): boolean {
  const config = usePrimaryEnvironment()?.serverConfig ?? null;
  const session = usePrimarySessionState().data;
  return (
    session?.authenticated === true &&
    session.canDelegateHubProxy === true &&
    config?.settings.hub.enabled === true &&
    config.environment.capabilities.hubProxy === true
  );
}

/**
 * What this session may put on a pairing: its own scopes, with hub access only when it may grant
 * it. Holding hub access is not enough; the server refuses a paired device that passes it on.
 */
export function useDelegatableScopes(
  session: AuthSessionState | null,
): ReadonlyArray<AuthEnvironmentScope> {
  const grantable = useHubAccessGrantable();
  const held = session?.authenticated ? (session.permissions ?? session.scopes ?? []) : [];
  const own = held.filter((scope) => scope !== AuthHubProxyScope);
  return grantable ? [...own, AuthHubProxyScope] : own;
}
