import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import type {
  DesktopBackendStartConfig,
  DesktopBackendSnapshot,
} from "../backend/DesktopBackendManager.ts";
import * as DesktopBackendActivity from "./DesktopBackendActivity.ts";

function instance(id = "primary", wsl = false) {
  let snapshot: DesktopBackendSnapshot = {
    desiredRunning: true,
    ready: true,
    activePid: Option.some(42),
    restartAttempt: 0,
    restartScheduled: false,
  };
  let config = {
    httpBaseUrl: new URL("http://192.168.1.9:4444/path"),
    executablePath: wsl ? "wsl.exe" : "node",
    ...(wsl ? { runningDistro: "Ubuntu" } : {}),
  } as DesktopBackendStartConfig;
  const backend: DesktopBackendPool.DesktopBackendInstance = {
    id: DesktopBackendPool.BackendInstanceId(id),
    label: Effect.succeed(id),
    start: Effect.void,
    stop: () => Effect.void,
    snapshot: Effect.sync(() => snapshot),
    currentConfig: Effect.sync(() => Option.some(config)),
    waitForReady: () => Effect.succeed(true),
  };
  return {
    backend,
    changePid: () => {
      snapshot = { ...snapshot, activePid: Option.some(43) };
    },
    changeConfig: () => {
      config = { ...config };
    },
    stop: () => {
      snapshot = { ...snapshot, desiredRunning: false, ready: false, activePid: Option.none() };
    },
  };
}

function activityLayer(
  instances: readonly DesktopBackendPool.DesktopBackendInstance[],
  response: Effect.Effect<Response> = Effect.sync(() =>
    Response.json({ activity: "idle", pid: 42, serverVersion: "1.2.3" }),
  ),
  urls: string[] = [],
) {
  return DesktopBackendActivity.layer.pipe(
    Layer.provide(
      Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
        list: Effect.sync(() => [...instances]),
        primary: Effect.succeed(instances[0]!),
        get: (id) =>
          Effect.sync(() => Option.fromNullishOr(instances.find((instance) => instance.id === id))),
        register: () => Effect.die("unexpected register"),
        unregister: () => Effect.die("unexpected unregister"),
      }),
    ),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          urls.push(request.url);
          return response.pipe(Effect.map((value) => HttpClientResponse.fromWeb(request, value)));
        }),
      ),
    ),
  );
}

