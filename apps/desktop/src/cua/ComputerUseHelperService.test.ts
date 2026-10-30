import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeHelperServiceManager } from "./ComputerUseHelperService.ts";

const HELPER =
  "/Applications/GOAT.app/Contents/Helpers/GOAT Computer Use.app/Contents/MacOS/GOAT Computer Use";
const UPDATED =
  "/Applications/GOAT 2.app/Contents/Helpers/GOAT Computer Use.app/Contents/MacOS/GOAT Computer Use";

/**
 * Helper services the manager opens: each launch gets the next pid and can be made to exit.
 * Launches from the gatedFrom-th on wait for the gate.
 */
function fakeServices(
  options: { readonly gate?: Promise<void>; readonly gatedFrom?: number } = {},
) {
  const launched: Array<{
    readonly executable: string;
    readonly pid: number;
    readonly closed: () => boolean;
    readonly exit: () => void;
  }> = [];
  const dead = new Set<number>();
  const opening = Promise.withResolvers<void>();
  // A launch finishes even when its claim was cancelled meanwhile, as a helper whose hello
  // crosses the stop does: the manager has to close it.
  const open = async (executable: string) => {
    opening.resolve();
    if (options.gate && launched.length >= (options.gatedFrom ?? 0)) await options.gate;
    const pid = 500 + launched.length;
    const ended = Promise.withResolvers<void>();
    let closed = false;
    launched.push({
      executable,
      pid,
      closed: () => closed,
      exit: () => {
        dead.add(pid);
        ended.resolve();
      },
    });
    return {
      pid,
      ended: ended.promise,
      close: async () => {
        closed = true;
        ended.resolve();
      },
    };
  };
  return {
    launched,
    dead,
    open,
    opening: opening.promise,
    alive: (pid: number) => !dead.has(pid),
  };
}

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("computer use helper service", () => {
  it.effect("starts one service for a channel however many sessions race to claim it", () =>
    Effect.gen(function* () {
      const gate = Promise.withResolvers<void>();
      const services = fakeServices({ gate: gate.promise });
      const manager = makeHelperServiceManager(services);
      const racing = Array.from({ length: 8 }, (_, index) =>
        manager.claim(HELPER, "thread-" + index),
      );
      yield* Effect.sync(() => gate.resolve());
      const claims = yield* Effect.promise(() => Promise.all(racing));
      assert.lengthOf(services.launched, 1);
      assert.deepEqual(new Set(claims.map((claim) => claim.service.pid)), new Set([500]));
      assert.equal(new Set(claims.map((claim) => claim.token)).size, 8);
    }),
  );

  it.effect("reuses the live service whose pid and executable match", () =>
    Effect.gen(function* () {
      const services = fakeServices();
      const manager = makeHelperServiceManager(services);
      const first = yield* Effect.promise(() => manager.claim(HELPER, "desktop"));
      const second = yield* Effect.promise(() => manager.claim(HELPER, "thread-a"));
      assert.lengthOf(services.launched, 1);
      assert.strictEqual(second.service, first.service);
      assert.equal(second.service.generation, first.service.generation);
    }),
  );

  it.effect("replaces only a service whose process is gone", () =>
    Effect.gen(function* () {
      const services = fakeServices();
      const manager = makeHelperServiceManager(services);
      const exited = yield* Effect.promise(() => manager.claim(HELPER, "desktop"));
      services.launched[0]?.exit();
      yield* Effect.promise(() => exited.service.session.ended);
      const afterExit = yield* Effect.promise(() => manager.claim(HELPER, "thread-a"));
      assert.equal(afterExit.service.pid, 501);
      assert.isAbove(afterExit.service.generation, exited.service.generation);
      // A pid that no longer answers is stale even before its exit is reported.
      services.dead.add(501);
      const afterStalePid = yield* Effect.promise(() => manager.claim(HELPER, "thread-b"));
      assert.equal(afterStalePid.service.pid, 502);
      const reused = yield* Effect.promise(() => manager.claim(HELPER, "thread-c"));
      assert.equal(reused.service.pid, 502);
      assert.lengthOf(services.launched, 3);
    }),
  );

  it.effect(
    "starts a new generation for another executable and lets the old one finish its sessions",
    () =>
      Effect.gen(function* () {
        const services = fakeServices();
        const manager = makeHelperServiceManager(services);
        const old = yield* Effect.promise(() => manager.claim(HELPER, "thread-a"));
        const updated = yield* Effect.promise(() => manager.claim(UPDATED, "thread-b"));
        assert.equal(updated.service.executable, UPDATED);
        assert.isAbove(updated.service.generation, old.service.generation);
        // The session still on the old service keeps it; nobody else is handed it again.
        assert.isFalse(services.launched[0]?.closed());
        const next = yield* Effect.promise(() => manager.claim(UPDATED, "thread-c"));
        assert.strictEqual(next.service, updated.service);
        yield* Effect.promise(() => old.release());
        assert.isTrue(services.launched[0]?.closed());
        assert.isFalse(services.launched[1]?.closed());
      }),
  );

  it.effect("names each session by its own token and ends only the session released", () =>
    Effect.gen(function* () {
      const services = fakeServices();
      const manager = makeHelperServiceManager(services);
      const a = yield* Effect.promise(() => manager.claim(HELPER, "thread-a"));
      const b = yield* Effect.promise(() => manager.claim(HELPER, "thread-b"));
      assert.strictEqual(manager.sessionFor(a.token), a);
      assert.strictEqual(manager.sessionFor(b.token), b);
      assert.isUndefined(manager.sessionFor("not-a-token"));
      yield* Effect.promise(() => a.release());
      // Releasing twice is releasing once.
      yield* Effect.promise(() => a.release());
      assert.isUndefined(manager.sessionFor(a.token));
      assert.strictEqual(manager.sessionFor(b.token), b);
      assert.isFalse(services.launched[0]?.closed());
      assert.isFalse(b.service.ended());
    }),
  );

  it.effect("stops the service with its last session, and the next claim starts a fresh one", () =>
    Effect.gen(function* () {
      const services = fakeServices();
      const manager = makeHelperServiceManager(services);
      const a = yield* Effect.promise(() => manager.claim(HELPER, "thread-a"));
      const b = yield* Effect.promise(() => manager.claim(HELPER, "thread-b"));
      yield* Effect.promise(() => Promise.all([a.release(), b.release()]));
      assert.isTrue(services.launched[0]?.closed());
      const fresh = yield* Effect.promise(() => manager.claim(HELPER, "thread-c"));
      assert.equal(fresh.service.pid, 501);
    }),
  );

  it.effect("keeps a service it is still starting when a release of the previous one lands", () =>
    Effect.gen(function* () {
      const gate = Promise.withResolvers<void>();
      const services = fakeServices({ gate: gate.promise, gatedFrom: 1 });
      const manager = makeHelperServiceManager(services);
      const a = yield* Effect.promise(() => manager.claim(HELPER, "thread-a"));
      services.launched[0]?.exit();
      const starting = manager.claim(HELPER, "thread-b");
      const released = a.release();
      yield* Effect.sync(() => gate.resolve());
      const b = yield* Effect.promise(() => starting);
      yield* Effect.promise(() => released);
      assert.equal(b.service.pid, 501);
      assert.isFalse(services.launched[1]?.closed());
    }),
  );

  it.effect(
    "never lets two observers share a service, and gives no later claim one its observer left",
    () =>
      Effect.gen(function* () {
        const services = fakeServices();
        const manager = makeHelperServiceManager(services);
        const desktop = yield* Effect.promise(() =>
          manager.claim(HELPER, "desktop", { observe: true }),
        );
        const agent = yield* Effect.promise(() => manager.claim(HELPER, "thread-a"));
        assert.equal(agent.service.pid, 500);
        const second = yield* Effect.promise(() =>
          manager.claim(HELPER, "desktop", { observe: true }),
        );
        assert.equal(second.service.pid, 501);
        yield* Effect.promise(() => second.release());
        // The observer leaves first: the session keeps the service, nobody new is handed it.
        yield* Effect.promise(() => desktop.release());
        assert.isFalse(services.launched[0]?.closed());
        const later = yield* Effect.promise(() => manager.claim(HELPER, "thread-b"));
        assert.equal(later.service.pid, 502);
        const observer = yield* Effect.promise(() =>
          manager.claim(HELPER, "desktop", { observe: true }),
        );
        assert.equal(observer.service.pid, 502);
        yield* Effect.promise(() => agent.release());
        assert.isTrue(services.launched[0]?.closed());
        assert.isFalse(services.launched[2]?.closed());
      }),
  );

  it("a claim cancelled while it waits its turn never holds the service", async () => {
    const gate = Promise.withResolvers<void>();
    const services = fakeServices({ gate: gate.promise });
    const manager = makeHelperServiceManager(services);
    const first = manager.claim(HELPER, "thread-a");
    const cancel = new AbortController();
    const queued = manager.claim(HELPER, "desktop", { observe: true, signal: cancel.signal });
    const stopped = new Error("stopped");
    cancel.abort(stopped);
    gate.resolve();
    const a = await first;
    assert.strictEqual(await rejection(queued), stopped);
    assert.lengthOf(services.launched, 1);
    // The other session's claim was never touched, and its release is the last one.
    assert.isFalse(services.launched[0]?.closed());
    await a.release();
    assert.isTrue(services.launched[0]?.closed());
  });

  it("a claim cancelled while its service opens closes that service and holds nothing", async () => {
    const gate = Promise.withResolvers<void>();
    const services = fakeServices({ gate: gate.promise });
    const manager = makeHelperServiceManager(services);
    const cancel = new AbortController();
    const claiming = manager.claim(HELPER, "desktop", { observe: true, signal: cancel.signal });
    await services.opening;
    const stopped = new Error("stopped");
    cancel.abort(stopped);
    gate.resolve();
    assert.strictEqual(await rejection(claiming), stopped);
    assert.isTrue(services.launched[0]?.closed());
    const next = await manager.claim(HELPER, "desktop", { observe: true });
    assert.equal(next.service.pid, 501);
  });
});
