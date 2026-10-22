import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthSessionId, AuthStandardClientScopes, EnvironmentId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import { base64UrlDecodeUtf8, base64UrlEncode, signPayload } from "./utils.ts";

const layerFailingSessionLookupRepository = Layer.succeed(AuthSessions.AuthSessionRepository, {
  create: () => Effect.void,
  createReplacingActive: () => Effect.succeed([]),
  createIfAbsent: () => Effect.void,
  getById: () => Effect.fail(repositoryFailure),
  listActive: () => Effect.succeed([]),
  revoke: () => Effect.fail(repositoryFailure),
  revokeAllExcept: () => Effect.fail(repositoryFailure),
  setLastConnectedAt: () => Effect.void,
  setClientConnection: () => Effect.void,
});
const repositoryFailure = new PersistenceSqlError({
  operation: "AuthSessionRepository.getById:query",
  detail: "sqlite is unavailable",
});
const layerServerConfig = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        ...overrides,
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-auth-session-test-" })),
  );

const layerServerEnvironment = (environmentId: EnvironmentId) =>
  Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(environmentId),
  });

const layerFailingSessionLookupCredential = Layer.effect(
  SessionStore.SessionStore,
  SessionStore.make,
).pipe(
  Layer.provide(layerFailingSessionLookupRepository),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerServerEnvironment(EnvironmentId.make("test-environment"))),
  Layer.provide(layerServerConfig()),
);
const layerSessionStore = (
  overrides?: Partial<ServerConfig.ServerConfig["Service"]>,
  environmentId = EnvironmentId.make("test-environment"),
) =>
  SessionStore.layer.pipe(
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(layerServerEnvironment(environmentId)),
    Layer.provide(layerServerConfig(overrides)),
  );

const relaySessionInput = {
  subject: "managed-relay-bootstrap",
  method: "dpop-access-token",
  proofKeyThumbprint: "relay-proof-key",
  ttl: Duration.hours(1),
  client: { label: "Relay desktop", deviceType: "desktop" },
} as const;

const makeDiskSessionStoreLayer = Effect.fn("makeDiskSessionStoreLayer")(function* (
  baseDir: string,
  token?: string,
) {
  const devUrl = new URL("http://127.0.0.1:5173");
  const paths = yield* ServerConfig.deriveServerPaths(baseDir, devUrl, {
    baseDirIsExplicit: true,
  });
  yield* ServerConfig.ensureServerDirectories(paths);
  const layerPersistence = SqlitePersistence.layerFromPath(paths.dbPath);
  return SessionStore.layer.pipe(
    Layer.provide(layerPersistence),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(layerServerEnvironment(EnvironmentId.make(baseDir))),
    Layer.provide(
      layerServerConfig({
        ...paths,
        baseDir,
        mode: "web",
        devUrl,
        ...(token === undefined ? {} : { devAuthToken: Redacted.make(token) }),
      }),
    ),
  );
});