describe("DesktopBackendActivity", () => {
  it.effect("uses each configured URL with loopback host and validates the stop set", () => {
    const a = instance();
    const b = instance("secondary");
    const urls: string[] = [];
    return Effect.gen(function* () {
      const activity = yield* DesktopBackendActivity.DesktopBackendActivity;
      const probe = yield* activity.probe;
      assert.equal(probe.activity, "idle");
      assert.deepEqual(urls, [
        "http://127.0.0.1:4444/.well-known/t3/activity",
        "http://127.0.0.1:4444/.well-known/t3/activity",
      ]);
      assert.isTrue(yield* probe.unchanged);
      a.changePid();
      assert.isFalse(yield* probe.unchanged);
    }).pipe(Effect.provide(activityLayer([a.backend, b.backend], undefined, urls)));
  });

  it.effect.each([
    { activity: "busy", pid: 42, serverVersion: "1.2.3" },
    { activity: "idle", pid: 99, serverVersion: "1.2.3" },
    { activity: "idle" },
  ])("classifies busy, wrong PID and malformed activity %j", (payload) => {
    const backend = instance();
    return Effect.gen(function* () {
      const result = yield* (yield* DesktopBackendActivity.DesktopBackendActivity).probe;
      assert.equal(result.activity, payload.activity === "busy" ? "busy" : "unknown");
    }).pipe(
      Effect.provide(activityLayer([backend.backend], Effect.succeed(Response.json(payload)))),
    );
  });

  it.effect("treats forbidden activity as unknown", () =>
    Effect.gen(function* () {
      assert.equal(
        (yield* (yield* DesktopBackendActivity.DesktopBackendActivity).probe).activity,
        "unknown",
      );
    }).pipe(
      Effect.provide(
        activityLayer([instance().backend], Effect.succeed(new Response(null, { status: 403 }))),
      ),
    ),
  );

  it.effect.each(["primary", "wsl:Ubuntu"])(
    "running WSL %s is unknown; stopped WSL is idle",
    (id) => {
      const wsl = instance(id, true);
      const native = instance("native");
      const urls: string[] = [];
      return Effect.gen(function* () {
        const activity = yield* DesktopBackendActivity.DesktopBackendActivity;
        assert.equal(
          (yield* activity.probe).reason,
          "Automatic restart postponed: WSL activity cannot be verified.",
        );
        assert.equal(urls.length, 1);
        wsl.stop();
        assert.equal((yield* activity.probe).activity, "idle");
      }).pipe(Effect.provide(activityLayer([native.backend, wsl.backend], undefined, urls)));
    },
  );

  it.effect("WSL-only primary is unknown without querying its distro address", () => {
    const urls: string[] = [];
    const primary = instance("primary", true);
    return Effect.gen(function* () {
      const probe = yield* (yield* DesktopBackendActivity.DesktopBackendActivity).probe;
      assert.equal(probe.activity, "unknown");
      assert.include(probe.reason ?? "", "WSL");
      assert.deepEqual(urls, []);
    }).pipe(Effect.provide(activityLayer([primary.backend], undefined, urls)));
  });

  it.effect("losing readiness during a request makes the result unknown", () => {
    const backend = instance();
    return Effect.gen(function* () {
      assert.equal(
        (yield* (yield* DesktopBackendActivity.DesktopBackendActivity).probe).activity,
        "unknown",
      );
    }).pipe(
      Effect.provide(
        activityLayer(
          [backend.backend],
          Effect.sync(() => {
            backend.stop();
            return Response.json({ activity: "idle", pid: 42, serverVersion: "1.2.3" });
          }),
        ),
      ),
    );
  });

  it.effect("stopped instances do not probe; starting instances remain unknown", () => {
    const backend = instance();
    backend.stop();
    const urls: string[] = [];
    return Effect.gen(function* () {
      assert.equal(
        (yield* (yield* DesktopBackendActivity.DesktopBackendActivity).probe).activity,
        "idle",
      );
      assert.deepEqual(urls, []);
    }).pipe(Effect.provide(activityLayer([backend.backend], undefined, urls)));
  });

  it.effect("a changed config during the request postpones installation", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const complete = yield* Deferred.make<Response>();
      const backend = instance();
      yield* Effect.gen(function* () {
        const probe = yield* (yield* DesktopBackendActivity.DesktopBackendActivity).probe.pipe(
          Effect.forkChild,
        );
        yield* Deferred.await(started);
        backend.changeConfig();
        yield* Deferred.succeed(
          complete,
          Response.json({ activity: "idle", pid: 42, serverVersion: "1.2.3" }),
        );
        assert.equal((yield* Fiber.join(probe)).activity, "unknown");
      }).pipe(
        Effect.provide(
          activityLayer(
            [backend.backend],
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(complete))),
          ),
        ),
      );
    }),
  );

  it.effect("a changed pool membership invalidates an idle admission", () => {
    const instances = [instance().backend];
    return Effect.gen(function* () {
      const probe = yield* (yield* DesktopBackendActivity.DesktopBackendActivity).probe;
      assert.equal(probe.activity, "idle");
      instances.push(instance("secondary").backend);
      assert.isFalse(yield* probe.unchanged);
    }).pipe(Effect.provide(activityLayer(instances)));
  });

  it.effect("bounds unanswered probes to two seconds", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const probe = yield* (yield* DesktopBackendActivity.DesktopBackendActivity).probe.pipe(
          Effect.forkChild,
        );
        yield* Deferred.await(started);
        yield* TestClock.adjust("2 seconds");
        assert.equal((yield* Fiber.join(probe)).activity, "unknown");
      }).pipe(
        Effect.provide(
          activityLayer(
            [instance().backend],
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        ),
      );
    }),
  );
});
