import * as ConnectHubCredentials from "./ConnectHubCredentials.ts";
import * as HubConnectAccess from "./HubConnectAccess.ts";
import * as IssuedEnvironmentSession from "./issueEnvironmentSession.ts";
import * as CloudCredentialWithdrawal from "./CloudCredentialWithdrawal.ts";
import {
  AuthAccessTokenType,
  AuthAccessWriteScope,
  AuthOrchestrationApproveScope,
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  AuthStandardClientScopes,
  type AuthAccessTokenResult,
  type AuthBrowserSessionResult,
  type AuthClientMetadata,
  type AuthClientSession,
  type AuthCreatePairingCredentialInput,
  type AuthEnvironmentScope,
  type AuthMcpClientAccess,
  type AuthMcpWorkspaceTerminalScope,
  type AuthPairingLink,
  type AuthPairingCredentialResult,
  type AuthSessionId,
  type AuthSessionState,
  authScopeResponse,
  type ServerAuthDescriptor,
  type ServerAuthSessionMethod,
  type AuthWebSocketTicketResult,
  type AuthWebSocketTicketUse,
  type ChildSetupPurpose,
  type RuntimeMode,
  type SessionPrincipalKind,
} from "@goat/contracts";
import { encodeOAuthScope } from "@goat/shared/oauthScope";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerConfig from "../config.ts";
import * as EnvironmentAuthPolicy from "./EnvironmentAuthPolicy.ts";
import { reauthorizeSession } from "./McpClientAuthority.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import { type ConnectionContext, connectionOf } from "./connectionContext.ts";
import type { AuthSessionPenBinding } from "../persistence/AuthSessions.ts";
import { REUSABLE_DEV_SESSION_EXPIRES_AT, resolveReusableDevAuth } from "./ReusableDevAuth.ts";
import { legacyScopedSessionCookieName } from "./utils.ts";
import { verifyRequestDpopProof } from "./dpop.ts";
import { DESKTOP_RENDERER_ORIGINS } from "../httpCors.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { MCP_CLIENT_SUBJECT } from "./mcpClientSubject.ts";
import { mcpClientScopes } from "./mcpClientScopes.ts";
import { ADMINISTRATIVE_BOOTSTRAP_SUBJECT, canDelegateHubProxy } from "./hubProxyDelegation.ts";

export { mcpClientScopes };

const DEFAULT_SESSION_SUBJECT = "cli-issued-session";
export const INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT = ADMINISTRATIVE_BOOTSTRAP_SUBJECT;

export interface IssuedPairingLink {
  readonly id: string;
  readonly credential: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly subject: string;
  readonly label?: string;
  readonly createdAt: DateTime.Utc;
  readonly expiresAt: DateTime.Utc;
}

export interface IssuedBearerSession {
  readonly childSetupPurpose?: ChildSetupPurpose;
  readonly sessionId: AuthSessionId;
  readonly token: string;
  readonly method: "bearer-access-token";
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly subject: string;
  readonly client: AuthClientMetadata;
  readonly expiresAt: DateTime.Utc;
}

const MCP_CLIENT_SESSION_TTL = Duration.days(30);

export interface McpClientSession {
  /** Verified from the signed session; only the Child setup tools admit it. */
  readonly childSetupPurpose?: ChildSetupPurpose;
  readonly sessionId: AuthSessionId;
  readonly label: string;
  readonly access: AuthMcpClientAccess;
  /** Holds `orchestration:approve` next to write access; OAuth sign-ins never do. */
  readonly approvals: boolean;
  readonly grantedScopes?: ReadonlyArray<AuthEnvironmentScope>;
  readonly reauthorize?: (
    required: ReadonlyArray<AuthEnvironmentScope>,
  ) => Effect.Effect<void, EnvironmentAuthorizationError>;
}

export interface AuthenticatedSession {
  readonly connectAccessGeneration?: number;
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly method: ServerAuthSessionMethod;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly proofKeyThumbprint?: string;
  readonly expiresAt?: DateTime.DateTime;
  readonly principalKind: SessionPrincipalKind;
  readonly penBinding?: AuthSessionPenBinding;
}

