import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NetService from "@goat/shared/Net";
import { ORCHESTRATION_PROTOCOL_VERSION, IsoDateTime, SshHostResult } from "@goat/contracts";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import * as ConfigProvider from "effect/ConfigProvider";
import * as FileSystem from "effect/FileSystem";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import { lazyChildProcessSpawner } from "@goat/shared/testing/lazyChildProcessSpawner";
import * as SshAuth from "./auth.ts";
import * as SshTunnel from "./tunnel.ts";
import {
  ARCHIVE,
  isRemoteLaunch,
  makeSuccessfulProcess,
  makeRunningProcess,
  testNetService,
  uploadTarget,
} from "./tunnel.fixture.ts";

const decodeHostResult = Schema.decodeEffect(SshHostResult);
const operationDate = Schema.decodeSync(IsoDateTime)("2026-10-18T00:00:00.000Z");
const pending = {
  reason: "busy",
  replacement: "incompatible",
  requestedVersion: ARCHIVE.archiveVersion,
  liveVersion: "1.2.2",
} as const;
const drainPending = {
  ...pending,
  reason: "unknown",
  replacement: "older",
  refreshCause: "drain_unavailable",
} as const;
const ready = {
  status: "ready",
  selectedVersion: ARCHIVE.archiveVersion,
  remotePort: 3773,
  serverKind: "managed",
  refresh: "replaced",
} as const;
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-managed-pin-" });
  const directory = `${home}/.ssh/goat-hosts`;
  const confPath = `${directory}/devbox.conf`;
  const pinPath = `${directory}/devbox.known_hosts`;
  const installPin = (key = "AAAA") =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(pinPath, `devbox ssh-ed25519 ${key}\n`);
      yield* fs.writeFileString(
        confPath,
        `Host devbox\n  HostName devbox.example.com\n  User alex\n  Port 2222\n  HostKeyAlias devbox\n  UserKnownHostsFile "${pinPath}"\n  GlobalKnownHostsFile /dev/null\n  StrictHostKeyChecking yes\n  UpdateHostKeys no\n  HostKeyAlgorithms ssh-ed25519\n`,
      );
    });
  const forwarded = yield* Deferred.make<void>();
  const staleProbeEntered = yield* Deferred.make<void>();
  const launchEntered = yield* Deferred.make<void>();
  const releaseLaunch = yield* Deferred.make<void>();
  const count = { launches: 0, forwards: 0, pairings: 0, stops: 0, kills: 0, prompts: 0 };
  let mode:
    | "pending"
    | "ready-pending"
    | "drain-attached"
    | "drain-pending"
    | "ready"
    | "ready-reused"
    | "older-attached"
    | "blocked"
    | "timeout"
    | "failure"
    | "archive"
    | "attached" = "pending";
  let stale = false;
  let resolutionFails = false;
  let pairingFails = false;
  let stopFails = false;
  let forwardFails = false;
  let versionNewer = false;
  let liveProbe = false;
  let probeOverrides: Record<string, unknown> = {};
  let forwardRunning = true;
  let forwardStateGate:
    | { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> }
    | undefined;
  let probeGate: { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | undefined;
  let archiveUnavailable = false;
  let requestedVersion: string = ARCHIVE.archiveVersion;
  const completed = Array.from({ length: 8 }, () => Deferred.makeUnsafe<void>());
  let completedCount = 0;
  const published = Array.from({ length: 16 }, () => Deferred.makeUnsafe<void>());
  let publishedCount = 0;
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (at, exit) => {
        end(at, exit);
        if (options.name === "ssh/tunnel.publishResult") {
          const milestone = published[publishedCount++];
          if (milestone) Deferred.doneUnsafe(milestone, Effect.void);
        }
        if (options.name === "ssh/tunnel.ensureTunnelEntry") {
          const milestone = completed[completedCount++];
          if (milestone) Deferred.doneUnsafe(milestone, Effect.void);
        }
      };
      return span;
    },
  });
  const launchScripts: string[] = [];
  const sshCalls: Array<ReadonlyArray<string>> = [];
  // One-shot: the next alias resolution waits until the test releases it.
  let resolutionGate: {
    entered: Deferred.Deferred<void>;
    release: Deferred.Deferred<void>;
  } | null = null;
  const spawner = lazyChildProcessSpawner((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected command");
      sshCalls.push(command.args);
      if (command.args.includes("-G")) {
        const gate = resolutionGate;
        resolutionGate = null;
        if (gate !== null) {
          yield* Deferred.succeed(gate.entered, undefined);
          yield* Deferred.await(gate.release);
        }
        if (resolutionFails)
          return {
            ...makeSuccessfulProcess(""),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
          };
        return makeSuccessfulProcess(
          "hostname devbox.example.com\nuser alex\nport 2222\n" +
            ((yield* fs.exists(confPath))
              ? `hostkeyalias devbox\nuserknownhostsfile ${pinPath}\nglobalknownhostsfile /dev/null\nstricthostkeychecking yes\nupdatehostkeys no\nhostkeyalgorithms ssh-ed25519\n`
              : ""),
        );
      }
      if (command.args.includes("-N")) {
        count.forwards++;
        yield* Deferred.succeed(forwarded, undefined);
        return {
          ...makeRunningProcess(() => count.kills++),
          isRunning: Effect.gen(function* () {
            const gate = forwardStateGate;
            forwardStateGate = undefined;
            if (gate !== undefined) {
              yield* Deferred.succeed(gate.entered, undefined);
              yield* Deferred.await(gate.release);
            }
            return forwardRunning;
          }),
        };
      }
      const input = command.options.stdin;
      const script =
        input !== undefined &&
        typeof input === "object" &&
        "stream" in input &&
        Stream.isStream(input.stream)
          ? yield* input.stream.pipe(Stream.decodeText(), Stream.mkString)
          : "";
      if (script.includes("ready=false") && !isRemoteLaunch(command.args)) {
        const gate = probeGate;
        probeGate = undefined;
        const capturedOverrides = { ...probeOverrides };
        if (gate !== undefined) {
          yield* Deferred.succeed(gate.entered, undefined);
          yield* Deferred.await(gate.release);
        }
        return makeSuccessfulProcess(
          JSON.stringify({
            platform: "linux",
            arch: "x64",
            ready: !archiveUnavailable,
            ...(liveProbe
              ? {
                  liveStatus: "live",
                  liveVersion: "1.2.2",
                  livePort: 3773,
                  liveOwned: true,
                  liveDrain: true,
                  liveSignals: {
                    serverVersion: "1.2.2",
                    sshRuntimeProtocolVersion: SSH_RUNTIME_PROTOCOL_VERSION,
                    orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
                  },
                  liveBinarySignals: {
                    serverVersion: "1.2.2",
                    sshRuntimeProtocolVersion: SSH_RUNTIME_PROTOCOL_VERSION,
                    orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
                  },
                }
              : {}),
            ...capturedOverrides,
          }),
        );
      }
      if (script.includes("\nset -- auth session issue --base-dir "))
        return makeSuccessfulProcess('{"token":"agent-session","expiresAt":null}');
      if (script.includes("auth pairing create")) {
        count.pairings++;
        return pairingFails
          ? {
              ...makeSuccessfulProcess(""),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
            }
          : makeSuccessfulProcess('{"credential":"pairing"}');
      }
      if (script.includes('"stopped":true')) {
        count.stops++;
        if (stopFails)
          return {
            ...makeSuccessfulProcess(""),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
          };
        return makeSuccessfulProcess('{"stopped":true}');
      }
      count.launches++;
      launchScripts.push(script);
      if (versionNewer)
        return {
          ...makeSuccessfulProcess(""),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
          stderr: Stream.make(
            new TextEncoder().encode(
              "Warning: Permanently added fixture.\nRemote runtime is newer than this app; update the app.",
            ),
          ),
        };
      if (mode === "timeout") {
        yield* Deferred.succeed(launchEntered, undefined);
        return { ...makeSuccessfulProcess(""), exitCode: Effect.never };
      }
      if (mode === "failure")
        return {
          ...makeSuccessfulProcess(""),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
        };
      if (mode === "blocked") {
        yield* Deferred.succeed(launchEntered, undefined);
        yield* Deferred.await(releaseLaunch);
      }
      return makeSuccessfulProcess(
        JSON.stringify(
          mode === "drain-pending"
            ? { status: "pending", pending: drainPending }
            : mode === "drain-attached"
              ? { ...ready, selectedVersion: "1.2.2", refresh: undefined, pending: drainPending }
              : mode === "ready-reused"
                ? { ...ready, refresh: undefined }
                : mode === "older-attached"
                  ? {
                      ...ready,
                      selectedVersion: "1.2.2",
                      refresh: undefined,
                      pending: { ...pending, replacement: "older" },
                    }
                  : mode === "pending"
                    ? { status: "pending", pending }
                    : mode === "ready-pending"
                      ? { ...ready, selectedVersion: "1.2.2", refresh: undefined, pending }
                      : mode === "archive" || mode === "attached"
                        ? { ...ready, selectedVersion: "1.2.2", refresh: undefined }
                        : ready,
        ),
      );
    }),
  );
  const layer = Layer.mergeAll(
    NodeServices.layer,
    ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home })),
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        stale
          ? Deferred.succeed(staleProbeEntered, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
      ),
    ),
    Layer.succeed(NetService.NetService, {
      ...testNetService,
      reserveLoopbackPort: () =>
        forwardFails
          ? Effect.fail(new NetService.NetError({ message: "fixture port failure" }))
          : testNetService.reserveLoopbackPort(),
    }),
    Layer.succeed(SshAuth.SshPasswordPrompt, {
      isAvailable: true,
      request: () =>
        Effect.sync(() => {
          count.prompts++;
          return "password";
        }),
    }),
    SshTunnel.SshEnvironmentManager.layer({
      resolveCliRunner: Effect.sync(() => ({
        ...ARCHIVE,
        archiveVersion: requestedVersion,
        archiveDirectory: "",
        refreshOwnedRuntimeOnFirstConnection: true,
      })),
    }),
  );
  return {
    layer,
    home,
    confPath,
    pinPath,
    installPin,
    count,
    completed,
    published,
    tracer,
    launchScripts,
    sshCalls,
    setRequestedVersion: (value: string) => {
      requestedVersion = value;
    },
    setProbe: (value: Record<string, unknown>) => {
      probeOverrides = value;
    },
    setForwardRunning: (value: boolean) => {
      forwardRunning = value;
    },
    holdNextForwardState: Effect.gen(function* () {
      const gate = { entered: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
      forwardStateGate = gate;
      return gate;
    }),
    holdNextProbe: Effect.gen(function* () {
      const gate = { entered: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
      probeGate = gate;
      return gate;
    }),
    useLiveProbe: () => {
      liveProbe = true;
    },
    forwarded,
    staleProbeEntered,
    launchEntered,
    releaseLaunch,
    setMode: (value: typeof mode) => {
      mode = value;
      archiveUnavailable = value === "archive";
      if (archiveUnavailable || value.startsWith("drain-")) liveProbe = true;
    },
    setStale: (value: boolean) => {
      stale = value;
    },
    failResolution: () => {
      resolutionFails = true;
    },
    failForward: (value: boolean) => {
      forwardFails = value;
    },
    refuseNewer: () => {
      versionNewer = true;
    },
    failStop: () => {
      stopFails = true;
    },
    failPairing: (value: boolean) => {
      pairingFails = value;
    },
    holdNextResolution: Effect.gen(function* () {
      const gate = { entered: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
      resolutionGate = gate;
      return gate;
    }),
  };
}).pipe(Effect.provide(NodeServices.layer));

describe("SSH pending replacement reconciliation", () => {
  it.effect("cold contention keeps its retry deadline when the older runtime is attached", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.useLiveProbe();
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const first = yield* manager.ensureEnvironment(uploadTarget);
        assert.isTrue("type" in first);
        yield* TestClock.adjust("9 minutes");
        f.setMode("attached");
        const attached = yield* manager.ensureEnvironment(uploadTarget);
        if ("type" in attached) throw new Error("Expected attached older runtime");
        assert.deepEqual(attached.pendingReplacement, pending);
        f.setMode("ready");
        yield* TestClock.adjust("1 minute");
        yield* Deferred.await(f.completed[2]!);
        assert.equal(f.count.launches, 3);
      }).pipe(
        Effect.provide(f.layer),
        Effect.provideService(Tracer.Tracer, f.tracer),
        Effect.scoped,
      );
    }),
  );

  it.effect.each(["pending", "failure"] as const)(
    "%s after attachment requires revalidation before any cached reuse",
    (outcome) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.setMode("ready-pending");
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          yield* manager.ensureEnvironment(uploadTarget);
          f.setMode(outcome);
          yield* TestClock.adjust("10 minutes");
          yield* Deferred.await(f.completed[1]!);
          f.setMode("pending");
          const result = yield* manager.ensureEnvironment(uploadTarget, {
            reuseWhileRefreshPending: true,
          });
          assert.isTrue("type" in result);
          assert.equal(f.count.launches, 3);
          assert.equal(f.count.forwards, 1);
        }).pipe(
          Effect.provide(f.layer),
          Effect.provideService(Tracer.Tracer, f.tracer),
          Effect.scoped,
        );
      }),
  );

  it.effect("forget still closes its tunnel and reports an unconfirmed remote stop", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setMode("ready");
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.ensureEnvironment(uploadTarget);
        f.failStop();
        const result = yield* manager.forgetEnvironment(uploadTarget, { stopRuntime: "if_idle" });
        assert.equal(result.status?.state, "untrusted");
        assert.equal(result.status?.detail, "Runtime stop was not confirmed.");
        assert.equal(f.count.kills, 1);
        assert.equal(f.count.stops, 1);
        assert.equal((yield* manager.status(uploadTarget)).status?.detail, result.status?.detail);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.each(["no", "if_idle"] as const)(
    "forget %s fences blocked launch and late publications before releasing it",
    (stopRuntime) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.setMode("blocked");
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          const operation = yield* manager.beginSetupOperation(uploadTarget, "blocked-setup");
          const launch = yield* Effect.forkChild(
            Effect.result(manager.ensureEnvironment(uploadTarget)),
          );
          yield* Deferred.await(f.launchEntered);
          assert.isFalse(
            yield* manager.publishSetupOutcome(uploadTarget, operation, { kind: "complete" }),
          );
          const forget = yield* Effect.forkChild(
            manager.forgetEnvironment(uploadTarget, { stopRuntime }),
          );
          yield* TestClock.adjust(0);
          assert.equal((yield* manager.status(uploadTarget)).status?.state, "untrusted");
          assert.isFalse(
            yield* manager.publishSetupOutcome(uploadTarget, operation, {
              kind: "error",
              reason: "diagnosis_failed",
              message: "Old result",
              fix: { actor: "agent", instruction: "Try again" },
            }),
          );
          assert.isFalse(
            yield* manager.publishProviderDiagnosis(uploadTarget, operation, {
              checkedAt: operationDate,
              ready: true,
              fixes: [],
            }),
          );
          assert.isTrue(
            Result.isFailure(yield* Effect.result(manager.readyEnvironment(uploadTarget))),
          );
          assert.equal(f.count.forwards, 0);
          yield* Deferred.succeed(f.releaseLaunch, undefined);
          assert.isTrue(Result.isFailure(yield* Fiber.join(launch)));
          yield* Fiber.join(forget);
          assert.equal((yield* manager.status(uploadTarget)).status?.state, "untrusted");
          yield* TestClock.adjust("20 minutes");
          assert.equal(f.count.launches, 1);
          assert.equal(f.count.forwards, 0);
          assert.equal(f.count.stops, stopRuntime === "no" ? 0 : 1);
        }).pipe(Effect.provide(f.layer), Effect.scoped);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("ready-only session admission fails before a blocked installation finishes", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setMode("blocked");
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const launch = yield* Effect.forkChild(manager.ensureEnvironment(uploadTarget));
        yield* Deferred.await(f.launchEntered);
        assert.isTrue(
          Result.isFailure(yield* Effect.result(manager.readyEnvironment(uploadTarget))),
        );
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
        assert.equal(f.count.pairings, 0);
        assert.equal(f.count.launches, 1);
        f.setMode("ready");
        yield* Deferred.succeed(f.releaseLaunch, undefined);
        yield* Fiber.join(launch);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.each(
    ["key", "conf-missing", "pin-missing", "mtime"].flatMap((change) => [
      { change, archive: false },
      { change, archive: true },
    ]),
  )(
    "managed retry drops its old snapshot after $change changes (archive=$archive)",
    ({ change, archive }) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        if (archive) f.setMode("archive");
        yield* f.installPin();
        const fs = yield* FileSystem.FileSystem;
        const invalidated = yield* Deferred.make<void>();
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options);
            const end = span.end.bind(span);
            span.end = (at, exit) => {
              end(at, exit);
              if (options.name === "ssh/tunnel.publishFailure")
                Deferred.doneUnsafe(invalidated, Effect.void);
            };
            return span;
          },
        });
        yield* Effect.gen(function* () {
          const desktop = yield* SshTunnel.SshEnvironmentManager;
          yield* desktop.ensureEnvironment(uploadTarget);
          assert.equal(
            (yield* desktop.status(uploadTarget)).status?.state,
            archive ? "ready" : "update_waiting",
          );
          // An independent server manager forgets while Desktop keeps its pending retry.
          yield* Effect.gen(function* () {
            const server = yield* SshTunnel.SshEnvironmentManager;
            yield* server.forgetEnvironment(uploadTarget, { stopRuntime: "no" });
          }).pipe(Effect.provide(SshTunnel.SshEnvironmentManager.layer()), Effect.scoped);
          const beforeRetry = f.sshCalls.length;
          if (change === "key") yield* f.installPin("AAAB");
          else if (change === "conf-missing") yield* fs.remove(f.confPath);
          else if (change === "pin-missing") yield* fs.remove(f.pinPath);
          else yield* fs.utimes(f.confPath, 0, 0);
          f.setMode("ready");
          yield* TestClock.adjust("10 minutes");
          yield* Deferred.await(invalidated);
          const result = yield* desktop.status(uploadTarget);
          assert.equal(result.status?.state, change === "key" ? "failed" : "untrusted");
          assert.equal(
            result.status?.failure?.reason,
            change === "key" ? "host_key_changed" : undefined,
          );
          assert.equal(f.count.launches, 1);
          assert.equal(f.count.forwards, archive ? 1 : 0);
          assert.equal(f.count.stops, 0);
          assert.equal(f.sshCalls.length, beforeRetry);
        }).pipe(
          Effect.provide(f.layer),
          Effect.provideService(Tracer.Tracer, tracer),
          Effect.scoped,
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "manual refresh runs after the first connection decision and bypasses pending-forward reuse",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.setMode("ready");
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          yield* manager.ensureEnvironment(uploadTarget);
          yield* manager.ensureEnvironment(uploadTarget);
          assert.equal(f.count.launches, 1);
          f.useLiveProbe();
          f.setMode("ready-pending");
          yield* manager.ensureEnvironment(uploadTarget, { refreshRuntime: true });
          assert.equal(f.count.launches, 2);
          assert.include(f.launchScripts[1]!, "REFRESH_IF_IDLE=1");
          assert.include(f.launchScripts[1]!, "DRAIN_AUTOMATIC=0");
          f.setMode("ready");
          yield* manager.ensureEnvironment(uploadTarget, {
            refreshRuntime: true,
            reuseWhileRefreshPending: true,
          });
          assert.equal(f.count.launches, 3);
        }).pipe(Effect.provide(f.layer), Effect.scoped);
      }),
  );

  it.effect.each(["ready", "older-attached", "drain-attached"] as const)(
    "status cannot revive a tunnel after a failed refresh (initial=%s)",
    (initial) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.setMode(initial);
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          yield* manager.ensureEnvironment(uploadTarget);
          if (initial === "drain-attached")
            assert.equal(
              (yield* manager.status(uploadTarget)).status?.refreshDeferred?.refreshCause,
              "drain_unavailable",
            );
          f.useLiveProbe();
          f.setMode("failure");
          assert.isTrue(
            Result.isFailure(
              yield* Effect.result(
                manager.ensureEnvironment(uploadTarget, { refreshRuntime: true }),
              ),
            ),
          );
          assert.isTrue(
            Result.isFailure(yield* Effect.result(manager.readyEnvironment(uploadTarget))),
          );
          const uncertain = yield* manager.status(uploadTarget);
          assert.equal(uncertain.status?.state, "update_blocked");
          assert.isUndefined(uncertain.status?.refreshDeferred);
          assert.isTrue(
            Result.isFailure(yield* Effect.result(manager.readyEnvironment(uploadTarget))),
          );
          assert.isTrue(
            Result.isFailure(
              yield* Effect.result(
                manager.issueMcpClientSession(uploadTarget, {
                  requireReady: true,
                  label: "fixture",
                  ttl: "1h",
                  runtimeModeCeiling: null,
                }),
              ),
            ),
          );
          const attempts = f.count.launches;
          f.setMode("ready-reused");
          yield* manager.ensureEnvironment(uploadTarget);
          assert.equal(f.count.launches, attempts + 1);
          if (initial === "ready") assert.equal(f.count.forwards, 1);
          assert.equal((yield* manager.status(uploadTarget)).status?.state, "ready");
          yield* manager.readyEnvironment(uploadTarget);
          yield* manager.issueMcpClientSession(uploadTarget, {
            requireReady: true,
            label: "fixture",
            ttl: "1h",
            runtimeModeCeiling: null,
          });
        }).pipe(Effect.provide(f.layer), Effect.scoped);
      }),
  );

  it.effect(
    "compatible manual updates share preparation while status reads preparing without waiting",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.setMode("blocked");
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          const phases: string[] = [];
          const first = yield* Effect.forkChild(
            manager.ensureEnvironment(uploadTarget, {
              refreshRuntime: true,
              onPhase: ({ phase }) => {
                phases.push(phase);
              },
            }),
          );
          yield* Deferred.await(f.launchEntered);
          const firstStatus = yield* manager.status(uploadTarget);
          assert.equal(firstStatus.status?.state, "preparing");
          assert.equal(firstStatus.status?.phase, "checking");
          const gate = yield* f.holdNextResolution;
          const second = yield* Effect.forkChild(
            manager.ensureEnvironment(uploadTarget, { refreshRuntime: true }),
          );
          yield* Deferred.await(gate.entered);
          yield* Deferred.succeed(gate.release, undefined);
          assert.equal(f.count.launches, 1);
          assert.equal((yield* manager.status(uploadTarget)).status?.state, "preparing");
          f.setMode("ready");
          yield* Deferred.succeed(f.releaseLaunch, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(second);
          assert.equal(f.count.launches, 1);
          assert.deepEqual(phases, ["connecting", "checking", "starting"]);
        }).pipe(Effect.provide(f.layer), Effect.scoped);
      }),
  );

  it.effect("managed aliases coalesce explicit and implicit effective key-only policy", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.installPin();
      f.setMode("blocked");
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const first = yield* manager.ensureEnvironment(uploadTarget).pipe(Effect.forkChild);
        yield* Deferred.await(f.launchEntered);
        const observed = yield* Deferred.make<void>();
        let disposition: string | undefined;
        const second = yield* manager
          .ensureEnvironment(uploadTarget, {
            keyOnly: true,
            onPreparationAdmission: (admission) => {
              disposition = admission.disposition;
            },
            onPreparationProgress: () => {
              Deferred.doneUnsafe(observed, Exit.void);
            },
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(observed);
        assert.equal(disposition, "join");
        f.setMode("ready");
        yield* Deferred.succeed(f.releaseLaunch, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        assert.equal(f.count.launches, 1);
        assert.equal(f.count.prompts, 0);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }),
  );

  it.effect("a confirmed call never grants force or its observer to the background retry", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const phases: string[] = [];
        yield* manager.ensureEnvironment(uploadTarget, {
          refreshRuntime: true,
          confirmReplacement: true,
          onPhase: ({ phase }) => {
            phases.push(phase);
          },
        });
        assert.include(f.launchScripts[0]!, "DRAIN_FORCE=1");
        assert.include(f.launchScripts[0]!, "DRAIN_AUTOMATIC=0");
        assert.equal((yield* manager.status(uploadTarget)).status?.state, "update_waiting");
        const observed = [...phases];
        f.setMode("ready");
        yield* TestClock.adjust("10 minutes");
        yield* Deferred.await(f.forwarded);
        // This call waits out the in-flight retry and reuses its successful forward.
        yield* manager.ensureEnvironment(uploadTarget, { keyOnly: true });
        assert.equal(f.count.launches, 2);
        assert.include(f.launchScripts[1]!, "DRAIN_FORCE=0");
        assert.include(f.launchScripts[1]!, "DRAIN_AUTOMATIC=0");
        assert.deepEqual(phases, observed);
        assert.equal(f.count.prompts, 0);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }),
  );

  it.effect("a disconnect overtaken by a newer reconnect leaves the host connected", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setMode("ready");
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.ensureEnvironment(uploadTarget);
        // A completed off clears the cached resolution, so the next off resolves again.
        yield* manager.disconnectEnvironment(uploadTarget);
        // Off again: this disconnect stalls resolving the alias, before the target lock.
        const gate = yield* f.holdNextResolution;
        const disconnect = yield* Effect.forkChild(manager.disconnectEnvironment(uploadTarget));
        yield* Deferred.await(gate.entered);
        // Switch back on: the newer ensure reaches the lock first.
        yield* manager.ensureEnvironment(uploadTarget);
        yield* Deferred.succeed(gate.release, undefined);
        yield* Fiber.join(disconnect);
        // Only the first, completed off closed a forward and stopped the server.
        assert.equal(f.count.kills, 1);
        assert.equal(f.count.stops, 1);
        assert.equal(f.count.forwards, 2);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }),
  );

  it.effect("an older reconnect cannot relaunch a host after a newer disconnect", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setMode("ready");
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const gate = yield* f.holdNextResolution;
        const ensure = yield* Effect.forkChild(
          Effect.result(manager.ensureEnvironment(uploadTarget)),
        );
        yield* Deferred.await(gate.entered);
        yield* manager.disconnectEnvironment(uploadTarget);
        yield* Deferred.succeed(gate.release, undefined);
        assert.isTrue(Result.isFailure(yield* Fiber.join(ensure)));
        assert.equal(f.count.launches, 0);
        assert.equal(f.count.forwards, 0);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }),
  );

  it.effect.each(["replacement", "stale", "disconnect"] as const)(
    "interrupted %s close cannot leak a removed forward",
    (action) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.setMode(action === "replacement" ? "ready-pending" : "ready");
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          yield* manager.ensureEnvironment(uploadTarget);
          f.setMode("ready");
          if (action === "stale") f.setStale(true);
          let interrupt: (() => void) | undefined;
          let interrupted = false;
          const preparationFinished = yield* Deferred.make<void>();
          const tracer = Tracer.make({
            span(options) {
              if (!interrupted && options.name === "ssh/tunnel.closeTunnelEntry") {
                interrupted = true;
                f.setStale(false);
                interrupt?.();
              }
              const span = new Tracer.NativeSpan(options);
              const end = span.end.bind(span);
              span.end = (at, exit) => {
                end(at, exit);
                if (options.name === "ssh/tunnel.ensureTunnelEntry")
                  Deferred.doneUnsafe(preparationFinished, Exit.void);
              };
              return span;
            },
          });
          const closing = yield* Effect.withFiber((fiber) => {
            interrupt = () => fiber.interruptUnsafe();
            return action === "disconnect"
              ? manager.disconnectEnvironment(uploadTarget)
              : manager.ensureEnvironment(uploadTarget, {
                  refreshRuntime: action === "replacement",
                });
          }).pipe(Effect.provideService(Tracer.Tracer, tracer), Effect.forkChild);
          if (action === "stale") {
            // ssh -G and managed-pin checks now await real file I/O before the probe starts.
            yield* Deferred.await(f.staleProbeEntered);
            yield* TestClock.adjust("2 seconds");
          }
          assert.isTrue(Exit.isFailure(yield* Fiber.await(closing)));
          assert.isTrue(interrupted);
          if (action !== "disconnect") yield* Deferred.await(preparationFinished);
          assert.equal(f.count.kills, 1);
        }).pipe(Effect.provide(f.layer), Effect.scoped);
        assert.equal(f.count.kills, action === "disconnect" ? 1 : 2);
      }),
  );

  it.effect(
    "failed first connect creates no background retry or speculative disconnect exemption",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.setMode("failure");
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          assert.isTrue(
            Result.isFailure(yield* Effect.result(manager.ensureEnvironment(uploadTarget))),
          );
          f.setMode("ready");
          yield* TestClock.adjust("20 minutes");
          assert.equal(f.count.launches, 1);
          assert.equal(f.count.forwards, 0);
          yield* manager.disconnectEnvironment(uploadTarget);
          assert.equal(f.count.stops, 1);
        }).pipe(Effect.provide(f.layer), Effect.scoped);
      }),
  );

  it.effect("failed stale reconnect does not exempt the managed remote from disconnect stop", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setMode("ready");
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.ensureEnvironment(uploadTarget);
        f.setStale(true);
        f.setMode("failure");
        const reconnect = yield* Effect.forkChild(
          Effect.result(manager.ensureEnvironment(uploadTarget)),
        );
        yield* Deferred.await(f.staleProbeEntered);
        yield* TestClock.adjust("2 seconds");
        assert.isTrue(Result.isFailure(yield* Fiber.join(reconnect)));
        yield* manager.disconnectEnvironment(uploadTarget);
        assert.equal(f.count.stops, 1);
        assert.equal(f.count.kills, 1);
        yield* TestClock.adjust("20 minutes");
        assert.equal(f.count.launches, 2);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }),
  );

  it.effect("disconnect clears real intent after the alias no longer resolves", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.ensureEnvironment(uploadTarget);
        f.failResolution();
        yield* manager.disconnectEnvironment(uploadTarget);
        f.setMode("ready");
        yield* TestClock.adjust("20 minutes");
        assert.equal(f.count.launches, 1);
        assert.equal(f.count.stops, 0);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }),
  );

  it.effect("mid-interval intent retries within one minute of its own deadline", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setMode("failure");
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* Effect.result(manager.ensureEnvironment(uploadTarget));
        yield* TestClock.adjust(270_000);
        f.setMode("pending");
        yield* manager.ensureEnvironment(uploadTarget);
        f.setMode("ready");
        yield* TestClock.adjust("10 minutes");
        assert.equal(f.count.launches, 2);
        yield* TestClock.adjust("30 seconds");
        yield* Deferred.await(f.forwarded);
        assert.equal(f.count.launches, 3);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }),
  );

  it.effect.each(["ready", "pending"] as const)(
    "disconnect during a retry honors the real %s launch result",
    (result) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          yield* manager.ensureEnvironment(uploadTarget);
          f.setMode("blocked");
          const launch = yield* Effect.forkChild(
            Effect.result(manager.ensureEnvironment(uploadTarget)),
          );
          yield* Deferred.await(f.launchEntered);
          const disconnect = yield* Effect.forkChild(manager.disconnectEnvironment(uploadTarget));
          yield* TestClock.adjust(0);
          f.setMode(result);
          yield* Deferred.succeed(f.releaseLaunch, undefined);
          assert.isTrue(Result.isFailure(yield* Fiber.join(launch)));
          yield* Fiber.join(disconnect);
          assert.equal(f.count.stops, result === "ready" ? 1 : 0);
          yield* TestClock.adjust("20 minutes");
          assert.equal(f.count.launches, 2);
          assert.equal(f.count.forwards, 0);
        }).pipe(Effect.provide(f.layer), Effect.scoped);
      }),
  );

  it.effect("pending without a port creates no forward or credentials; reconnect settles it", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const first = yield* manager.ensureEnvironment(uploadTarget, { issuePairingToken: true });
        assert.equal("type" in first ? first.type : "ready", "ssh-runtime-pending");
        assert.equal(f.count.forwards, 0);
        assert.equal(f.count.pairings, 0);
        f.setMode("ready");
        const second = yield* manager.ensureEnvironment(uploadTarget, { issuePairingToken: true });
        assert.isFalse("type" in second);
        assert.equal(f.count.launches, 2);
        assert.equal(f.count.forwards, 1);
        assert.equal(f.count.pairings, 1);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }),
  );

  it.effect(
    "an agent connection reuses a healthy forward while a refresh waits for its retry",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.setMode("ready-pending");
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          const agent = { reuseWhileRefreshPending: true } as const;
          const first = yield* manager.ensureEnvironment(uploadTarget, agent);
          assert.isFalse("type" in first);
          const again = yield* manager.ensureEnvironment(uploadTarget, agent);
          assert.isFalse("type" in again);
          assert.equal(f.count.launches, 1);
          assert.equal(f.count.forwards, 1);
          // Foreground connections leave the original ten-minute refresh deadline intact.
          yield* TestClock.adjust("9 minutes");
          f.setMode("ready");
          yield* manager.ensureEnvironment(uploadTarget);
          assert.equal(f.count.launches, 1);
          yield* TestClock.adjust("1 minute");
          yield* Deferred.await(f.completed[3]!);
          assert.equal(f.count.launches, 2);
        }).pipe(
          Effect.provide(f.layer),
          Effect.provideService(Tracer.Tracer, f.tracer),
          Effect.scoped,
        );
      }),
  );

  it.effect("one scoped ten-minute retry uses noninteractive auth and caches its forward", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.ensureEnvironment(uploadTarget);
        f.setMode("ready");
        yield* TestClock.adjust("10 minutes");
        yield* Deferred.await(f.forwarded);
        const second = yield* manager.ensureEnvironment(uploadTarget);
        assert.isFalse("type" in second);
        assert.equal(f.count.launches, 2);
        assert.equal(f.count.prompts, 0);
        assert.equal(f.count.pairings, 0);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }),
  );

  it.effect("a ready connection reports the replacement its host scheduled until it lands", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setMode("ready-pending");
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const busy = yield* manager.ensureEnvironment(uploadTarget, { issuePairingToken: true });
        if ("type" in busy) throw new Error("Expected ready");
        assert.deepStrictEqual(busy.pendingReplacement, pending);
        assert.equal((yield* manager.status(uploadTarget)).status?.waitingReason, pending.reason);
        assert.equal(busy.remoteServerVersion, "1.2.2");

        f.setMode("ready");
        const replaced = yield* manager.ensureEnvironment(uploadTarget, {
          issuePairingToken: true,
          refreshRuntime: true,
        });
        if ("type" in replaced) throw new Error("Expected ready");
        assert.notProperty(replaced, "pendingReplacement");
        assert.equal(f.count.launches, 2);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }),
  );

  it.effect(
    "healthy cached entries reconcile intent after pairing failure and retain their local port",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.setMode("ready-pending");
        f.failPairing(true);
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          const failed = yield* Effect.result(
            manager.ensureEnvironment(uploadTarget, { issuePairingToken: true }),
          );
          assert.isTrue(Result.isFailure(failed));
          f.failPairing(false);
          f.setMode("ready");
          const replaced = yield* manager.ensureEnvironment(uploadTarget, {
            issuePairingToken: true,
            refreshRuntime: true,
          });
          if ("type" in replaced) throw new Error("Expected ready");
          assert.equal(replaced.httpBaseUrl, "http://127.0.0.1:41773/");
          assert.equal(f.count.forwards, 2);
          assert.equal(f.count.stops, 0);
          assert.equal(f.count.kills, 1);
          yield* manager.ensureEnvironment(uploadTarget);
          assert.equal(f.count.launches, 2);
        }).pipe(Effect.provide(f.layer), Effect.scoped);
      }),
  );

  it.effect("disconnect cancels intent and does not stop the busy remote", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.ensureEnvironment(uploadTarget);
        yield* manager.disconnectEnvironment(uploadTarget);
        f.setMode("ready");
        yield* TestClock.adjust("20 minutes");
        assert.equal(f.count.launches, 1);
        assert.equal(f.count.stops, 0);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
      assert.equal(f.count.stops, 0);
    }),
  );

  it.effect("cancelled in-flight launch cannot resurrect pending intent or forwarding", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setMode("blocked");
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const launch = yield* Effect.forkChild(
          Effect.result(manager.ensureEnvironment(uploadTarget)),
        );
        yield* Deferred.await(f.launchEntered);
        const disconnect = yield* Effect.forkChild(manager.disconnectEnvironment(uploadTarget));
        yield* TestClock.adjust(0);
        yield* Deferred.succeed(f.releaseLaunch, undefined);
        assert.isTrue(Result.isFailure(yield* Fiber.join(launch)));
        yield* Fiber.join(disconnect);
        yield* TestClock.adjust("20 minutes");
        assert.equal(f.count.forwards, 0);
        assert.equal(f.count.launches, 1);
        assert.equal(f.count.stops, 1);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }),
  );
  it.effect(
    "transport timeout retains only real intent and the queued retry settles without password prompts",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          yield* manager.ensureEnvironment(uploadTarget);
          f.setMode("timeout");
          const launch = yield* Effect.forkChild(
            Effect.result(manager.ensureEnvironment(uploadTarget)),
          );
          yield* Deferred.await(f.launchEntered);
          f.setMode("ready");
          yield* TestClock.adjust("15 minutes");
          assert.isTrue(Result.isFailure(yield* Fiber.join(launch)));
          yield* Deferred.await(f.forwarded);
          yield* manager.ensureEnvironment(uploadTarget);
          assert.equal(f.count.launches, 3);
          assert.equal(f.count.prompts, 0);
        }).pipe(Effect.provide(f.layer), Effect.scoped);
      }),
  );
  it.effect("forward admission failure retains intent for the ten-minute retry", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setMode("ready-pending");
      f.failForward(true);
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        assert.isTrue(
          Result.isFailure(yield* Effect.result(manager.ensureEnvironment(uploadTarget))),
        );
        f.failForward(false);
        f.setMode("ready");
        yield* TestClock.adjust("10 minutes");
        yield* Deferred.await(f.forwarded);
        yield* manager.ensureEnvironment(uploadTarget);
        assert.equal(f.count.launches, 2);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }),
  );

  it.effect("newer-incompatible refusal creates no replacement retry intent", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.ensureEnvironment(uploadTarget);
        f.refuseNewer();
        assert.isTrue(
          Result.isFailure(yield* Effect.result(manager.ensureEnvironment(uploadTarget))),
        );
        yield* TestClock.adjust("20 minutes");
        assert.equal(f.count.launches, 2);
        assert.equal(f.count.forwards, 0);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }),
  );
});

