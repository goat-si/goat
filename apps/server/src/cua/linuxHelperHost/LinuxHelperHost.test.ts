import { assert, describe, it } from "@effect/vitest";
import type { DesktopCuaReadinessReport, DesktopCuaSafetyReport } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { type DriverSession, makeLinuxHelperHost, TICK_MS } from "./LinuxHelperHost.ts";
import { CAPABILITIES, type FakeRequest, fakeHelper, READY } from "./LinuxHelperHost.testkit.ts";

const SESSION: DriverSession = {
  command: "/opt/goat/cua-driver",
  display: { DISPLAY: ":7", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus" },
};

/** A host over a scripted helper whose driver session a test turns on and off. */
const hostWith = (windows: ReadonlyArray<{ pid: number; windowId: number; onScreen?: boolean }>) =>
  Effect.gen(function* () {
    const session = yield* Ref.make(Option.none<DriverSession>());
    const report = yield* Ref.make(Option.none<DesktopCuaReadinessReport>());
    const requests = yield* Queue.unbounded<FakeRequest>();
    const spawned: Array<{
      readonly env: Readonly<Record<string, string>>;
      readonly helper: ReturnType<typeof fakeHelper>;
    }> = [];
    let next = 0;
    const host = yield* makeLinuxHelperHost({
      session: Ref.get(session),
      spawn: (env) => {
        const helper = fakeHelper({
          generation: "gen-" + (spawned.length + 1),
          windows: () => windows,
          onRequest: (request) => void Queue.offerUnsafe(requests, request),
        });
        spawned.push({ env, helper });
        return helper.process;
      },
      environment: { PATH: "/usr/bin", HOME: "/home/person", GOAT_AUTH_TOKEN: "secret" },
      report,
      newId: () => "id-" + ++next,
      after: () => () => undefined,
    });
    const safety = yield* Queue.unbounded<DesktopCuaSafetyReport>();
    yield* host.safety.pipe(
      Stream.runForEach((value) => Queue.offer(safety, value)),
      // Subscribed before the helper can report anything.
      Effect.forkScoped({ startImmediately: true }),
    );
    /** The next request the helper got for this method. */
    const nextRequest = (method: string): Effect.Effect<FakeRequest> =>
      Queue.take(requests).pipe(
        Effect.flatMap((request) =>
          request.method === method ? Effect.succeed(request) : nextRequest(method),
        ),
      );
    return { host, session, report, spawned, safety, nextRequest };
  });

describe("LinuxHelperHost (#1223)", () => {
  it.effect(
    "runs the helper only while the driver runs, with the session's variables, and reports its readiness",
    () =>
      Effect.gen(function* () {
        const t = yield* hostWith([]);
        yield* TestClock.adjust(TICK_MS);
        assert.lengthOf(t.spawned, 0);
        yield* Ref.set(t.session, Option.some(SESSION));
        yield* TestClock.adjust(TICK_MS);
        const readiness = yield* Queue.take(t.safety);
        assert.deepEqual(readiness, {
          version: 1,
          type: "cuaReadiness",
          generation: 1,
          readiness: READY,
          signals: CAPABILITIES.signals,
        });
        assert.deepEqual(yield* t.host.readiness, Option.some(readiness));
        // The display it was started on and the driver it runs, never the server's credentials.
        const env = t.spawned[0]?.env ?? {};
        assert.include(env, {
          DISPLAY: ":7",
          PATH: "/usr/bin",
          GOAT_COMPUTER_USE_DRIVER: SESSION.command,
        });
        assert.notProperty(env, "GOAT_AUTH_TOKEN");
        // The driver stopping stops the helper, and its readiness is no longer reported.
        yield* Ref.set(t.session, Option.none());
        yield* TestClock.adjust(TICK_MS);
        assert.isTrue(t.spawned[0]?.helper.stopped());
        assert.deepEqual(yield* t.host.readiness, Option.none());
      }).pipe(Effect.scoped),
  );

  it.effect("watches every window on screen while agents control the host, and nothing after", () =>
    Effect.gen(function* () {
      const t = yield* hostWith([
        { pid: 7, windowId: 70 },
        { pid: 8, windowId: 80 },
        { pid: 9, windowId: 90, onScreen: false },
      ]);
      yield* Ref.set(t.session, Option.some(SESSION));
      yield* TestClock.adjust(TICK_MS);
      yield* t.host.setWatch(true);
      const watch = yield* t.nextRequest("watch");
      assert.deepEqual((watch.params as { targets: unknown }).targets, [
        { pid: 7, windowId: 70 },
        { pid: 8, windowId: 80 },
      ]);
      yield* t.host.setWatch(false);
      yield* t.nextRequest("unwatch");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "pauses for a secret field in any watched window until the last clears; a helper that exits clears it and is started again",
    () =>
      Effect.gen(function* () {
        const t = yield* hostWith([
          { pid: 7, windowId: 70 },
          { pid: 8, windowId: 80 },
        ]);
        yield* Ref.set(t.session, Option.some(SESSION));
        yield* TestClock.adjust(TICK_MS);
        assert.strictEqual((yield* Queue.take(t.safety)).type, "cuaReadiness");
        yield* t.host.setWatch(true);
        const watchId = ((yield* t.nextRequest("watch")).params as { watchId: string }).watchId;
        // The next tick's window read comes after the watch's answer took effect.
        yield* TestClock.adjust(TICK_MS);
        yield* t.nextRequest("listWindows");
        const helper = t.spawned[0]?.helper;
        const secret = (pid: number, active: boolean) =>
          helper?.event(watchId, {
            type: "privateMode",
            active,
            target: { pid, windowId: pid * 10 },
          });
        secret(7, true);
        secret(8, true);
        secret(7, false);
        secret(8, false);
        helper?.event(watchId, { type: "humanInput", source: "pointer" });
        secret(7, true);
        helper?.exit();
        yield* TestClock.adjust(TICK_MS);
        const reports: Array<DesktopCuaSafetyReport> = [];
        for (let index = 0; index < 5; index++) reports.push(yield* Queue.take(t.safety));
        assert.deepEqual(
          reports.map((report) =>
            report.type === "cuaPrivateMode"
              ? [report.type, report.active, report.target.pid]
              : [report.type],
          ),
          [
            ["cuaPrivateMode", true, 7],
            ["cuaPrivateMode", false, 8],
            ["cuaHumanInput"],
            ["cuaPrivateMode", true, 7],
            ["cuaPrivateMode", false, 7],
          ],
        );
        // The next tick starts a new helper, whose readiness is the one reported now.
        assert.include(yield* Queue.take(t.safety), { type: "cuaReadiness", generation: 2 });
        assert.lengthOf(t.spawned, 2);
      }).pipe(Effect.scoped),
  );
});
