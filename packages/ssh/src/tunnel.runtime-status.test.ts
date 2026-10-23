import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ORCHESTRATION_PROTOCOL_VERSION, SshHostResult, SshHostProviders } from "@goat/contracts";
import { cliArchiveFileName } from "@goat/shared/cliRelease";
import * as HostProcess from "@goat/shared/HostProcess";
import * as NetService from "@goat/shared/Net";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
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
  isRemoteLaunch,
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

const fixture = (
  initial: unknown,
  runnerOptions: SshTunnel.RemoteGoatRunnerOptions = {},
  afterUpload: Effect.Effect<void> = Effect.void,
) => {
  let probe = initial;
  let probeFailure: string | undefined;
  let toolFixProbe = "1000\nLinux\nID=debian\n";
  let launchVersion = ARCHIVE.archiveVersion as string;
  let drainPending = false;
  let drainReplacement: "older" | "capability" = "older";
  // The version the server behind a forward reports; unset answers no descriptor.
  let descriptorVersion: string | undefined;
  let readinessGate:
    | { readonly entered: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
    | undefined;
  const httpClient = HttpClient.make((request) =>
    Effect.gen(function* () {
      const path = new URL(request.url).pathname;
      if (path === "/.well-known/goat/environment" && descriptorVersion !== undefined)
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ serverVersion: descriptorVersion }), { status: 200 }),
        );
      const gate = readinessGate;
      if (gate !== undefined && path === "/") {
        readinessGate = undefined;
        yield* Deferred.succeed(gate.entered, undefined);
        yield* Deferred.await(gate.release);
      }
      return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
    }),
  );
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
      const input = command.options.stdin;
      if (command.args.includes("-c")) {
        calls.uploads++;
        if (
          input !== undefined &&
          typeof input === "object" &&
          "stream" in input &&
          Stream.isStream(input.stream)
        )
          yield* Stream.runDrain(input.stream);
        yield* afterUpload;
        return makeSuccessfulProcess("goat uploaded");
      }
      const script =
        input !== undefined &&
        typeof input === "object" &&
        "stream" in input &&
        Stream.isStream(input.stream)
          ? yield* input.stream.pipe(Stream.decodeText(), Stream.mkString)
          : "";
      if (script.includes("GOAT_TOOL_FIX_PROBE")) return makeSuccessfulProcess(toolFixProbe);
      if (command.args.includes("goat-runtime-cleanup")) return makeSuccessfulProcess("");
      if (script.includes("ready=false") && !isRemoteLaunch(command.args)) {
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
          ...(drainPending
            ? {
                pending: {
                  reason: "unknown",
                  refreshCause: "drain_unavailable",
                  replacement: drainReplacement,
                  requestedVersion: ARCHIVE.archiveVersion,
                  liveVersion: launchVersion,
                },
              }
            : {}),
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
    setDrainPending: (replacement: "older" | "capability" = "older") => {
      drainPending = true;
      drainReplacement = replacement;
    },
    setLaunchVersion: (value: string) => {
      launchVersion = value;
    },
    setDescriptorVersion: (value: string) => {
      descriptorVersion = value;
    },
    gateReadiness: (gate: NonNullable<typeof readinessGate>) => {
      readinessGate = gate;
    },
    layer: Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(NetService.NetService, testNetService),
      Layer.succeed(HttpClient.HttpClient, httpClient),
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
  const live = (version: string) => ({
    ...stopped,
    ready: true,
    liveStatus: "live",
    liveVersion: version,
    livePort: 3773,
    liveOwned: true,
    liveDrain: true,
    liveSignals: signals(version),
    liveBinarySignals: signals(version),
  });

  it.effect("an agent call reusing a healthy forward never reports the host as preparing", () => {
    const f = fixture(live(ARCHIVE.archiveVersion));
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      yield* manager.ensureEnvironment(uploadTarget, { keyOnly: true });
      const gate = {
        entered: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
      f.gateReadiness(gate);
      const reuse = yield* manager
        .ensureEnvironment(uploadTarget, { keyOnly: true, reuseWhileRefreshPending: true })
        .pipe(Effect.forkChild);
      yield* Deferred.await(gate.entered);
      const during = successfulStatus(yield* manager.status(uploadTarget));
      assert.equal(during.state, "ready");
      assert.equal(during.runtimeVersion, ARCHIVE.archiveVersion);
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(reuse);
      assert.equal(f.calls.launches, 1);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect(
    "an app connects to a newer runtime that speaks its protocols and reports it ready",
    () => {
      const f = fixture(live("99.0.0"));
      f.setLaunchVersion("99.0.0");
      return Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.ensureEnvironment(uploadTarget, { keyOnly: true });
        const status = successfulStatus(yield* manager.status(uploadTarget));
        assert.equal(status.state, "ready");
        assert.equal(status.runtimeVersion, "99.0.0");
        assert.isUndefined(status.detail);
        yield* manager.readyEnvironment(uploadTarget);
        assert.equal(f.calls.uploads, 0);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    },
  );

  it.effect(
    "a forward whose server was replaced on the same port reconnects to the live build without updating again",
    () => {
      const f = fixture(live("1.2.2"), { refreshOwnedRuntimeOnFirstConnection: false });
      f.setLaunchVersion("1.2.2");
      return Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.ensureEnvironment(uploadTarget, { keyOnly: true });
        assert.equal(f.calls.launches, 1);
        // Another client (or a person) replaced 1.2.2 with this app's build on the same port.
        f.setProbe(live(ARCHIVE.archiveVersion));
        f.setLaunchVersion(ARCHIVE.archiveVersion);
        f.setDescriptorVersion(ARCHIVE.archiveVersion);
        yield* manager.ensureEnvironment(uploadTarget, {
          keyOnly: true,
          reuseWhileRefreshPending: true,
        });
        assert.equal(f.calls.launches, 2);
        assert.equal(f.calls.uploads, 0);
        const after = successfulStatus(yield* manager.status(uploadTarget));
        assert.equal(after.state, "ready");
        assert.equal(after.runtimeVersion, ARCHIVE.archiveVersion);
        // Matching the live build again, the next call reuses the forward.
        yield* manager.ensureEnvironment(uploadTarget, {
          keyOnly: true,
          reuseWhileRefreshPending: true,
        });
        assert.equal(f.calls.launches, 2);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    },
  );

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
          milestones
            .map((step) => step.phase)
            .filter((phase, index, phases) => phase !== phases[index - 1]),
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

  it.effect.each(["linux", "win32"] as const)(
    "publishes throttled archive counters for a %s upload and clears them on launch",
    (platform) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-upload-progress-" });
        const totalBytes = 3 * 1024 * 1024 + 13;
        yield* fs.writeFile(
          `${directory}/${cliArchiveFileName(ARCHIVE.archiveVersion, `${platform}-x64`)}`,
          new Uint8Array(totalBytes),
        );
        const uploaded = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const f = fixture(
          { ...stopped, platform },
          { archiveDirectory: directory },
          Deferred.succeed(uploaded, undefined).pipe(Effect.andThen(Deferred.await(resume))),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          const progress: SshTunnel.SshRuntimeProgress[] = [];
          const fiber = yield* manager
            .ensureEnvironment(uploadTarget, {
              onPhase: (step) => progress.push(step),
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(uploaded);
          const status = yield* manager.status(uploadTarget);
          yield* decodeSshHostResult(status);
          assert.equal(status.status?.phase, "uploading");
          assert.deepEqual(status.status?.upload, { sentBytes: totalBytes, totalBytes });
          const updates = progress.flatMap((step) => step.upload ?? []);
          assert.deepEqual(updates[0], { sentBytes: 0, totalBytes });
          assert.deepEqual(updates.at(-1), { sentBytes: totalBytes, totalBytes });
          assert.isAtLeast(updates.length, 3);
          for (let index = 1; index < updates.length; index++) {
            const previous = updates[index - 1]!;
            const current = updates[index]!;
            assert.equal(current.totalBytes, totalBytes);
            assert.isAtMost(current.sentBytes, totalBytes);
            if (current.sentBytes !== totalBytes)
              assert.isAtLeast(current.sentBytes - previous.sentBytes, 1024 * 1024);
          }
          if (platform === "win32") {
            assert.isAbove(updates[1]!.sentBytes, 1024 * 1024);
            assert.isBelow(updates[1]!.sentBytes, 2 * 1024 * 1024);
          } else assert.equal(updates[1]!.sentBytes, 1024 * 1024);
          yield* Deferred.succeed(resume, undefined);
          yield* Fiber.join(fiber);
          assert.isUndefined((yield* manager.status(uploadTarget)).status?.upload);
          assert.isTrue(
            progress
              .filter((step) => step.phase !== "uploading")
              .every((step) => step.upload === undefined),
          );
        }).pipe(Effect.provide(f.layer), Effect.scoped);
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
    // A newer runtime that speaks this app's protocols serves it; nothing waits on an update.
    { version: "99.0.0", owned: true, expected: "ready" },
    { version: "99.0.0", owned: false, expected: "ready" },
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

  it.effect("blocks a newer runtime only when it no longer speaks this app's protocol", () => {
    const f = fixture({
      ...stopped,
      liveStatus: "live",
      liveVersion: "99.0.0",
      liveOwned: true,
      liveDrain: true,
      liveSignals: {
        ...signals("99.0.0"),
        orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION + 1,
      },
    });
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const status = successfulStatus(yield* manager.status(uploadTarget));
      assert.equal(status.state, "update_blocked");
      assert.include(status.detail ?? "", "runs a newer GOAT (99.0.0)");
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
    {
      stderr:
        "GOAT 1.2.3 on this host cannot open its data because a newer GOAT build already upgraded it. Update this app or the GOAT runtime on this host, then reconnect.",
      state: "failed",
      reason: "operation_failed",
      detail:
        "GOAT 1.2.3 on this host cannot open its data because a newer GOAT build already upgraded it. Update this app or the GOAT runtime on this host, then reconnect.",
      instruction: "Update this app or the GOAT runtime on devbox, then reconnect.",
    },
  ])("classifies an observed failure: $state/$reason", (input) => {
    const { stderr, state, reason } = input;
    const f = fixture(stopped);
    f.failProbe(stderr);
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const result = yield* manager.status(uploadTarget);
      yield* decodeSshHostResult(result);
      const status = successfulStatus(result);
      assert.equal(status.state, state);
      assert.equal(status.failure?.reason, reason);
      if ("detail" in input && typeof input.detail === "string")
        assert.include(status.detail ?? "", input.detail);
      if ("instruction" in input && typeof input.instruction === "string") {
        assert.equal(status.failure?.fix?.actor, "human");
        assert.equal(status.failure?.fix?.instruction, input.instruction);
      }
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

  it.effect.each([true, false])(
    "reconciles fallback and exact success even when drain=%s",
    (drain) => {
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
          liveDrain: drain,
          liveSignals: signals("1.2.2"),
          liveBinarySignals: signals("1.2.2"),
        });
        const result = yield* manager.status(uploadTarget);
        yield* decodeSshHostResult(result);
        const status = successfulStatus(result);
        assert.equal(status.state, "ready");
        assert.equal(status.runtimeVersion, "1.2.2");
        assert.equal(status.refreshDeferred?.requestedVersion, ARCHIVE.archiveVersion);
        assert.isUndefined(status.failure);
        f.setProbe({
          ...stopped,
          ready: true,
          liveStatus: "live",
          liveOwned: true,
          liveVersion: ARCHIVE.archiveVersion,
          liveSignals: signals(ARCHIVE.archiveVersion),
          liveBinarySignals: signals(ARCHIVE.archiveVersion),
        });
        const exact = yield* manager.status(uploadTarget);
        yield* decodeSshHostResult(exact);
        assert.equal(exact.status?.state, "ready");
        assert.isUndefined(exact.status?.refreshDeferred);
        assert.isUndefined(exact.status?.failure);
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
        const events = log.map(
          (line) => JSON.parse(line) as { type: string; args?: ReadonlyArray<string> },
        );
        // Every invocation is recorded as "exec"; status may only ask read-only questions.
        const readOnlyCalls = [
          ["--version"],
          ["__ssh-helper", "protocol"],
          ["__ssh-helper", "commit-time"],
          ["auth", "session", "issue", "--help"],
        ];
        for (const event of events) {
          if (event.type === "exec") {
            const args = event.args ?? [];
            assert.isTrue(
              readOnlyCalls.some((call) => call.every((arg, index) => args[index] === arg)),
              `unexpected status call: ${args.join(" ")}`,
            );
          } else {
            assert.include(["version", "protocol"], event.type);
          }
        }
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

it.effect.each([
  "Connection closed by UNKNOWN port 65535",
  "kex_exchange_identification: Connection closed by remote host",
  "kex_exchange_identification: Connection reset by remote host",
  "kex_exchange_identification: read: Connection reset by peer",
  'Dial("remote.invalid", 22): no such host',
  "dial tcp: lookup remote.invalid: no such host",
  "cloudflared: 404 Not Found\nConnection closed by UNKNOWN port 65535",
])("reports quiet unreachable runtime status for %s", (stderr) => {
  const f = fixture(stopped);
  f.failProbe(stderr);
  return Effect.gen(function* () {
    const manager = yield* SshTunnel.SshEnvironmentManager;
    const result = yield* manager.status(uploadTarget);
    assert.equal(result.kind, "error");
    if (result.kind === "error") assert.equal(result.code, "host_unreachable");
  }).pipe(Effect.provide(f.layer), Effect.scoped);
});

it.effect.each(["Tailscale is stopped.", "Logged out."])(
  "keeps the specific local proxy status: %s",
  (status) => {
    const f = fixture(stopped);
    f.failProbe(
      `debug1: kex_exchange_identification: banner line 0: ${status}\nConnection closed by UNKNOWN port 65535`,
    );
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const result = yield* manager.status(uploadTarget);
      assert.equal(result.kind, "error");
      if (result.kind === "error") {
        assert.equal(result.code, "operation_failed");
        assert.include(result.message, `Tailscale proxy status: ${status}`);
      }
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  },
);

it.effect.each(["stopped", "incompatible", "unverified-binary", "probe-failed"] as const)(
  "does not turn %s evidence into a ready archive deferral",
  (kind) => {
    const f = fixture(retained);
    f.setLaunchVersion("1.2.2");
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      yield* manager.ensureEnvironment(uploadTarget, { keyOnly: true });
      if (kind === "probe-failed") f.failProbe("Connection refused");
      f.setProbe(
        kind === "stopped"
          ? stopped
          : {
              ...stopped,
              liveStatus: "live",
              liveOwned: true,
              liveDrain: true,
              liveVersion: "1.2.2",
              liveSignals: {
                ...signals("1.2.2"),
                sshRuntimeProtocolVersion:
                  kind === "incompatible" ? 99 : SSH_RUNTIME_PROTOCOL_VERSION,
              },
              ...(kind === "unverified-binary" ? {} : { liveBinarySignals: signals("1.2.2") }),
            },
      );
      const result = yield* manager.status(uploadTarget);
      yield* decodeSshHostResult(result);
      assert.notEqual(result.status?.state, "ready");
      assert.isUndefined(result.status?.refreshDeferred);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  },
);

it.effect.each(
  (["older", "capability"] as const).flatMap((replacement) =>
    [false, true].map((drain) => ({ replacement, drain })),
  ),
)(
  "fresh status preserves $replacement drain deferral when drain becomes $drain",
  ({ replacement, drain }) => {
    const f = fixture({ ...stopped, ready: true }, { refreshOwnedRuntimeOnFirstConnection: true });
    const actualVersion = replacement === "capability" ? "1.2.3-dev.deadbeef" : "1.2.2";
    f.setLaunchVersion(actualVersion);
    f.setDrainPending(replacement);
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const operation = yield* manager.beginSetupOperation(uploadTarget, "drain-status");
      yield* manager.ensureEnvironment(uploadTarget);
      f.setProbe({
        ...stopped,
        ready: true,
        liveStatus: "live",
        liveOwned: true,
        liveDrain: drain,
        liveVersion: actualVersion,
        livePort: 3773,
        liveSignals: signals(actualVersion),
        liveBinarySignals: signals(actualVersion),
      });
      const fresh = yield* manager.status(uploadTarget);
      yield* decodeSshHostResult(fresh);
      assert.equal(fresh.status?.state, "ready");
      assert.equal(fresh.status?.runtimeVersion, actualVersion);
      assert.equal(fresh.status?.refreshDeferred?.refreshCause, "drain_unavailable");
      yield* manager.publishProviderDiagnosis(uploadTarget, operation, {
        checkedAt: "2026-10-18T00:00:00.000Z",
        ready: false,
        fixes: [{ actor: "human", instruction: "Sign in" }],
      });
      const diagnosed = yield* manager.status(uploadTarget);
      assert.equal(diagnosed.status?.state, "providers_not_ready");
      assert.equal(diagnosed.status?.refreshDeferred?.refreshCause, "drain_unavailable");
      yield* manager.readyEnvironment(uploadTarget);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  },
);

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "live no-drain attachment status",
  () => {
    it.live("pending ownership loss requires fresh proof before reusing the attachment", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: "1.2.2",
          ssh: SSH_RUNTIME_PROTOCOL_VERSION,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        });
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          const first = yield* manager.ensureEnvironment(uploadTarget, { keyOnly: true });
          assert.notProperty(first, "type");
          f.setBeforeCommand((script) =>
            script.includes('IDENTITY_NEXT="$STATE_DIR/identity.next.$$"')
              ? f.fs.writeFileString(`${f.test}/pending-proof`, "ownership-loss")
              : Effect.void,
          );
          const rejected = yield* manager.ensureEnvironment(uploadTarget, {
            keyOnly: true,
            refreshRuntime: true,
          });
          assert.property(rejected, "type");
          assert.equal((yield* f.fs.readFileString(`${f.state}/managed`)).trim(), "external");
          assert.isTrue(
            Result.isFailure(yield* Effect.result(manager.readyEnvironment(uploadTarget))),
          );
          const launches = () =>
            f.remoteCommands.filter(
              (command) => command._tag === "StandardCommand" && isRemoteLaunch(command.args),
            ).length;
          const beforeReuse = launches();
          const reused = yield* manager.ensureEnvironment(uploadTarget, {
            keyOnly: true,
            reuseWhileRefreshPending: true,
          });
          assert.notProperty(reused, "type");
          if ("type" in reused) throw new Error("Expected freshly verified runtime");
          assert.equal(launches(), beforeReuse + 1);
          assert.isUndefined(reused.pendingReplacement);
          assert.isTrue(
            Result.isFailure(yield* Effect.result(manager.readyEnvironment(uploadTarget))),
          );
          assert.isTrue(
            Result.isFailure(
              yield* Effect.result(
                manager.issueMcpClientSession(uploadTarget, {
                  requireReady: true,
                  label: "ownership-loss",
                  ttl: "1h",
                  runtimeModeCeiling: null,
                }),
              ),
            ),
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              SshTunnel.SshEnvironmentManager.layer({
                resolveCliRunner: Effect.succeed({
                  ...f.runner,
                  refreshOwnedRuntimeOnFirstConnection: true,
                }),
                leaveRemoteServerRunning: true,
              }),
              SshAuth.SshPasswordPrompt.disabledLayer,
              Layer.succeed(NetService.NetService, testNetService),
              Layer.succeed(HttpClient.HttpClient, testHttpClient),
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, f.transport),
            ),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
    it.live("busy runtime admission survives diagnosis and agent sessions", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: "1.2.2",
          ssh: SSH_RUNTIME_PROTOCOL_VERSION,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        });
        yield* f.fs.writeFileString(`${f.test}/activity`, "busy");
        const before = yield* f.snapshot;
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          const operation = yield* manager.beginSetupOperation(uploadTarget, "real-drain-status");
          const connected = yield* manager.ensureEnvironment(uploadTarget, { keyOnly: true });
          if ("type" in connected) throw new Error("Expected live attachment");
          assert.equal(connected.remotePort, f.port);
          assert.equal(connected.pendingReplacement?.refreshCause, "drain_unavailable");
          const fresh = yield* manager.status(uploadTarget);
          yield* decodeSshHostResult(fresh);
          assert.equal(fresh.status?.state, "ready");
          assert.equal(fresh.status?.refreshDeferred?.refreshCause, "drain_unavailable");
          yield* manager.publishProviderDiagnosis(
            uploadTarget,
            operation,
            yield* decodeProviders({
              checkedAt: "2026-10-18T00:00:00.000Z",
              ready: false,
              fixes: [{ actor: "human", instruction: "Sign in" }],
            }),
          );
          const diagnosed = yield* manager.status(uploadTarget);
          assert.equal(diagnosed.status?.state, "providers_not_ready");
          assert.equal(diagnosed.status?.runtimeVersion, "1.2.2");
          assert.equal(diagnosed.status?.refreshDeferred?.refreshCause, "drain_unavailable");
          const session = yield* manager.issueMcpClientSession(uploadTarget, {
            requireReady: true,
            label: "diagnose",
            ttl: "1h",
            runtimeModeCeiling: null,
          });
          assert.equal(session.token, "1.2.2");
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              SshTunnel.SshEnvironmentManager.layer({
                resolveCliRunner: Effect.succeed({
                  ...f.runner,
                  refreshOwnedRuntimeOnFirstConnection: true,
                }),
                leaveRemoteServerRunning: true,
              }),
              SshAuth.SshPasswordPrompt.disabledLayer,
              Layer.succeed(NetService.NetService, testNetService),
              Layer.succeed(HttpClient.HttpClient, testHttpClient),
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, f.transport),
            ),
          ),
        );
        assert.deepEqual(yield* f.snapshot, before);
        const events = yield* f.fs.readFileString(`${f.test}/events`);
        for (const type of ["drain", "drain-request", "supervise", "self-stop", "stop", "activity"])
          assert.notInclude(events, `"type":"${type}"`);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
