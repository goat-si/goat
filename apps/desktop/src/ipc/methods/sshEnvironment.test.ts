import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopSshEnvironment from "../../ssh/DesktopSshEnvironment.ts";
import { SshHostAnswered } from "@goat/ssh/command";
import * as IpcChannels from "../channels.ts";
import {
  SshEnsureSupersededError,
  SshHttpBridgeError,
  SshPasswordPromptError,
  SshPreparationTimeoutError,
} from "@goat/ssh/errors";
import { SshHostResult } from "@goat/contracts";
import * as SshTunnel from "@goat/ssh/tunnel";
import * as NetService from "@goat/shared/Net";
import * as DesktopSshPasswordPrompts from "../../ssh/DesktopSshPasswordPrompts.ts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { vi } from "vite-plus/test";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  CLOUD_MACHINE_READY_WINDOW_MS,
  DesktopSshEnvironmentRequestError,
  fetchSshEnvironmentDescriptor,
  ensureSshEnvironment,
  requireReadiedCloudMachine,
  getSshHostStatus,
  updateSshRuntime,
} from "./sshEnvironment.ts";

const decodeSshHostResult = Schema.decodeUnknownEffect(SshHostResult);

vi.mock("electron", () => ({}));

/** A desktop whose home is `home`, for the cloud machine guard. */
const desktopAt = (home: string) =>
  Layer.effect(
    DesktopEnvironment.DesktopEnvironment,
    Effect.map(Path.Path, (path) =>
      DesktopEnvironment.DesktopEnvironment.of({
        path,
        homeDirectory: home,
      } as DesktopEnvironment.DesktopEnvironment["Service"]),
    ),
  ).pipe(Layer.provideMerge(NodeServices.layer));

function jsonResponse(request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) {
  return HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function layerHttpClient(
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, never>,
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => handler(request)),
  );
}

const target = { alias: "devbox", hostname: "box.example.test", username: "owner", port: 2207 };
const baseStatus = { host: target.alias, runtimeVersion: "1.2.2", requestedVersion: "1.2.3" };
const unusedSshService = {
  discoverHosts: () => Effect.die("unexpected discovery"),
  resolveHost: () => Effect.die("unexpected resolve"),
  ensureEnvironment: () => Effect.die("unexpected ensure"),
  status: () => Effect.die("unexpected status"),
  update: () => Effect.die("unexpected update"),
  disconnectEnvironment: () => Effect.die("unexpected disconnect"),
  revalidateTunnels: Effect.die("unexpected revalidation"),
} satisfies DesktopSshEnvironment.DesktopSshEnvironment["Service"];