it.layer(NodeServices.layer)("SessionStore.layer", (it) => {
  it.effect.each(["revoke", "revokeAllExcept", "replace"] as const)(
    "invalidates every connection for a session on %s and leaves other sessions active",
    (operation) =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const owner = yield* sessions.issue({ subject: "owner" });
        const client = yield* sessions.issue(relaySessionInput);
        const ownerInvalidated = yield* Deferred.make<void>();
        yield* sessions
          .awaitInvalidation(owner.sessionId)
          .pipe(
            Effect.andThen(Deferred.succeed(ownerInvalidated, undefined)),
            Effect.forkScoped({ startImmediately: true }),
          );
        const first = yield* sessions
          .awaitInvalidation(client.sessionId)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        const second = yield* sessions
          .awaitInvalidation(client.sessionId)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        if (operation === "revoke") yield* sessions.revoke(client.sessionId);
        else if (operation === "revokeAllExcept") yield* sessions.revokeAllExcept(owner.sessionId);
        else yield* sessions.issue({ ...relaySessionInput, replaceSessionId: client.sessionId });
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(yield* Deferred.isDone(ownerInvalidated)).toBe(false);
        yield* sessions.awaitInvalidation(client.sessionId);
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(layerSessionStore(), TestClock.layer()))),
  );

  it.effect("expires a connected session at its credential deadline", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const client = yield* sessions.issue(relaySessionInput);
      yield* sessions.markConnected(client.sessionId);
      const invalidated = yield* Deferred.make<void>();
      const watcher = yield* sessions
        .awaitInvalidation(client.sessionId)
        .pipe(
          Effect.andThen(Deferred.succeed(invalidated, undefined)),
          Effect.forkScoped({ startImmediately: true }),
        );
      yield* TestClock.adjust(Duration.minutes(59));
      expect(yield* Deferred.isDone(invalidated)).toBe(false);
      yield* TestClock.adjust(Duration.minutes(1));
      yield* Fiber.join(watcher);
      yield* sessions.awaitInvalidation(client.sessionId);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(layerSessionStore(), TestClock.layer()))),
  );

  it.effect("keys remote cookies by environment identity instead of state directory", () =>
    Effect.gen(function* () {
      const cookieName = (stateDir: string, environmentId: EnvironmentId) =>
        Effect.gen(function* () {
          const sessions = yield* SessionStore.SessionStore;
          return sessions.cookieName;
        }).pipe(
          Effect.provide(
            layerSessionStore({ mode: "web", host: "192.168.1.50", stateDir }, environmentId),
          ),
        );

      const original = yield* cookieName("/srv/t3-one", EnvironmentId.make("environment-one"));
      const moved = yield* cookieName("/srv/t3-moved", EnvironmentId.make("environment-one"));
      const other = yield* cookieName("/srv/t3-one", EnvironmentId.make("environment-two"));

      expect(moved).toBe(original);
      expect(other).not.toBe(original);
    }),
  );

  it.effect("keeps reusable dev auth local across disk-backed stores and restarts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const token = "reusable-dev-auth-token-that-is-long-enough";
      const baseA = yield* fs.makeTempDirectoryScoped({ prefix: "goat-dev-auth-a-" });
      const baseB = yield* fs.makeTempDirectoryScoped({ prefix: "goat-dev-auth-b-" });
      const layerA = yield* makeDiskSessionStoreLayer(baseA, token);
      const fromA = yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const dev = yield* sessions.verify(token);
        const local = yield* sessions.issue({ subject: "environment-a" });
        const ticket = yield* sessions.issueWebSocketToken(local.sessionId);
        yield* sessions.revoke(dev.sessionId);
        return { dev, local, ticket };
      }).pipe(Effect.provide(layerA), Effect.scoped);

      const layerB = yield* makeDiskSessionStoreLayer(baseB, token);
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const dev = yield* sessions.verify(token);
        expect(dev.sessionId).toBe(fromA.dev.sessionId);
        expect((yield* Effect.flip(sessions.verify(fromA.local.token)))._tag).toBe(
          "InvalidSessionTokenSignatureError",
        );
        expect((yield* Effect.flip(sessions.verifyWebSocketToken(fromA.ticket.token)))._tag).toBe(
          "InvalidWebSocketTokenSignatureError",
        );
      }).pipe(Effect.provide(layerB), Effect.scoped);

      const layerReopenedB = yield* makeDiskSessionStoreLayer(baseB, token);
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const dev = yield* sessions.verify(token);
        expect(dev.sessionId).toBe(fromA.dev.sessionId);
        const ticket = yield* sessions.issueWebSocketToken(dev.sessionId);
        expect((yield* sessions.verifyWebSocketToken(ticket.token)).sessionId).toBe(dev.sessionId);
      }).pipe(Effect.provide(layerReopenedB), Effect.scoped);

      const layerReopenedA = yield* makeDiskSessionStoreLayer(baseA, token);
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        expect((yield* Effect.flip(sessions.verify(token)))._tag).toBe("SessionTokenRevokedError");
      }).pipe(Effect.provide(layerReopenedA), Effect.scoped);
    }),
  );

  it.effect("invalidates old dev credentials and tickets after rotation or removal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-dev-auth-rotation-" });
      const oldToken = "old-reusable-dev-auth-token-that-is-long-enough";
      const newToken = "new-reusable-dev-auth-token-that-is-long-enough";
      const layerInitial = yield* makeDiskSessionStoreLayer(baseDir, oldToken);
      const old = yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const dev = yield* sessions.verify(oldToken);
        const ticket = yield* sessions.issueWebSocketToken(dev.sessionId);
        return { dev, ticket };
      }).pipe(Effect.provide(layerInitial), Effect.scoped);

      const layerRotated = yield* makeDiskSessionStoreLayer(baseDir, newToken);
      const rotated = yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        expect((yield* Effect.flip(sessions.verify(oldToken)))._tag).toBe(
          "MalformedSessionTokenError",
        );
        expect((yield* Effect.flip(sessions.verifyWebSocketToken(old.ticket.token)))._tag).toBe(
          "UnknownWebSocketSessionError",
        );
        expect(
          (yield* sessions.listActive()).some((row) => row.sessionId === old.dev.sessionId),
        ).toBe(true);
        const dev = yield* sessions.verify(newToken);
        const ticket = yield* sessions.issueWebSocketToken(dev.sessionId);
        return { dev, ticket };
      }).pipe(Effect.provide(layerRotated), Effect.scoped);

      const layerRemoved = yield* makeDiskSessionStoreLayer(baseDir);
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        expect((yield* Effect.flip(sessions.verify(newToken)))._tag).toBe(
          "MalformedSessionTokenError",
        );
        expect((yield* Effect.flip(sessions.verifyWebSocketToken(rotated.ticket.token)))._tag).toBe(
          "UnknownWebSocketSessionError",
        );
        expect(
          (yield* sessions.listActive()).some((row) => row.sessionId === rotated.dev.sessionId),
        ).toBe(true);
      }).pipe(Effect.provide(layerRemoved), Effect.scoped);
    }),
  );

  it.effect("carries a runtime-mode ceiling only on sessions issued with one", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const capped = yield* sessions.issue({
        subject: "mcp-client",
        method: "bearer-access-token",
        runtimeModeCeiling: "auto",
      });
      const uncapped = yield* sessions.issue({ method: "bearer-access-token" });

      expect((yield* sessions.verify(capped.token)).runtimeModeCeiling).toBe("auto");
      expect((yield* sessions.verify(uncapped.token)).runtimeModeCeiling).toBeUndefined();
    }).pipe(Effect.provide(layerSessionStore())),
  );
  it.effect("keeps recorded scopes unchanged for both token versions", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const legacyScopes = ["orchestration:read", "terminal:operate", "review:write"] as const;
      const issued = yield* sessions.issue({ subject: "one-time-token", scopes: legacyScopes });
      const [encodedPayload] = issued.token.split(".");
      const currentClaims = base64UrlDecodeUtf8(encodedPayload!);
      expect(currentClaims).toContain('"v":1');
      const legacyPayload = base64UrlEncode(currentClaims.replace('"v":1', '"v":2'));
      const secret = yield* secrets.getOrCreateRandom("server-signing-key", 32);
      const legacyToken = `${legacyPayload}.${signPayload(legacyPayload, secret)}`;

      expect((yield* sessions.verify(issued.token)).scopes).toEqual(legacyScopes);
      expect((yield* sessions.verify(legacyToken)).scopes).toEqual(legacyScopes);
    }).pipe(
      Effect.provide(
        SessionStore.layer.pipe(
          Layer.provideMerge(ServerSecretStore.layer),
          Layer.provide(SqlitePersistence.layerMemory),
          Layer.provide(layerServerEnvironment(EnvironmentId.make("test-environment"))),
          Layer.provide(layerServerConfig()),
        ),
      ),
    ),
  );

  it.effect("preserves repository failures while verifying session and websocket credentials", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        method: "bearer-access-token",
        subject: "repository-failure",
      });
      const websocket = yield* sessions.issueWebSocketToken(issued.sessionId);
      // This repository rejects getById; live reauthorization reads only the committed Ref, so a
      // miss fails as unknown without SQL (memory transactions call it holding the writer).
      expect(yield* sessions.readActiveScopes(issued.sessionId)).toEqual(AuthStandardClientScopes);
      expect(
        (yield* Effect.flip(sessions.readActiveScopes(AuthSessionId.make("never-issued"))))._tag,
      ).toBe("UnknownSessionTokenError");

      const sessionError = yield* Effect.flip(sessions.verify(issued.token));
      const websocketError = yield* Effect.flip(sessions.verifyWebSocketToken(websocket.token));
      const revokeError = yield* Effect.flip(sessions.revoke(issued.sessionId));
      const revokeOthersError = yield* Effect.flip(sessions.revokeAllExcept(issued.sessionId));

      expect(sessionError._tag).toBe("SessionCredentialVerificationError");
      expect(websocketError._tag).toBe("WebSocketTokenVerificationError");
      expect(sessionError.cause).toBe(repositoryFailure);
      expect(websocketError.cause).toBe(repositoryFailure);
      if (sessionError._tag === "SessionCredentialVerificationError") {
        expect(sessionError.sessionId).toBe(issued.sessionId);
      }
      if (websocketError._tag === "WebSocketTokenVerificationError") {
        expect(websocketError.sessionId).toBe(issued.sessionId);
      }
      expect(revokeError).toMatchObject({
        _tag: "SessionRevocationError",
        sessionId: issued.sessionId,
        cause: repositoryFailure,
      });
      expect(revokeOthersError).toMatchObject({
        _tag: "OtherSessionsRevocationError",
        currentSessionId: issued.sessionId,
        cause: repositoryFailure,
      });
    }).pipe(Effect.provide(layerFailingSessionLookupCredential)),
  );

  it.effect("atomically replaces active sessions with the same subject and method", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const browser = yield* sessions.issue({
        subject: "desktop-bootstrap",
        method: "browser-session-cookie",
      });
      const [firstBearer, secondBearer] = yield* Effect.all(
        [
          sessions.issue({
            subject: "desktop-bootstrap",
            method: "bearer-access-token",
            replaceActiveForSubjectAndMethod: true,
          }),
          sessions.issue({
            subject: "desktop-bootstrap",
            method: "bearer-access-token",
            replaceActiveForSubjectAndMethod: true,
          }),
        ],
        { concurrency: "unbounded" },
      );

      const active = yield* sessions.listActive();
      const bearerVerification = yield* Effect.all([
        sessions.verify(firstBearer.token).pipe(Effect.option),
        sessions.verify(secondBearer.token).pipe(Effect.option),
      ]);

      expect(active).toHaveLength(2);
      expect(active.find((entry) => entry.sessionId === browser.sessionId)).toBeDefined();
      expect(
        active.filter(
          (entry) =>
            entry.subject === "desktop-bootstrap" && entry.method === "bearer-access-token",
        ),
      ).toHaveLength(1);
      expect(bearerVerification.filter(Option.isSome)).toHaveLength(1);
    }).pipe(Effect.provide(layerSessionStore())),
  );

  it.effect("keeps the previous desktop session valid when replacement fails", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const sql = yield* SqlClient.SqlClient;
      const previous = yield* sessions.issue({
        subject: "desktop-bootstrap",
        method: "bearer-access-token",
      });
      yield* sql`
        CREATE TRIGGER reject_auth_session_insert BEFORE INSERT ON auth_sessions
        BEGIN
          SELECT RAISE(ABORT, 'simulated insert failure');
        END
      `;

      const error = yield* sessions
        .issue({
          subject: "desktop-bootstrap",
          method: "bearer-access-token",
          replaceActiveForSubjectAndMethod: true,
        })
        .pipe(Effect.flip);

      expect(error._tag).toBe("SessionCredentialIssueError");
      expect((yield* sessions.verify(previous.token)).sessionId).toBe(previous.sessionId);
      expect((yield* sessions.listActive()).map((session) => session.sessionId)).toEqual([
        previous.sessionId,
      ]);
    }).pipe(Effect.provide(Layer.mergeAll(layerSessionStore(), SqlitePersistence.layerMemory))),
  );

  it.effect.each(["insert", "revoke"] as const)(
    "keeps existing browser sessions valid when replacement cannot %s",
    (operation) =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const sql = yield* SqlClient.SqlClient;
        const previous = yield* sessions.issue({ subject: "one-time-token" });
        const unrelated = yield* sessions.issue({ subject: "one-time-token" });
        if (operation === "insert") {
          yield* sql`
            CREATE TRIGGER reject_auth_session_insert BEFORE INSERT ON auth_sessions
            BEGIN
              SELECT RAISE(ABORT, 'simulated insert failure');
            END
          `;
        } else {
          yield* sql`
            CREATE TRIGGER reject_auth_session_revocation BEFORE UPDATE OF revoked_at ON auth_sessions
            BEGIN
              SELECT RAISE(ABORT, 'simulated revocation failure');
            END
          `;
        }

        const error = yield* sessions
          .issue({
            subject: "replacement-pairing",
            scopes: ["orchestration:read"],
            replaceSessionId: previous.sessionId,
          })
          .pipe(Effect.flip);

        expect(error._tag).toBe("SessionCredentialIssueError");
        expect((yield* sessions.verify(previous.token)).sessionId).toBe(previous.sessionId);
        expect((yield* sessions.verify(unrelated.token)).sessionId).toBe(unrelated.sessionId);
        expect((yield* sessions.listActive()).map((session) => session.sessionId).sort()).toEqual(
          [previous.sessionId, unrelated.sessionId].sort(),
        );
      }).pipe(Effect.provide(Layer.mergeAll(layerSessionStore(), SqlitePersistence.layerMemory))),
  );

  it.effect("rejects websocket tokens once the parent session has expired", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        method: "bearer-access-token",
        subject: "short-lived",
        ttl: Duration.seconds(1),
      });
      const websocket = yield* sessions.issueWebSocketToken(issued.sessionId);

      yield* TestClock.adjust(Duration.seconds(2));

      const error = yield* Effect.flip(sessions.verifyWebSocketToken(websocket.token));
      expect(error._tag).toBe("WebSocketSessionExpiredError");
      if (error._tag === "WebSocketSessionExpiredError") {
        expect(error.sessionId).toBe(issued.sessionId);
        expect(error.expiresAt.epochMilliseconds).toBe(issued.expiresAt.epochMilliseconds);
        expect(error.observedAt.epochMilliseconds).toBeGreaterThan(
          error.expiresAt.epochMilliseconds,
        );
      }
    }).pipe(Effect.provide(Layer.merge(layerSessionStore(), TestClock.layer()))),
  );

  it.effect("lists active sessions, tracks connectivity, and revokes other sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const administrative = yield* sessions.issue({
        subject: "desktop-bootstrap",
        scopes: ["orchestration:read", "access:write"],
        client: {
          label: "Desktop app",
          deviceType: "desktop",
          os: "macOS",
          browser: "Electron",
        },
      });
      const client = yield* sessions.issue({
        subject: "one-time-token",
        scopes: ["orchestration:read"],
        client: {
          label: "Julius iPhone",
          deviceType: "mobile",
          os: "iOS",
          browser: "Safari",
          ipAddress: "192.168.1.88",
        },
      });
      const clientWebSocket = yield* sessions.issueWebSocketToken(client.sessionId);

      yield* sessions.markConnected(client.sessionId);
      const beforeRevoke = yield* sessions.listActive();
      const revokedCount = yield* sessions.revokeAllExcept(administrative.sessionId);
      const afterRevoke = yield* sessions.listActive();
      const revokedClient = yield* Effect.flip(sessions.verify(client.token));
      const revokedClientWebSocket = yield* Effect.flip(
        sessions.verifyWebSocketToken(clientWebSocket.token),
      );

      expect(beforeRevoke).toHaveLength(2);
      expect(beforeRevoke.find((entry) => entry.sessionId === client.sessionId)?.connected).toBe(
        true,
      );
      expect(beforeRevoke.find((entry) => entry.sessionId === client.sessionId)?.client.label).toBe(
        "Julius iPhone",
      );
      expect(
        beforeRevoke.find((entry) => entry.sessionId === administrative.sessionId)?.client
          .deviceType,
      ).toBe("desktop");
      expect(revokedCount).toBe(1);
      expect(afterRevoke).toHaveLength(1);
      expect(afterRevoke[0]?.sessionId).toBe(administrative.sessionId);
      expect(revokedClient._tag).toBe("SessionTokenRevokedError");
      if (revokedClient._tag === "SessionTokenRevokedError") {
        expect(revokedClient.sessionId).toBe(client.sessionId);
        expect(revokedClient.revokedAt.epochMilliseconds).toBeGreaterThanOrEqual(0);
      }
      expect(revokedClientWebSocket._tag).toBe("WebSocketSessionRevokedError");
      if (revokedClientWebSocket._tag === "WebSocketSessionRevokedError") {
        expect(revokedClientWebSocket.sessionId).toBe(client.sessionId);
        expect(revokedClientWebSocket.revokedAt.epochMilliseconds).toBeGreaterThanOrEqual(0);
      }
    }).pipe(Effect.provide(layerSessionStore())),
  );

  it.effect("records client connection metadata without clearing prior values", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const sql = yield* SqlClient.SqlClient;
      const issued = yield* sessions.issue({
        subject: "client-connection-test",
        method: "bearer-access-token",
      });
      const readRow = sql<{
        readonly surface: string | null;
        readonly appVersion: string | null;
      }>`
        SELECT client_surface AS "surface", client_app_version AS "appVersion"
        FROM auth_sessions
        WHERE session_id = ${issued.sessionId}
      `;

      yield* sessions.recordClientConnection(issued.sessionId, {
        surface: "mobile",
        appVersion: "1.2.0",
      });
      expect((yield* readRow)[0]).toEqual({ surface: "mobile", appVersion: "1.2.0" });

      yield* sessions.recordClientConnection(issued.sessionId, { appVersion: "1.3.0" });
      expect((yield* readRow)[0]).toEqual({ surface: "mobile", appVersion: "1.3.0" });

      yield* sessions.recordClientConnection(issued.sessionId, {});
      expect((yield* readRow)[0]).toEqual({ surface: "mobile", appVersion: "1.3.0" });
    }).pipe(Effect.provide(Layer.mergeAll(layerSessionStore(), SqlitePersistence.layerMemory))),
  );
});

