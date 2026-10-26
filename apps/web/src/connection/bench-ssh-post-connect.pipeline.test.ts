import {
  AuthStandardClientScopes,
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
  type AuthSessionState,
  type DesktopBridge,
  type ExecutionEnvironmentDescriptor,
} from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Authorization from "@goat/client-runtime/authorization/service";
import { ClientCapabilities as Capabilities } from "@goat/client-runtime/platform";
import { ManagedRelay as Relay } from "@goat/client-runtime/relay";
import { TokenStore } from "@goat/client-runtime/authorization";
import * as RpcHttp from "@goat/client-runtime/rpc";
import * as Session from "@goat/client-runtime/rpc/session";
import type { WsRpcProtocolClient } from "@goat/client-runtime/rpc";
import * as Driver from "@goat/client-runtime/connection/driver";
import * as Resolver from "@goat/client-runtime/connection/resolver";
import {
  BearerConnectionCredential,
  CredentialStore as Credentials,
  ProfileStore as Profiles,
  SshConnectionProfile,
  SshConnectionTarget,
} from "@goat/client-runtime/connection";
import { prepareDesktopSshEnvironment } from "./platform.ts";

const ENVIRONMENT_ID = EnvironmentId.make("ssh-environment");
const TARGET = { alias: "devbox", hostname: "devbox.test", username: "developer", port: 22 };
const BOOTSTRAP = {
  target: TARGET,
  httpBaseUrl: "http://127.0.0.1:3201",
  wsBaseUrl: "ws://127.0.0.1:3201",
  pairingToken: null,
};
const DESCRIPTOR: ExecutionEnvironmentDescriptor = {
  environmentId: ENVIRONMENT_ID,
  label: "SSH",
  platform: { os: "linux", arch: "arm64" },
  instanceId: "first-runtime",
  serverVersion: "0.0.0-test",
  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
  capabilities: { repositoryIdentity: true },
};
type SessionState = Pick<AuthSessionState, "authenticated" | "permissions" | "scopes">;
const AUTHENTICATED: SessionState = { authenticated: true, permissions: AuthStandardClientScopes };
const ticket = (value: string) =>
  Response.json({ ticket: value, expiresAt: "2026-10-20T00:05:00Z" });

