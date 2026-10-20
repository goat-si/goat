import {
  EnvironmentAuthorizationError,
  type AuthEnvironmentScope,
  type AuthSessionId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as SessionStore from "../auth/SessionStore.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";

export type SshHostCaller =
  | { readonly kind: "client"; readonly sessionId: AuthSessionId }
  | { readonly kind: "mcp"; readonly scope: McpInvocationScope };

/** Reload authority immediately before each SSH or local configuration mutation. */
export const authorizeSshHost = (
  sessions: SessionStore.SessionStore["Service"],
  caller: SshHostCaller,
  requiredScope: AuthEnvironmentScope,
) =>
  Effect.gen(function* () {
    const denied = () =>
      new EnvironmentAuthorizationError({
        requiredScope,
        message: `This operation needs a live ${requiredScope} grant.`,
      });
    if (caller.kind === "mcp") {
      const scope = caller.scope;
      if (
        !scope.capabilities.has("orchestration") ||
        scope.reauthorize === undefined ||
        !scope.grantedScopes?.includes(requiredScope) ||
        (requiredScope !== "orchestration:read" &&
          (scope.readOnly || scope.client?.access === "read-only"))
      )
        return yield* denied();
      yield* scope.reauthorize([requiredScope]);
    } else {
      const active = yield* sessions.listActive().pipe(Effect.mapError(denied));
      const session = active.find((entry) => entry.sessionId === caller.sessionId);
      if (!session || !(session.permissions ?? session.scopes).includes(requiredScope))
        return yield* denied();
    }
  });

/**
 * Lets a thread agent ask a person to approve something it may not do itself.
 * It only creates the approval card: whatever runs afterwards is authorized
 * against the approving person's own session. The thread needs a live,
 * writable credential for its running turn, and gains no other authority.
 */
export const authorizeApprovalRequest = (scope: McpInvocationScope) =>
  Effect.gen(function* () {
    if (
      scope.thread === undefined ||
      scope.client !== undefined ||
      scope.readOnly === true ||
      !scope.capabilities.has("orchestration") ||
      scope.reauthorize === undefined ||
      !scope.grantedScopes?.includes("orchestration:read")
    )
      return yield* new EnvironmentAuthorizationError({
        requiredScope: "orchestration:read",
        message: "Only a running, writable GOAT thread can ask for this approval.",
      });
    yield* scope.reauthorize(["orchestration:read"]);
  });
