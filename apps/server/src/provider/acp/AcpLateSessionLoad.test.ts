import { it } from "@effect/vitest";
import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";
import * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import type * as EffectAcpSchema from "effect-acp/compat";
import { mockRuntimeOptions } from "./AcpJsonRpcConnection.testkit.ts";

describe("late ACP session load", () => {
  // Live clock: the replay-idle gap must elapse in real time against the mock agent process.
  it.live("adopts config options from a session/load response that arrives after replay idle", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.make({
        ...mockRuntimeOptions,
        spawn: {
          ...mockRuntimeOptions.spawn,
          env: {
            GOAT_ACP_DELAY_LOAD_SESSION_AFTER_REPLAY: "1",
            GOAT_ACP_HOLD_LOAD_AFTER_REPLAY: "1",
          },
        },
        resumeSessionId: "mock-session-1",
        sessionLoadReplayIdleGap: "100 millis",
        sessionLoadReplayIdleReadiness: true,
      });
      const started = yield* runtime.start();
      expect(started.sessionSetupResult._meta).toMatchObject({
        goatSessionLoadReady: "replay_idle",
      });

      yield* runtime.request("_test/release-load", {});
      yield* runtime.getEvents().pipe(
        Stream.filter((event) => event._tag === "ConfigOptionsUpdated"),
        Stream.take(1),
        Stream.runDrain,
      );

      expect((yield* runtime.getConfigOptions).map((option) => option.id)).toEqual([
        "mode",
        "model",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("drops a late session/load response when a selection was sent before it", () =>
    Effect.gen(function* () {
      const lateLoadLogged = yield* Deferred.make<void>();
      const selectionStarted = yield* Deferred.make<void>();
      const runtime = yield* AcpSessionRuntime.make({
        ...mockRuntimeOptions,
        spawn: {
          ...mockRuntimeOptions.spawn,
          env: {
            GOAT_ACP_DELAY_LOAD_SESSION_AFTER_REPLAY: "1",
            GOAT_ACP_HOLD_LOAD_AFTER_REPLAY: "1",
            GOAT_ACP_HOLD_SET_CONFIG_OPTION_UNTIL_LOAD_REPLY: "1",
          },
        },
        resumeSessionId: "mock-session-1",
        sessionLoadReplayIdleGap: "100 millis",
        sessionLoadReplayIdleReadiness: true,
        requestLogger: (event) =>
          event.method === "session/set_config_option" && event.status === "started"
            ? Deferred.succeed(selectionStarted, undefined).pipe(Effect.asVoid)
            : event.method === "session/load" &&
                event.status === "succeeded" &&
                (event.result as { readonly configOptions?: unknown } | undefined)
                  ?.configOptions !== undefined
              ? Deferred.succeed(lateLoadLogged, undefined).pipe(Effect.asVoid)
              : Effect.void,
      });
      const started = yield* runtime.start();
      // The agent answers the load before this request, so no config change
      // is visible when the late response arrives.
      const selection = yield* runtime.setConfigOption("model", "gpt-5.4").pipe(Effect.forkChild);
      yield* Deferred.await(selectionStarted);
      yield* runtime.request("_test/release-load", {});
      yield* Deferred.await(lateLoadLogged);
      yield* runtime.request("_test/release-config", {});
      yield* Fiber.join(selection);

      expect((yield* runtime.start()).sessionSetupResult).toBe(started.sessionSetupResult);
      const model = (yield* runtime.getConfigOptions).find((option) => option.id === "model");
      expect(model?.currentValue).toBe("gpt-5.4");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("drops a late session/load response when the agent changed mode before it", () =>
    Effect.gen(function* () {
      const lateLoadLogged = yield* Deferred.make<void>();
      const runtime = yield* AcpSessionRuntime.make({
        ...mockRuntimeOptions,
        spawn: {
          ...mockRuntimeOptions.spawn,
          env: {
            GOAT_ACP_DELAY_LOAD_SESSION_AFTER_REPLAY: "1",
            GOAT_ACP_HOLD_LOAD_AFTER_REPLAY: "1",
            GOAT_ACP_NOTIFY_MODE_BEFORE_LOAD_REPLY: "code",
          },
        },
        resumeSessionId: "mock-session-1",
        sessionLoadReplayIdleGap: "100 millis",
        sessionLoadReplayIdleReadiness: true,
        // The mock speaks ACP v2, which has no current_mode_update; decode it as a v1 agent's.
        transformSessionUpdate: (notification) =>
          notification.update.sessionUpdate === "_t3_unknown" &&
          notification.update.originalSessionUpdate === "current_mode_update"
            ? {
                ...notification,
                update: notification.update.raw as EffectAcpSchema.SessionNotification["update"],
              }
            : notification,
        requestLogger: (event) =>
          event.method === "session/load" &&
          event.status === "succeeded" &&
          (event.result as { readonly configOptions?: unknown } | undefined)?.configOptions !==
            undefined
            ? Deferred.succeed(lateLoadLogged, undefined).pipe(Effect.asVoid)
            : Effect.void,
      });
      const started = yield* runtime.start();
      // No mode metadata yet, so the notification leaves the mode state as is.
      expect(yield* runtime.getModeState).toBeUndefined();
      yield* runtime.request("_test/release-load", {});
      yield* Deferred.await(lateLoadLogged);

      expect((yield* runtime.start()).sessionSetupResult).toBe(started.sessionSetupResult);
      expect(yield* runtime.getModeState).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("drops a late session/load response that startup metadata superseded", () =>
    Effect.gen(function* () {
      const provisionalLogged = yield* Deferred.make<void>();
      const allowStartup = yield* Deferred.make<void>();
      const lateLoadLogged = yield* Deferred.make<void>();
      const runtime = yield* AcpSessionRuntime.make({
        ...mockRuntimeOptions,
        spawn: {
          ...mockRuntimeOptions.spawn,
          env: {
            GOAT_ACP_DELAY_LOAD_SESSION_AFTER_REPLAY: "1",
            GOAT_ACP_HOLD_LOAD_AFTER_REPLAY: "1",
          },
        },
        resumeSessionId: "mock-session-1",
        sessionLoadReplayIdleGap: "100 millis",
        sessionLoadReplayIdleReadiness: true,
        requestLogger: (event) => {
          if (event.method !== "session/load" || event.status !== "succeeded") {
            return Effect.void;
          }
          return (event.result as { readonly configOptions?: unknown } | undefined)
            ?.configOptions === undefined
            ? Deferred.succeed(provisionalLogged, undefined).pipe(
                Effect.andThen(Deferred.await(allowStartup)),
              )
            : Deferred.succeed(lateLoadLogged, undefined).pipe(Effect.asVoid);
        },
      });
      const startup = yield* runtime.start().pipe(Effect.forkChild);
      yield* Deferred.await(provisionalLogged);
      yield* runtime.request("_test/startup-metadata", {});
      yield* Deferred.succeed(allowStartup, undefined);
      yield* Fiber.join(startup);
      yield* runtime.request("_test/release-load", {});
      yield* Deferred.await(lateLoadLogged);

      expect(yield* runtime.getModeState).toMatchObject({ currentModeId: "code" });
      expect(
        (yield* runtime.getConfigOptions).find((option) => option.category === "model"),
      ).toMatchObject({ currentValue: "gpt-5.4" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
