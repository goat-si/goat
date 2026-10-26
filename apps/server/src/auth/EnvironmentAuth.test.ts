// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync or sign.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { authScopeResponse, AuthStandardClientScopes } from "@goat/contracts";
import {
  LEGACY_DEV_SESSION_COOKIE_PREFIX,
  LEGACY_SESSION_COOKIE_NAME,
} from "@goat/contracts/legacyT3Names";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
} from "@goat/shared/dpop";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import { legacyScopedSessionCookieName } from "./utils.ts";

const TEST_SERVER_PORT = 13_773;

const layerServerConfig = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        ...overrides,
        port: TEST_SERVER_PORT,
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-auth-server-test-" })),
  );

const layerEnvironmentAuth = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  EnvironmentAuth.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(layerServerConfig(overrides)),
  );

/** A disk-backed server; two of these on one base directory share state like two processes. */
const makeDiskEnvironmentAuthLayer = Effect.fn("makeDiskEnvironmentAuthLayer")(function* (
  baseDir: string,
) {
  const devUrl = new URL("http://127.0.0.1:5173");
  const paths = yield* ServerConfig.deriveServerPaths(baseDir, devUrl, {
    baseDirIsExplicit: true,
  });
  yield* ServerConfig.ensureServerDirectories(paths);
  return EnvironmentAuth.layer.pipe(
    Layer.provide(SqlitePersistence.layerFromPath(paths.dbPath)),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(layerServerConfig({ ...paths, baseDir, mode: "web", devUrl })),
  );
});

const makeCookieRequest = (
  cookieName: string,
  sessionToken: string,
): Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]>[0] =>
  ({
    cookies: {
      [cookieName]: sessionToken,
    },
    headers: {},
  }) as unknown as Parameters<
    EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
  >[0];

const makeBearerRequest = (
  token: string,
): Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]>[0] =>
  ({
    cookies: {},
    headers: {
      authorization: `Bearer ${token}`,
    },
  }) as unknown as Parameters<
    EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
  >[0];

const requestMetadata = {
  deviceType: "desktop" as const,
  os: "macOS",
  browser: "Chrome",
  ipAddress: "192.168.1.23",
};

const makeDpopKey = () => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicJwk = publicKey.export({ format: "jwk" }) as DpopPublicJwk;
  let proofCount = 0;
  return {
    thumbprint: computeDpopJwkThumbprint(publicJwk),
    sign: (input: {
      readonly method: string;
      readonly url: string;
      readonly token: string;
      readonly iat: number;
    }) => {
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const header = encode({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk });
      const payload = encode({
        htm: input.method,
        htu: input.url,
        jti: `proof-${++proofCount}`,
        iat: input.iat,
        ath: computeDpopAccessTokenHash(input.token),
      });
      const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url");
      return `${header}.${payload}.${signature}`;
    },
  };
};