it.effect("reads live scopes without a token and fences replacement, revocation and expiry", () =>
  Effect.gen(function* () {
    const store = yield* SessionStore.SessionStore;
    const first = yield* store.issue({
      subject: "memory-client",
      method: "bearer-access-token",
      scopes: ["memory:read", "memory:write"],
    });
    expect(yield* store.readActiveScopes(first.sessionId)).toEqual(["memory:read", "memory:write"]);
    const second = yield* store.issue({
      subject: "memory-client",
      method: "bearer-access-token",
      scopes: ["memory:read"],
      replaceSessionId: first.sessionId,
      ttl: Duration.seconds(1),
    });
    expect((yield* store.readActiveScopes(first.sessionId).pipe(Effect.flip))._tag).toBe(
      "UnknownSessionTokenError",
    );
    expect(yield* store.readActiveScopes(second.sessionId)).toEqual(["memory:read"]);
    yield* TestClock.adjust(Duration.seconds(1));
    expect((yield* store.readActiveScopes(second.sessionId).pipe(Effect.flip))._tag).toBe(
      "SessionTokenExpiredError",
    );
    const third = yield* store.issue({ scopes: ["memory:write"] });
    yield* store.revoke(third.sessionId);
    expect((yield* store.readActiveScopes(third.sessionId).pipe(Effect.flip))._tag).toBe(
      "UnknownSessionTokenError",
    );
  }).pipe(Effect.provide(layerSessionStore().pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("serves live scopes for sessions another process issued after startup", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-session-read-through-" });
    const running = yield* makeDiskSessionStoreLayer(baseDir);
    // A separate store on the same database stands in for `goat auth session issue`; a local
    // memo map keeps it from reusing the running store's instance.
    const cli = yield* makeDiskSessionStoreLayer(baseDir);
    const fromCli = <A, E>(
      use: (store: SessionStore.SessionStore["Service"]) => Effect.Effect<A, E>,
    ) =>
      SessionStore.SessionStore.pipe(
        Effect.flatMap(use),
        Effect.provide(cli, { local: true }),
        Effect.scoped,
      );

    yield* Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
      const issue = (ttl: Duration.Duration) =>
        fromCli((other) =>
          other.issue({ method: "bearer-access-token", scopes: ["memory:read"], ttl }),
        );

      const active = yield* issue(Duration.hours(1));
      // Before this server verifies the token it has no grant for it.
      expect((yield* store.readActiveScopes(active.sessionId).pipe(Effect.flip))._tag).toBe(
        "UnknownSessionTokenError",
      );
      expect((yield* store.verify(active.token)).sessionId).toBe(active.sessionId);
      expect(yield* store.readActiveScopes(active.sessionId)).toEqual(["memory:read"]);
      yield* store.revoke(active.sessionId);
      expect((yield* store.readActiveScopes(active.sessionId).pipe(Effect.flip))._tag).toBe(
        "UnknownSessionTokenError",
      );
      expect((yield* store.verify(active.token).pipe(Effect.flip))._tag).toBe(
        "SessionTokenRevokedError",
      );

      const revoked = yield* issue(Duration.hours(1));
      yield* fromCli((other) => other.revoke(revoked.sessionId));
      expect((yield* store.verify(revoked.token).pipe(Effect.flip))._tag).toBe(
        "SessionTokenRevokedError",
      );
      expect((yield* store.readActiveScopes(revoked.sessionId).pipe(Effect.flip))._tag).toBe(
        "UnknownSessionTokenError",
      );

      const expiring = yield* issue(Duration.seconds(1));
      yield* store.verify(expiring.token);
      yield* TestClock.adjust(Duration.seconds(1));
      expect((yield* store.readActiveScopes(expiring.sessionId).pipe(Effect.flip))._tag).toBe(
        "SessionTokenExpiredError",
      );
      // Remembering the next verified session prunes the expired one.
      yield* store.verify((yield* issue(Duration.hours(1))).token);
      expect((yield* store.readActiveScopes(expiring.sessionId).pipe(Effect.flip))._tag).toBe(
        "UnknownSessionTokenError",
      );
    }).pipe(Effect.provide(running), Effect.scoped);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a verify that read the row before a revocation cannot restore the grant", () =>
  Effect.gen(function* () {
    const read = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let paused = false;
    // Pauses the first armed getById after it read the still-active row.
    const layerPausingRepository = Layer.effect(
      AuthSessions.AuthSessionRepository,
      Effect.map(AuthSessions.make, (repository) => ({
        ...repository,
        getById: (input: Parameters<typeof repository.getById>[0]) =>
          repository.getById(input).pipe(
            Effect.tap(() =>
              paused
                ? Effect.void
                : Effect.suspend(() => {
                    paused = true;
                    return Deferred.succeed(read, undefined).pipe(
                      Effect.andThen(Deferred.await(resume)),
                    );
                  }),
            ),
          ),
      })),
    );
    const layerStore = Layer.effect(SessionStore.SessionStore, SessionStore.make).pipe(
      Layer.provide(layerPausingRepository),
      Layer.provide(ServerSecretStore.layer),
      Layer.provide(SqlitePersistence.layerMemory),
      Layer.provide(layerServerEnvironment(EnvironmentId.make("test-environment"))),
      Layer.provide(layerServerConfig()),
    );
    yield* Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
      const issued = yield* store.issue({
        method: "bearer-access-token",
        scopes: ["memory:write"],
      });
      const verifying = yield* store
        .verify(issued.token)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(read);
      yield* store.revoke(issued.sessionId);
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(verifying);
      expect((yield* store.readActiveScopes(issued.sessionId).pipe(Effect.flip))._tag).toBe(
        "UnknownSessionTokenError",
      );
    }).pipe(Effect.provide(layerStore), Effect.scoped);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("next issuance prunes all expired live authority entries without reading them", () =>
  Effect.gen(function* () {
    const store = yield* SessionStore.SessionStore;
    const expired = yield* Effect.forEach(
      Array.from({ length: 40 }, (_, n) => n),
      (n) =>
        store.issue({
          subject: `synthetic-expiry-${n}`,
          scopes: ["memory:read"],
          ttl: Duration.seconds(1),
        }),
    );
    const retained = yield* store.issue({ scopes: ["memory:write"], ttl: Duration.minutes(1) });
    yield* TestClock.adjust(Duration.seconds(1));
    const next = yield* store.issue({ scopes: ["memory:read"] });
    for (const session of expired)
      expect((yield* store.readActiveScopes(session.sessionId).pipe(Effect.flip))._tag).toBe(
        "UnknownSessionTokenError",
      );
    expect(yield* store.readActiveScopes(retained.sessionId)).toEqual(["memory:write"]);
    expect(yield* store.readActiveScopes(next.sessionId)).toEqual(["memory:read"]);
    yield* store.revokeAllExcept(next.sessionId);
    expect((yield* store.readActiveScopes(retained.sessionId).pipe(Effect.flip))._tag).toBe(
      "UnknownSessionTokenError",
    );
    expect(yield* store.readActiveScopes(next.sessionId)).toEqual(["memory:read"]);
  }).pipe(Effect.provide(layerSessionStore().pipe(Layer.provideMerge(NodeServices.layer)))),
);