describe("SSH archive refresh retry", () => {
  it.effect(
    "waits ten minutes, renews a miss on the same forward, then clears on exact success",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.setMode("archive");
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          const agent = { keyOnly: true, reuseWhileRefreshPending: true } as const;
          const first = yield* manager.ensureEnvironment(uploadTarget, agent);
          assert.isFalse("type" in first);
          const status = (yield* manager.status(uploadTarget)).status;
          assert.equal(status?.state, "ready");
          assert.equal(status?.refreshDeferred?.reason, "archive_unavailable");
          yield* TestClock.adjust("9 minutes");
          yield* manager.ensureEnvironment(uploadTarget, agent);
          assert.equal(f.count.launches, 1);
          yield* TestClock.adjust("1 minute");
          yield* Deferred.await(f.completed[2]!);
          const second = yield* manager.ensureEnvironment(uploadTarget, agent);
          if ("type" in first || "type" in second)
            return yield* Effect.die("Expected ready attachments");
          assert.notEqual(second.attachmentId, first.attachmentId);
          assert.deepEqual({ ...second, attachmentId: first.attachmentId! }, first);
          assert.equal(f.count.launches, 2);
          assert.equal(f.count.forwards, 1);
          assert.equal(f.count.kills, 0);
          yield* TestClock.adjust("9 minutes");
          assert.equal(f.count.launches, 2);
          f.setMode("ready");
          yield* TestClock.adjust("1 minute");
          yield* Deferred.await(f.completed[4]!);
          const exact = yield* manager.ensureEnvironment(uploadTarget, agent);
          if ("type" in exact) throw new Error("Expected ready");
          assert.equal(exact.remoteServerVersion, ARCHIVE.archiveVersion);
          assert.isUndefined((yield* manager.status(uploadTarget)).status?.refreshDeferred);
          assert.equal(f.count.launches, 3);
          assert.equal(f.count.prompts, 0);
          assert.include(f.launchScripts[1]!, "DRAIN_FORCE=0");
        }).pipe(
          Effect.provide(f.layer),
          Effect.provideService(Tracer.Tracer, f.tracer),
          Effect.scoped,
        );
      }).pipe(Effect.scoped),
  );
  it.effect.each(["disconnect", "forget", "generation", "close"] as const)(
    "%s cancels archive retry",
    (action) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.setMode("archive");
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          yield* manager.ensureEnvironment(uploadTarget, { keyOnly: true });
          if (action === "disconnect") yield* manager.disconnectEnvironment(uploadTarget);
          if (action === "forget")
            yield* manager.forgetEnvironment(uploadTarget, { stopRuntime: "no" });
          if (action === "generation")
            yield* manager.beginSetupOperation(uploadTarget, "new-generation");
          if (action !== "close") {
            const calls = f.sshCalls.length;
            yield* TestClock.adjust("20 minutes");
            assert.equal(f.sshCalls.length, calls);
          }
        }).pipe(
          Effect.provide(f.layer),
          Effect.provideService(Tracer.Tracer, f.tracer),
          Effect.scoped,
        );
        const calls = f.sshCalls.length;
        yield* TestClock.adjust("20 minutes");
        assert.equal(f.sshCalls.length, calls);
        assert.equal(f.count.launches, 1);
        assert.equal(f.count.stops, action === "generation" ? 1 : 0);
        assert.equal(f.count.prompts, 0);
      }).pipe(Effect.scoped),
  );
  it.effect.each(["diagnosis_failed", "approval_expired", "authorization_revoked"] as const)(
    "%s removes deferred warning and cancels retry",
    (reason) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.setMode("archive");
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          const operation = yield* manager.beginSetupOperation(uploadTarget, "archive-setup");
          yield* manager.ensureEnvironment(uploadTarget, { keyOnly: true });
          if (reason === "diagnosis_failed") {
            yield* manager.publishProviderDiagnosis(uploadTarget, operation, {
              checkedAt: operationDate,
              ready: false,
              fixes: [{ actor: "human", instruction: "Sign in" }],
            });
            const providerStatus = yield* manager.status(uploadTarget);
            yield* decodeHostResult(providerStatus);
            assert.equal(providerStatus.status?.state, "providers_not_ready");
            assert.equal(providerStatus.status?.refreshDeferred?.reason, "archive_unavailable");
          }
          assert.isTrue(
            yield* manager.publishSetupOutcome(uploadTarget, operation, {
              kind: "error",
              reason,
              message: "Setup failed",
              fix: { actor: "human", instruction: "Try again" },
            }),
          );
          const result = yield* manager.status(uploadTarget);
          yield* decodeHostResult(result);
          assert.equal(result.status?.state, "failed");
          assert.equal(result.status?.failure?.reason, reason);
          assert.isUndefined(result.status?.refreshDeferred);
          const calls = f.sshCalls.length;
          yield* TestClock.adjust("20 minutes");
          assert.equal(f.sshCalls.length, calls);
          assert.equal(f.count.prompts, 0);
        }).pipe(
          Effect.provide(f.layer),
          Effect.provideService(Tracer.Tracer, f.tracer),
          Effect.scoped,
        );
      }).pipe(Effect.scoped),
  );
  it.effect("a background archive retry keeps provider diagnosis on the working host", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setMode("archive");
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const operation = yield* manager.beginSetupOperation(uploadTarget, "archive-setup");
        yield* manager.ensureEnvironment(uploadTarget, { keyOnly: true });
        yield* manager.publishProviderDiagnosis(uploadTarget, operation, {
          checkedAt: operationDate,
          ready: false,
          fixes: [{ actor: "human", instruction: "Sign in" }],
        });
        assert.equal((yield* manager.status(uploadTarget)).status?.state, "providers_not_ready");
        yield* TestClock.adjust("10 minutes");
        yield* Deferred.await(f.completed[1]!);
        assert.equal(f.count.launches, 2);
        const after = yield* manager.status(uploadTarget);
        yield* decodeHostResult(after);
        assert.equal(after.status?.state, "providers_not_ready");
        assert.equal(after.status?.providers?.ready, false);
        assert.equal(after.status?.refreshDeferred?.reason, "archive_unavailable");
      }).pipe(
        Effect.provide(f.layer),
        Effect.provideService(Tracer.Tracer, f.tracer),
        Effect.scoped,
      );
    }).pipe(Effect.scoped),
  );
});

