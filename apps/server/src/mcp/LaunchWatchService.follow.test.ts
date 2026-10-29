import { describe, expect, it } from "@effect/vitest";
import { RunId } from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import {
  finished,
  launcher,
  local,
  makeWorld,
  projectId,
  remoteItem,
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

const [run3, run4, run5] = ["run-3", "run-4", "run-5"].map((id) => RunId.make(id)) as [
  RunId,
  RunId,
  RunId,
];

interface RunFacts {
  readonly requestedAt?: number;
  /** Null while it runs. */
  readonly completedAt?: number | null;
  /** The message that started it; a wake of the thread's own by default. */
  readonly trigger?: string;
  readonly status?: "queued" | "running" | "completed";
}

/** Records a run of the target thread, which becomes its latest run. */
const addRun = (world: World, runId: RunId, ordinal: number, facts: RunFacts = {}) => {
  const requestedAt = facts.requestedAt ?? ordinal * 10_000;
  const completedAt = facts.completedAt === undefined ? requestedAt + 5_000 : facts.completedAt;
  world.runs = [
    ...world.runs.filter((run) => run.id !== runId),
    {
      id: runId,
      ordinal,
      status: facts.status ?? (completedAt === null ? "running" : "completed"),
      requestedAt: DateTime.makeUnsafe(requestedAt),
      completedAt: completedAt === null ? null : DateTime.makeUnsafe(completedAt),
      userMessageId: facts.trigger ?? `message:wake:${runId}`,
    },
  ];
  world.shells.set(target, { ...world.shells.get(target), latestRunId: runId });
};

const external = (input: { readonly owner?: string; readonly host?: string } = {}) => ({
  owner: input.owner ?? "client:bot-a",
  host: input.host ?? null,
  threadId: target,
  projectId: input.host === undefined ? projectId : null,
  title: "Fix the flake",
  runId: run1,
  ceiling: "full-access" as const,
  route: { notifyWebhook: true, webhookTarget: null },
});

const keyOf = (owner = "client:bot-a", host: string | null = null) =>
  ({ launcherThreadId: null, owner, host, threadId: target }) as const;

const reportsQueue = (world: World) =>
  Effect.gen(function* () {
    const reported = yield* Queue.unbounded<void>();
    world.webhookNotify = Queue.offer(reported, undefined).pipe(Effect.asVoid);
    return reported;
  });

const reportedRuns = (world: World) => world.webhookReports.map(({ report }) => report.runId);
const waitedRuns = (world: World) => world.waitCalls.map((call) => call.runId);

/** The idle follower looks at its thread once more. */
const look = (world: World) => Queue.offer(world.lookTicks, undefined);

/** Reports run-1 of a local outside launch and lets its follower go idle. */
const launchAndFinish = (world: World, reported: Queue.Queue<void>) =>
  Effect.gen(function* () {
    yield* Queue.take(world.waitStarted);
    yield* Queue.offer(world.waits, finished(run1));
    yield* Queue.take(reported);
    expect(yield* Queue.take(world.idleWaits)).toBe(30_000);
  });

interface RemoteRun {
  readonly runId: RunId;
  readonly ordinal: number;
  /** The message that started it; null when it has none yet. */
  readonly trigger?: string | null;
  readonly status?: "queued" | "running" | "completed";
}

/** A remote thread's runs and the messages that started them, as goat_thread_read lists them. */
const remoteThread = (
  runs: ReadonlyArray<RemoteRun>,
  more: { readonly itemCount?: number; readonly items?: ReadonlyArray<unknown> } = {},
) =>
  remoteRead({
    itemCount: more.itemCount ?? runs.length,
    recentRuns: runs.toReversed().map(({ runId, ordinal, status = "completed" }) => ({
      runId,
      ordinal,
      status,
      providerInstanceId: "codex",
      model: "gpt-5",
      requestedAt: DateTime.formatIso(DateTime.makeUnsafe(ordinal * 10_000)),
      startedAt: DateTime.formatIso(DateTime.makeUnsafe(ordinal * 10_000)),
      completedAt:
        status === "completed"
          ? DateTime.formatIso(DateTime.makeUnsafe(ordinal * 10_000 + 5_000))
          : null,
    })),
    items: [
      ...runs.flatMap(({ runId, ordinal, trigger }) =>
        trigger === null ? [] : [userMessage(ordinal, runId, trigger ?? `message:wake:${runId}`)],
      ),
      ...(more.items ?? []),
    ],
  });

const userMessage = (position: number, runId: RunId, messageId: string) => ({
  ...remoteItem(position, runId, "Do the next step."),
  type: "user_message",
  messageId,
});

/** A remote host that ends each followed run at once and answers reads from the current thread. */
const remoteHost =
  (thread: () => unknown): World["hostCall"] =>
  (call) =>
    Effect.succeed(
      call.tool === "goat_thread_wait"
        ? {
            threadId: target,
            runId: (call.arguments as { readonly runId: RunId }).runId,
            status: "completed",
            timedOut: false,
          }
        : thread(),
    );

const remoteWaits = (world: World) =>
  world.hostCalls
    .filter(({ call }) => call.tool === "goat_thread_wait")
    .map(({ call }) => (call.arguments as { readonly runId: RunId }).runId);

describe("LaunchWatchService runs the thread starts itself", () => {
  it.effect("reports each run the thread starts itself once, each time the thread goes idle", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const reported = yield* reportsQueue(world);
      const baseDir = yield* tempDir;
      addRun(world, run1, 1);
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* service.watchExternal(external());
          yield* launchAndFinish(world, reported);
          // Two wakes come and go before the next look, with the thread idle between them.
          addRun(world, run2, 2, { requestedAt: 20_000, completedAt: 25_000 });
          addRun(world, run3, 3, { requestedAt: 30_000, completedAt: 35_000 });
          yield* Queue.offer(world.waits, finished(run2));
          yield* Queue.offer(world.waits, finished(run3));
          yield* look(world);
          yield* Queue.take(reported);
          yield* Queue.take(reported);
          // Later looks find nothing new.
          yield* Queue.take(world.idleWaits);
          yield* look(world);
          yield* Queue.take(world.idleWaits);
          expect(yield* service.find(keyOf())).toMatchObject({
            pendingRuns: [],
            reportedRuns: [run1, run2, run3],
          });
        }),
      );
      expect(reportedRuns(world)).toEqual([run1, run2, run3]);
      expect(waitedRuns(world)).toEqual([run1, run2, run3]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports runs the thread went straight through once, when it goes idle", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const reported = yield* reportsQueue(world);
      const baseDir = yield* tempDir;
      addRun(world, run1, 1);
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* service.watchExternal(external());
          yield* launchAndFinish(world, reported);
          // run-3 was queued while run-2 ran.
          addRun(world, run2, 2, { requestedAt: 20_000, completedAt: 30_000 });
          addRun(world, run3, 3, { requestedAt: 25_000, completedAt: 35_000 });
          yield* Queue.offer(world.waits, finished(run3));
          yield* look(world);
          yield* Queue.take(reported);
          // run-4 is still running when the watch finds it; run-5 queues behind it.
          yield* Queue.take(world.idleWaits);
          addRun(world, run4, 4, { requestedAt: 40_000, completedAt: null });
          yield* look(world);
          expect(yield* Queue.take(world.waitStarted)).toBe(run3);
          expect(yield* Queue.take(world.waitStarted)).toBe(run4);
          addRun(world, run4, 4, { requestedAt: 40_000, completedAt: 50_000 });
          addRun(world, run5, 5, { requestedAt: 45_000, completedAt: 55_000 });
          yield* Queue.offer(world.waits, finished(run4));
          yield* Queue.offer(world.waits, finished(run5));
          yield* Queue.take(reported);
        }),
      );
      expect(reportedRuns(world)).toEqual([run1, run3, run5]);
      expect(waitedRuns(world)).toEqual([run1, run3, run4, run5]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves another caller's send out, and reports a send whose re-arm came late", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const reported = yield* reportsQueue(world);
      const baseDir = yield* tempDir;
      addRun(world, run1, 1);
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* service.watchExternal(external());
          yield* launchAndFinish(world, reported);
          // bot-b's send waits on a question; neither it nor its end is bot-a's to hear.
          addRun(world, run2, 2, {
            completedAt: null,
            trigger: "message:mcp:client%3Abot-b:thread-send:request-1",
          });
          world.requests.push({ id: "request-1", status: "pending", kind: "user_input" });
          yield* look(world);
          yield* Queue.take(world.idleWaits);
          // bot-a's own send, seen before its re-arm arrived.
          addRun(world, run3, 3, { trigger: "message:mcp:client%3Abot-a:thread-send:request-2" });
          yield* look(world);
          yield* Queue.take(world.idleWaits);
          yield* service.rearm({ ...keyOf(), runId: run3 });
          expect(yield* Queue.take(world.waitStarted)).toBe(run3);
          yield* Queue.offer(world.waits, finished(run3));
          yield* Queue.take(reported);
          expect(yield* service.find(keyOf("client:bot-b"))).toBeNull();
        }),
      );
      expect(reportedRuns(world)).toEqual([run1, run3]);
      expect(world.webhookReports.map(({ report }) => report.event)).toEqual([
        "run.completed",
        "run.completed",
      ]);
      expect(waitedRuns(world)).toEqual([run1, run3]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "counts a found run as arming, and a look that outlives retention re-arms nothing",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const reported = yield* reportsQueue(world);
        const baseDir = yield* tempDir;
        let runs = [{ runId: run1, ordinal: 1 }];
        let hold: Deferred.Deferred<void> | undefined;
        const readStarted = yield* Queue.unbounded<void>();
        world.hostCall = (call) =>
          call.tool === "goat_thread_wait"
            ? Effect.succeed({
                threadId: target,
                runId: (call.arguments as { readonly runId: RunId }).runId,
                status: "completed",
                timedOut: false,
              })
            : Queue.offer(readStarted, undefined).pipe(
                Effect.andThen(hold === undefined ? Effect.void : Deferred.await(hold)),
                Effect.as(remoteThread(runs)),
              );
        yield* withService(world, baseDir, (service) =>
          Effect.gen(function* () {
            yield* service.watchExternal(external({ host: "box" }));
            yield* Queue.take(reported);
            expect(yield* Queue.take(world.idleWaits)).toBe(120_000);
            yield* TestClock.adjust("5 days");
            runs = [...runs, { runId: run2, ordinal: 2 }];
            yield* look(world);
            yield* Queue.take(reported);
            yield* Queue.take(world.idleWaits);
            // Ten days after the launch, five after run-2: still kept.
            yield* TestClock.adjust("5 days");
            const kept = yield* service.find(keyOf("client:bot-a", "box"));
            expect(kept).not.toBeNull();
            // A look starts 30 seconds before the week since run-2 is up and answers after it.
            yield* TestClock.setTime((kept?.armedAt ?? 0) + 7 * 24 * 60 * 60_000 - 30_000);
            hold = yield* Deferred.make<void>();
            yield* Queue.clear(readStarted);
            yield* look(world);
            yield* Queue.take(readStarted);
            yield* TestClock.adjust("1 minute");
            runs = [...runs, { runId: run3, ordinal: 3 }];
            yield* Queue.clear(world.wantsAsked);
            yield* Deferred.succeed(hold, undefined);
            yield* Queue.take(world.wantsAsked);
            expect(yield* service.find(keyOf("client:bot-a", "box"))).toBeNull();
          }),
        );
        expect(reportedRuns(world)).toEqual([run1, run2]);
        expect(
          world.hostCalls
            .filter(({ call }) => call.tool === "goat_thread_wait")
            .map(({ call }) => (call.arguments as { readonly runId: RunId }).runId),
        ).toEqual([run1, run2]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("stops following a launcher's watch once it is unwatched", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      addRun(world, run1, 1);
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          yield* Queue.offer(world.waits, finished(run1));
          yield* Queue.take(world.delivered);
          yield* Queue.take(world.idleWaits);
          expect(yield* service.unwatch(local)).toBe(true);
          addRun(world, run2, 2);
          yield* look(world);
          expect(yield* service.list(launcher)).toEqual([]);
        }),
      );
      expect(waitedRuns(world)).toEqual([run1]);
      expect(world.deliveredLog).toHaveLength(1);
    }),
  );

  it.effect("follows a remote thread's own runs on a host without goat_thread_status", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      let runs = [{ runId: run1, ordinal: 1 }];
      world.hostCall = (call) =>
        call.tool === "goat_thread_wait"
          ? Effect.succeed({
              threadId: target,
              runId: (call.arguments as { readonly runId: RunId }).runId,
              status: "completed",
              timedOut: false,
            })
          : call.tool === "goat_thread_read"
            ? Effect.succeed(remoteThread(runs))
            : Effect.fail(
                new SshRemoteDispatch.SshRemoteDispatchError({
                  reason: "remote_refused",
                  message: `${call.tool} is not a tool here`,
                }),
              );
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchRemote(service, run1);
          yield* Queue.take(world.delivered);
          expect(yield* Queue.take(world.idleWaits)).toBe(120_000);
          runs = [...runs, { runId: run2, ordinal: 2 }];
          yield* look(world);
          const found = yield* Queue.take(world.delivered);
          expect(found.text).toContain("finished run run-2 with status completed");
          // A send while the follower is idle is followed without waiting for the next look.
          yield* Queue.take(world.idleWaits);
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
      const tools = world.hostCalls.map(({ call }) => call.tool);
      expect(tools).not.toContain("goat_thread_status");
      expect(
        world.hostCalls
          .filter(({ call }) => call.tool === "goat_thread_wait")
          .map(({ call }) => (call.arguments as { readonly runId: RunId }).runId),
      ).toEqual([run1, run2, run3]);
      expect(world.hostCalls.every(({ call }) => call.writes === false)).toBe(true);
    }),
  );
  it.effect("never takes a steer for who started a remote run whose start is out of view", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const reported = yield* reportsQueue(world);
      const baseDir = yield* tempDir;
      // bot-b's long run-2: its starting send scrolled out of the last messages; a steer did not.
      const steer = { items: [userMessage(150, run2, "message:wake:steer")], itemCount: 200 };
      let thread = remoteThread([{ runId: run1, ordinal: 1 }]);
      world.hostCall = remoteHost(() => thread);
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* service.watchExternal(external({ host: "box" }));
          yield* Queue.take(reported);
          yield* Queue.take(world.idleWaits);
          thread = remoteThread(
            [
              { runId: run1, ordinal: 1, trigger: null },
              { runId: run2, ordinal: 2, trigger: null, status: "running" },
            ],
            steer,
          );
          yield* look(world);
          yield* Queue.take(world.idleWaits);
          thread = remoteThread(
            [
              { runId: run1, ordinal: 1, trigger: null },
              { runId: run2, ordinal: 2, trigger: null },
            ],
            steer,
          );
          yield* look(world);
          yield* Queue.take(world.idleWaits);
          expect(yield* service.find(keyOf("client:bot-a", "box"))).toMatchObject({
            pendingRuns: [],
            skippedRuns: [run2],
          });
        }),
      );
      expect(reportedRuns(world)).toEqual([run1]);
      expect(remoteWaits(world)).toEqual([run1]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a remote run that was queued before its message landed", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const reported = yield* reportsQueue(world);
      const baseDir = yield* tempDir;
      let thread = remoteThread([{ runId: run1, ordinal: 1 }]);
      world.hostCall = remoteHost(() => thread);
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* service.watchExternal(external({ host: "box" }));
          yield* Queue.take(reported);
          yield* Queue.take(world.idleWaits);
          thread = remoteThread([
            { runId: run1, ordinal: 1 },
            { runId: run2, ordinal: 2, trigger: null, status: "queued" },
          ]);
          yield* look(world);
          yield* Queue.take(world.idleWaits);
          expect(remoteWaits(world)).toEqual([run1]);
          thread = remoteThread([
            { runId: run1, ordinal: 1 },
            { runId: run2, ordinal: 2 },
          ]);
          yield* look(world);
          yield* Queue.take(reported);
        }),
      );
      expect(reportedRuns(world)).toEqual([run1, run2]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports none of the questions another run left pending, queued or not", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const reported = yield* reportsQueue(world);
      const baseDir = yield* tempDir;
      addRun(world, run1, 1);
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* service.watchExternal(external());
          yield* launchAndFinish(world, reported);
          // bot-b's send is running and asks a question; the thread's own run-3 queues behind it.
          addRun(world, run2, 2, {
            completedAt: null,
            trigger: "message:mcp:client%3Abot-b:thread-send:request-1",
          });
          addRun(world, run3, 3, { completedAt: null, status: "queued" });
          world.requests.push({
            id: "request-1",
            status: "pending",
            kind: "user_input",
            runId: run2,
          });
          const step = (status: string) =>
            Queue.offer(
              world.waits,
              Effect.succeed({
                threadId: target,
                run: { id: run3, status } as never,
                timedOut: true,
              }),
            );
          yield* step("queued");
          // Recovery cancels run-2 but keeps its question pending while run-3 runs.
          yield* step("running");
          yield* Queue.offer(world.waits, finished(run3));
          yield* look(world);
          yield* Queue.take(reported);
        }),
      );
      expect(world.webhookReports.map(({ report }) => [report.event, report.runId])).toEqual([
        ["run.completed", run1],
        ["run.completed", run3],
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect.each(["local", "remote"] as const)(
    "names the run that asks a question when the wait follows a continuation (%s)",
    (mode) =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const baseDir = yield* tempDir;
        // The wait for run-1 follows its restart continuation run-2, which asks.
        world.requests = [{ id: "question-1", status: "pending", kind: "user_input" }];
        world.waitHandler = () =>
          Effect.succeed({
            threadId: target,
            run: { id: run2, status: "waiting" } as never,
            timedOut: false,
          });
        world.hostCall = (call) =>
          call.tool === "goat_thread_wait"
            ? Effect.succeed({
                threadId: target,
                runId: run2,
                status: "waiting",
                timedOut: false,
                pendingRequestIds: ["question-1"],
              })
            : Effect.never;
        yield* withService(world, baseDir, (service) =>
          Effect.gen(function* () {
            yield* mode === "local" ? watchLocal(service, run1) : watchRemote(service, run1);
            const wake = yield* Queue.take(world.delivered);
            expect(wake.text).toContain("(question-1) in run run-2");
          }),
        );
        expect(world.webhookReports.map(({ report }) => report.runId)).toEqual([run2]);
      }),
  );
});