describe("SSH runtime IPC", () => {
  it.effect("decodes structured status and failures over IPC", () =>
    Effect.gen(function* () {
      const results = [
        {
          kind: "ok",
          status: {
            ...baseStatus,
            state: "preparing",
            phase: "uploading",
            upload: { sentBytes: 1024 * 1024, totalBytes: 70 * 1024 * 1024 },
          },
        },
        {
          kind: "ok",
          status: {
            ...baseStatus,
            state: "update_waiting",
            detail: "Another computer is updating devbox. GOAT will retry.",
          },
        },
        {
          kind: "ok",
          status: {
            ...baseStatus,
            state: "failed",
            failure: {
              reason: "archive_unavailable",
              archive: {
                requestedVersion: "1.2.3",
                platformKey: "linux-x64",
                sourcesTried: ["bundle", "https"],
              },
              fix: {
                actor: "human",
                instruction: "Install a published GOAT release, or set a release mirror.",
              },
            },
          },
        },
        {
          kind: "error",
          code: "host_unreachable",
          message: "Can't reach devbox.",
          fix: { actor: "agent", instruction: "Try again" },
        },
      ] satisfies readonly SshHostResult[];
      for (const result of results) {
        const encoded = yield* getSshHostStatus.handler({ target }).pipe(
          Effect.provideService(DesktopSshEnvironment.DesktopSshEnvironment, {
            ...unusedSshService,
            status: () => Effect.succeed(result),
          }),
        );
        assert.deepEqual(yield* decodeSshHostResult(encoded), result);
        const updated = yield* updateSshRuntime.handler({ target }).pipe(
          Effect.provideService(DesktopSshEnvironment.DesktopSshEnvironment, {
            ...unusedSshService,
            update: () => Effect.succeed(result),
          }),
          Effect.provide(desktopAt("/nonexistent-home")),
        );
        assert.deepEqual(yield* decodeSshHostResult(updated), result);
      }
    }),
  );

  it.effect("rejects malformed runtime requests and results", () =>
    Effect.gen(function* () {
      const invalidRequests = [{ target: { ...target, port: "2207" } }, { target, mode: "force" }];
      for (const input of invalidRequests) {
        const exit = yield* updateSshRuntime.handler(input).pipe(Effect.exit);
        assert(Exit.isFailure(exit));
      }
      const invalidResult = yield* getSshHostStatus.handler({ target }).pipe(
        Effect.provideService(DesktopSshEnvironment.DesktopSshEnvironment, {
          ...unusedSshService,
          status: () =>
            Effect.succeed({ kind: "ok", status: { ...baseStatus, state: "preparing" } }),
        }),
        Effect.exit,
      );
      assert(Exit.isFailure(invalidResult));
    }).pipe(
      Effect.provideService(DesktopSshEnvironment.DesktopSshEnvironment, unusedSshService),
      Effect.provide(desktopAt("/nonexistent-home")),
    ),
  );

  it.effect(
    "desktop now uses its owner manager without server WS and preserves hostname user and port",
    () => {
      let confirmed = false;
      const manager = {
        status: () =>
          Effect.succeed({
            kind: "ok",
            status: {
              ...baseStatus,
              state: confirmed ? "ready" : "update_waiting",
              runtimeVersion: confirmed ? "1.2.3" : "1.2.2",
            },
          } satisfies SshHostResult),
        ensureEnvironment: (receivedTarget, options) =>
          Effect.sync(() => {
            assert.deepEqual(receivedTarget, target);
            assert.equal(options?.keyOnly, true);
            assert.equal(options?.issuePairingToken, false);
            confirmed = options?.refreshRuntime === true && options.confirmReplacement === true;
            return {
              target: receivedTarget,
              httpBaseUrl: "http://127.0.0.1:41773/",
              wsBaseUrl: "ws://127.0.0.1:41773/",
              pairingToken: null,
            };
          }),
        readyEnvironment: () => Effect.die("Unexpected ready environment"),
        beginSetupOperation: () => Effect.die("Unexpected setup operation"),
        publishProviderDiagnosis: () => Effect.die("Unexpected provider publication"),
        publishSetupOutcome: () => Effect.die("Unexpected setup outcome"),
        forgetEnvironment: () => Effect.die("Unexpected forget"),
        disconnectEnvironment: () => Effect.void,
        revalidateTunnels: () => Effect.void,
        issueMcpClientSession: () => Effect.die("unexpected MCP session"),
        issueClientSession: () => Effect.die("unexpected client session"),
        runRemoteScript: () => Effect.die("unexpected remote script"),
      } satisfies SshTunnel.SshEnvironmentManagerShape;
      return Effect.gen(function* () {
        const service = yield* DesktopSshEnvironment.make;
        const invoke = (mode?: "when_idle" | "now") =>
          updateSshRuntime
            .handler({ target, ...(mode === undefined ? {} : { mode }) })
            .pipe(
              Effect.provideService(DesktopSshEnvironment.DesktopSshEnvironment, service),
              Effect.flatMap(decodeSshHostResult),
            );
        assert.equal((yield* invoke()).status?.state, "update_waiting");
        assert.equal((yield* invoke("when_idle")).status?.state, "update_waiting");
        const updated = yield* invoke("now");
        assert.equal(updated.status?.state, "ready");
        assert.equal(updated.status?.requestedVersion, "1.2.3");
      }).pipe(
        Effect.provideService(SshTunnel.SshEnvironmentManager, manager),
        Effect.provideService(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {
          request: () => Effect.die("unexpected password"),
          resolve: () => Effect.die("unexpected resolution"),
        }),
        Effect.provide(
          Layer.mergeAll(
            desktopAt("/nonexistent-home"),
            layerHttpClient(() => Effect.die("unexpected HTTP request")),
            NetService.layer,
          ),
        ),
      );
    },
  );

  it.effect(
    "reads cloud runtime status without provisioning and guards updates before mutation",
    () => {
      const cloudTarget = { ...target, alias: "boat-bx_23456789" };
      return Effect.gen(function* () {
        const status = yield* getSshHostStatus.handler({ target: cloudTarget });
        assert.deepEqual(yield* decodeSshHostResult(status), {
          kind: "ok",
          status: { ...baseStatus, host: cloudTarget.alias, state: "stopped" },
        });
        const exit = yield* updateSshRuntime
          .handler({ target: cloudTarget, mode: "now" })
          .pipe(Effect.exit);
        assert(Exit.isFailure(exit));
        const failure = Cause.findErrorOption(exit.cause);
        assert(Option.isSome(failure));
        assert.include(failure.value.message, "belongs to another GOAT server");
      }).pipe(
        Effect.provideService(DesktopSshEnvironment.DesktopSshEnvironment, {
          ...unusedSshService,
          status: () =>
            Effect.succeed({
              kind: "ok",
              status: { ...baseStatus, host: cloudTarget.alias, state: "stopped" },
            }),
        }),
        Effect.provide(desktopAt("/nonexistent-home")),
      );
    },
  );
});