it.effect("terminal setup failure fences an archive refresh already in flight", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.setMode("archive");
    yield* Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const operation = yield* manager.beginSetupOperation(uploadTarget, "fenced-setup");
      yield* manager.ensureEnvironment(uploadTarget, { keyOnly: true });
      f.setMode("blocked");
      yield* TestClock.adjust("10 minutes");
      yield* Deferred.await(f.launchEntered);
      assert.isTrue(
        yield* manager.publishSetupOutcome(uploadTarget, operation, {
          kind: "error",
          reason: "authorization_revoked",
          message: "Authorization revoked",
          fix: { actor: "human", instruction: "Authorize setup again" },
        }),
      );
      yield* Deferred.succeed(f.releaseLaunch, undefined);
      yield* Deferred.await(f.completed[1]!);
      const result = yield* manager.status(uploadTarget);
      yield* decodeHostResult(result);
      assert.equal(result.status?.state, "failed");
      assert.equal(result.status?.failure?.reason, "authorization_revoked");
      assert.isUndefined(result.status?.refreshDeferred);
      const calls = f.sshCalls.length;
      yield* TestClock.adjust("20 minutes");
      assert.equal(f.sshCalls.length, calls);
      assert.equal(f.count.launches, 2);
      assert.equal(f.count.forwards, 1);
      assert.equal(f.count.stops, 0);
      assert.equal(f.count.prompts, 0);
    }).pipe(Effect.provide(f.layer), Effect.provideService(Tracer.Tracer, f.tracer), Effect.scoped);
  }).pipe(Effect.scoped),
);
it.effect("archive recovery follows normal busy and idle replacement retries", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.setMode("archive");
    yield* Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const agent = { keyOnly: true, reuseWhileRefreshPending: true } as const;
      yield* manager.ensureEnvironment(uploadTarget, agent);
      f.setMode("ready-pending");
      yield* TestClock.adjust("10 minutes");
      yield* Deferred.await(f.completed[1]!);
      const busy = yield* manager.ensureEnvironment(uploadTarget, agent);
      if ("type" in busy) throw new Error("Expected ready");
      assert.equal(busy.remoteServerVersion, "1.2.2");
      assert.deepEqual(busy.pendingReplacement, pending);
      const status = yield* manager.status(uploadTarget);
      assert.equal(status.status?.state, "update_waiting");
      assert.isUndefined(status.status?.refreshDeferred);
      f.setMode("ready");
      yield* TestClock.adjust("10 minutes");
      yield* Deferred.await(f.completed[3]!);
      const idle = yield* manager.ensureEnvironment(uploadTarget, agent);
      if ("type" in idle) throw new Error("Expected ready");
      assert.equal(idle.remoteServerVersion, ARCHIVE.archiveVersion);
      assert.isUndefined(idle.pendingReplacement);
      assert.isUndefined((yield* manager.status(uploadTarget)).status?.refreshDeferred);
      assert.equal(f.count.prompts, 0);
      for (const script of f.launchScripts) assert.include(script, "DRAIN_FORCE=0");
    }).pipe(Effect.provide(f.layer), Effect.provideService(Tracer.Tracer, f.tracer), Effect.scoped);
  }).pipe(Effect.scoped),
);

