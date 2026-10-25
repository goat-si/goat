import { assert, describe, it } from "@effect/vitest";
import type { DesktopCuaReadinessReport, DesktopCuaSafetyReport } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { type DriverSession, makeLinuxHelperHost, TICK_MS } from "./LinuxHelperHost.ts";
import {
  CAPABILITIES,
  type FakeHelperOptions,
  type FakeRequest,
  fakeHelper,
  READY,
} from "./LinuxHelperHost.testkit.ts";

const SESSION: DriverSession = {
  command: "/opt/goat/cua-driver",
  display: { DISPLAY: ":7", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus" },
};

/** A host over a scripted helper whose driver session a test turns on and off. */
const hostWith = (
  windows: ReadonlyArray<{ pid: number; windowId: number; onScreen?: boolean }>,
  options: FakeHelperOptions = {},
) =>
  Effect.gen(function* () {
    const session = yield* Ref.make(Option.none<DriverSession>());
    const check = yield* Ref.make(Option.none<DriverSession>());
    const report = yield* Ref.make(Option.none<DesktopCuaReadinessReport>());
    const requests = yield* Queue.unbounded<FakeRequest>();
    const spawned: Array<{
      readonly env: Readonly<Record<string, string>>;
      readonly helper: ReturnType<typeof fakeHelper>;
    }> = [];
    let next = 0;
    /** Request deadlines; a test fires them to stand for a helper that did not answer in time. */
    const deadlines: Array<() => void> = [];
    const host = yield* makeLinuxHelperHost({
      session: Ref.get(session),
      check: { wanted: Ref.get(check).pipe(Effect.map(Option.isSome)), session: Ref.get(check) },
      spawn: (env) => {
        const helper = fakeHelper({
          ...options,
          generation: "gen-" + (spawned.length + 1),
          windows: options.windows ?? (() => windows),
          onRequest: (request) => {
            options.onRequest?.(request);
            Queue.offerUnsafe(requests, request);
          },
        });
        spawned.push({ env, helper });
        return helper.process;
      },
      environment: {
        PATH: "/usr/bin",
        HOME: "/home/person",
        GOAT_AUTH_TOKEN: "secret",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/ambient-bus",
      },
      report,
      newId: () => "id-" + ++next,
      after: (_ms, task) => {
        deadlines.push(task);
        return () => undefined;
      },
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
    const expire = () => {
      for (const task of deadlines.splice(0)) task();
    };
    return { host, session, check, report, spawned, safety, nextRequest, expire };
  });

/** The helper's initial state for each window of a watch it took: none of them secret. */
const initialStates = (request: FakeRequest, send: (frame: unknown) => void) => {
  if (request.method !== "watch") return;
  const params = request.params as {
    watchId: string;
    targets: ReadonlyArray<{ pid: number; windowId: number }>;
  };
  const generation = (request as { generation: string }).generation;
  for (const target of params.targets)
    send({
      generation,
      watchId: params.watchId,
      event: { type: "privateMode", active: false, target },
    });
};

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
    "pauses for a secret field in any watched window until the last clears; after a crash it holds until a new helper sees the field without a secret (#1494 merge review P1)",
    () =>
      Effect.gen(function* () {
        const t = yield* hostWith(
          [
            { pid: 7, windowId: 70 },
            { pid: 8, windowId: 80 },
          ],
          { afterAnswer: initialStates },
        );
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
        // A crash proves nothing about the field: the pause holds through it.
        helper?.exit();
        // The next tick starts a new helper; its watch's initial states show the field clear.
        yield* TestClock.adjust(TICK_MS);
        const reports: Array<DesktopCuaSafetyReport> = [];
        for (let index = 0; index < 6; index++) reports.push(yield* Queue.take(t.safety));
        assert.deepEqual(
          reports.map((report) =>
            report.type === "cuaPrivateMode"
              ? [report.type, report.active, report.target.pid]
              : report.type === "cuaReadiness"
                ? [report.type, report.generation]
                : [report.type],
          ),
          [
            ["cuaPrivateMode", true, 7],
            ["cuaPrivateMode", false, 8],
            ["cuaHumanInput"],
            ["cuaPrivateMode", true, 7],
            ["cuaReadiness", 2],
            ["cuaPrivateMode", false, 7],
          ],
        );
        assert.lengthOf(t.spawned, 2);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a failed window listing keeps the watch, so a secret field stays private (#1494 r1)",
    () =>
      Effect.gen(function* () {
        let listingFails = false;
        const t = yield* hostWith([{ pid: 7, windowId: 70 }], {
          listing: () =>
            listingFails ? { outcome: "refused", reason: "busy", message: "busy" } : undefined,
        });
        yield* Ref.set(t.session, Option.some(SESSION));
        yield* TestClock.adjust(TICK_MS);
        assert.strictEqual((yield* Queue.take(t.safety)).type, "cuaReadiness");
        yield* t.host.setWatch(true);
        const watchId = ((yield* t.nextRequest("watch")).params as { watchId: string }).watchId;
        const helper = t.spawned[0]?.helper;
        helper?.event(watchId, {
          type: "privateMode",
          active: true,
          target: { pid: 7, windowId: 70 },
        });
        assert.include(yield* Queue.take(t.safety), { type: "cuaPrivateMode", active: true });
        listingFails = true;
        yield* TestClock.adjust(TICK_MS);
        yield* t.nextRequest("listWindows");
        // The watch still delivers, and private mode was not cleared in between.
        helper?.event(watchId, { type: "humanInput", source: "keyboard" });
        assert.include(yield* Queue.take(t.safety), { type: "cuaHumanInput" });
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a daemon replaced by another (another display) gets a helper of its own (#1494 r1)",
    () =>
      Effect.gen(function* () {
        const t = yield* hostWith([]);
        yield* Ref.set(t.session, Option.some(SESSION));
        yield* TestClock.adjust(TICK_MS);
        assert.lengthOf(t.spawned, 1);
        yield* Ref.set(
          t.session,
          Option.some({ command: "/opt/goat/cua-driver-2", display: { DISPLAY: ":8" } }),
        );
        yield* TestClock.adjust(TICK_MS);
        assert.isTrue(t.spawned[0]?.helper.stopped());
        assert.lengthOf(t.spawned, 2);
        assert.include(t.spawned[1]?.env ?? {}, {
          DISPLAY: ":8",
          GOAT_COMPUTER_USE_DRIVER: "/opt/goat/cua-driver-2",
        });
        // The probe found no usable bus for this daemon; the helper does not dial the ambient one.
        assert.notProperty(t.spawned[1]?.env ?? {}, "DBUS_SESSION_BUS_ADDRESS");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a stopped or exited helper's hold stands until a later helper no longer sees that window (#1494 merge review P1)",
    () =>
      Effect.gen(function* () {
        let windows = [
          { pid: 7, windowId: 70 },
          { pid: 8, windowId: 80 },
        ];
        const t = yield* hostWith([], { windows: () => windows, afterAnswer: initialStates });
        yield* Ref.set(t.session, Option.some(SESSION));
        yield* TestClock.adjust(TICK_MS);
        assert.strictEqual((yield* Queue.take(t.safety)).type, "cuaReadiness");
        yield* t.host.setWatch(true);
        const watchId = ((yield* t.nextRequest("watch")).params as { watchId: string }).watchId;
        const helper = t.spawned[0]?.helper;
        helper?.event(watchId, {
          type: "privateMode",
          active: true,
          target: { pid: 7, windowId: 70 },
        });
        assert.include(yield* Queue.take(t.safety), { type: "cuaPrivateMode", active: true });
        yield* Ref.set(t.session, Option.none());
        yield* TestClock.adjust(TICK_MS);
        // Asked to stop, then gone: readiness is withdrawn, private mode still holds.
        assert.isTrue(helper?.stopped());
        helper?.exit();
        assert.deepEqual(yield* t.host.readiness, Option.none());
        assert.strictEqual(yield* Queue.size(t.safety), 0);
        // A later helper's screen no longer has that window, so nothing secret can be focused in it.
        windows = [{ pid: 8, windowId: 80 }];
        yield* Ref.set(t.session, Option.some(SESSION));
        yield* TestClock.adjust(TICK_MS);
        assert.strictEqual((yield* Queue.take(t.safety)).type, "cuaReadiness");
        assert.include(yield* Queue.take(t.safety), {
          type: "cuaPrivateMode",
          active: false,
        });
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a readiness check the helper does not answer withdraws the signals and says why (#1494 merge review P2)",
    () =>
      Effect.gen(function* () {
        let checks = 0;
        const t = yield* hostWith([], {
          override: (request) =>
            request.method === "permissions" && ++checks > 1
              ? { outcome: "refused", reason: "busy", message: "busy" }
              : undefined,
        });
        yield* Ref.set(t.session, Option.some(SESSION));
        yield* TestClock.adjust(TICK_MS);
        assert.include(yield* Queue.take(t.safety), { type: "cuaReadiness" });
        yield* TestClock.adjust(30_000);
        const downgraded = yield* Queue.take(t.safety);
        assert.deepInclude(downgraded, {
          type: "cuaReadiness",
          signals: { privateMode: "unsupported", humanInput: "unsupported" },
        });
        assert.deepEqual(yield* t.host.readiness, Option.some(downgraded));
        assert.include(downgraded.type === "cuaReadiness" ? downgraded.readiness : {}, {
          capture: "unavailable",
          tree: "unavailable",
        });
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a helper that stops answering is no longer reported authenticated, nor its grants proven (#1514)",
    () =>
      Effect.gen(function* () {
        let checks = 0;
        const t = yield* hostWith([], {
          override: (request) =>
            request.method !== "permissions"
              ? undefined
              : ++checks > 1
                ? { outcome: "refused", reason: "busy", message: "busy" }
                : { ...READY, platform: { linux: { displayServer: "x11" } } },
        });
        yield* Ref.set(t.session, Option.some(SESSION));
        yield* TestClock.adjust(TICK_MS);
        const first = yield* Queue.take(t.safety);
        yield* TestClock.adjust(30_000);
        const downgraded = yield* Queue.take(t.safety);
        const before = first.type === "cuaReadiness" ? first.readiness : undefined;
        const after = downgraded.type === "cuaReadiness" ? downgraded.readiness : undefined;
        assert.strictEqual(before?.helper, "authenticated");
        assert.strictEqual(after?.helper, "unauthenticated");
        assert.deepEqual(after?.grants, { accessibility: "unknown", screenCapture: "unknown" });
        // What the helper last said about the session stays, so the guide can still name it.
        assert.deepEqual(after?.platform, before?.platform);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a stopped daemon stops its helper within a check, even with a request waiting (#1494 r1)",
    () =>
      Effect.gen(function* () {
        // The helper never answers permissions, so the host's tick waits on it.
        const t = yield* hostWith([], { answers: (request) => request.method !== "permissions" });
        yield* Ref.set(t.session, Option.some(SESSION));
        yield* TestClock.adjust(TICK_MS);
        yield* t.nextRequest("permissions");
        yield* Ref.set(t.session, Option.none());
        yield* TestClock.adjust(TICK_MS);
        assert.isTrue(t.spawned[0]?.helper.stopped());
        assert.deepEqual(yield* t.host.readiness, Option.none());
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a watch not answered in time is asked again, even for the same windows (#1494 r3)",
    () =>
      Effect.gen(function* () {
        let windows = [{ pid: 7, windowId: 70 }];
        let watches = 0;
        const t = yield* hostWith([], {
          windows: () => windows,
          // The second watch goes unanswered.
          answers: (request) => request.method !== "watch" || ++watches !== 2,
        });
        yield* Ref.set(t.session, Option.some(SESSION));
        yield* TestClock.adjust(TICK_MS);
        yield* t.host.setWatch(true);
        yield* t.nextRequest("watch");
        windows = [
          { pid: 7, windowId: 70 },
          { pid: 8, windowId: 80 },
        ];
        yield* TestClock.adjust(TICK_MS);
        yield* t.nextRequest("watch");
        t.expire();
        windows = [{ pid: 7, windowId: 70 }];
        yield* TestClock.adjust(TICK_MS);
        // The windows match the first watch, but whether the helper took the second is unknown.
        yield* t.nextRequest("watch");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "the clearing a helper sends as a watch ends is no proof: private mode holds until the next watch sees the field (#1494 r5)",
    () =>
      Effect.gen(function* () {
        let watchId = "";
        let send: ((frame: unknown) => void) | undefined;
        const target = { pid: 7, windowId: 70 };
        const t = yield* hostWith([target], {
          onRequest: (request) => {
            if (request.method === "watch")
              watchId = (request.params as { watchId: string }).watchId;
            // As the helper does, an active target leaving the watch is cleared before the answer.
            if (request.method === "unwatch")
              send?.({
                generation: "gen-1",
                watchId,
                event: { type: "privateMode", active: false, target },
              });
          },
          afterAnswer: (request, reply) => {
            send = reply;
            initialStates(request, reply);
          },
        });
        yield* Ref.set(t.session, Option.some(SESSION));
        yield* TestClock.adjust(TICK_MS);
        assert.strictEqual((yield* Queue.take(t.safety)).type, "cuaReadiness");
        yield* t.host.setWatch(true);
        yield* t.nextRequest("watch");
        t.spawned[0]?.helper.event(watchId, { type: "privateMode", active: true, target });
        assert.include(yield* Queue.take(t.safety), { type: "cuaPrivateMode", active: true });
        yield* t.host.setWatch(false);
        yield* t.nextRequest("unwatch");
        assert.strictEqual(yield* Queue.size(t.safety), 0);
        // The next watch's initial state is a fresh look at the field: clear now.
        yield* t.host.setWatch(true);
        yield* t.nextRequest("watch");
        assert.include(yield* Queue.take(t.safety), { type: "cuaPrivateMode", active: false });
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a teardown clear that arrives after its request timed out is no proof, even once a new watch is asked for (#1494 r6)",
    () =>
      Effect.gen(function* () {
        let watchId = "";
        let watches = 0;
        const target = { pid: 7, windowId: 70 };
        const t = yield* hostWith([target], {
          onRequest: (request) => {
            if (request.method === "watch" && ++watches === 1)
              watchId = (request.params as { watchId: string }).watchId;
          },
          // The unwatch and the second watch go unanswered; the third is answered.
          answers: (request) =>
            request.method === "unwatch" ? false : request.method !== "watch" || watches !== 2,
          afterAnswer: initialStates,
        });
        yield* Ref.set(t.session, Option.some(SESSION));
        yield* TestClock.adjust(TICK_MS);
        assert.strictEqual((yield* Queue.take(t.safety)).type, "cuaReadiness");
        yield* t.host.setWatch(true);
        yield* t.nextRequest("watch");
        const helper = t.spawned[0]?.helper;
        helper?.event(watchId, { type: "privateMode", active: true, target });
        assert.include(yield* Queue.take(t.safety), { type: "cuaPrivateMode", active: true });
        yield* t.host.setWatch(false);
        yield* t.nextRequest("unwatch");
        t.expire();
        // The helper carries out the unwatch late: its clear under the first watch arrives.
        helper?.event(watchId, { type: "privateMode", active: false, target });
        assert.strictEqual(yield* Queue.size(t.safety), 0);
        yield* t.host.setWatch(true);
        yield* t.nextRequest("watch");
        t.expire();
        helper?.event(watchId, { type: "privateMode", active: false, target });
        assert.strictEqual(yield* Queue.size(t.safety), 0);
        // A watch that is answered looks at the field again: clear now.
        yield* TestClock.adjust(TICK_MS);
        yield* t.nextRequest("watch");
        assert.include(yield* Queue.take(t.safety), { type: "cuaPrivateMode", active: false });
      }).pipe(Effect.scoped),
  );

  it.effect(
    "an earlier watch's late acceptance does not lift the guard of a later unconfirmed unwatch (#1494 r7)",
    () =>
      Effect.gen(function* () {
        let windows = [{ pid: 7, windowId: 70 }];
        let watches = 0;
        const target = { pid: 7, windowId: 70 };
        const t = yield* hostWith([], {
          windows: () => windows,
          onRequest: (request) => {
            if (request.method === "watch") watches++;
          },
          // The replacement watch and the unwatch go unanswered for now.
          answers: (request) =>
            request.method === "unwatch" ? false : request.method !== "watch" || watches !== 2,
        });
        yield* Ref.set(t.session, Option.some(SESSION));
        yield* TestClock.adjust(TICK_MS);
        assert.strictEqual((yield* Queue.take(t.safety)).type, "cuaReadiness");
        yield* t.host.setWatch(true);
        const first = yield* t.nextRequest("watch");
        const helper = t.spawned[0]?.helper;
        helper?.event((first.params as { watchId: string }).watchId, {
          type: "privateMode",
          active: true,
          target,
        });
        assert.include(yield* Queue.take(t.safety), { type: "cuaPrivateMode", active: true });
        windows = [target, { pid: 8, windowId: 80 }];
        yield* TestClock.adjust(TICK_MS);
        const replacement = yield* t.nextRequest("watch");
        t.expire();
        yield* t.host.setWatch(false);
        yield* t.nextRequest("unwatch");
        // The helper now answers in order: the replacement watch late, then the unwatch's clear.
        const replaced = (replacement.params as { watchId: string }).watchId;
        helper?.send({
          id: replacement.id,
          generation: "gen-1",
          result: { watchId: replaced, watching: windows },
        });
        helper?.event(replaced, { type: "privateMode", active: false, target });
        assert.strictEqual(yield* Queue.size(t.safety), 0);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a view of the screen does not release a hold refreshed after it was taken (#1494 r8)",
    () =>
      Effect.gen(function* () {
        let windows = [{ pid: 7, windowId: 70 }];
        const target = { pid: 7, windowId: 70 };
        const t = yield* hostWith([], {
          windows: () => windows,
          // The unwatch is answered by hand, after the window has come back.
          answers: (request) => request.method !== "unwatch",
        });
        yield* Ref.set(t.session, Option.some(SESSION));
        yield* TestClock.adjust(TICK_MS);
        assert.strictEqual((yield* Queue.take(t.safety)).type, "cuaReadiness");
        yield* t.host.setWatch(true);
        const watchId = ((yield* t.nextRequest("watch")).params as { watchId: string }).watchId;
        const helper = t.spawned[0]?.helper;
        helper?.event(watchId, { type: "privateMode", active: true, target });
        assert.include(yield* Queue.take(t.safety), { type: "cuaPrivateMode", active: true });
        // The listing sees no windows, so the host unwatches.
        windows = [];
        yield* TestClock.adjust(TICK_MS);
        const unwatch = yield* t.nextRequest("unwatch");
        // Meanwhile the window is back and the watch still in force sees its secret again.
        windows = [target];
        helper?.event(watchId, { type: "privateMode", active: true, target });
        helper?.send({ id: unwatch.id, generation: "gen-1", result: { watching: [] } });
        yield* TestClock.adjust(TICK_MS);
        yield* t.nextRequest("listWindows");
        assert.strictEqual(yield* Queue.size(t.safety), 0);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a later listing with the same windows releases a hold on a window that left (#1494 r9)",
    () =>
      Effect.gen(function* () {
        const a = { pid: 7, windowId: 70 };
        const b = { pid: 8, windowId: 80 };
        let windows = [a];
        let watchId = "";
        let listWindows = 0;
        const t = yield* hostWith([], {
          windows: () => windows,
          onRequest: (request) => {
            if (request.method === "watch" && watchId === "")
              watchId = (request.params as { watchId: string }).watchId;
            // A reports its secret after this listing was asked for, so this listing cannot release it.
            if (request.method === "listWindows" && ++listWindows === 2)
              t2.helper()?.event(watchId, { type: "privateMode", active: true, target: a });
          },
        });
        const t2 = { helper: () => t.spawned[0]?.helper };
        yield* Ref.set(t.session, Option.some(SESSION));
        yield* TestClock.adjust(TICK_MS);
        assert.strictEqual((yield* Queue.take(t.safety)).type, "cuaReadiness");
        yield* t.host.setWatch(true);
        yield* t.nextRequest("watch");
        windows = [b];
        yield* TestClock.adjust(TICK_MS);
        yield* t.nextRequest("watch");
        assert.include(yield* Queue.take(t.safety), { type: "cuaPrivateMode", active: true });
        // The next listing still shows only B: A is gone, and its hold is older than this view.
        yield* TestClock.adjust(TICK_MS);
        yield* t.nextRequest("listWindows");
        assert.include(yield* Queue.take(t.safety), { type: "cuaPrivateMode", active: false });
      }).pipe(Effect.scoped),
  );
});

describe("LinuxHelperHost before the first turn (#1542)", () => {
  it.effect(
    "checks the session once with a helper of its own, stops it, and keeps what it proved",
    () =>
      Effect.gen(function* () {
        const t = yield* hostWith([]);
        yield* Ref.set(t.check, Option.some(SESSION));
        yield* TestClock.adjust(TICK_MS);
        assert.lengthOf(t.spawned, 1);
        const helper = t.spawned[0]?.helper;
        // Only readiness is asked: nothing is watched or listed without an agent.
        assert.deepEqual(
          helper?.requests.map((request) => request.method),
          ["permissions"],
        );
        assert.isTrue(helper?.stopped());
        assert.include(t.spawned[0]?.env ?? {}, {
          DISPLAY: ":7",
          GOAT_COMPUTER_USE_DRIVER: SESSION.command,
        });
        assert.notProperty(t.spawned[0]?.env ?? {}, "GOAT_AUTH_TOKEN");
        const report = yield* t.host.readiness;
        assert.deepInclude(Option.getOrUndefined(report), {
          type: "cuaReadiness",
          readiness: READY,
          signals: CAPABILITIES.signals,
        });
        // No helper watches until a driver starts one, so nothing vouches for detection yet.
        assert.deepEqual(yield* t.host.liveReadiness, Option.none());
        // The same session is not checked again right away.
        yield* TestClock.adjust(TICK_MS * 3);
        assert.lengthOf(t.spawned, 1);
        assert.deepEqual(yield* t.host.readiness, report);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a helper bound to another process proves nothing, and turning off clears a check",
    () =>
      Effect.gen(function* () {
        const other = yield* hostWith([], { bindingPid: 9999 });
        yield* Ref.set(other.check, Option.some(SESSION));
        yield* TestClock.adjust(TICK_MS);
        assert.lengthOf(other.spawned, 1);
        assert.isTrue(other.spawned[0]?.helper.stopped());
        assert.deepEqual(yield* other.host.readiness, Option.none());

        const t = yield* hostWith([]);
        yield* Ref.set(t.check, Option.some(SESSION));
        yield* TestClock.adjust(TICK_MS);
        assert.isTrue(Option.isSome(yield* t.host.readiness));
        yield* Ref.set(t.check, Option.none());
        yield* TestClock.adjust(TICK_MS);
        assert.deepEqual(yield* t.host.readiness, Option.none());
      }).pipe(Effect.scoped),
  );
});

describe("LinuxHelperHost before the first turn, round 1 (#1546)", () => {
  it.effect("a session that cannot be resolved is not probed again every tick", () =>
    Effect.gen(function* () {
      let probes = 0;
      const report = yield* Ref.make(Option.none<DesktopCuaReadinessReport>());
      yield* makeLinuxHelperHost({
        session: Effect.succeed(Option.none()),
        check: {
          wanted: Effect.succeed(true),
          session: Effect.sync(() => {
            probes++;
            return Option.none<DriverSession>();
          }),
        },
        spawn: () => fakeHelper().process,
        environment: {},
        report,
        newId: () => "id",
        after: () => () => undefined,
      });
      yield* TestClock.adjust(TICK_MS * 4);
      assert.strictEqual(probes, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("a check whose answer comes after computer use was turned off reports nothing", () =>
    Effect.gen(function* () {
      let wanted = true;
      const report = yield* Ref.make(Option.none<DesktopCuaReadinessReport>());
      yield* makeLinuxHelperHost({
        session: Effect.succeed(Option.none()),
        check: { wanted: Effect.sync(() => wanted), session: Effect.succeed(Option.some(SESSION)) },
        spawn: () =>
          fakeHelper({
            onRequest: (request) => {
              if (request.method === "permissions") wanted = false;
            },
          }).process,
        environment: {},
        report,
        newId: () => "id",
        after: () => () => undefined,
      });
      // Read right after the first check, before a later tick could clear it.
      yield* TestClock.adjust(1);
      assert.deepEqual(yield* Ref.get(report), Option.none());
    }).pipe(Effect.scoped),
  );
});
