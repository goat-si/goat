/**
 * Builds the connection owner for a caller the server already authenticated.
 *
 * @module channelOwner
 */
import {
  AuthOrchestrationOperateScope,
  type AuthEnvironmentScope,
  type AuthSessionId,
  type EnvironmentId,
} from "@goat/contracts";

import type { ChannelConnectionOwner } from "./ChannelIngressContext.ts";

/** This prototype has one owner per environment: whoever operates this server. */
export const channelOwnerIdFor = (environmentId: EnvironmentId) => "environment:" + environmentId;

/** The owner for an authenticated client session. Never read from client input. */
export const ownerFromSession = (
  environmentId: EnvironmentId,
  session: { readonly subject: string; readonly scopes: ReadonlyArray<AuthEnvironmentScope> },
  authSessionId?: AuthSessionId,
): ChannelConnectionOwner => ({
  ownerId: channelOwnerIdFor(environmentId),
  ...(authSessionId === undefined ? {} : { authSessionId }),
  principalId: session.subject,
  displayName: "Owner",
  grantedScopes: [...session.scopes],
  runtimeModeCeiling: session.scopes.includes(AuthOrchestrationOperateScope)
    ? "full-access"
    : "approval-required",
});