describe("SSH drain-unavailable attachment", () => {
  it.effect.each([false, true])(
    "retries at ten minutes on the same forward; provider unhealthy=%s",
    (unhealthy) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.setMode("drain-attached");
        f.setProbe({ liveDrain: false });
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          const operation = yield* manager.beginSetupOperation(uploadTarget, "drain-setup");
          const agent = { keyOnly: true, reuseWhileRefreshPending: true } as const;
          const first = yield* manager.ensureEnvironment(uploadTarget, agent);
          if ("type" in first) throw new Error("Expected attachment");
          assert.deepEqual(first.pendingReplacement, drainPending);
          const initial = yield* manager.status(uploadTarget);
          yield* decodeHostResult(initial);
          assert.equal(initial.status?.state, "ready");
          assert.equal(initial.status?.runtimeVersion, "1.2.2");
          assert.equal(initial.status?.refreshDeferred?.refreshCause, "drain_unavailable");
          yield* manager.publishProviderDiagnosis(uploadTarget, operation, {
            checkedAt: operationDate,
            ready: !unhealthy,
            fixes: unhealthy ? [{ actor: "human", instruction: "Sign in" }] : [],
          });
          const afterDiagnosis = yield* manager.status(uploadTarget);
          assert.equal(afterDiagnosis.status?.state, unhealthy ? "providers_not_ready" : "ready");
          assert.equal(afterDiagnosis.status?.refreshDeferred?.refreshCause, "drain_unavailable");
          if (unhealthy)
            assert.equal(afterDiagnosis.status?.providers?.fixes[0]?.instruction, "Sign in");
          yield* manager.readyEnvironment(uploadTarget);
          const session = yield* manager.issueMcpClientSession(uploadTarget, {
            requireReady: true,
            label: "diagnosis",
            ttl: "1h",
            runtimeModeCeiling: null,
          });
          assert.equal(session.token, "agent-session");
          yield* TestClock.adjust("9 minutes");
          assert.equal(f.count.launches, 1);
          yield* TestClock.adjust("1 minute");
          yield* Deferred.await(f.published[1]!);
          const repeated = yield* manager.ensureEnvironment(uploadTarget, agent);
          if ("type" in first || "type" in repeated)
            return yield* Effect.die("Expected ready attachments");
          assert.notEqual(repeated.attachmentId, first.attachmentId);
          assert.deepEqual({ ...repeated, attachmentId: first.attachmentId! }, first);
          assert.equal(f.count.launches, 2);
          assert.equal(f.count.forwards, 1);
          assert.equal(f.count.kills, 0);
          assert.equal(f.count.stops, 0);
          f.setProbe({ liveDrain: true });
          const positive = yield* manager.status(uploadTarget);
          assert.equal(positive.status?.refreshDeferred?.refreshCause, "drain_unavailable");
          assert.equal(positive.status?.state, unhealthy ? "providers_not_ready" : "ready");
          yield* TestClock.adjust("9 minutes");
          assert.equal(f.count.launches, 2);
          f.setMode("ready");
          yield* TestClock.adjust("1 minute");
          yield* Deferred.await(f.published[3]!);
          f.setProbe({
            liveVersion: ARCHIVE.archiveVersion,
            liveSignals: {
              serverVersion: ARCHIVE.archiveVersion,
              sshRuntimeProtocolVersion: SSH_RUNTIME_PROTOCOL_VERSION,
              orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
            },
            liveBinarySignals: {
              serverVersion: ARCHIVE.archiveVersion,
              sshRuntimeProtocolVersion: SSH_RUNTIME_PROTOCOL_VERSION,
              orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
            },
          });
          const exact = yield* manager.status(uploadTarget);
          yield* decodeHostResult(exact);
          assert.isUndefined(exact.status?.refreshDeferred);
          const settled = yield* manager.ensureEnvironment(uploadTarget, agent);
          if ("type" in settled) throw new Error("Expected exact attachment");
          assert.isUndefined(settled.pendingReplacement);
          assert.equal(f.count.launches, 3);
          yield* TestClock.adjust("20 minutes");
          assert.equal(f.count.launches, 3);
          assert.equal(f.count.prompts, 0);
          for (const script of f.launchScripts) assert.include(script, "DRAIN_FORCE=0");
        }).pipe(
          Effect.provide(f.layer),
          Effect.provideService(Tracer.Tracer, f.tracer),
          Effect.scoped,
        );
      }).pipe(Effect.scoped),
  );

  it.effect.each(["drain-pending", "forward-failure"] as const)(
    "%s never claims a usable attachment and retries",
    (mode) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.setMode(mode === "drain-pending" ? mode : "drain-attached");
        f.failForward(mode === "forward-failure");
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          const result = yield* Effect.result(
            manager.ensureEnvironment(uploadTarget, { issuePairingToken: true }),
          );
          if (mode === "drain-pending") {
            if (Result.isFailure(result)) throw result.failure;
            assert.property(result.success, "type");
            assert.equal((yield* manager.status(uploadTarget)).status?.state, "update_waiting");
          } else assert.isTrue(Result.isFailure(result));
          assert.isUndefined((yield* manager.status(uploadTarget)).status?.refreshDeferred);
          assert.equal(f.count.forwards, 0);
          assert.equal(f.count.pairings, 0);
          assert.isTrue(
            Result.isFailure(yield* Effect.result(manager.readyEnvironment(uploadTarget))),
          );
          f.failForward(false);
          f.setMode("drain-attached");
          yield* TestClock.adjust("10 minutes");
          yield* Deferred.await(f.forwarded);
          yield* Deferred.await(f.published[mode === "drain-pending" ? 1 : 0]!);
          assert.equal(
            (yield* manager.status(uploadTarget)).status?.refreshDeferred?.refreshCause,
            "drain_unavailable",
          );
          assert.equal(f.count.launches, 2);
        }).pipe(
          Effect.provide(f.layer),
          Effect.provideService(Tracer.Tracer, f.tracer),
          Effect.scoped,
        );
      }).pipe(Effect.scoped),
  );

  it.effect.each(
    [false, true].flatMap((liveDrain) =>
      [
        { name: "foreign owner", probe: { liveOwned: false } },
        { name: "identity absent", probe: { identityAbsent: true } },
        { name: "missing port", probe: { livePort: undefined } },
        { name: "changed port", probe: { livePort: 4444 } },
        { name: "changed version", probe: { liveVersion: "1.2.1" } },
        { name: "missing live binary", probe: { liveBinarySignals: undefined } },
        {
          name: "incompatible live binary",
          probe: {
            liveBinarySignals: {
              serverVersion: "1.2.2",
              sshRuntimeProtocolVersion: 999,
              orchestrationProtocolVersion: 999,
            },
          },
        },
        { name: "unknown runtime", probe: { liveStatus: "unknown" } },
        { name: "dead forward", probe: {} },
        { name: "changed requested version", probe: {} },
      ].map((scenario) => ({ ...scenario, liveDrain })),
    ),
  )("fresh status cannot promote $name (drain=$liveDrain)", ({ name, probe, liveDrain }) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setMode("drain-attached");
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.ensureEnvironment(uploadTarget);
        if (name === "dead forward") f.setForwardRunning(false);
        if (name === "changed requested version") {
          f.setRequestedVersion("1.2.4");
        }
        f.setProbe({ ...probe, liveDrain });
        const result = yield* manager.status(uploadTarget);
        assert.isUndefined(result.status?.refreshDeferred);
        assert.notEqual(result.status?.state, "ready");
        assert.equal(f.count.launches, 1);
        assert.isTrue(
          Result.isFailure(yield* Effect.result(manager.readyEnvironment(uploadTarget))),
        );
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }).pipe(Effect.scoped),
  );

  it.effect.each(["disconnect", "forget", "generation", "terminal"] as const)(
    "%s cancels intent and fences a stale fresh probe",
    (action) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.setMode("drain-attached");
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          const operation = yield* manager.beginSetupOperation(uploadTarget, "drain-cancel");
          yield* manager.ensureEnvironment(uploadTarget);
          const gate = yield* f.holdNextProbe;
          const status = yield* manager.status(uploadTarget).pipe(Effect.forkChild);
          yield* Deferred.await(gate.entered);
          if (action === "disconnect") yield* manager.disconnectEnvironment(uploadTarget);
          if (action === "forget")
            yield* manager.forgetEnvironment(uploadTarget, { stopRuntime: "no" });
          if (action === "generation")
            yield* manager.beginSetupOperation(uploadTarget, "new-generation");
          if (action === "terminal")
            yield* manager.publishSetupOutcome(uploadTarget, operation, {
              kind: "error",
              reason: "diagnosis_failed",
              message: "Diagnosis failed",
              fix: { actor: "human", instruction: "Try again" },
            });
          yield* Deferred.succeed(gate.release, undefined);
          const result = yield* Fiber.join(status);
          assert.isUndefined(result.status?.refreshDeferred);
          yield* TestClock.adjust("20 minutes");
          assert.equal(f.count.launches, 1);
        }).pipe(Effect.provide(f.layer), Effect.scoped);
      }).pipe(Effect.scoped),
  );

  it.effect("archive recovery becomes drain deferral and clears obsolete archive state", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setMode("archive");
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const operation = yield* manager.beginSetupOperation(uploadTarget, "archive-to-drain");
        yield* manager.ensureEnvironment(uploadTarget);
        yield* manager.publishProviderDiagnosis(uploadTarget, operation, {
          checkedAt: operationDate,
          ready: false,
          fixes: [{ actor: "human", instruction: "Sign in" }],
        });
        assert.equal(
          (yield* manager.status(uploadTarget)).status?.refreshDeferred?.reason,
          "archive_unavailable",
        );
        f.setMode("drain-attached");
        f.setProbe({ liveDrain: false });
        yield* TestClock.adjust("10 minutes");
        yield* Deferred.await(f.published[1]!);
        for (let i = 0; i < 2; i++) {
          const result = yield* manager.status(uploadTarget);
          yield* decodeHostResult(result);
          assert.equal(result.status?.refreshDeferred?.refreshCause, "drain_unavailable");
          assert.equal(result.status?.state, "providers_not_ready");
        }
        f.setMode("ready");
        yield* TestClock.adjust("10 minutes");
        yield* Deferred.await(f.published[2]!);
        f.setProbe({ liveDrain: false });
        const result = yield* manager.status(uploadTarget);
        assert.isUndefined(result.status?.refreshDeferred);
        assert.isUndefined(result.status?.failure);
        assert.equal(f.count.launches, 3);
      }).pipe(
        Effect.provide(f.layer),
        Effect.provideService(Tracer.Tracer, f.tracer),
        Effect.scoped,
      );
    }).pipe(Effect.scoped),
  );
});

