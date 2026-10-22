import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DesktopSshEnvironmentBootstrapSchema,
  DesktopSshPreparationProgressEventSchema,
  EnvironmentId,
} from "@goat/contracts";
import {
  Connectivity,
  ConnectionDriver,
  EnvironmentSupervisor,
  SshConnectionTarget,
  Wakeups,
  connectionRouteId,
  type SupervisorConnectionState,
} from "@goat/client-runtime/connection";
import type { WsRpcProtocolClient } from "@goat/client-runtime/rpc";
import { SshHostAnswered } from "@goat/ssh/command";
import * as NetService from "@goat/shared/Net";
import * as SshTunnel from "@goat/ssh/tunnel";
import {
  SshEnsureSupersededError,
  SshLaunchError,
  SshPasswordPromptError,
  SshPreparationTimeoutError,
} from "@goat/ssh/errors";
import { vi } from "vite-plus/test";
import * as SshAuth from "@goat/ssh/auth";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Sink from "effect/Sink";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as DesktopSshEnvironment from "./DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";
import { makeEnsureFlightFixture } from "../../../../packages/ssh/src/tunnel.ensure-flight.fixture.ts";
import { uploadTarget } from "../../../../packages/ssh/src/tunnel.fixture.ts";
import { bootstrapSshBearerSession, ensureSshEnvironment } from "../ipc/methods/sshEnvironment.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as IpcChannels from "../ipc/channels.ts";

vi.mock("electron", () => ({}));

const decodeBootstrap = Schema.decodeUnknownEffect(DesktopSshEnvironmentBootstrapSchema);
const decodePreparationEvent = Schema.decodeUnknownOption(DesktopSshPreparationProgressEventSchema);

const runtimeTarget = {
  alias: "devbox",
  hostname: "box.example.test",
  username: "maintainer",
  port: 2207,
};
const pendingRuntime = {
  type: "ssh-runtime-pending",
  target: runtimeTarget,
  pending: {
    reason: "busy",
    replacement: "older",
    requestedVersion: "1.2.3",
    liveVersion: "1.2.2",
  },
} as const;
const waitingStatus = {
  kind: "ok",
  status: {
    host: runtimeTarget.alias,
    state: "update_waiting",
    requestedVersion: "1.2.3",
    runtimeVersion: "1.2.2",
  },
} as const;

const unusedManager = {
  status: () => Effect.die("unexpected status"),
  ensureEnvironment: () => Effect.die("unexpected ensure"),
  readyEnvironment: () => Effect.die("Unexpected ready environment"),
  beginSetupOperation: () => Effect.die("Unexpected setup operation"),
  publishProviderDiagnosis: () => Effect.die("Unexpected provider publication"),
  publishSetupOutcome: () => Effect.die("Unexpected setup outcome"),
  forgetEnvironment: () => Effect.die("Unexpected forget"),
  disconnectEnvironment: () => Effect.void,
  revalidateTunnels: () => Effect.void,
  issueMcpClientSession: () => Effect.die("unexpected session"),
  issueClientSession: () => Effect.die("unexpected client session"),
  runRemoteScript: () => Effect.die("unexpected remote script"),
} satisfies SshTunnel.SshEnvironmentManagerShape;

const desktopRuntimeLayer = Layer.mergeAll(
  NodeServices.layer,
  NodeHttpClient.layerUndici,
  NetService.layer,
  Layer.succeed(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {
    request: () => Effect.die("unexpected desktop password prompt"),
    resolve: () => Effect.die("unexpected password resolution"),
  }),
);

const withManager = (manager: SshTunnel.SshEnvironmentManagerShape) =>
  Layer.mergeAll(desktopRuntimeLayer, Layer.succeed(SshTunnel.SshEnvironmentManager, manager));

const successfulProcess = (stdout: string) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.make(new TextEncoder().encode(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });

describe("desktop SSH runtime status", () => {
  it.effect("uses the existing desktop manager for status when_idle and now", () => {
    let confirmed = false;
    const manager = {
      ...unusedManager,
      status: () =>
        Effect.sync(() => ({
          ...waitingStatus,
          status: confirmed
            ? { ...waitingStatus.status, state: "ready" as const, runtimeVersion: "1.2.3" }
            : waitingStatus.status,
        })),
      ensureEnvironment: (target, options) =>
        Effect.sync(() => {
          assert.deepEqual(target, runtimeTarget);
          if (options?.refreshRuntime && options.keyOnly && options.issuePairingToken === false)
            confirmed = options.confirmReplacement === true;
          return confirmed
            ? {
                target,
                httpBaseUrl: "http://127.0.0.1:41773/",
                wsBaseUrl: "ws://127.0.0.1:41773/",
                pairingToken: null,
              }
            : pendingRuntime;
        }),
    } satisfies SshTunnel.SshEnvironmentManagerShape;
    return Effect.gen(function* () {
      const service = yield* DesktopSshEnvironment.make;
      assert.deepEqual(yield* service.status(runtimeTarget), waitingStatus);
      assert.deepEqual(yield* service.update(runtimeTarget), waitingStatus);
      assert.deepEqual(yield* service.update(runtimeTarget, "when_idle"), waitingStatus);
      const updated = yield* service.update(runtimeTarget, "now");
      assert.equal(updated.status?.state, "ready");
      assert.equal(updated.status?.runtimeVersion, "1.2.3");
      assert.deepEqual(yield* service.status(runtimeTarget), updated);
    }).pipe(Effect.provide(withManager(manager)));
  });

  it.effect("status does not prompt for a password", () =>
    Effect.gen(function* () {
      const service = yield* DesktopSshEnvironment.make;
      assert.deepEqual(yield* service.status(runtimeTarget), waitingStatus);
    }).pipe(
      Effect.provide(
        withManager({
          ...unusedManager,
          status: () =>
            Effect.gen(function* () {
              const prompt = yield* SshAuth.SshPasswordPrompt;
              assert.equal(prompt.isAvailable, false);
              const exit = yield* prompt
                .request({
                  destination: "maintainer@box.example.test",
                  username: "maintainer",
                  prompt: "Password:",
                  attempt: 1,
                })
                .pipe(Effect.exit);
              assert(Exit.isFailure(exit));
              const failure = Cause.findErrorOption(exit.cause);
              assert(Option.isSome(failure));
              assert.instanceOf(failure.value, SshPasswordPromptError);
              return waitingStatus;
            }),
        }),
      ),
    ),
  );

  it.effect("returns the manager's structured failure when acquisition fails", () => {
    const failed = {
      kind: "ok",
      status: {
        ...waitingStatus.status,
        state: "failed",
        failure: {
          reason: "archive_unavailable",
          archive: { requestedVersion: "1.2.3", platformKey: "linux-x64", sourcesTried: ["https"] },
          fix: { actor: "human", instruction: "Install a published GOAT release." },
        },
      },
    } as const;
    return Effect.gen(function* () {
      const service = yield* DesktopSshEnvironment.make;
      assert.deepEqual(yield* service.update(runtimeTarget), failed);
    }).pipe(
      Effect.provide(
        withManager({
          ...unusedManager,
          ensureEnvironment: () =>
            Effect.fail(
              new SshLaunchError({
                reason: "archive-unavailable",
                message: "Requested GOAT archive is unavailable.",
                stdout: "",
                acquisition: failed.status.failure.archive,
              }),
            ),
          status: () => Effect.succeed(failed),
        }),
      ),
    );
  });

  it.effect("ignores late results after disconnect", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let statusReads = 0;
      const service = yield* DesktopSshEnvironment.make.pipe(
        Effect.provideService(SshTunnel.SshEnvironmentManager, {
          ...unusedManager,
          ensureEnvironment: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return pendingRuntime;
            }),
          status: () =>
            Effect.sync(() => {
              statusReads++;
              return waitingStatus;
            }),
        }),
      );
      const update = yield* service.update(runtimeTarget, "now").pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* service.disconnectEnvironment(runtimeTarget);
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(update);
      assert.equal(result.kind, "error");
      if (result.kind === "error") assert.equal(result.code, "cancelled");
      assert.equal(statusReads, 0);
    }).pipe(Effect.provide(desktopRuntimeLayer)),
  );

  it.effect("ignores a status probe that finishes after disconnect", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const service = yield* DesktopSshEnvironment.make.pipe(
        Effect.provideService(SshTunnel.SshEnvironmentManager, {
          ...unusedManager,
          status: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return waitingStatus;
            }),
        }),
      );
      const read = yield* service.status(runtimeTarget).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* service.disconnectEnvironment(runtimeTarget);
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(read);
      assert.equal(result.kind, "error");
      if (result.kind === "error") assert.equal(result.code, "cancelled");
    }).pipe(Effect.provide(desktopRuntimeLayer)),
  );

  it.effect("keeps desktop and dispatch caches separate while sharing the remote lock", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let held = false;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (command._tag !== "StandardCommand") return yield* Effect.die("unexpected command");
          if (command.args.includes("-G"))
            return successfulProcess("hostname box.example.test\nuser maintainer\nport 2207\n");
          const input = command.options.stdin;
          const script =
            input !== undefined &&
            typeof input === "object" &&
            "stream" in input &&
            Stream.isStream(input.stream)
              ? yield* input.stream.pipe(Stream.decodeText(), Stream.mkString)
              : "";
          // Archive launches embed a reconnect probe; only launches pass a state key to sh -s.
          const isLaunch = command.args.some(
            (arg, index) => arg === "-s" && command.args[index + 1] === "--",
          );
          if (script.includes("ready=false") && !isLaunch)
            return successfulProcess(
              JSON.stringify({ platform: "linux", arch: "x64", ready: true, liveStatus: "none" }),
            );
          assert.isTrue(isLaunch, "unexpected SSH command");
          assert.equal(command.args.at(-1), "runtime");
          const contended = held;
          if (!contended) {
            held = true;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            held = false;
          }
          return successfulProcess(
            JSON.stringify({
              status: "pending",
              pending: {
                ...pendingRuntime.pending,
                requestedVersion: contended ? "1.2.4" : "1.2.3",
                reason: contended ? "contended" : "busy",
              },
            }),
          );
        }),
      );
      yield* Effect.gen(function* () {
        const desktopContext = yield* Layer.build(
          SshTunnel.SshEnvironmentManager.layer({
            resolveCliRunner: Effect.succeed({
              archiveVersion: "1.2.3",
              refreshOwnedRuntimeOnFirstConnection: true,
            }),
            leaveRemoteServerRunning: true,
          }),
        );
        const desktop = yield* DesktopSshEnvironment.make.pipe(
          Effect.provideService(
            SshTunnel.SshEnvironmentManager,
            Context.get(desktopContext, SshTunnel.SshEnvironmentManager),
          ),
        );
        const dispatchContext = yield* Layer.build(
          SshTunnel.SshEnvironmentManager.layer({
            resolveCliRunner: Effect.succeed({
              archiveVersion: "1.2.4",
              refreshOwnedRuntimeOnFirstConnection: true,
            }),
          }),
        );
        const dispatch = Context.get(dispatchContext, SshTunnel.SshEnvironmentManager);
        const desktopUpdate = yield* desktop.update(runtimeTarget).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* dispatch.ensureEnvironment(runtimeTarget, {
          keyOnly: true,
          issuePairingToken: false,
        });
        const dispatchStatus = yield* dispatch.status(runtimeTarget);
        assert.equal(dispatchStatus.status?.state, "update_waiting");
        assert.equal(dispatchStatus.status?.requestedVersion, "1.2.4");
        assert.include(dispatchStatus.status?.detail ?? "", "Another computer");
        const desktopStatus = yield* desktop.status(runtimeTarget);
        assert.equal(desktopStatus.status?.state, "preparing");
        assert.equal(desktopStatus.status?.requestedVersion, "1.2.3");
        yield* Deferred.succeed(release, undefined);
        assert.equal((yield* Fiber.join(desktopUpdate)).status?.state, "update_waiting");
        yield* desktop.disconnectEnvironment(runtimeTarget);
        const retainedDispatchStatus = yield* dispatch.status(runtimeTarget);
        assert.equal(retainedDispatchStatus.status?.state, "update_waiting");
        assert.equal(retainedDispatchStatus.status?.requestedVersion, "1.2.4");
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    }).pipe(
      Effect.provideService(SshAuth.SshPasswordPrompt, {
        isAvailable: false,
        request: () => Effect.die("unexpected password"),
      }),
      Effect.provide(desktopRuntimeLayer),
      Effect.scoped,
    ),
  );
});

