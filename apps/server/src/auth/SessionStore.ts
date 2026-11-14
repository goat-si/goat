import { fromSecret } from "./PayloadSigner.ts";
import {
  SessionClaims,
  WebSocketClaims,
  decodeSessionClaims,
  decodeWebSocketClaims,
} from "./sessionClaims.ts";
import * as CloudSessionFence from "./CloudSessionFence.ts";
import * as PenMemberSessionFence from "./PenMemberSessionFence.ts";
import {
  AuthSessionId,
  PenId,
  AuthStandardClientScopes,
  type AuthClientMetadata,
  type AuthClientSession,
  type AuthEnvironmentScope,
  type AuthWebSocketTicketUse,
  type ChildSetupPurpose,
  type ClientSurface,
  type RuntimeMode,
  type ServerAuthSessionMethod,
  type SessionPrincipalKind,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import type { ConnectionContext } from "./connectionContext.ts";
import {
  admitBinding,
  defaultPrincipalKind,
  issueShapeRefusal,
  PEN_SESSION_MAX_TTL,
} from "./sessionBinding.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import {
  REUSABLE_DEV_SESSION_EXPIRES_AT,
  REUSABLE_DEV_SESSION_PREFIX,
  resolveReusableDevAuth,
} from "./ReusableDevAuth.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  resolveLegacySessionCookieName,
  resolveSessionCookieName,
} from "./utils.ts";
import * as ChildSetupSession from "./childSetupSession.ts";
import {
  createDefaultClientMetadata,
  toAuthClientSession,
  toClientMetadata,
} from "./sessionClientMetadata.ts";

export interface IssuedSession {
  readonly childSetupPurpose?: ChildSetupPurpose;
  readonly sessionId: AuthSessionId;
  readonly token: string;
  readonly method: ServerAuthSessionMethod;
  readonly client: AuthClientMetadata;
  readonly expiresAt: DateTime.DateTime;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly proofKeyThumbprint?: string;
}

export interface VerifiedSession {
  readonly sessionId: AuthSessionId;
  readonly token: string;
  readonly method: ServerAuthSessionMethod;
  readonly client: AuthClientMetadata;
  readonly expiresAt?: DateTime.DateTime;
  readonly subject: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly connectAccessGeneration?: number;
  readonly proofKeyThumbprint?: string;
  readonly runtimeModeCeiling?: RuntimeMode;
  readonly childSetupPurpose?: ChildSetupPurpose;
  readonly principalKind: SessionPrincipalKind;
  readonly penBinding?: AuthSessions.AuthSessionPenBinding;
  readonly penMemberNode: string | null;
}
export interface VerifiedWebSocketTicket extends VerifiedSession {
  readonly audience?: AuthWebSocketTicketUse;
}
export type SessionCredentialChange =
  | {
      readonly type: "clientUpserted";
      readonly clientSession: AuthClientSession;
    }
  | {
      readonly type: "clientRemoved";
      readonly sessionId: AuthSessionId;
    };

export * from "./sessionStoreErrors.ts";
import {
  SessionBindingRefusedError,
  MalformedSessionTokenError,
  InvalidSessionTokenSignatureError,
  InvalidSessionTokenPayloadError,
  SessionTokenExpiredError,
  UnknownSessionTokenError,
  SessionTokenRevokedError,
  InvalidSessionExpirationClaimError,
  MalformedWebSocketTokenError,
  InvalidWebSocketTokenSignatureError,
  InvalidWebSocketTokenPayloadError,
  WebSocketTokenExpiredError,
  UnknownWebSocketSessionError,
  WebSocketSessionExpiredError,
  WebSocketSessionRevokedError,
  SessionClaimsEncodingError,
  SessionCredentialIssueError,
  SessionCredentialVerificationError,
  WebSocketTokenIssueError,
  WebSocketTokenVerificationError,
  ActiveSessionsListError,
  SessionRevocationError,
  OtherSessionsRevocationError,
  SessionCredentialInternalError,
  SessionCredentialError,
} from "./sessionStoreErrors.ts";