it.effect.each([false, true])(
  "failed HTTP readiness with drain=%s removes readiness without closing the forward or consuming intent",
  (liveDrain) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setMode("drain-attached");
      f.setProbe({ liveDrain });
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.ensureEnvironment(uploadTarget);
        f.setStale(true);
        const status = yield* manager.status(uploadTarget).pipe(Effect.forkChild);
        yield* Deferred.await(f.staleProbeEntered);
        yield* TestClock.adjust("10 seconds");
        const failed = yield* Fiber.join(status);
        assert.isUndefined(failed.status?.refreshDeferred);
        assert.equal(failed.status?.state, "update_blocked");
        assert.isTrue(
          Result.isFailure(yield* Effect.result(manager.readyEnvironment(uploadTarget))),
        );
        assert.equal(f.count.kills, 0);
        assert.equal(f.count.stops, 0);
        f.setStale(false);
        assert.equal(
          (yield* manager.status(uploadTarget)).status?.refreshDeferred?.refreshCause,
          "drain_unavailable",
        );
        yield* TestClock.adjust("10 minutes");
        yield* Deferred.await(f.published[1]!);
        assert.equal(f.count.launches, 2);
      }).pipe(
        Effect.provide(f.layer),
        Effect.provideService(Tracer.Tracer, f.tracer),
        Effect.scoped,
      );
    }).pipe(Effect.scoped),
);