export * from "./environmentAuthErrors.ts";
import {
  ServerAuthBootstrapCredentialValidationError,
  ServerAuthSessionCredentialValidationError,
  ServerAuthAuthenticatedSessionIssueError,
  ServerAuthAuthenticatedAccessTokenIssueError,
  ServerAuthPairingLinkCreationError,
  ServerAuthPairingLinksListError,
  ServerAuthPairingLinkRevocationError,
  ServerAuthSessionTokenIssueError,
  ServerAuthSessionsListError,
  ServerAuthSessionRevocationError,
  ServerAuthOtherSessionsRevocationError,
  ServerAuthWebSocketTokenIssueError,
  ServerAuthInternalError,
  ServerAuthMissingCredentialError,
  ServerAuthInvalidCredentialError,
  ServerAuthCredentialError,
  isServerAuthCredentialError,
  ServerAuthScopeNotGrantedError,
  ServerAuthInvalidRequestError,
  ServerAuthMcpApprovalCodeError,
  ServerAuthForbiddenOperationError,
} from "./environmentAuthErrors.ts";
export class EnvironmentAuth extends Context.Service<
  EnvironmentAuth,
  {
    readonly getDescriptor: () => Effect.Effect<ServerAuthDescriptor>;
    readonly getSessionState: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<AuthSessionState, ServerAuthInternalError>;
    readonly withCloudCredentialPermit: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | CloudCredentialWithdrawal.CloudCredentialWithdrawalError, R>;
    readonly withdrawCloudCredentials: () => Effect.Effect<void, ServerAuthInternalError>;
    readonly completeCloudWithdrawal: () => Effect.Effect<void, ServerAuthInternalError>;
    readonly createBrowserSession: (
      credential: string,
      connection: ConnectionContext | undefined,
      requestMetadata: AuthClientMetadata,
      previousSessionToken?: string,
    ) => Effect.Effect<
      {
        readonly response: AuthBrowserSessionResult;
        readonly sessionToken: string;
        readonly cookieName?: string;
        readonly expireNormalCookie?: boolean;
      },
      ServerAuthInvalidCredentialError | ServerAuthInternalError
    >;
    readonly exchangeBootstrapCredentialForAccessToken: (
      credential: string,
      connection: ConnectionContext | undefined,
      requestedScopes: ReadonlyArray<AuthEnvironmentScope> | undefined,
      requestMetadata: AuthClientMetadata,
      input?: {
        readonly proofKeyThumbprint?: string;
      },
    ) => Effect.Effect<
      AuthAccessTokenResult,
      ServerAuthInvalidCredentialError | ServerAuthInvalidRequestError | ServerAuthInternalError
    >;
    readonly setCloudLinkTrust: (
      userId: string | null,
    ) => Effect.Effect<void, ServerAuthInternalError>;
    readonly createCloudConnectPairingLink: (input: {
      readonly proofKeyThumbprint: string;
      readonly label?: string;
    }) => Effect.Effect<IssuedPairingLink, ServerAuthInternalError>;
    readonly createPairingLink: (input?: {
      readonly ttl?: Duration.Duration;
      readonly label?: string;
      readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
      readonly subject?: string;
      readonly proofKeyThumbprint?: string;
      readonly purpose?: "startup";
    }) => Effect.Effect<IssuedPairingLink, ServerAuthInternalError>;
    readonly issuePairingCredential: (
      input?: AuthCreatePairingCredentialInput,
    ) => Effect.Effect<AuthPairingCredentialResult, ServerAuthInternalError>;
    readonly issueStartupPairingCredential: () => Effect.Effect<
      AuthPairingCredentialResult,
      ServerAuthInternalError
    >;
    readonly listPairingLinks: (input?: {
      readonly excludeSubjects?: ReadonlyArray<string>;
    }) => Effect.Effect<ReadonlyArray<AuthPairingLink>, ServerAuthInternalError>;
    readonly revokePairingLink: (id: string) => Effect.Effect<boolean, ServerAuthInternalError>;
    readonly issueSession: (input?: {
      readonly ttl?: Duration.Duration;
      readonly subject?: string;
      readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
      readonly label?: string;
      /** Caps the threads an `mcp-client` session may start or change; see `authenticateMcpClient`. */
      readonly runtimeModeCeiling?: RuntimeMode;
      readonly childSetupPurpose?: ChildSetupPurpose;
    }) => Effect.Effect<IssuedBearerSession, ServerAuthInternalError>;
    readonly listSessions: () => Effect.Effect<
      ReadonlyArray<AuthClientSession>,
      ServerAuthInternalError
    >;
    readonly revokeSession: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<boolean, ServerAuthInternalError>;
    readonly revokeOtherSessionsExcept: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<number, ServerAuthInternalError>;
    readonly listClientSessions: (
      currentSessionId: AuthSessionId,
    ) => Effect.Effect<ReadonlyArray<AuthClientSession>, ServerAuthInternalError>;
    readonly revokeClientSession: (
      currentSessionId: AuthSessionId,
      targetSessionId: AuthSessionId,
    ) => Effect.Effect<boolean, ServerAuthForbiddenOperationError | ServerAuthInternalError>;
    readonly revokeOtherClientSessions: (
      currentSessionId: AuthSessionId,
    ) => Effect.Effect<number, ServerAuthInternalError>;
    readonly authenticateHttpRequest: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<AuthenticatedSession, ServerAuthCredentialError | ServerAuthInternalError>;
    readonly authenticateWebSocketUpgrade: (
      request: HttpServerRequest.HttpServerRequest,
      use: AuthWebSocketTicketUse,
    ) => Effect.Effect<AuthenticatedSession, ServerAuthCredentialError | ServerAuthInternalError>;
    readonly issueWebSocketTicket: (
      session: Pick<AuthenticatedSession, "sessionId" | "proofKeyThumbprint" | "penBinding"> & {
        readonly principalKind?: SessionPrincipalKind;
      },
      input?: { readonly use?: AuthWebSocketTicketUse },
    ) => Effect.Effect<AuthWebSocketTicketResult, ServerAuthInternalError>;
    readonly issueStartupPairingUrl: (
      baseUrl: string,
    ) => Effect.Effect<string, ServerAuthInternalError>;
    readonly authenticateMcpClient: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<McpClientSession, ServerAuthCredentialError | ServerAuthInternalError>;
    readonly issueMcpClientSession: (input: {
      readonly label: string;
      readonly access: AuthMcpClientAccess;
      readonly memoryScopes?: ReadonlyArray<"memory:read" | "memory:write">;
      readonly workspaceTerminalScopes?: ReadonlyArray<AuthMcpWorkspaceTerminalScope>;
      readonly client: AuthClientMetadata;
    }) => Effect.Effect<
      {
        readonly sessionId: AuthSessionId;
        readonly token: string;
        readonly expiresAt: DateTime.DateTime;
      },
      ServerAuthInternalError
    >;
    /** Spends a code covering all granted scopes. Rejects desktop grants and leaves refused proof-bound codes unspent. */
    readonly consumeMcpApprovalCode: (
      code: string,
      connection: ConnectionContext | undefined,
      access: AuthMcpClientAccess,
      memoryScopes?: ReadonlyArray<"memory:read" | "memory:write">,
      workspaceTerminalScopes?: ReadonlyArray<AuthMcpWorkspaceTerminalScope>,
    ) => Effect.Effect<void, ServerAuthMcpApprovalCodeError | ServerAuthInternalError>;
    readonly authenticateBrowserSession: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<AuthenticatedSession, ServerAuthCredentialError | ServerAuthInternalError>;
  }
