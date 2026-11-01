import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@goat/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as SshAuth from "./auth.ts";
import * as SshTunnel from "./tunnel.ts";
import {
  commandArgs,
  makeDelayedSuccessfulProcess,
  makeProtocolTestSpawner,
  makeRunningProcess,
  makeSuccessfulProcess,
  PROTOCOL_ARCHIVE,
  testNetService,
  uploadTarget,
  isRemoteLaunch,
} from "./tunnel.fixture.ts";

// A server that answers every request after `latencyMs`, like a healthy
// remote reached over a ~600 ms RTT link.
const slowClient = (latencyMs: number) =>
  HttpClient.make((request) =>
    Effect.sleep(Duration.millis(latencyMs)).pipe(
      Effect.as(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
    ),
  );

const refusingClient = HttpClient.make((request) =>
  Effect.fail(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ request, description: "ECONNREFUSED" }),
    }),
  ),
);

// ensureEnvironment writes an askpass helper before it spawns SSH. The fake spawner never
// runs it, and real disk I/O would let `advance` step the TestClock past the launch while
// the write is still in flight. On a loaded CI runner the fiber then sleeps on a clock
// nobody advances again, and the test hangs until the 60 s timeout.
const askpassFileSystem = FileSystem.makeNoop({
  makeTempDirectoryScoped: () => Effect.succeed("/goat-ssh-runtime-test"),
  makeDirectory: () => Effect.void,
  exists: () => Effect.succeed(false),
  writeFileString: () => Effect.void,
  chmod: () => Effect.void,
});

// Steps the test clock so work scheduled after each wake-up sees ordered time.
const advance = (total: Duration.Duration) =>
  Effect.gen(function* () {
    for (let elapsed = 0; elapsed < Duration.toMillis(total); elapsed += 100) {
      yield* TestClock.adjust(Duration.millis(100));
    }
  });

const waitWithClock = (
  client: HttpClient.HttpClient,
  input: Parameters<typeof SshTunnel.waitForHttpReady>[0],
  elapse: Duration.Duration,
) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(Effect.result(SshTunnel.waitForHttpReady(input)));
    yield* Effect.yieldNow;
    yield* TestClock.adjust(elapse);
    return yield* Fiber.join(fiber);
  }).pipe(
    Effect.provide(Layer.merge(TestClock.layer(), Layer.succeed(HttpClient.HttpClient, client))),
  );