it.effect("a changed managed pin cannot reconstruct drain readiness", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.installPin();
    f.setMode("drain-attached");
    yield* Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      yield* manager.ensureEnvironment(uploadTarget);
      const gate = yield* f.holdNextProbe;
      const status = yield* manager.status(uploadTarget).pipe(Effect.forkChild);
      yield* Deferred.await(gate.entered);
      yield* f.installPin("BBBB");
      yield* Deferred.succeed(gate.release, undefined);
      const result = yield* Fiber.join(status);
      assert.isUndefined(result.status?.refreshDeferred);
      assert.notEqual(result.status?.state, "ready");
      assert.equal(f.count.launches, 1);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  }).pipe(Effect.scoped),
);

it.effect(
  "fresh status proof cannot revive an attachment hint invalidated by an earlier owner probe",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setMode("drain-attached");
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const first = yield* manager.ensureEnvironment(uploadTarget);
        if ("type" in first) return yield* Effect.die("Expected a ready forward");
        f.setProbe({ liveOwned: false });
        assert.equal((yield* manager.status(uploadTarget)).status?.state, "update_blocked");
        f.setProbe({ liveDrain: true });
        assert.equal((yield* manager.status(uploadTarget)).status?.state, "ready");
        const hint = yield* Effect.result(
          manager.ensureEnvironment(uploadTarget, {
            preparedAttachmentId: first.attachmentId!,
            issuePairingToken: true,
          }),
        );
        assert.isTrue(Result.isFailure(hint));
        if (Result.isFailure(hint)) assert.equal(hint.failure._tag, "SshEnsureSupersededError");
        const fresh = yield* manager.ensureEnvironment(uploadTarget, {
          reuseWhileRefreshPending: true,
        });
        if ("type" in fresh) return yield* Effect.die("Expected a revalidated forward");
        assert.notEqual(fresh.attachmentId, first.attachmentId);
        assert.equal(f.count.pairings, 0);
        assert.equal(f.count.launches, 1);
        assert.equal(f.count.forwards, 1);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }),
);

