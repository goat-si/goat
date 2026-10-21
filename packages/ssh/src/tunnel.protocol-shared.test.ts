import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { REMOTE_RUNTIME_STATE_KEY } from "./command.ts";
import * as SshTunnel from "./tunnel.ts";
import { remoteShell } from "./tunnel.fixture.ts";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";

const current = {
  ssh: SSH_RUNTIME_PROTOCOL_VERSION,
  orchestration: ORCHESTRATION_PROTOCOL_VERSION,
};
// The same host as `uploadTarget`, dialled by a second client under another name.
const secondClient = {
  alias: "mac-studio",
  hostname: "mac-studio.tailnet.ts.net",
  username: "jun",
  port: null,
};

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH runtime shared between clients",
  () => {
    it.live("a second client attaches to the runtime another client launched", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: "1.2.2",
          ...current,
        });
        const before = yield* f.snapshot;
        const second = yield* SshTunnel.launchOrReuseRemoteServer(secondClient, {}, f.runner).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.transport),
        );
        assert.equal(second.status, "ready");
        if (second.status !== "ready") return;
        // Same server and the same ownership record: threads launched by either
        // client live in that server's state and are visible to both.
        assert.equal(second.remotePort, f.port);
        assert.equal(second.remoteServerKind, "managed");
        const first = yield* f.run("launch");
        assert.isTrue(Result.isSuccess(first));
        if (Result.isSuccess(first)) assert.equal(first.success.port, f.port);
        assert.deepEqual(yield* f.snapshot, before);
        assert.isTrue(f.state.endsWith(`/ssh-launch/${REMOTE_RUNTIME_STATE_KEY}`));
        assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '"type":"stop"');
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live(
      "stale launch files from an earlier server do not block adopting the live runtime",
      () =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            ...current,
          });
          const exited = yield* f.realSpawner.spawn(ChildProcess.make("true"));
          assert.equal(Number(yield* exited.exitCode), 0);
          const deadPid = Number(exited.pid);
          yield* f.fs.writeFileString(`${f.state}/pid`, `${deadPid}\n`);
          yield* f.fs.writeFileString(`${f.state}/port`, `${f.port + 1}\n`);
          const result = yield* SshTunnel.launchOrReuseRemoteServer(
            secondClient,
            {},
            f.runner,
          ).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.transport),
            Effect.result,
          );
          if (Result.isFailure(result)) throw result.failure;
          assert.equal(result.success.status, "ready");
          if (result.success.status !== "ready") return;
          assert.equal(result.success.remotePort, f.port);
          // Ownership comes from the live server's own GOAT invocation, never from the stale
          // record, and it is used only to drain: the server is not signalled.
          assert.equal(result.success.remoteServerKind, "managed");
          assert.equal(yield* f.fs.readFileString(`${f.state}/pid`), `${f.pid}\n`);
          assert.equal(yield* f.fs.readFileString(`${f.state}/port`), `${f.port}\n`);
          yield* Effect.sync(() => process.kill(f.pid, 0));
          assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '"type":"stop"');
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live(
      "a server recorded under an old per-client directory is attached, never signalled",
      () =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            ...current,
          });
          // Releases before the shared directory hashed the dialled target into the path.
          const legacy = `${f.home}/.goat/ssh-launch/711bc738002d72fd`;
          yield* f.fs.rename(f.state, legacy);
          const legacyBefore: Record<string, string> = {};
          for (const name of yield* f.fs.readDirectory(legacy))
            legacyBefore[name] = yield* f.fs.readFileString(`${legacy}/${name}`);
          const result = yield* SshTunnel.launchOrReuseRemoteServer(
            secondClient,
            {},
            f.runner,
          ).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.transport),
            Effect.result,
          );
          if (Result.isFailure(result)) throw result.failure;
          assert.equal(result.success.status, "ready");
          if (result.success.status !== "ready") return;
          assert.equal(result.success.remotePort, f.port);
          assert.equal(result.success.remoteServerKind, "external");
          const legacyAfter: Record<string, string> = {};
          for (const name of yield* f.fs.readDirectory(legacy))
            legacyAfter[name] = yield* f.fs.readFileString(`${legacy}/${name}`);
          assert.deepEqual(legacyAfter, legacyBefore);
          yield* Effect.sync(() => process.kill(f.pid, 0));
          assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '"type":"stop"');
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("a compatible runtime from another release train is attached, never replaced", () =>
      Effect.gen(function* () {
        // SemVer sorts "dev" below "preview", which used to read as an older runtime.
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: "1.2.3-dev.d9bdcfc89",
          ...current,
        });
        const before = yield* f.snapshot;
        const result = yield* f.run("launch", false, {
          refreshOwnedRuntimeOnFirstConnection: true,
        });
        if (Result.isFailure(result)) throw result.failure;
        assert.equal(result.success.version, "1.2.3-dev.d9bdcfc89");
        assert.equal(result.success.port, f.port);
        assert.isUndefined(result.success.refresh);
        assert.deepEqual(yield* f.snapshot, before);
        assert.isFalse(yield* f.fs.exists(`${f.test}/activity-requests`));
        assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '"type":"stop"');
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(["busy", "unknown", "idle"] as const)(
      "stop signals a shared server only when it reports idle: %s",
      (activity) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            ...current,
          });
          yield* f.fs.writeFileString(`${f.test}/activity`, activity);
          const before = yield* f.snapshot;
          const stop = yield* f.realSpawner.spawn(
            ChildProcess.make(
              remoteShell,
              ["-c", SshTunnel.buildRemoteStopScript(REMOTE_RUNTIME_STATE_KEY)],
              {
                env: {
                  HOME: f.home,
                  PATH: f.withPortShim(`${f.test}/identity-bin:${process.env.PATH ?? ""}`),
                  LC_ALL: "C",
                },
                extendEnv: false,
              },
            ),
          );
          const output = yield* stop.stdout.pipe(Stream.decodeText(), Stream.mkString);
          assert.equal(Number(yield* stop.exitCode), 0);
          const stopped = (yield* f.fs.readFileString(`${f.test}/events`)).includes(
            '"type":"stop"',
          );
          if (activity === "idle") {
            assert.include(output, '{"stopped":true}');
            assert.isTrue(stopped);
          } else {
            assert.include(output, `{"stopped":false,"activity":"${activity}"}`);
            assert.isFalse(stopped);
            yield* Effect.sync(() => process.kill(f.pid, 0));
            assert.deepEqual(yield* f.snapshot, before);
          }
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);