const makeHarness = Effect.fn("TestSshAuthorization.makeHarness")(function* (options?: {
  readonly session?: Effect.Effect<SessionState>;
  readonly sessionForToken?: (token: string) => Effect.Effect<SessionState>;
  readonly ticket?: (token: string) => Effect.Effect<Response>;
  readonly beforeDescriptor?: Effect.Effect<void>;
  readonly overlap?: boolean;
  readonly gatewayEvidence?: boolean;
}) {
  // oxlint-disable-next-line goat/no-manual-effect-runtime-in-tests -- IPC/fetch fixtures return promises; reuse it.effect's services so their Deferreds and clock stay test-owned.
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const state = { descriptor: DESCRIPTOR, bearerToken: "saved-token", sockets: [] as string[] };
  const requests: Array<{ path: string; authorization: string | null }> = [];
  const calls: string[] = [];
  const sessionStarted = yield* Deferred.make<void>();
  const ticketStarted = yield* Deferred.make<void>();
  const descriptorStarted = yield* Deferred.make<void>();
  const authorizationFinished = yield* Deferred.make<void>();
  const bridge = {
    ensureSshEnvironment: async (
      _target: typeof TARGET,
      input?: { issuePairingToken?: boolean },
    ) => {
      calls.push("ensure");
      return { ...BOOTSTRAP, pairingToken: input?.issuePairingToken ? "pairing-token" : null };
    },
    fetchSshEnvironmentDescriptor: async () => {
      calls.push("gateway-descriptor");
      return state.descriptor;
    },
    fetchSshSessionState: (_url: string, token: string) => {
      calls.push("session");
      Deferred.doneUnsafe(sessionStarted, Effect.void);
      return runPromise(
        options?.sessionForToken?.(token) ?? options?.session ?? Effect.succeed(AUTHENTICATED),
      );
    },
    bootstrapSshBearerSession: async () => {
      calls.push("pairing");
      return {
        access_token: "paired-token",
        scope: AuthStandardClientScopes.join(" "),
      };
    },
  } as unknown as DesktopBridge;
  const http = RpcHttp.layerRemoteHttpClient(async (url, init) => {
    const path = new URL(String(url)).pathname;
    const authorization = new Headers(init?.headers).get("Authorization");
    requests.push({ path, authorization });
    if (path.endsWith("/environment")) {
      Deferred.doneUnsafe(descriptorStarted, Effect.void);
      await runPromise(options?.beforeDescriptor ?? Effect.void, {
        signal: init?.signal ?? undefined,
      });
      return Response.json(state.descriptor);
    }
    if (path.endsWith("/websocket-ticket/rpc")) {
      Deferred.doneUnsafe(ticketStarted, Effect.void);
      const token = authorization?.replace(/^Bearer /, "") ?? "";
      return runPromise(options?.ticket?.(token) ?? Effect.succeed(ticket(token)), {
        signal: init?.signal ?? undefined,
      });
    }
    throw new Error("Unexpected HTTP path");
  });
  const unused = () => Effect.die("Unexpected relay operation");
  const common = Layer.mergeAll(
    http,
    Layer.succeed(Capabilities.CloudSession, {
      identity: Effect.succeedNone,
      clerkToken: unused(),
    }),
    Layer.succeed(Capabilities.RelayDeviceIdentity, { deviceId: Effect.succeedNone }),
    Layer.succeed(Capabilities.PrimaryEnvironmentAuth, { bearerToken: Effect.succeedNone }),
    Layer.succeed(Capabilities.ClientPresentation, {
      metadata: { label: "Test", deviceType: "desktop" },
    }),
    Layer.succeed(TokenStore.RemoteDpopAccessTokenStore, {
      get: () => Effect.succeedNone,
      put: unused,
      remove: unused,
    }),
    Layer.succeed(Relay.ManagedRelayDpopSigner, { thumbprint: unused(), createProof: unused }),
    Layer.succeed(Relay.ManagedRelayClient, {
      relayUrl: "https://unused.invalid",
      listEnvironments: unused,
      listDevices: unused,
      createEnvironmentLinkChallenge: unused,
      linkEnvironment: unused,
      unlinkEnvironment: unused,
      getEnvironmentStatus: unused,
      connectEnvironment: unused,
      registerDevice: unused,
      unregisterDevice: unused,
      registerLiveActivity: unused,
      getAgentActivitySnapshot: unused,
      resetTokenCache: Effect.void,
    }),
  );
  const remote = yield* Authorization.make.pipe(Effect.provide(common));
  const profile = new SshConnectionProfile({
    connectionId: "ssh",
    environmentId: ENVIRONMENT_ID,
    label: "SSH",
    target: TARGET,
  });
  const entry = {
    target: new SshConnectionTarget({
      connectionId: "ssh",
      environmentId: ENVIRONMENT_ID,
      label: "SSH",
    }),
    profile: Option.some(profile),
    enabled: true,
  };
  const resolver = yield* Resolver.make.pipe(
    Effect.provideService(Authorization.RemoteEnvironmentAuthorization, remote),
    Effect.provideService(Profiles.ConnectionProfileStore, {
      get: () => Effect.succeedSome(profile),
      put: () => Effect.void,
      remove: () => Effect.void,
    }),
    Effect.provideService(Credentials.ConnectionCredentialStore, {
      get: () => Effect.succeedSome(new BearerConnectionCredential({ token: state.bearerToken })),
      put: (_id, credential) =>
        Effect.sync(() => {
          if (credential._tag === "BearerConnectionCredential")
            state.bearerToken = credential.token;
        }),
      remove: () => Effect.void,
    }),
    Effect.provideService(Capabilities.SshEnvironmentGateway, {
      provision: unused,
      disconnect: () => Effect.void,
      prepare: (input) => {
        if (options?.gatewayEvidence === false)
          return Effect.succeed({ bootstrap: BOOTSTRAP, bearerToken: state.bearerToken });
        const { authorize, ...rest } = input;
        return prepareDesktopSshEnvironment(
          bridge,
          {
            ...rest,
            ...(options?.overlap === false || authorize === undefined
              ? {}
              : {
                  authorize: (prepared, onVerified) =>
                    authorize(prepared, onVerified).pipe(
                      Effect.onExit(() => Deferred.succeed(authorizationFinished, undefined)),
                    ),
                }),
          },
          () => Effect.void,
          new Map(),
        );
      },
    }),
    Effect.provide(common),
  );
  const driver = yield* Driver.make.pipe(
    Effect.provideService(Resolver.ConnectionResolver, resolver),
    Effect.provideService(Session.RpcSessionFactory, {
      connect: (prepared) =>
        Effect.sync(() => {
          state.sockets.push(prepared.socketUrl);
          return {
            client: {} as WsRpcProtocolClient,
            initialConfig: Effect.die("unused"),
            subscribeServerConfig: () => {
              throw new Error("unused");
            },
            ready: Effect.void,
            probe: Effect.void,
            closed: Effect.never,
          };
        }),
    }),
    Effect.provide(http),
  );
  return {
    state,
    requests,
    calls,
    sessionStarted,
    ticketStarted,
    descriptorStarted,
    authorizationFinished,
    resolver,
    driver,
    entry,
  };
});

