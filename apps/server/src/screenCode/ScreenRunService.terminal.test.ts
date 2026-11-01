import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ScreenRunError,
  type ScreenRunResult,
} from "@goat/contracts";
import type { ComputerUseTerminalReason } from "../cua/ComputerUseTerminal.ts";
import { finishCellResponse, makeCellAuthority } from "./ScreenCellAuthority.ts";
import * as ComputerUseLeases from "../cua/ComputerUseLeases.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";
import { harness, active, CONTROL } from "../cua/ComputerUseLeaseProxy.testkit.ts";
import { driverError } from "./DesktopDriverReplies.ts";
import { fixture as desktopFixture } from "./DesktopTargetHost.testkit.ts";

const invocation = {
  environmentId: EnvironmentId.make("env"),
  capabilities: new Set<"preview">(),
  issuedAt: 0,
  requestNamespace: "test",
  client: undefined,
  thread: {
    threadId: ThreadId.make("thread"),
    providerSessionId: "s",
    providerInstanceId: ProviderInstanceId.make("p"),
  },
};

it.live("screen.run preserves dispatcher Stop when a lock cuts its cell", () =>
  Effect.gen(function* () {
    let notify: Parameters<
      NonNullable<ComputerUseLeases.ComputerUseLeases["Service"]["onAuthorityChange"]>
    >[0] = () => {};
    const leases = yield* ComputerUseLeases.ComputerUseLeases.pipe(
      Effect.provide(
        Layer.mock(ComputerUseLeases.ComputerUseLeases)({
          proxy: undefined,
          currentControl: () =>
            Effect.succeedSome({
              threadId: ThreadId.make("thread"),
              controlId: "A",
              expiresAt: DateTime.makeUnsafe(60000),
            }),
          onAuthorityChange: (listener) => {
            notify = listener;
            return () => {};
          },
          releaseForeground: () => Effect.succeed(false),
        }),
      ),
    );
    const service = yield* ScreenRunService.pipe(
      Effect.provide(
        ScreenRunService.layerWithRuntime({
          leases,
          invocation: {
            command: process.execPath,
            entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
          },
          assetResolver: () => resolveScreenRuntimeAsset("dev"),
          dispatcher: {
            availability: () => Effect.succeed([{ kind: "app", available: true }]),
            dispatch: () =>
              Effect.suspend(() => {
                notify({
                  kind: "pause",
                  threadId: ThreadId.make("thread"),
                  controlId: "A",
                  terminal: "screen_locked",
                });
                return Effect.fail<ScreenRunError>({
                  code: "stopped_by_person",
                  effectStarted: true,
                  nextStep: "Do not retry this turn.",
                });
              }),
          },
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    );
    const answer = yield* service
      .runCell({
        runId: "run",
        turnId: "turn",
        threadId: "thread",
        environmentId: "env",
        invocation,
        source: "return await screen.list_apps();",
      })
      .pipe(Effect.result);
    expect(answer._tag).toBe("Failure");
    if (answer._tag === "Failure") {
      expect(answer.failure.code).toBe("stopped_by_person");
      expect(answer.failure.safety?.retryClass).toBe("never");
      expect(answer.failure.safety?.possibleCommit).toBe(true);
    }
  }),
);

it.live("a late Stop for an old control does not fence a newer control's unfinished cell", () =>
  Effect.gen(function* () {
    const firstEntered = yield* Deferred.make<void, string>();
    const secondEntered = yield* Deferred.make<void, string>();
    const release = yield* Deferred.make<void>();
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
    let controlId = "A";
    let notify: Parameters<
      NonNullable<ComputerUseLeases.ComputerUseLeases["Service"]["onAuthorityChange"]>
    >[0] = () => {};
    const leases = yield* ComputerUseLeases.ComputerUseLeases.pipe(
      Effect.provide(
        Layer.mock(ComputerUseLeases.ComputerUseLeases)({
          proxy: undefined,
          currentControl: (threadId) =>
            Effect.sync(() =>
              Option.some({ threadId, controlId, expiresAt: DateTime.makeUnsafe(60000) }),
            ),
          onAuthorityChange: (listener) => {
            notify = listener;
            return () => {};
          },
          releaseForeground: () => Effect.succeed(false),
        }),
      ),
    );
    const { host } = desktopFixture({});
    const service = yield* ScreenRunService.pipe(
      Effect.provide(
        ScreenRunService.layerWithRuntime({
          leases,
          invocation: {
            command: process.execPath,
            entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
          },
          assetResolver: () => resolveScreenRuntimeAsset("dev"),
          desktopHost: {
            ...host,
            finishCell: (context) =>
              Deferred.succeed(
                context.turnId === "A" ? firstEntered : secondEntered,
                undefined,
              ).pipe(Effect.andThen(Deferred.await(release)), Effect.as({})),
          },
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    );
    const request = {
      runId: "run",
      threadId: "thread",
      environmentId: "env",
      invocation,
      source: "return 1;",
    };
    const first = yield* service
      .runCell({ ...request, turnId: "A" })
      .pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(firstEntered);
    controlId = "B";
    const second = yield* service.runCell({ ...request, turnId: "B" }).pipe(
      Effect.tapError(() => Deferred.fail(secondEntered, "second cell did not start")),
      Effect.result,
      Effect.forkChild,
    );
    yield* Deferred.await(secondEntered);
    notify({
      kind: "stop",
      threadId: ThreadId.make("thread"),
      controlId: "A",
      terminal: "stopped_by_person",
    });
    yield* Deferred.succeed(release, undefined);
    const a = yield* Fiber.join(first);
    const b = yield* Fiber.join(second);
    expect(a._tag).toBe("Failure");
    if (a._tag === "Failure") expect(a.failure.code).toBe("stopped_by_person");
    expect(b._tag).toBe("Success");
  }),
);

it.live.each(["lock first", "stop first"])(
  "end-cell collection merges terminal causes and preserves possible input: %s",
  (order) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let notify: Parameters<
        NonNullable<ComputerUseLeases.ComputerUseLeases["Service"]["onAuthorityChange"]>
      >[0] = () => {};
      const leases = yield* ComputerUseLeases.ComputerUseLeases.pipe(
        Effect.provide(
          Layer.mock(ComputerUseLeases.ComputerUseLeases)({
            proxy: undefined,
            currentControl: () => Effect.succeedNone,
            onAuthorityChange: (listener) => {
              notify = listener;
              return () => {};
            },
            releaseForeground: () => Effect.succeed(false),
          }),
        ),
      );
      const { host } = desktopFixture({});
      const service = yield* ScreenRunService.pipe(
        Effect.provide(
          ScreenRunService.layerWithRuntime({
            leases,
            invocation: {
              command: process.execPath,
              entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
            },
            assetResolver: () => resolveScreenRuntimeAsset("dev"),
            desktopHost: {
              ...host,
              finishCell: () =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(
                    Effect.fail<ScreenRunError>({
                      code: order === "lock first" ? "stopped_by_person" : "screen_locked",
                      effectStarted: true,
                      nextStep: "interrupted",
                    }),
                  ),
                ),
            },
          }).pipe(Layer.provide(NodeServices.layer)),
        ),
      );
      const pending = yield* service
        .runCell({
          runId: "run-terminal",
          turnId: "turn-terminal",
          threadId: "thread",
          environmentId: "env",
          invocation,
          source: "return 1;",
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      const terminal = order === "lock first" ? "screen_locked" : "stopped_by_person";
      notify({
        kind: terminal === "screen_locked" ? "pause" : "stop",
        threadId: ThreadId.make("thread"),
        controlId: "control",
        terminal,
      });
      yield* Deferred.succeed(release, undefined);
      const answer = yield* Fiber.join(pending);
      expect(answer._tag).toBe("Failure");
      if (answer._tag === "Failure") {
        expect(answer.failure.code).toBe("stopped_by_person");
        expect(answer.failure.safety?.retryClass).toBe("never");
        expect(answer.failure.safety?.possibleCommit).toBe(true);
      }
    }),
);

it.live.each(["stopped_by_person", "screen_locked"] as const)(
  "a lease authority %s cutoff stays terminal at the screen.run boundary",
  (reason) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      let trigger = () => {};
      const leases = yield* ComputerUseLeases.ComputerUseLeases.pipe(
        Effect.provide(
          Layer.mock(ComputerUseLeases.ComputerUseLeases)({
            proxy: undefined,
            currentControl: () => Effect.succeedNone,
            onAuthorityChange: (listener) => {
              trigger = () =>
                listener({
                  kind: reason === "screen_locked" ? "pause" : "stop",
                  threadId: ThreadId.make("thread"),
                  controlId: "control",
                  terminal: reason,
                });
              return () => {};
            },
            releaseForeground: () => Effect.succeed(false),
          }),
        ),
      );
      const service = yield* ScreenRunService.pipe(
        Effect.provide(
          ScreenRunService.layerWithRuntime({
            leases,
            invocation: {
              command: process.execPath,
              entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
            },
            assetResolver: () => resolveScreenRuntimeAsset("dev"),
            dispatcher: {
              availability: () => Effect.succeed([{ kind: "app", available: true }]),
              dispatch: () =>
                Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
            },
          }).pipe(Layer.provide(NodeServices.layer)),
        ),
      );
      const running = yield* service
        .runCell({
          runId: "run-terminal",
          turnId: "turn-terminal",
          threadId: "thread",
          environmentId: "env",
          invocation,
          source: "return await screen.list_apps();",
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      trigger();
      const result = yield* Fiber.join(running);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.code).toBe(reason);
        expect(result.failure.safety?.retryClass).toBe("never");
      }
    }),
);

it.live.each(["lock", "stop", "lock then stop", "stop then lock", "lock then resume then stop"])(
  "successful end-cell collection must preserve a terminal cutoff: %s",
  (order) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let notify: Parameters<
        NonNullable<ComputerUseLeases.ComputerUseLeases["Service"]["onAuthorityChange"]>
      >[0] = () => {};
      const leases = yield* ComputerUseLeases.ComputerUseLeases.pipe(
        Effect.provide(
          Layer.mock(ComputerUseLeases.ComputerUseLeases)({
            proxy: undefined,
            currentControl: () => Effect.succeedNone,
            onAuthorityChange: (listener) => {
              notify = listener;
              return () => {};
            },
            releaseForeground: () => Effect.succeed(false),
          }),
        ),
      );
      const { host } = desktopFixture({});
      const service = yield* ScreenRunService.pipe(
        Effect.provide(
          ScreenRunService.layerWithRuntime({
            leases,
            invocation: {
              command: process.execPath,
              entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
            },
            assetResolver: () => resolveScreenRuntimeAsset("dev"),
            dispatcher: {
              availability: () => Effect.succeed([{ kind: "app", available: true }]),
              dispatch: () =>
                Effect.succeed({
                  category: "confirmed",
                  value: [],
                  evidence: ["fixture:apps_read"],
                }),
            },
            desktopHost: {
              ...host,
              finishCell: () =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(Effect.succeed({})),
                ),
            },
          }).pipe(Layer.provide(NodeServices.layer)),
        ),
      );
      const pending = yield* service
        .runCell({
          runId: "run-terminal",
          turnId: "turn-terminal",
          threadId: "thread",
          environmentId: "env",
          invocation,
          source: "return await screen.list_apps();",
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      const terminal = order === "lock" ? "screen_locked" : "stopped_by_person";
      const emit = (reason: "screen_locked" | "stopped_by_person") =>
        notify({
          kind: reason === "screen_locked" ? "pause" : "stop",
          threadId: ThreadId.make("thread"),
          controlId: "control",
          terminal: reason,
        });
      if (order === "lock" || order === "lock then stop" || order === "lock then resume then stop")
        emit("screen_locked");
      if (order === "lock then resume then stop")
        yield* service.controlChanged({ kind: "resume", threadId: "thread", controlId: "control" });
      if (order !== "lock") emit("stopped_by_person");
      if (order === "stop then lock") emit("screen_locked");
      yield* Deferred.succeed(release, undefined);
      const answer = yield* Fiber.join(pending);
      expect(answer._tag).toBe("Failure");
      if (answer._tag === "Failure") {
        expect(answer.failure.code).toBe(terminal);
        expect(answer.failure.safety?.retryClass).toBe("never");
      }
    }),
);

it.live.each([
  "stop",
  "lock",
  "lock then stop",
  "stop then lock",
  "lock reply then stop",
  "finish turn then stop",
])("outbound terminal after final collection: %s", (order) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void, string>();
    const release = yield* Deferred.make<void>();
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
    const clock = yield* Clock.Clock;
    let afterCollection = false;
    let blocked = false;
    let notify: Parameters<
      NonNullable<ComputerUseLeases.ComputerUseLeases["Service"]["onAuthorityChange"]>
    >[0] = () => {};
    const leases = yield* ComputerUseLeases.ComputerUseLeases.pipe(
      Effect.provide(
        Layer.mock(ComputerUseLeases.ComputerUseLeases)({
          proxy: undefined,
          currentControl: () =>
            Effect.succeedSome({
              threadId: ThreadId.make("thread"),
              controlId: "A",
              expiresAt: DateTime.makeUnsafe(60000),
            }),
          onAuthorityChange: (listener) => {
            notify = listener;
            return () => {};
          },
          releaseForeground: () => Effect.succeed(false),
        }),
      ),
    );
    const { host } = desktopFixture({});
    const service = yield* ScreenRunService.pipe(
      Effect.provide(
        ScreenRunService.layerWithRuntime({
          leases,
          invocation: {
            command: process.execPath,
            entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
          },
          assetResolver: () => resolveScreenRuntimeAsset("dev"),
          desktopHost: {
            ...host,
            finishCell: () =>
              Effect.sync(() => {
                afterCollection = true;
                if (order === "lock reply then stop")
                  notify({
                    kind: "pause",
                    threadId: ThreadId.make("thread"),
                    controlId: "A",
                    terminal: "screen_locked",
                  });
                return {};
              }),
          },
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    );
    const pending = yield* service
      .runCell({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        invocation,
        source: "return 1;",
      })
      .pipe(
        Effect.provideService(
          Clock.Clock,
          Object.assign(Object.create(clock), {
            currentTimeMillis: Effect.suspend(() => {
              if (afterCollection && !blocked) {
                blocked = true;
                return Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(clock.currentTimeMillis),
                );
              }
              return clock.currentTimeMillis;
            }),
          }),
        ),
        Effect.tapCause(() => Deferred.fail(entered, "cell failed before finalization")),
        Effect.result,
        Effect.forkChild,
      );
    yield* Deferred.await(entered);
    if (order === "finish turn then stop")
      yield* service.finishTurn({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        reason: "completed",
      });
    const emit = (terminal: "stopped_by_person" | "screen_locked") =>
      notify({
        kind: terminal === "screen_locked" ? "pause" : "stop",
        threadId: ThreadId.make("thread"),
        controlId: "A",
        terminal,
      });
    if (order.startsWith("lock")) emit("screen_locked");
    if (order.includes("stop")) emit("stopped_by_person");
    if (order === "stop then lock" || order === "lock") emit("screen_locked");
    yield* Deferred.succeed(release, undefined);
    const answer = yield* Fiber.join(pending);
    expect(answer._tag).toBe("Failure");
    if (answer._tag === "Failure")
      expect(answer.failure.code).toBe(order === "lock" ? "screen_locked" : "stopped_by_person");
  }),
);

it.effect("the final cell latch preserves possible input from an earlier terminal failure", () =>
  Effect.gen(function* () {
    const cells = makeCellAuthority(undefined);
    const terminals = new Map<string, ComputerUseTerminalReason>();
    expect(yield* cells.begin("run", "cell", "thread")).toBe(true);
    terminals.set("run", "stopped_by_person");
    const answer = yield* Effect.fail<ScreenRunError>({
      code: "screen_locked",
      effectStarted: true,
      nextStep: "interrupted",
    }).pipe(finishCellResponse({ id: "run", cellId: "cell", cells, terminals }), Effect.result);
    expect(answer._tag).toBe("Failure");
    if (answer._tag === "Failure") {
      expect(answer.failure.code).toBe("stopped_by_person");
      expect(answer.failure.safety?.retryClass).toBe("never");
      expect(answer.failure.safety?.possibleCommit).toBe(true);
    }
    expect(cells.get("run")).toBeUndefined();
    expect(terminals.has("run")).toBe(false);
  }),
);

it.effect("a late terminal result retains cell window evidence", () =>
  Effect.gen(function* () {
    const cells = makeCellAuthority(undefined);
    const terminals = new Map<string, ComputerUseTerminalReason>();
    yield* cells.begin("run", "cell", "thread");
    terminals.set("run", "stopped_by_person");
    const answer = yield* Effect.succeed({
      runId: "run",
      turnId: "turn",
      cellId: "cell",
      status: "completed",
      console: [],
      journal: [],
      truncated: [],
      availability: [],
      imageMetadata: [],
      images: [],
      windowsOpenedUnverified: true,
    } satisfies ScreenRunResult).pipe(
      finishCellResponse({ id: "run", cellId: "cell", cells, terminals }),
      Effect.result,
    );
    expect(answer._tag).toBe("Failure");
    if (answer._tag === "Failure") expect(answer.failure.windowsOpenedUnverified).toBe(true);
  }),
);

it.live.each([false, true])(
  "screen.run preserves terminal image evidence with huge metadata=%s",
  (huge) =>
    Effect.gen(function* () {
      const expiry = "2099-01-01T00:00:00.000Z";
      const h = yield* harness({ expiresAt: expiry });
      yield* h.push(active(expiry));
      yield* h.applied;
      const driver = yield* h.driverStarted;
      const service = yield* ScreenRunService.pipe(
        Effect.provide(
          ScreenRunService.layerWithRuntime({
            invocation: {
              command: process.execPath,
              entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
            },
            assetResolver: () => resolveScreenRuntimeAsset("dev"),
            dispatcher: {
              availability: () => Effect.succeed([{ kind: "app", available: true }]),
              dispatch: (call) =>
                Effect.gen(function* () {
                  yield* h.sendPrimitive({
                    state: "primitive-request",
                    requestId: "req",
                    registrationId: "reg",
                    controlId: CONTROL,
                    connectionGeneration: driver.connectionId,
                    runId: call.runId,
                    turnId: call.turnId,
                    callId: call.callId,
                    deadlineMillis: call.deadlineMillis,
                    tool: "list_apps",
                    args: {},
                  });
                  const sent = yield* h.nextToDriver;
                  yield* h.reply(
                    JSON.stringify({
                      jsonrpc: "2.0",
                      id: sent.id,
                      result: {
                        isError: true,
                        structuredContent: {
                          code: "stopped_by_person",
                          safety: { possibleCommit: true, retryClass: "never" },
                          screenshot_width: 1,
                          screenshot_height: 1,
                          padding: huge ? "x".repeat(1024 * 1024) : "",
                        },
                        content: [
                          {
                            type: "image",
                            mimeType: "image/png",
                            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=",
                          },
                        ],
                      },
                    }),
                  );
                  const received = yield* h.primitiveReply;
                  const error = driverError(received);
                  if (error) return yield* Effect.fail(error);
                  return { category: "confirmed" as const, evidence: ["fixture"], value: {} };
                }),
            },
          }).pipe(Layer.provide(NodeServices.layer)),
        ),
      );
      const answer = yield* service
        .runCell({
          runId: "r",
          turnId: "t",
          threadId: "thread",
          environmentId: "env",
          invocation,
          source: "return await screen.list_apps();",
        })
        .pipe(Effect.result);
      expect(answer._tag).toBe("Failure");
      if (answer._tag === "Failure") {
        expect(answer.failure.code).toBe("stopped_by_person");
        expect(answer.failure.effectStarted).toBe(true);
        expect(answer.failure.safety?.possibleCommit).toBe(true);
        expect(answer.failure.safety?.retryClass).toBe("never");
      }
    }),
);