// Upstream reconnect regressions, exercised through GOAT's protocol-aware launcher.
describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH reconnect preserves remote work",
  () => {
    it.live.each(["ready", "stalled"] as const)(
      "gives an existing managed server the full readiness budget: %s",
      (mode) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            ...current,
          });
          // Keep protocol discovery real. Only readiness is controlled, so the test
          // proves the launcher's budget and failure behavior without timed sleeps.
          const executable = `${f.old}/goat`;
          const source = yield* f.fs.readFileString(executable);
          yield* f.fs.writeFileString(
            executable,
            source.replace(
              "// Fixture readiness uses an event, not polling or a delay.",
              `fs.writeFileSync(path.join(test, "reuse-budget"), args[3]);
if (args[3] !== "60000") process.exit(9);
${mode === "stalled" ? "process.exit(1);" : ""}`,
            ),
          );
          const before = yield* f.snapshot;
          const result = yield* f.run("launch");
          assert.equal(yield* f.fs.readFileString(`${f.test}/reuse-budget`), "60000");
          if (mode === "ready") {
            assert.isTrue(Result.isSuccess(result));
            if (Result.isSuccess(result)) assert.equal(result.success.port, f.port);
          } else {
            assert.isTrue(Result.isFailure(result));
            if (Result.isFailure(result)) assert.include(String(result.failure), "left running");
          }
          assert.deepEqual(yield* f.snapshot, before);
          yield* Effect.sync(() => process.kill(f.pid, 0));
          assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '"type":"stop"');
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("adopts a live server without a managed record instead of restarting it", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: "1.2.2",
          ...current,
        });
        yield* f.fs.remove(`${f.state}/managed`);
        const result = yield* SshTunnel.launchOrReuseRemoteServer(secondClient, {}, f.runner).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.transport),
        );
        assert.equal(result.status, "ready");
        if (result.status === "ready") {
          assert.equal(result.remotePort, f.port);
          assert.equal(result.remoteServerKind, "external");
        }
        yield* Effect.sync(() => process.kill(f.pid, 0));
        assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '"type":"stop"');
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