describe("SSH session and ticket pipeline", () => {
  it.effect(
    "runs ticket and session concurrently but opens the socket only after session approval",
    () =>
      Effect.gen(function* () {
        const session = yield* Deferred.make<SessionState>();
        const h = yield* makeHarness({ session: Deferred.await(session) });
        const fiber = yield* h.driver.connect(h.entry, () => Effect.void).pipe(Effect.forkChild);
        yield* Deferred.await(h.sessionStarted);
        yield* Deferred.await(h.ticketStarted);
        yield* Deferred.await(h.authorizationFinished);
        expect(h.state.sockets).toEqual([]);
        expect(h.requests.map((r) => r.path)).toEqual([
          "/.well-known/goat/environment",
          "/api/auth/websocket-ticket/rpc",
        ]);
        yield* Deferred.succeed(session, AUTHENTICATED);
        const connected = yield* Fiber.join(fiber);
        expect(connected.prepared.socketUrl).toContain("wsTicket=saved-token");
        expect(h.state.sockets).toHaveLength(1);
        expect(h.requests.filter((r) => r.path.endsWith("/websocket-ticket/rpc"))).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.effect("waits for a pending ticket when the session check finishes first", () =>
    Effect.gen(function* () {
      const ticketReply = yield* Deferred.make<Response>();
      const h = yield* makeHarness({ ticket: () => Deferred.await(ticketReply) });
      const fiber = yield* h.driver.connect(h.entry, () => Effect.void).pipe(Effect.forkChild);
      yield* Deferred.await(h.sessionStarted);
      yield* Deferred.await(h.ticketStarted);
      expect(h.state.sockets).toEqual([]);
      yield* Deferred.succeed(ticketReply, ticket("completed-ticket"));
      expect((yield* Fiber.join(fiber)).prepared.socketUrl).toContain("wsTicket=completed-ticket");
      expect(h.state.sockets).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "rejects a changed forward during fresh verification before either bearer request",
    () =>
      Effect.gen(function* () {
        const descriptorReply = yield* Deferred.make<void>();
        const h = yield* makeHarness({ beforeDescriptor: Deferred.await(descriptorReply) });
        const fiber = yield* h.driver
          .connect(h.entry, () => Effect.void)
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(h.descriptorStarted);
        h.state.descriptor = {
          ...DESCRIPTOR,
          environmentId: EnvironmentId.make("replacement-environment"),
        };
        yield* Deferred.succeed(descriptorReply, undefined);
        expect((yield* Fiber.join(fiber))._tag).toBe("Failure");
        expect(h.calls).not.toContain("session");
        expect(h.requests).toEqual([
          { path: "/.well-known/goat/environment", authorization: null },
        ]);
        expect(h.state.sockets).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.effect.each(["revoked", "insufficient-scopes"] as const)(
    "discards the speculative ticket and pairs for %s sessions",
    (scenario) =>
      Effect.gen(function* () {
        const session = yield* Deferred.make<SessionState>();
        const h = yield* makeHarness({ session: Deferred.await(session) });
        const fiber = yield* h.driver.connect(h.entry, () => Effect.void).pipe(Effect.forkChild);
        yield* Deferred.await(h.ticketStarted);
        yield* Deferred.await(h.authorizationFinished);
        expect(h.state.sockets).toEqual([]);
        yield* Deferred.succeed(session, {
          authenticated: scenario !== "revoked",
          permissions: [],
        });
        const connected = yield* Fiber.join(fiber);
        expect(connected.prepared.socketUrl).toContain("wsTicket=paired-token");
        expect(h.calls.filter((call) => call === "pairing")).toHaveLength(1);
        expect(h.state.sockets).toHaveLength(1);
        expect(h.state.sockets[0]).not.toContain("wsTicket=saved-token");
      }).pipe(Effect.scoped),
  );

  it.effect.each(["revoked", "insufficient-scopes"] as const)(
    "an early ticket failure still lets %s sessions pair",
    (scenario) =>
      Effect.gen(function* () {
        const session = yield* Deferred.make<SessionState>();
        const ticketFailed = yield* Deferred.make<void>();
        const h = yield* makeHarness({
          session: Deferred.await(session),
          ticket: (token) =>
            token === "saved-token"
              ? Deferred.succeed(ticketFailed, undefined).pipe(
                  Effect.as(Response.json({}, { status: 401 })),
                )
              : Effect.succeed(ticket(token)),
        });
        const fiber = yield* h.driver.connect(h.entry, () => Effect.void).pipe(Effect.forkChild);
        yield* Deferred.await(ticketFailed);
        yield* Deferred.await(h.authorizationFinished);
        yield* Deferred.await(h.sessionStarted);
        expect(h.calls).not.toContain("pairing");
        yield* Deferred.succeed(session, {
          authenticated: scenario !== "revoked",
          permissions: [],
        });
        const connected = yield* Fiber.join(fiber);
        expect(connected.prepared.socketUrl).toContain("wsTicket=paired-token");
      }).pipe(Effect.scoped),
  );

  it.effect("surfaces a ticket error after the session is accepted", () =>
    Effect.gen(function* () {
      const session = yield* Deferred.make<SessionState>();
      const h = yield* makeHarness({
        session: Deferred.await(session),
        ticket: () => Effect.succeed(Response.json({}, { status: 503 })),
      });
      const fiber = yield* h.driver
        .connect(h.entry, () => Effect.void)
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(h.ticketStarted);
      yield* Deferred.succeed(session, AUTHENTICATED);
      expect((yield* Fiber.join(fiber))._tag).toBe("Failure");
      expect(h.calls).not.toContain("pairing");
      expect(h.state.sockets).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("cancels an old attempt's ticket before accepting a replacement bearer", () =>
    Effect.gen(function* () {
      const oldTicket = yield* Deferred.make<Response>();
      const ticketCancelled = yield* Deferred.make<void>();
      const h = yield* makeHarness({
        ticket: (token) =>
          token === "saved-token"
            ? Deferred.await(oldTicket).pipe(
                Effect.onInterrupt(() => Deferred.succeed(ticketCancelled, undefined)),
              )
            : Effect.succeed(ticket(token)),
      });
      const old = yield* h.driver.connect(h.entry, () => Effect.void).pipe(Effect.forkChild);
      yield* Deferred.await(h.ticketStarted);
      yield* Fiber.interrupt(old);
      yield* Deferred.await(ticketCancelled);
      h.state.bearerToken = "replacement-token";
      const connected = yield* h.driver.connect(h.entry, () => Effect.void);
      yield* Deferred.succeed(oldTicket, ticket("stale-ticket"));
      expect(connected.prepared.socketUrl).toContain("wsTicket=replacement-token");
      expect(h.state.sockets).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("ignores a cancelled attempt's late session result after bearer replacement", () =>
    Effect.gen(function* () {
      const oldSession = yield* Deferred.make<SessionState>();
      const h = yield* makeHarness({
        sessionForToken: (token) =>
          token === "saved-token" ? Deferred.await(oldSession) : Effect.succeed(AUTHENTICATED),
      });
      const old = yield* h.driver.connect(h.entry, () => Effect.void).pipe(Effect.forkChild);
      yield* Deferred.await(h.sessionStarted);
      yield* Deferred.await(h.authorizationFinished);
      yield* Fiber.interrupt(old);
      h.state.bearerToken = "replacement-token";
      const connected = yield* h.driver.connect(h.entry, () => Effect.void);
      yield* Deferred.succeed(oldSession, AUTHENTICATED);
      expect(connected.prepared.socketUrl).toContain("wsTicket=replacement-token");
      expect(h.state.sockets).toHaveLength(1);
      expect(h.state.sockets[0]).not.toContain("wsTicket=saved-token");
    }).pipe(Effect.scoped),
  );

  it.effect("cancels a pending speculative ticket before re-pairing", () =>
    Effect.gen(function* () {
      const oldTicket = yield* Deferred.make<Response>();
      const cancelled = yield* Deferred.make<void>();
      const session = yield* Deferred.make<SessionState>();
      const h = yield* makeHarness({
        session: Deferred.await(session),
        ticket: (token) =>
          token === "saved-token"
            ? Deferred.await(oldTicket).pipe(
                Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
              )
            : Effect.succeed(ticket(token)),
      });
      const fiber = yield* h.driver.connect(h.entry, () => Effect.void).pipe(Effect.forkChild);
      yield* Deferred.await(h.ticketStarted);
      yield* Deferred.succeed(session, { authenticated: false });
      yield* Deferred.await(cancelled);
      const connected = yield* Fiber.join(fiber);
      yield* Deferred.succeed(oldTicket, ticket("stale-ticket"));
      expect(connected.prepared.socketUrl).toContain("wsTicket=paired-token");
      expect(h.state.sockets).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "rejects a same-attempt forward replacement after session validation without sending its bearer",
    () =>
      Effect.gen(function* () {
        const descriptorReply = yield* Deferred.make<void>();
        const h = yield* makeHarness({
          overlap: false,
          beforeDescriptor: Deferred.await(descriptorReply),
        });
        const fiber = yield* h.driver
          .connect(h.entry, () => Effect.void)
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(h.sessionStarted);
        yield* Deferred.await(h.descriptorStarted);
        h.state.descriptor = {
          ...DESCRIPTOR,
          environmentId: EnvironmentId.make("replacement-environment"),
        };
        yield* Deferred.succeed(descriptorReply, undefined);
        expect((yield* Fiber.join(fiber))._tag).toBe("Failure");
        expect(h.requests).toEqual([
          { path: "/.well-known/goat/environment", authorization: null },
        ]);
        expect(h.calls).not.toContain("pairing");
        expect(h.state.sockets).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.effect.each(["prepare", "prepareForUpdate"] as const)(
    "uses fresh discovery across two %s calls without gateway evidence",
    (method) =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ gatewayEvidence: false });
        yield* h.resolver.prepare(h.entry);
        const { orchestrationProtocolVersion: _protocol, ...olderRuntime } = DESCRIPTOR;
        h.state.descriptor = { ...olderRuntime, instanceId: "restarted-runtime" };
        if (method === "prepare") {
          const error = yield* h.resolver.prepare(h.entry).pipe(Effect.flip);
          expect(error).toMatchObject({ reason: "unsupported" });
        } else {
          expect((yield* h.resolver.prepareForUpdate(h.entry)).descriptor.instanceId).toBe(
            "restarted-runtime",
          );
        }
        expect(h.requests.filter((r) => r.path.endsWith("/environment"))).toHaveLength(2);
      }).pipe(Effect.scoped),
  );
});