it.effect("terminal setup failure fences drain publication across the forward-state read", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.setMode("drain-attached");
    yield* Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const operation = yield* manager.beginSetupOperation(uploadTarget, "drain-publication");
      const gate = yield* f.holdNextForwardState;
      const launch = yield* manager
        .ensureEnvironment(uploadTarget)
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(gate.entered);
      yield* manager.publishSetupOutcome(uploadTarget, operation, {
        kind: "error",
        reason: "authorization_revoked",
        message: "Authorization revoked",
        fix: { actor: "human", instruction: "Authorize setup again" },
      });
      yield* Deferred.succeed(gate.release, undefined);
      const superseded = yield* Fiber.join(launch);
      assert.isTrue(Result.isFailure(superseded));
      if (Result.isFailure(superseded))
        assert.equal(superseded.failure._tag, "SshEnsureSupersededError");
      const result = yield* manager.status(uploadTarget);
      assert.equal(result.status?.state, "failed");
      assert.equal(result.status?.failure?.reason, "authorization_revoked");
      assert.isUndefined(result.status?.refreshDeferred);
      assert.isTrue(Result.isFailure(yield* Effect.result(manager.readyEnvironment(uploadTarget))));
      yield* TestClock.adjust("20 minutes");
      assert.equal(f.count.launches, 1);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  }).pipe(Effect.scoped),
);

