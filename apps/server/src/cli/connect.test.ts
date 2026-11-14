// @effect-diagnostics nodeBuiltinImport:off -- The unlink test exercises a local HTTP listener.
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { AuthSessionId, EnvironmentId } from "@goat/contracts";
import { guardErrors } from "@goat/shared/errorGuards";
import * as DateTime from "effect/DateTime";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as CliTokenManager from "../cloud/CliTokenManager.ts";
import { CLOUD_LINKED_USER_ID, CLOUD_WITHDRAWAL_FENCE } from "../cloud/config.ts";
import { assert, it } from "@effect/vitest";
import * as RelayClient from "@goat/shared/relayClient";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command } from "effect/cli";
import * as TestConsole from "effect/testing/TestConsole";
import * as FileSystem from "effect/FileSystem";
import * as NetService from "@goat/shared/Net";
import {
  connectCommand,
  acquireRelayClientForLink,
  disconnectCloud,
  checkLiveReachability,
} from "./connect.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";

const managedExecutable = {
  status: "available",
  executablePath: "/tmp/cloudflared",
  source: "managed",
  version: RelayClient.CLOUDFLARED_VERSION,
} as const;

it.effect("does not install the relay client when the user declines the managed download", () =>
  Effect.gen(function* () {
    let installCalls = 0;
    const result = yield* acquireRelayClientForLink(
      {
        resolve: Effect.succeed({
          status: "missing",
          version: RelayClient.CLOUDFLARED_VERSION,
        }),
        install: Effect.sync(() => {
          installCalls += 1;
          return managedExecutable;
        }),
        installWithProgress: () =>
          Effect.sync(() => {
            installCalls += 1;
            return managedExecutable;
          }),
        pruneManagedVersions: Effect.void,
      },
      () => Effect.succeed(false),
      () => Effect.void,
    );

    assert.isTrue(Option.isNone(result));
    assert.equal(installCalls, 0);
  }),
);

