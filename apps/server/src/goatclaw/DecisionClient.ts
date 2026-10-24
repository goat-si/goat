import { type EnvironmentId, type AuthEnvironmentScope } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { rpcAuthorizationError } from "../auth/RpcAuthorization.ts";
import type { DecisionCaller } from "./DecisionInbox.ts";

export const caller = Effect.fn("DecisionClient.caller")(function* (
  environmentId: EnvironmentId,
  session: Pick<AuthenticatedSession, "sessionId" | "scopes">,
) {
  const sessions = yield* SessionStore.SessionStore;
  const reauthorize = Effect.fn("DecisionClient.reauthorize")(function* (
    required: ReadonlyArray<AuthEnvironmentScope>,
  ) {
    const scopes = yield* sessions
      .readActiveScopes(session.sessionId)
      .pipe(Effect.mapError(() => rpcAuthorizationError(required[0] ?? "orchestration:operate")));
    const missing = required.find((scope) => !scopes.includes(scope));
    if (missing !== undefined) return yield* rpcAuthorizationError(missing);
  });
  return {
    kind: "client",
    environmentId,
    sessionId: session.sessionId,
    scopes: session.scopes,
    reauthorize,
  } satisfies DecisionCaller;
});