describe("SSH environment IPC", () => {
  it.effect(
    "preserves the prompt-cancel result and distinguishes native supersession and expiry",
    () =>
      Effect.gen(function* () {
        const cancelled = new SshPasswordPromptError({
          message: "SSH authentication cancelled for devbox.",
          cause: new DesktopSshPasswordPrompts.DesktopSshPromptCancelledError({
            requestId: "prompt-1",
            destination: "devbox",
          }),
        });
        const invoke = (error: DesktopSshEnvironment.DesktopSshEnvironmentOperationError) =>
          ensureSshEnvironment.handler({ target, requestId: "request-1" }).pipe(
            Effect.provideService(DesktopSshEnvironment.DesktopSshEnvironment, {
              ...unusedSshService,
              ensureEnvironment: () => Effect.fail(error),
            }),
          );
        assert.deepEqual(yield* invoke(cancelled), {
          type: IpcChannels.SSH_PASSWORD_PROMPT_CANCELLED_RESULT,
          message: cancelled.message,
        });
        for (const error of [
          new SshEnsureSupersededError({
            message: "SSH preparation superseded by a newer connection intent.",
          }),
          new SshPreparationTimeoutError({
            message: "SSH runtime preparation exceeded its 15-minute limit.",
          }),
        ]) {
          const result = yield* invoke(error).pipe(Effect.exit);
          assert(Exit.isFailure(result));
          const cause = Cause.findErrorOption(result.cause);
          assert(Option.isSome(cause));
          assert.strictEqual(cause.value, error);
        }
      }).pipe(Effect.provide(desktopAt("/nonexistent-home"))),
  );
  it.effect("sends one preparation answer to the requesting renderer with its request ID", () =>
    Effect.gen(function* () {
      const sent: unknown[] = [];
      const result = yield* ensureSshEnvironment
        .handler(
          { target, requestId: "setup-1", options: { issuePairingToken: false } },
          {
            sender: {
              id: 42,
              send: (...args) => {
                sent.push(args);
              },
            },
          },
        )
        .pipe(
          Effect.provide(desktopAt("/nonexistent-home")),
          Effect.provideService(DesktopSshEnvironment.DesktopSshEnvironment, {
            ...unusedSshService,
            ensureEnvironment: () =>
              Effect.gen(function* () {
                const answer = yield* SshHostAnswered;
                answer?.();
                answer?.();
                return {
                  target,
                  httpBaseUrl: "http://127.0.0.1:41773/",
                  wsBaseUrl: "ws://127.0.0.1:41773/",
                  pairingToken: null,
                };
              }),
          }),
        );
      assert.deepEqual(sent, [[IpcChannels.SSH_ENVIRONMENT_ANSWERED_CHANNEL, "setup-1"]]);
      assert.equal((result as { pairingToken: null }).pairingToken, null);
    }),
  );

  it.effect("preserves key-only options across the IPC handler", () =>
    Effect.gen(function* () {
      const target = {
        alias: "devbox",
        hostname: "devbox.example.test",
        username: null,
        port: null,
      };
      let received: unknown;
      const result = yield* ensureSshEnvironment
        .handler({ target, options: { keyOnly: true, issuePairingToken: true } })
        .pipe(
          Effect.provide(desktopAt("/nonexistent-home")),
          Effect.provideService(DesktopSshEnvironment.DesktopSshEnvironment, {
            status: () => Effect.die("unused"),
            update: () => Effect.die("unused"),
            discoverHosts: () => Effect.die("unused"),
            resolveHost: () => Effect.die("unused"),
            disconnectEnvironment: () => Effect.die("unused"),
            revalidateTunnels: Effect.die("unused"),
            ensureEnvironment: (receivedTarget, options) =>
              Effect.sync(() => {
                const { onPreparationProgress, onPreparationAdmission, ...nativeOptions } =
                  options ?? {};
                assert.isFunction(onPreparationProgress);
                assert.isFunction(onPreparationAdmission);
                received = { target: receivedTarget, options: nativeOptions };
                return {
                  target,
                  httpBaseUrl: "http://127.0.0.1:41773/",
                  wsBaseUrl: "ws://127.0.0.1:41773/",
                  pairingToken: "fixture-token",
                };
              }),
          }),
        );
      assert.deepEqual(received, { target, options: { keyOnly: true, issuePairingToken: true } });
      assert.deepEqual(result, {
        target,
        httpBaseUrl: "http://127.0.0.1:41773/",
        wsBaseUrl: "ws://127.0.0.1:41773/",
        pairingToken: "fixture-token",
      });
    }),
  );

  it.effect(
    "keeps shared-operation events and trace provenance scoped to each sender and request",
    () =>
      Effect.gen(function* () {
        const entered =
          yield* Queue.unbounded<
            NonNullable<
              Parameters<
                DesktopSshEnvironment.DesktopSshEnvironment["Service"]["ensureEnvironment"]
              >[1]
            >
          >();
        const release = yield* Deferred.make<void>();
        const spans: Tracer.Span[] = [];
        const tracer = Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            spans.push(span);
            return span;
          },
        });
        const sent = [[], []] as unknown[][];
        const invoke = (index: number) =>
          ensureSshEnvironment
            .handler(
              {
                target,
                requestId: `request-${index}`,
                caller: index === 0 ? "saved-connection" : "provision",
                attemptContext: {
                  supervisorId: `window-${index}`,
                  attemptId: index + 1,
                  routeId: "ssh:devbox",
                },
                options: { preparedAttachmentId: "attachment-1", issuePairingToken: true },
              },
              {
                sender: {
                  id: 41 + index,
                  send: (...args) => {
                    sent[index]!.push(args);
                  },
                },
              },
            )
            .pipe(Effect.provideService(Tracer.Tracer, tracer));
        const service = {
          ...unusedSshService,
          ensureEnvironment: (_target, options) =>
            Effect.gen(function* () {
              assert.equal(options?.preparedAttachmentId, "attachment-1");
              yield* Queue.offer(entered, options!);
              yield* Deferred.await(release);
              return {
                target,
                httpBaseUrl: "http://127.0.0.1:41773/",
                wsBaseUrl: "ws://127.0.0.1:41773/",
                pairingToken: "fixture-private-pairing",
              };
            }),
        } satisfies DesktopSshEnvironment.DesktopSshEnvironment["Service"];
        yield* Effect.gen(function* () {
          const first = yield* invoke(0).pipe(Effect.forkChild);
          const firstObservers = yield* Queue.take(entered);
          const second = yield* invoke(1).pipe(Effect.forkChild);
          const secondObservers = yield* Queue.take(entered);
          firstObservers.onPreparationAdmission?.({
            operationId: "shared-flight",
            disposition: "leader",
            generation: 7,
          });
          secondObservers.onPreparationAdmission?.({
            operationId: "shared-flight",
            disposition: "join",
            generation: 7,
          });
          const active = {
            operationId: "shared-flight",
            phase: "uploading",
            hostAnswered: true,
            remainingMs: 880_000,
          } as const;
          firstObservers.onPreparationProgress?.(active);
          secondObservers.onPreparationProgress?.(active);
          firstObservers.onPreparationProgress?.({ ...active, phase: null, outcome: "pending" });
          secondObservers.onPreparationProgress?.({ ...active, phase: null, outcome: "pending" });
          assert.deepEqual(
            sent,
            [0, 1].map((index) => [
              [
                IpcChannels.SSH_ENVIRONMENT_PROGRESS_CHANNEL,
                { requestId: `request-${index}`, ...active },
              ],
              [
                IpcChannels.SSH_ENVIRONMENT_PROGRESS_CHANNEL,
                { requestId: `request-${index}`, ...active, phase: null, outcome: "pending" },
              ],
            ]),
          );
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(second);
          const ensureSpans = spans.filter(
            (span) => span.name === "desktop.ipc.sshEnvironment.ensureEnvironment",
          );
          assert.equal(ensureSpans.length, 2);
          for (const [index, span] of ensureSpans.entries()) {
            assert.equal(span.attributes.get("senderId"), 41 + index);
            assert.equal(
              span.attributes.get("key"),
              "devbox\u0000box.example.test\u0000owner\u00002207",
            );
            assert.equal(
              span.attributes.get("caller"),
              index === 0 ? "saved-connection" : "provision",
            );
            assert.equal(span.attributes.get("requestId"), `request-${index}`);
            assert.equal(span.attributes.get("supervisorId"), `window-${index}`);
            assert.equal(span.attributes.get("attemptId"), index + 1);
            assert.equal(span.attributes.get("routeId"), "ssh:devbox");
            assert.equal(span.attributes.get("operationId"), "shared-flight");
            assert.equal(span.attributes.get("disposition"), index === 0 ? "leader" : "join");
            assert.equal(span.attributes.get("generation"), 7);
            assert.equal(span.attributes.get("outcome"), "ready");
            assert.notInclude(JSON.stringify([...span.attributes]), "fixture-private-pairing");
          }
        }).pipe(Effect.provideService(DesktopSshEnvironment.DesktopSshEnvironment, service));
      }).pipe(Effect.provide(desktopAt("/nonexistent-home"))),
  );

  it.effect(
    "detaches destroyed and throwing senders without failing preparation or other requests",
    () =>
      Effect.gen(function* () {
        const spans: Tracer.Span[] = [];
        const tracer = Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            spans.push(span);
            return span;
          },
        });
        for (const mode of ["destroyed", "throws", "live"] as const) {
          const sent: unknown[] = [];
          const sender = {
            id: 42,
            isDestroyed: () => mode === "destroyed",
            send: (...args: unknown[]) => {
              if (mode === "throws") throw new Error("Object has been destroyed");
              sent.push(args);
            },
          };
          const result = yield* ensureSshEnvironment
            .handler({ target, requestId: mode }, { sender })
            .pipe(
              Effect.provideService(DesktopSshEnvironment.DesktopSshEnvironment, {
                ...unusedSshService,
                ensureEnvironment: (_target, options) =>
                  Effect.gen(function* () {
                    (yield* SshHostAnswered)?.();
                    options?.onPreparationAdmission?.({
                      operationId: "flight",
                      disposition: "attachment-completion",
                      generation: 1,
                    });
                    options?.onPreparationProgress?.({
                      operationId: "flight",
                      phase: "checking",
                      hostAnswered: true,
                      remainingMs: 1_000,
                    });
                    options?.onPreparationProgress?.({
                      operationId: "flight",
                      phase: null,
                      outcome: "failed",
                      hostAnswered: true,
                      remainingMs: 0,
                    });
                    return {
                      target,
                      httpBaseUrl: "http://127.0.0.1:41773/",
                      wsBaseUrl: "ws://127.0.0.1:41773/",
                      pairingToken: null,
                    };
                  }),
              }),
              Effect.provideService(Tracer.Tracer, tracer),
            );
          assert.equal((result as { pairingToken: null }).pairingToken, null);
          assert.equal(sent.length, mode === "live" ? 3 : 0);
        }
        const ensures = spans.filter(
          (span) => span.name === "desktop.ipc.sshEnvironment.ensureEnvironment",
        );
        assert.deepEqual(
          ensures.map((span) => span.attributes.get("observerDetached") ?? false),
          [true, true, false],
        );
      }).pipe(Effect.provide(desktopAt("/nonexistent-home"))),
  );

  it.effect("rejects non-loopback HTTP endpoints before issuing a request", () => {
    let requestCount = 0;
    const layer = layerHttpClient((request) =>
      Effect.sync(() => {
        requestCount += 1;
        return jsonResponse(request, {});
      }),
    );

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        fetchSshEnvironmentDescriptor.handler({
          httpBaseUrl: "http://remote.example.com:41773/",
        }),
      );
      assert(Exit.isFailure(exit));
      const failure = Cause.findErrorOption(exit.cause);
      assert(Option.isSome(failure));
      const error = failure.value;

      assert.instanceOf(error, DesktopSshEnvironmentRequestError);
      assert.instanceOf(error.cause, SshHttpBridgeError);
      assert.equal(requestCount, 0);
    }).pipe(Effect.provide(layer));
  });
});