it.live.each([false, true])(
  "unlink contacts the recorded server only when its process is alive: %s",
  (alive) =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const warnings: string[] = [];
      const values = new Map<string, Uint8Array>([
        [CLOUD_LINKED_USER_ID, new TextEncoder().encode("user-1")],
      ]);
      const listener = yield* Effect.acquireRelease(
        Effect.callback<NodeHttp.Server, Error>((resume) => {
          const server = guardErrors(
            NodeHttp.createServer((request, response) => {
              requests.push(`${request.method} ${request.url}`);
              response.writeHead(200, { "content-type": "application/json" });
              response.end(JSON.stringify({ ok: true, endpointRuntimeStatus: null }));
            }),
            (error) => resume(Effect.fail(error)),
          );
          server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
        }),
        (server) => Effect.sync(() => server.close()),
      );
      const address = listener.address();
      if (address === null || typeof address === "string") {
        return yield* Effect.die(new Error("Expected a TCP address"));
      }
      const config = yield* ServerConfig.ServerConfig;
      const state = yield* makePersistedServerRuntimeState({
        config: { host: "127.0.0.1", devUrl: undefined },
        port: address.port,
      });
      yield* persistServerRuntimeState({
        path: config.serverRuntimeStatePath,
        state: { ...state, pid: alive ? process.pid : 4_194_305 },
      });
      const console = yield* Console.Console;
      yield* disconnectCloud({ clearAuthorization: false }).pipe(
        Effect.provideService(Console.Console, {
          ...console,
          warn: (...args) => warnings.push(args.join(" ")),
        }),
        Effect.provideService(ServerSecretStore.ServerSecretStore, {
          get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
          set: (name, value) => Effect.sync(() => void values.set(name, value)),
          remove: (name) => Effect.sync(() => void values.delete(name)),
          create: () => Effect.die("unused"),
          getOrCreateRandom: () => Effect.die("unused"),
        }),
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(CliTokenManager.CloudCliTokenManager, { getExisting: Effect.succeedNone }),
            Layer.mock(EnvironmentAuth.EnvironmentAuth, {
              setCloudLinkTrust: () => Effect.void,
              issueSession: () =>
                Effect.succeed({
                  sessionId: AuthSessionId.make("test-session"),
                  token: "test-token",
                  method: "bearer-access-token" as const,
                  scopes: [],
                  subject: "cloud-cli",
                  client: { deviceType: "unknown" as const },
                  expiresAt: DateTime.makeUnsafe("2030-01-01T00:00:00Z"),
                }),
              revokeSession: () => Effect.succeed(true),
            }),
          ),
        ),
        Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-1")),
        }),
      );
      if (alive) {
        assert.deepEqual(requests, ["POST /api/connect/unlink"]);
        assert.isFalse(values.has(CLOUD_LINKED_USER_ID));
        assert.notInclude(warnings.join("\n"), "cloudflared process may still be running");
      } else {
        assert.deepEqual(requests, []);
        assert.isTrue(values.has(CLOUD_LINKED_USER_ID));
        assert.equal(new TextDecoder().decode(values.get(CLOUD_WITHDRAWAL_FENCE)), "pending");
        assert.include(warnings.join("\n"), "cloudflared process may still be running");
        assert.include(warnings.join("\n"), "before relinking");
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          FetchHttpClient.layer,
          ServerConfig.layerTest("/", { prefix: "goat-connect-unlink-test-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    ),
);

it.effect.each(["credential-failure", "pending-delete"] as const)(
  "logout removes CLI authorization and fences retained link trust during %s",
  (mode) =>
    Effect.gen(function* () {
      const values = new Map<string, Uint8Array>([
        ["cloud-cli-desired-link", new TextEncoder().encode("managed")],
        [CLOUD_LINKED_USER_ID, new TextEncoder().encode("user-1")],
        ["cloud-cli-oauth-token", new TextEncoder().encode("cached-oauth")],
      ]);
      const pendingLink = new Map([
        [CLOUD_LINKED_USER_ID, new TextEncoder().encode("user-1")],
        [CLOUD_WITHDRAWAL_FENCE, new TextEncoder().encode("pending")],
      ]);
      let cleared = false;
      const warnings: string[] = [];
      const console = yield* Console.Console;
      const started = yield* Deferred.make<void>();
      const program = disconnectCloud({ clearAuthorization: true }).pipe(
        Effect.provideService(Console.Console, {
          ...console,
          warn: (...args) => {
            warnings.push(args.join(" "));
          },
        }),
        Effect.provideService(ServerSecretStore.ServerSecretStore, {
          get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
          set: (name, value) =>
            Effect.sync(() => {
              values.set(name, value);
            }),
          remove: (name) =>
            Effect.sync(() => {
              values.delete(name);
            }),
          create: () => Effect.die("unused"),
          getOrCreateRandom: () => Effect.die("unused"),
        }),
        Effect.provideService(CliTokenManager.CloudCliTokenManager, {
          approveLink: () => Effect.die("logout must not request approval"),
          get: Effect.die("unused"),
          getExisting:
            mode === "credential-failure"
              ? Effect.fail(
                  new CliTokenManager.CloudCliCredentialRefreshError({
                    cause: "provider unavailable",
                  }),
                )
              : Effect.succeedSome({
                  accessToken: "cached-oauth",
                  refreshToken: "refresh",
                  expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
                }),
          hasCredential: Effect.succeed(true),
          store: () => Effect.die("unused"),
          clear: Effect.sync(() => {
            values.delete("cloud-cli-oauth-token");
            cleared = true;
          }),
        }),
        Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-1")),
        }),
        Effect.provide(
          Layer.mock(EnvironmentAuth.EnvironmentAuth, { setCloudLinkTrust: () => Effect.void }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        ),
      );
      const fiber = yield* program.pipe(Effect.forkChild);
      if (mode === "pending-delete") {
        yield* Deferred.await(started);
        assert.isTrue(cleared);
        assert.isFalse(values.has("cloud-cli-oauth-token"));
        assert.deepEqual(values, pendingLink);
        yield* TestClock.adjust("5 seconds");
      }
      yield* Fiber.join(fiber);
      assert.include(warnings.join("\n"), "Remote revocation pending");
      assert.include(warnings.join("\n"), "goat connect login, then goat connect unlink");
      assert.isTrue(cleared);
      assert.isFalse(values.has("cloud-cli-oauth-token"));
      assert.deepEqual(values, pendingLink);
      assert.include(warnings.join("\n"), "before relinking");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: { GOAT_RELAY_URL: "https://relay.example.test" } }),
          ),
          ServerConfig.layerTest("/", { prefix: "goat-connect-logout-test-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
      Effect.scoped,
    ),
);

it.effect.each([{ args: ["publish"] }, { args: ["link", "--publish-only"] }])(
  "publishing command %j reports the reachability-only beta without promising startup authorization",
  ({ args }) =>
    Effect.gen(function* () {
      const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "connect-publishing-",
      });
      yield* Command.runWith(connectCommand, { version: "0.0.0" })([
        ...args,
        "--base-dir",
        directory,
      ]);
      const output = (yield* TestConsole.errorLines).join("\n");
      assert.include(output, "unavailable in the reachability-only Connect beta");
      assert.notInclude(
        (yield* TestConsole.logLines).join("\n"),
        "Restart GOAT to finish authorizing",
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NetService.layer,
          TestConsole.layer,
          // The test's own shell may be an SSH session; this case is a local one.
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
        ),
      ),
      Effect.scoped,
    ),
);

