import {
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  AuthHubProxyScope,
  type AuthEnvironmentScope,
} from "@goat/contracts";

import { DESKTOP_BOOTSTRAP_SUBJECT } from "./PairingGrantStore.ts";

/** The startup pairing URL a headless server prints for its owner's browser. */
export const ADMINISTRATIVE_BOOTSTRAP_SUBJECT = "administrative-bootstrap";

/**
 * Subjects only the server's own bootstrap grants carry. HTTP pairing always issues
 * `one-time-token`, so a paired device cannot name itself the owner. A local CLI session can pick
 * any subject, but whoever runs that CLI can already run `goat pair --hub-proxy`.
 */
const OWNER_SUBJECTS: ReadonlySet<string> = new Set([
  DESKTOP_BOOTSTRAP_SUBJECT,
  ADMINISTRATIVE_BOOTSTRAP_SUBJECT,
]);

type Principal = {
  readonly subject: string;
  readonly holds: (scope: AuthEnvironmentScope) => boolean;
};

/** The owner may put `hub:proxy` on a pairing without holding it; nobody else may hand it on. */
export const canDelegateHubProxy = (principal: Principal) =>
  OWNER_SUBJECTS.has(principal.subject) &&
  principal.holds(AuthAccessWriteScope) &&
  principal.holds(AuthEnvironmentMaintainScope);

export type HubProxyDelegationRefusal =
  | { readonly _tag: "ScopeRequired"; readonly scope: AuthEnvironmentScope }
  | { readonly _tag: "HubOff" };

/** Why a pairing request may not carry `hub:proxy`, or undefined when it may. */
export const hubProxyDelegationRefusal = (
  principal: Principal,
  hubEnabled: boolean,
): HubProxyDelegationRefusal | undefined =>
  !canDelegateHubProxy(principal)
    ? { _tag: "ScopeRequired", scope: AuthHubProxyScope }
    : !hubEnabled
      ? { _tag: "HubOff" }
      : undefined;
