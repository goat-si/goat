import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderTurnId, RunAttemptId, RunId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Detached from "../provider/CodexDetachedAppServerLive.ts";
import { CodexDetachedAppServerError } from "../provider/CodexDetachedAppServer.ts";
import { layerTest } from "./FoundationPersistence.testkit.ts";
import * as Recovery from "./ProviderRuntimeRecoveryService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RuntimeDrain from "../runtimeDrain.ts";
import * as DesktopStopIntent from "../desktopStopIntent.ts";

it.effect.each(
  (["off", "restart", "always"] as const).flatMap((setting) =>
    (
      [
        "quit",
        "relaunch",
        "update-install",
        "recovery-retry",
        "none",
        "reader-timeout",
        "drain-mark",
      ] as const
    ).map((intent) => [setting, intent] as const),
  ),
)("retains eligible instances only for the selected stop intent (%s, %s)", ([setting, intent]) =>
  Effect.gen(function* () {
    const retained: string[] = [];
    const detached = Layer.mock(Detached.CodexDetachedAppServers)({
      socketTransportEnabled: true,
      loadRecords: Effect.succeed([
        {
          name: "record",
          instanceId: "codex",
          providerSessionId: "session",
          state: "running",
          stderrMode: "discard",
        },
      ] as never),
      retainOnClose: (name) =>
        Effect.sync(() => {
          retained.push(name);
          return true;
        }),
    });
    const threadId = ThreadId.make("retention-thread");
    const projection = {
      thread: { id: threadId, projectId: "project" },
      providerThreads: [
        { id: "pt", driver: "codex", providerSessionId: "session", cloudTask: undefined },
      ],
      runs: [
        {
          id: RunId.make("run"),
          status: "running",
          providerThreadId: "pt",
          providerInstanceId: ProviderInstanceId.make("codex"),
          activeAttemptId: RunAttemptId.make("attempt"),
        },
      ],
    };
    const layer = Recovery.layer.pipe(
      Layer.provideMerge(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([threadId]),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection as never),
          getThreadRecords: () =>
            Effect.succeed({
              providerTurns: [
                {
                  id: ProviderTurnId.make("turn"),
                  runAttemptId: RunAttemptId.make("attempt"),
                  status: "running",
                  ordinal: 1,
                },
              ],
            } as never),
        }),
      ),
      Layer.provideMerge(detached),
      Layer.provideMerge(layerTest),
      Layer.provideMerge(
        ServerSettings.layerTest({
          codexTurnsSurviveServerStop: setting,
          continueThreadsAfterServerUpdate: false,
        }),
      ),
    );
    const stopIntent =
      intent === "reader-timeout"
        ? yield* Effect.gen(function* () {
            const started = yield* Deferred.make<void>();
            const fs = FileSystem.layerNoop({
              stream: () =>
                Stream.fromEffect(
                  Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
                ),
            });
            return yield* Effect.gen(function* () {
              const reader = yield* DesktopStopIntent.DesktopStopIntentReader;
              const fiber = yield* reader.atShutdown.pipe(
                Effect.forkChild({ startImmediately: true }),
              );
              yield* Deferred.await(started);
              yield* TestClock.adjust("1 second");
              return yield* Fiber.join(fiber);
            }).pipe(
              Effect.provide(DesktopStopIntent.layer("/intent", 123).pipe(Layer.provide(fs))),
            );
          })
        : intent === "none" || intent === "drain-mark"
          ? Option.none()
          : Option.some({ reason: intent, requestedAt: "2026-01-01T00:00:00Z" } as never);
    const kind = RuntimeDrain.stopKind(intent === "drain-mark", stopIntent);
    yield* Effect.gen(function* () {
      yield* (yield* Recovery.ProviderRuntimeRecoveryService).prepareForShutdownWithStopKind(kind);
      assert.deepEqual(
        retained,
        setting === "always" || (setting === "restart" && kind === "restart") ? ["record"] : [],
      );
      const prepared = yield* (yield* EffectOutbox.EffectOutboxV2).get(
        "effect:restart-continuation:run",
      );
      assert.equal(Option.isSome(prepared), retained.length > 0);
    }).pipe(Effect.provide(layer));
  }),
);

