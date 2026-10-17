import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ORCHESTRATION_PROTOCOL_VERSION, SshHostResult, SshHostProviders } from "@goat/contracts";
import { cliArchiveFileName } from "@goat/shared/cliRelease";
import * as HostProcess from "@goat/shared/HostProcess";
import * as NetService from "@goat/shared/Net";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
import * as SshTunnel from "./tunnel.ts";
import {
  ARCHIVE,
  makeSuccessfulProcess,
  makeRunningProcess,
  testHttpClient,
  testNetService,
  uploadTarget,
} from "./tunnel.fixture.ts";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";

const decodeProviders = Schema.decodeEffect(SshHostProviders);
const decodeSshHostResult = Schema.decodeEffect(SshHostResult);

const signals = (version: string) => ({
  serverVersion: version,
  sshRuntimeProtocolVersion: SSH_RUNTIME_PROTOCOL_VERSION,
  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
});
const stopped = { platform: "linux", arch: "x64", ready: false, liveStatus: "none" };
const retained = {
  ...stopped,
  retained: "ready",
  retainedVersion: "1.2.2",
  retainedSignals: signals("1.2.2"),
  retainedRunnerSha256: "a".repeat(64),
};
const successfulStatus = (result: SshHostResult) => {
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") throw new Error("Expected an SSH status");
  return result.status;
};

const fixture = (initial: unknown, runnerOptions: SshTunnel.RemoteGoatRunnerOptions = {}) => {
  let probe = initial;
  let probeFailure: string | undefined;
  let toolFixProbe = "1000\nLinux\nID=debian\n";
  let launchVersion = ARCHIVE.archiveVersion as string;
  const calls = { probes: 0, uploads: 0, launches: 0, forwards: 0, prompts: 0, strict: false };
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected command");
      if (command.args.includes("-G"))
        return makeSuccessfulProcess("hostname devbox.example.com\nuser julius\nport 2222\n");
      if (command.args.includes("-N")) {
        calls.forwards++;
        return makeRunningProcess(() => undefined);
      }
      if (command.args.includes("-c")) {
        calls.uploads++;
        return makeSuccessfulProcess("goat uploaded");
      }
      const input = command.options.stdin;
      const script =
        input !== undefined &&
        typeof input === "object" &&
        "stream" in input &&
        Stream.isStream(input.stream)
          ? yield* input.stream.pipe(Stream.decodeText(), Stream.mkString)
          : "";
      if (script.includes("GOAT_TOOL_FIX_PROBE")) return makeSuccessfulProcess(toolFixProbe);
      if (script.includes("ready=false")) {
        calls.probes++;
        calls.strict = ["StrictHostKeyChecking=yes", "UpdateHostKeys=no", "BatchMode=yes"].every(
          (arg) => command.args.includes(arg),
        );
        if (probeFailure !== undefined)
          return {
            ...makeSuccessfulProcess(""),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
            stderr: Stream.make(new TextEncoder().encode(probeFailure)),
          };
        return makeSuccessfulProcess(typeof probe === "string" ? probe : JSON.stringify(probe));
      }
      calls.launches++;
      return makeSuccessfulProcess(
        JSON.stringify({
          status: "ready",
          selectedVersion: launchVersion,
          remotePort: 3773,
          serverKind: "managed",
        }),
      );
    }),
  );
  return {
    calls,
    setToolFixProbe: (value: string) => {
      toolFixProbe = value;
    },
    setProbe: (value: unknown) => {
      probe = value;
    },
    failProbe: (value: string) => {
      probeFailure = value;
    },
    setLaunchVersion: (value: string) => {
      launchVersion = value;
    },
    layer: Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(NetService.NetService, testNetService),
      Layer.succeed(HttpClient.HttpClient, testHttpClient),
      Layer.succeed(SshAuth.SshPasswordPrompt, {
        isAvailable: true,
        request: () =>
          Effect.sync(() => {
            calls.prompts++;
            return "unused";
          }),
      }),
      SshTunnel.SshEnvironmentManager.layer({
        resolveCliRunner: Effect.succeed({
          ...ARCHIVE,
          refreshOwnedRuntimeOnFirstConnection: true,
          ...runnerOptions,
        }),
        leaveRemoteServerRunning: true,
      }),
    ),
  };
};

