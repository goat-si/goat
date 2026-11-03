import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import { vi } from "vite-plus/test";

interface FakeNotice {
  readonly emit: (event: string, ...args: unknown[]) => boolean;
  readonly listenerCount: (event: string) => number;
  closed: boolean;
}
const fixture = vi.hoisted(() => ({ notices: Array<FakeNotice>(), supported: true }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class Notification extends EventEmitter {
    static isSupported() {
      return fixture.supported;
    }
    closed = false;
    constructor() {
      super();
      fixture.notices.push(this);
    }
    show() {}
    close() {
      this.closed = true;
    }
  }
  return { Notification };
});
import { make } from "./ElectronNotification.ts";

it.effect("a replacement closes the previous notification and failed delivery is reported", () =>
  Effect.gen(function* () {
    fixture.notices.length = 0;
    fixture.supported = true;
    const notifications = make();
    const failures: string[] = [];
    const failed = yield* Deferred.make<void>();
    const failure = (reason: string) =>
      Effect.sync(() => {
        failures.push(reason);
      }).pipe(Effect.andThen(Deferred.succeed(failed, undefined)), Effect.asVoid);
    yield* notifications.show("one", "title", "body", Effect.void, failure);
    yield* notifications.show("one", "title", "body", Effect.void, failure);
    const [first, second] = fixture.notices;
    assert.isTrue(first?.closed);
    assert.doesNotThrow(() => first?.emit("error", new Error("late error")));
    assert.equal(first?.listenerCount("click"), 0);
    second?.emit("failed", "event", "failure");
    yield* Deferred.await(failed);
    assert.deepEqual(failures, ["failure"]);
    yield* notifications.show("one", "title", "body", Effect.void, failure);
    yield* notifications.close("one");
    assert.isTrue(fixture.notices[2]?.closed);
    assert.doesNotThrow(() => fixture.notices[2]?.emit("error", new Error("late error")));
  }),
);

it.effect("unsupported notifications report failure and clicks open logs", () =>
  Effect.gen(function* () {
    fixture.notices.length = 0;
    const notifications = make();
    const clicked = yield* Deferred.make<void>();
    const failed = yield* Deferred.make<string>();
    fixture.supported = false;
    yield* notifications.show("one", "title", "body", Effect.void, (reason) =>
      Deferred.succeed(failed, reason).pipe(Effect.asVoid),
    );
    assert.equal(yield* Deferred.await(failed), "notifications unsupported");
    fixture.supported = true;
    yield* notifications.show(
      "one",
      "title",
      "body",
      Deferred.succeed(clicked, undefined).pipe(Effect.asVoid),
      () => Effect.void,
    );
    fixture.notices[0]?.emit("click");
    yield* Deferred.await(clicked);
    assert.equal(fixture.notices[0]?.listenerCount("click"), 0);
  }),
);