>()("goat/auth/EnvironmentAuth") {}

type BootstrapExchangeResult = {
  readonly response: AuthBrowserSessionResult;
  readonly sessionToken: string;
  readonly cookieName?: string;
  readonly expireNormalCookie?: boolean;
};

const AUTHORIZATION_PREFIX = "Bearer ";
const DPOP_AUTHORIZATION_PREFIX = "DPoP ";
const WebSocketUpgradeQuery = Schema.Struct({
  wsTicket: Schema.optionalKey(Schema.RedactedFromValue(Schema.String)),
  dpop: Schema.optionalKey(Schema.RedactedFromValue(Schema.String)),
});
const decodeWebSocketUpgradeQuery = Schema.decodeEffect(WebSocketUpgradeQuery);

const bySessionPriority = (left: AuthClientSession, right: AuthClientSession) => {
  const leftCanManage = left.scopes.includes(AuthAccessWriteScope);
  const rightCanManage = right.scopes.includes(AuthAccessWriteScope);
  if (leftCanManage !== rightCanManage) {
    return leftCanManage ? -1 : 1;
  }
  if (left.connected !== right.connected) {
    return left.connected ? -1 : 1;
  }
  return right.issuedAt.epochMilliseconds - left.issuedAt.epochMilliseconds;
};

function toBootstrapExchangeError(
  cause: PairingGrantStore.BootstrapCredentialError,
): ServerAuthInvalidCredentialError | ServerAuthInternalError {
  if (PairingGrantStore.isBootstrapCredentialInternalError(cause)) {
    return new ServerAuthBootstrapCredentialValidationError({ cause });
  }

  return new ServerAuthInvalidCredentialError({
    cause,
  });
}

const rejectMcpClientAudience = <S extends { readonly subject: string }>(session: S) =>
  session.subject === MCP_CLIENT_SUBJECT
    ? Effect.fail(
        new ServerAuthInvalidCredentialError({
          diagnostic: "MCP client sessions are only accepted by the MCP endpoint.",
        }),
      ).pipe(Effect.tap(() => Effect.logWarning("Rejected an MCP client session outside /mcp.")))
    : Effect.succeed(session);

const mapSessionVerificationErrors = <A, R>(
  effect: Effect.Effect<A, SessionStore.SessionCredentialError, R>,
): Effect.Effect<A, ServerAuthInvalidCredentialError | ServerAuthInternalError, R> =>
  effect.pipe(
    Effect.mapError((cause) =>
      SessionStore.isSessionCredentialInvalidError(cause)
        ? new ServerAuthInvalidCredentialError({ cause })
        : new ServerAuthSessionCredentialValidationError({ cause }),
    ),
  );

