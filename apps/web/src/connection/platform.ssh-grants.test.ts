import { describe, expect, it } from "@effect/vitest";
import { BearerConnectionCredential, ConnectionOnboarding } from "@goat/client-runtime/connection";
import {
  ClientCapabilities,
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  putConnectionCredentialInCatalog,
  registerConnectionInCatalog,
  removeConnectionFromCatalog,
} from "@goat/client-runtime/platform";
import { AuthStandardClientScopes, EnvironmentId, type DesktopBridge } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";

import { prepareDesktopSshEnvironment, provisionDesktopSshEnvironment } from "./platform";
import { desktopSshPairingGrantStore } from "./sshPairingGrantStore";

const environmentId = EnvironmentId.make("ssh-grant-test");
const target = { alias: "test", hostname: "test.invalid", username: "test", port: 22 };
const scopes = AuthStandardClientScopes.filter((scope) => scope !== "access:write");
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionCatalogDocument));

function fixture() {
  let raw = JSON.stringify(EMPTY_CONNECTION_CATALOG_DOCUMENT);
  let pairings = 0;
  let writes = 0;
  let releaseSession: (() => void) | undefined;
  const sessionBlocked = new Promise<void>((resolve) => {
    releaseSession = resolve;
  });
  let connectionId = "";
  let token = "";
  const state = {
    version: "1.0.0",
    instance: "runtime-1" as string | undefined,
    hostname: target.hostname,
    authenticated: true,
    failPairing: false,
    unavailable: false,
    failRead: false,
    sessionError: undefined as Error | undefined,
    beforeSession: async () => {},
    afterSession: () => {},
  };
  const bridge = {
    getConnectionCatalog: async () => {
      if (state.failRead) throw new Error("secure store locked");
      return state.unavailable ? null : raw;
    },
    setConnectionCatalog: async (next: string, expected: string | null) => {
      if (state.unavailable) return false;
      if (raw !== expected) return "conflict";
      writes++;
      raw = next;
      return true;
    },
    ensureSshEnvironment: async (
      _target: typeof target,
      options?: { issuePairingToken?: boolean },
    ) => ({
      target: { ...target, hostname: state.hostname },
      httpBaseUrl: "http://127.0.0.1:3201/",
      wsBaseUrl: "ws://127.0.0.1:3201/",
      pairingToken: options?.issuePairingToken ? "fixture-pairing" : null,
    }),
    fetchSshEnvironmentDescriptor: async () => ({
      environmentId,
      label: "Test",
      platform: { os: "linux", arch: "arm64" },
      serverVersion: state.version,
      instanceId: state.instance,
      capabilities: { repositoryIdentity: true },
    }),
    fetchSshSessionState: async () => {
      await state.beforeSession();
      state.afterSession();
      if (state.sessionError) throw state.sessionError;
      return { authenticated: state.authenticated, permissions: scopes };
    },
    bootstrapSshBearerSession: async () => {
      if (state.failPairing) throw new Error("fixture pairing failed");
      pairings++;
      return { access_token: `fixture-token-${pairings}`, scope: scopes.join(" ") };
    },
  } as unknown as DesktopBridge;
  const document = () => decode(raw);
  const credential = () =>
    document().credentials.find((value) => value.connectionId === connectionId)?.credential;
  const register = Effect.gen(function* () {
    const registration = yield* ConnectionOnboarding.prepareSshRegistration({ target }).pipe(
      Effect.provideService(ClientCapabilities.SshEnvironmentGateway, {
        provision: (target, expected, options) =>
          provisionDesktopSshEnvironment(bridge, target, expected, options, undefined, new Map()),
        prepare: () => Effect.die("unused"),
        disconnect: () => Effect.void,
      }),
    );
    connectionId = registration.target.connectionId;
    token = registration.credential.token;
    raw = JSON.stringify(registerConnectionInCatalog(document(), registration));
  });
  const reconnectWithAuthorization = (
    authorize?: Parameters<typeof prepareDesktopSshEnvironment>[1]["authorize"],
  ) =>
    Effect.suspend(() =>
      prepareDesktopSshEnvironment(
        bridge,
        {
          connectionId,
          target,
          expectedEnvironmentId: environmentId,
          bearerToken: token,
          ...(authorize === undefined ? {} : { authorize }),
        },
        undefined,
        new Map(),
      ),
    );
  return {
    state,
    bridge,
    register,
    reconnect: reconnectWithAuthorization(),
    reconnectWithAuthorization,
    writes: () => writes,
    sessionBlocked,
    releaseSession: () => releaseSession!(),
    document,
    credential,
    pairings: () => pairings,
    connectionId: () => connectionId,
    token: () => token,
    replaceCredential: (credential: BearerConnectionCredential) => {
      raw = JSON.stringify(putConnectionCredentialInCatalog(document(), connectionId, credential));
    },
    forget: () => {
      raw = JSON.stringify(removeConnectionFromCatalog(document(), environmentId));
    },
  };
}

