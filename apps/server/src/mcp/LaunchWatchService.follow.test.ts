import { describe, expect, it } from "@effect/vitest";
import { RunId } from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import {
  advanceUntil,
  finished,
  launcher,
  local,
  makeWorld,
  projectId,
  remoteRead,
  run1,
  run2,
  target,
  tempDir,
  watchLocal,
  watchRemote,
  withService,
  type World,
} from "./LaunchWatchService.testkit.ts";

const run3 = RunId.make("run-3");

/** The target thread is on a run it started itself, such as a pull request watch's wake. */
const startsRun = (world: World, runId: RunId, userMessageId = `message:wake:${runId}`) => {
  world.shells.set(target, { ...world.shells.get(target), activeRunId: runId, latestRunId: runId });
  world.runs = [...world.runs, { id: runId, userMessageId }];
};

const goesIdle = (world: World) =>
  world.shells.set(target, { ...world.shells.get(target), activeRunId: null });

const external = (owner = "client:bot-a") => ({
  owner,
  host: null,
  threadId: target,
  projectId,
  title: "Fix the flake",
  runId: run1,
  ceiling: "full-access" as const,
  route: { notifyWebhook: true, webhookTarget: null },
});

const keyOf = (owner = "client:bot-a") =>
  ({ launcherThreadId: null, owner, host: null, threadId: target }) as const;

const reportsQueue = (world: World) =>
  Effect.gen(function* () {
    const reported = yield* Queue.unbounded<void>();
    world.webhookNotify = Queue.offer(reported, undefined).pipe(Effect.asVoid);
    return reported;
  });

const reportedRuns = (world: World) => world.webhookReports.map(({ report }) => report.runId);

/** Reports run-1 of an outside launch, the way every test here starts. */
const launchAndFinish = (world: World, reported: Queue.Queue<void>) =>
  Effect.gen(function* () {
    yield* Queue.take(world.waitStarted);
    yield* Queue.offer(world.waits, finished(run1));
    yield* Queue.take(reported);
  });