export function parseBearerToken(request: HttpServerRequest.HttpServerRequest): string | null {
  const header = request.headers["authorization"];
  if (typeof header !== "string" || !/^Bearer /i.test(header)) {
    return null;
  }
  const token = header.slice(AUTHORIZATION_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

function parseDpopToken(request: HttpServerRequest.HttpServerRequest): string | null {
  const header = request.headers["authorization"];
  if (typeof header !== "string" || !/^DPoP /i.test(header)) {
    return null;
  }
  const token = header.slice(DPOP_AUTHORIZATION_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

export function selectRequestCredential(
  request: HttpServerRequest.HttpServerRequest,
  cookieName: string,
  legacyCookieName: string | undefined,
) {
  const primaryCookie = request.cookies[cookieName];
  if (primaryCookie) return { token: primaryCookie, source: "cookie" } as const;
  const scopedLegacyCookie = request.cookies[legacyScopedSessionCookieName(cookieName)];
  if (scopedLegacyCookie) return { token: scopedLegacyCookie, source: "legacy-cookie" } as const;

  const bearerToken = parseBearerToken(request);
  if (bearerToken !== null) {
    return { token: bearerToken, source: "bearer" } as const;
  }

  const dpopToken = parseDpopToken(request);
  if (dpopToken !== null) {
    return { token: dpopToken, source: "dpop" } as const;
  }

  const legacyToken = legacyCookieName ? request.cookies[legacyCookieName] : undefined;
  if (legacyToken !== undefined) {
    return { token: legacyToken, source: "legacy-cookie" } as const;
  }

  return undefined;
}

type RequestCredentialSource = NonNullable<ReturnType<typeof selectRequestCredential>>["source"];

export const isBrowserCookieCredential = (source: RequestCredentialSource | "dev-cookie") =>
  source === "cookie" || source === "legacy-cookie" || source === "dev-cookie";

function firstHeaderValue(value: string | undefined): string | undefined {
  const first = value?.split(",")[0]?.trim().toLowerCase();
  return first && first.length > 0 ? first : undefined;
}

// Missing Origin allows same-origin reads and non-browser clients; otherwise require
// same-origin Sec-Fetch-Site, this server's host (including X-Forwarded-Host), or a trusted app origin.
function isBrowserOriginAllowed(
  request: HttpServerRequest.HttpServerRequest,
  trustedOrigins: ReadonlySet<string>,
): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (request.headers["sec-fetch-site"] === "same-origin") return true;
  if (trustedOrigins.has(origin)) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  if (originHost === "") return false;
  return (
    originHost === firstHeaderValue(request.headers.host) ||
    originHost === firstHeaderValue(request.headers["x-forwarded-host"])
  );
}

/** @public */
export const make = Effect.gen(function* () {
  const withdrawal = yield* CloudCredentialWithdrawal.make;
  const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
  const connectAccess = yield* HubConnectAccess.HubConnectAccess;
  const { createPairingLink, createCloudConnectPairingLink, admit } =
    yield* ConnectHubCredentials.make;
  const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
  const sessions = yield* SessionStore.SessionStore;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const descriptor = yield* policy.getDescriptor();
  const config = yield* ServerConfig.ServerConfig;
  const devAuth = resolveReusableDevAuth(config);

  const authenticateToken = (
    token: string,
    connection: ConnectionContext | undefined,
  ): Effect.Effect<
    AuthenticatedSession,
    ServerAuthInvalidCredentialError | ServerAuthInternalError
  > =>
    sessions.verify(token, connection).pipe(
      Effect.tapError((cause) =>
        SessionStore.isSessionCredentialInvalidError(cause)
          ? Effect.logWarning("Rejected authenticated session credential.").pipe(
              Effect.annotateLogs({
                reason: cause.message,
              }),
            )
          : Effect.void,
      ),
      mapSessionVerificationErrors,
      Effect.tap((session) => withdrawal.guard(session.subject)),
      Effect.flatMap(rejectMcpClientAudience),
      Effect.flatMap(admit),
      Effect.map(ConnectHubCredentials.authenticatedSession),
    );

  const resolveRequestCredential = (request: HttpServerRequest.HttpServerRequest) => {
    const selectedCredential = selectRequestCredential(
      request,
      sessions.cookieName,
      sessions.legacyCookieName,
    );
    const hasAuthorization = request.headers.authorization !== undefined;
    const devCookieToken = devAuth
      ? (request.cookies[devAuth.cookieName] ?? request.cookies[devAuth.legacyCookieName])
      : undefined;
    return (
      selectedCredential ??
      (!hasAuthorization && devCookieToken !== undefined
        ? { token: devCookieToken, source: "dev-cookie" as const }
        : undefined)
    );
  };

  // Cookies span ports; reject cookie-authenticated requests and sockets from other same-site origins.
  const trustedBrowserOrigins = new Set<string>([
    ...(config.devUrl ? [config.devUrl.origin] : []),
    ...DESKTOP_RENDERER_ORIGINS,
    ...config.devAllowedOrigins,
  ]);

  const authenticateRequest = (
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<AuthenticatedSession, ServerAuthCredentialError | ServerAuthInternalError> => {
    const dpopToken = parseDpopToken(request);
    const credential = resolveRequestCredential(request);
    if (!credential?.token) {
      return Effect.fail(new ServerAuthMissingCredentialError({}));
    }
    if (
      isBrowserCookieCredential(credential.source) &&
      !isBrowserOriginAllowed(request, trustedBrowserOrigins)
    ) {
      return Effect.fail(
        new ServerAuthInvalidCredentialError({
          diagnostic: "Browser sessions are only accepted from the app's own origin.",
        }),
      );
    }
    return authenticateToken(credential.token, connectionOf(request)).pipe(
      Effect.flatMap((session) => {
        if (session.proofKeyThumbprint) {
          if (!dpopToken || dpopToken !== credential.token) {
            return Effect.fail(
              new ServerAuthInvalidCredentialError({
                diagnostic: "DPoP-bound access token requires DPoP authorization.",
                dpopFailureReason: "invalid_proof",
              }),
            );
          }
          return verifyRequestDpopProof({
            request,
            expectedThumbprint: session.proofKeyThumbprint,
            expectedAccessToken: dpopToken,
          }).pipe(
            Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.as(session),
          );
        }
        if (dpopToken) {
          return Effect.fail(
            new ServerAuthInvalidCredentialError({
              diagnostic: "DPoP authorization requires a proof-bound access token.",
              dpopFailureReason: "invalid_proof",
            }),
          );
        }
        return Effect.succeed(session);
      }),
    );
  };

  const getSessionState: EnvironmentAuth["Service"]["getSessionState"] = (request) =>
    authenticateRequest(request).pipe(
      Effect.map(
        (session) =>
          ({
            authenticated: true,
            auth: descriptor,
            ...authScopeResponse(session.scopes),
            sessionMethod: session.method,
            ...(session.expiresAt ? { expiresAt: DateTime.toUtc(session.expiresAt) } : {}),
            ...(canDelegateHubProxy({
              subject: session.subject,
              holds: (scope) => session.scopes.includes(scope),
            })
              ? { canDelegateHubProxy: true }
              : {}),
          }) satisfies AuthSessionState,
      ),
      Effect.catchIf(isServerAuthCredentialError, () =>
        Effect.succeed({
          authenticated: false,
          auth: descriptor,
        } satisfies AuthSessionState),
      ),
      Effect.withSpan("EnvironmentAuth.getSessionState"),
    );

  const createBrowserSession: EnvironmentAuth["Service"]["createBrowserSession"] = Effect.fn(
    "EnvironmentAuth.createBrowserSession",
  )(function* (credential, connection, requestMetadata, previousSessionToken) {
    if (devAuth?.matches(credential)) {
      return yield* sessions.verify(credential, connection).pipe(
        mapSessionVerificationErrors,
        Effect.flatMap((session) =>
          DateTime.now.pipe(
            Effect.map(
              (now) =>
                ({
                  response: {
                    authenticated: true,
                    ...authScopeResponse(session.scopes),
                    sessionMethod: session.method,
                    expiresAt: DateTime.toUtc(DateTime.add(now, { days: 30 })),
                  } satisfies AuthBrowserSessionResult,
                  sessionToken: credential,
                  cookieName: devAuth.cookieName,
                  expireNormalCookie: true,
                }) satisfies BootstrapExchangeResult,
            ),
          ),
        ),
        Effect.withSpan("EnvironmentAuth.createBrowserSession"),
      );
    }
    const previousSession =
      previousSessionToken === undefined
        ? undefined
        : yield* sessions.verify(previousSessionToken, connection).pipe(
            Effect.catchIf(SessionStore.isSessionCredentialInvalidError, () => Effect.void),
            Effect.mapError((cause) => new ServerAuthSessionCredentialValidationError({ cause })),
          );
    const grant = yield* bootstrapCredentials
      .consume(credential)
      .pipe(Effect.mapError(toBootstrapExchangeError));
    yield* withdrawal.guard(grant.subject);
    yield* admit(grant);
    const session = yield* sessions
      .issue({
        method: "browser-session-cookie",
        subject: grant.subject,
        ...(grant.connectAccessGeneration !== undefined
          ? { connectAccessGeneration: grant.connectAccessGeneration }
          : {}),
        scopes: grant.scopes,
        ...(previousSession?.method === "browser-session-cookie"
          ? { replaceSessionId: previousSession.sessionId }
          : {}),
        client: {
          ...requestMetadata,
          ...(grant.label ? { label: grant.label } : {}),
        },
      })
      .pipe(Effect.mapError((cause) => new ServerAuthAuthenticatedSessionIssueError({ cause })));
    return {
      response: {
        authenticated: true,
        ...authScopeResponse(session.scopes),
        sessionMethod: session.method,
        expiresAt: DateTime.toUtc(session.expiresAt),
      } satisfies AuthBrowserSessionResult,
      sessionToken: session.token,
    } satisfies BootstrapExchangeResult;
  });

  type ResolvedBootstrapGrant = Pick<
    PairingGrantStore.BootstrapGrant,
    "scopes" | "subject" | "label" | "connectAccessGeneration"
  > & {
    readonly method: PairingGrantStore.BootstrapGrant["method"] | "reusable-dev-token";
  };
  const resolveBootstrapGrant = (
    credential: string,
    connection: ConnectionContext | undefined,
    input?: {
      readonly proofKeyThumbprint?: string;
      readonly requestedScopes?: ReadonlyArray<AuthEnvironmentScope>;
      readonly requiredScopes?: ReadonlyArray<AuthEnvironmentScope>;
    },
  ): Effect.Effect<
    ResolvedBootstrapGrant,
    ServerAuthInvalidCredentialError | ServerAuthInternalError | ServerAuthScopeNotGrantedError
  > => {
    if (!devAuth?.matches(credential)) {
      return bootstrapCredentials.consume(credential, input).pipe(
        Effect.mapError((cause) =>
          cause._tag === "BootstrapCredentialScopeNotGrantedError"
            ? new ServerAuthScopeNotGrantedError({})
            : toBootstrapExchangeError(cause),
        ),
        Effect.flatMap(admit),
      );
    }
    return sessions.verify(credential, connection).pipe(
      mapSessionVerificationErrors,
      Effect.filterOrFail(
        (session) =>
          input?.requiredScopes === undefined ||
          input.requiredScopes.every((scope) => session.scopes.includes(scope)),
        () => new ServerAuthScopeNotGrantedError({}),
      ),
      Effect.map(
        (session) =>
          ({
            method: "reusable-dev-token",
            scopes: session.scopes,
            subject: "reusable-dev-token-child",
          }) satisfies ResolvedBootstrapGrant,
      ),
    );
  };

  const exchangeBootstrapCredentialForAccessToken: EnvironmentAuth["Service"]["exchangeBootstrapCredentialForAccessToken"] =
    (credential, connection, requestedScopes, requestMetadata, input) => {
      return resolveBootstrapGrant(credential, connection, {
        ...input,
        ...(requestedScopes !== undefined ? { requestedScopes } : {}),
      }).pipe(
        Effect.flatMap((grant) =>
          Effect.gen(function* () {
            yield* withdrawal.guard(grant.subject);
            yield* admit(grant);
            const grantedScopes =
              requestedScopes === undefined
                ? grant.scopes
                : [...new Set(requestedScopes)].filter((scope) => grant.scopes.includes(scope));
            if (grantedScopes.length === 0) {
              return yield* new ServerAuthScopeNotGrantedError({});
            }
            return yield* sessions
              .issue({
                method: input?.proofKeyThumbprint ? "dpop-access-token" : "bearer-access-token",
                subject: grant.subject,
                ...(grant.connectAccessGeneration !== undefined
                  ? { connectAccessGeneration: grant.connectAccessGeneration }
                  : {}),
                scopes: grantedScopes,
                ...(input?.proofKeyThumbprint
                  ? {
                      proofKeyThumbprint: input.proofKeyThumbprint,
                      ttl: Duration.hours(1),
                    }
                  : {}),
                replaceActiveForSubjectAndMethod: grant.method === "desktop-bootstrap",
                client: {
                  ...requestMetadata,
                  ...(grant.label ? { label: grant.label } : {}),
                },
              })
              .pipe(
                Effect.mapError(
                  (cause) => new ServerAuthAuthenticatedAccessTokenIssueError({ cause }),
                ),
              );
          }),
        ),
        Effect.flatMap((session) =>
          DateTime.now.pipe(
            Effect.map(
              (now) =>
                ({
                  access_token: session.token,
                  issued_token_type: AuthAccessTokenType,
                  token_type: input?.proofKeyThumbprint ? "DPoP" : "Bearer",
                  expires_in: Math.max(
                    0,
                    Math.floor(
                      (session.expiresAt.epochMilliseconds - now.epochMilliseconds) / 1000,
                    ),
                  ),
                  scope: encodeOAuthScope(session.scopes),
                }) satisfies AuthAccessTokenResult,
            ),
          ),
        ),
        Effect.withSpan("EnvironmentAuth.exchangeBootstrapCredentialForAccessToken"),
      );
    };

  const issuePairingCredentialForSubject = (input: {
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
    readonly subject: string;
    readonly label?: string;
    readonly purpose?: "startup";
  }) =>
    createPairingLink({
      scopes: input.scopes,
      subject: input.subject,
      ...(input.label ? { label: input.label } : {}),
      ...(input.purpose ? { purpose: input.purpose } : {}),
    }).pipe(
      Effect.map(
        (issued) =>
          ({
            id: issued.id,
            credential: issued.credential,
            ...(issued.label ? { label: issued.label } : {}),
            expiresAt: issued.expiresAt,
          }) satisfies AuthPairingCredentialResult,
      ),
    );

  const listPairingLinks: EnvironmentAuth["Service"]["listPairingLinks"] = (input) =>
    bootstrapCredentials.listActive().pipe(
      Effect.map((pairingLinks) => {
        const excludedSubjects = input?.excludeSubjects ?? [
          INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT,
        ];
        return pairingLinks
          .filter((pairingLink) => !excludedSubjects.includes(pairingLink.subject))
          .map((link) => ({ ...link, ...authScopeResponse(link.scopes) }))
          .toSorted(
            (left, right) => right.createdAt.epochMilliseconds - left.createdAt.epochMilliseconds,
          );
      }),
      Effect.mapError((cause) => new ServerAuthPairingLinksListError({ cause })),
      Effect.withSpan("EnvironmentAuth.listPairingLinks"),
    );

  const revokePairingLink: EnvironmentAuth["Service"]["revokePairingLink"] = (id) =>
    bootstrapCredentials.revoke(id).pipe(
      Effect.mapError((cause) => new ServerAuthPairingLinkRevocationError({ cause })),
      Effect.withSpan("EnvironmentAuth.revokePairingLink"),
    );

  const issueSession = yield* IssuedEnvironmentSession.make(DEFAULT_SESSION_SUBJECT);

  const listSessions: EnvironmentAuth["Service"]["listSessions"] = () =>
    sessions.listActive().pipe(
      Effect.map((activeSessions) => activeSessions.toSorted(bySessionPriority)),
      Effect.mapError((cause) => new ServerAuthSessionsListError({ cause })),
      Effect.withSpan("EnvironmentAuth.listSessions"),
    );

  const revokeSession: EnvironmentAuth["Service"]["revokeSession"] = (sessionId) =>
    sessions.revoke(sessionId).pipe(
      Effect.mapError((cause) => new ServerAuthSessionRevocationError({ cause })),
      Effect.withSpan("EnvironmentAuth.revokeSession"),
    );

  const revokeOtherSessionsExcept: EnvironmentAuth["Service"]["revokeOtherSessionsExcept"] = (
    sessionId,
  ) =>
    sessions.revokeAllExcept(sessionId).pipe(
      Effect.mapError((cause) => new ServerAuthOtherSessionsRevocationError({ cause })),
      Effect.withSpan("EnvironmentAuth.revokeOtherSessionsExcept"),
    );

  const issuePairingCredential: EnvironmentAuth["Service"]["issuePairingCredential"] = (input) =>
    issuePairingCredentialForSubject({
      scopes: input?.scopes ?? AuthStandardClientScopes,
      subject: "one-time-token",
      ...(input?.label ? { label: input.label } : {}),
    }).pipe(Effect.withSpan("EnvironmentAuth.issuePairingCredential"));

  const issueStartupPairingCredential: EnvironmentAuth["Service"]["issueStartupPairingCredential"] =
    () => {
      const fallback = issuePairingCredentialForSubject({
        scopes: AuthStandardClientScopes,
        subject: INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT,
        purpose: "startup",
      });
      if (!devAuth) {
        return fallback.pipe(Effect.withSpan("EnvironmentAuth.issueStartupPairingCredential"));
      }
      return sessions.verifyStartupDevCredential().pipe(
        Effect.map(
          (session) =>
            ({
              id: session.sessionId,
              credential: devAuth.credential,
              label: "Reusable dev token",
              expiresAt: DateTime.toUtc(session.expiresAt ?? REUSABLE_DEV_SESSION_EXPIRES_AT),
            }) satisfies AuthPairingCredentialResult,
        ),
        Effect.catch((cause) =>
          SessionStore.isSessionCredentialInvalidError(cause)
            ? fallback
            : Effect.fail(new ServerAuthPairingLinkCreationError({ cause })),
        ),
        Effect.withSpan("EnvironmentAuth.issueStartupPairingCredential"),
      );
    };

  const listClientSessions: EnvironmentAuth["Service"]["listClientSessions"] = (currentSessionId) =>
    listSessions().pipe(
      Effect.map((clientSessions) =>
        clientSessions.map((clientSession): AuthClientSession => ({
          ...clientSession,
          ...authScopeResponse(clientSession.scopes),
          current: clientSession.sessionId === currentSessionId,
        })),
      ),
      Effect.withSpan("EnvironmentAuth.listClientSessions"),
    );

  const revokeClientSession: EnvironmentAuth["Service"]["revokeClientSession"] = Effect.fn(
    "EnvironmentAuth.revokeClientSession",
  )(function* (currentSessionId, targetSessionId) {
    if (currentSessionId === targetSessionId) {
      return yield* new ServerAuthForbiddenOperationError({});
    }
    return yield* revokeSession(targetSessionId);
  });

  const revokeOtherClientSessions: EnvironmentAuth["Service"]["revokeOtherClientSessions"] = (
    currentSessionId,
  ) =>
    revokeOtherSessionsExcept(currentSessionId).pipe(
      Effect.withSpan("EnvironmentAuth.revokeOtherClientSessions"),
    );

  const issueStartupPairingUrl: EnvironmentAuth["Service"]["issueStartupPairingUrl"] = (baseUrl) =>
    issueStartupPairingCredential().pipe(
      Effect.map((issued) => {
        const url = new URL(baseUrl);
        url.pathname = "/pair";
        url.searchParams.delete("token");
        url.hash = new URLSearchParams([["token", issued.credential]]).toString();
        return url.toString();
      }),
      Effect.withSpan("EnvironmentAuth.issueStartupPairingUrl"),
    );

  // Only the RPC socket's ticket is bound to the client's proof key. The media
  // routes reuse one ticket across <img>, EventSource and several sockets, and
  // each of those would need its own single-use proof.
  const issueWebSocketTicket: EnvironmentAuth["Service"]["issueWebSocketTicket"] = (
    session,
    input,
  ) =>
    // Pen-bound sessions never need tickets: upstream sockets carry a bearer header.
    session.penBinding !== undefined
      ? Effect.fail(new ServerAuthWebSocketTokenIssueError({ cause: "Pen-bound session" }))
      : sessions
          .issueWebSocketToken(session.sessionId, {
            ...(session.principalKind === undefined
              ? {}
              : { principalKind: session.principalKind }),
            ...(input?.use ? { audience: input.use } : {}),
            ...(input?.use === "rpc" && session.proofKeyThumbprint
              ? { proofKeyThumbprint: session.proofKeyThumbprint }
              : {}),
          })
          .pipe(
            Effect.mapError((cause) => new ServerAuthWebSocketTokenIssueError({ cause })),
            Effect.map(
              (issued) =>
                ({
                  ticket: Redacted.make(issued.token),
                  expiresAt: DateTime.toUtc(issued.expiresAt),
                }) satisfies AuthWebSocketTicketResult,
            ),
            Effect.withSpan("EnvironmentAuth.issueWebSocketTicket"),
          );

  const authenticateHttpRequest: EnvironmentAuth["Service"]["authenticateHttpRequest"] = (
    request,
  ) =>
    authenticateRequest(request).pipe(Effect.withSpan("EnvironmentAuth.authenticateHttpRequest"));

  const authenticateWebSocketUpgrade: EnvironmentAuth["Service"]["authenticateWebSocketUpgrade"] =
    Effect.fn("EnvironmentAuth.authenticateWebSocketUpgrade")(function* (request, use) {
      const requestUrl = HttpServerRequest.toURL(request);
      if (Option.isSome(requestUrl)) {
        const query = yield* decodeWebSocketUpgradeQuery(
          Object.fromEntries(requestUrl.value.searchParams),
        ).pipe(Effect.orDie);
        const websocketTicket = query.wsTicket && Redacted.value(query.wsTicket);
        if (websocketTicket && websocketTicket.trim().length > 0) {
          const session = yield* sessions
            .verifyWebSocketToken(websocketTicket, connectionOf(request))
            .pipe(
              mapSessionVerificationErrors,
              Effect.tap((session) => withdrawal.guard(session.subject)),
              Effect.flatMap(rejectMcpClientAudience),
              Effect.flatMap(admit),
            );
          yield* ConnectHubCredentials.admitSocketUse(session, use);
          if (session.proofKeyThumbprint) {
            // WebSocket clients cannot set headers, so the proof travels in the query.
            // The proof hashes the ticket; consuming its jti prevents replay after first use.
            // Only encrypted transport prevents an active interceptor from racing that use.
            const proof = request.headers.dpop ?? (query.dpop && Redacted.value(query.dpop));
            if (!proof) {
              return yield* new ServerAuthInvalidCredentialError({
                diagnostic: "DPoP-bound WebSocket ticket requires a DPoP proof.",
                dpopFailureReason: "invalid_proof",
              });
            }
            yield* verifyRequestDpopProof({
              request,
              proof,
              expectedThumbprint: session.proofKeyThumbprint,
              expectedAccessToken: websocketTicket,
            }).pipe(
              Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
              Effect.provideService(Crypto.Crypto, crypto),
            );
          }
          return ConnectHubCredentials.authenticatedSession(session);
        }
      }

      return yield* authenticateRequest(request);
    });
  const authenticateMcpClient: EnvironmentAuth["Service"]["authenticateMcpClient"] = (request) => {
    const token = parseBearerToken(request);
    if (token === null) return Effect.fail(new ServerAuthMissingCredentialError({}));
    return sessions.verify(token, connectionOf(request)).pipe(
      mapSessionVerificationErrors,
      Effect.flatMap((session) =>
        session.subject === MCP_CLIENT_SUBJECT && session.method === "bearer-access-token"
          ? sessions.markUsed(session.sessionId).pipe(
              Effect.as({
                sessionId: session.sessionId,
                label: session.client.label ?? "MCP client",
                access: session.scopes.includes(AuthOrchestrationOperateScope)
                  ? (session.runtimeModeCeiling ?? "approval-required")
                  : "read-only",
                grantedScopes: session.scopes,
                ...(session.childSetupPurpose
                  ? { childSetupPurpose: session.childSetupPurpose }
                  : {}),
                reauthorize: reauthorizeSession(sessions, session.sessionId),
                approvals:
                  session.scopes.includes(AuthOrchestrationOperateScope) &&
                  session.scopes.includes(AuthOrchestrationApproveScope),
              } satisfies McpClientSession),
            )
          : Effect.fail(
              new ServerAuthInvalidCredentialError({
                diagnostic: "Only MCP client sessions are accepted here.",
              }),
            ),
      ),
      Effect.withSpan("EnvironmentAuth.authenticateMcpClient"),
    );
  };
  const issueMcpClientSession: EnvironmentAuth["Service"]["issueMcpClientSession"] = (input) =>
    sessions
      .issue({
        subject: MCP_CLIENT_SUBJECT,
        method: "bearer-access-token",
        scopes: mcpClientScopes(input.access, input.memoryScopes, input.workspaceTerminalScopes),
        ttl: MCP_CLIENT_SESSION_TTL,
        ...(input.access === "read-only" ? {} : { runtimeModeCeiling: input.access }),
        client: { ...input.client, label: input.label, deviceType: "bot" },
      })
      .pipe(
        Effect.map((issued) => ({
          sessionId: issued.sessionId,
          token: issued.token,
          expiresAt: issued.expiresAt,
        })),
        Effect.mapError((cause) => new ServerAuthSessionTokenIssueError({ cause })),
        Effect.withSpan("EnvironmentAuth.issueMcpClientSession"),
      );
  const authenticateBrowserSession: EnvironmentAuth["Service"]["authenticateBrowserSession"] = (
    request,
  ) => {
    const credential = resolveRequestCredential(request);
    if (!credential || !isBrowserCookieCredential(credential.source)) {
      return Effect.fail(new ServerAuthMissingCredentialError({}));
    }
    return authenticateRequest(request).pipe(
      Effect.filterOrFail(
        (session) => session.method === "browser-session-cookie",
        () => new ServerAuthInvalidCredentialError({ diagnostic: "Not a browser session." }),
      ),
      Effect.withSpan("EnvironmentAuth.authenticateBrowserSession"),
    );
  };
  const consumeMcpApprovalCode: EnvironmentAuth["Service"]["consumeMcpApprovalCode"] = (
    code,
    connection,
    access,
    memoryScopes,
    workspaceTerminalScopes,
  ) =>
    resolveBootstrapGrant(code.trim(), connection, {
      requiredScopes: mcpClientScopes(access, memoryScopes, workspaceTerminalScopes),
    }).pipe(
      Effect.catchTags({
        ServerAuthInvalidCredentialError: () =>
          Effect.fail(new ServerAuthMcpApprovalCodeError({ reason: "unknown_or_used" })),
        ServerAuthScopeNotGrantedError: () =>
          Effect.fail(new ServerAuthMcpApprovalCodeError({ reason: "insufficient_scope" })),
      }),
      Effect.flatMap((grant) =>
        grant.method !== "one-time-token" && grant.method !== "reusable-dev-token"
          ? Effect.fail(new ServerAuthMcpApprovalCodeError({ reason: "not_a_pairing_code" }))
          : Effect.void,
      ),
      (exchange) => connectAccess.withPolicy(() => exchange),
      Effect.withSpan("EnvironmentAuth.consumeMcpApprovalCode"),
    );
  return EnvironmentAuth.of({
    getDescriptor: Effect.fn("EnvironmentAuth.getDescriptor")(function () {
      return Effect.succeed(descriptor);
    }),
    getSessionState,
    withCloudCredentialPermit: Effect.fn("EnvironmentAuth.withCloudCredentialPermit")(
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        withdrawal.withPermit(withdrawal.guard("cloud-connect").pipe(Effect.andThen(effect))),
    ),
    withdrawCloudCredentials: withdrawal.withdraw,
    completeCloudWithdrawal: withdrawal.complete,
    createBrowserSession: Effect.fn("EnvironmentAuth.exchangeBrowserCredential")((...args) =>
      withdrawal.withPermit(connectAccess.withPolicy(() => createBrowserSession(...args))),
    ),
    exchangeBootstrapCredentialForAccessToken: Effect.fn(
      "EnvironmentAuth.exchangeAccessCredential",
    )((...args) =>
      withdrawal.withPermit(
        connectAccess.withPolicy(() => exchangeBootstrapCredentialForAccessToken(...args)),
      ),
    ),
    createCloudConnectPairingLink: Effect.fn("EnvironmentAuth.createCloudConnectPairingLink")(
      (input) =>
        withdrawal.withPermit(
          withdrawal
            .guard("cloud-connect")
            .pipe(Effect.andThen(createCloudConnectPairingLink(input))),
        ),
    ),
    createPairingLink: Effect.fn("EnvironmentAuth.createPairingLink")((input) =>
      withdrawal.withPermit(
        withdrawal
          .guard(input?.subject ?? "one-time-token")
          .pipe(Effect.andThen(createPairingLink(input))),
      ),
    ),
    setCloudLinkTrust: Effect.fn("EnvironmentAuth.setCloudLinkTrust")((userId) =>
      withdrawal.withPermit(
        connectAccess
          .rotate(bootstrapCredentials.setCloudTrust(userId))
          .pipe(Effect.mapError((cause) => new ServerAuthPairingLinkCreationError({ cause }))),
      ),
    ),
    issuePairingCredential,
    issueStartupPairingCredential,
    listPairingLinks,
    revokePairingLink,
    issueSession: Effect.fn("EnvironmentAuth.issueSession")((input) =>
      withdrawal.withPermit(
        withdrawal
          .guard(input?.subject ?? DEFAULT_SESSION_SUBJECT)
          .pipe(Effect.andThen(issueSession(input))),
      ),
    ),
    listSessions,
    revokeSession,
    revokeOtherSessionsExcept,
    listClientSessions,
    revokeClientSession,
    revokeOtherClientSessions,
    authenticateHttpRequest,
    authenticateWebSocketUpgrade,
    issueWebSocketTicket,
    issueStartupPairingUrl,
    authenticateMcpClient,
    issueMcpClientSession,
    consumeMcpApprovalCode,
    authenticateBrowserSession,
  });
});
export const layer = Layer.effect(EnvironmentAuth, make).pipe(
  Layer.provideMerge(HubConnectAccess.layer),
  Layer.provideMerge(EnvironmentAuthPolicy.layer),
);
const layerStorage = Layer.mergeAll(ServerSecretStore.layer, SqlitePersistence.layerConfig);
export const layerRuntime = layer.pipe(
  Layer.provideMerge(layerStorage),
  Layer.provideMerge(ServerEnvironment.layerIdentity),
);