describe("secure SSH pairing grants", () => {
  it.effect(
    "persists with initial registration and reuses a narrow token across renderer launches",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        yield* f.register;
        expect(f.credential()?.sshPairingGrant?.scopes).toEqual(scopes);
        for (let launch = 0; launch < 3; launch++) {
          const prepared = yield* f.reconnect;
          expect(prepared.bearerToken).toBe(f.token());
        }
        expect(f.pairings()).toBe(1);
      }),
  );

  it.effect.each([401, 403, "unauthenticated"] as const)(
    "invalidates %s after a speculative ticket completes without persisting it",
    (rejection) =>
      Effect.gen(function* () {
        const f = fixture();
        yield* f.register;
        f.state.beforeSession = () => f.sessionBlocked;
        f.state.failPairing = true;
        if (rejection === "unauthenticated") {
          f.state.authenticated = false;
          f.state.failPairing = true;
        } else {
          f.state.sessionError = new Error(`[ssh_http:${rejection}]`);
        }
        let tickets = 0;
        const attempt = f.reconnectWithAuthorization((prepared, verified) =>
          Effect.gen(function* () {
            const descriptor = prepared.verifiedEndpoint!.descriptor;
            yield* verified(descriptor);
            tickets++;
            f.releaseSession();
            return {
              environmentId,
              label: descriptor.label,
              httpBaseUrl: prepared.bootstrap.httpBaseUrl,
              socketUrl: prepared.bootstrap.wsBaseUrl,
              httpAuthorization: { _tag: "Bearer", token: prepared.bearerToken },
            };
          }),
        );
        yield* attempt.pipe(Effect.flip);
        expect(tickets).toBe(1);
        expect(f.credential()?.sshPairingGrant).toBeUndefined();
        expect(f.credential()?.token).toBe(f.token());
        expect(f.writes()).toBe(1);
        expect(f.pairings()).toBe(1);
      }),
  );

  it.effect("keeps ticket and session validation concurrent without rewriting the grant", () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* f.register;
      const sessionStarted = yield* Deferred.make<void>();
      const releaseTicket = yield* Deferred.make<void>();
      f.state.afterSession = () => {
        Deferred.doneUnsafe(sessionStarted, Effect.void);
      };
      const fiber = yield* f
        .reconnectWithAuthorization((prepared, verified) =>
          Effect.gen(function* () {
            const descriptor = prepared.verifiedEndpoint!.descriptor;
            yield* verified(descriptor);
            yield* Deferred.await(releaseTicket);
            return {
              environmentId,
              label: descriptor.label,
              httpBaseUrl: prepared.bootstrap.httpBaseUrl,
              socketUrl: prepared.bootstrap.wsBaseUrl,
              httpAuthorization: { _tag: "Bearer", token: prepared.bearerToken },
            };
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(sessionStarted);
      expect(f.writes()).toBe(0);
      yield* Deferred.succeed(releaseTicket, undefined);
      const prepared = yield* Fiber.join(fiber);
      expect(prepared.authorization).toBeDefined();
      expect(prepared.sshPairingGrant).toEqual(f.credential()?.sshPairingGrant);
      expect(f.writes()).toBe(0);
      expect(f.pairings()).toBe(1);
    }),
  );

  it.effect("invalidates using the fresh authorization identity when the forward changes", () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* f.register;
      f.state.failPairing = true;
      yield* f
        .reconnectWithAuthorization((prepared, verified) =>
          Effect.gen(function* () {
            const descriptor = {
              ...prepared.verifiedEndpoint!.descriptor,
              instanceId: "replacement-instance",
            };
            yield* verified(descriptor);
            return {
              environmentId,
              label: descriptor.label,
              httpBaseUrl: prepared.bootstrap.httpBaseUrl,
              socketUrl: prepared.bootstrap.wsBaseUrl,
              httpAuthorization: { _tag: "Bearer", token: prepared.bearerToken },
            };
          }),
        )
        .pipe(Effect.flip);
      expect(f.credential()?.sshPairingGrant).toBeUndefined();
    }),
  );

  it.effect.each(["version", "instance"] as const)(
    "invalidates on runtime %s change before a failed re-pair",
    (changed) =>
      Effect.gen(function* () {
        const f = fixture();
        yield* f.register;
        f.state[changed] = "changed";
        f.state.failPairing = true;
        yield* f.reconnect.pipe(Effect.flip);
        expect(f.credential()?.sshPairingGrant).toBeUndefined();
        expect(f.credential()?.token).toBe(f.token());
      }),
  );

  it.effect(
    "does not reuse a grant for another host claiming the same environment and runtime",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        yield* f.register;
        f.state.hostname = "other.invalid";
        f.state.failPairing = true;
        yield* f.reconnect.pipe(Effect.flip);
        expect(f.credential()?.sshPairingGrant).toBeUndefined();
      }),
  );

  it.effect("does not persist a grant when the runtime has no instance identity", () =>
    Effect.gen(function* () {
      const f = fixture();
      f.state.instance = undefined;
      yield* f.register;
      expect(f.credential()?.sshPairingGrant).toBeUndefined();
      yield* f.reconnect;
      expect(f.pairings()).toBe(2);
    }),
  );

  it.effect.each([401, 403])("invalidates on an Electron-wrapped HTTP %s", (status) =>
    Effect.gen(function* () {
      const f = fixture();
      yield* f.register;
      f.state.failPairing = true;
      f.state.sessionError = new Error(
        `Error invoking remote method 'fetch-ssh-session-state': DesktopSshEnvironmentRequestError: [ssh_http:${status}] SSH remote API request failed during fetch-session-state.`,
      );
      yield* f.reconnect.pipe(Effect.flip);
      expect(f.credential()?.sshPairingGrant).toBeUndefined();
      expect(f.pairings()).toBe(1);
    }),
  );

  it.effect("drops a revoked grant even when obtaining its replacement fails", () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* f.register;
      f.state.authenticated = false;
      f.state.failPairing = true;
      yield* f.reconnect.pipe(Effect.flip);
      expect(f.credential()?.sshPairingGrant).toBeUndefined();
    }),
  );

  it.effect("does not clear a newer pairing when an older session is rejected late", () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* f.register;
      const grant = f.credential()!.sshPairingGrant!;
      f.state.afterSession = () =>
        f.replaceCredential(
          new BearerConnectionCredential({ token: "newer-fixture-token", sshPairingGrant: grant }),
        );
      f.state.authenticated = false;
      f.state.failPairing = true;
      yield* f.reconnect.pipe(Effect.flip);
      expect(f.credential()?.token).toBe("newer-fixture-token");
      expect(f.credential()?.sshPairingGrant).toEqual(grant);
    }),
  );

  it.effect("forgets the grant across renderers and cannot restore it from a late reconnect", () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* f.register;
      yield* f.reconnect;
      f.forget();
      expect(f.document().credentials).toEqual([]);
      const prepared = yield* f.reconnect;
      expect(f.pairings()).toBe(2);
      f.replaceCredential(
        new BearerConnectionCredential({
          token: prepared.bearerToken,
          sshPairingGrant: prepared.sshPairingGrant!,
        }),
      );
      expect(f.document().credentials).toEqual([]);
    }),
  );

  it.effect(
    "does not restore metadata if forget happens while a session request is in flight",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        yield* f.register;
        f.state.afterSession = f.forget;
        f.state.authenticated = false;
        const prepared = yield* f.reconnect;
        f.replaceCredential(
          new BearerConnectionCredential({
            token: prepared.bearerToken,
            sshPairingGrant: prepared.sshPairingGrant!,
          }),
        );
        expect(f.document().credentials).toEqual([]);
      }),
  );

  it.effect.each(["unavailable", "failRead"] as const)(
    "requires full scopes when secure storage becomes %s after a successful load",
    (unavailable) =>
      Effect.gen(function* () {
        const f = fixture();
        yield* f.register;
        yield* f.reconnect;
        f.state[unavailable] = true;
        yield* f.reconnect;
        expect(f.pairings()).toBe(2);
      }),
  );

  it.effect("keeps metadata only in the credential and never writes before registration", () =>
    Effect.gen(function* () {
      const f = fixture();
      const provisioned = yield* provisionDesktopSshEnvironment(f.bridge, target);
      expect(provisioned.sshPairingGrant?.scopes).toEqual(scopes);
      expect(f.document()).toEqual(EMPTY_CONNECTION_CATALOG_DOCUMENT);
    }),
  );

  it.effect("invalidates only the observed token and grant after a CAS conflict", () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* f.register;
      const grant = f.credential()!.sshPairingGrant!;
      const loaded = yield* desktopSshPairingGrantStore(f.bridge)!.load(
        f.connectionId(),
        f.token(),
        grant.key,
      );
      const set = f.bridge.setConnectionCatalog!;
      f.bridge.setConnectionCatalog = async () => {
        f.replaceCredential(
          new BearerConnectionCredential({ token: "newer-fixture-token", sshPairingGrant: grant }),
        );
        f.bridge.setConnectionCatalog = set;
        return "conflict";
      };
      yield* loaded.invalidate;
      expect(f.credential()?.token).toBe("newer-fixture-token");
      expect(f.credential()?.sshPairingGrant).toEqual(grant);
    }),
  );

  it("does not offer a persistence path on older desktop shells", () => {
    expect(desktopSshPairingGrantStore({} as DesktopBridge)).toBeUndefined();
  });
});
