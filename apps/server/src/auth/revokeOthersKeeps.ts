import type { AuthRevokeOthersKeep, ServerAuthSessionMethod } from "@goat/contracts";

import { DESKTOP_BOOTSTRAP_SUBJECT } from "./PairingGrantStore.ts";

/**
 * The desktop app's own session. Only a desktop bootstrap credential mints this subject, and
 * each bearer exchange replaces the previous row. Cookie and DPoP desktop sessions are not kept.
 */
export const REVOKE_OTHERS_KEEPS_DESKTOP = {
  subject: DESKTOP_BOOTSTRAP_SUBJECT,
  method: "bearer-access-token",
} as const satisfies { readonly subject: string; readonly method: ServerAuthSessionMethod };

/** Mirrors the rows AuthSessionRepository.revokeAllExcept keeps. */
export const keptByRevokeOthers = (session: {
  readonly subject: string;
  readonly method: ServerAuthSessionMethod;
  readonly penBound: boolean;
}): AuthRevokeOthersKeep | undefined => {
  if (session.penBound) return "pen";
  return session.subject === REVOKE_OTHERS_KEEPS_DESKTOP.subject &&
    session.method === REVOKE_OTHERS_KEEPS_DESKTOP.method
    ? "desktop"
    : undefined;
};
