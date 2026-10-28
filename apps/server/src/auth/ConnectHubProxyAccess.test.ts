import * as Context from "effect/Context";
import * as PlatformError from "effect/PlatformError";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { AuthHubProxyScope, AuthStandardClientScopes } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as PubSub from "effect/PubSub";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Config from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as Auth from "./EnvironmentAuth.ts";
import * as Access from "./HubConnectAccess.ts";
import * as Grants from "./PairingGrantStore.ts";
import * as Secrets from "./ServerSecretStore.ts";
import * as Sessions from "./SessionStore.ts";
import * as Lifetime from "./SessionSocketLifetime.ts";

const services = Layer.mergeAll(Auth.layer, Settings.layer).pipe(
  Layer.provide(Secrets.layer),
  Layer.provide(Environment.layerIdentity),
);
const storage = Sqlite.layerMemory.pipe(
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "goat-connect-restart-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const layer = Layer.mergeAll(Auth.layer, Settings.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(Secrets.layer),
  Layer.provide(Environment.layerIdentity),
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "goat-connect-hub-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const request = (token: string) =>
  HttpServerRequest.fromWeb(
    new Request("http://hub.test/api/auth/session", {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
const metadata = { deviceType: "mobile" as const };
const setup = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const auth = yield* Auth.EnvironmentAuth;
  yield* auth.setCloudLinkTrust("test-account");
  yield* settings.start;
  return {
    settings,
    auth,
    access: yield* Access.HubConnectAccess,
    sessions: yield* Sessions.SessionStore,
    grants: yield* Grants.PairingGrantStore,
  };
});
const issuePrivileged = Effect.gen(function* () {
  const access = yield* Access.HubConnectAccess;
  const sessions = yield* Sessions.SessionStore;
  return yield* access.withPolicy((state) =>
    sessions.issue({
      subject: "cloud-connect",
      scopes: [...AuthStandardClientScopes, AuthHubProxyScope],
      connectAccessGeneration: state.generation,
    }),
  );
});

it.effect("adds hub access only to new Connect grants under effective standing consent", () =>
  Effect.gen(function* () {
    const { settings, auth } = yield* setup;
    for (const [enabled, consent, allowed] of [
      [false, true, false],
      [true, false, false],
      [true, true, true],
    ] as const) {
      yield* settings.updateSettings({ hub: { enabled, connectDevicesHubProxy: consent } });
      const grant = yield* auth.createCloudConnectPairingLink({ proofKeyThumbprint: "device-key" });
      const exchanged = yield* auth.exchangeBootstrapCredentialForAccessToken(
        grant.credential,
        undefined,
        metadata,
        { proofKeyThumbprint: "device-key" },
      );
      const sessions = yield* Sessions.SessionStore;
      const verified = yield* sessions.verify(exchanged.access_token);
      expect(verified.scopes).toEqual(
        allowed ? [...AuthStandardClientScopes, AuthHubProxyScope] : AuthStandardClientScopes,
      );
      expect(verified.connectAccessGeneration !== undefined).toBe(allowed);
    }
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "withdrawal rejects grants before narrowing and old tokens and tickets after re-enable",
  () =>
    Effect.gen(function* () {
      const { settings, auth, access, grants } = yield* setup;
      yield* settings.updateSettings({ hub: { enabled: true, connectDevicesHubProxy: true } });
      const session = yield* issuePrivileged;
      const ticket = yield* auth.issueWebSocketTicket(session, { use: "rpc" });
      const stamp = (yield* access.current).generation;
      const grant = yield* grants.issueOneTimeToken({
        subject: "cloud-connect",
        scopes: [...AuthStandardClientScopes, AuthHubProxyScope],
        connectAccessGeneration: stamp,
      });
      const standard = yield* auth.issueSession({ subject: "cloud-connect" });
      const paired = yield* auth.issueSession({ subject: "paired", scopes: [AuthHubProxyScope] });
      yield* auth.authenticateHttpRequest(request(session.token));
      yield* settings.updateSettings({ hub: { connectDevicesHubProxy: false } });
      yield* settings.updateSettings({ hub: { connectDevicesHubProxy: true } });
      expect(
        yield* auth.authenticateHttpRequest(request(session.token)).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
      const upgrade = HttpServerRequest.fromWeb(
        new Request(`http://hub.test/ws?wsTicket=${encodeURIComponent(ticket.ticket)}`),
      );
      expect(
        yield* auth.authenticateWebSocketUpgrade(upgrade, "rpc").pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
      expect(
        yield* auth
          .exchangeBootstrapCredentialForAccessToken(
            grant.credential,
            ["orchestration:read"],
            metadata,
          )
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
      expect((yield* auth.authenticateHttpRequest(request(standard.token))).subject).toBe(
        "cloud-connect",
      );
      expect((yield* auth.authenticateHttpRequest(request(paired.token))).subject).toBe("paired");
      const fresh = yield* issuePrivileged;
      yield* auth.authenticateHttpRequest(request(fresh.token));
    }).pipe(Effect.provide(layer)),
);

it.effect("Connect unlink and relink revoke issued hub privileges while consent stays on", () =>
  Effect.gen(function* () {
    const { settings, auth, access, grants } = yield* setup;
    yield* settings.updateSettings({ hub: { enabled: true, connectDevicesHubProxy: true } });
    const session = yield* issuePrivileged;
    const ticket = yield* auth.issueWebSocketTicket(session, { use: "rpc" });
    const stamp = (yield* access.current).generation;
    const grant = yield* grants.issueOneTimeToken({
      subject: "cloud-connect",
      scopes: [...AuthStandardClientScopes, AuthHubProxyScope],
      connectAccessGeneration: stamp,
    });
    const credential = {
      subject: "cloud-connect",
      scopes: [...AuthStandardClientScopes, AuthHubProxyScope],
      connectAccessGeneration: stamp,
    };
    yield* auth.authenticateHttpRequest(request(session.token));
    yield* auth.setCloudLinkTrust(null);
    yield* auth.setCloudLinkTrust("test-account");
    const current = yield* access.current;
    expect(current.allowed).toBe(true);
    expect(Access.admits(credential, current)).toBe(false);
    yield* access.awaitDenial(credential);
    expect(
      yield* auth.authenticateHttpRequest(request(session.token)).pipe(Effect.result),
    ).toMatchObject({ _tag: "Failure" });
    const upgrade = HttpServerRequest.fromWeb(
      new Request(`http://hub.test/ws?wsTicket=${encodeURIComponent(ticket.ticket)}`),
    );
    expect(
      yield* auth.authenticateWebSocketUpgrade(upgrade, "rpc").pipe(Effect.result),
    ).toMatchObject({ _tag: "Failure" });
    expect(
      yield* auth
        .exchangeBootstrapCredentialForAccessToken(grant.credential, undefined, metadata)
        .pipe(Effect.result),
    ).toMatchObject({ _tag: "Failure" });
    const fresh = yield* auth.createCloudConnectPairingLink({ proofKeyThumbprint: "device-key" });
    const exchanged = yield* auth.exchangeBootstrapCredentialForAccessToken(
      fresh.credential,
      undefined,
      metadata,
      { proofKeyThumbprint: "device-key" },
    );
    const sessions = yield* Sessions.SessionStore;
    expect((yield* sessions.verify(exchanged.access_token)).scopes).toContain(AuthHubProxyScope);
  }).pipe(Effect.provide(layer)),
);

it.effect("a hub generation advanced by another process denies issued privileges", () =>
  Effect.gen(function* () {
    const { settings, access } = yield* setup;
    yield* settings.updateSettings({ hub: { enabled: true, connectDevicesHubProxy: true } });
    const credential = {
      subject: "cloud-connect",
      scopes: [...AuthStandardClientScopes, AuthHubProxyScope],
      connectAccessGeneration: (yield* access.current).generation,
    };
    const denied = yield* access.awaitDenial(credential).pipe(Effect.forkChild);
    const sql = yield* SqlClient.SqlClient;
    // The CLI's offline unlink advances the durable generation from its own process.
    yield* sql`UPDATE hub_connect_access SET generation = generation + 1 WHERE id = 1`;
    yield* TestClock.adjust("5 seconds");
    yield* Fiber.join(denied);
    const current = yield* access.current;
    expect(Access.admits(credential, current)).toBe(false);
    expect(current.allowed).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a withdrawal fence written by another process denies issued privileges and recovers",
  () =>
    Effect.gen(function* () {
      const { settings, access } = yield* setup;
      yield* settings.updateSettings({ hub: { enabled: true, connectDevicesHubProxy: true } });
      const credential = {
        subject: "cloud-connect",
        scopes: [...AuthStandardClientScopes, AuthHubProxyScope],
        connectAccessGeneration: (yield* access.current).generation,
      };
      const denied = yield* access.awaitDenial(credential).pipe(Effect.forkChild);
      const fs = yield* FileSystem.FileSystem;
      const marker = `${(yield* Config.ServerConfig).stateDir}/connect-hub-access.fence`;
      // The other process persisted only the fence before its SQLite writes failed.
      yield* fs.writeFileString(marker, "withdrawn\n");
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(denied);
      yield* access.awaitRecovery;
      expect(Access.admits(credential, yield* access.current)).toBe(false);
      expect(yield* fs.exists(marker)).toBe(false);
    }).pipe(Effect.provide(layer)),
);

it.effect("a guarded media socket ends when Connect hub consent is withdrawn", () =>
  Effect.gen(function* () {
    const { settings, auth } = yield* setup;
    yield* settings.updateSettings({ hub: { enabled: true, connectDevicesHubProxy: true } });
    const session = yield* issuePrivileged;
    const authenticated = yield* auth.authenticateHttpRequest(request(session.token));
    const socket = yield* Lifetime.guard(authenticated, Effect.never).pipe(Effect.forkChild);
    yield* settings.updateSettings({ hub: { connectDevicesHubProxy: false } });
    expect((yield* Fiber.join(socket)).status).toBe(204);
  }).pipe(Effect.provide(layer)),
);

it.effect("an external withdrawal fence denies issued privileges while SQLite reads fail", () =>
  Effect.gen(function* () {
    const { settings, access } = yield* setup;
    yield* settings.updateSettings({ hub: { enabled: true, connectDevicesHubProxy: true } });
    const credential = {
      subject: "cloud-connect",
      scopes: [...AuthStandardClientScopes, AuthHubProxyScope],
      connectAccessGeneration: (yield* access.current).generation,
    };
    const denied = yield* access.awaitDenial(credential).pipe(Effect.forkChild);
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      `${(yield* Config.ServerConfig).stateDir}/connect-hub-access.fence`,
      "withdrawn\n",
    );
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DROP TABLE hub_connect_access`;
    yield* TestClock.adjust("5 seconds");
    yield* Fiber.join(denied);
    expect((yield* access.current).fenced).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect("a link-trust change commits together with the hub generation advance", () =>
  Effect.gen(function* () {
    const { access } = yield* setup;
    const before = (yield* access.current).generation;
    const sql = yield* SqlClient.SqlClient;
    // Another process reading mid-change must not see the replacement generation yet.
    const seen = yield* access.rotate(
      sql<{ generation: number }>`SELECT generation FROM hub_connect_access WHERE id = 1`,
    );
    expect(seen[0]?.generation).toBe(before);
    expect((yield* access.current).generation).toBe(before + 1);
  }).pipe(Effect.provide(layer)),
);

it.effect("hub disable preserves consent and invalidates unstamped legacy privileges", () =>
  Effect.gen(function* () {
    const { settings, sessions, auth } = yield* setup;
    yield* settings.updateSettings({ hub: { enabled: true, connectDevicesHubProxy: true } });
    const legacy = yield* sessions.issue({ subject: "cloud-connect", scopes: [AuthHubProxyScope] });
    expect(
      yield* auth.authenticateHttpRequest(request(legacy.token)).pipe(Effect.result),
    ).toMatchObject({ _tag: "Failure" });
    const privileged = yield* issuePrivileged;
    yield* settings.updateSettings({ hub: { enabled: false } });
    expect((yield* settings.getSettings).hub.connectDevicesHubProxy).toBe(true);
    yield* settings.updateSettings({ hub: { enabled: true } });
    expect(
      yield* auth.authenticateHttpRequest(request(privileged.token)).pipe(Effect.result),
    ).toMatchObject({ _tag: "Failure" });
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a failed generation write fences admission, blocks enable, and recovers without a settings edit",
  () =>
    Effect.gen(function* () {
      const { settings, access, auth } = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* Config.ServerConfig;
      yield* settings.updateSettings({ hub: { enabled: true, connectDevicesHubProxy: true } });
      const session = yield* issuePrivileged;
      const verified = yield* (yield* Sessions.SessionStore).verify(session.token);
      const stopped = yield* Deferred.make<void>();
      yield* access
        .awaitDenial(verified)
        .pipe(
          Effect.andThen(Deferred.succeed(stopped, undefined)),
          Effect.forkScoped({ startImmediately: true }),
        );
      yield* sql`CREATE TRIGGER fail_connect_bump BEFORE UPDATE ON hub_connect_access BEGIN SELECT RAISE(FAIL, 'injected write failure'); END`;
      expect(
        yield* settings
          .updateSettings({ hub: { connectDevicesHubProxy: false } })
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { _tag: "ServerSettingsError" } });
      yield* Deferred.await(stopped);
      expect(yield* access.current).toMatchObject({ allowed: false, fenced: true });
      expect(yield* fs.exists(`${config.stateDir}/connect-hub-access.fence`)).toBe(true);
      expect(
        yield* auth.authenticateHttpRequest(request(session.token)).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
      expect(
        yield* settings
          .updateSettings({ hub: { connectDevicesHubProxy: true } })
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
      yield* sql`DROP TRIGGER fail_connect_bump`;
      yield* TestClock.adjust("1 second");
      yield* SubscriptionRef.changes(access.state).pipe(
        Stream.filter((value) => !value.fenced),
        Stream.runHead,
      );
      expect((yield* access.current).fenced).toBe(false);
      expect(yield* fs.exists(`${config.stateDir}/connect-hub-access.fence`)).toBe(false);
      yield* settings.updateSettings({ hub: { connectDevicesHubProxy: true } });
      expect(
        yield* auth.authenticateHttpRequest(request(session.token)).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("mint after an in-flight enable receives the newly committed scope", () =>
  Effect.gen(function* () {
    const { access, auth } = yield* setup;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const commit = yield* access
      .commitPolicy(
        true,
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    const mint = yield* auth
      .createCloudConnectPairingLink({ proofKeyThumbprint: "device-key" })
      .pipe(Effect.forkScoped);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(commit);
    const grant = yield* Fiber.join(mint);
    const token = yield* auth.exchangeBootstrapCredentialForAccessToken(
      grant.credential,
      undefined,
      metadata,
      { proofKeyThumbprint: "device-key" },
    );
    expect(token.scope.split(" ")).toContain(AuthHubProxyScope);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect.each([
  ["mint", "credential"],
  ["mint", "withdrawal"],
  ["exchange", "credential"],
  ["exchange", "withdrawal"],
] as const)("%s versus withdrawal, %s acquires authority first", ([operation, first]) =>
  Effect.gen(function* () {
    const { settings, access, auth, grants, sessions } = yield* setup;
    const fs = yield* FileSystem.FileSystem;
    yield* settings.updateSettings({ hub: { enabled: true, connectDevicesHubProxy: true } });
    const policy = yield* access.current;
    const bootstrap = yield* grants.issueOneTimeToken({
      subject: "cloud-connect",
      scopes: [...AuthStandardClientScopes, AuthHubProxyScope],
      connectAccessGeneration: (yield* access.current).generation,
    });
    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const issuing = yield* Deferred.make<void>();
    const consuming = yield* Deferred.make<void>();
    const credentialCompleted = yield* Deferred.make<void>();
    const withdrawalCompleted = yield* Deferred.make<void>();
    const pause = Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release)));
    const issueGrant = grants.issueOneTimeToken;
    const issueSession = sessions.issue;
    const consume = grants.consume;
    const write = fs.writeFileString;
    using _grant = vi
      .spyOn(grants, "issueOneTimeToken")
      .mockImplementation((input) =>
        Deferred.succeed(issuing, undefined).pipe(
          Effect.andThen(operation === "mint" && first === "credential" ? pause : Effect.void),
          Effect.andThen(issueGrant(input)),
        ),
      );
    using _session = vi
      .spyOn(sessions, "issue")
      .mockImplementation((input) =>
        Deferred.succeed(issuing, undefined).pipe(
          Effect.andThen(operation === "exchange" && first === "credential" ? pause : Effect.void),
          Effect.andThen(issueSession(input)),
        ),
      );
    using _consume = vi
      .spyOn(grants, "consume")
      .mockImplementation((...args) =>
        Deferred.succeed(consuming, undefined).pipe(Effect.andThen(consume(...args))),
      );
    using _marker = vi
      .spyOn(fs, "writeFileString")
      .mockImplementation((file, ...args) =>
        (first === "withdrawal" && file.endsWith("connect-hub-access.fence.tmp")
          ? pause
          : Effect.void
        ).pipe(Effect.andThen(write(file, ...args))),
      );
    const credential = Effect.gen(function* () {
      if (operation === "mint")
        return {
          kind: "mint" as const,
          grant: yield* auth.createCloudConnectPairingLink({ proofKeyThumbprint: "device-key" }),
        };
      return {
        kind: "exchange" as const,
        token: yield* auth.exchangeBootstrapCredentialForAccessToken(
          bootstrap.credential,
          undefined,
          metadata,
        ),
      };
    }).pipe(Effect.onExit(() => Deferred.succeed(credentialCompleted, undefined)));
    const withdrawal = settings
      .updateSettings({ hub: { connectDevicesHubProxy: false } })
      .pipe(Effect.onExit(() => Deferred.succeed(withdrawalCompleted, undefined)));
    const attempted = yield* Deferred.make<void>();
    const tracer = Tracer.make({
      span: (options) => {
        if (
          options.name === "HubConnectAccess.withPolicy" ||
          options.name === "ConnectHubSettings.commit"
        )
          Deferred.doneUnsafe(attempted, Effect.void);
        return new Tracer.NativeSpan(options);
      },
    });
    if (first === "credential") {
      const pending = yield* credential.pipe(Effect.forkScoped);
      yield* Deferred.await(held);
      const off = yield* withdrawal.pipe(
        Effect.withTracer(tracer),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* Deferred.await(attempted);
      try {
        expect(yield* access.current).toEqual(policy);
        expect(yield* Deferred.isDone(withdrawalCompleted)).toBe(false);
        expect(yield* Deferred.isDone(credentialCompleted)).toBe(false);
      } finally {
        yield* Deferred.succeed(release, undefined);
      }
      const result = yield* Fiber.join(pending);
      yield* Fiber.join(off);
      if (result.kind === "mint") {
        expect(result.grant.scopes).toContain(AuthHubProxyScope);
        expect(
          yield* auth
            .exchangeBootstrapCredentialForAccessToken(
              result.grant.credential,
              undefined,
              metadata,
              { proofKeyThumbprint: "device-key" },
            )
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure" });
      } else {
        expect(result.token.scope.split(" ")).toContain(AuthHubProxyScope);
        expect(
          yield* auth
            .authenticateHttpRequest(request(result.token.access_token))
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure" });
      }
    } else {
      const off = yield* withdrawal.pipe(Effect.forkScoped);
      yield* Deferred.await(held);
      const pending = yield* credential.pipe(
        Effect.withTracer(tracer),
        Effect.result,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* Deferred.await(attempted);
      try {
        expect(yield* Deferred.isDone(consuming)).toBe(false);
        expect(yield* Deferred.isDone(issuing)).toBe(false);
        expect(yield* Deferred.isDone(credentialCompleted)).toBe(false);
        expect(yield* Deferred.isDone(withdrawalCompleted)).toBe(false);
        expect((yield* grants.listActive()).some((grant) => grant.id === bootstrap.id)).toBe(true);
        expect(yield* sessions.listActive()).toEqual([]);
        expect(yield* access.current).toEqual({ ...policy, allowed: false, fenced: true });
      } finally {
        yield* Deferred.succeed(release, undefined);
      }
      yield* Fiber.join(off);
      const result = yield* Fiber.join(pending);
      if (operation === "exchange") expect(result).toMatchObject({ _tag: "Failure" });
      else {
        if (result._tag !== "Success" || result.success.kind !== "mint")
          return yield* Effect.die("Expected standard Connect mint");
        expect(result.success.grant.scopes).toEqual(AuthStandardClientScopes);
        const token = yield* auth.exchangeBootstrapCredentialForAccessToken(
          result.success.grant.credential,
          undefined,
          metadata,
          { proofKeyThumbprint: "device-key" },
        );
        expect((yield* sessions.verify(token.access_token)).scopes).toEqual(
          AuthStandardClientScopes,
        );
      }
    }
    expect((yield* access.current).allowed).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "cancellation after settings rename cannot strand committed consent before policy publication",
  () =>
    Effect.gen(function* () {
      const { settings, access, auth } = yield* setup;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* Config.ServerConfig;
      yield* settings.updateSettings({ hub: { enabled: true, connectDevicesHubProxy: true } });
      const old = yield* issuePrivileged;
      yield* settings.updateSettings({ hub: { connectDevicesHubProxy: false } });
      const renamed = yield* Deferred.make<void>();
      const publish = yield* Deferred.make<void>();
      const rename = fs.rename;
      using _rename = vi
        .spyOn(fs, "rename")
        .mockImplementation((from, to) =>
          rename(from, to).pipe(
            Effect.tap(() =>
              to === config.settingsPath
                ? Deferred.succeed(renamed, undefined).pipe(Effect.andThen(Deferred.await(publish)))
                : Effect.void,
            ),
          ),
        );
      const update = yield* settings
        .updateSettings({ hub: { connectDevicesHubProxy: true } })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(renamed);
      expect(
        JSON.parse(yield* fs.readFileString(config.settingsPath)).hub.connectDevicesHubProxy,
      ).toBe(true);
      expect((yield* access.current).allowed).toBe(false);
      const cancellation = yield* Fiber.interrupt(update).pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* Deferred.succeed(publish, undefined);
      yield* Fiber.join(cancellation);
      expect((yield* settings.getSettings).hub.connectDevicesHubProxy).toBe(true);
      expect((yield* access.current).allowed).toBe(true);
      expect(
        yield* auth.authenticateHttpRequest(request(old.token)).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
      expect(
        (yield* auth.createCloudConnectPairingLink({ proofKeyThumbprint: "device-key" })).scopes,
      ).toContain(AuthHubProxyScope);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("generic issuance cannot bypass coordinated Connect hub authorization", () =>
  Effect.gen(function* () {
    const { auth } = yield* setup;
    const input = { subject: "cloud-connect", scopes: [AuthHubProxyScope] };
    expect(yield* auth.createPairingLink(input).pipe(Effect.result)).toMatchObject({
      _tag: "Failure",
    });
    expect(yield* auth.issueSession(input).pipe(Effect.result)).toMatchObject({ _tag: "Failure" });
  }).pipe(Effect.provide(layer)),
);

const openServer = Effect.fn("test.openConnectServer")(function* (fs?: FileSystem.FileSystem) {
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
  const context = yield* Layer.buildWithScope(Layer.fresh(services), scope).pipe((build) =>
    fs === undefined ? build : build.pipe(Effect.provideService(FileSystem.FileSystem, fs)),
  );
  return {
    scope,
    settings: Context.get(context, Settings.ServerSettingsService),
    access: Context.get(context, Access.HubConnectAccess),
    auth: Context.get(context, Auth.EnvironmentAuth),
    sessions: Context.get(context, Sessions.SessionStore),
  };
});

it.effect(
  "fenced startup waits for recovery, retains disk edits, installs its watcher, and cancels the old recovery worker",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* Config.ServerConfig;
      const stopped = yield* Deferred.make<void>();
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (...args) => {
            end(...args);
            if (span.name === "HubConnectAccess.recover") Deferred.doneUnsafe(stopped, Effect.void);
          };
          return span;
        },
      });
      const first = yield* openServer().pipe(Effect.withTracer(tracer));
      yield* first.settings.start;
      yield* first.settings.updateSettings({
        hub: { enabled: true, connectDevicesHubProxy: true },
      });
      const old = yield* first.sessions.issue({
        subject: "cloud-connect",
        scopes: [AuthHubProxyScope],
        connectAccessGeneration: (yield* first.access.current).generation,
      });
      yield* sql`CREATE TRIGGER fail_connect_bump BEFORE UPDATE ON hub_connect_access BEGIN SELECT RAISE(FAIL, 'injected write failure'); END`;
      yield* first.settings
        .updateSettings({ hub: { connectDevicesHubProxy: false } })
        .pipe(Effect.result);
      yield* Scope.close(first.scope, Exit.void);
      yield* Deferred.await(stopped);
      const before = yield* sql`SELECT generation FROM hub_connect_access`;
      yield* TestClock.adjust("1 minute");
      expect(yield* sql`SELECT generation FROM hub_connect_access`).toEqual(before);
      const events = yield* PubSub.unbounded<{
        event: FileSystem.WatchEvent;
        seen: Deferred.Deferred<void>;
      }>();
      const watching = yield* Deferred.make<void>();
      const controlled = {
        ...fs,
        watch: (_directory: string, options?: FileSystem.WatchOptions) =>
          Stream.unwrap(
            PubSub.subscribe(events).pipe(
              Effect.tap(() => Effect.sync(() => options?.onReady?.())),
              Effect.tap(() => Deferred.succeed(watching, undefined)),
              Effect.map((subscription) =>
                Stream.fromSubscription(subscription).pipe(
                  Stream.tap(({ seen }) => Deferred.succeed(seen, undefined)),
                  Stream.map(({ event }) => event),
                ),
              ),
            ),
          ),
      };
      const second = yield* openServer(controlled);
      expect(yield* second.access.current).toMatchObject({ allowed: false, fenced: true });
      expect(
        yield* second.auth.authenticateHttpRequest(request(old.token)).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
      const waiting = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      const startupTracer = Tracer.make({
        span: (options) => {
          if (options.name === "HubConnectAccess.awaitRecovery")
            Deferred.doneUnsafe(waiting, Effect.void);
          return new Tracer.NativeSpan(options);
        },
      });
      const startup = yield* second.settings.start.pipe(
        Effect.tap(() => Deferred.succeed(ready, undefined)),
        Effect.withTracer(startupTracer),
        Effect.forkScoped,
      );
      yield* Deferred.await(waiting);
      expect(yield* Deferred.isDone(ready)).toBe(false);
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({
          hub: { enabled: true, connectDevicesHubProxy: true },
          enableProviderUpdateChecks: false,
        }),
      );
      yield* sql`DROP TRIGGER fail_connect_bump`;
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(startup);
      expect(yield* second.access.current).toMatchObject({ allowed: true, fenced: false });
      expect((yield* second.settings.getSettings).enableProviderUpdateChecks).toBe(false);
      expect(
        yield* second.auth.authenticateHttpRequest(request(old.token)).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
      yield* Deferred.await(watching);
      const changes = yield* second.settings.subscribeChanges;
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({ hub: { enabled: true, connectDevicesHubProxy: false } }),
      );
      const seen = yield* Deferred.make<void>();
      yield* PubSub.publish(events, {
        event: { _tag: "Update" as const, path: config.settingsPath },
        seen,
      });
      yield* Deferred.await(seen);
      yield* TestClock.adjust(100);
      expect(Option.getOrThrow(yield* Stream.runHead(changes)).hub.connectDevicesHubProxy).toBe(
        false,
      );
      yield* Scope.close(second.scope, Exit.void);
    }).pipe(Effect.scoped, Effect.provide(storage)),
);

it.effect("a failed marker write still commits the independent SQLite withdrawal", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const faulty = {
      ...fs,
      writeFileString: (
        file: string,
        ...args: Parameters<typeof fs.writeFileString> extends [string, ...infer Rest]
          ? Rest
          : never
      ) =>
        file.endsWith("connect-hub-access.fence.tmp")
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "writeFileString",
                pathOrDescriptor: file,
              }),
            )
          : fs.writeFileString(file, ...args),
    };
    const server = yield* openServer(faulty);
    yield* server.settings.start;
    yield* server.settings.updateSettings({ hub: { enabled: true, connectDevicesHubProxy: true } });
    const before = yield* server.access.current;
    yield* server.settings.updateSettings({ hub: { connectDevicesHubProxy: false } });
    expect((yield* server.access.current).generation).toBeGreaterThan(before.generation);
    expect(yield* server.access.current).toMatchObject({ allowed: false, fenced: false });
    yield* Scope.close(server.scope, Exit.void);
  }).pipe(Effect.scoped, Effect.provide(storage)),
);

it.effect("marker removal failure and double write failure keep live denial until recovery", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const sql = yield* SqlClient.SqlClient;
    let markerFails = false;
    let removalFails = false;
    const failure = (file: string) =>
      PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "writeFileString",
        pathOrDescriptor: file,
      });
    const faulty = {
      ...fs,
      writeFileString: (
        file: string,
        ...args: Parameters<typeof fs.writeFileString> extends [string, ...infer Rest]
          ? Rest
          : never
      ) =>
        markerFails && file.endsWith("connect-hub-access.fence.tmp")
          ? Effect.fail(failure(file))
          : fs.writeFileString(file, ...args),
      remove: (file: string, options?: Parameters<typeof fs.remove>[1]) =>
        removalFails && file.endsWith("connect-hub-access.fence")
          ? Effect.fail(failure(file))
          : fs.remove(file, options),
    };
    const server = yield* openServer(faulty);
    yield* server.settings.start;
    for (const doubleFailure of [false, true]) {
      yield* server.settings.updateSettings({
        hub: { enabled: true, connectDevicesHubProxy: true },
      });
      const token = yield* server.sessions.issue({
        subject: "cloud-connect",
        scopes: ["hub:proxy"],
        connectAccessGeneration: (yield* server.access.current).generation,
      });
      const credential = yield* server.sessions.verify(token.token);
      const stopped = yield* Deferred.make<void>();
      yield* server.access
        .awaitDenial(credential)
        .pipe(
          Effect.andThen(Deferred.succeed(stopped, undefined)),
          Effect.forkScoped({ startImmediately: true }),
        );
      markerFails = doubleFailure;
      removalFails = !doubleFailure;
      if (doubleFailure)
        yield* sql`CREATE TRIGGER fail_connect_bump BEFORE UPDATE ON hub_connect_access BEGIN SELECT RAISE(FAIL, 'injected write failure'); END`;
      expect(
        yield* server.settings
          .updateSettings({ hub: { connectDevicesHubProxy: false } })
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
      yield* Deferred.await(stopped);
      expect(yield* server.access.current).toMatchObject({ allowed: false, fenced: true });
      expect(
        yield* server.auth.authenticateHttpRequest(request(token.token)).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
      markerFails = false;
      removalFails = false;
      if (doubleFailure) yield* sql`DROP TRIGGER fail_connect_bump`;
      yield* TestClock.adjust("1 second");
      yield* SubscriptionRef.changes(server.access.state).pipe(
        Stream.filter((value) => !value.fenced),
        Stream.runHead,
      );
      yield* server.settings.updateSettings({ hub: { connectDevicesHubProxy: true } });
      expect(
        yield* server.auth.authenticateHttpRequest(request(token.token)).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
    }
    yield* Scope.close(server.scope, Exit.void);
  }).pipe(Effect.scoped, Effect.provide(storage)),
);

it.effect(
  "a stamped keyless Connect bootstrap carries its generation through browser exchange",
  () =>
    Effect.gen(function* () {
      const { settings, auth, sessions, grants, access } = yield* setup;
      yield* settings.updateSettings({ hub: { enabled: true, connectDevicesHubProxy: true } });
      const generation = (yield* access.current).generation;
      const grant = yield* grants.issueOneTimeToken({
        subject: "cloud-connect",
        scopes: ["hub:proxy"],
        connectAccessGeneration: generation,
      });
      const browser = yield* auth.createBrowserSession(grant.credential, { deviceType: "mobile" });
      expect((yield* sessions.verify(browser.sessionToken)).connectAccessGeneration).toBe(
        generation,
      );
      yield* settings.updateSettings({ hub: { connectDevicesHubProxy: false } });
      expect(
        yield* auth.authenticateHttpRequest(request(browser.sessionToken)).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
    }).pipe(Effect.provide(layer)),
);

it.effect("Connect hub media tickets remain bearer capabilities but cannot open RPC sockets", () =>
  Effect.gen(function* () {
    const { settings, auth, sessions } = yield* setup;
    yield* settings.updateSettings({ hub: { enabled: true, connectDevicesHubProxy: true } });
    const grant = yield* auth.createCloudConnectPairingLink({ proofKeyThumbprint: "device-key" });
    const token = yield* auth.exchangeBootstrapCredentialForAccessToken(
      grant.credential,
      undefined,
      { deviceType: "mobile" },
      { proofKeyThumbprint: "device-key" },
    );
    const verified = yield* sessions.verify(token.access_token);
    const ticket = yield* auth.issueWebSocketTicket(verified);
    const request = HttpServerRequest.fromWeb(
      new Request(`http://hub.test/ws?wsTicket=${encodeURIComponent(ticket.ticket)}`),
    );
    expect(
      yield* auth.authenticateWebSocketUpgrade(request, "rpc").pipe(Effect.result),
    ).toMatchObject({ _tag: "Failure", failure: { _tag: "ServerAuthInvalidCredentialError" } });
    expect((yield* auth.authenticateWebSocketUpgrade(request, "media")).sessionId).toBe(
      verified.sessionId,
    );
  }).pipe(Effect.provide(layer)),
);