const twoRecordShutdown = (
  retainOnClose: (name: string) => Effect.Effect<boolean, CodexDetachedAppServerError>,
) => {
  const threads = { kept: ThreadId.make("kept-thread"), other: ThreadId.make("other-thread") };
  const detached = Layer.mock(Detached.CodexDetachedAppServers)({
    socketTransportEnabled: true,
    loadRecords: Effect.succeed(
      (["kept", "other"] as const).map((name) => ({
        name,
        instanceId: `codex-${name}`,
        providerSessionId: `session-${name}`,
        state: "running",
        stderrMode: "discard",
      })) as never,
    ),
    retainOnClose,
  });
  const projection = (name: keyof typeof threads) => ({
    thread: { id: threads[name], projectId: "project" },
    providerThreads: [
      {
        id: `pt-${name}`,
        driver: "codex",
        providerSessionId: `session-${name}`,
        cloudTask: undefined,
      },
    ],
    providerSessions: [],
    runs: [
      {
        id: RunId.make(`run-${name}`),
        status: "running",
        providerThreadId: `pt-${name}`,
        providerInstanceId: ProviderInstanceId.make(`codex-${name}`),
        activeAttemptId: RunAttemptId.make("attempt"),
      },
    ],
  });
  return Recovery.layer.pipe(
    Layer.provideMerge(
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getRecoveryThreadIds: () => Effect.succeed([threads.kept, threads.other]),
        getRuntimeRecoveryProjection: (threadId) =>
          Effect.succeed(projection(threadId === threads.kept ? "kept" : "other") as never),
        getThreadRecords: () =>
          Effect.succeed({
            providerTurns: [
              {
                id: ProviderTurnId.make("turn"),
                runAttemptId: RunAttemptId.make("attempt"),
                status: "running",
                ordinal: 1,
              },
            ],
          } as never),
      }),
    ),
    Layer.provideMerge(detached),
    Layer.provideMerge(layerTest),
    Layer.provideMerge(
      ServerSettings.layerTest({
        codexTurnsSurviveServerStop: "always",
        continueThreadsAfterServerUpdate: false,
      }),
    ),
  );
};

const prepareQuit = Effect.gen(function* () {
  return yield* (yield* Recovery.ProviderRuntimeRecoveryService).prepareForShutdownWithStopKind(
    "quit",
  );
});

// The unprotected thread falls to the ordinary shutdown path, which counts it as a candidate.
it.effect.each(["failure", "defect"] as const)(
  "an app-server whose retention fails (%s) closes with its session; the retained one stays protected",
  (outcome) =>
    Effect.gen(function* () {
      const retained: string[] = [];
      const summary = yield* prepareQuit.pipe(
        Effect.provide(
          twoRecordShutdown((name) =>
            name === "kept"
              ? Effect.sync(() => {
                  retained.push(name);
                  return true;
                })
              : outcome === "failure"
                ? Effect.fail(new CodexDetachedAppServerError({ detail: "not verified" }))
                : Effect.die("classification crashed"),
          ),
        ),
      );
      assert.deepEqual(retained, ["kept"]);
      assert.deepEqual(summary, { candidates: 2, continued: 1 });
    }),
);

it.effect("survivor preparation that overruns its budget keeps what it already retained", () =>
  Effect.gen(function* () {
    const verifying = yield* Deferred.make<void>();
    const preparing = yield* prepareQuit.pipe(
      Effect.provide(
        twoRecordShutdown((name) =>
          name === "kept"
            ? Effect.succeed(true)
            : Deferred.succeed(verifying, undefined).pipe(Effect.andThen(Effect.never)),
        ),
      ),
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Deferred.await(verifying);
    yield* TestClock.adjust("2 seconds");
    assert.deepEqual(yield* Fiber.join(preparing), { candidates: 2, continued: 1 });
  }),
);