describe("LaunchWatchService runs the thread starts itself (#2212)", () => {
  it.effect("reports each later run of a launcherless watch's thread once, when it ends", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const reported = yield* reportsQueue(world);
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* service.watchExternal(external());
          yield* launchAndFinish(world, reported);
          startsRun(world, run2);
          expect(yield* advanceUntil(Queue.take(world.waitStarted))).toBe(run2);
          goesIdle(world);
          yield* Queue.offer(world.waits, finished(run2));
          yield* Queue.take(reported);
          // Looking again finds only the run already reported.
          yield* TestClock.adjust("10 minutes");
          expect(yield* service.find(keyOf())).toMatchObject({
            pendingRuns: [],
            discoveredRuns: [],
            reportedRuns: [run1, run2],
          });
        }),
      );
      expect(reportedRuns(world)).toEqual([run1, run2]);
      expect(world.waitCalls.map((call) => call.runId)).toEqual([run1, run2]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a burst of wake runs once, when the thread goes idle", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const reported = yield* reportsQueue(world);
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* service.watchExternal(external());
          yield* launchAndFinish(world, reported);
          startsRun(world, run2);
          expect(yield* advanceUntil(Queue.take(world.waitStarted))).toBe(run2);
          // A queued wake starts run-3 as run-2 ends.
          startsRun(world, run3);
          yield* Queue.offer(world.waits, finished(run2));
          expect(yield* Queue.take(world.waitStarted)).toBe(run3);
          goesIdle(world);
          yield* Queue.offer(world.waits, finished(run3));
          yield* Queue.take(reported);
        }),
      );
      expect(reportedRuns(world)).toEqual([run1, run3]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps another outside caller's send out of a launcherless watch's reports", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const reported = yield* reportsQueue(world);
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* service.watchExternal(external());
          yield* launchAndFinish(world, reported);
          // bot-b's goat_thread_send starts run-2; its report belongs to bot-b's own watch.
          startsRun(world, run2, "message:mcp:client%3Abot-b:thread-send:request-1");
          expect(yield* advanceUntil(Queue.take(world.waitStarted))).toBe(run2);
          goesIdle(world);
          yield* Queue.offer(world.waits, finished(run2));
          // The thread's own next run still reaches bot-a.
          startsRun(world, run3);
          expect(yield* advanceUntil(Queue.take(world.waitStarted))).toBe(run3);
          goesIdle(world);
          yield* Queue.offer(world.waits, finished(run3));
          yield* Queue.take(reported);
          expect(yield* service.find(keyOf("client:bot-b"))).toBeNull();
        }),
      );
      expect(reportedRuns(world)).toEqual([run1, run3]);
      expect(world.webhookReports.every(({ watch }) => watch.owner === "client:bot-a")).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("counts a found run as arming, and stays quiet once the watch expires", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const reported = yield* reportsQueue(world);
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* service.watchExternal(external());
          yield* launchAndFinish(world, reported);
          yield* TestClock.adjust("5 days");
          startsRun(world, run2);
          expect(yield* advanceUntil(Queue.take(world.waitStarted))).toBe(run2);
          goesIdle(world);
          yield* Queue.offer(world.waits, finished(run2));
          yield* Queue.take(reported);
          // Ten days after the launch, but five after run-2: still kept.
          yield* TestClock.adjust("5 days");
          expect(yield* service.find(keyOf())).not.toBeNull();
          // A week after run-2 its follower drops it, and a later run is not followed.
          yield* Queue.clear(world.wantsAsked);
          yield* TestClock.adjust("3 days");
          yield* Queue.take(world.wantsAsked);
          expect(yield* service.find(keyOf())).toBeNull();
          startsRun(world, run3);
          yield* TestClock.adjust("10 minutes");
        }),
      );
      expect(reportedRuns(world)).toEqual([run1, run2]);
      expect(world.waitCalls.map((call) => call.runId)).toEqual([run1, run2]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("stops following a launcher's watch once it is unwatched", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          yield* Queue.offer(world.waits, finished(run1));
          yield* Queue.take(world.delivered);
          expect(yield* service.unwatch(local)).toBe(true);
          startsRun(world, run2);
          yield* TestClock.adjust("10 minutes");
        }),
      );
      expect(world.waitCalls.map((call) => call.runId)).toEqual([run1]);
      expect(world.deliveredLog).toHaveLength(1);
    }),
  );

  it.effect(
    "finds a remote thread's own runs with goat_thread_status and follows sends at once",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const baseDir = yield* tempDir;
        let latest = run1;
        const looked = yield* Queue.unbounded<number>();
        const answer = (call: { readonly tool: string; readonly arguments: unknown }) => {
          if (call.tool === "goat_thread_status") return { run: { runId: latest } };
          if (call.tool !== "goat_thread_wait") return remoteRead({ itemCount: 0 });
          const { runId } = call.arguments as { readonly runId: RunId };
          return { threadId: target, runId, status: "completed", timedOut: false };
        };
        world.hostCall = (call) =>
          (call.tool === "goat_thread_status"
            ? Clock.currentTimeMillis.pipe(Effect.flatMap((at) => Queue.offer(looked, at)))
            : Effect.void
          ).pipe(Effect.as(answer(call)));
        yield* withService(world, baseDir, (service) =>
          Effect.gen(function* () {
            yield* watchRemote(service, run1);
            yield* Queue.take(world.delivered);
            latest = run2;
            const found = yield* advanceUntil(Queue.take(world.delivered));
            expect(found.text).toContain("finished run run-2 with status completed");
            // Idle, the watch asks the host again only after two minutes, and reports nothing more.
            yield* Queue.clear(looked);
            const first = yield* Queue.take(looked);
            const next = yield* advanceUntil(Queue.take(looked));
            expect(next - first).toBeGreaterThanOrEqual(120_000);
            expect(world.deliveredLog).toHaveLength(2);
            // A send is followed without waiting for the next look.
            yield* service.rearm({
              launcherThreadId: launcher,
              host: "box",
              threadId: target,
              runId: run3,
            });
            const sent = yield* Queue.take(world.delivered);
            expect(sent.text).toContain("finished run run-3");
          }),
        );
        expect(
          world.hostCalls
            .filter(({ call }) => call.tool === "goat_thread_wait")
            .map(({ call }) => (call.arguments as { readonly runId: RunId }).runId),
        ).toEqual([run1, run2, run3]);
        expect(world.hostCalls.every(({ call }) => call.writes === false)).toBe(true);
      }),
  );
});