describe("SSH runtime status", () => {
  it.effect("publishes current-operation diagnosis and preserves it on status reads", () => {
    const f = fixture({
      ...stopped,
      ready: true,
      liveStatus: "live",
      liveVersion: ARCHIVE.archiveVersion,
      liveOwned: true,
      liveDrain: true,
      liveSignals: signals(ARCHIVE.archiveVersion),
    });
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const first = yield* manager.beginSetupOperation(uploadTarget, "first");
      yield* manager.ensureEnvironment(uploadTarget, { keyOnly: true });
      assert.equal((yield* manager.status(uploadTarget)).status?.setup?.stage, "diagnosis");
      const providers = yield* decodeProviders({
        checkedAt: "2026-10-18T00:00:00.000Z",
        ready: false,
        fixes: [{ actor: "human", instruction: "Sign in on the host." }],
      });
      assert.isTrue(yield* manager.publishProviderDiagnosis(uploadTarget, first, providers));
      const failed = yield* manager.status(uploadTarget);
      yield* decodeSshHostResult(failed);
      assert.equal(failed.status?.state, "providers_not_ready");
      assert.deepEqual(failed.status?.providers, providers);
      assert.equal(failed.status?.setup?.stage, "complete");
      const second = yield* manager.beginSetupOperation(uploadTarget, "second");
      assert.isAbove(second.generation, first.generation);
      yield* manager.ensureEnvironment(uploadTarget, { keyOnly: true });
      assert.isFalse(yield* manager.publishProviderDiagnosis(uploadTarget, first, providers));
      const current = yield* manager.status(uploadTarget);
      assert.equal(current.status?.state, "ready");
      assert.equal(current.status?.setup?.operationId, "second");
      assert.equal(current.status?.setup?.stage, "diagnosis");
      assert.isUndefined(current.status?.providers);
      yield* manager.forgetEnvironment(uploadTarget, { stopRuntime: "no" });
      assert.isFalse(yield* manager.publishProviderDiagnosis(uploadTarget, second, providers));
      assert.equal((yield* manager.status(uploadTarget)).status?.state, "untrusted");
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect.each(["ready", "stopped"] as const)(
    "ready-only access to %s never bootstraps",
    (state) => {
      const f = fixture({ ...stopped, ready: true });
      return Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        if (state === "ready") yield* manager.ensureEnvironment(uploadTarget, { keyOnly: true });
        const before = { ...f.calls };
        const result = yield* Effect.result(manager.readyEnvironment(uploadTarget));
        assert.equal(Result.isSuccess(result), state === "ready");
        assert.deepEqual(f.calls, before);
        if (state === "stopped") {
          assert.isTrue(
            Result.isFailure(
              yield* Effect.result(
                manager.issueMcpClientSession(uploadTarget, {
                  requireReady: true,
                  label: "diagnose",
                  ttl: "1h",
                  runtimeModeCeiling: null,
                }),
              ),
            ),
          );
          assert.deepEqual(f.calls, before);
        }
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    },
  );

  it.effect.each(["0", "1000", "unknown"] as const)(
    "missing tools use plain guidance and root-only commands for uid %s",
    (uid) => {
      const f = fixture(stopped);
      f.failProbe("Remote host needs curl or wget to download the archive.");
      f.setToolFixProbe(`${uid}\nLinux\nID=debian\n`);
      return Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* manager.status(uploadTarget);
        yield* decodeSshHostResult(result);
        const fix = result.status?.failure?.fix;
        assert.equal(fix?.instruction, "Install curl or wget on devbox, then try again.");
        if (uid === "0") assert.equal(fix?.command, "apt-get update && apt-get install -y curl");
        else assert.isUndefined(fix?.command);
        assert.notInclude(fix?.command ?? "", "sudo");
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    },
  );

  it.effect.each([true, false])(
    "auth_failed exposes only the GOAT-generated public key (managed=%s)",
    (managed) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-public-key-" });
        const dir = `${home}/.ssh/goat-cloud`;
        yield* fs.makeDirectory(dir, { recursive: true });
        yield* fs.writeFileString(
          `${dir}/devbox.conf`,
          `Host devbox\n  IdentityFile "${managed ? dir + "/id_ed25519" : home + "/private-key"}"\n`,
        );
        yield* fs.writeFileString(`${dir}/id_ed25519.pub`, "ssh-ed25519 AAAAGOATKEY goat-cloud\n");
        const f = fixture(stopped);
        f.failProbe("Permission denied (publickey).");
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          const result = yield* manager.status(uploadTarget);
          yield* decodeSshHostResult(result);
          assert.equal(result.status?.state, "auth_failed");
          assert.equal(
            result.status?.publicKey,
            managed ? "ssh-ed25519 AAAAGOATKEY goat-cloud" : undefined,
          );
          assert.equal(
            result.status?.keyAuth?.command,
            managed
              ? `ssh-copy-id -i '${dir}/id_ed25519.pub' -p '2222' 'julius@devbox'`
              : undefined,
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              f.layer,
              ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home })),
            ),
          ),
          Effect.scoped,
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.each(["mirror", "installed", "upload"] as const)(
    "reports only executed %s milestones",
    (mode) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-phases-" });
        if (mode === "upload")
          yield* fs.writeFile(
            `${directory}/${cliArchiveFileName(ARCHIVE.archiveVersion, "linux-x64")}`,
            new Uint8Array(64),
          );
        const f = fixture(
          { ...stopped, ready: mode === "installed" },
          mode === "mirror"
            ? { releaseBaseUrl: "https://example.invalid/mirror" }
            : mode === "upload"
              ? { archiveDirectory: directory }
              : {},
        );
        const milestones: Array<{
          phase: string;
          probes: number;
          uploads: number;
          launches: number;
        }> = [];
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          yield* manager.ensureEnvironment(uploadTarget, {
            onPhase: ({ phase }) => {
              milestones.push({
                phase,
                probes: f.calls.probes,
                uploads: f.calls.uploads,
                launches: f.calls.launches,
              });
            },
          });
        }).pipe(Effect.provide(f.layer), Effect.scoped);
        assert.deepEqual(
          milestones.map((step) => step.phase),
          mode === "upload"
            ? ["connecting", "checking", "uploading", "starting"]
            : ["connecting", "checking", "starting"],
        );
        assert.deepInclude(milestones, { phase: "checking", probes: 0, uploads: 0, launches: 0 });
        if (mode === "upload")
          assert.deepInclude(milestones, {
            phase: "uploading",
            probes: 1,
            uploads: 0,
            launches: 0,
          });
        assert.deepInclude(milestones, {
          phase: "starting",
          probes: 1,
          uploads: mode === "upload" ? 1 : 0,
          launches: 1,
        });
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("an observer exception cannot fail runtime preparation or launch", () => {
    const f = fixture({ ...stopped, ready: true });
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const result = yield* manager.ensureEnvironment(uploadTarget, {
        onPhase: () => {
          throw new Error("view disposed");
        },
      });
      assert.notProperty(result, "type");
      assert.equal(f.calls.launches, 1);
      assert.equal(f.calls.forwards, 1);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect.each([
    { name: "never installed", probe: stopped, version: null },
    { name: "retained but stopped", probe: retained, version: "1.2.2" },
    {
      name: "requested installed but stopped",
      probe: { ...stopped, ready: true },
      version: ARCHIVE.archiveVersion,
    },
  ])("observes $name without starting or installing it", ({ probe, version }) => {
    const f = fixture(probe);
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const result = yield* manager.status(uploadTarget);
      yield* decodeSshHostResult(result);
      const status = successfulStatus(result);
      assert.equal(status.state, "stopped");
      assert.equal(status.runtimeVersion, version);
      assert.equal(status.requestedVersion, ARCHIVE.archiveVersion);
      assert.isUndefined(status.phase);
      assert.deepEqual(f.calls, {
        probes: 1,
        uploads: 0,
        launches: 0,
        forwards: 0,
        prompts: 0,
        strict: true,
      });
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect.each([
    { version: ARCHIVE.archiveVersion, owned: true, expected: "ready" },
    { version: "1.2.2", owned: true, expected: "ready" },
    { version: "99.0.0", owned: true, expected: "update_blocked" },
    { version: "1.2.2", owned: false, expected: "update_blocked" },
    { version: "1.2.3-dev.deadbeef", owned: true, expected: "update_blocked" },
  ])("classifies live $version owned=$owned as $expected", ({ version, owned, expected }) => {
    const f = fixture({
      ...stopped,
      liveStatus: "live",
      liveVersion: version,
      liveOwned: owned,
      liveDrain: true,
      liveSignals: signals(version),
    });
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const result = yield* manager.status(uploadTarget);
      yield* decodeSshHostResult(result);
      assert.equal(successfulStatus(result).state, expected);
      assert.equal(successfulStatus(result).runtimeVersion, version);
      assert.equal(f.calls.launches, 0);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect.each([
    {
      stderr: "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nHost key verification failed.",
      state: "failed",
      reason: "host_key_changed",
    },
    {
      stderr:
        "No ED25519 host key is known for devbox and you have requested strict checking.\nHost key verification failed.",
      state: "untrusted",
      reason: undefined,
    },
    { stderr: "Permission denied (publickey).", state: "auth_failed", reason: undefined },
    {
      stderr: "Remote GOAT server did not become ready on 127.0.0.1:3773.",
      state: "failed",
      reason: "start_timeout",
    },
    {
      stderr:
        "Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.",
      state: "failed",
      reason: "missing_tools",
    },
  ])("classifies an observed failure: $state/$reason", ({ stderr, state, reason }) => {
    const f = fixture(stopped);
    f.failProbe(stderr);
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const result = yield* manager.status(uploadTarget);
      yield* decodeSshHostResult(result);
      assert.equal(successfulStatus(result).state, state);
      assert.equal(successfulStatus(result).failure?.reason, reason);
      assert.equal(f.calls.prompts, 0);
      assert.equal(f.calls.launches, 0);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect("keeps network failures distinct from acquisition failures", () => {
    const f = fixture(stopped);
    f.failProbe("ssh: connect to host devbox.example.com port 2222: Connection refused");
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const result = yield* manager.status(uploadTarget);
      assert.equal(result.kind, "error");
      if (result.kind === "error") {
        assert.equal(result.code, "host_unreachable");
        assert.equal(result.fix?.instruction, "Try again");
        assert.include(result.message, "devbox");
      }
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect("publishes only the sanitized final line of an unknown failure", () => {
    const f = fixture(stopped);
    f.failProbe(
      "private earlier line\nUnexpected helper failure token=top-secret https://user:password@example.invalid/?credential=private",
    );
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const result = yield* manager.status(uploadTarget);
      assert.equal(result.kind, "error");
      if (result.kind === "error") {
        assert.equal(result.code, "operation_failed");
        assert.include(result.message, "devbox: Unexpected helper failure");
        assert.equal(result.fix?.instruction, "Try again");
      }
      const serialized = JSON.stringify(result);
      for (const secret of ["private", "top-secret", "user:password", "stdout", "cause"])
        assert.notInclude(serialized, secret);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect("does not guess unsupported_platform from malformed probe output", () => {
    const f = fixture("not json");
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const result = yield* manager.status(uploadTarget);
      assert.equal(result.kind, "error");
      if (result.kind === "error") assert.equal(result.code, "operation_failed");
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect(
    "recognizes a proven unsupported archive platform without guessing from decode failure",
    () => {
      const f = fixture({ ...stopped, platform: "darwin", arch: "x64" });
      return Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        assert.isTrue(
          Result.isFailure(yield* Effect.result(manager.ensureEnvironment(uploadTarget))),
        );
        const result = yield* manager.status(uploadTarget);
        yield* decodeSshHostResult(result);
        assert.equal(successfulStatus(result).failure?.reason, "unsupported_platform");
        assert.equal(f.calls.launches, 0);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    },
  );

  it.effect(
    "retains an acquisition failure while the fallback runtime connects and probes successfully",
    () => {
      const f = fixture(retained);
      f.setLaunchVersion("1.2.2");
      return Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const connection = yield* manager.ensureEnvironment(uploadTarget);
        assert.notProperty(connection, "type");
        if (!("type" in connection)) assert.equal(connection.remoteServerVersion, "1.2.2");
        f.setProbe({
          ...retained,
          liveStatus: "live",
          liveVersion: "1.2.2",
          liveOwned: true,
          liveDrain: true,
          liveSignals: signals("1.2.2"),
        });
        const result = yield* manager.status(uploadTarget);
        yield* decodeSshHostResult(result);
        const status = successfulStatus(result);
        assert.equal(status.state, "failed");
        assert.equal(status.runtimeVersion, "1.2.2");
        assert.deepEqual(status.failure?.archive, {
          requestedVersion: ARCHIVE.archiveVersion,
          platformKey: "linux-x64",
          sourcesTried: [],
        });
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    },
  );
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("read-only status shell", () => {
  it.live.each([true, false])(
    "distinguishes installed=%s using the real remote probe without writes",
    (installed) =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: false,
          kind: "managed",
          oldVersion: "1.2.2",
          ssh: SSH_RUNTIME_PROTOCOL_VERSION,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        });
        if (!installed) {
          yield* f.fs.remove(`${f.old}/.install-complete`);
          yield* f.fs.remove(`${f.state}/run-t3.sh`);
        }
        const persistentFiles = [
          `${f.old}/.install-complete`,
          `${f.old}/goat`,
          `${f.state}/run-t3.sh`,
          `${f.state}/pid`,
          `${f.state}/port`,
          `${f.state}/managed`,
          `${f.state}/identity`,
          `${f.home}/.goat/userdata/server-runtime.json`,
        ];
        const persisted = Effect.forEach(persistentFiles, (path) =>
          Effect.gen(function* () {
            return (yield* f.fs.exists(path)) ? yield* f.fs.readFileString(path) : null;
          }),
        );
        const before = yield* persisted;
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          const result = successfulStatus(yield* manager.status(uploadTarget));
          assert.equal(result.state, "stopped");
          assert.equal(result.runtimeVersion, installed ? "1.2.2" : null);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              SshTunnel.SshEnvironmentManager.layer({
                resolveCliRunner: Effect.succeed(ARCHIVE),
                leaveRemoteServerRunning: true,
              }),
              SshAuth.SshPasswordPrompt.disabledLayer,
              Layer.succeed(NetService.NetService, testNetService),
              Layer.succeed(HttpClient.HttpClient, testHttpClient),
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, f.transport),
            ),
          ),
        );
        assert.deepEqual(yield* persisted, before);
        const log = (yield* f.fs.readFileString(`${f.test}/events`))
          .trim()
          .split("\n")
          .filter(Boolean);
        assert.isTrue(
          log.every((line) =>
            ["version", "protocol"].includes((JSON.parse(line) as { type: string }).type),
          ),
        );
        assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

it.effect(
  "plain runtime completion ends diagnosis without manufacturing provider readiness",
  () => {
    const f = fixture({
      ...stopped,
      ready: true,
      liveStatus: "live",
      liveVersion: ARCHIVE.archiveVersion,
      liveOwned: true,
      liveDrain: true,
      liveSignals: signals(ARCHIVE.archiveVersion),
    });
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const operation = yield* manager.beginSetupOperation(uploadTarget, "plain-update");
      yield* manager.ensureEnvironment(uploadTarget, { keyOnly: true });
      assert.equal((yield* manager.status(uploadTarget)).status?.setup?.stage, "diagnosis");
      assert.isTrue(
        yield* manager.publishSetupOutcome(uploadTarget, operation, { kind: "complete" }),
      );
      const result = yield* manager.status(uploadTarget);
      yield* decodeSshHostResult(result);
      assert.equal(result.status?.setup?.stage, "complete");
      assert.isUndefined(result.status?.providers);
      const next = yield* manager.beginSetupOperation(uploadTarget, "next-update");
      assert.isFalse(
        yield* manager.publishSetupOutcome(uploadTarget, operation, { kind: "complete" }),
      );
      yield* manager.forgetEnvironment(uploadTarget, { stopRuntime: "no" });
      assert.isFalse(yield* manager.publishSetupOutcome(uploadTarget, next, { kind: "complete" }));
      assert.equal((yield* manager.status(uploadTarget)).status?.state, "untrusted");
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  },
);
it.effect.each([
  "diagnosis_failed",
  "approval_expired",
  "authorization_revoked",
  "operation_failed",
] as const)("publishes %s as one guarded terminal recovery and retains it on refresh", (reason) => {
  const f = fixture({
    ...stopped,
    ready: true,
    liveStatus: "live",
    liveVersion: ARCHIVE.archiveVersion,
    liveOwned: true,
    liveDrain: true,
    liveSignals: signals(ARCHIVE.archiveVersion),
  });
  return Effect.gen(function* () {
    const manager = yield* SshTunnel.SshEnvironmentManager;
    const operation = yield* manager.beginSetupOperation(uploadTarget, "failed-setup");
    yield* manager.ensureEnvironment(uploadTarget, { keyOnly: true });
    const fix = { actor: "human" as const, instruction: "Ask again." };
    assert.isTrue(
      yield* manager.publishSetupOutcome(uploadTarget, operation, {
        kind: "error",
        reason,
        message: "This operation could not continue.",
        fix,
      }),
    );
    const before = { ...f.calls };
    const result = yield* manager.status(uploadTarget);
    yield* decodeSshHostResult(result);
    assert.equal(result.status?.state, "failed");
    assert.equal(result.status?.setup?.stage, "complete");
    assert.equal(result.status?.failure?.reason, reason);
    assert.deepEqual(result.status?.failure?.fix, fix);
    assert.isUndefined(result.status?.providers);
    assert.deepEqual(f.calls, before);
    assert.isFalse(
      yield* manager.publishProviderDiagnosis(uploadTarget, operation, {
        checkedAt: "2026-10-18T00:00:00Z",
        ready: true,
        fixes: [],
      }),
    );
  }).pipe(Effect.provide(f.layer), Effect.scoped);
});

it.effect(
  "an expired key-auth approval replaces authentication recovery with one terminal failure",
  () => {
    const f = fixture(stopped);
    f.failProbe("Permission denied (publickey).");
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const operation = yield* manager.beginSetupOperation(uploadTarget, "expired-key-auth");
      yield* manager.ensureEnvironment(uploadTarget, { keyOnly: true }).pipe(Effect.result);
      assert.equal((yield* manager.status(uploadTarget)).status?.state, "auth_failed");
      assert.isTrue(
        yield* manager.publishSetupOutcome(uploadTarget, operation, {
          kind: "error",
          reason: "approval_expired",
          message: "This approval expired. Ask again.",
          fix: { actor: "human", instruction: "Ask again to review this setup." },
        }),
      );
      const result = yield* manager.status(uploadTarget);
      yield* decodeSshHostResult(result);
      assert.equal(result.status?.state, "failed");
      assert.equal(result.status?.failure?.reason, "approval_expired");
      assert.equal(result.status?.setup?.stage, "complete");
      assert.isUndefined(result.status?.keyAuth);
      assert.isUndefined(result.status?.publicKey);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  },
);