describe("SSH forward readiness", () => {
  it("keeps fast-host defaults and scales the budget with a slow launch", () => {
    assert.deepEqual(SshTunnel.sshReadinessBudget(300), {
      probeTimeoutMs: 1_000,
      timeoutMs: 20_000,
    });
    // About 6 s for the launch over a phone hotspot relayed through London.
    assert.deepEqual(SshTunnel.sshReadinessBudget(6_000), {
      probeTimeoutMs: 1_500,
      timeoutMs: 30_000,
    });
    assert.deepEqual(SshTunnel.sshReadinessBudget(600_000), {
      probeTimeoutMs: 5_000,
      timeoutMs: 60_000,
    });
  });

  it.effect("reaches a server that answers slower than the first probe allows", () =>
    Effect.gen(function* () {
      const result = yield* waitWithClock(
        slowClient(1_300),
        { baseUrl: "http://127.0.0.1:41773/", timeoutMs: 20_000, probeTimeoutMs: 1_000 },
        Duration.seconds(20),
      );
      assert.isTrue(Result.isSuccess(result));
    }),
  );

  it.effect("reports a slow server as high latency once the probes stop growing", () =>
    Effect.gen(function* () {
      const result = yield* waitWithClock(
        slowClient(1_300),
        {
          baseUrl: "http://127.0.0.1:41773/",
          timeoutMs: 20_000,
          probeTimeoutMs: 1_000,
          maxProbeTimeoutMs: 1_000,
        },
        Duration.seconds(20),
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.equal(result.failure.reason, "slow");
        assert.include(result.failure.message, "Timed out waiting 20000ms");
        assert.include(result.failure.message, "high latency");
      }
    }),
  );

  it.effect("reports a forward with nothing behind it as unreachable", () =>
    Effect.gen(function* () {
      const result = yield* waitWithClock(
        refusingClient,
        { baseUrl: "http://127.0.0.1:41773/", timeoutMs: 2_000 },
        Duration.seconds(2),
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.equal(result.failure.reason, "unreachable");
        assert.include(result.failure.message, "did not answer through the SSH tunnel");
      }
    }),
  );

  it.effect("connects and reconnects over a high-latency link", () =>
    Effect.gen(function* () {
      let forwards = 0;
      let kills = 0;
      const spawner = makeProtocolTestSpawner((command) =>
        Effect.sync(() => {
          const args = commandArgs(command);
          if (args.includes("-G"))
            return makeSuccessfulProcess("hostname devbox.example.com\nuser alex\nport 2222\n");
          if (args.includes("-N")) {
            forwards++;
            return makeRunningProcess(() => {
              kills++;
            });
          }
          if (isRemoteLaunch(args))
            return makeDelayedSuccessfulProcess(
              '{"status":"ready","selectedVersion":"1.2.3-preview.20260911.4","remotePort":3773,"serverKind":"managed"}',
              6_000,
            );
          return makeSuccessfulProcess("");
        }),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(FileSystem.FileSystem, askpassFileSystem),
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, slowClient(1_300)),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({
          resolveCliRunner: Effect.succeed(PROTOCOL_ARCHIVE),
        }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const connect = yield* Effect.forkChild(
          Effect.result(manager.ensureEnvironment(uploadTarget)),
        );
        yield* advance(Duration.seconds(40));
        const first = yield* Fiber.join(connect);
        if (Result.isFailure(first)) assert.fail(String(first.failure.message));

        const reconnect = yield* Effect.forkChild(
          Effect.result(manager.ensureEnvironment(uploadTarget)),
        );
        yield* advance(Duration.seconds(10));
        assert.isTrue(Result.isSuccess(yield* Fiber.join(reconnect)));
        // The answering forward is kept, not torn down as stale.
        assert.equal(forwards, 1);
        assert.equal(kills, 0);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );
});

describe("SSH stale forwards", () => {
  it.effect("replaces a stale SSH forward without stopping the remote server", () =>
    Effect.gen(function* () {
      const probeStarted = yield* Deferred.make<void>();
      let stale = false;
      let forwards = 0;
      let stops = 0;
      let kills = 0;
      const spawner = makeProtocolTestSpawner((command) =>
        Effect.sync(() => {
          const args = commandArgs(command);
          if (args.includes("-N")) {
            forwards += 1;
            stale = false;
            return makeRunningProcess(() => {
              kills += 1;
            });
          }
          if (isRemoteLaunch(args))
            return makeSuccessfulProcess(
              '{"status":"ready","selectedVersion":"1.2.3-preview.20260911.4","remotePort":3773,"serverKind":"managed"}\n',
            );
          if (args.includes("sh")) stops += 1;
          return makeSuccessfulProcess("");
        }),
      );
      const httpClient = HttpClient.make((request) =>
        stale
          ? Deferred.succeed(probeStarted, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(FileSystem.FileSystem, askpassFileSystem),
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({
          resolveCliRunner: Effect.succeed(PROTOCOL_ARCHIVE),
        }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
        yield* manager.ensureEnvironment(target);
        stale = true;
        const reconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
        yield* Deferred.await(probeStarted);
        yield* TestClock.adjust("2 seconds");
        yield* Fiber.join(reconnect);
        assert.equal(forwards, 2);
        assert.equal(kills, 1);
        assert.equal(stops, 0);
        yield* manager.disconnectEnvironment(target);
        assert.equal(stops, 1);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("replaces a forward whose ssh process exited even though the port still answers", () =>
    Effect.gen(function* () {
      // The local port can be taken over or answered by something else after the ssh child
      // dies; only the child's own state says the forward is gone.
      let exited = false;
      let forwards = 0;
      let stops = 0;
      const spawner = makeProtocolTestSpawner((command) =>
        Effect.sync(() => {
          const args = commandArgs(command);
          if (args.includes("-N")) {
            forwards += 1;
            exited = false;
            return {
              ...makeRunningProcess(() => undefined),
              isRunning: Effect.sync(() => !exited),
            };
          }
          if (isRemoteLaunch(args))
            return makeSuccessfulProcess(
              '{"status":"ready","selectedVersion":"1.2.3-preview.20260911.4","remotePort":3773,"serverKind":"managed"}\n',
            );
          if (args.includes("sh")) stops += 1;
          return makeSuccessfulProcess("");
        }),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(FileSystem.FileSystem, askpassFileSystem),
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
          ),
        ),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({
          resolveCliRunner: Effect.succeed(PROTOCOL_ARCHIVE),
        }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
        yield* manager.ensureEnvironment(target);
        yield* manager.ensureEnvironment(target);
        assert.equal(forwards, 1);
        exited = true;
        yield* manager.ensureEnvironment(target);
        assert.equal(forwards, 2);
        assert.equal(stops, 0);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );
});
