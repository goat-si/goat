import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as NetService from "@goat/shared/Net";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import * as SshAuth from "./auth.ts";
import * as SshTunnel from "./tunnel.ts";
import {
  ARCHIVE,
  commandArgs,
  makeDelayedSuccessfulProcess,
  makeProtocolTestSpawner,
  makeRunningProcess,
  makeSuccessfulProcess,
  testNetService,
  uploadTarget,
} from "./tunnel.fixture.ts";

// Each new SSH connection to the host costs this long, like a Cloudflare Access ProxyCommand.
const CONNECT_MS = 7_000;
const OWNER = EnvironmentId.make("managed-owner");

const descriptor = (environmentId: string) =>
  JSON.stringify({
    environmentId,
    serverVersion: ARCHIVE.archiveVersion,
    sshRuntimeProtocolVersion: SSH_RUNTIME_PROTOCOL_VERSION,
    orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
    capabilities: { runtimeSessions: true },
  });

const noAskpassFileSystem = FileSystem.makeNoop({
  makeTempDirectoryScoped: () => Effect.succeed("/goat-ssh-runtime-test"),
  makeDirectory: () => Effect.void,
  exists: () => Effect.succeed(false),
  writeFileString: () => Effect.void,
  chmod: () => Effect.void,
});

const advance = (total: Duration.Duration) =>
  Effect.gen(function* () {
    for (let elapsed = 0; elapsed < Duration.toMillis(total); elapsed += 100) {
      yield* TestClock.adjust(Duration.millis(100));
    }
  });

/** A host whose managed GOAT server owns OWNER; the app server is absent. */
const makeHost = () => {
  const host = { connections: 0, served: OWNER as string, onDisk: OWNER as string };
  const spawner = makeProtocolTestSpawner((command) =>
    Effect.gen(function* () {
      const args = commandArgs(command);
      if (args.includes("-G")) return makeSuccessfulProcess("hostname devbox.example.com\n");
      host.connections++;
      if (args.includes("-N")) return makeRunningProcess(() => {});
      const stdin = command._tag === "StandardCommand" ? command.options.stdin : undefined;
      const bytes =
        typeof stdin === "object" && "stream" in stdin && Stream.isStream(stdin.stream)
          ? yield* stdin.stream.pipe(Stream.runCollect)
          : [];
      const script = new TextDecoder().decode(
        new Uint8Array(bytes.flatMap((chunk) => Array.from(chunk))),
      );
      if (args.includes("goat-existing-server-probe"))
        return makeDelayedSuccessfulProcess(
          script.includes("try_app_home")
            ? "GOAT_EXISTING=absent\n"
            : `GOAT_EXISTING=live 3773 ${host.onDisk}\n${descriptor(host.served)}\n`,
          CONNECT_MS,
        );
      if (args.includes("goat-app-server-credential"))
        return makeDelayedSuccessfulProcess(
          '{"token":"owner-session","expiresAt":null}\nGOAT_HTTP_STATUS=200\n',
          CONNECT_MS,
        );
      return makeSuccessfulProcess("");
    }),
  );
  const httpClient = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        request.url.endsWith("/.well-known/goat/environment")
          ? new Response(descriptor(host.served))
          : new Response("", { status: 200 }),
      ),
    ),
  );
  let localPort = 41_773;
  const layer = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(FileSystem.FileSystem, noAskpassFileSystem),
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Layer.succeed(HttpClient.HttpClient, httpClient),
    Layer.succeed(
      NetService.NetService,
      NetService.NetService.of({
        ...testNetService,
        reserveLoopbackPort: () => Effect.sync(() => localPort++),
      }),
    ),
    SshAuth.SshPasswordPrompt.disabledLayer,
  ).pipe((base) =>
    SshTunnel.SshEnvironmentManager.layer({
      resolveCliRunner: Effect.succeed(ARCHIVE),
      leaveRemoteServerRunning: true,
    }).pipe(Layer.provideMerge(base)),
  );
  /** Runs one call and returns how many new SSH connections it opened. */
  const call = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const before = host.connections;
      const fiber = yield* Effect.forkChild(Effect.result(effect));
      yield* advance(Duration.seconds(60));
      const result = yield* Fiber.join(fiber);
      return { result, connections: host.connections - before };
    });
  return { host, layer, call };
};

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH routes to an existing environment",
  () => {
    it.effect(
      "a warm route opens no SSH connection per call, and a session opens only its own",
      () =>
        Effect.gen(function* () {
          const { layer, call } = makeHost();
          yield* Effect.gen(function* () {
            const manager = yield* SshTunnel.SshEnvironmentManager;
            const route = () => manager.existingEnvironment!(uploadTarget, OWNER);
            const cold = yield* call(route());
            assert.isTrue(Result.isSuccess(cold.result));
            // App probe, managed probe, and the forward itself.
            assert.equal(cold.connections, 3);

            const warm = yield* call(route());
            assert.isTrue(Result.isSuccess(warm.result));
            if (Result.isSuccess(warm.result) && Result.isSuccess(cold.result))
              assert.equal(warm.result.success.httpBaseUrl, cold.result.success.httpBaseUrl);
            assert.equal(warm.connections, 0);

            const session = yield* call(
              manager.issueExistingMcpSession!(uploadTarget, OWNER, {
                label: "hub",
                ttl: "1h",
                runtimeModeCeiling: "full-access",
              }),
            );
            assert.isTrue(Result.isSuccess(session.result));
            if (Result.isSuccess(session.result))
              assert.equal(session.result.success.token, "owner-session");
            // Only the credential request, which the host checks against OWNER itself.
            assert.equal(session.connections, 1);
          }).pipe(Effect.provide(layer), Effect.scoped);
        }),
    );

    it.effect("rechecks ownership on disk over one connection once the window passes", () =>
      Effect.gen(function* () {
        const { host, layer, call } = makeHost();
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          const route = () => manager.existingEnvironment!(uploadTarget, OWNER);
          assert.isTrue(Result.isSuccess((yield* call(route())).result));
          yield* TestClock.adjust(Duration.minutes(5));
          const recheck = yield* call(route());
          assert.isTrue(Result.isSuccess(recheck.result));
          // The owner was managed last time, so only the managed probe runs.
          assert.equal(recheck.connections, 1);

          host.onDisk = "replaced-owner";
          yield* TestClock.adjust(Duration.minutes(5));
          const replaced = yield* call(route());
          assert.isTrue(Result.isFailure(replaced.result));
        }).pipe(Effect.provide(layer), Effect.scoped);
      }),
    );

    it.effect("a forward that now answers for another environment is not reused", () =>
      Effect.gen(function* () {
        const { host, layer, call } = makeHost();
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          const route = () => manager.existingEnvironment!(uploadTarget, OWNER);
          assert.isTrue(Result.isSuccess((yield* call(route())).result));
          host.served = "replaced-owner";
          host.onDisk = "replaced-owner";
          const after = yield* call(route());
          assert.isTrue(Result.isFailure(after.result));
          assert.equal(after.connections, 2);
        }).pipe(Effect.provide(layer), Effect.scoped);
      }),
    );
  },
);
