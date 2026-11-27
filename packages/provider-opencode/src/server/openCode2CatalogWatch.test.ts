import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodeAssert from "node:assert/strict";

import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import { makeOpenCode2CatalogWatch } from "./openCode2CatalogWatch.ts";
import { makeOpenCode2ModelLoader, type OpenCode2Model } from "./status.ts";

const model = (id: string): OpenCode2Model => ({
  providerID: "github-copilot",
  id,
  name: id,
  variants: [],
});

it.effect("publishes the catalog OpenCode lists after its startup snapshot had settled", () =>
  Effect.gen(function* () {
    const startup = [model("startup-only")];
    const live = [model("live-only")];
    let listed = startup;
    const read = Effect.sync(() => listed);
    const events = yield* Queue.unbounded<{ readonly type: string }>();
    const watch = yield* makeOpenCode2CatalogWatch();
    const seen: Array<ReadonlyArray<OpenCode2Model> | undefined> = [];
    yield* Stream.runForEach(watch.changes, (catalog) =>
      Effect.sync(() => seen.push(catalog)),
    ).pipe(Effect.forkScoped);
    const load = yield* makeOpenCode2ModelLoader(
      watch
        .follow("server", Effect.succeed(Stream.fromQueue(events)), read)
        .pipe(Effect.andThen(read)),
    );
    const check = yield* Effect.forkChild(load);
    yield* TestClock.adjust("1 second");
    NodeAssert.deepEqual(yield* Fiber.join(check), startup);

    // Discovery ends long after two reads agreed, and only the event says so.
    yield* TestClock.adjust("6 seconds");
    listed = live;
    yield* Queue.offer(events, { type: "session.updated" });
    yield* TestClock.adjust("1 second");
    NodeAssert.deepEqual(seen.at(-1), startup);
    yield* Queue.offer(events, { type: "model.updated" });
    yield* TestClock.adjust("1 second");
    NodeAssert.deepEqual(seen.at(-1), live);
  }),
);

it.effect("keeps the last listed catalog once its server has stopped", () =>
  Effect.gen(function* () {
    const live = [model("live-only")];
    let running = true;
    const read = Effect.suspend(() =>
      running
        ? Effect.succeed(live)
        : Effect.fail(
            new OpenCodeRuntime.OpenCodeRuntimeError({
              operation: "model.list",
              detail: "stopped",
            }),
          ),
    );
    const events = yield* Queue.unbounded<{ readonly type: string }, "closed">();
    const watch = yield* makeOpenCode2CatalogWatch();
    const seen: Array<ReadonlyArray<OpenCode2Model> | undefined> = [];
    yield* Stream.runForEach(watch.changes, (catalog) =>
      Effect.sync(() => seen.push(catalog)),
    ).pipe(Effect.forkScoped);
    const follow = watch.follow("server", Effect.succeed(Stream.fromQueue(events)), read);
    yield* follow;
    yield* TestClock.adjust("1 second");
    NodeAssert.deepEqual(seen.at(-1), live);

    running = false;
    yield* Queue.offer(events, { type: "model.updated" });
    yield* Queue.fail(events, "closed");
    yield* TestClock.adjust("10 seconds");
    NodeAssert.deepEqual(seen.at(-1), live);

    // The next check's read follows the restarted server instead of the ended stream.
    running = true;
    const restarted = yield* Queue.unbounded<{ readonly type: string }>();
    const next = [model("after-restart")];
    yield* watch.follow(
      "server",
      Effect.succeed(Stream.fromQueue(restarted)),
      Effect.succeed(next),
    );
    yield* TestClock.adjust("1 second");
    NodeAssert.deepEqual(seen.at(-1), next);
  }),
);

it.effect("rescans a directory whose catalog changes after its scan settled", () =>
  Effect.gen(function* () {
    const startup = [model("startup-only")];
    const live = [model("live-only")];
    let listed = startup;
    const read = Effect.sync(() => listed);
    const events = yield* Queue.unbounded<{ readonly type: string }>();
    const watch = yield* makeOpenCode2CatalogWatch();
    const rescans: Array<string> = [];
    yield* Stream.runForEach(watch.rescans, (cwd) => Effect.sync(() => rescans.push(cwd))).pipe(
      Effect.forkScoped,
    );
    const subscribe = Effect.succeed(Stream.fromQueue(events));
    yield* watch.follow("server", subscribe, read, { cwd: "/project", settled: startup });
    // A scan that never settled keeps what the watch last read, so it cannot rescan forever.
    yield* watch.follow("server", subscribe, read, { cwd: "/unsettled" });
    yield* TestClock.adjust("1 second");
    NodeAssert.deepEqual(rescans, ["/unsettled"]);
    yield* watch.follow("server", subscribe, read, { cwd: "/unsettled" });
    yield* TestClock.adjust("1 second");
    NodeAssert.deepEqual(rescans, ["/unsettled"]);

    listed = live;
    yield* Queue.offer(events, { type: "model.updated" });
    yield* TestClock.adjust("1 second");
    NodeAssert.deepEqual(rescans, ["/unsettled", "/project", "/unsettled"]);

    // The rescan settles on the live catalog, and its own follow asks for nothing more.
    yield* watch.follow("server", subscribe, read, { cwd: "/project", settled: live });
    yield* TestClock.adjust("1 second");
    NodeAssert.deepEqual(rescans, ["/unsettled", "/project", "/unsettled"]);
  }),
);

it.effect("reads later changes after a catalog read that never answered", () =>
  Effect.gen(function* () {
    const live = [model("live-only")];
    let answering = false;
    const read = Effect.suspend(() => (answering ? Effect.succeed(live) : Effect.never));
    const events = yield* Queue.unbounded<{ readonly type: string }>();
    const watch = yield* makeOpenCode2CatalogWatch();
    const seen: Array<ReadonlyArray<OpenCode2Model> | undefined> = [];
    yield* Stream.runForEach(watch.changes, (catalog) =>
      Effect.sync(() => seen.push(catalog)),
    ).pipe(Effect.forkScoped);
    yield* watch.follow("server", Effect.succeed(Stream.fromQueue(events)), read);
    yield* TestClock.adjust("31 seconds");
    answering = true;
    yield* Queue.offer(events, { type: "model.updated" });
    yield* TestClock.adjust("1 second");
    NodeAssert.deepEqual(seen.at(-1), live);
  }),
);
