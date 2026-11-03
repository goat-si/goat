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
        { name: "record", instanceId: "codex", state: "running", stderrMode: "discard" },
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
      providerThreads: [{ id: "pt", driver: "codex", cloudTask: undefined }],
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