it.layer(NodeServices.layer)("EnvironmentAuth.layer", (it) => {
  it.effect("refuses CLI session issuance with the reserved desktop subject", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const error = yield* Effect.flip(
        auth.issueSession({
          subject: PairingGrantStore.DESKTOP_BOOTSTRAP_SUBJECT,
        }),
      );
      expect(error._tag).toBe("ReservedAuthSubjectError");
      expect(error.message).toContain("reserved");
      expect(yield* auth.listSessions()).toEqual([]);
    }).pipe(Effect.provide(layerEnvironmentAuth())),
  );

  it.effect("authenticates old scoped cookies and keeps revocation authoritative", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const pairing = yield* auth.issuePairingCredential();
      const exchanged = yield* auth.createBrowserSession(pairing.credential, requestMetadata);
      const legacyRequest = makeCookieRequest(
        legacyScopedSessionCookieName(sessions.cookieName),
        exchanged.sessionToken,
      );
      const authenticated = yield* auth.authenticateHttpRequest(legacyRequest);
      expect((yield* auth.authenticateBrowserSession(legacyRequest)).sessionId).toBe(
        authenticated.sessionId,
      );
      const newRequest = makeCookieRequest(sessions.cookieName, exchanged.sessionToken);
      expect((yield* auth.authenticateHttpRequest(newRequest)).sessionId).toBe(
        authenticated.sessionId,
      );
      yield* sessions.revoke(authenticated.sessionId);
      expect((yield* Effect.flip(auth.authenticateHttpRequest(legacyRequest)))._tag).toBe(
        "ServerAuthInvalidCredentialError",
      );
    }).pipe(Effect.provide(layerEnvironmentAuth())),
  );

  it.effect("accepts the oldest remote cookie and never falls back after revocation", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const pairing = yield* auth.issuePairingCredential();
      const exchanged = yield* auth.createBrowserSession(pairing.credential, requestMetadata);
      const legacyRequest = makeCookieRequest(LEGACY_SESSION_COOKIE_NAME, exchanged.sessionToken);
      const authenticated = yield* auth.authenticateHttpRequest(legacyRequest);
      expect((yield* auth.authenticateBrowserSession(legacyRequest)).sessionId).toBe(
        authenticated.sessionId,
      );
      const secondPairing = yield* auth.issuePairingCredential();
      const second = yield* auth.createBrowserSession(secondPairing.credential, requestMetadata);
      yield* sessions.revoke(authenticated.sessionId);
      const request = {
        cookies: {
          [sessions.cookieName]: exchanged.sessionToken,
          [legacyScopedSessionCookieName(sessions.cookieName)]: second.sessionToken,
        },
        headers: {},
      } as never;
      expect((yield* Effect.flip(auth.authenticateHttpRequest(request)))._tag).toBe(
        "ServerAuthInvalidCredentialError",
      );
      expect((yield* Effect.flip(auth.authenticateBrowserSession(request)))._tag).toBe(
        "ServerAuthInvalidCredentialError",
      );
    }).pipe(Effect.provide(layerEnvironmentAuth({ mode: "web", host: "192.168.1.50" }))),
  );

  it.effect("accepts a legacy reusable dev cookie", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const exchanged = yield* auth.createBrowserSession(
        "reusable-dev-auth-token-that-is-long-enough",
        requestMetadata,
      );
      const legacyName = exchanged.cookieName!.replace(
        "goat_dev_session_",
        LEGACY_DEV_SESSION_COOKIE_PREFIX,
      );
      const request = makeCookieRequest(legacyName, exchanged.sessionToken);
      expect((yield* auth.authenticateHttpRequest(request)).scopes).toEqual(
        AuthStandardClientScopes,
      );
      expect((yield* auth.authenticateBrowserSession(request)).scopes).toEqual(
        AuthStandardClientScopes,
      );
    }).pipe(
      Effect.provide(
        layerEnvironmentAuth({
          mode: "web",
          devUrl: new URL("http://127.0.0.1:5173"),
          devAuthToken: Redacted.make("reusable-dev-auth-token-that-is-long-enough"),
        }),
      ),
    ),
  );

  it.effect("uses the reusable dev cookie without overriding a normal scoped cookie", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const token = "reusable-dev-auth-token-that-is-long-enough";
      const devExchange = yield* serverAuth.createBrowserSession(token, requestMetadata);
      const pairing = yield* serverAuth.issuePairingCredential({ scopes: ["orchestration:read"] });
      const scopedExchange = yield* serverAuth.createBrowserSession(
        pairing.credential,
        requestMetadata,
      );
      const request = {
        cookies: {
          [sessions.cookieName]: scopedExchange.sessionToken,
          [devExchange.cookieName ?? "missing"]: devExchange.sessionToken,
        },
        headers: {},
      } as unknown as Parameters<
        EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
      >[0];

      const authenticated = yield* serverAuth.authenticateHttpRequest(request);
      expect(devExchange.cookieName).toMatch(/^goat_dev_session_/);
      expect(devExchange.expireNormalCookie).toBe(true);
      expect(devExchange.response).toMatchObject(authScopeResponse(AuthStandardClientScopes));
      expect(authenticated.scopes).toEqual(["orchestration:read"]);
    }).pipe(
      Effect.provide(
        layerEnvironmentAuth({
          mode: "web",
          devUrl: new URL("http://127.0.0.1:5173"),
          devAuthToken: Redacted.make("reusable-dev-auth-token-that-is-long-enough"),
        }),
      ),
    ),
  );

  it.effect("does not fall back to the dev cookie after a normal cookie is rejected", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const token = "reusable-dev-auth-token-that-is-long-enough";
      const devExchange = yield* serverAuth.createBrowserSession(token, requestMetadata);
      const pairing = yield* serverAuth.issuePairingCredential({ scopes: ["orchestration:read"] });
      const scopedExchange = yield* serverAuth.createBrowserSession(
        pairing.credential,
        requestMetadata,
      );
      const scoped = yield* sessions.verify(scopedExchange.sessionToken);
      yield* sessions.revoke(scoped.sessionId);
      const request = {
        cookies: {
          [sessions.cookieName]: scopedExchange.sessionToken,
          [devExchange.cookieName ?? "missing"]: devExchange.sessionToken,
        },
        headers: {},
      } as unknown as Parameters<
        EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
      >[0];

      const error = yield* Effect.flip(serverAuth.authenticateHttpRequest(request));
      expect(error._tag).toBe("ServerAuthInvalidCredentialError");
    }).pipe(
      Effect.provide(
        layerEnvironmentAuth({
          mode: "web",
          devUrl: new URL("http://127.0.0.1:5173"),
          devAuthToken: Redacted.make("reusable-dev-auth-token-that-is-long-enough"),
        }),
      ),
    ),
  );

  it.effect("does not use the dev cookie when Authorization is invalid or empty", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const token = "reusable-dev-auth-token-that-is-long-enough";
      const devExchange = yield* serverAuth.createBrowserSession(token, requestMetadata);
      for (const authorization of ["Bearer invalid", ""] as const) {
        const request = {
          cookies: { [devExchange.cookieName ?? "missing"]: devExchange.sessionToken },
          headers: { authorization },
        } as unknown as Parameters<
          EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
        >[0];
        const error = yield* Effect.flip(serverAuth.authenticateHttpRequest(request));
        expect(EnvironmentAuth.isServerAuthCredentialError(error)).toBe(true);
      }
    }).pipe(
      Effect.provide(
        layerEnvironmentAuth({
          mode: "web",
          devUrl: new URL("http://127.0.0.1:5173"),
          devAuthToken: Redacted.make("reusable-dev-auth-token-that-is-long-enough"),
        }),
      ),
    ),
  );

  it.effect("exchanges the reusable dev token for a local scoped OAuth session", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const token = "reusable-dev-auth-token-that-is-long-enough";
      const exchanged = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        token,
        ["orchestration:read"],
        requestMetadata,
      );

      expect(exchanged.access_token).not.toBe(token);
      expect(exchanged.scope).toBe("orchestration:read");
      const dpop = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        token,
        ["orchestration:read"],
        requestMetadata,
        { proofKeyThumbprint: "test-proof-key" },
      );
      expect(dpop.access_token).not.toBe(token);
      expect(dpop.access_token).not.toBe(exchanged.access_token);
      expect(dpop.token_type).toBe("DPoP");
      expect(dpop.scope).toBe("orchestration:read");

      const secondBearer = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        token,
        ["orchestration:read"],
        requestMetadata,
      );
      const firstSession = yield* serverAuth.authenticateHttpRequest(
        makeBearerRequest(exchanged.access_token),
      );
      const secondSession = yield* serverAuth.authenticateHttpRequest(
        makeBearerRequest(secondBearer.access_token),
      );
      expect(firstSession.subject).toBe("reusable-dev-token-child");
      expect(secondSession.subject).toBe("reusable-dev-token-child");
      expect((yield* sessions.verify(token)).subject).toBe("reusable-dev-token");
      const before = yield* serverAuth.listClientSessions(firstSession.sessionId);
      const denied = yield* serverAuth
        .exchangeBootstrapCredentialForAccessToken(token, ["review:write"], requestMetadata)
        .pipe(Effect.flip);
      expect(denied._tag).toBe("ServerAuthScopeNotGrantedError");
      const empty = yield* serverAuth
        .exchangeBootstrapCredentialForAccessToken(token, [], requestMetadata)
        .pipe(Effect.flip);
      expect(empty._tag).toBe("ServerAuthScopeNotGrantedError");
      expect(yield* serverAuth.listClientSessions(firstSession.sessionId)).toEqual(before);
    }).pipe(
      Effect.provide(
        layerEnvironmentAuth({
          mode: "web",
          devUrl: new URL("http://127.0.0.1:5173"),
          devAuthToken: Redacted.make("reusable-dev-auth-token-that-is-long-enough"),
        }),
      ),
    ),
  );

  it.effect("uses a one-time startup credential after local dev token revocation", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const token = "reusable-dev-auth-token-that-is-long-enough";
      const initial = yield* serverAuth.issueStartupPairingCredential();
      const seeded = yield* sessions.verify(token);

      yield* sessions.revoke(seeded.sessionId);
      const recovery = yield* serverAuth.issueStartupPairingCredential();

      expect(initial.credential).toBe(token);
      expect(recovery.credential).not.toBe(token);
      expect((yield* Effect.flip(sessions.verify(token)))._tag).toBe("SessionTokenRevokedError");
      expect(
        (yield* serverAuth.createBrowserSession(recovery.credential, requestMetadata)).response,
      ).toMatchObject({ authenticated: true, ...authScopeResponse(AuthStandardClientScopes) });
    }).pipe(
      Effect.provide(
        layerEnvironmentAuth({
          mode: "web",
          devUrl: new URL("http://127.0.0.1:5173"),
          devAuthToken: Redacted.make("reusable-dev-auth-token-that-is-long-enough"),
        }),
      ),
    ),
  );

  it.effect("prefers a bearer token over a stale legacy cookie", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const bearer = yield* serverAuth.issueSession();
      const verified = yield* serverAuth.authenticateHttpRequest({
        cookies: { [sessions.legacyCookieName ?? LEGACY_SESSION_COOKIE_NAME]: "stale" },
        headers: { authorization: `Bearer ${bearer.token}` },
      } as never);

      expect(verified.sessionId).toBe(bearer.sessionId);
    }).pipe(Effect.provide(layerEnvironmentAuth({ mode: "web", host: "192.168.1.50" }))),
  );

  it.effect("preserves pairing grants after rejecting scopes they do not grant", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const pairingCredential = yield* serverAuth.issuePairingCredential({
        scopes: ["orchestration:read", "orchestration:operate"],
      });

      const error = yield* serverAuth
        .exchangeBootstrapCredentialForAccessToken(
          pairingCredential.credential,
          ["access:write"],
          requestMetadata,
        )
        .pipe(Effect.flip);

      expect(error._tag).toBe("ServerAuthScopeNotGrantedError");
      expect((yield* serverAuth.listPairingLinks()).map((link) => link.id)).toContain(
        pairingCredential.id,
      );
      expect(yield* serverAuth.listSessions()).toEqual([]);

      const token = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        pairingCredential.credential,
        ["orchestration:read"],
        requestMetadata,
      );
      const session = yield* serverAuth.authenticateHttpRequest(
        makeBearerRequest(token.access_token),
      );

      expect(token.scope).toBe("orchestration:read");
      expect(session.scopes).toEqual(["orchestration:read"]);
      expect((yield* serverAuth.listPairingLinks()).map((link) => link.id)).not.toContain(
        pairingCredential.id,
      );
      const reused = yield* serverAuth
        .exchangeBootstrapCredentialForAccessToken(
          pairingCredential.credential,
          ["orchestration:read"],
          requestMetadata,
        )
        .pipe(Effect.flip);
      expect(reused._tag).toBe("ServerAuthInvalidCredentialError");
    }).pipe(Effect.provide(layerEnvironmentAuth())),
  );

  it.effect.each([
    { label: "omits scope", requestedScopes: undefined },
    {
      label: "requests unsupported permissions alongside a granted one",
      requestedScopes: ["orchestration:read", "access:write"] as const,
    },
  ])("inherits a constrained pairing grant when token exchange $label", ({ requestedScopes }) =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const pairingCredential = yield* serverAuth.issuePairingCredential({
        scopes: ["orchestration:read"],
      });

      const token = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        pairingCredential.credential,
        requestedScopes,
        requestMetadata,
      );

      expect(token.scope).toBe("orchestration:read");
    }).pipe(Effect.provide(layerEnvironmentAuth())),
  );

  it.effect("narrows seeded desktop grants to the requested scopes", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const token = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        "desktop-bootstrap-token",
        ["orchestration:read"],
        requestMetadata,
      );
      const session = yield* serverAuth.authenticateHttpRequest(
        makeBearerRequest(token.access_token),
      );

      expect(token.scope).toBe("orchestration:read");
      expect(session.scopes).toEqual(["orchestration:read"]);
    }).pipe(
      Effect.provide(layerEnvironmentAuth({ desktopBootstrapToken: "desktop-bootstrap-token" })),
    ),
  );

  it.effect("rotates desktop bearer sessions without accumulating authorized clients", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const browser = yield* serverAuth.createBrowserSession(
        "desktop-bootstrap-token",
        requestMetadata,
      );
      const browserSession = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(sessions.cookieName, browser.sessionToken),
      );
      const staleSessions = yield* Effect.forEach([1, 2, 3], () =>
        sessions.issue({ subject: "desktop-bootstrap", method: "bearer-access-token" }),
      );
      const pairing = yield* serverAuth.issuePairingCredential();
      const paired = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        pairing.credential,
        undefined,
        { ...requestMetadata, label: "T3 Code Desktop" },
      );
      const first = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        "desktop-bootstrap-token",
        undefined,
        requestMetadata,
      );
      const firstSession = yield* serverAuth.authenticateHttpRequest(
        makeBearerRequest(first.access_token),
      );
      const second = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        "desktop-bootstrap-token",
        undefined,
        requestMetadata,
      );

      const active = yield* serverAuth.listSessions();
      const firstError = yield* serverAuth
        .authenticateHttpRequest(makeBearerRequest(first.access_token))
        .pipe(Effect.flip);
      const secondSession = yield* serverAuth.authenticateHttpRequest(
        makeBearerRequest(second.access_token),
      );

      expect(active).toHaveLength(3);
      expect(active.map((entry) => entry.sessionId)).toContain(browserSession.sessionId);
      expect(active.map((entry) => entry.sessionId)).toContain(secondSession.sessionId);
      expect(active.map((entry) => entry.sessionId)).not.toContain(firstSession.sessionId);
      expect(firstError._tag).toBe("ServerAuthInvalidCredentialError");
      for (const stale of staleSessions) {
        const error = yield* sessions.verify(stale.token).pipe(Effect.flip);
        expect(error._tag).toBe("SessionTokenRevokedError");
      }
      const pairedSession = yield* serverAuth.authenticateHttpRequest(
        makeBearerRequest(paired.access_token),
      );
      expect(pairedSession.subject).toBe("one-time-token");
      expect(active.map((entry) => entry.sessionId)).toContain(pairedSession.sessionId);
    }).pipe(
      Effect.provide(
        layerEnvironmentAuth({
          desktopBootstrapToken: "desktop-bootstrap-token",
        }),
      ),
    ),
  );

  it.effect("issues startup pairing URLs that bootstrap administrative sessions", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;

      const pairingUrl = yield* serverAuth.issueStartupPairingUrl("http://127.0.0.1:3773");
      const token = new URLSearchParams(new URL(pairingUrl).hash.slice(1)).get("token");
      const listedPairingLinks = yield* serverAuth.listPairingLinks();
      expect(token).toBeTruthy();
      expect(
        listedPairingLinks.some(
          (pairingLink) => pairingLink.subject === "administrative-bootstrap",
        ),
      ).toBe(false);

      const exchanged = yield* serverAuth.createBrowserSession(token ?? "", requestMetadata);
      const verified = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(sessions.cookieName, exchanged.sessionToken),
      );

      expect(verified.scopes).toEqual(AuthStandardClientScopes);
      expect(verified.subject).toBe("administrative-bootstrap");
    }).pipe(Effect.provide(layerEnvironmentAuth())),
  );

  it.effect(
    "lists pairing links and revokes other sessions while keeping the administrative session",
    () =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;

        const administrativeExchange = yield* serverAuth.createBrowserSession(
          "desktop-bootstrap-token",
          requestMetadata,
        );
        const administrativeSession = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(sessions.cookieName, administrativeExchange.sessionToken),
        );
        const pairingCredential = yield* serverAuth.issuePairingCredential({
          label: "Julius iPhone",
        });
        const listedPairingLinks = yield* serverAuth.listPairingLinks();
        const clientExchange = yield* serverAuth.createBrowserSession(
          pairingCredential.credential,
          {
            ...requestMetadata,
            deviceType: "mobile",
            os: "iOS",
            browser: "Safari",
            ipAddress: "192.168.1.88",
          },
        );
        const clientSession = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(sessions.cookieName, clientExchange.sessionToken),
        );
        const clientsBeforeRevoke = yield* serverAuth.listClientSessions(
          administrativeSession.sessionId,
        );
        const revokedCount = yield* serverAuth.revokeOtherClientSessions(
          administrativeSession.sessionId,
        );
        const clientsAfterRevoke = yield* serverAuth.listClientSessions(
          administrativeSession.sessionId,
        );

        expect(listedPairingLinks.map((entry) => entry.id)).toContain(pairingCredential.id);
        expect(listedPairingLinks.find((entry) => entry.id === pairingCredential.id)?.label).toBe(
          "Julius iPhone",
        );
        expect(clientsBeforeRevoke).toHaveLength(2);
        expect(
          clientsBeforeRevoke.find((entry) => entry.sessionId === administrativeSession.sessionId)
            ?.current,
        ).toBe(true);
        expect(
          clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.current,
        ).toBe(false);
        expect(
          clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.client
            .label,
        ).toBe("Julius iPhone");
        expect(
          clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.client
            .deviceType,
        ).toBe("mobile");
        expect(revokedCount).toBe(1);
        expect(clientsAfterRevoke).toHaveLength(1);
        expect(clientsAfterRevoke[0]?.sessionId).toBe(administrativeSession.sessionId);
      }).pipe(
        Effect.provide(
          layerEnvironmentAuth({
            desktopBootstrapToken: "desktop-bootstrap-token",
          }),
        ),
      ),
  );

  it.effect("accepts cookie sessions on socket upgrades only from the app's own origins", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const pairing = yield* serverAuth.issuePairingCredential();
      const exchanged = yield* serverAuth.createBrowserSession(pairing.credential, requestMetadata);
      const upgrade = (headers: Record<string, string>) =>
        serverAuth.authenticateWebSocketUpgrade(
          {
            url: "/ws",
            cookies: { [sessions.cookieName]: exchanged.sessionToken },
            headers: { host: "192.168.1.50:3773", ...headers },
          } as never,
          "rpc",
        );

      yield* upgrade({ origin: "http://192.168.1.50:3773" });
      yield* upgrade({
        origin: "https://box.tail1234.ts.net",
        "x-forwarded-host": "box.tail1234.ts.net",
      });
      yield* upgrade({ origin: "goat://app" });
      yield* upgrade({ origin: "t3code://app" });
      yield* upgrade({ origin: "goat-dev://app" });
      yield* upgrade({ origin: "t3code-dev://app" });
      yield* upgrade({ origin: "http://localhost:5733" });
      yield* upgrade({});

      const otherPort = yield* Effect.flip(upgrade({ origin: "http://192.168.1.50:8080" }));
      expect(otherPort._tag).toBe("ServerAuthInvalidCredentialError");
      const opaque = yield* Effect.flip(upgrade({ origin: "null" }));
      expect(opaque._tag).toBe("ServerAuthInvalidCredentialError");
    }).pipe(
      Effect.provide(
        layerEnvironmentAuth({
          mode: "web",
          host: "192.168.1.50",
          devUrl: new URL("http://localhost:5733"),
        }),
      ),
    ),
  );

  it.effect("accepts cookie sessions on HTTP requests only from the app's own origins", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const pairing = yield* serverAuth.issuePairingCredential();
      const exchanged = yield* serverAuth.createBrowserSession(pairing.credential, requestMetadata);
      const post = (headers: Record<string, string>) =>
        serverAuth.authenticateHttpRequest({
          cookies: { [sessions.cookieName]: exchanged.sessionToken },
          headers: { host: "localhost:13773", ...headers },
        } as never);

      yield* post({ origin: "http://192.168.1.50:5733", "sec-fetch-site": "same-origin" });
      const sameOrigin = yield* post({ origin: "http://localhost:13773" });
      for (const origin of ["goat://app", "t3code://app", "goat-dev://app", "t3code-dev://app"]) {
        const authenticated = yield* post({ origin });
        expect(authenticated.sessionId).toBe(sameOrigin.sessionId);
      }

      const otherPort = yield* Effect.flip(
        post({ origin: "http://localhost:3000", "sec-fetch-site": "same-site" }),
      );
      expect(otherPort._tag).toBe("ServerAuthInvalidCredentialError");
      const state = yield* serverAuth.getSessionState({
        cookies: { [sessions.cookieName]: exchanged.sessionToken },
        headers: { host: "localhost:13773", origin: "http://localhost:3000" },
      } as never);
      expect(state.authenticated).toBe(false);
    }).pipe(Effect.provide(layerEnvironmentAuth({ mode: "web" }))),
  );

  it.effect("keeps bearer socket upgrades independent of the page origin", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const bearer = yield* serverAuth.issueSession();
      const verified = yield* serverAuth.authenticateWebSocketUpgrade(
        {
          url: "/ws",
          cookies: {},
          headers: {
            host: "192.168.1.50:3773",
            origin: "http://192.168.1.50:8080",
            authorization: `Bearer ${bearer.token}`,
          },
        } as never,
        "rpc",
      );
      expect(verified.sessionId).toBe(bearer.sessionId);
    }).pipe(Effect.provide(layerEnvironmentAuth({ mode: "web", host: "192.168.1.50" }))),
  );

  // An SSH client reuses its saved bearer while the host answers it as signed in, so that
  // answer must survive a restart and end with revocation or expiry.
  it.effect("answers a paired bearer as signed in across a restart until revoked", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-auth-ssh-reuse-" });
      const before = yield* makeDiskEnvironmentAuthLayer(baseDir);
      const after = yield* makeDiskEnvironmentAuthLayer(baseDir);
      const token = yield* Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const pairing = yield* auth.issuePairingCredential();
        const access = yield* auth.exchangeBootstrapCredentialForAccessToken(
          pairing.credential,
          undefined,
          requestMetadata,
        );
        return access.access_token;
      }).pipe(Effect.provide(before), Effect.scoped);
      yield* Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const state = yield* auth.getSessionState(makeBearerRequest(token) as never);
        expect(state.authenticated).toBe(true);
        expect(state.permissions).toEqual(expect.arrayContaining([...AuthStandardClientScopes]));
        const principal = yield* auth.authenticateHttpRequest(makeBearerRequest(token));
        yield* auth.revokeSession(principal.sessionId);
        const revoked = yield* auth.getSessionState(makeBearerRequest(token) as never);
        expect(revoked.authenticated).toBe(false);
      }).pipe(Effect.provide(after), Effect.scoped);
    }).pipe(Effect.scoped),
  );

  it.effect("answers a paired bearer as signed out once it expires", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const pairing = yield* auth.issuePairingCredential();
      const access = yield* auth.exchangeBootstrapCredentialForAccessToken(
        pairing.credential,
        undefined,
        requestMetadata,
      );
      const request = makeBearerRequest(access.access_token) as never;
      expect((yield* auth.getSessionState(request)).authenticated).toBe(true);
      yield* TestClock.adjust(Duration.seconds(access.expires_in + 1));
      expect((yield* auth.getSessionState(request)).authenticated).toBe(false);
    }).pipe(Effect.provide(layerEnvironmentAuth())),
  );

  it.effect("reauthorizes MCP clients that the CLI issued after the server started", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-auth-cli-mcp-" });
      const server = yield* makeDiskEnvironmentAuthLayer(baseDir);
      const cli = yield* makeDiskEnvironmentAuthLayer(baseDir);
      yield* Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const issued = yield* EnvironmentAuth.EnvironmentAuth.pipe(
          Effect.flatMap((other) =>
            other.issueSession({
              subject: "mcp-client",
              scopes: ["orchestration:read", "orchestration:operate", "memory:read"],
              label: "SSH dispatch",
            }),
          ),
          Effect.provide(cli, { local: true }),
          Effect.scoped,
        );
        const client = yield* auth.authenticateMcpClient(makeBearerRequest(issued.token) as never);
        yield* client.reauthorize!(["memory:read"]);
        expect((yield* client.reauthorize!(["memory:write"]).pipe(Effect.flip)).message).toBe(
          "The MCP session does not grant the required scope.",
        );
        yield* auth.revokeSession(client.sessionId);
        expect((yield* client.reauthorize!(["memory:read"]).pipe(Effect.flip)).message).toBe(
          "The MCP session is no longer active.",
        );
      }).pipe(Effect.provide(server), Effect.scoped);
    }).pipe(Effect.scoped),
  it.effect("binds a DPoP session's RPC socket ticket to its proof key", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const key = makeDpopKey();
      const other = makeDpopKey();
      const exchanged = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        "desktop-bootstrap-token",
        ["orchestration:read"],
        requestMetadata,
        { proofKeyThumbprint: key.thumbprint },
      );
      const session = yield* sessions.verify(exchanged.access_token);
      const host = "192.168.1.50:3773";
      const socketUrl = `http://${host}/ws`;
      const iat = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
      const upgrade = (ticket: string, use: "rpc" | "media", proof?: string) =>
        serverAuth.authenticateWebSocketUpgrade(
          {
            method: "GET",
            url: `/ws?orchestrationProtocol=2&wsTicket=${ticket}${proof ? `&dpop=${proof}` : ""}`,
            cookies: {},
            headers: { host },
          } as never,
          use,
        );

      const rpc = yield* serverAuth.issueWebSocketTicket(session, { use: "rpc" });
      const bare = yield* Effect.flip(upgrade(rpc.ticket, "rpc"));
      expect(bare._tag).toBe("ServerAuthInvalidCredentialError");
      const signed = yield* upgrade(
        rpc.ticket,
        "rpc",
        key.sign({ method: "GET", url: socketUrl, token: rpc.ticket, iat }),
      );
      expect(signed.sessionId).toBe(session.sessionId);

      const wrongKey = yield* Effect.flip(
        upgrade(
          rpc.ticket,
          "rpc",
          other.sign({ method: "GET", url: socketUrl, token: rpc.ticket, iat }),
        ),
      );
      expect(wrongKey._tag).toBe("ServerAuthInvalidCredentialError");
      const onMedia = yield* Effect.flip(
        upgrade(
          rpc.ticket,
          "media",
          key.sign({ method: "GET", url: socketUrl, token: rpc.ticket, iat }),
        ),
      );
      expect(onMedia._tag).toBe("ServerAuthInvalidCredentialError");

      const media = yield* serverAuth.issueWebSocketTicket(session, { use: "media" });
      expect((yield* upgrade(media.ticket, "media")).sessionId).toBe(session.sessionId);
      const mediaOnRpc = yield* Effect.flip(upgrade(media.ticket, "rpc"));
      expect(mediaOnRpc._tag).toBe("ServerAuthInvalidCredentialError");

      // Clients that predate ticket binding still connect with the unbound ticket they mint.
      const legacy = yield* serverAuth.issueWebSocketTicket(session);
      expect((yield* upgrade(legacy.ticket, "rpc")).sessionId).toBe(session.sessionId);
    }).pipe(
      Effect.provide(layerEnvironmentAuth({ desktopBootstrapToken: "desktop-bootstrap-token" })),
    ),
  );

  it.effect("rejects a replayed proof on a bound RPC socket ticket", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const key = makeDpopKey();
      const exchanged = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        "desktop-bootstrap-token",
        ["orchestration:read"],
        requestMetadata,
        { proofKeyThumbprint: key.thumbprint },
      );
      const session = yield* sessions.verify(exchanged.access_token);
      const rpc = yield* serverAuth.issueWebSocketTicket(session, { use: "rpc" });
      const request = {
        method: "GET",
        url: `/ws?wsTicket=${rpc.ticket}&dpop=${key.sign({
          method: "GET",
          url: "http://192.168.1.50:3773/ws",
          token: rpc.ticket,
          iat: Math.floor((yield* DateTime.now).epochMilliseconds / 1_000),
        })}`,
        cookies: {},
        headers: { host: "192.168.1.50:3773" },
      } as never;

      yield* serverAuth.authenticateWebSocketUpgrade(request, "rpc");
      const replayed = yield* Effect.flip(serverAuth.authenticateWebSocketUpgrade(request, "rpc"));
      expect(replayed._tag).toBe("ServerAuthInvalidCredentialError");
      if (replayed._tag === "ServerAuthInvalidCredentialError") {
        expect(replayed.dpopFailureReason).toBe("replay");
      }
    }).pipe(
      Effect.provide(layerEnvironmentAuth({ desktopBootstrapToken: "desktop-bootstrap-token" })),
    ),
  );
});
