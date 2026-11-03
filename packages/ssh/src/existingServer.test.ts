import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId, EnvironmentId, ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as NetService from "@goat/shared/Net";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import * as Deferred from "effect/Deferred";
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
  const host = {
    connections: 0,
    // What the host's own curl sees (the strict probe) and what an open forward reaches.
    served: OWNER as string,
    // What each open forward reaches, by local port, when it differs from `served`.
    forwardServed: new Map<number, string>(),
    nextForwardServes: undefined as string | undefined,
    onDisk: OWNER as string,
    forwardsKilled: 0,
    // Holds the next identity read through a forward until released.
    hold: undefined as
      | { readonly entered: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
      | undefined,
  };
  const spawner = makeProtocolTestSpawner((command) =>
    Effect.gen(function* () {
      const args = commandArgs(command);
      if (args.includes("-G")) return makeSuccessfulProcess("hostname devbox.example.com\n");
      host.connections++;
      if (args.includes("-N")) {
        const localPort = Number(args[args.indexOf("-L") + 1]?.split(":")[0]);
        if (host.nextForwardServes !== undefined)
          host.forwardServed.set(localPort, host.nextForwardServes);
        return makeRunningProcess(() => {
          host.forwardsKilled++;
        });
      }
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
          `${script.includes('"revoke"') ? '{"sessionId":"owner-session-id","revoked":true}' : '{"token":"owner-session","expiresAt":null}'}\nGOAT_HTTP_STATUS=200\n`,
          CONNECT_MS,
        );
      return makeSuccessfulProcess("");
    }),
  );
  const httpClient = HttpClient.make((request) =>
    Effect.gen(function* () {
      if (!request.url.endsWith("/.well-known/goat/environment"))
        return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
      const hold = host.hold;
      host.hold = undefined;
      if (hold !== undefined) {
        yield* Deferred.succeed(hold.entered, undefined);
        yield* Deferred.await(hold.release);
      }
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          descriptor(host.forwardServed.get(Number(new URL(request.url).port)) ?? host.served),
        ),
      );
    }),
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

            const revoked = yield* call(
              manager.revokeExistingMcpSession!(
                uploadTarget,
                OWNER,
                AuthSessionId.make("owner-session-id"),
              ),
            );

            assert.deepEqual(revoked.result, Result.succeed(true));

            assert.equal(revoked.connections, 1);
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
    it.effect("a forward that fails its identity check is replaced even when ownership holds", () =>
      Effect.gen(function* () {
        const { host, layer, call } = makeHost();
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          const route = () => manager.existingEnvironment!(uploadTarget, OWNER);
          const cold = yield* call(route());
          // The open forward still reaches an old backend; a fresh SSH session sees the owner.
          if (Result.isSuccess(cold.result))
            host.forwardServed.set(
              Number(new URL(cold.result.success.httpBaseUrl).port),
              "old-backend",
            );
          const after = yield* call(route());
          assert.isTrue(Result.isSuccess(after.result));
          if (Result.isSuccess(after.result) && Result.isSuccess(cold.result))
            assert.notEqual(after.result.success.httpBaseUrl, cold.result.success.httpBaseUrl);
          // The managed probe and a new forward; the failed forward is closed.
          assert.equal(after.connections, 2);
          assert.equal(host.forwardsKilled, 1);
        }).pipe(Effect.provide(layer), Effect.scoped);
      }),
    );

    it.effect("a route torn down while its forward answers is not returned", () =>
      Effect.gen(function* () {
        const { host, layer, call } = makeHost();
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          const route = () => manager.existingEnvironment!(uploadTarget, OWNER);
          const cold = yield* call(route());
          const hold = {
            entered: yield* Deferred.make<void>(),
            release: yield* Deferred.make<void>(),
          };
          host.hold = hold;
          const pending = yield* Effect.forkChild(Effect.result(route()));
          yield* Deferred.await(hold.entered);
          yield* manager.disconnectEnvironment(uploadTarget);
          assert.equal(host.forwardsKilled, 1);
          yield* Deferred.succeed(hold.release, undefined);
          yield* advance(Duration.seconds(60));
          const after = yield* Fiber.join(pending);
          assert.isTrue(Result.isSuccess(after));
          if (Result.isSuccess(after) && Result.isSuccess(cold.result))
            assert.notEqual(after.success.httpBaseUrl, cold.result.success.httpBaseUrl);
        }).pipe(Effect.provide(layer), Effect.scoped);
      }),
    );
    it.effect("a new forward that reaches another environment fails closed", () =>
      Effect.gen(function* () {
        const { host, layer, call } = makeHost();
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          host.nextForwardServes = "other-backend";
          const first = yield* call(manager.existingEnvironment!(uploadTarget, OWNER));
          assert.isTrue(Result.isFailure(first.result));
          assert.equal(host.forwardsKilled, 1);
          const session = yield* call(
            manager.issueExistingMcpSession!(uploadTarget, OWNER, {
              label: "hub",
              ttl: "1h",
              runtimeModeCeiling: "full-access",
            }),
          );
          // Both probes and another forward, but no credential request.
          assert.isTrue(Result.isFailure(session.result));
          assert.equal(session.connections, 3);
        }).pipe(Effect.provide(layer), Effect.scoped);
      }),
    );
    it.effect("concurrent calls on a cold or expired route share one ownership check", () =>
      Effect.gen(function* () {
        const { layer, call } = makeHost();
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          const route = () => manager.existingEnvironment!(uploadTarget, OWNER);
          const both = () => Effect.all([route(), route()], { concurrency: "unbounded" });
          const cold = yield* call(both());
          assert.isTrue(Result.isSuccess(cold.result));
          // One app probe, one managed probe, and one forward for both callers.
          assert.equal(cold.connections, 3);
          yield* TestClock.adjust(Duration.minutes(5));
          const expired = yield* call(both());
          assert.isTrue(Result.isSuccess(expired.result));
          assert.equal(expired.connections, 1);
        }).pipe(Effect.provide(layer), Effect.scoped);
      }),
    );
  },
);