export class SessionStore extends Context.Service<
  SessionStore,
  {
    readonly cookieName: string;
    readonly legacyCookieName: string | undefined;
    readonly issue: (input?: {
      readonly ttl?: Duration.Duration;
      readonly subject?: string;
      readonly penMemberNode?: string;
      readonly method?: ServerAuthSessionMethod;
      readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
      readonly client?: AuthClientMetadata;
      readonly connectAccessGeneration?: number;
      readonly proofKeyThumbprint?: string;
      readonly runtimeModeCeiling?: RuntimeMode;
      readonly childSetupPurpose?: ChildSetupPurpose;
      readonly replaceActiveForSubjectAndMethod?: boolean;
      readonly replaceSessionId?: AuthSessionId;
      /** Defaults by subject (mcp-client: outside_client, else person); pen-proxy must name it. */
      readonly principalKind?: SessionPrincipalKind;
      readonly penBinding?: AuthSessions.AuthSessionPenBinding;
    }) => Effect.Effect<IssuedSession, SessionCredentialInternalError>;
    /**
     * Token-free live authority; revocation and expiry are checked on every read. A memory read
     * with no SQL or lock, so it is safe inside a SQL transaction. Covers sessions loaded at
     * startup, issued here, or accepted by `verify`, including ones another process issued.
     */
    readonly setPenMembersAdmitted: (view: ReadonlySet<string> | "closed") => Effect.Effect<void>;
    readonly listPenMemberSessions: Effect.Effect<
      ReadonlyArray<{ readonly sessionId: AuthSessionId; readonly penMemberNode: string }>
    >;
    readonly setCloudWithdrawalPending: (pending: boolean) => Effect.Effect<void>;
    readonly readActiveScopes: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<ReadonlyArray<AuthEnvironmentScope>, SessionCredentialError>;
    /** Ends in admitBinding: the connection is required and never defaulted. */
    readonly verify: (
      token: string,
      connection: ConnectionContext | undefined,
    ) => Effect.Effect<VerifiedSession, SessionCredentialError>;
    /** Server startup's own check of the reusable dev credential; takes no token. */
    readonly verifyStartupDevCredential: () => Effect.Effect<
      VerifiedSession,
      SessionCredentialError
    >;
    readonly issueWebSocketToken: (
      sessionId: AuthSessionId,
      input?: {
        readonly ttl?: Duration.Duration;
        readonly audience?: AuthWebSocketTicketUse;
        readonly proofKeyThumbprint?: string;
        readonly principalKind?: SessionPrincipalKind;
        readonly penNodeId?: string;
      },
    ) => Effect.Effect<
      {
        readonly token: string;
        readonly expiresAt: DateTime.DateTime;
      },
      SessionCredentialInternalError
    >;
    readonly verifyWebSocketToken: (
      token: string,
      connection: ConnectionContext | undefined,
    ) => Effect.Effect<VerifiedWebSocketTicket, SessionCredentialError>;
    readonly listActive: () => Effect.Effect<
      ReadonlyArray<AuthClientSession>,
      SessionCredentialInternalError
    >;
    readonly streamChanges: Stream.Stream<SessionCredentialChange>;
    readonly awaitInvalidation: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<void, SessionCredentialVerificationError>;
    readonly revoke: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<boolean, SessionCredentialInternalError>;
    readonly revokeAllExcept: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<number, SessionCredentialInternalError>;
    readonly markConnected: (sessionId: AuthSessionId) => Effect.Effect<void, never>;
    readonly markDisconnected: (sessionId: AuthSessionId) => Effect.Effect<void, never>;
    /**
     * Records that a connectionless client (an MCP bearer token) just used its
     * session, as `lastConnectedAt`. Writes at most once a minute per session.
     */
    readonly markUsed: (sessionId: AuthSessionId) => Effect.Effect<void, never>;
    readonly recordClientConnection: (
      sessionId: AuthSessionId,
      client: {
        readonly surface?: ClientSurface | undefined;
        readonly appVersion?: string | undefined;
      },
    ) => Effect.Effect<void, never>;
  }
>()("goat/auth/SessionStore") {}

const SIGNING_SECRET_NAME = "server-signing-key";
const DEFAULT_SESSION_TTL = Duration.days(30);
const MARK_USED_INTERVAL_MS = 60_000;
const DEFAULT_WEBSOCKET_TOKEN_TTL = Duration.minutes(5);

