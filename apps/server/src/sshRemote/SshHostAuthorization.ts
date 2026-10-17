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