it.effect.each([
  { name: "foreign owner", probe: { liveOwned: false } },
  { name: "identity absent", probe: { identityAbsent: true } },
])(
  "status invalidation of $name fences drain publication across the forward-state read",
  ({ probe }) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setMode("drain-attached");
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.ensureEnvironment(uploadTarget);
        const publicationGate = yield* f.holdNextForwardState;
        const retry = yield* TestClock.adjust("10 minutes").pipe(Effect.forkChild);
        yield* Deferred.await(publicationGate.entered);
        f.setProbe(probe);
        assert.equal((yield* manager.status(uploadTarget)).status?.state, "update_blocked");

        // Observe the blocked snapshot before publication resumes, so a new probe cannot mask an overwrite.
        const probeGate = yield* f.holdNextProbe;
        const status = yield* manager.status(uploadTarget).pipe(Effect.forkChild);
        yield* Deferred.await(probeGate.entered);
        yield* Deferred.succeed(publicationGate.release, undefined);
        yield* Deferred.await(f.published[1]!);
        yield* Fiber.join(retry);
        yield* Deferred.succeed(probeGate.release, undefined);
        const result = yield* Fiber.join(status);
        assert.equal(result.status?.state, "update_blocked");
        assert.isUndefined(result.status?.refreshDeferred);
        assert.isTrue(
          Result.isFailure(yield* Effect.result(manager.readyEnvironment(uploadTarget))),
        );
        assert.isTrue(
          Result.isFailure(
            yield* Effect.result(
              manager.issueMcpClientSession(uploadTarget, {
                requireReady: true,
                label: "invalidated-publication",
                ttl: "1h",
                runtimeModeCeiling: null,
              }),
            ),
          ),
        );
        assert.equal(f.count.launches, 2);
        assert.equal(f.count.forwards, 1);
      }).pipe(
        Effect.provide(f.layer),
        Effect.provideService(Tracer.Tracer, f.tracer),
        Effect.scoped,
      );
    }).pipe(Effect.scoped),
);

it.effect.each(
  [false, true].flatMap((liveDrain) => [
    { name: "foreign owner", probe: { liveOwned: false }, liveDrain },
    { name: "identity absent", probe: { identityAbsent: true }, liveDrain },
  ]),
)(
  "status invalidation of $name (drain=$liveDrain) prevents pending reuse and session admission",
  ({ probe, liveDrain }) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setMode("drain-attached");
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.ensureEnvironment(uploadTarget);
        f.setProbe({ ...probe, liveDrain });
        assert.equal((yield* manager.status(uploadTarget)).status?.state, "update_blocked");
        f.setMode("drain-pending");
        const result = yield* manager.ensureEnvironment(uploadTarget, {
          reuseWhileRefreshPending: true,
        });
        assert.property(result, "type");
        assert.equal(f.count.launches, 2);
        assert.equal(f.count.forwards, 1);
        assert.equal(f.count.stops, 0);
        const waiting = yield* manager.status(uploadTarget);
        assert.equal(waiting.status?.state, "update_waiting");
        assert.isUndefined(waiting.status?.refreshDeferred);
        assert.isTrue(
          Result.isFailure(yield* Effect.result(manager.readyEnvironment(uploadTarget))),
        );
        assert.isTrue(
          Result.isFailure(
            yield* Effect.result(
              manager.issueMcpClientSession(uploadTarget, {
                requireReady: true,
                label: "invalidated",
                ttl: "1h",
                runtimeModeCeiling: null,
              }),
            ),
          ),
        );
        f.setMode("drain-attached");
        f.setProbe({ liveDrain });
        yield* TestClock.adjust("10 minutes");
        yield* Deferred.await(f.published[2]!);
        const recovered = yield* manager.ensureEnvironment(uploadTarget, {
          reuseWhileRefreshPending: true,
        });
        assert.notProperty(recovered, "type");
        yield* manager.readyEnvironment(uploadTarget);
        assert.equal(f.count.launches, 3);
      }).pipe(
        Effect.provide(f.layer),
        Effect.provideService(Tracer.Tracer, f.tracer),
        Effect.scoped,
      );
    }).pipe(Effect.scoped),
);