describe("sshEnvironment", () => {
  it.effect(
    "shares one real manager preparation across two window gateways and independent supervisors",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeEnsureFlightFixture;
        yield* Effect.gen(function* () {
          const scope = yield* Scope.Scope;
          const service = yield* DesktopSshEnvironment.make;
          const ipcContext = yield* Effect.context<FileSystem.FileSystem>();
          const desktop = DesktopEnvironment.DesktopEnvironment.of({
            path: yield* Path.Path,
            homeDirectory: fixture.root,
          } as DesktopEnvironment.DesktopEnvironment["Service"]);
          const observed = yield* Queue.unbounded<string>();
          const exchangeEntered = yield* Queue.unbounded<string>();
          const requestIds: string[] = [];
          const completions: string[] = [];
          const exchanged = new Map<string, string>();
          const sent: Array<{
            senderId: number;
            requestId: string;
            operationId: string;
            terminal: boolean;
          }> = [];
          const target = new SshConnectionTarget({
            environmentId: EnvironmentId.make("ssh-two-window-fixture"),
            label: "SSH fixture",
            connectionId: "ssh:devbox",
          });
          const routeId = connectionRouteId(target);
          const makeWindow = (senderId: number) =>
            Effect.gen(function* () {
              let sequence = 0;
              return yield* EnvironmentSupervisor.make(
                { target, profile: Option.none(), enabled: true },
                { initiallyDesired: false },
              ).pipe(
                Effect.provideService(Connectivity.Connectivity, {
                  status: Effect.succeed("online" as const),
                  changes: Stream.never,
                }),
                Effect.provideService(Wakeups.ConnectionWakeups, { changes: Stream.never }),
                Effect.provideService(ConnectionDriver, {
                  checkRoute: () => Effect.succeed("unchecked"),
                  preflight: () => Effect.succeed(false),
                  connect: (_entry, report, context) =>
                    Effect.gen(function* () {
                      const requestId = `window-${senderId}-request-${++sequence}`;
                      requestIds.push(requestId);
                      const events = yield* Queue.unbounded<Effect.Effect<void>>();
                      const drained = yield* Deferred.make<void>();
                      let active = true;
                      let sawPreparation = false;
                      yield* report({ stage: "preparing", routeId });
                      yield* Queue.take(events).pipe(
                        Effect.flatten,
                        Effect.forever,
                        Effect.forkChild,
                      );
                      yield* Effect.sleep("235 millis");
                      const native = yield* ensureSshEnvironment
                        .handler(
                          {
                            target: uploadTarget,
                            requestId,
                            caller: "provision",
                            options: { issuePairingToken: true },
                            ...(context === undefined
                              ? {}
                              : { attemptContext: { ...context, routeId } }),
                          },
                          {
                            sender: {
                              id: senderId,
                              send: (channel, payload) => {
                                if (
                                  channel === IpcChannels.SSH_ENVIRONMENT_ANSWERED_CHANNEL &&
                                  payload === requestId &&
                                  active
                                )
                                  Queue.offerUnsafe(
                                    events,
                                    report({ stage: "preparing", routeId, hostAnswered: true }),
                                  );
                                if (channel !== IpcChannels.SSH_ENVIRONMENT_PROGRESS_CHANNEL)
                                  return;
                                const decoded = decodePreparationEvent(payload);
                                assert(Option.isSome(decoded));
                                assert.equal(decoded.value.requestId, requestId);
                                const { requestId: _requestId, ...progress } = decoded.value;
                                sent.push({
                                  senderId,
                                  requestId,
                                  operationId: progress.operationId,
                                  terminal: progress.phase === null,
                                });
                                if (
                                  !sawPreparation &&
                                  progress.phase === "uploading" &&
                                  progress.hostAnswered
                                ) {
                                  sawPreparation = true;
                                  Queue.offerUnsafe(observed, requestId);
                                }
                                if (active)
                                  Queue.offerUnsafe(
                                    events,
                                    report({
                                      stage: "preparing",
                                      routeId,
                                      sshPreparation: progress,
                                    }),
                                  );
                              },
                            },
                          },
                        )
                        .pipe(
                          Effect.provideService(
                            DesktopSshEnvironment.DesktopSshEnvironment,
                            service,
                          ),
                          Effect.provideService(DesktopEnvironment.DesktopEnvironment, desktop),
                          Effect.provide(ipcContext),
                          Effect.flatMap(decodeBootstrap),
                          Effect.tap(() =>
                            Effect.sync(() => {
                              completions.push(requestId);
                            }),
                          ),
                          Effect.orDie,
                          Effect.forkIn(scope),
                        );
                      return yield* Effect.gen(function* () {
                        const bootstrap = yield* Fiber.join(native);
                        Queue.offerUnsafe(
                          events,
                          Deferred.succeed(drained, undefined).pipe(Effect.asVoid),
                        );
                        yield* Deferred.await(drained);
                        yield* Queue.offer(exchangeEntered, requestId);
                        yield* Effect.sleep("235 millis");
                        assert.isString(bootstrap.pairingToken);
                        const exchange = yield* bootstrapSshBearerSession
                          .handler({
                            httpBaseUrl: bootstrap.httpBaseUrl,
                            credential: bootstrap.pairingToken!,
                          })
                          .pipe(
                            Effect.provideService(
                              HttpClient.HttpClient,
                              HttpClient.make((request) =>
                                Effect.sync(() => {
                                  assert.equal(request.url, "http://127.0.0.1:41773/oauth/token");
                                  assert.equal(request.method, "POST");
                                  assert(request.body._tag === "Uint8Array");
                                  const credential = new URLSearchParams(
                                    new TextDecoder().decode(request.body.body),
                                  ).get("subject_token");
                                  assert.equal(credential, bootstrap.pairingToken);
                                  assert.isFalse(exchanged.has(credential!));
                                  exchanged.set(credential!, requestId);
                                  return HttpClientResponse.fromWeb(
                                    request,
                                    Response.json({
                                      access_token: `fixture-bearer-${senderId}`,
                                      issued_token_type:
                                        "urn:ietf:params:oauth:token-type:access_token",
                                      token_type: "Bearer",
                                      expires_in: 3600,
                                      scope: "orchestration:read",
                                    }),
                                  );
                                }),
                              ),
                            ),
                            Effect.orDie,
                          );
                        assert.equal(
                          (exchange as { access_token: string }).access_token,
                          `fixture-bearer-${senderId}`,
                        );
                        const prepared = {
                          environmentId: target.environmentId,
                          label: target.label,
                          httpBaseUrl: bootstrap.httpBaseUrl,
                          socketUrl: `${bootstrap.wsBaseUrl}ws`,
                          httpAuthorization: null,
                          target,
                        };
                        yield* report({ stage: "synchronizing", prepared });
                        return {
                          prepared,
                          session: {
                            client: {} as WsRpcProtocolClient,
                            initialConfig: Effect.die("unused config"),
                            subscribeServerConfig: () => Stream.never,
                            ready: Effect.void,
                            probe: Effect.void,
                            closed: Effect.never,
                          },
                        };
                      }).pipe(
                        Effect.ensuring(
                          Effect.sync(() => {
                            active = false;
                          }),
                        ),
                      );
                    }),
                }),
              );
            });
          const awaitPhase = (
            supervisor: EnvironmentSupervisor.EnvironmentSupervisor["Service"],
            phase: SupervisorConnectionState["phase"],
          ) =>
            SubscriptionRef.changes(supervisor.state).pipe(
              Stream.filter((state) => state.phase === phase),
              Stream.runHead,
            );
          const first = yield* makeWindow(1);
          const second = yield* makeWindow(2);
          yield* first.connect;
          yield* TestClock.adjust("235 millis");
          yield* Deferred.await(fixture.uploadEntered);
          assert.equal(yield* Queue.take(observed), "window-1-request-1");
          yield* second.connect;
          yield* TestClock.adjust("235 millis");
          assert.equal(yield* Queue.take(observed), "window-2-request-1");
          yield* first.disconnect;
          yield* awaitPhase(first, "available");
          assert.equal((yield* SubscriptionRef.get(second.state)).phase, "connecting");
          yield* first.connect;
          yield* TestClock.adjust("235 millis");
          assert.equal(yield* Queue.take(observed), "window-1-request-2");
          yield* TestClock.adjust("258 seconds");
          assert.equal((yield* SubscriptionRef.get(first.state)).phase, "connecting");
          assert.equal((yield* SubscriptionRef.get(second.state)).phase, "connecting");
          assert.equal(fixture.count.acquisitions, 1);
          assert.equal(fixture.count.uploads, 1);
          assert.equal(fixture.count.launches, 0);
          assert.equal(requestIds.length, 3);
          yield* Deferred.succeed(fixture.releaseUpload, undefined);
          yield* Queue.take(exchangeEntered);
          yield* Queue.take(exchangeEntered);
          yield* TestClock.adjust("235 millis");
          yield* awaitPhase(first, "connected");
          yield* awaitPhase(second, "connected");
          assert.equal(fixture.count.launches, 1);
          assert.equal(fixture.count.forwards, 1);
          assert.equal(fixture.count.pairings, 3);
          assert.equal(completions.length, 3);
          assert.deepEqual([...exchanged.values()].sort(), [
            "window-1-request-2",
            "window-2-request-1",
          ]);
          assert.equal(new Set(sent.map((event) => event.operationId)).size, 1);
          assert.equal(
            new Set(sent.filter((event) => event.terminal).map((event) => event.requestId)).size,
            3,
          );
          yield* TestClock.adjust("200 seconds");
          assert.equal(requestIds.length, 3);
          assert.equal(fixture.count.acquisitions, 1);
          assert.equal(fixture.count.uploads, 1);
          assert.equal(fixture.count.launches, 1);
          assert.equal((yield* SubscriptionRef.get(first.state)).phase, "connected");
          assert.equal((yield* SubscriptionRef.get(second.state)).phase, "connected");
        }).pipe(
          Effect.provide(fixture.layer),
          Effect.provideService(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {
            request: () => Effect.die("unexpected password"),
            resolve: () => Effect.die("unexpected resolution"),
          }),
          Effect.scoped,
        );
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer())), Effect.scoped),
  );

  it.effect("forwards attachment completion hints and isolates phase and admission observers", () =>
    Effect.gen(function* () {
      const active = {
        operationId: "flight-1",
        phase: "uploading",
        hostAnswered: true,
        remainingMs: 800_000,
      } as const;
      const terminal = { ...active, phase: null, outcome: "pending" } as const;
      const progress: unknown[] = [];
      const admissions: unknown[] = [];
      const service = yield* DesktopSshEnvironment.make.pipe(
        Effect.provideService(SshTunnel.SshEnvironmentManager, {
          ...unusedManager,
          ensureEnvironment: (receivedTarget, options) =>
            Effect.sync(() => {
              assert.deepEqual(receivedTarget, runtimeTarget);
              assert.equal(options?.preparedAttachmentId, "attachment-1");
              assert.equal(options?.issuePairingToken, true);
              assert.equal(options?.keyOnly, true);
              assert.doesNotThrow(() =>
                options?.onPreparationAdmission?.({
                  operationId: "flight-1",
                  disposition: "attachment-completion",
                  generation: 3,
                }),
              );
              assert.doesNotThrow(() => options?.onPreparationProgress?.(active));
              assert.doesNotThrow(() => options?.onPreparationProgress?.(terminal));
              return pendingRuntime;
            }),
        }),
      );
      const result = yield* service.ensureEnvironment(runtimeTarget, {
        preparedAttachmentId: "attachment-1",
        issuePairingToken: true,
        keyOnly: true,
        onPreparationProgress: (value) => {
          progress.push(value);
          throw new Error("renderer gone");
        },
        onPreparationAdmission: (value) => {
          admissions.push(value);
          throw new Error("renderer gone");
        },
      });
      assert.deepEqual(result, pendingRuntime);
      assert.deepEqual(progress, [active, terminal]);
      assert.deepEqual(admissions, [
        { operationId: "flight-1", disposition: "attachment-completion", generation: 3 },
      ]);
    }).pipe(Effect.provide(desktopRuntimeLayer)),
  );

  it.effect(
    "preserves neutral ownership and preparation timeout errors without prompt cancellation",
    () =>
      Effect.gen(function* () {
        for (const error of [
          new SshEnsureSupersededError({
            message: "SSH preparation superseded by a newer connection intent.",
          }),
          new SshPreparationTimeoutError({
            message: "SSH runtime preparation exceeded its 15-minute limit.",
          }),
        ]) {
          const service = yield* DesktopSshEnvironment.make.pipe(
            Effect.provideService(SshTunnel.SshEnvironmentManager, {
              ...unusedManager,
              ensureEnvironment: () => Effect.fail(error),
            }),
          );
          const result = yield* service.ensureEnvironment(runtimeTarget).pipe(Effect.exit);
          assert(Exit.isFailure(result));
          const cause = Cause.findErrorOption(result.cause);
          assert(Option.isSome(cause));
          assert.strictEqual(cause.value, error);
          assert.isFalse(DesktopSshEnvironment.isDesktopSshPasswordPromptCancellation(cause.value));
        }
      }).pipe(Effect.provide(desktopRuntimeLayer)),
  );

  it.effect("isolates a throwing authentication listener from other pending requests", () =>
    Effect.gen(function* () {
      const entered = yield* Queue.unbounded<() => void>();
      const finish = yield* Deferred.make<void>();
      const service = yield* DesktopSshEnvironment.make.pipe(
        Effect.provideService(SshTunnel.SshEnvironmentManager, {
          ...unusedManager,
          ensureEnvironment: () =>
            Effect.gen(function* () {
              const answer = yield* SshHostAnswered;
              yield* Queue.offer(entered, () => answer?.());
              yield* Deferred.await(finish);
              return pendingRuntime;
            }),
        }),
      );
      let liveAnswers = 0;
      const dead = yield* service.ensureEnvironment(runtimeTarget).pipe(
        Effect.provideService(SshHostAnswered, () => {
          throw new Error("Object has been destroyed");
        }),
        Effect.forkChild,
      );
      const authenticate = yield* Queue.take(entered);
      const live = yield* service.ensureEnvironment(runtimeTarget).pipe(
        Effect.provideService(SshHostAnswered, () => {
          liveAnswers++;
        }),
        Effect.forkChild,
      );
      yield* Queue.take(entered);
      assert.doesNotThrow(authenticate);
      assert.equal(liveAnswers, 1);
      yield* Deferred.succeed(finish, undefined);
      assert.deepEqual(yield* Fiber.join(dead), pendingRuntime);
      assert.deepEqual(yield* Fiber.join(live), pendingRuntime);
    }).pipe(Effect.provide(desktopRuntimeLayer)),
  );

  it.effect("clears authentication state after a replay listener throws", () =>
    Effect.gen(function* () {
      const entered = yield* Queue.unbounded<() => void>();
      const replayed = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const service = yield* DesktopSshEnvironment.make.pipe(
        Effect.provideService(SshTunnel.SshEnvironmentManager, {
          ...unusedManager,
          ensureEnvironment: () =>
            Effect.gen(function* () {
              const answer = yield* SshHostAnswered;
              yield* Queue.offer(entered, () => answer?.());
              yield* Deferred.await(finish);
              return pendingRuntime;
            }),
        }),
      );
      const original = yield* service.ensureEnvironment(runtimeTarget).pipe(Effect.forkChild);
      (yield* Queue.take(entered))();
      let replayAnswers = 0;
      const replay = yield* service.ensureEnvironment(runtimeTarget).pipe(
        Effect.provideService(SshHostAnswered, () => {
          replayAnswers++;
          Deferred.doneUnsafe(replayed, Effect.void);
          throw new Error("Object has been destroyed");
        }),
        Effect.exit,
        Effect.forkChild,
      );
      yield* Deferred.await(replayed);
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(original);
      const replayResult = yield* Fiber.join(replay);
      let freshAnswers = 0;
      yield* service.ensureEnvironment(runtimeTarget).pipe(
        Effect.provideService(SshHostAnswered, () => {
          freshAnswers++;
        }),
      );
      assert.equal(freshAnswers, 0);
      assert.equal(replayAnswers, 1);
      assert(Exit.isSuccess(replayResult));
      assert.deepEqual(replayResult.value, pendingRuntime);
    }).pipe(Effect.provide(desktopRuntimeLayer)),
  );

  it.effect(
    "limits authentication replay to pending requests for the same target and generation",
    () =>
      Effect.gen(function* () {
        const entered = yield* Queue.unbounded<() => void>();
        const finish = yield* Deferred.make<void>();
        const answers: string[] = [];
        const service = yield* DesktopSshEnvironment.make.pipe(
          Effect.provideService(SshTunnel.SshEnvironmentManager, {
            ...unusedManager,
            ensureEnvironment: () =>
              Effect.gen(function* () {
                const answer = yield* SshHostAnswered;
                yield* Queue.offer(entered, () => answer?.());
                yield* Deferred.await(finish);
                return pendingRuntime;
              }),
          }),
        );
        const start = Effect.fnUntraced(function* (id: string, target = runtimeTarget) {
          const fiber = yield* service.ensureEnvironment(target).pipe(
            Effect.provideService(SshHostAnswered, () => {
              answers.push(id);
            }),
            Effect.forkChild,
          );
          return { fiber, answer: yield* Queue.take(entered) };
        });
        const original = yield* start("original");
        const early = yield* start("early");
        original.answer();
        original.answer();
        assert.deepEqual(answers, ["original", "early"]);
        const retry = yield* start("retry");
        const other = yield* start("other", { ...runtimeTarget, hostname: "other.example.test" });
        assert.deepEqual(answers, ["original", "early", "retry"]);
        yield* service.disconnectEnvironment(runtimeTarget);
        const replacement = yield* start("replacement");
        original.answer();
        assert.deepEqual(answers, ["original", "early", "retry"]);
        replacement.answer();
        yield* Fiber.interrupt(original.fiber);
        yield* Fiber.interrupt(early.fiber);
        yield* Fiber.interrupt(retry.fiber);
        const replacementRetry = yield* start("replacement-retry");
        assert.deepEqual(answers, [
          "original",
          "early",
          "retry",
          "replacement",
          "replacement-retry",
        ]);
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(replacement.fiber);
        yield* Fiber.join(replacementRetry.fiber);
        yield* Fiber.join(other.fiber);
        yield* start("fresh");
        assert.deepEqual(answers, [
          "original",
          "early",
          "retry",
          "replacement",
          "replacement-retry",
        ]);
      }).pipe(Effect.provide(desktopRuntimeLayer)),
  );

  it.effect("learns 42 seconds when only the original SSH request authenticates", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const finishSetup = yield* Deferred.make<void>();
      const lock = yield* Semaphore.make(1);
      let requests = 0;
      let authentications = 0;
      const service = yield* DesktopSshEnvironment.make.pipe(
        Effect.provideService(SshTunnel.SshEnvironmentManager, {
          ...unusedManager,
          ensureEnvironment: () =>
            Effect.gen(function* () {
              const request = ++requests;
              return yield* lock.withPermit(
                Effect.gen(function* () {
                  // IPC retries wait behind the original target lock without authenticating again.
                  if (request === 1 || request === 4) {
                    authentications++;
                    (yield* SshHostAnswered)?.();
                  }
                  if (request <= 3) yield* Deferred.await(finishSetup);
                  else return yield* Effect.never;
                  return {
                    target: runtimeTarget,
                    httpBaseUrl: "http://127.0.0.1:41773/",
                    wsBaseUrl: "ws://127.0.0.1:41773/",
                    pairingToken: null,
                  };
                }),
              );
            }),
        }),
      );
      const target = new SshConnectionTarget({
        environmentId: EnvironmentId.make("ssh-test"),
        label: "SSH test",
        connectionId: "ssh:devbox",
      });
      const prepared = {
        environmentId: target.environmentId,
        label: target.label,
        httpBaseUrl: "http://127.0.0.1:41773/",
        socketUrl: "ws://127.0.0.1:41773/ws",
        httpAuthorization: null,
        target,
      };
      const supervisor = yield* EnvironmentSupervisor.make(
        { target, profile: Option.none(), enabled: true },
        { initiallyDesired: true },
      ).pipe(
        Effect.provideService(Connectivity.Connectivity, {
          status: Effect.succeed("online" as const),
          changes: Stream.never,
        }),
        Effect.provideService(Wakeups.ConnectionWakeups, { changes: Stream.never }),
        Effect.provideService(ConnectionDriver, {
          checkRoute: () => Effect.succeed("unchecked"),
          preflight: () => Effect.succeed(false),
          connect: (_entry, progress) =>
            Effect.gen(function* () {
              yield* progress({ stage: "preparing", routeId: connectionRouteId(target) });
              const answered = yield* Deferred.make<void>();
              const request = yield* service.ensureEnvironment(runtimeTarget).pipe(
                Effect.provideService(SshHostAnswered, () => {
                  Deferred.doneUnsafe(answered, Effect.void);
                }),
                // Renderer cancellation does not cancel the desktop IPC request.
                Effect.forkIn(scope),
              );
              yield* Deferred.await(answered).pipe(
                Effect.andThen(progress({ stage: "preparing", hostAnswered: true })),
                Effect.forkChild,
              );
              yield* Fiber.join(request).pipe(Effect.orDie);
              yield* progress({ stage: "synchronizing", prepared });
              return {
                prepared,
                session: {
                  client: {} as WsRpcProtocolClient,
                  initialConfig: Effect.die("unused config"),
                  subscribeServerConfig: () => Stream.never,
                  ready: Effect.void,
                  probe: Effect.void,
                  closed: Effect.never,
                },
              };
            }),
        }),
      );
      const awaitPhase = (phase: SupervisorConnectionState["phase"]) =>
        SubscriptionRef.changes(supervisor.state).pipe(
          Stream.filter((state) => state.phase === phase),
          Stream.runHead,
        );
      yield* TestClock.adjust(0);
      assert.equal(requests, 1);
      yield* TestClock.adjust("15 seconds");
      assert.equal(requests, 2);
      yield* TestClock.adjust("15 seconds");
      assert.equal((yield* SubscriptionRef.get(supervisor.state)).phase, "backoff");
      yield* TestClock.adjust("2 seconds");
      assert.equal(requests, 3);
      yield* TestClock.adjust("10 seconds");
      yield* Deferred.succeed(finishSetup, undefined);
      yield* awaitPhase("connected");
      assert.equal(authentications, 1);
      yield* supervisor.disconnect;
      yield* awaitPhase("available");
      yield* supervisor.connect;
      yield* TestClock.adjust(0);
      yield* TestClock.adjust("44 seconds");
      assert.equal(requests, 4);
      assert.equal((yield* SubscriptionRef.get(supervisor.state)).phase, "connecting");
      yield* TestClock.adjust("1 second");
      assert.equal(requests, 5);
    }).pipe(Effect.provide(Layer.mergeAll(desktopRuntimeLayer, TestClock.layer()))),
  );

  it.effect("passes key-only provisioning to the SSH manager without requesting a password", () => {
    const target = { alias: "devbox", hostname: "box.example.test", username: null, port: null };
    return Effect.gen(function* () {
      const environment = yield* DesktopSshEnvironment.make;
      const result = yield* environment.ensureEnvironment(target, {
        keyOnly: true,
        issuePairingToken: true,
      });
      if ("type" in result) throw new Error("unexpected pending runtime replacement");
      assert.equal(result.pairingToken, "fixture-token");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeHttpClient.layerUndici,
          NetService.layer,
          Layer.succeed(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {
            request: () => Effect.die("unexpected password prompt"),
            resolve: () => Effect.die("unused"),
          }),
          Layer.succeed(SshTunnel.SshEnvironmentManager, {
            status: () => Effect.die("unused"),
            ensureEnvironment: (receivedTarget, options) =>
              Effect.sync(() => {
                assert.deepEqual(receivedTarget, target);
                assert.deepEqual(options, { keyOnly: true, issuePairingToken: true });
                return {
                  target,
                  httpBaseUrl: "http://127.0.0.1:41773/",
                  wsBaseUrl: "ws://127.0.0.1:41773/",
                  pairingToken: "fixture-token",
                };
              }),
            readyEnvironment: () => Effect.die("Unexpected ready environment"),
            beginSetupOperation: () => Effect.die("Unexpected setup operation"),
            publishProviderDiagnosis: () => Effect.die("Unexpected provider publication"),
            publishSetupOutcome: () => Effect.die("Unexpected setup outcome"),
            forgetEnvironment: () => Effect.die("Unexpected forget"),
            disconnectEnvironment: () => Effect.die("unused"),
            revalidateTunnels: () => Effect.die("unused"),
            issueMcpClientSession: () => Effect.die("unused"),
            issueClientSession: () => Effect.die("unexpected client session"),
            runRemoteScript: () => Effect.die("unused"),
          }),
        ),
      ),
    );
  });
});
