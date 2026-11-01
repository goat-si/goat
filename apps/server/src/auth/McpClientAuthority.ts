/**
 * An outside MCP client's authority, rebuilt from its auth session id alone, so work the client
 * left running (a fleet goal) is checked again whenever it acts, after a restart included. Nothing
 * here keeps the bearer token or the request it arrived with: every read goes to SessionStore's
 * live grant, which forgets a revoked or replaced session and refuses an expired one.
 *
 * The runtime-mode ceiling is not here: it is signed into the token, set once when the session is
 * issued, and never changes for that session id. Whoever acts for the client keeps the ceiling it
 * captured from an authenticated request.
 */
import {
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthSessionId,
  EnvironmentAuthorizationError,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as SessionStore from "./SessionStore.ts";

/** Asks the session's live grant, never a copy taken when the request arrived. */
export const reauthorizeSession =
  (sessions: SessionStore.SessionStore["Service"], sessionId: AuthSessionId) =>
  (required: ReadonlyArray<AuthEnvironmentScope>) =>
    sessions.readActiveScopes(sessionId).pipe(
      Effect.mapError(
        () =>
          new EnvironmentAuthorizationError({
            message: "The MCP session is no longer active.",
            requiredScope: required[0] ?? "memory:read",
          }),
      ),
      Effect.flatMap((scopes) =>
        required.every((scope) => scopes.includes(scope))
          ? Effect.void
          : Effect.fail(
              new EnvironmentAuthorizationError({
                message: "The MCP session does not grant the required scope.",
                requiredScope: required.find((scope) => !scopes.includes(scope)) ?? "memory:read",
              }),
            ),
      ),
    );

export interface McpClientGrant {
  readonly sessionId: AuthSessionId;
  readonly grantedScopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly reauthorize: ReturnType<typeof reauthorizeSession>;
}

export class McpClientAuthority extends Context.Service<
  McpClientAuthority,
  {
    /**
     * The session's grant now, when it may still control threads; otherwise why not. Revoked,
     * replaced, expired and unknown sessions read the same, so the answer names no secret.
     */
    readonly load: (
      sessionId: string,
    ) => Effect.Effect<McpClientGrant | { readonly unavailable: string }>;
  }
>()("goat/auth/McpClientAuthority") {}

const isSessionId = Schema.is(AuthSessionId);

/** Needs the server's one SessionStore: a second instance would hold its own live grants. */
export const layer = Layer.effect(
  McpClientAuthority,
  Effect.gen(function* () {
    const sessions = yield* SessionStore.SessionStore;
    return McpClientAuthority.of({
      load: (raw) => {
        if (!isSessionId(raw))
          return Effect.succeed({ unavailable: "The goal names no MCP client session." });
        return sessions.readActiveScopes(raw).pipe(
          Effect.map((scopes): McpClientGrant | { readonly unavailable: string } =>
            scopes.includes(AuthOrchestrationOperateScope)
              ? {
                  sessionId: raw,
                  grantedScopes: scopes,
                  reauthorize: reauthorizeSession(sessions, raw),
                }
              : { unavailable: "The MCP client session no longer controls threads." },
          ),
          Effect.orElseSucceed(() => ({
            unavailable: "The MCP client session was revoked or has expired.",
          })),
        );
      },
    });
  }),
);