const isPenId = Schema.is(PenId);
export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const authSessions = yield* AuthSessions.AuthSessionRepository;
  const signer = fromSecret(yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32));
  const connectedSessionsRef = yield* Ref.make(new Map<AuthSessionId, number>());
  const lastUsedWritesRef = yield* Ref.make(new Map<AuthSessionId, number>());
  const changesPubSub = yield* PubSub.unbounded<SessionCredentialChange>();
  const cookieInput = {
    mode: serverConfig.mode,
    port: serverConfig.port,
    host: serverConfig.host,
    instanceKey: serverConfig.stateDir,
    environmentId: yield* serverEnvironment.getEnvironmentId,
    development: serverConfig.devUrl !== undefined,
  } as const;
  const cookieName = resolveSessionCookieName(cookieInput);
  const legacyCookieName = resolveLegacySessionCookieName(cookieInput);
  const devAuth = resolveReusableDevAuth(serverConfig);
  if (devAuth) {
    yield* authSessions
      .createIfAbsent({
        sessionId: devAuth.sessionId,
        subject: "reusable-dev-token",
        scopes: AuthStandardClientScopes,
        method: "browser-session-cookie",
        client: {
          label: "Reusable dev token",
          ipAddress: null,
          userAgent: null,
          deviceType: "unknown",
          os: null,
          browser: null,
        },
        issuedAt: yield* DateTime.now,
        expiresAt: REUSABLE_DEV_SESSION_EXPIRES_AT,
        principalKind: "person",
      })
      .pipe(
        Effect.mapError(
          (cause) => new SessionCredentialIssueError({ sessionId: devAuth.sessionId, cause }),
        ),
      );
  }

  const activeScopeRows = yield* authSessions.listActive({
    now: yield* DateTime.now,
    connectedSessionIds: [],
  });
  type ActiveScopeRecord = {
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
    readonly expiresAt: DateTime.Utc;
  };
  // Live grants plus the fences that keep a verify from restoring one removed while it ran.
  // Removals are numbered; each running verify registers the removal count at its start, and a
  // removal is fenced only while a verify that started before it is still running.
  type ActiveScopeState = {
    readonly records: ReadonlyMap<AuthSessionId, ActiveScopeRecord>;
    readonly removed: ReadonlyMap<AuthSessionId, number>;
    readonly removals: number;
    readonly verifying: ReadonlyMap<number, number>;
    readonly nextVerify: number;
  };
  const activeScopes = yield* Ref.make<ActiveScopeState>({
    records: new Map<AuthSessionId, ActiveScopeRecord>(
      activeScopeRows.map((row) => [
        row.sessionId,
        { scopes: row.scopes, expiresAt: row.expiresAt },
      ]),
    ),
    removed: new Map(),
    removals: 0,
    verifying: new Map(),
    nextVerify: 0,
  });
  const withoutExpired = (records: ReadonlyMap<AuthSessionId, ActiveScopeRecord>, at: number) =>
    new Map(Array.from(records).filter(([, record]) => record.expiresAt.epochMilliseconds > at));
  /** Keeps only fences a running verify that started before that removal still needs. */
  const neededFences = (
    removed: ReadonlyMap<AuthSessionId, number>,
    verifying: ReadonlyMap<number, number>,
  ) => {
    const oldestStart = Math.min(...verifying.values());
    return new Map(Array.from(removed).filter(([, removal]) => removal > oldestStart));
  };

  // Serialize auth mutations through publication: a delayed activity event must
  // never restore a removed grant, and a committed revoke must update the Ref.
  const authorityLock = yield* Semaphore.make(1);
  let penSessionDenied: (sessionId: AuthSessionId) => Effect.Effect<boolean> = () =>
    Effect.succeed(false);
  const emitUpsert = (clientSession: AuthClientSession) =>
    penSessionDenied(clientSession.sessionId).pipe(
      Effect.flatMap((denied) =>
        denied
          ? Effect.void
          : PubSub.publish(changesPubSub, { type: "clientUpserted", clientSession }).pipe(
              Effect.asVoid,
            ),
      ),
    );

  let forgetPenSession: (sessionId: AuthSessionId) => Effect.Effect<void> = () => Effect.void;
  const emitRemoved = (sessionId: AuthSessionId) =>
    Ref.update(activeScopes, (current) => {
      const records = new Map(current.records);
      records.delete(sessionId);
      const removals = current.removals + 1;
      return {
        ...current,
        records,
        removals,
        removed: neededFences(new Map(current.removed).set(sessionId, removals), current.verifying),
      };
    }).pipe(
      Effect.andThen(forgetPenSession(sessionId)),
      Effect.andThen(PubSub.publish(changesPubSub, { type: "clientRemoved", sessionId })),
      Effect.asVoid,
    );

  const cloudFence = yield* CloudSessionFence.make(activeScopeRows, emitRemoved);
  const penFence = yield* PenMemberSessionFence.make(
    activeScopeRows,
    (sessionId) =>
      PubSub.publish(changesPubSub, { type: "clientRemoved", sessionId }).pipe(Effect.asVoid),
    (sessionId) =>
      loadActiveSession(sessionId).pipe(
        Effect.flatMap((session) =>
          Option.isSome(session) ? emitUpsert(session.value) : Effect.void,
        ),
        Effect.catchCause((cause) =>
          Effect.logError("Failed to publish Pen session admission", { cause }),
        ),
      ),
  );
  forgetPenSession = penFence.forget;
  penSessionDenied = penFence.denied;

  /** Registers a running verify; yields its ticket and the removal count it started at. */
  const beginVerify = Ref.modify(activeScopes, (current) => {
    const ticket = current.nextVerify;
    return [
      { ticket, startedAt: current.removals },
      {
        ...current,
        nextVerify: ticket + 1,
        verifying: new Map(current.verifying).set(ticket, current.removals),
      },
    ] as const;
  });
  const endVerify = (ticket: number) =>
    Ref.update(activeScopes, (current) => {
      const verifying = new Map(current.verifying);
      verifying.delete(ticket);
      return { ...current, verifying, removed: neededFences(current.removed, verifying) };
    });

  /**
   * Records the live grant of a session `verify` just accepted, including one another process
   * (the CLI's `goat auth session issue`) stored after startup. Runs outside authorityLock and
   * SQL so `readActiveScopes` stays a lock-free memory read inside memory transactions.
   */
  const rememberVerified = (
    sessionId: AuthSessionId,
    record: ActiveScopeRecord,
    verifyStartedAt: number,
  ) =>
    Effect.flatMap(DateTime.now, (now) =>
      Ref.update(activeScopes, (current) =>
        current.records.has(sessionId) ||
        (current.removed.get(sessionId) ?? Number.NEGATIVE_INFINITY) > verifyStartedAt
          ? current
          : {
              ...current,
              records: withoutExpired(current.records, now.epochMilliseconds).set(
                sessionId,
                record,
              ),
            },
      ),
    );

  const loadActiveSession = Effect.fn("SessionStore.loadActiveSession")(function* (
    sessionId: AuthSessionId,
  ) {
    const row = yield* authSessions.getById({ sessionId });
    if (Option.isNone(row) || row.value.revokedAt !== null) {
      return Option.none<AuthClientSession>();
    }

    const connectedSessions = yield* Ref.get(connectedSessionsRef);
    const connected = connectedSessions.has(row.value.sessionId);
    const now = yield* DateTime.now;
    if (!connected && row.value.expiresAt.epochMilliseconds <= now.epochMilliseconds) {
      return Option.none<AuthClientSession>();
    }
    return Option.some(
      toAuthClientSession({
        sessionId: row.value.sessionId,
        subject: row.value.subject,
        scopes: row.value.scopes,
        method: row.value.method,
        client: toClientMetadata(row.value.client),
        issuedAt: row.value.issuedAt,
        expiresAt: row.value.expiresAt,
        lastConnectedAt: row.value.lastConnectedAt,
        connected,
        principalKind: row.value.principalKind,
      }),
    );
  });

  const markConnected: SessionStore["Service"]["markConnected"] = (sessionId) =>
    Ref.modify(connectedSessionsRef, (current) => {
      const next = new Map(current);
      const wasDisconnected = !next.has(sessionId);
      next.set(sessionId, (next.get(sessionId) ?? 0) + 1);
      return [wasDisconnected, next] as const;
    }).pipe(
      Effect.flatMap((wasDisconnected) =>
        wasDisconnected
          ? DateTime.now.pipe(
              Effect.flatMap((lastConnectedAt) =>
                authSessions.setLastConnectedAt({
                  sessionId,
                  lastConnectedAt,
                }),
              ),
            )
          : Effect.void,
      ),
      Effect.flatMap(() => loadActiveSession(sessionId)),
      Effect.flatMap((session) =>
        Option.isSome(session) ? emitUpsert(session.value) : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logError("Failed to publish connected-session auth update.").pipe(
          Effect.annotateLogs({
            sessionId,
            cause,
          }),
        ),
      ),
      Effect.withSpan("SessionStore.markConnected"),
    );

  const markUsed: SessionStore["Service"]["markUsed"] = (sessionId) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        Ref.modify(lastUsedWritesRef, (current) => {
          const previous = current.get(sessionId);
          const at = now.epochMilliseconds;
          if (previous !== undefined && at - previous < MARK_USED_INTERVAL_MS) {
            return [undefined, current] as const;
          }
          const next = new Map(current);
          next.set(sessionId, at);
          return [now, next] as const;
        }),
      ),
      Effect.flatMap((lastConnectedAt) =>
        lastConnectedAt === undefined
          ? Effect.void
          : authSessions.setLastConnectedAt({ sessionId, lastConnectedAt }).pipe(
              Effect.flatMap(() => loadActiveSession(sessionId)),
              Effect.flatMap((session) =>
                Option.isSome(session) ? emitUpsert(session.value) : Effect.void,
              ),
            ),
      ),
      Effect.catchCause((cause) =>
        Effect.logError("Failed to record session use.").pipe(
          Effect.annotateLogs({ sessionId, cause }),
        ),
      ),
      Effect.withSpan("SessionStore.markUsed"),
    );

  const recordClientConnection: SessionStore["Service"]["recordClientConnection"] = (
    sessionId,
    client,
  ) =>
    client.surface === undefined && client.appVersion === undefined
      ? Effect.void
      : authSessions
          .setClientConnection({
            sessionId,
            surface: client.surface ?? null,
            appVersion: client.appVersion ?? null,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to record session client connection metadata.").pipe(
                Effect.annotateLogs({ sessionId, cause }),
              ),
            ),
            Effect.withSpan("SessionStore.recordClientConnection"),
          );

  const markDisconnected: SessionStore["Service"]["markDisconnected"] = (sessionId) =>
    Ref.update(connectedSessionsRef, (current) => {
      const next = new Map(current);
      const remaining = (next.get(sessionId) ?? 0) - 1;
      if (remaining > 0) {
        next.set(sessionId, remaining);
      } else {
        next.delete(sessionId);
      }
      return next;
    }).pipe(
      Effect.flatMap(() => loadActiveSession(sessionId)),
      Effect.flatMap((session) =>
        Option.isSome(session) ? emitUpsert(session.value) : emitRemoved(sessionId),
      ),
      Effect.catchCause((cause) =>
        Effect.logError("Failed to publish disconnected-session auth update.").pipe(
          Effect.annotateLogs({
            sessionId,
            cause,
          }),
        ),
      ),
      Effect.withSpan("SessionStore.markDisconnected"),
    );

  const encodeClaims = Schema.encodeEffect(Schema.fromJsonString(SessionClaims));
  const issue: SessionStore["Service"]["issue"] = Effect.fn("SessionStore.issue")(
    function* (input) {
      const sessionId = AuthSessionId.make(
        yield* crypto
          .randomUUIDv4()
          .pipe(Effect.mapError((cause) => new SessionCredentialIssueError({ cause }))),
      );
      const issuedAt = yield* DateTime.now;
      const purpose = input?.childSetupPurpose;
      if (
        input?.penMemberNode !== undefined &&
        (!isPenId(input.penMemberNode) || input.subject !== undefined)
      )
        return yield* new SessionCredentialIssueError({
          sessionId,
          cause: "Invalid Pen member issuance",
        });
      const subject =
        input?.penMemberNode === undefined
          ? (input?.subject ?? "browser")
          : `pen-member:${input.penMemberNode}`;
      const principalKind = input?.principalKind ?? defaultPrincipalKind(subject);
      const shapeRefusal = issueShapeRefusal(subject, principalKind, input?.penBinding);
      if (shapeRefusal !== undefined)
        return yield* new SessionCredentialIssueError({ sessionId, cause: shapeRefusal });
      const requestedTtl = Duration.toMillis(input?.ttl ?? DEFAULT_SESSION_TTL);
      const ttl =
        input?.penBinding === undefined
          ? requestedTtl
          : Math.min(requestedTtl, Duration.toMillis(PEN_SESSION_MAX_TTL));
      const milliseconds = ChildSetupSession.ttlMs(input, issuedAt.epochMilliseconds, ttl);
      if (milliseconds === undefined)
        return yield* new SessionCredentialIssueError({
          sessionId,
          cause: ChildSetupSession.refused(),
        });
      const expiresAt = DateTime.add(issuedAt, { milliseconds });
      const claims: SessionClaims = {
        v: 1,
        kind: "session",
        sid: sessionId,
        sub: subject,
        scopes: input?.scopes ?? AuthStandardClientScopes,
        method: input?.method ?? "browser-session-cookie",
        ...(input?.proofKeyThumbprint ? { jkt: input.proofKeyThumbprint } : {}),
        ...(input?.runtimeModeCeiling ? { rtc: input.runtimeModeCeiling } : {}),
        ...(purpose === undefined ? {} : { csp: purpose }),
        iat: issuedAt.epochMilliseconds,
        exp: expiresAt.epochMilliseconds,
      };

      const encodedPayload = yield* encodeClaims(claims).pipe(
        Effect.map(base64UrlEncode),
        Effect.mapError(
          (cause) =>
            new SessionCredentialIssueError({
              sessionId,
              cause: new SessionClaimsEncodingError({
                sessionId,
                operation: "encode_session_claims",
                cause,
              }),
            }),
        ),
      );
      const signature = signer.sign(encodedPayload);
      const client = input?.client ?? createDefaultClientMetadata();
      const sessionRecord = {
        sessionId,
        subject: claims.sub,
        connectAccessGeneration: input?.connectAccessGeneration ?? null,
        scopes: claims.scopes,
        method: claims.method,
        client: {
          label: client.label ?? null,
          ipAddress: client.ipAddress ?? null,
          userAgent: client.userAgent ?? null,
          deviceType: client.deviceType,
          os: client.os ?? null,
          browser: client.browser ?? null,
        },
        issuedAt,
        expiresAt,
        principalKind,
        ...(input?.penMemberNode === undefined ? {} : { penMemberNode: input.penMemberNode }),
        ...(input?.penBinding === undefined ? {} : { penBinding: input.penBinding }),
      } satisfies AuthSessions.CreateAuthSessionInput;
      const replacedSessionIds = yield* (
        input?.replaceSessionId !== undefined || input?.replaceActiveForSubjectAndMethod
          ? authSessions.createReplacingActive({
              session: sessionRecord,
              revokedAt: issuedAt,
              ...(input.replaceSessionId !== undefined
                ? { replaceSessionId: input.replaceSessionId }
                : {}),
            })
          : authSessions.create(sessionRecord).pipe(Effect.as([] as ReadonlyArray<AuthSessionId>))
      ).pipe(Effect.mapError((cause) => new SessionCredentialIssueError({ sessionId, cause })));
      if (replacedSessionIds.length > 0) {
        yield* Ref.update(connectedSessionsRef, (current) => {
          const next = new Map(current);
          for (const replacedSessionId of replacedSessionIds) {
            next.delete(replacedSessionId);
          }
          return next;
        });
        yield* Effect.forEach(replacedSessionIds, emitRemoved, {
          concurrency: "unbounded",
          discard: true,
        });
      }
      yield* Ref.update(activeScopes, (current) => ({
        ...current,
        records: withoutExpired(current.records, issuedAt.epochMilliseconds).set(sessionId, {
          scopes: claims.scopes,
          expiresAt,
        }),
      }));
      yield* penFence.observe({
        sessionId,
        subject,
        penMemberNode: input?.penMemberNode ?? null,
      });
      yield* emitUpsert(
        toAuthClientSession({
          sessionId,
          subject: claims.sub,
          scopes: claims.scopes,
          method: claims.method,
          client,
          issuedAt,
          expiresAt,
          lastConnectedAt: null,
          connected: false,
          principalKind,
        }),
      );

      return {
        sessionId,
        token: `${encodedPayload}.${signature}`,
        method: claims.method,
        client,
        expiresAt: expiresAt,
        scopes: claims.scopes,
        ...(claims.jkt ? { proofKeyThumbprint: claims.jkt } : {}),
        ...(claims.csp === undefined ? {} : { childSetupPurpose: claims.csp }),
      } satisfies IssuedSession;
    },
  );

  const readActiveScopes: SessionStore["Service"]["readActiveScopes"] = Effect.fn(
    "SessionStore.readActiveScopes",
  )(function* (sessionId) {
    yield* cloudFence.guardId(sessionId);
    yield* penFence.guardId(sessionId);
    const record = (yield* Ref.get(activeScopes)).records.get(sessionId);
    if (!record) return yield* new UnknownSessionTokenError({ sessionId });
    const observedAt = yield* DateTime.now;
    if (record.expiresAt.epochMilliseconds <= observedAt.epochMilliseconds)
      return yield* new SessionTokenExpiredError({
        sessionId,
        expiresAt: record.expiresAt,
        observedAt,
      });
    return record.scopes;
  });

  const verifyToken = Effect.fn("SessionStore.verifyToken")(function* (
    token: string,
    verifyStartedAt: number,
  ) {
    if (devAuth?.matches(token)) {
      const row = yield* authSessions
        .getById({ sessionId: devAuth.sessionId })
        .pipe(
          Effect.mapError(
            (cause) =>
              new SessionCredentialVerificationError({ sessionId: devAuth.sessionId, cause }),
          ),
        );
      if (Option.isNone(row)) {
        return yield* new UnknownSessionTokenError({ sessionId: devAuth.sessionId });
      }
      if (row.value.revokedAt !== null) {
        return yield* new SessionTokenRevokedError({
          sessionId: devAuth.sessionId,
          revokedAt: row.value.revokedAt,
        });
      }
      const observedAt = yield* DateTime.now;
      if (row.value.expiresAt.epochMilliseconds <= observedAt.epochMilliseconds) {
        return yield* new SessionTokenExpiredError({
          sessionId: devAuth.sessionId,
          expiresAt: row.value.expiresAt,
          observedAt,
        });
      }
      yield* penFence.guard(row.value);
      yield* rememberVerified(
        row.value.sessionId,
        { scopes: row.value.scopes, expiresAt: row.value.expiresAt },
        verifyStartedAt,
      );
      return {
        sessionId: row.value.sessionId,
        token,
        method: row.value.method,
        client: toClientMetadata(row.value.client),
        expiresAt: row.value.expiresAt,
        subject: row.value.subject,
        penMemberNode: row.value.penMemberNode,
        scopes: row.value.scopes,
        principalKind: row.value.principalKind,
        ...(row.value.penBinding === null ? {} : { penBinding: row.value.penBinding }),
      } satisfies VerifiedSession;
    }
    const [encodedPayload, signature] = token.split(".");
    if (!encodedPayload || !signature) {
      return yield* new MalformedSessionTokenError({});
    }

    if (!signer.verify(encodedPayload, signature)) {
      return yield* new InvalidSessionTokenSignatureError({});
    }

    const claims = yield* decodeSessionClaims(base64UrlDecodeUtf8(encodedPayload)).pipe(
      Effect.mapError((cause) => new InvalidSessionTokenPayloadError({ cause })),
    );

    const observedAt = yield* DateTime.now;
    if (!ChildSetupSession.claimsValid(claims, observedAt.epochMilliseconds))
      return yield* new InvalidSessionTokenPayloadError({ cause: ChildSetupSession.refused() });
    const expiresAt = DateTime.make(claims.exp);
    if (Option.isNone(expiresAt)) {
      return yield* new InvalidSessionExpirationClaimError({
        sessionId: claims.sid,
        expirationClaim: claims.exp,
      });
    }
    if (claims.exp <= observedAt.epochMilliseconds) {
      return yield* new SessionTokenExpiredError({
        sessionId: claims.sid,
        expiresAt: expiresAt.value,
        observedAt,
      });
    }

    const row = yield* authSessions
      .getById({ sessionId: claims.sid })
      .pipe(
        Effect.mapError(
          (cause) => new SessionCredentialVerificationError({ sessionId: claims.sid, cause }),
        ),
      );
    if (Option.isNone(row)) {
      return yield* new UnknownSessionTokenError({ sessionId: claims.sid });
    }
    if (row.value.revokedAt !== null) {
      return yield* new SessionTokenRevokedError({
        sessionId: claims.sid,
        revokedAt: row.value.revokedAt,
      });
    }

    // A member session is admitted by its stored marker, so its signed subject must be that row's.
    if (
      claims.sub !== row.value.subject &&
      (row.value.penMemberNode !== null ||
        claims.sub.startsWith("pen-member:") ||
        row.value.subject.startsWith("pen-member:"))
    )
      return yield* new InvalidSessionTokenPayloadError({ cause: "Session subject mismatch" });
    yield* penFence.guard(row.value);
    yield* rememberVerified(
      claims.sid,
      { scopes: row.value.scopes, expiresAt: row.value.expiresAt },
      verifyStartedAt,
    );
    return {
      sessionId: claims.sid,
      token,
      method: claims.method,
      client: toClientMetadata(row.value.client),
      expiresAt: expiresAt.value,
      subject: claims.sub,
      penMemberNode: row.value.penMemberNode,
      ...(row.value.connectAccessGeneration != null
        ? { connectAccessGeneration: row.value.connectAccessGeneration }
        : {}),
      scopes: row.value.scopes,
      ...(claims.jkt ? { proofKeyThumbprint: claims.jkt } : {}),
      ...(claims.rtc ? { runtimeModeCeiling: claims.rtc } : {}),
      ...(claims.csp === undefined ? {} : { childSetupPurpose: claims.csp }),
      principalKind: row.value.principalKind,
      ...(row.value.penBinding === null ? {} : { penBinding: row.value.penBinding }),
    } satisfies VerifiedSession;
  });

  // Registration is released on success, failure and interruption so fences never pile up.
  const verify = (token: string) =>
    Effect.acquireUseRelease(
      beginVerify,
      ({ startedAt }) => verifyToken(token, startedAt),
      ({ ticket }) => endVerify(ticket),
    ).pipe(Effect.withSpan("SessionStore.verify"));

  const encodeWsClaims = Schema.encodeEffect(Schema.fromJsonString(WebSocketClaims));
  const issueWebSocketToken: SessionStore["Service"]["issueWebSocketToken"] = Effect.fn(
    "SessionStore.issueWebSocketToken",
  )(function* (sessionId, input) {
    const issuedAt = yield* DateTime.now;
    const expiresAt = DateTime.add(issuedAt, {
      milliseconds: Duration.toMillis(input?.ttl ?? DEFAULT_WEBSOCKET_TOKEN_TTL),
    });
    const claims: WebSocketClaims = {
      v: 1,
      kind: "websocket",
      sid: sessionId,
      ...(input?.audience ? { aud: input.audience } : {}),
      ...(input?.proofKeyThumbprint ? { jkt: input.proofKeyThumbprint } : {}),
      ...(input?.principalKind === undefined ? {} : { pk: input.principalKind }),
      ...(input?.penNodeId === undefined ? {} : { pn: input.penNodeId }),
      iat: issuedAt.epochMilliseconds,
      exp: expiresAt.epochMilliseconds,
    };
    const encodedPayload = yield* encodeWsClaims(claims).pipe(
      Effect.map(base64UrlEncode),
      Effect.mapError(
        (cause) =>
          new WebSocketTokenIssueError({
            sessionId,
            cause: new SessionClaimsEncodingError({
              sessionId,
              operation: "encode_websocket_claims",
              cause,
            }),
          }),
      ),
    );
    const signature = signer.sign(encodedPayload);
    return {
      token: `${encodedPayload}.${signature}`,
      expiresAt,
    };
  });

  const verifyWebSocketToken = Effect.fn("SessionStore.verifyWebSocketToken")(function* (
    token: string,
  ) {
    const [encodedPayload, signature] = token.split(".");
    if (!encodedPayload || !signature) {
      return yield* new MalformedWebSocketTokenError({});
    }

    if (!signer.verify(encodedPayload, signature)) {
      return yield* new InvalidWebSocketTokenSignatureError({});
    }

    const claims = yield* decodeWebSocketClaims(base64UrlDecodeUtf8(encodedPayload)).pipe(
      Effect.mapError((cause) => new InvalidWebSocketTokenPayloadError({ cause })),
    );
    if (claims.sid.startsWith(REUSABLE_DEV_SESSION_PREFIX) && claims.sid !== devAuth?.sessionId) {
      return yield* new UnknownWebSocketSessionError({ sessionId: claims.sid });
    }

    const observedAt = yield* DateTime.now;
    const expiresAt = DateTime.make(claims.exp);
    if (Option.isNone(expiresAt)) {
      return yield* new InvalidSessionExpirationClaimError({
        sessionId: claims.sid,
        expirationClaim: claims.exp,
      });
    }
    if (claims.exp <= observedAt.epochMilliseconds) {
      return yield* new WebSocketTokenExpiredError({
        sessionId: claims.sid,
        expiresAt: expiresAt.value,
        observedAt,
      });
    }

    const row = yield* authSessions
      .getById({ sessionId: claims.sid })
      .pipe(
        Effect.mapError(
          (cause) => new WebSocketTokenVerificationError({ sessionId: claims.sid, cause }),
        ),
      );
    if (Option.isNone(row)) {
      return yield* new UnknownWebSocketSessionError({ sessionId: claims.sid });
    }
    if (row.value.expiresAt.epochMilliseconds <= observedAt.epochMilliseconds) {
      return yield* new WebSocketSessionExpiredError({
        sessionId: claims.sid,
        expiresAt: row.value.expiresAt,
        observedAt,
      });
    }
    if (row.value.revokedAt !== null) {
      return yield* new WebSocketSessionRevokedError({
        sessionId: claims.sid,
        revokedAt: row.value.revokedAt,
      });
    }
    // A ticket without pk predates principal kinds and only ever spoke for an unbound person.
    const rowNode = row.value.penBinding?.nodeId;
    if (
      (claims.pk ?? "person") !== row.value.principalKind ||
      claims.pn !== rowNode ||
      (claims.pk === undefined && rowNode !== undefined)
    ) {
      return yield* new InvalidWebSocketTokenPayloadError({
        cause: "The ticket's principal does not match its session.",
      });
    }

    return {
      sessionId: row.value.sessionId,
      token,
      method: row.value.method,
      client: toClientMetadata(row.value.client),
      expiresAt: row.value.expiresAt,
      subject: row.value.subject,
      penMemberNode: row.value.penMemberNode,
      ...(row.value.connectAccessGeneration != null
        ? { connectAccessGeneration: row.value.connectAccessGeneration }
        : {}),
      scopes: row.value.scopes,
      ...(claims.aud ? { audience: claims.aud } : {}),
      ...(claims.jkt ? { proofKeyThumbprint: claims.jkt } : {}),
      principalKind: row.value.principalKind,
      ...(row.value.penBinding === null ? {} : { penBinding: row.value.penBinding }),
    } satisfies VerifiedWebSocketTicket;
  });

  const listActive: SessionStore["Service"]["listActive"] = Effect.fn("SessionStore.listActive")(
    function* () {
      const now = yield* DateTime.now;
      const connectedSessions = yield* Ref.get(connectedSessionsRef);
      const rows = yield* authSessions.listActive({
        now,
        connectedSessionIds: Array.from(connectedSessions.keys()),
      });
      const visible = yield* Effect.filter(rows, (row) =>
        penFence.observe(row).pipe(
          Effect.andThen(penFence.denied(row.sessionId)),
          Effect.map((denied) => !denied),
        ),
      );
      return visible.map((row) =>
        toAuthClientSession({
          sessionId: row.sessionId,
          subject: row.subject,
          scopes: row.scopes,
          method: row.method,
          client: toClientMetadata(row.client),
          issuedAt: row.issuedAt,
          expiresAt: row.expiresAt,
          lastConnectedAt: row.lastConnectedAt,
          connected: connectedSessions.has(row.sessionId),
          principalKind: row.principalKind,
        }),
      );
    },
    Effect.mapError((cause) => new ActiveSessionsListError({ cause })),
  );

  const revoke: SessionStore["Service"]["revoke"] = Effect.fn("SessionStore.revoke")(
    function* (sessionId) {
      const revokedAt = yield* DateTime.now;
      const revoked = yield* authSessions
        .revoke({
          sessionId,
          revokedAt,
        })
        .pipe(Effect.mapError((cause) => new SessionRevocationError({ sessionId, cause })));
      if (revoked) {
        yield* Ref.update(connectedSessionsRef, (current) => {
          const next = new Map(current);
          next.delete(sessionId);
          return next;
        });
        yield* emitRemoved(sessionId);
      }
      return revoked;
    },
  );

  const revokeAllExcept: SessionStore["Service"]["revokeAllExcept"] = Effect.fn(
    "SessionStore.revokeAllExcept",
  )(function* (sessionId) {
    const revokedAt = yield* DateTime.now;
    const revokedSessionIds = yield* authSessions
      .revokeAllExcept({
        currentSessionId: sessionId,
        revokedAt,
      })
      .pipe(
        Effect.mapError(
          (cause) => new OtherSessionsRevocationError({ currentSessionId: sessionId, cause }),
        ),
      );
    if (revokedSessionIds.length > 0) {
      yield* Ref.update(connectedSessionsRef, (current) => {
        const next = new Map(current);
        for (const revokedSessionId of revokedSessionIds) {
          next.delete(revokedSessionId);
        }
        return next;
      });
      yield* Effect.forEach(
        revokedSessionIds,
        (revokedSessionId) => emitRemoved(revokedSessionId),
        {
          concurrency: "unbounded",
          discard: true,
        },
      );
    }
    return revokedSessionIds.length;
  });

  const awaitInvalidation = Effect.fn(function* (sessionId: AuthSessionId) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        // Subscribe before reading: revocation can race with the WebSocket upgrade.
        const subscription = yield* PubSub.subscribe(changesPubSub);
        const row = yield* authSessions
          .getById({ sessionId })
          .pipe(
            Effect.mapError(
              (cause) => new SessionCredentialVerificationError({ sessionId, cause }),
            ),
          );
        if (Option.isSome(row)) yield* penFence.observe(row.value);
        if (
          Option.isNone(row) ||
          row.value.revokedAt !== null ||
          (yield* cloudFence.denied(sessionId)) ||
          (yield* penFence.denied(sessionId))
        )
          return;
        const now = yield* DateTime.now;
        const remaining = row.value.expiresAt.epochMilliseconds - now.epochMilliseconds;
        if (remaining <= 0) return;
        yield* Effect.raceFirst(
          Stream.fromSubscription(subscription).pipe(
            Stream.filter(
              (change) => change.type === "clientRemoved" && change.sessionId === sessionId,
            ),
            Stream.runHead,
          ),
          Effect.sleep(Duration.millis(remaining)),
        );
      }),
    );
  });

  return SessionStore.of({
    setCloudWithdrawalPending: cloudFence.setPending,
    setPenMembersAdmitted: (view) => authorityLock.withPermit(penFence.setAdmitted(view)),
    listPenMemberSessions: Effect.gen(function* () {
      const rows = yield* authSessions.listActive({ now: yield* DateTime.now });
      return rows.flatMap((row) =>
        row.penMemberNode === null
          ? []
          : [{ sessionId: row.sessionId, penMemberNode: row.penMemberNode }],
      );
    }).pipe(Effect.orDie),
    readActiveScopes,
    cookieName,
    legacyCookieName,
    issue: (input) =>
      authorityLock.withPermit(
        issue(input).pipe(
          Effect.tap((session) =>
            cloudFence.observe({
              sessionId: session.sessionId,
              subject: input?.subject ?? "browser",
            }),
          ),
          Effect.uninterruptible,
        ),
      ),
    verify: (token, connection) =>
      verify(token).pipe(
        Effect.tap(cloudFence.guard),
        Effect.tap(penFence.guard),
        Effect.tap((session) => admitBinding(session, connection)),
      ),
    verifyStartupDevCredential: () =>
      devAuth === undefined
        ? Effect.fail(new MalformedSessionTokenError({}))
        : verify(devAuth.credential).pipe(
            Effect.tap(cloudFence.guard),
            Effect.tap(penFence.guard),
            Effect.tap((session) =>
              session.penBinding === undefined
                ? Effect.void
                : Effect.fail(
                    new SessionBindingRefusedError({
                      sessionId: session.sessionId,
                      reason: "wrong_listener",
                    }),
                  ),
            ),
          ),
    issueWebSocketToken,
    verifyWebSocketToken: (token, connection) =>
      verifyWebSocketToken(token).pipe(
        Effect.tap(cloudFence.guard),
        Effect.tap(penFence.guard),
        Effect.tap((session) => admitBinding(session, connection)),
      ),
    listActive,
    awaitInvalidation,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
    revoke: (sessionId) => authorityLock.withPermit(revoke(sessionId).pipe(Effect.uninterruptible)),
    revokeAllExcept: (sessionId) =>
      authorityLock.withPermit(revokeAllExcept(sessionId).pipe(Effect.uninterruptible)),
    markConnected,
    markUsed,
    markDisconnected,
    recordClientConnection,
  });
});

export const layer = Layer.effect(SessionStore, make).pipe(Layer.provideMerge(AuthSessions.layer));