it.effect.each([{ SSH_CONNECTION: "203.0.113.1 50000 203.0.113.2 22" }, { SSH_TTY: "/dev/pts/0" }])(
  "link from an SSH session %j refuses before asking for a browser approval",
  (env) =>
    Effect.gen(function* () {
      const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "connect-ssh-",
      });
      const error = yield* Command.runWith(connectCommand, { version: "0.0.0" })([
        "link",
        "--publish-only",
        "--base-dir",
        directory,
      ]).pipe(Effect.flip);
      assert.instanceOf(error, CliTokenManager.CloudCliAuthorizationUnsupportedError);
      assert.notInclude(
        (yield* TestConsole.errorLines).join("\n"),
        "unavailable in the reachability-only Connect beta",
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NetService.layer,
          TestConsole.layer,
          ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
        ),
      ),
      Effect.scoped,
    ),
);

it.effect.each([false, true])(
  "reachability sends credentials only to a living server: %s",
  (alive) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const state = yield* makePersistedServerRuntimeState({
        config: { host: "127.0.0.1", devUrl: undefined },
        port: 3773,
      });
      yield* persistServerRuntimeState({
        path: config.serverRuntimeStatePath,
        state: { ...state, pid: alive ? process.pid : 4_194_305 },
      });
      let requests = 0;
      let issued = 0;
      yield* checkLiveReachability().pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            requests++;
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("unavailable", { status: 503 })),
            );
          }),
        ),
        Effect.provide(
          Layer.mock(EnvironmentAuth.EnvironmentAuth, {
            issueSession: () => {
              issued++;
              return Effect.succeed({
                sessionId: AuthSessionId.make("test-session"),
                token: "test-token",
                method: "bearer-access-token" as const,
                scopes: [],
                subject: "cloud-cli",
                client: { deviceType: "unknown" as const },
                expiresAt: DateTime.makeUnsafe("2030-01-01T00:00:00Z"),
              });
            },
            revokeSession: () => Effect.succeed(true),
          }),
        ),
      );
      assert.equal(requests, alive ? 1 : 0);
      assert.equal(issued, alive ? 1 : 0);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerConfig.layerTest("/", { prefix: "goat-connect-live-test-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);