describe("cloud machine guard", () => {
  const ALIAS = "boat-bx_23456789";
  const withHome = <A, E>(
    use: (
      home: string,
      fs: FileSystem.FileSystem,
    ) => Effect.Effect<A, E, DesktopEnvironment.DesktopEnvironment | FileSystem.FileSystem>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-desktop-cloud-test-" });
        return yield* use(home, fs).pipe(Effect.provide(desktopAt(home)));
      }),
    ).pipe(Effect.provide(NodeServices.layer));

  it.effect("refuses a cloud machine this computer's server has not readied recently", () =>
    withHome((home, fs) =>
      Effect.gen(function* () {
        const missing = yield* requireReadiedCloudMachine(ALIAS).pipe(Effect.flip);
        assert.include(missing.message, "belongs to another GOAT server");

        const dir = `${home}/.ssh/goat-cloud`;
        yield* fs.makeDirectory(dir, { recursive: true });
        yield* fs.writeFileString(`${dir}/${ALIAS}.conf`, "Host x\n");
        const written = Option.getOrThrow((yield* fs.stat(`${dir}/${ALIAS}.conf`)).mtime).getTime();
        yield* TestClock.setTime(written);
        yield* requireReadiedCloudMachine(ALIAS);

        yield* TestClock.setTime(written + CLOUD_MACHINE_READY_WINDOW_MS + 60_000);
        const stale = yield* requireReadiedCloudMachine(ALIAS).pipe(Effect.flip);
        assert.include(stale.message, "Prepare this cloud machine");

        // Ordinary hosts, including other boat- names, are not checked.
        yield* requireReadiedCloudMachine("devbox");
        yield* requireReadiedCloudMachine("boat-house");
      }),
    ),
  );
});
